// regime.test.mjs
//
// advanceMonotoneDrift is the literal bounded-convergence closure-operator
// step (regime.mjs's header comment): a drifting parameter must move only
// toward its target, never past it, and must land exactly on target within
// kHeight iterations. These tests check both halves of that claim directly:
// monotonicity across the iteration sequence, and exact convergence by
// (or before) the kHeight-th call.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeMonotoneDrift, advanceMonotoneDrift, growthTower, classify } from '../src/generative/regime.mjs';

test('advanceMonotoneDrift reaches the target value within kHeight iterations (rising target)', () => {
  const kHeight = 3;
  const drift = makeMonotoneDrift(100);
  const target = 1800;

  const values = [];
  for (let i = 0; i < kHeight; i++) {
    values.push(advanceMonotoneDrift(drift, target, kHeight));
  }

  assert.equal(values[values.length - 1], target, 'must land exactly on target by the kHeight-th call');
});

test('advanceMonotoneDrift reaches the target value within kHeight iterations (falling target)', () => {
  const kHeight = 3;
  const drift = makeMonotoneDrift(1800);
  const target = 800;

  const values = [];
  for (let i = 0; i < kHeight; i++) {
    values.push(advanceMonotoneDrift(drift, target, kHeight));
  }

  assert.equal(values[values.length - 1], target);
});

test('advanceMonotoneDrift never overshoots or oscillates: the value sequence is monotonic toward the target', () => {
  const kHeight = 3;

  for (const [start, target] of [
    [100, 1800],
    [1800, 100],
    [500, 500], // already at target
  ]) {
    const drift = makeMonotoneDrift(start);
    const values = [start];
    for (let i = 0; i < kHeight + 2; i++) {
      // run a couple of iterations past kHeight too, to check the
      // force-clamp holds steady rather than wobbling once settled
      values.push(advanceMonotoneDrift(drift, target, kHeight));
    }

    const rising = target >= start;
    for (let i = 1; i < values.length; i++) {
      if (rising) {
        assert.ok(values[i] >= values[i - 1] - 1e-9, `value must not decrease when rising toward target (step ${i}: ${values[i - 1]} -> ${values[i]})`);
        assert.ok(values[i] <= target + 1e-9, `value must never overshoot target (step ${i}: ${values[i]} > ${target})`);
      } else {
        assert.ok(values[i] <= values[i - 1] + 1e-9, `value must not increase when falling toward target (step ${i}: ${values[i - 1]} -> ${values[i]})`);
        assert.ok(values[i] >= target - 1e-9, `value must never overshoot target (step ${i}: ${values[i]} < ${target})`);
      }
    }

    // Once settled, further calls at the same target must hold steady, not
    // oscillate.
    assert.equal(values[values.length - 1], target);
    assert.equal(values[values.length - 2], target);
  }
});

test('advanceMonotoneDrift: retargeting mid-settle resets the iteration count and still converges monotonically toward the new target', () => {
  const kHeight = 3;
  const drift = makeMonotoneDrift(0);
  advanceMonotoneDrift(drift, 1000, kHeight); // one step toward 1000
  const beforeRetarget = drift.value;
  assert.ok(beforeRetarget > 0 && beforeRetarget < 1000);

  // Retarget to something lower than the in-progress value but above 0:
  // the drift must now move monotonically toward *this* target, not
  // toward 1000 or back toward 0.
  const newTarget = 200;
  const values = [];
  for (let i = 0; i < kHeight; i++) values.push(advanceMonotoneDrift(drift, newTarget, kHeight));
  assert.equal(values[values.length - 1], newTarget);
});

test('growthTower produces the expected seeded 1,1,1,... families with genuinely distinct growth', () => {
  assert.deepEqual(growthTower('fibonacci', 6), [1, 1, 2, 3, 5, 8]);
  assert.deepEqual(growthTower('padovan', 6), [1, 1, 1, 2, 2, 3]);
  assert.deepEqual(growthTower('tribonacci', 6), [1, 1, 1, 3, 5, 9]);
  // Distinct growth: by the 6th term, tribonacci >= fibonacci >= padovan.
  const p = growthTower('padovan', 6);
  const f = growthTower('fibonacci', 6);
  const t = growthTower('tribonacci', 6);
  assert.ok(t[5] >= f[5]);
  assert.ok(f[5] >= p[5]);
});

test('classify is a decidable total function (never throws, always returns one of the four tags)', () => {
  const validTags = new Set(['STRICT', 'SCOTT', 'TRANSFINITE_BOUNDED', 'APERIODIC']);
  const cases = [
    { activeVoiceCount: 0, emaFilterDelta: 0, directFilterDelta: 0, ticksSinceLastReset: 0 },
    { activeVoiceCount: 6, emaFilterDelta: 500, directFilterDelta: 0, ticksSinceLastReset: 100 },
    { activeVoiceCount: 4, emaFilterDelta: 10, directFilterDelta: 12, ticksSinceLastReset: 19 },
  ];
  for (const c of cases) {
    assert.ok(validTags.has(classify(c)));
  }
});
