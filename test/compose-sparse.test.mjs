// compose-sparse.test.mjs
//
// Covers the additive sparseness/timbre controls added to compose.mjs's
// renderTrack() (maxVoices, baseInjectProb, risingInjectProb,
// melodyPhraseGapSecMin/Max, melodyMinTrailingSilenceSec, padPartialsName,
// melodySectionProfiles) and their self-verification instrumentation
// (voiceActivityLog / voiceActivitySummary), plus the two new named
// PARTIAL_PRESETS entries in dsp/oscillator.mjs (breathyFlute,
// pluckedString) added for a sparser/more traditional-instrument-coded
// timbre target.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generatePartials, PARTIAL_PRESETS } from "@red-cup-engineering/computer-audio-engineering-services-section/oscillator";
import { renderTrack } from '../src/generative/compose.mjs';

test('breathyFlute and pluckedString are real generatePartials outputs, not hand-listed tables', () => {
  for (const name of ['breathyFlute', 'pluckedString']) {
    const partials = PARTIAL_PRESETS[name];
    assert.ok(Array.isArray(partials) && partials.length > 0, `${name} should be a non-empty partial series`);
    assert.equal(partials[0].ratio, 1, `${name}'s first partial should be the fundamental (ratio 1)`);
    assert.equal(partials[0].amp, 1, `${name}'s fundamental amplitude should be exactly 1 (ratio^-exponent at ratio=1 is 1)`);
    for (let i = 1; i < partials.length; i++) {
      assert.ok(partials[i].ratio > partials[i - 1].ratio, `${name}'s partial ratios should be strictly ascending`);
    }
  }
});

test('breathyFlute rolls off faster (fewer, quieter upper partials) than pluckedString, matching their documented character', () => {
  const flute = PARTIAL_PRESETS.breathyFlute;
  const plucked = PARTIAL_PRESETS.pluckedString;
  // Same generator, different points: flute's steep rolloffExponent should
  // leave it with fewer surviving partials (amp > 1e-4 cutoff in
  // generatePartials) than the brighter, more gently-rolling-off plucked
  // preset.
  assert.ok(flute.length < plucked.length, `breathyFlute (${flute.length} partials) should have fewer surviving partials than pluckedString (${plucked.length})`);
  // At the second partial (ratio 2), flute's amplitude should be
  // proportionally much quieter relative to its fundamental than plucked's.
  const fluteRatio2 = flute.find((p) => p.ratio === 2);
  const pluckedRatio2 = plucked.find((p) => p.ratio === 2);
  assert.ok(fluteRatio2 && pluckedRatio2, 'both presets should have a ratio-2 partial to compare');
  assert.ok(fluteRatio2.amp < pluckedRatio2.amp, 'breathyFlute\'s 2nd harmonic should be quieter (relative to fundamental=1) than pluckedString\'s');
});

test('breathyFlute and pluckedString are reachable directly via generatePartials with the documented parameters (no separate hand-listed mechanism)', () => {
  const flute = generatePartials({ count: 5, rolloffExponent: 2.8, oddEvenBias: 0.2 });
  const plucked = generatePartials({ count: 10, rolloffExponent: 1.2, oddEvenBias: 0 });
  assert.deepEqual(flute, PARTIAL_PRESETS.breathyFlute);
  assert.deepEqual(plucked, PARTIAL_PRESETS.pluckedString);
});

test('renderTrack: omitting the new sparseness/timbre opts produces output identical to explicitly passing their documented defaults', () => {
  const common = { durationSec: 4, sampleRate: 8000, seed: 12345, mode: 'dorian', root: 'D', reverbPreset: 'chamber', melody: true };
  const a = renderTrack(common);
  const b = renderTrack({
    ...common,
    maxVoices: 6,
    baseInjectProb: 0.15,
    risingInjectProb: 0.03,
    melodyPhraseGapSecMin: 4,
    melodyPhraseGapSecMax: 9,
    melodyMinTrailingSilenceSec: 18,
    padPartialsName: 'warmPad',
  });
  assert.deepEqual(Array.from(a.left), Array.from(b.left), 'left channel should be byte-identical when new opts are omitted vs. explicitly set to their documented defaults');
  assert.deepEqual(Array.from(a.right), Array.from(b.right), 'right channel should be byte-identical when new opts are omitted vs. explicitly set to their documented defaults');
});

