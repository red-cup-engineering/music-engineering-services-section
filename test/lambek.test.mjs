// lambek.test.mjs
//
// Property-based checks that lambek.mjs's bounded finite-language instance
// actually satisfies the algebra LambekCalculus.lean proves things about --
// dot's associativity, and the bi-residuation adjunction
// (dot(A,B) subsetOf C <=> B subsetOf lres(A,C) <=> A subsetOf rres(C,B)) --
// rather than merely asserting it in a comment. See lambek.mjs's header
// comment for why the bound (maxLen) has to be handled the way it is for
// these properties to actually hold.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  EMPTY_WORD,
  word,
  unword,
  wordLen,
  enumerateUniverse,
  meet,
  join,
  isSubsetOf,
  dot,
  lres,
  rres,
} from '../src/generative/lambek.mjs';
import { makeRng, nextInt, pick } from '../src/generative/random.mjs';

const ALPHABET = ['a', 'b', 'c'];
const MAX_LEN = 3;

function randomWord(rng, maxLen) {
  const len = nextInt(rng, 0, maxLen + 1);
  const toks = [];
  for (let i = 0; i < len; i++) toks.push(pick(rng, ALPHABET));
  return word(toks);
}

function randomLanguage(rng, maxLen, maxSize) {
  const size = nextInt(rng, 0, maxSize + 1);
  const lang = new Set();
  for (let i = 0; i < size; i++) lang.add(randomWord(rng, maxLen));
  return lang;
}

test('word/unword/wordLen round-trip correctly for multi-character tokens', () => {
  const tokens = ['u1', 'd2', 'r', 'u2'];
  const w = word(tokens);
  assert.deepEqual(unword(w), tokens);
  assert.equal(wordLen(w), tokens.length);
  assert.equal(unword(EMPTY_WORD).length, 0);
  assert.equal(wordLen(EMPTY_WORD), 0);
});

test('enumerateUniverse(alphabet, maxLen) contains exactly the words of length 0..maxLen, and only those', () => {
  const universe = enumerateUniverse(ALPHABET, 3);
  let expectedCount = 0;
  for (let len = 0; len <= 3; len++) expectedCount += Math.pow(ALPHABET.length, len);
  assert.equal(universe.size, expectedCount);
  for (const w of universe) assert.ok(wordLen(w) <= 3, `word ${JSON.stringify(unword(w))} exceeds maxLen`);
  assert.ok(universe.has(EMPTY_WORD));
});

test('meet/join are set intersection/union, and isSubsetOf matches the lattice order (meet(A,B) === A)', () => {
  const rng = makeRng(1);
  for (let trial = 0; trial < 50; trial++) {
    const A = randomLanguage(rng, MAX_LEN, 8);
    const B = randomLanguage(rng, MAX_LEN, 8);
    const m = meet(A, B);
    const j = join(A, B);
    for (const w of m) assert.ok(A.has(w) && B.has(w));
    for (const w of A) if (B.has(w)) assert.ok(m.has(w));
    for (const w of j) assert.ok(A.has(w) || B.has(w));
    assert.equal(isSubsetOf(m, A), true, 'meet(A,B) must be a subset of A');
    assert.equal(isSubsetOf(A, j), true, 'A must be a subset of join(A,B)');
  }
});

test('dot is associative under the length bound: (A.B).C === A.(B.C) for random finite languages', () => {
  const rng = makeRng(2);
  for (let trial = 0; trial < 100; trial++) {
    const A = randomLanguage(rng, 2, 4);
    const B = randomLanguage(rng, 2, 4);
    const C = randomLanguage(rng, 2, 4);
    const maxLen = 4;
    const left = dot(dot(A, B, maxLen), C, maxLen);
    const right = dot(A, dot(B, C, maxLen), maxLen);
    assert.equal(isSubsetOf(left, right), true, `trial ${trial}: (A.B).C not subset of A.(B.C)`);
    assert.equal(isSubsetOf(right, left), true, `trial ${trial}: A.(B.C) not subset of (A.B).C`);
  }
});

