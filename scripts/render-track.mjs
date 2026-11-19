#!/usr/bin/env node
// render-track.mjs
//
// CLI entry point for the generative ambient music engine. Parses args,
// calls renderTrack() (src/generative/compose.mjs) with a deterministic
// seed, runs a battery of self-verification checks on the returned audio
// BEFORE writing anything to disk, writes a 24-bit stereo WAV via
// dsp/wav-writer.mjs, and prints a plain-text stats block.
//
// Usage:
//   node scripts/render-track.mjs --duration 120 --seed 561 \
//     --title "Settling Spiral" --out ./data/renders/settling-spiral.wav
//
// Exit code is 0 only if every self-check passed; otherwise nonzero, with
// the failing check named on stderr -- safe to wire into CI/verify steps
// (e.g. `npm run render -- --duration 5` as a fast smoke test).

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderTrack } from '../src/generative/compose.mjs';
import { hasNonFinite, peakOf, rmsOf } from "@red-cup-engineering/computer-audio-engineering-services-section/mixer";
import { writeWavFile } from '@red-cup-engineering/computer-audio-engineering-services-section/write-wav-file';
import { slugify } from '@red-cup-engineering/computer-text-content-engineering-services-section/slugify-text';

const SERVICE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  duration: 120,
  sampleRate: 44100,
  title: 'Settling Spiral',
  mode: 'dorian',
  root: 'D',
  reverbPreset: 'deepAmbient',
  melody: true,
  rmsFloorDb: -60,
  peakWarnDb: -0.1,
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    const takesValue = next !== undefined && !next.startsWith('--');
    switch (key) {
      case 'duration':
        args.duration = Number(next);
        i++;
        break;
      case 'sampleRate':
      case 'sample-rate':
        args.sampleRate = Number(next);
        i++;
        break;
      case 'seed':
        args.seed = next;
        i++;
        break;
      case 'title':
        args.title = next;
        i++;
        break;
      case 'out':
        args.out = next;
        i++;
        break;
      case 'mode':
        args.mode = next;
        i++;
        break;
      case 'root':
        args.root = next;
        i++;
        break;
      case 'reverbPreset':
      case 'reverb-preset':
        args.reverbPreset = next;
        i++;
        break;
      case 'melody':
        // Accepts an explicit true/false value (`--melody false`) or a bare
        // flag (`--melody`, meaning true).
        if (next === 'true' || next === 'false') {
          args.melody = next === 'true';
          i++;
        } else {
          args.melody = true;
        }
        break;
      case 'no-melody':
        args.melody = false;
        break;
      default:
        if (takesValue) i++; // ignore unrecognized flags, but don't eat a bare flag's value by accident
        break;
    }
  }
  return args;
}


function toDb(linear) {
  return linear > 0 ? 20 * Math.log10(linear) : -Infinity;
}

function fmtDb(db) {
  return Number.isFinite(db) ? `${db.toFixed(2)} dBFS` : '-Inf dBFS';
}

/**
 * Groups a melodyOnsetLog (compose.mjs's renderTrack() return value) by
 * sectionTag and computes, per section, the mean absolute scale-degree
 * interval between consecutive onsets (in onset order, which is transport-
 * time order since the log is appended as notes trigger) plus register/
 * timbre usage counts -- the concrete numbers behind the large-scale-form
 * claim, not just an assertion that it happened.
 * @param {Array<{startSec:number, degree:number, sectionTag:string, octaveIndex:number, partialsName:string}>} onsetLog
 * @returns {Record<string, {count:number, meanAbsInterval:number|null, octaveIndexCounts:Record<string,number>, partialsCounts:Record<string,number>}>}
 */
