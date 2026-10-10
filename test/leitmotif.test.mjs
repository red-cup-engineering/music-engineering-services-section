// leitmotif.test.mjs
//
// Checks leitmotif.mjs: determinism (same seed -> byte-identical core and
// family), that every named transform in TRANSFORM_NAMES actually runs and
// produces a real, distinct result from the original (not a no-op), and
// that reharmonizeAgainstScale resolves the identical NoteEvent sequence to
// different Hz values against different scales (the "same identity,
// different harmonic color" claim, checked against actual numbers).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeLeitmotif, deriveVariation, generateFamily, reharmonizeAgainstScale, TRANSFORM_NAMES, childSeed, motifLengthWholeNotes } from '../src/generative/leitmotif.mjs';
import { makeScale } from '../src/generative/scale.mjs';

test('makeLeitmotif is deterministic: same seed produces byte-identical core', () => {
  const a = makeLeitmotif(561);
  const b = makeLeitmotif(561);
  assert.deepEqual(a.core, b.core);
  assert.equal(a.id, b.id);
});

test('makeLeitmotif produces different cores for different seeds (not a constant fallback)', () => {
  const a = makeLeitmotif(561);
  const b = makeLeitmotif(562);
  assert.notDeepEqual(a.core, b.core);
});

test('childSeed is a pure deterministic function of (parentSeed, salt)', () => {
  assert.equal(childSeed(561, 'family'), childSeed(561, 'family'));
  assert.notEqual(childSeed(561, 'family'), childSeed(561, 'schedule'));
  assert.notEqual(childSeed(561, 'family'), childSeed(562, 'family'));
});

test('every named transform runs and (except original) changes the motif', () => {
  const { core } = makeLeitmotif(561, { length: 5 });
  for (const name of TRANSFORM_NAMES) {
    const result = deriveVariation(core, name, { degreeShift: 3, factor: 2, axisDegree: core[0].degree });
    assert.equal(result.length, core.length, name);
    if (name !== 'original') {
      assert.notDeepEqual(result, core, `${name} should differ from the original motif`);
    } else {
      assert.deepEqual(result, core);
    }
  }
});

test('deriveVariation throws on an unknown transform name', () => {
  const { core } = makeLeitmotif(561);
  assert.throws(() => deriveVariation(core, 'nonsense'));
});

test('transpose is a real scale-degree shift (round-trips back to original degrees)', () => {
  const { core } = makeLeitmotif(561, { length: 4 });
  const up = deriveVariation(core, 'transpose', { degreeShift: 3 });
  const back = deriveVariation(up, 'transpose', { degreeShift: -3 });
  assert.deepEqual(back.map((n) => n.degree), core.map((n) => n.degree));
});

test('generateFamily is deterministic and produces the requested size', () => {
  const lm = makeLeitmotif(561);
  const familyA = generateFamily(lm, { size: 10 });
  const familyB = generateFamily(lm, { size: 10 });
  assert.equal(familyA.length, 10);
  assert.deepEqual(familyA, familyB);
});

test('generateFamily cycles through distinct transform names and yields at least a few distinct motif shapes', () => {
  const lm = makeLeitmotif(561, { length: 5 });
  const family = generateFamily(lm, { size: 8 });
  const names = new Set(family.map((f) => f.name));
  assert.ok(names.size >= 4, `expected several distinct transform names, got ${names.size}`);
  const shapes = new Set(family.map((f) => f.motif.map((n) => n.degree).join(',')));
  assert.ok(shapes.size >= 4, `expected several distinct motif shapes, got ${shapes.size}`);
});

test('reharmonizeAgainstScale resolves the same core motif to different Hz values under different scales', () => {
  const { core } = makeLeitmotif(561, { length: 4, startDegree: 2 });
  const dorianD = makeScale({ root: 'D', mode: 'dorian' });
  const aeolianA = makeScale({ root: 'A', mode: 'aeolian' });
  const inD = reharmonizeAgainstScale(core, dorianD, 1);
  const inA = reharmonizeAgainstScale(core, aeolianA, 1);
  assert.equal(inD.length, core.length);
  assert.notDeepEqual(inD.map((n) => n.hz), inA.map((n) => n.hz));
  // The degree sequence itself is untouched by reharmonization -- only the resolved Hz changes.
  assert.deepEqual(inD.map((n) => n.degree), core.map((n) => n.degree));
  assert.deepEqual(inA.map((n) => n.degree), core.map((n) => n.degree));
});

test('motifLengthWholeNotes sums durationFrac correctly', () => {
  const motif = [
    { degree: 0, durationFrac: { num: 1, den: 4 }, rest: false },
    { degree: 1, durationFrac: { num: 1, den: 2 }, rest: false },
  ];
  assert.equal(motifLengthWholeNotes(motif), 0.75);
});
