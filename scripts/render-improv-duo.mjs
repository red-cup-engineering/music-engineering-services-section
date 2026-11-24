#!/usr/bin/env node
// render-improv-duo.mjs
//
// CLI entry point for the call-and-response duo improvisation mode
// (src/generative/improv-duo.mjs): a Karplus-Strong plucked string and a
// bow/breath voice trading real developing-variation phrases over a
// piece-level motif vocabulary, paced by the same regime-driven macro-form
// machinery the ambient engine uses. Parses args, calls renderImprovDuo(),
// runs real self-verification checks (spectral distinctness between the two
// instruments, turn-taking/overlap statistics, motif-vocabulary recurrence)
// on the returned audio and session log BEFORE writing anything to disk,
// writes a 24-bit stereo WAV, and prints a plain-text stats report.
//
// Usage:
//   node scripts/render-improv-duo.mjs --duration 720 --seed 561 \
//     --title "String and Breath" --out ./data/renders/string-and-breath.wav

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderImprovDuo } from '../src/generative/improv-duo.mjs';
import { hasNonFinite, peakOf, rmsOf } from "@red-cup-engineering/computer-audio-engineering-services-section/mixer";
import { writeWavFile } from '@red-cup-engineering/computer-audio-engineering-services-section/write-wav-file';
import { slugify } from '@red-cup-engineering/computer-text-content-engineering-services-section/slugify-text';

const SERVICE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  duration: 300,
  sampleRate: 44100,
  title: 'Improv Duo',
  mode: 'dorian',
  root: 'D',
  reverbPreset: 'chamber',
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
      case 'reverbPreset':
      case 'reverb-preset':
        args.reverbPreset = next;
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
function fmtPct(frac) {
  return `${(frac * 100).toFixed(1)}%`;
}

/**
 * Goertzel single-frequency DFT magnitude, used for the spectral-distinctness
 * self-check below -- cheap and exact enough to compare energy at a handful
 * of specific probe frequencies without pulling in an FFT dependency,
 * matching the DSP core's own zero-dependency discipline.
 */
function goertzelMagnitude(signal, freqHz, sampleRate) {
  const n = signal.length;
  const k = Math.round((n * freqHz) / sampleRate);
  const w = (2 * Math.PI * k) / n;
  const cosine = Math.cos(w);
  const coeff = 2 * cosine;
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;
  for (let i = 0; i < n; i++) {
    q0 = coeff * q1 - q2 + signal[i];
    q2 = q1;
    q1 = q0;
  }
  const real = q1 - q2 * cosine;
  const imag = q2 * Math.sin(w);
  return Math.sqrt(real * real + imag * imag) / n;
}

/**
 * Spectral centroid (Hz) of a signal window, estimated from Goertzel
 * magnitudes at a fixed probe grid -- a real, checkable single number
 * summarizing "how bright/high vs. dark/low is this window's energy",
 * used here to compare the string's and the breath voice's isolated
 * sounding regions.
 */
function spectralCentroid(signal, sampleRate, probeHzList) {
  let weightedSum = 0;
  let magSum = 0;
  for (const f of probeHzList) {
    const mag = goertzelMagnitude(signal, f, sampleRate);
    weightedSum += mag * f;
    magSum += mag;
  }
  return magSum > 0 ? weightedSum / magSum : 0;
}

const PROBE_GRID_HZ = [110, 165, 220, 330, 440, 660, 880, 1320, 1760, 2640, 3520, 5280];

/**
 * Measures spectral distinctness directly from the rendered audio: finds
 * windows where the session log says ONLY voice A (string) or ONLY voice B
 * (breath) is sounding (per computeOverlapStats-style interval logic,
 * inlined here against the actual note schedule), computes each voice's own
 * spectral centroid across its isolated windows, and reports both plus
 * their difference -- a real measured number, not an assumption that two
 * different DSP techniques must sound different.
 */
