// cover.test.mjs
//
// mergeChord is the literal CRDT knowledge-join (see cover.mjs's header
// comment and joinList_congr in the theory note): an OR-reduction over
// pitch-class-bit events that is supposed to be commutative and idempotent,
// and therefore order-independent. These tests check that property
// directly, plus the sub-check/join-check primitives it composes with.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { mergeChord, subCheck, joinCheck, pairwiseOverlap, OVERLAP } from '../src/generative/cover.mjs';

test('mergeChord is order-independent (same events, any array order, same result)', () => {
  const events = [
    { pitchClassBit: 1 << 2 }, // D
    { pitchClassBit: 1 << 9 }, // A
    { pitchClassBit: 1 << 5 }, // F
    { pitchClassBit: 1 << 2 }, // duplicate D, exercises idempotence too
  ];

  const forward = mergeChord(events);
  const reversed = mergeChord(events.slice().reverse());

  // A handful of other permutations, not just the reverse.
  const shuffled1 = mergeChord([events[2], events[0], events[3], events[1]]);
  const shuffled2 = mergeChord([events[3], events[1], events[0], events[2]]);

  assert.equal(forward, (1 << 2) | (1 << 9) | (1 << 5));
  assert.equal(reversed, forward);
  assert.equal(shuffled1, forward);
  assert.equal(shuffled2, forward);
});

test('mergeChord of an empty event list is 0 (identity element of the join)', () => {
  assert.equal(mergeChord([]), 0);
});

test('mergeChord is idempotent: merging a set with itself changes nothing', () => {
  const events = [{ pitchClassBit: 1 << 0 }, { pitchClassBit: 1 << 7 }];
  const once = mergeChord(events);
  const merged = mergeChord(events.concat(events));
  assert.equal(merged, once);
});

test('subCheck: memberBits must be a submask of targetMask', () => {
  const target = (1 << 2) | (1 << 5) | (1 << 9);
  assert.equal(subCheck(1 << 2, target), true);
  assert.equal(subCheck((1 << 2) | (1 << 5), target), true);
  assert.equal(subCheck(1 << 3, target), false); // bit not in target
  assert.equal(subCheck(0, target), true); // empty grouping is trivially a submask
});

test('joinCheck: admitted groupings must OR-reduce to exactly targetMask', () => {
  const target = (1 << 2) | (1 << 5) | (1 << 9);
  const complete = [{ bits: 1 << 2 }, { bits: 1 << 5 }, { bits: 1 << 9 }];
  const incomplete = [{ bits: 1 << 2 }, { bits: 1 << 5 }];
  const tooMuch = [{ bits: 1 << 2 }, { bits: 1 << 5 }, { bits: 1 << 9 }, { bits: 1 << 0 }];

  assert.equal(joinCheck(complete, target), true);
  assert.equal(joinCheck(incomplete, target), false);
  assert.equal(joinCheck(tooMuch, target), false);
});

test('pairwiseOverlap classifies the four cases correctly', () => {
  assert.equal(pairwiseOverlap(0, 0), OVERLAP.NONE);
  assert.equal(pairwiseOverlap(1 << 2, 0), OVERLAP.ONLY_A);
  assert.equal(pairwiseOverlap(0, 1 << 2), OVERLAP.ONLY_B);
  assert.equal(pairwiseOverlap(1 << 2, 1 << 2), OVERLAP.BOTH);
  assert.equal(pairwiseOverlap((1 << 2) | (1 << 5), 1 << 5), OVERLAP.BOTH);
});
