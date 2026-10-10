#!/usr/bin/env node
// render-arrangement.mjs
//
// CLI entry point for the intensity-layered stem arrangement engine
// (src/generative/arrangement.mjs + compose-arrangement.mjs) -- the general-
// purpose counterpart to scripts/render-demos.mjs's fixed presets. Builds an
// arrangement from CLI flags, schedules it at a constant intensity (use the
// demo presets, or call the library directly, for a scored intensity arc),
// renders it via the same performance-spec contract a downstream realtime
// player consumes, and writes a WAV via the existing dsp/wav-writer.mjs path
// -- mirroring render-track.mjs's self-verify-before-write discipline.
//
// Usage:
//   node scripts/render-arrangement.mjs --duration 30 --seed 561 \
//     --title "Arrangement Demo" --intensity 0.6 --root D --mode dorian

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeArrangement, scheduleArrangement } from '../src/generative/arrangement.mjs';
import { buildPerformanceSpec, validatePerformanceSpec } from '../src/generative/performance-spec.mjs';
import { renderPerformanceSpecToBuffer } from '../src/generative/compose-arrangement.mjs';
import { hasNonFinite, peakOf, rmsOf } from "@red-cup-engineering/computer-audio-engineering-services-section/mixer";
import { writeWavFile } from '@red-cup-engineering/computer-audio-engineering-services-section/write-wav-file';
import { slugify } from '@red-cup-engineering/computer-text-content-engineering-services-section/slugify-text';

const SERVICE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const DEFAULTS = {
  duration: 30,
  title: 'Arrangement Demo',
  mode: 'dorian',
  root: 'D',
  tempoBpm: 90,
  intensity: 0.6,
  reverbPreset: 'deepAmbient',
};

function parseArgs(argv) {
  const args = { ...DEFAULTS };
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i];
    if (!raw.startsWith('--')) continue;
    const key = raw.slice(2);
    const next = argv[i + 1];
    switch (key) {
      case 'duration': args.duration = Number(next); i++; break;
      case 'seed': args.seed = next; i++; break;
      case 'title': args.title = next; i++; break;
      case 'out': args.out = next; i++; break;
      case 'mode': args.mode = next; i++; break;
      case 'root': args.root = next; i++; break;
      case 'tempoBpm': args.tempoBpm = Number(next); i++; break;
      case 'intensity': args.intensity = Number(next); i++; break;
      case 'reverbPreset': args.reverbPreset = next; i++; break;
      default: break;
    }
  }
  return args;
}


function toDb(linear) {
  return linear > 0 ? 20 * Math.log10(linear) : -Infinity;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!(args.duration > 0)) {
    console.error('FAIL: --duration must be a positive number');
    process.exit(1);
  }

  const seedInput = args.seed !== undefined ? args.seed : Date.now();
  const seedForRender = /^-?\d+$/.test(String(seedInput)) ? Number(seedInput) : String(seedInput);

  const outPath = args.out ? resolve(process.cwd(), args.out) : resolve(SERVICE_ROOT, 'data', 'renders', `${slugify(args.title) || 'arrangement'}.wav`);

  console.log(`Rendering arrangement "${args.title}" (${args.duration}s, seed=${seedForRender}, intensity=${args.intensity})...`);

  const arrangement = makeArrangement({ seed: seedForRender, root: args.root, mode: args.mode, tempoBpm: args.tempoBpm });
  const scheduled = scheduleArrangement(arrangement, { durationSec: args.duration, intensityFn: args.intensity });
  const spec = buildPerformanceSpec(arrangement, scheduled, { title: args.title, durationSec: args.duration });
  validatePerformanceSpec(spec);
  const buffer = renderPerformanceSpecToBuffer(spec, { reverbPreset: args.reverbPreset });

  const { sampleRate, left, right, durationSec, peak, rms } = buffer;

  const checks = [];
  const nonFinite = hasNonFinite(left, right);
  checks.push({ name: 'finite samples (no NaN/Infinity)', pass: !nonFinite, detail: nonFinite ? 'found non-finite sample(s)' : 'ok' });
  checks.push({ name: 'no clipping (peak < 1.0)', pass: peak < 1.0, detail: `peak=${peak.toFixed(6)}` });
  const rmsDb = toDb(rms);
  checks.push({ name: 'not silent (RMS >= -60 dBFS)', pass: rmsDb >= -60, detail: `rms=${rmsDb.toFixed(2)} dBFS` });

  const allPassed = checks.every((c) => c.pass);
  if (!allPassed) {
    console.error('\nSelf-verification FAILED -- refusing to write WAV file.');
    for (const c of checks) console.error(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);
    process.exit(1);
  }

  await mkdir(dirname(outPath), { recursive: true });
  const { bytes: byteLength } = await writeWavFile(outPath, { sampleRate, numChannels: 2, bitDepth: 24, bufferL: left, bufferR: right });

  console.log('');
  console.log('=== Arrangement Render: Self-Verification Report ===');
  console.log(`Title:         ${args.title}`);
  console.log(`File:          ${outPath}`);
  console.log(`File size:     ${byteLength} bytes`);
  console.log(`Duration:      ${durationSec.toFixed(3)}s`);
  console.log(`Seed used:     ${seedForRender}`);
  console.log(`Mode / root:   ${args.mode} / ${args.root}`);
  console.log(`Note events:   ${spec.events.filter((e) => e.type === 'note').length}`);
  console.log('Self-checks:');
  for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);
  console.log('\nOverall: PASS\n');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL: render-arrangement.mjs threw an unhandled error:');
  console.error(err);
  process.exit(1);
});