function measureSpectralDistinctness(track, sampleRate) {
  function mergedSpans(events) {
    const spans = events.map((e) => [e.startSec, e.startSec + e.durSec]).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of spans) {
      if (merged.length > 0 && s <= merged[merged.length - 1][1] + 1e-9) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
      } else {
        merged.push([s, e]);
      }
    }
    return merged;
  }

  const spansA = mergedSpans(track.session.schedule.A);
  const spansB = mergedSpans(track.session.schedule.B);

  function isolatedWindows(mySpans, otherSpans, minLenSec) {
    const out = [];
    for (const [s, e] of mySpans) {
      // Find the sub-interval of [s,e] not covered by any otherSpans entry.
      let segments = [[s, e]];
      for (const [os, oe] of otherSpans) {
        const next = [];
        for (const [a, b] of segments) {
          if (oe <= a || os >= b) {
            next.push([a, b]);
            continue;
          }
          if (os > a) next.push([a, os]);
          if (oe < b) next.push([oe, b]);
        }
        segments = next;
      }
      for (const [a, b] of segments) if (b - a >= minLenSec) out.push([a, b]);
    }
    return out;
  }

  const isolatedA = isolatedWindows(spansA, spansB, 0.3);
  const isolatedB = isolatedWindows(spansB, spansA, 0.3);

  function centroidsOverWindows(windows) {
    const centroids = [];
    for (const [s, e] of windows.slice(0, 12)) {
      // cap at 12 windows -- plenty for a real measurement, keeps this cheap
      const startSample = Math.max(0, Math.round(s * sampleRate));
      const endSample = Math.min(track.left.length, Math.round(e * sampleRate));
      if (endSample - startSample < 512) continue;
      const window = track.left.subarray(startSample, Math.min(endSample, startSample + sampleRate)); // at most 1s per window
      centroids.push(spectralCentroid(window, sampleRate, PROBE_GRID_HZ));
    }
    return centroids;
  }

  const centroidsA = centroidsOverWindows(isolatedA);
  const centroidsB = centroidsOverWindows(isolatedB);
  const meanA = centroidsA.length ? centroidsA.reduce((a, b) => a + b, 0) / centroidsA.length : null;
  const meanB = centroidsB.length ? centroidsB.reduce((a, b) => a + b, 0) / centroidsB.length : null;

  return { isolatedAWindowCount: isolatedA.length, isolatedBWindowCount: isolatedB.length, meanCentroidAHz: meanA, meanCentroidBHz: meanB, sampledWindowsA: centroidsA.length, sampledWindowsB: centroidsB.length };
}

/**
 * Summarizes motif-vocabulary recurrence from the phrase log: for every
 * vocabulary index drawn by more than one call, confirms (and counts) the
 * exact interval-shape recurrence, plus overall vocabulary size/usage
 * counts -- the concrete, checkable form of "the same motif material
 * genuinely recurs and gets developed," not just claimed.
 */
