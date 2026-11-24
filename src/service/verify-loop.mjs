#!/usr/bin/env node
// verify-loop.mjs
//
// Standalone diagnostic (no HTTP server needed) that renders a loopable bed
// via renderLoopableTrack() and measures how discontinuous the actual loop
// seam is, per presets.mjs's measureLoopSeam(): it concatenates the render
// with itself and compares the sample jump at the seam against the typical
// sample-to-sample jump seen elsewhere in the same buffer. This is the
// "actually run it" verification for the loop-crossfade approach -- not
// just "it ran without throwing".
//
// Usage:
//   node src/service/verify-loop.mjs [presetId] [seed]
//   node src/service/verify-loop.mjs bed-calm 561

import { BED_PRESETS, renderLoopableTrack, measureLoopSeam } from './presets.mjs';
import { hasNonFinite, peakOf } from "@red-cup-engineering/computer-audio-engineering-services-section/mixer";

const presetId = process.argv[2] || 'bed-calm';
const seed = process.argv[3] || 561;

const preset = BED_PRESETS[presetId];
if (!preset) {
  console.error(`unknown bed preset "${presetId}" -- known: ${Object.keys(BED_PRESETS).join(', ')}`);
  process.exit(1);
}

console.log(`rendering "${presetId}" (loopSec=${preset.loopSec}, loopFadeSec=${preset.loopFadeSec}, seed=${seed}) ...`);
const t0 = Date.now();
const track = renderLoopableTrack({ ...preset, seed });
const wallMs = Date.now() - t0;
console.log(`rendered in ${wallMs}ms (sourceDurationSec=${track.sourceDurationSec}, audible loopSec=${track.durationSec})`);

if (hasNonFinite(track.left, track.right)) {
  console.error('FAIL: non-finite samples in loop render');
  process.exit(1);
}

const peak = peakOf(track.left, track.right);
console.log(`peak=${peak.toFixed(6)}`);

const seam = measureLoopSeam(track);
console.log('');
console.log('=== Loop seam measurement (concatenate-with-self test) ===');
console.log(`typical sample-to-sample jump:  ${seam.typicalJump.toExponential(4)}  (${seam.typicalJumpDb.toFixed(2)} dBFS)`);
console.log(`seam sample-to-sample jump:     ${seam.seamJump.toExponential(4)}  (${seam.seamJumpDb.toFixed(2)} dBFS)`);
console.log(`ratio (seam / typical):         ${seam.ratio.toFixed(3)}x`);
console.log('');

// A seam jump at or below a small multiple of the typical in-buffer jump
// means the loop point isn't distinguishable from ordinary signal movement.
// A large ratio (order of magnitude+) means there's a real click/step at
// the seam. This threshold is a diagnostic judgment call, not a spec value
// from anywhere else in the codebase.
const RATIO_THRESHOLD = 5;
if (seam.ratio <= RATIO_THRESHOLD) {
  console.log(`PASS: seam jump is within ${RATIO_THRESHOLD}x the typical in-buffer sample jump -- no measurable click at the loop point.`);
  process.exit(0);
} else {
  console.log(`FAIL: seam jump is ${seam.ratio.toFixed(1)}x the typical in-buffer sample jump -- likely audible as a click/step.`);
  process.exit(1);
}
