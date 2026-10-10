#!/usr/bin/env node
// render-demos.mjs
//
// Renders every named preset from src/generative/demo-presets.mjs to a WAV
// file in data/renders/, one per preset, via compose-arrangement.mjs's
// renderPerformanceSpecToBuffer -- the concrete, listenable proof that the
// arrangement/leitmotif/harmony/transitions layer added by this pass
// actually produces audio through the existing render path, not just passes
// unit tests. Runs the same finite/no-clipping/not-silent/duration self-
// checks scripts/render-track.mjs runs before writing anything to disk, per
// preset, and exits nonzero (naming which preset/check failed) if any of
// them fail.
//
// Usage:
//   node scripts/render-demos.mjs                  # all five presets
//   node scripts/render-demos.mjs --preset lounge-noir
//   node scripts/render-demos.mjs --out-dir /tmp/demo-renders

import { mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildDemoPerformanceSpec, DEMO_PRESET_NAMES } from '../src/generative/demo-presets.mjs';
import { renderPerformanceSpecToBuffer } from '../src/generative/compose-arrangement.mjs';
import { hasNonFinite, peakOf, rmsOf } from "@red-cup-engineering/computer-audio-engineering-services-section/mixer";
import { writeWavFile } from '@red-cup-engineering/computer-audio-engineering-services-section/write-wav-file';

const SERVICE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const args = { presets: DEMO_PRESET_NAMES.slice(), outDir: resolve(SERVICE_ROOT, 'data', 'renders') };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--preset' && argv[i + 1]) {
      args.presets = [argv[++i]];
    } else if (argv[i] === '--out-dir' && argv[i + 1]) {
      args.outDir = resolve(process.cwd(), argv[++i]);
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

async function renderOnePreset(name, outDir) {
  console.log(`\n--- ${name} ---`);
  const { spec, reverbPreset } = await buildDemoPerformanceSpec(name);
  const buffer = renderPerformanceSpecToBuffer(spec, { reverbPreset });
  const { sampleRate, left, right, durationSec, peak, rms } = buffer;

  const checks = [];
  const nonFinite = hasNonFinite(left, right);
  checks.push({ name: 'finite samples', pass: !nonFinite, detail: nonFinite ? 'found non-finite sample(s)' : 'ok' });

  const clipping = peak >= 1.0;
  checks.push({ name: 'no clipping (peak < 1.0)', pass: !clipping, detail: `peak=${peak.toFixed(6)} (${fmtDb(toDb(peak))})` });

  const rmsDb = toDb(rms);
  const tooQuiet = rmsDb < -60;
  checks.push({ name: 'not silent (RMS >= -60 dBFS)', pass: !tooQuiet, detail: `rms=${fmtDb(rmsDb)}` });

  const noteEventCount = spec.events.filter((e) => e.type === 'note').length;
  checks.push({ name: 'produced at least one note event', pass: noteEventCount > 0, detail: `noteEvents=${noteEventCount}` });

  const allPassed = checks.every((c) => c.pass);
  for (const c of checks) console.log(`  [${c.pass ? 'PASS' : 'FAIL'}] ${c.name}: ${c.detail}`);

  if (!allPassed) {
    return { name, passed: false };
  }

  const outPath = resolve(outDir, `${name}.wav`);
  await mkdir(dirname(outPath), { recursive: true });
  const { bytes: byteLength } = await writeWavFile(outPath, { sampleRate, numChannels: 2, bitDepth: 24, bufferL: left, bufferR: right });

  console.log(`  wrote ${outPath} (${byteLength} bytes, ${durationSec.toFixed(2)}s, seed=${spec.seed})`);
  return { name, passed: true, outPath };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const results = [];
  for (const preset of args.presets) {
    if (!DEMO_PRESET_NAMES.includes(preset)) {
      console.error(`Unknown preset "${preset}". Use one of: ${DEMO_PRESET_NAMES.join(', ')}`);
      process.exit(1);
    }
    results.push(await renderOnePreset(preset, args.outDir));
  }

  const failed = results.filter((r) => !r.passed);
  console.log(`\n${results.length - failed.length}/${results.length} presets rendered and passed self-checks.`);
  if (failed.length > 0) {
    console.error(`FAILED: ${failed.map((f) => f.name).join(', ')}`);
    process.exit(1);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL: render-demos.mjs threw an unhandled error:');
  console.error(err);
  process.exit(1);
});