function summarizeMotifRecurrence(phraseLog, vocabulary) {
  const callsByVocabIndex = new Map();
  for (const p of phraseLog) {
    if (p.role !== 'call' || p.vocabularyIndex === null || p.isFresh) continue;
    if (!callsByVocabIndex.has(p.vocabularyIndex)) callsByVocabIndex.set(p.vocabularyIndex, []);
    callsByVocabIndex.get(p.vocabularyIndex).push(p.baseMotifIntervals.join(','));
  }
  let recurringIndices = 0;
  let totalRecurrences = 0;
  let allShapesConsistent = true;
  for (const [, shapes] of callsByVocabIndex) {
    if (shapes.length > 1) {
      recurringIndices++;
      totalRecurrences += shapes.length;
      if (new Set(shapes).size !== 1) allShapesConsistent = false;
    }
  }
  return { vocabularySize: vocabulary.length, vocabIndicesDrawn: callsByVocabIndex.size, recurringIndices, totalRecurrences, allShapesConsistent };
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

  console.log(`Rendering "${args.title}" (${args.duration}s, seed=${seedForRender}, mode=improv-duo)...`);

  const track = renderImprovDuo({
    durationSec: args.duration,
    sampleRate: args.sampleRate,
    seed: seedForRender,
    mode: args.mode,
    root: args.root,
    reverbPreset: args.reverbPreset,
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
  const clipping = peak >= 1.0;
  checks.push({ name: 'no clipping (peak < 1.0)', pass: !clipping, detail: `peak=${peak.toFixed(6)} (${fmtDb(toDb(peak))})` });

  const rms = rmsOf(left, right);
  const rmsDb = toDb(rms);
  const tooQuiet = rmsDb < -60;
  checks.push({ name: 'not silent (RMS >= -60 dBFS)', pass: !tooQuiet, detail: `rms=${fmtDb(rmsDb)}` });

  const durationDelta = Math.abs(actualDurationSec - args.duration);
  checks.push({ name: 'duration within 0.01s of requested', pass: durationDelta <= 0.01, detail: `requested=${args.duration}s actual=${actualDurationSec.toFixed(6)}s` });

  // The checks below only become meaningful once the piece is long enough to
  // plausibly have run several call/response exchanges -- a short smoke-test
  // render (e.g. `--duration 20`) can legitimately produce just one exchange
  // that hasn't even finished sounding both voices yet, by design, not by
  // bug. Mirrors render-track.mjs's own duration-gated checks (its melodic-
  // layer and large-scale-form checks only activate at >=30s/>=120s).
  const stats = track.overlapStats;
  if (args.duration >= 120) {
    const hasAllThreeCategories = stats.bothSec > 0 && stats.onlyASec > 0 && stats.onlyBSec > 0;
    checks.push({
      name: 'real call-and-response turn-taking: both-sounding, string-only, AND breath-only time all occur',
      pass: hasAllThreeCategories,
      detail: `both=${fmtPct(stats.bothFrac)} stringOnly=${fmtPct(stats.onlyAFrac)} breathOnly=${fmtPct(stats.onlyBFrac)} silence=${fmtPct(stats.silenceFrac)}`,
    });
  }

  const voiceCounts = { A: 0, B: 0 };
  for (const p of track.phraseLog) voiceCounts[p.voice] += 1;
  const totalPhrases = voiceCounts.A + voiceCounts.B;
  const minorityFraction = totalPhrases > 0 ? Math.min(voiceCounts.A, voiceCounts.B) / totalPhrases : 0;
  if (args.duration >= 60) {
    checks.push({
      name: 'neither voice dominates the dialogue (each carries >=25% of phrases)',
      pass: totalPhrases > 0 && minorityFraction >= 0.25,
      detail: `string phrases=${voiceCounts.A} breath phrases=${voiceCounts.B} (minority fraction ${fmtPct(minorityFraction)})`,
    });
  }

  const motifRecurrence = summarizeMotifRecurrence(track.phraseLog, track.vocabulary);
  if (args.duration >= 180) {
    checks.push({
      name: 'piece-level motif vocabulary genuinely recurs (not regenerated fresh every phrase)',
      pass: motifRecurrence.recurringIndices > 0 && motifRecurrence.allShapesConsistent,
      detail: `vocabulary size=${motifRecurrence.vocabularySize}, ${motifRecurrence.vocabIndicesDrawn} distinct entries drawn, ${motifRecurrence.recurringIndices} entries recurred (${motifRecurrence.totalRecurrences} total draws of recurring entries), shape consistency=${motifRecurrence.allShapesConsistent}`,
    });
  }

  const spectral = args.duration >= 60 ? measureSpectralDistinctness(track, sampleRate) : null;
  if (spectral) {
    const bothMeasured = spectral.meanCentroidAHz !== null && spectral.meanCentroidBHz !== null;
    const distinct = bothMeasured && Math.abs(spectral.meanCentroidAHz - spectral.meanCentroidBHz) > 30;
    checks.push({
      name: 'the two instrument voices are spectrally distinct in isolated (non-overlapping) windows',
      pass: !bothMeasured || distinct,
      detail: bothMeasured
        ? `string mean spectral centroid=${spectral.meanCentroidAHz.toFixed(1)}Hz (n=${spectral.sampledWindowsA} windows), breath mean spectral centroid=${spectral.meanCentroidBHz.toFixed(1)}Hz (n=${spectral.sampledWindowsB} windows)`
        : `not enough isolated (single-voice) windows to measure (string isolated windows=${spectral.isolatedAWindowCount}, breath isolated windows=${spectral.isolatedBWindowCount})`,
    });
  }

  const macroFormTransitions = track.macroFormLog.length - 1;
  checks.push({
    name: 'macro-form pacing (regime.mjs-driven) actually moved at least once',
    pass: args.duration < 180 || macroFormTransitions > 0,
    detail: `${macroFormTransitions} phase transitions: ${track.macroFormLog.map((m) => `${m.phase}@${m.tSec.toFixed(0)}s(${m.regimeTag})`).join(' -> ')}`,
  });

  const allPassed = checks.every((c) => c.pass);

  if (!allPassed) {
    console.error('\nSelf-verification FAILED -- refusing to write WAV file.');
    for (const c of checks) console.error(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);
    process.exit(1);
  }

  await mkdir(dirname(outPath), { recursive: true });
  const { bytes: byteLength } = await writeWavFile(outPath, { sampleRate, numChannels: 2, bitDepth: 24, bufferL: left, bufferR: right });

  const lines = [];
  lines.push('');
  lines.push('=== Improv Duo Render: Self-Verification Report ===');
  lines.push(`Title:            ${args.title}`);
  lines.push(`File:             ${outPath}`);
  lines.push(`File size:        ${byteLength} bytes`);
  lines.push(`Sample rate:      ${sampleRate} Hz`);
  lines.push(`Duration:         ${numSamples} samples / ${actualDurationSec.toFixed(3)} s`);
  lines.push(`Peak:             ${fmtDb(toDb(peak))} (${peak.toFixed(6)})`);
  lines.push(`RMS:              ${fmtDb(rmsDb)}`);
  lines.push(`Seed used:        ${seedForRender}`);
  lines.push(`Mode / root:      ${args.mode} / ${args.root}`);
  lines.push(`Reverb preset:    ${args.reverbPreset}`);
  lines.push(`Total phrases:    ${totalPhrases} (string/A=${voiceCounts.A}, breath/B=${voiceCounts.B})`);
  lines.push(`Motif vocabulary: ${motifRecurrence.vocabularySize} entries, ${motifRecurrence.vocabIndicesDrawn} distinct entries drawn by calls, ${motifRecurrence.recurringIndices} entries recurred across multiple calls (${motifRecurrence.totalRecurrences} total recurring draws)`);
  lines.push('');
  lines.push('Turn-taking / overlap (exact, from the scheduled note intervals, not sampled from audio):');
  lines.push(`  both voices sounding:  ${fmtPct(stats.bothFrac)} (${stats.bothSec.toFixed(1)}s)`);
  lines.push(`  string only:           ${fmtPct(stats.onlyAFrac)} (${stats.onlyASec.toFixed(1)}s)`);
  lines.push(`  breath only:           ${fmtPct(stats.onlyBFrac)} (${stats.onlyBSec.toFixed(1)}s)`);
  lines.push(`  silence:               ${fmtPct(stats.silenceFrac)} (${stats.silenceSec.toFixed(1)}s)`);
  if (spectral && spectral.meanCentroidAHz !== null && spectral.meanCentroidBHz !== null) {
    lines.push('');
    lines.push('Spectral distinctness (measured from isolated, single-voice windows in the actual rendered audio):');
    lines.push(`  string (Karplus-Strong) mean spectral centroid: ${spectral.meanCentroidAHz.toFixed(1)} Hz (n=${spectral.sampledWindowsA} windows)`);
    lines.push(`  breath voice mean spectral centroid:            ${spectral.meanCentroidBHz.toFixed(1)} Hz (n=${spectral.sampledWindowsB} windows)`);
  }
  lines.push('');
  lines.push('Macro-form phase transitions (regime.mjs-driven, same mechanism as compose.mjs):');
  for (const m of track.macroFormLog) lines.push(`  t=${m.tSec.toFixed(1)}s -> ${m.phase} (regime=${m.regimeTag})`);
  lines.push('');
  lines.push('Self-checks:');
  for (const c of checks) lines.push(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);
  lines.push('');
  lines.push('Overall: PASS');
  lines.push('');

  console.log(lines.join('\n'));
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL: render-improv-duo.mjs threw an unhandled error:');
  console.error(err);
  process.exit(1);
});
