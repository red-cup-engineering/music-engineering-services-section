// demo-presets.test.mjs
//
// Checks demo-presets.mjs: every named preset builds a valid, non-trivial
// performance spec, is deterministic given its own default seed, and (for
// the two presets that specifically layer a transition on top of the base
// arrangement) actually contains the transition event the preset's own
// description claims. Also renders each preset's spec through
// compose-arrangement.mjs and checks the resulting audio is finite and
// non-silent -- the same self-checks scripts/render-demos.mjs runs before
// writing a WAV, run here so a broken preset fails `npm test`, not just a
// manual render.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDemoPerformanceSpec, DEMO_PRESET_NAMES } from '../src/generative/demo-presets.mjs';
import { validatePerformanceSpec } from '../src/generative/performance-spec.mjs';
import { renderPerformanceSpecToBuffer } from '../src/generative/compose-arrangement.mjs';
import { hasNonFinite } from "@red-cup-engineering/computer-audio-engineering-services-section/mixer";

for (const name of DEMO_PRESET_NAMES) {
  test(`preset "${name}" builds a valid performance spec with at least one note event`, async () => {
    const { spec, reverbPreset } = await buildDemoPerformanceSpec(name);
    assert.equal(validatePerformanceSpec(spec), true);
    assert.ok(['deepAmbient', 'hall', 'chamber'].includes(reverbPreset));
    const noteCount = spec.events.filter((e) => e.type === 'note').length;
    assert.ok(noteCount > 0, `preset "${name}" produced no note events`);
  });

  test(`preset "${name}" is deterministic given its default seed`, async () => {
    const a = await buildDemoPerformanceSpec(name);
    const b = await buildDemoPerformanceSpec(name);
    assert.deepEqual(a.spec.events, b.spec.events);
  });

  test(`preset "${name}" renders to finite, non-silent audio`, async () => {
    const { spec, reverbPreset } = await buildDemoPerformanceSpec(name);
    const buffer = renderPerformanceSpecToBuffer(spec, { reverbPreset });
    assert.equal(hasNonFinite(buffer.left, buffer.right), false);
    assert.ok(buffer.peak > 0, 'render should not be literal silence');
    assert.ok(buffer.peak < 1.0, 'render should not be clipping');
  });
}

test('anticipation-riser preset contains a riser transition automating cutoffHz', async () => {
  const { spec } = await buildDemoPerformanceSpec('anticipation-riser');
  const riser = spec.events.find((e) => e.type === 'transition' && e.kind === 'riser');
  assert.ok(riser, 'expected a riser transition marker');
  const automation = spec.events.find((e) => e.type === 'automation' && e.param === 'cutoffHz');
  assert.ok(automation, 'expected a cutoffHz automation event');
  assert.ok(automation.toValue > automation.fromValue, 'riser should ramp upward');
});

test('celebration-fanfare preset contains a motif-driven stinger at the top of the piece', async () => {
  const { spec } = await buildDemoPerformanceSpec('celebration-fanfare');
  const stinger = spec.events.find((e) => e.type === 'transition' && e.kind === 'stinger');
  assert.ok(stinger, 'expected a stinger transition marker');
  assert.equal(stinger.startSec, 0);
});

test('guqin-echo preset labels its title with the corpus fixture status (illustrative, not a transcription)', async () => {
  const { spec, meta } = await buildDemoPerformanceSpec('guqin-echo');
  assert.ok(meta && /synthetic|illustrative/i.test(meta.fixtureStatus), 'expected the corpus fixture status to read as illustrative/synthetic');
  assert.ok(/synthetic|illustrative|ILLUSTRATIVE/i.test(spec.title));
});
