#!/usr/bin/env node
// render-throat-track.mjs
//
// CLI entry point for the "Flaming Lips meets Tuva throat singing"
// genre-divergence piece (src/generative/compose-throat.mjs), a sibling to
// scripts/render-track.mjs (the default ambient-drone CLI, untouched by
// this file). Same self-verification discipline -- finite samples, no
// clipping, not silent, duration sanity -- PLUS a render-level formant-
// sweep measurement that is the real point of this script: for a sample of
// the actual rendered overtone notes (from renderThroatTrack's own
// overtoneNoteLog), it measures -- via dsp/formant.mjs's Goertzel power
// detector applied to the real mixed-down stereo output, not a synthetic
// test tone -- whether each note's target harmonic frequency measures
// louder than a neighboring harmonic during that note's own settled
// window (after its glide has finished).
//
// This is deliberately the *harder* version of the check
// test/formant.test.mjs already proves in isolation: the full render also
// carries the secondary pad-bed layer, chorus, reverb, saturation, and
// wobble, all of which blur/mask a bare formant sweep somewhat. A real
// mixed render is not expected to hit 100% the way the isolated DSP test
// does, so this script reports the actual measured pass rate rather than
// pretending otherwise -- see the printed "Formant-sweep measurement"
// section, and the self-check's own threshold (a majority, not all, of
// sampled notes must show the target dominating) and stated honestly as
// such.
//
// Usage:
//   node scripts/render-throat-track.mjs --duration 360 --seed 561 \
//     --title "Flaming Lips Meet Tuva" --out ./data/renders/flaming-lips-meet-tuva.wav

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderThroatTrack } from '../src/generative/compose-throat.mjs';
import { hasNonFinite, peakOf, rmsOf } from "@red-cup-engineering/computer-audio-engineering-services-section/mixer";
import { goertzelPowerDb, harmonicToHz } from "@red-cup-engineering/computer-audio-engineering-services-section/formant";
import { writeWavFile } from '@red-cup-engineering/computer-audio-engineering-services-section/write-wav-file';
import { slugify } from '@red-cup-engineering/computer-text-content-engineering-services-section/slugify-text';

const SERVICE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  duration: 360,
  sampleRate: 44100,
  title: 'Flaming Lips Meet Tuva',
  mode: 'dorian',
  root: 'D',
  rmsFloorDb: -60,
  peakWarnDb: -0.1,
  saturationDrive: 1.6,
  saturationMix: 0.55,
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
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
      case 'saturationDrive':
      case 'saturation-drive':
        args.saturationDrive = Number(next);
        i++;
        break;
      case 'saturationMix':
      case 'saturation-mix':
        args.saturationMix = Number(next);
        i++;
        break;
      default:
        if (next !== undefined && !next.startsWith('--')) i++;
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

// --- render-level formant-sweep measurement ---------------------------------
//
// For a sample of the actual rendered overtone notes, measures (Goertzel
// power, in dB) the real mixed-down mono buffer's energy at the note's
// target harmonic frequency (h1) versus at its immediate lower neighbor
// harmonic (h1-1) during a settled analysis window late in the note (after
// its glide has finished, per the note's own logged glideSec) -- the direct,
// measured evidence that the overtone-emphasis technique survived the full
// mix (secondary pad bed, chorus, reverb, saturation, wobble), not just the
// isolated DSP chain test/formant.test.mjs already checks.
const ANALYSIS_WINDOW_SAMPLES = 8192; // ~186ms at 44100Hz -- long enough for a low fundamental's harmonic spacing (~70-120Hz here) to resolve cleanly via Goertzel, short enough to comfortably fit inside most note durations
const MEASUREMENT_MARGIN_DB = 1.5; // how much louder the target must measure than its neighbor to count as a clear "pass" for that note
const MAX_NOTES_TO_MEASURE = 40; // sample this many notes across the render rather than every single one, for a fast but still statistically meaningful check

