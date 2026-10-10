// harmony.test.mjs
//
// Theory-sanity checks for harmony.mjs: triads are built from real scale
// degrees and stay within the scale (no chromatic leakage, mirroring
// scale.mjs's own "every chord is diatonic" invariant), function
// classification is internally consistent (degree 0 is always tonic, the
// dominant/predominant degrees are real distinct degrees for a standard
// 7-note scale), generated progressions actually resolve to the tonic when
// requested, tension values track FUNCTION_TENSION exactly, and modal drift
// always produces a coordinate scale.mjs's own generator accepts.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeScale, generateModeIntervals } from '../src/generative/scale.mjs';
import { makeRng } from '../src/generative/random.mjs';
import {
  diatonicTriadDegrees,
  triadMask,
  classifyFunction,
  closestDegreeToInterval,
  generateProgression,
  scheduleProgression,
  pickDegreeForFunction,
  FUNCTION_TENSION,
  makeModalDriftState,
  stepModalDrift,
  randomDriftStartCoords,
} from '../src/generative/harmony.mjs';

test('diatonicTriadDegrees stacks two scale-degree thirds', () => {
  assert.deepEqual(diatonicTriadDegrees(0), [0, 2, 4]);
  assert.deepEqual(diatonicTriadDegrees(3), [3, 5, 7]);
});

test('every triad built from a scale degree is diatonic (its pitch classes are a subset of the scale mask)', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });
  for (let d = 0; d < 7; d++) {
    const mask = triadMask(scale, d);
    assert.equal(mask & scale.scaleMask, mask, `triad at degree ${d} should be fully diatonic`);
  }
});

test('classifyFunction: degree 0 is always tonic, across several scales', () => {
  for (const mode of ['dorian', 'aeolian', 'majorPentatonic', 'minorPentatonic']) {
    const scale = makeScale({ root: 'D', mode });
    assert.equal(classifyFunction(scale, 0), 'tonic', mode);
  }
});

test('classifyFunction: the dominant degree is a real scale degree closest to a perfect fifth above the tonic', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });
  const dominantDegree = closestDegreeToInterval(scale, 7);
  assert.equal(classifyFunction(scale, dominantDegree), 'dominant');
  // D dorian degreeIntervals = [0,2,3,5,7,9,10] -- degree 4 is exactly 7 semitones above the root.
  assert.equal(dominantDegree, 4);
});

test('classifyFunction covers every degree with a valid label', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });
  for (let d = 0; d < 7; d++) {
    const fn = classifyFunction(scale, d);
    assert.ok(['tonic', 'predominant', 'dominant'].includes(fn), `degree ${d} got invalid function ${fn}`);
  }
});

test('pickDegreeForFunction always returns a degree that actually classifies as the requested function', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });
  const rng = makeRng(561);
  for (let i = 0; i < 50; i++) {
    for (const fn of ['tonic', 'predominant', 'dominant']) {
      const degree = pickDegreeForFunction(rng, scale, fn);
      assert.equal(classifyFunction(scale, degree), fn);
    }
  }
});

test('generateProgression always resolves to the tonic when requireResolution is true', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });
  const rng = makeRng(561);
  for (let i = 0; i < 20; i++) {
    const progression = generateProgression(rng, scale, { length: 6 });
    const last = progression[progression.length - 1];
    assert.equal(last.functionLabel, 'tonic');
    assert.equal(last.degree, 0);
  }
});

test('generateProgression tension values exactly track FUNCTION_TENSION per chord', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });
  const rng = makeRng(561);
  const progression = generateProgression(rng, scale, { length: 8 });
  for (const chord of progression) {
    assert.equal(chord.tension, FUNCTION_TENSION[chord.functionLabel]);
  }
});

test('generateProgression is deterministic given the same rng state', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });
  const a = generateProgression(makeRng(561), scale, { length: 6 });
  const b = generateProgression(makeRng(561), scale, { length: 6 });
  assert.deepEqual(a, b);
});

test('scheduleProgression lays chords out at consecutive fixed-length intervals', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });
  const progression = generateProgression(makeRng(561), scale, { length: 4, requireResolution: false });
  const scheduled = scheduleProgression(progression, { startSec: 10, chordDurationSec: 3 });
  assert.equal(scheduled[0].startSec, 10);
  assert.equal(scheduled[1].startSec, 13);
  assert.equal(scheduled[2].startSec, 16);
  for (const c of scheduled) assert.equal(c.durSec, 3);
});

test('modal drift always lands on coordinates scale.mjs\'s generator accepts', () => {
  const rng = makeRng(561);
  const state = makeModalDriftState(randomDriftStartCoords(rng));
  for (let i = 0; i < 200; i++) {
    stepModalDrift(state, rng, { pRotate: 0.6, pCardinality: 0.2 });
    assert.doesNotThrow(() => generateModeIntervals(state.coords));
    assert.ok(state.coords.rotation >= 0 && state.coords.rotation < state.coords.cardinality);
  }
});

test('modal drift eventually produces both rotation-only and cardinality-changing steps over many trials', () => {
  const rng = makeRng(561);
  const state = makeModalDriftState({ cardinality: 7, rotation: 0, chromaticUniverse: 12 });
  const kinds = new Set();
  for (let i = 0; i < 300; i++) {
    const { kind } = stepModalDrift(state, rng, { pRotate: 0.6, pCardinality: 0.3, cardinalityRange: [5, 8] });
    kinds.add(kind);
  }
  assert.ok(kinds.has('rotation'), 'expected at least one rotation-only drift step');
  assert.ok(kinds.has('cardinality'), 'expected at least one cardinality-changing drift step');
});