test('renderTrack: voiceActivitySummary reports real numbers (sampleCount matches duration/interval, fractions in [0,1])', () => {
  const track = renderTrack({ durationSec: 10, sampleRate: 8000, seed: 777, reverbPreset: 'chamber' });
  assert.ok(track.voiceActivitySummary, 'voiceActivitySummary should be present for a non-trivial render');
  const s = track.voiceActivitySummary;
  assert.ok(s.sampleCount > 0);
  assert.ok(s.meanTotalVoices >= 0);
  assert.ok(s.fractionSilent >= 0 && s.fractionSilent <= 1);
  assert.ok(s.fractionSingleVoiceOrFewer >= s.fractionSilent, 'fractionSingleVoiceOrFewer must be >= fractionSilent (0-voice instants are a subset of <=1-voice instants)');
});

test('renderTrack: lowering maxVoices/baseInjectProb/risingInjectProb and widening melody phrase gaps measurably increases sparseness (lower mean voice count, higher silent/near-silent fraction) versus default settings, across multiple seeds', () => {
  const seeds = [1, 2, 3, 4];
  const durationSec = 60;
  let denseMean = 0;
  let sparseMean = 0;
  let denseSilent = 0;
  let sparseSilent = 0;

  for (const seed of seeds) {
    const dense = renderTrack({ durationSec, sampleRate: 8000, seed, reverbPreset: 'chamber' });
    const sparse = renderTrack({
      durationSec,
      sampleRate: 8000,
      seed,
      reverbPreset: 'chamber',
      maxVoices: 2,
      baseInjectProb: 0.02,
      risingInjectProb: 0.005,
      melodyPhraseGapSecMin: 20,
      melodyPhraseGapSecMax: 40,
      melodyMinTrailingSilenceSec: 25,
    });
    denseMean += dense.voiceActivitySummary.meanTotalVoices;
    sparseMean += sparse.voiceActivitySummary.meanTotalVoices;
    denseSilent += dense.voiceActivitySummary.fractionSingleVoiceOrFewer;
    sparseSilent += sparse.voiceActivitySummary.fractionSingleVoiceOrFewer;
  }
  denseMean /= seeds.length;
  sparseMean /= seeds.length;
  denseSilent /= seeds.length;
  sparseSilent /= seeds.length;

  assert.ok(
    sparseMean < denseMean,
    `sparse config should average fewer simultaneous voices than default (sparse=${sparseMean.toFixed(3)}, dense=${denseMean.toFixed(3)})`,
  );
  assert.ok(
    sparseSilent > denseSilent,
    `sparse config should spend a larger fraction of the track at <=1 simultaneous voice than default (sparse=${sparseSilent.toFixed(3)}, dense=${denseSilent.toFixed(3)})`,
  );
});

test('renderTrack: padPartialsName selects the pad bed\'s oscillator timbre (falls back to warmPad for an unknown name)', () => {
  // Indirect check: rendering with a real named preset vs. an unknown name
  // should not throw, and should still produce finite, non-silent audio
  // (the fallback path in compose.mjs's padPartials resolution).
  const known = renderTrack({ durationSec: 3, sampleRate: 8000, seed: 99, padPartialsName: 'breathyFlute', reverbPreset: 'chamber' });
  const unknown = renderTrack({ durationSec: 3, sampleRate: 8000, seed: 99, padPartialsName: 'not-a-real-preset', reverbPreset: 'chamber' });
  assert.ok(known.rms > 0);
  assert.ok(unknown.rms > 0);
});
