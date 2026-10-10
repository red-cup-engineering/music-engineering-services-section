// motif-grammar.test.mjs
//
// Checks that generateTokenSequence's output is well-formed *by
// construction* -- every generated sequence really does land in the
// requested closing category (net-displacement range, wide-token
// requirement/prohibition) -- and that the space it draws from is
// genuinely large, not a relabeled small enum. See melody.test.mjs for the
// higher-level integration (generateMotif/generatePhrase using this).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { generateTokenSequence, tokensToSteps, isWideToken, TOKENS, ALPHABET } from '../src/generative/motif-grammar.mjs';
import { makeRng } from '../src/generative/random.mjs';

function netDisplacement(tokens) {
  const VALUE = { r: 0, u1: 1, u2: 5, d1: -1, d2: -5 };
  return tokens.reduce((s, t) => s + VALUE[t], 0);
}

test('generateTokenSequence always returns exactly `length` tokens from ALPHABET', () => {
  const rng = makeRng(1);
  for (let trial = 0; trial < 50; trial++) {
    const length = 1 + (trial % 5);
    const seq = generateTokenSequence(rng, length, { lo: -3, hi: 3 });
    assert.equal(seq.length, length);
    for (const t of seq) assert.ok(ALPHABET.includes(t));
  }
});

test('generateTokenSequence(0, ...) returns an empty sequence', () => {
  const rng = makeRng(2);
  assert.deepEqual(generateTokenSequence(rng, 0, { lo: -2, hi: 2 }), []);
});

test('well-formedness by construction: every generated sequence satisfies its own requested [lo,hi] net-displacement range, across many draws/lengths/biases', () => {
  const rng = makeRng(3);
  const biases = [
    { lo: -2, hi: 2, allowWide: false },
    { lo: -3, hi: 3 },
    { lo: 4, hi: 11, requireWide: true },
    { lo: -11, hi: -4, requireWide: true },
  ];
  for (let trial = 0; trial < 300; trial++) {
    const length = 1 + (trial % 4);
    const bias = biases[trial % biases.length];
    const seq = generateTokenSequence(rng, length, bias);
    const v = netDisplacement(seq);
    assert.ok(v >= bias.lo && v <= bias.hi, `trial ${trial} length=${length} bias=${JSON.stringify(bias)}: netDisplacement=${v} outside [${bias.lo},${bias.hi}], seq=${seq}`);
    if (bias.requireWide) assert.ok(seq.some(isWideToken), `trial ${trial}: requireWide bias produced no wide token, seq=${seq}`);
    if (bias.allowWide === false) assert.ok(!seq.some(isWideToken), `trial ${trial}: allowWide:false bias produced a wide token, seq=${seq}`);
  }
});

test('well-formedness holds even when the requested range is unreachable for the given length (defensive fallback still respects allowWide)', () => {
  const rng = makeRng(4);
  // [50,60] net displacement is unreachable for length<=3 tokens (max
  // representative value per token is 5) -- the fallback must still
  // produce a real length-N sequence, and still honor allowWide:false.
  for (let trial = 0; trial < 40; trial++) {
    const seq = generateTokenSequence(rng, 3, { lo: 50, hi: 60, allowWide: false });
    assert.equal(seq.length, 3);
    assert.ok(!seq.some(isWideToken), `fallback violated allowWide:false, seq=${seq}`);
  }
});

test('tokensToSteps converts every token to a delta whose magnitude matches its class (repeat=0, narrow steps <=3, leaps >=4), and respects the token\'s sign', () => {
  const rng = makeRng(5);
  for (let trial = 0; trial < 200; trial++) {
    const seq = [TOKENS.REPEAT, TOKENS.STEP_UP, TOKENS.STEP_DOWN, TOKENS.LEAP_UP, TOKENS.LEAP_DOWN];
    const steps = tokensToSteps(rng, seq);
    assert.equal(steps[0], 0);
    assert.ok(steps[1] >= 1 && steps[1] <= 3);
    assert.ok(steps[2] <= -1 && steps[2] >= -3);
    assert.ok(steps[3] >= 4 && steps[3] <= 6);
    assert.ok(steps[4] <= -4 && steps[4] >= -6);
  }
});

test('variety: distinct token sequences generated across many draws vastly exceeds the old 4-shape enum', () => {
  const rng = makeRng(6);
  const seen = new Set();
  const N = 500;
  for (let i = 0; i < N; i++) {
    const seq = generateTokenSequence(rng, 4, { lo: -3, hi: 3 });
    seen.add(seq.join(','));
  }
  assert.ok(seen.size > 30, `expected >30 distinct token sequences across ${N} draws, got ${seen.size}`);
});

test('is deterministic given the same rng state', () => {
  const a = generateTokenSequence(makeRng(9001), 4, { lo: -3, hi: 3, requireWide: true });
  const b = generateTokenSequence(makeRng(9001), 4, { lo: -3, hi: 3, requireWide: true });
  assert.deepEqual(a, b);
});