function summarizeMelodyArc(onsetLog) {
  const bySection = { OPENING: [], DEVELOPMENT: [], RETURN: [] };
  for (const o of onsetLog) {
    if (bySection[o.sectionTag]) bySection[o.sectionTag].push(o);
  }
  const summary = {};
  for (const [sectionTag, onsets] of Object.entries(bySection)) {
    let totalInterval = 0;
    let intervalCount = 0;
    const octaveIndexCounts = {};
    const partialsCounts = {};
    for (let i = 0; i < onsets.length; i++) {
      if (i > 0) {
        totalInterval += Math.abs(onsets[i].degree - onsets[i - 1].degree);
        intervalCount++;
      }
      octaveIndexCounts[onsets[i].octaveIndex] = (octaveIndexCounts[onsets[i].octaveIndex] || 0) + 1;
      partialsCounts[onsets[i].partialsName] = (partialsCounts[onsets[i].partialsName] || 0) + 1;
    }
    summary[sectionTag] = {
      count: onsets.length,
      meanAbsInterval: intervalCount > 0 ? totalInterval / intervalCount : null,
      octaveIndexCounts,
      partialsCounts,
    };
  }
  return summary;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!(args.duration > 0)) {
    console.error('FAIL: --duration must be a positive number');
    process.exit(1);
  }

  // Deterministic seed: default to Date.now() only when the caller didn't
  // supply one, so a given --seed is exactly reproducible (renderTrack's
  // own makeRng, from generative/random.mjs, is a mulberry32 PRNG that
  // takes this same value straight through).
  const seedInput = args.seed !== undefined ? args.seed : Date.now();
  const seedForRender = /^-?\d+$/.test(String(seedInput)) ? Number(seedInput) : String(seedInput);

  const outPath = args.out
    ? resolve(process.cwd(), args.out)
    : resolve(SERVICE_ROOT, 'data', 'renders', `${slugify(args.title) || 'track'}.wav`);

  console.log(`Rendering "${args.title}" (${args.duration}s, seed=${seedForRender})...`);

  const track = renderTrack({
    durationSec: args.duration,
    sampleRate: args.sampleRate,
    seed: seedForRender,
    mode: args.mode,
    root: args.root,
    reverbPreset: args.reverbPreset,
    melody: args.melody,
  });

  const { sampleRate, left, right } = track;
  const numSamples = left.length;
  const actualDurationSec = numSamples / sampleRate;

  const checks = [];

  // 1. No NaN/Infinity anywhere. renderTrack() already throws on this
  // internally, but we re-check the returned buffers directly too --
  // defense in depth, and this is the check whose PASS/FAIL actually
  // appears in the printed stats block.
  const nonFinite = hasNonFinite(left, right);
  checks.push({ name: 'finite samples (no NaN/Infinity)', pass: !nonFinite, detail: nonFinite ? 'found non-finite sample(s)' : 'ok' });

  // 2. Peak: hard-fail on actual clipping (>= 1.0), warn (but pass) above
  // peakWarnDb.
  const peakL = peakOf(left, left);
  const peakR = peakOf(right, right);
  const peak = Math.max(peakL, peakR);
  const peakDb = toDb(peak);
  const clipping = peak >= 1.0;
  checks.push({
    name: 'no clipping (peak < 1.0)',
    pass: !clipping,
    detail: clipping ? `peak=${peak.toFixed(6)} >= 1.0` : `peak=${peak.toFixed(6)} (${fmtDb(peakDb)})${peakDb > args.peakWarnDb ? ' [warn: low headroom]' : ''}`,
  });

  // 3. RMS floor: fail if the render is near-silent (a bug, not a valid
  // ambient piece -- ambient still needs sustained sub/pad energy).
  const rmsL = rmsOf(left, left);
  const rmsR = rmsOf(right, right);
  const rms = rmsOf(left, right);
  const rmsDb = toDb(rms);
  const tooQuiet = rmsDb < args.rmsFloorDb;
  checks.push({
    name: `not silent (RMS >= ${args.rmsFloorDb} dBFS)`,
    pass: !tooQuiet,
    detail: `rms=${fmtDb(rmsDb)}`,
  });

  // 4. Duration sanity check.
  const durationDelta = Math.abs(actualDurationSec - args.duration);
  const durationOk = durationDelta <= 0.01;
  checks.push({
    name: 'duration within 0.01s of requested',
    pass: durationOk,
    detail: `requested=${args.duration}s actual=${actualDurationSec.toFixed(6)}s delta=${durationDelta.toFixed(6)}s`,
  });

  // 5. Melodic layer sanity check (only meaningful once the track is long
  // enough for at least one phrase to plausibly complete -- melody.mjs's
  // shortest phrases run ~15s and compose.mjs stops starting new phrases
  // once MELODY_MIN_TRAILING_SILENCE_SEC=18s from the end, so a very short
  // smoke-test render can legitimately produce zero melody note onsets by
  // design, not by bug). When melody is enabled and the track is long
  // enough, checks that real discrete note onsets actually happened and
  // that they are not all the same pitch/duration (i.e. this is not just
  // the pad bed with an inaudible melody layer).
  if (args.melody && args.duration >= 30) {
    const hasOnsets = track.melodyNoteOnsets > 0;
    const varied = track.melodyUniqueDegrees > 1 && track.melodyUniqueDurationsSec > 1;
    checks.push({
      name: 'melodic layer produced varied note onsets',
      pass: hasOnsets && varied,
      detail: `onsets=${track.melodyNoteOnsets} uniqueDegrees=${track.melodyUniqueDegrees} uniqueDurations=${track.melodyUniqueDurationsSec}`,
    });
  }

  // 6. Large-scale melodic form check: only meaningful once the track is
  // long enough to plausibly reach both the OPENING and DEVELOPMENT
  // sections with a handful of onsets in each. OPENING/DEVELOPMENT/RETURN
  // are now regime-driven (melody.mjs's advanceMacroFormPhase), not a fixed
  // time fraction, so there's no fixed duration threshold that guarantees
  // enough onsets in each section -- the `enoughData` check below is the
  // real gate, not this comment's duration floor. Verifies, with real
  // numbers from the actual rendered onset log (not an assumption), that
  // DEVELOPMENT's melodic material genuinely uses wider intervals on
  // average than OPENING's -- the concrete, checkable form of "the piece
  // develops instead of just repeating the same shapes."
  let melodyArcSummary = null;
  if (args.melody && args.duration >= 120) {
    melodyArcSummary = summarizeMelodyArc(track.melodyOnsetLog);
    const opening = melodyArcSummary.OPENING;
    const development = melodyArcSummary.DEVELOPMENT;
    const enoughData = opening.count >= 6 && development.count >= 6 && opening.meanAbsInterval !== null && development.meanAbsInterval !== null;
    checks.push({
      name: 'large-scale form: DEVELOPMENT uses wider average melodic intervals than OPENING',
      pass: !enoughData || development.meanAbsInterval > opening.meanAbsInterval,
      detail: enoughData
        ? `OPENING meanAbsInterval=${opening.meanAbsInterval.toFixed(3)} (n=${opening.count}), DEVELOPMENT meanAbsInterval=${development.meanAbsInterval.toFixed(3)} (n=${development.count})`
        : `not enough onsets to compare (OPENING n=${opening.count}, DEVELOPMENT n=${development.count}) -- render longer to exercise this check`,
    });
  }

  const allPassed = checks.every((c) => c.pass);

  if (!allPassed) {
    console.error('\nSelf-verification FAILED -- refusing to write WAV file.');
    for (const c of checks) {
      console.error(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);
    }
    process.exit(1);
  }

  await mkdir(dirname(outPath), { recursive: true });
  const { bytes: byteLength } = await writeWavFile(outPath, {
    sampleRate,
    numChannels: 2,
    bitDepth: 24,
    bufferL: left,
    bufferR: right,
  });

  const lines = [];
  lines.push('');
  lines.push('=== Generative Ambient Render: Self-Verification Report ===');
  lines.push(`Title:            ${args.title}`);
  lines.push(`File:             ${outPath}`);
  lines.push(`File size:        ${byteLength} bytes`);
  lines.push(`Sample rate:      ${sampleRate} Hz`);
  lines.push(`Bit depth:        24-bit PCM`);
  lines.push(`Channels:         2 (stereo)`);
  lines.push(`Duration:         ${numSamples} samples / ${actualDurationSec.toFixed(3)} s`);
  lines.push(`Peak (L):         ${fmtDb(toDb(peakL))} (${peakL.toFixed(6)})`);
  lines.push(`Peak (R):         ${fmtDb(toDb(peakR))} (${peakR.toFixed(6)})`);
  lines.push(`RMS (L):          ${fmtDb(toDb(rmsL))}`);
  lines.push(`RMS (R):          ${fmtDb(toDb(rmsR))}`);
  lines.push(`Seed used:        ${seedForRender}`);
  lines.push(`Mode / root:      ${args.mode} / ${args.root}`);
  lines.push(`Reverb preset:    ${args.reverbPreset}`);
  lines.push(`Regime transitions: ${track.regimeTransitions}`);
  lines.push(`Final regime:     ${track.finalRegime}`);
  lines.push(`Settlement spirals: ${track.spiralCount}`);
  lines.push(`Melody layer:     ${args.melody ? 'on' : 'off'}`);
  lines.push(`Melody note onsets: ${track.melodyNoteOnsets} (${track.melodyUniqueDegrees} distinct scale degrees, ${track.melodyUniqueDurationsSec} distinct durations)`);
  if (melodyArcSummary) {
    lines.push('');
    lines.push('Melodic large-scale arc (OPENING / DEVELOPMENT / RETURN), from the actual rendered onset log:');
    for (const sectionTag of ['OPENING', 'DEVELOPMENT', 'RETURN']) {
      const s = melodyArcSummary[sectionTag];
      const intervalStr = s.meanAbsInterval !== null ? s.meanAbsInterval.toFixed(3) : 'n/a';
      const octStr = Object.entries(s.octaveIndexCounts).map(([k, v]) => `oct${k}:${v}`).join(' ') || 'none';
      const timbreStr = Object.entries(s.partialsCounts).map(([k, v]) => `${k}:${v}`).join(' ') || 'none';
      lines.push(`  ${sectionTag.padEnd(11)} onsets=${String(s.count).padEnd(4)} meanAbsInterval=${intervalStr.padEnd(6)} registers=[${octStr}] timbres=[${timbreStr}]`);
    }
  }
  lines.push('');
  lines.push('Self-checks:');
  for (const c of checks) {
    lines.push(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);
  }
  lines.push('');
  lines.push('Overall: PASS');
  lines.push('');

  console.log(lines.join('\n'));
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL: render-track.mjs threw an unhandled error:');
  console.error(err);
  process.exit(1);
});