test('dot with the unit language {epsilon} is the identity on both sides', () => {
  const rng = makeRng(3);
  const unit = new Set([EMPTY_WORD]);
  for (let trial = 0; trial < 30; trial++) {
    const A = randomLanguage(rng, MAX_LEN, 8);
    const left = dot(unit, A, MAX_LEN);
    const right = dot(A, unit, MAX_LEN);
    assert.deepEqual(left, A, `trial ${trial}: unit.A !== A`);
    assert.deepEqual(right, A, `trial ${trial}: A.unit !== A`);
  }
});

test('bi-residuation adjunction: dot(A,B) subsetOf C <=> B subsetOf lres(A,C), for random finite languages (the literal claim LambekCalculus.lean proves for any LambekAlgebra)', () => {
  const rng = makeRng(4);
  const maxLen = 3;
  const universe = enumerateUniverse(ALPHABET, maxLen);
  for (let trial = 0; trial < 60; trial++) {
    const A = randomLanguage(rng, maxLen, 4);
    const B = randomLanguage(rng, maxLen, 4);
    const C = randomLanguage(rng, maxLen, 6);

    const AB = dot(A, B, maxLen);
    const forward = isSubsetOf(AB, C);

    const residual = lres(A, C, universe, maxLen);
    const backward = isSubsetOf(B, residual);

    assert.equal(forward, backward, `trial ${trial}: dot(A,B)<=C (${forward}) disagrees with B<=lres(A,C) (${backward})`);
  }
});

test('bi-residuation adjunction: dot(A,B) subsetOf C <=> A subsetOf rres(C,B), for random finite languages', () => {
  const rng = makeRng(5);
  const maxLen = 3;
  const universe = enumerateUniverse(ALPHABET, maxLen);
  for (let trial = 0; trial < 60; trial++) {
    const A = randomLanguage(rng, maxLen, 4);
    const B = randomLanguage(rng, maxLen, 4);
    const C = randomLanguage(rng, maxLen, 6);

    const AB = dot(A, B, maxLen);
    const forward = isSubsetOf(AB, C);

    const residual = rres(C, B, universe, maxLen);
    const backward = isSubsetOf(A, residual);

    assert.equal(forward, backward, `trial ${trial}: dot(A,B)<=C (${forward}) disagrees with A<=rres(C,B) (${backward})`);
  }
});

test('left modus ponens: dot(A, lres(A,C), maxLen) is a subset of C (LambekCalculus.lean\'s modus_ponens_left, checked directly)', () => {
  const rng = makeRng(6);
  const maxLen = 3;
  const universe = enumerateUniverse(ALPHABET, maxLen);
  for (let trial = 0; trial < 40; trial++) {
    const A = randomLanguage(rng, maxLen, 4);
    const C = randomLanguage(rng, maxLen, 6);
    const residual = lres(A, C, universe, maxLen);
    const reconstructed = dot(A, residual, maxLen);
    assert.equal(isSubsetOf(reconstructed, C), true, `trial ${trial}: dot(A, lres(A,C)) not subset of C`);
  }
});

test('right modus ponens: dot(rres(C,B), B, maxLen) is a subset of C', () => {
  const rng = makeRng(7);
  const maxLen = 3;
  const universe = enumerateUniverse(ALPHABET, maxLen);
  for (let trial = 0; trial < 40; trial++) {
    const B = randomLanguage(rng, maxLen, 4);
    const C = randomLanguage(rng, maxLen, 6);
    const residual = rres(C, B, universe, maxLen);
    const reconstructed = dot(residual, B, maxLen);
    assert.equal(isSubsetOf(reconstructed, C), true, `trial ${trial}: dot(rres(C,B), B) not subset of C`);
  }
});

test('non-commutativity: dot(A,B) differs from dot(B,A) for a concrete example (the whole reason this ported algebra needs two residuals, not one)', () => {
  const A = new Set([word(['a'])]);
  const B = new Set([word(['b'])]);
  const AB = dot(A, B, 2);
  const BA = dot(B, A, 2);
  assert.notDeepEqual(AB, BA);
  assert.ok(AB.has(word(['a', 'b'])));
  assert.ok(BA.has(word(['b', 'a'])));
  assert.ok(!AB.has(word(['b', 'a'])));
});