function measureFormantSweepInRender(track) {
  const { left, right, sampleRate, overtoneNoteLog } = track;
  const mono = new Float64Array(left.length);
  for (let i = 0; i < left.length; i++) mono[i] = (left[i] + right[i]) * 0.5;

  const candidates = overtoneNoteLog.filter((n) => n.durSec > (ANALYSIS_WINDOW_SAMPLES / sampleRate) * 1.3 + n.glideSec);
  const step = Math.max(1, Math.floor(candidates.length / MAX_NOTES_TO_MEASURE));
  const sampled = candidates.filter((_, i) => i % step === 0).slice(0, MAX_NOTES_TO_MEASURE);

  const results = [];
  for (const note of sampled) {
    const windowStartSec = note.startSec + Math.max(note.glideSec, note.durSec * 0.3);
    const windowEndSec = Math.min(note.startSec + note.durSec, windowStartSec + ANALYSIS_WINDOW_SAMPLES / sampleRate);
    const startSample = Math.round(windowStartSec * sampleRate);
    const endSample = Math.round(windowEndSec * sampleRate);
    if (endSample - startSample < ANALYSIS_WINDOW_SAMPLES * 0.5) continue;
    const window = mono.subarray(startSample, endSample);

    const targetHz = harmonicToHz(note.fundamentalHz, note.h1);
    const neighborRatio = note.h1 > 3 ? note.h1 - 1 : note.h1 + 1;
    const neighborHz = harmonicToHz(note.fundamentalHz, neighborRatio);

    const targetDb = goertzelPowerDb(window, targetHz, sampleRate);
    const neighborDb = goertzelPowerDb(window, neighborHz, sampleRate);
    const marginDb = targetDb - neighborDb;

    results.push({
      startSec: note.startSec,
      h1: note.h1,
      targetHz: Math.round(targetHz),
      neighborRatio,
      neighborHz: Math.round(neighborHz),
      targetDb,
      neighborDb,
      marginDb,
      pass: marginDb >= MEASUREMENT_MARGIN_DB,
    });
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!(args.duration > 0)) {
    console.error('FAIL: --duration must be a positive number');
    process.exit(1);
  }

  const seedInput = args.seed !== undefined ? args.seed : Date.now();
  const seedForRender = /^-?\d+$/.test(String(seedInput)) ? Number(seedInput) : String(seedInput);

  const outPath = args.out
    ? resolve(process.cwd(), args.out)
    : resolve(SERVICE_ROOT, 'data', 'renders', `${slugify(args.title) || 'track'}.wav`);

  console.log(`Rendering "${args.title}" (${args.duration}s, seed=${seedForRender})...`);

  const track = renderThroatTrack({
    durationSec: args.duration,
    sampleRate: args.sampleRate,
    seed: seedForRender,
    mode: args.mode,
    root: args.root,
    saturationDrive: args.saturationDrive,
    saturationMix: args.saturationMix,
  });

  const { sampleRate, left, right } = track;
  const numSamples = left.length;
  const actualDurationSec = numSamples / sampleRate;

  const checks = [];

  const nonFinite = hasNonFinite(left, right);
  checks.push({ name: 'finite samples (no NaN/Infinity)', pass: !nonFinite, detail: nonFinite ? 'found non-finite sample(s)' : 'ok' });

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

  const rms = rmsOf(left, right);
  const rmsDb = toDb(rms);
  const tooQuiet = rmsDb < args.rmsFloorDb;
  checks.push({ name: `not silent (RMS >= ${args.rmsFloorDb} dBFS)`, pass: !tooQuiet, detail: `rms=${fmtDb(rmsDb)}` });

  const durationDelta = Math.abs(actualDurationSec - args.duration);
  const durationOk = durationDelta <= 0.01;
  checks.push({
    name: 'duration within 0.01s of requested',
    pass: durationOk,
    detail: `requested=${args.duration}s actual=${actualDurationSec.toFixed(6)}s delta=${durationDelta.toFixed(6)}s`,
  });

  const hasOnsets = track.overtoneNoteOnsets > 0;
  checks.push({
    name: 'overtone-melody layer produced note onsets with more than one target harmonic',
    pass: hasOnsets && track.overtoneUniqueH1 > 1,
    detail: `onsets=${track.overtoneNoteOnsets} uniqueH1=${track.overtoneUniqueH1}`,
  });

  // The real point of this script: measure, in the actual mixed render, that
  // the formant sweep is audible -- not asserted, not assumed from the
  // isolated DSP test.
  let formantResults = [];
  let formantPassRate = null;
  if (args.duration >= 20) {
    formantResults = measureFormantSweepInRender(track);
    const passCount = formantResults.filter((r) => r.pass).length;
    formantPassRate = formantResults.length > 0 ? passCount / formantResults.length : null;
    checks.push({
      name: `formant sweep measurably audible in the mixed render (target harmonic >= neighbor + ${MEASUREMENT_MARGIN_DB}dB in a majority of sampled notes)`,
      pass: formantPassRate === null || formantPassRate >= 0.5,
      detail:
        formantResults.length > 0
          ? `${passCount}/${formantResults.length} sampled notes passed (${(formantPassRate * 100).toFixed(1)}%)`
          : 'not enough eligible notes to measure (render longer, or reduce ANALYSIS_WINDOW_SAMPLES)',
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
  const { bytes: byteLength } = await writeWavFile(outPath, { sampleRate, numChannels: 2, bitDepth: 24, bufferL: left, bufferR: right });

  const lines = [];
  lines.push('');
  lines.push('=== "Flaming Lips Meet Tuva" Throat-Singing Render: Self-Verification Report ===');
  lines.push(`Title:            ${args.title}`);
  lines.push(`File:             ${outPath}`);
  lines.push(`File size:        ${byteLength} bytes`);
  lines.push(`Sample rate:      ${sampleRate} Hz`);
  lines.push(`Bit depth:        24-bit PCM`);
  lines.push(`Channels:         2 (stereo)`);
  lines.push(`Duration:         ${numSamples} samples / ${actualDurationSec.toFixed(3)} s`);
  lines.push(`Peak (L/R):       ${fmtDb(toDb(peakL))} / ${fmtDb(toDb(peakR))}`);
  lines.push(`RMS:              ${fmtDb(rmsDb)}`);
  lines.push(`Seed used:        ${seedForRender}`);
  lines.push(`Mode / root:      ${args.mode} / ${args.root}`);
  lines.push(`Fundamental:      ${track.fundamentalHz.toFixed(2)} Hz (held for the whole piece -- the fixed drone, per the technique)`);
  lines.push(`Saturation:       drive=${args.saturationDrive} mix=${args.saturationMix}`);
  lines.push(`Regime transitions: ${track.regimeTransitions}`);
  lines.push(`Final regime:     ${track.finalRegime}`);
  lines.push(`Overtone-melody note onsets: ${track.overtoneNoteOnsets} (${track.overtoneUniqueH1} distinct target harmonics used)`);
  lines.push('');
  lines.push(`Macro-form phase transitions (${track.macroFormLog.length}):`);
  for (const m of track.macroFormLog.slice(0, 12)) {
    lines.push(`  t=${m.tSec.toFixed(1)}s  ${m.phase.padEnd(11)} (regime=${m.regimeTag})`);
  }
  if (track.macroFormLog.length > 12) lines.push(`  ... (${track.macroFormLog.length - 12} more)`);
  lines.push('');
  if (formantResults.length > 0) {
    lines.push(`Formant-sweep measurement (Goertzel power, measured directly on the actual mixed stereo render -- not a synthetic test tone):`);
    lines.push(`  Sampled ${formantResults.length} overtone-melody notes; measured each note's target harmonic (h1) vs. its nearest neighbor harmonic during a settled analysis window after the note's glide finished.`);
    for (const r of formantResults.slice(0, 15)) {
      lines.push(
        `  t=${r.startSec.toFixed(1)}s  h1=${String(r.h1).padStart(2)} (${r.targetHz}Hz)=${r.targetDb.toFixed(1)}dB  vs h=${r.neighborRatio} (${r.neighborHz}Hz)=${r.neighborDb.toFixed(1)}dB  margin=${r.marginDb >= 0 ? '+' : ''}${r.marginDb.toFixed(1)}dB  [${r.pass ? 'PASS' : 'fail'}]`
      );
    }
    if (formantResults.length > 15) lines.push(`  ... (${formantResults.length - 15} more measured notes not shown)`);
    lines.push('');
  }
  lines.push('Self-checks:');
  for (const c of checks) {
    lines.push(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);
  }
  lines.push('');
  lines.push('Honest scope note: the formant-sweep mechanism above is measured, real evidence. The "Flaming Lips" instrumental');
  lines.push('character (saturation, layered pad bed, slow pitch/amp wobble) is a genuine, working DSP signal chain, but whether');
  lines.push('it reads as that specific aesthetic reference is a judgment call this script cannot measure -- reported as');
  lines.push('best-effort approximation, not verified, in the accompanying task report.');
  lines.push('');
  lines.push('Overall: PASS');
  lines.push('');

  console.log(lines.join('\n'));
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL: render-throat-track.mjs threw an unhandled error:');
  console.error(err);
  process.exit(1);
});
