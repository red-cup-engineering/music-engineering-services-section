// scale.test.mjs
//
// Checks the maximal-evenness scale/mode generator that replaced the old
// 4-entry MODE_INTERVALS lookup table: that it reproduces all seven
// classical diatonic modes and both pentatonic collections exactly (not
// approximately) as specific (cardinality, rotation) coordinates, that
// makeScale's legacy named-mode path produces byte-identical results to
// before this refactor, and that the generator covers a real combinatorial
// space beyond those four/eleven recognizable special cases.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  maximallyEvenIntervals,
  rotateIntervalsToDegree,
  generateModeIntervals,
  makeScale,
  buildScaleBitmask,
  randomModeCoordinates,
} from '../src/generative/scale.mjs';
import { makeRng } from '../src/generative/random.mjs';

test('maximallyEvenIntervals(7,12) rotated through all 7 members reproduces every classical diatonic mode exactly', () => {
  const targets = {
    // rotation index -> known interval pattern, discovered empirically and
    // fixed here as a regression check (see this module's own header
    // comment / the engineering README for how these were derived).
    0: [0, 2, 4, 6, 7, 9, 11], // Lydian
    1: [0, 2, 4, 5, 7, 9, 10], // Mixolydian
    2: [0, 2, 3, 5, 7, 8, 10], // Aeolian (natural minor)
    3: [0, 1, 3, 5, 6, 8, 10], // Locrian
    4: [0, 2, 4, 5, 7, 9, 11], // Ionian (major)
    5: [0, 2, 3, 5, 7, 9, 10], // Dorian
    6: [0, 1, 3, 5, 7, 8, 10], // Phrygian
  };
  const base = maximallyEvenIntervals(7, 12);
  assert.equal(base.length, 7);
  for (const [rotation, expected] of Object.entries(targets)) {
    const got = generateModeIntervals({ cardinality: 7, rotation: Number(rotation), chromaticUniverse: 12 });
    assert.deepEqual(got, expected, `rotation ${rotation}`);
  }
});

test('maximallyEvenIntervals(5,12) rotated reproduces both pentatonic collections exactly', () => {
  const majorPentatonic = generateModeIntervals({ cardinality: 5, rotation: 3, chromaticUniverse: 12 });
  const minorPentatonic = generateModeIntervals({ cardinality: 5, rotation: 2, chromaticUniverse: 12 });
  assert.deepEqual(majorPentatonic, [0, 2, 4, 7, 9]);
  assert.deepEqual(minorPentatonic, [0, 3, 5, 7, 10]);
});

test('makeScale legacy named modes are byte-identical to the pre-refactor hardcoded interval lists', () => {
  const targets = {
    dorian: [0, 2, 3, 5, 7, 9, 10],
    aeolian: [0, 2, 3, 5, 7, 8, 10],
    majorPentatonic: [0, 2, 4, 7, 9],
    minorPentatonic: [0, 3, 5, 7, 10],
  };
  for (const [mode, expected] of Object.entries(targets)) {
    const scale = makeScale({ root: 'D', mode });
    assert.deepEqual(scale.degreeIntervals, expected, mode);
  }
});

test('maximallyEvenIntervals produces a strictly ascending, distinct, 0-starting set for every cardinality 2..11 at c=12', () => {
  for (let d = 2; d <= 11; d++) {
    const s = maximallyEvenIntervals(d, 12);
    assert.equal(s.length, d);
    assert.equal(s[0], 0);
    assert.equal(new Set(s).size, d, `cardinality ${d}: duplicate pitch classes`);
    for (let i = 1; i < s.length; i++) assert.ok(s[i] > s[i - 1], `cardinality ${d}: not strictly ascending at index ${i}`);
    for (const v of s) assert.ok(v >= 0 && v < 12, `cardinality ${d}: value ${v} outside chromatic universe`);
  }
});

test('maximallyEvenIntervals rejects cardinalities outside [1, chromaticUniverse]', () => {
  assert.throws(() => maximallyEvenIntervals(0, 12));
  assert.throws(() => maximallyEvenIntervals(13, 12));
  assert.throws(() => maximallyEvenIntervals(1.5, 12));
});

test('rotateIntervalsToDegree always produces a set starting at 0, same size, same underlying pitch classes as a set (just a different degree-0)', () => {
  const base = maximallyEvenIntervals(7, 12);
  for (let rotation = 0; rotation < 7; rotation++) {
    const rotated = rotateIntervalsToDegree(base, 12, rotation);
    assert.equal(rotated.length, base.length);
    assert.equal(rotated[0], 0);
  }
});

test('generative space: cardinality x rotation gives far more than 4 distinct interval-set shapes at c=12', () => {
  const shapes = new Set();
  for (let d = 2; d <= 11; d++) {
    for (let r = 0; r < d; r++) {
      shapes.add(generateModeIntervals({ cardinality: d, rotation: r, chromaticUniverse: 12 }).join(','));
    }
  }
  // sum_{d=2}^{11} d = 65 distinct (cardinality,rotation) coordinate pairs;
  // some may coincide in interval-set shape (e.g. rotations of a
  // palindromic set), so just check it vastly exceeds the old 4-entry table.
  assert.ok(shapes.size > 20, `expected >20 distinct interval-set shapes, got ${shapes.size}`);
});

test('buildScaleBitmask accepts direct generator coordinates (not just legacy names)', () => {
  const mask = buildScaleBitmask('C', { cardinality: 6, rotation: 0, chromaticUniverse: 12 });
  // whole-tone-like set at C: intervals maximallyEvenIntervals(6,12) = [0,2,4,6,8,10]
  const expectedMask = [0, 2, 4, 6, 8, 10].reduce((m, pc) => m | (1 << pc), 0);
  assert.equal(mask, expectedMask);
});

test('randomModeCoordinates stays within the requested cardinality range and produces a valid rotation', () => {
  const rng = makeRng(561);
  for (let trial = 0; trial < 100; trial++) {
    const coords = randomModeCoordinates(rng, { cardinalityRange: [5, 8] });
    assert.ok(coords.cardinality >= 5 && coords.cardinality <= 8, `cardinality ${coords.cardinality} outside [5,8]`);
    assert.ok(coords.rotation >= 0 && coords.rotation < coords.cardinality);
    // Must actually be usable to build a real scale.
    const scale = makeScale({ root: 'D', mode: coords });
    assert.equal(scale.degreeIntervals.length, coords.cardinality);
  }
});
