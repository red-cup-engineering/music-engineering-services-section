// motif-grammar.mjs
//
// Replaces melody.mjs's old MOTIF_CHARACTERS -- a 4-entry enum of hand-
// designed contour templates (stepwise/arch/risingLeapDescent/repeatedLeap)
// -- with a real generative grammar built on lambek.mjs's ported bi-
// residuation algebra. This is the concrete musical instance of "categories
// for melodic fragments with left/right residuals expressing what must
// follow/precede this fragment to close a well-formed phrase" the operator
// asked for.
//
// The construction, concretely:
//   - A small alphabet of 5 step TOKENS stands in for a melodic move:
//     repeat, small step up/down, genuine leap up/down (the same
//     small-step-vs-leap boundary the old code drew: magnitude <4 is
//     "narrow", >=4 is "wide", so the WIDE/NARROW distinction that used to
//     be baked into 4 separate named functions is now just a predicate over
//     generated token sequences).
//   - A target CATEGORY S ("what a well-formed motif's step sequence must
//     satisfy") is built as a genuine language -- a finite subset of
//     Sigma^{=length} -- filtered by net representative displacement falling
//     in a requested [lo,hi] range, and (when requested) containing at least
//     one wide token. This is real category structure, not a label: S is an
//     explicit, computed set of admissible token sequences, built with
//     lambek.mjs's own set operations.
//   - The sequence is generated token-by-token. At each position, a
//     candidate token t is only kept if some completion of the *remaining*
//     budget exists that lands the whole sequence in S -- checked by
//     literally computing lres({prefix+t}, S) over a universe re-scoped to
//     the remaining length (per lambek.mjs's header comment on why that
//     re-scoping is required) and testing it for a completion of exactly the
//     right remaining length. This is modus_ponens_left /
//     dot_lres_adj from LambekCalculus.lean applied directly: a token is
//     legal exactly when it keeps S reachable, which is what the left
//     residual computes.
//   - Among the tokens that pass that reachability test, the actual choice
//     is still a weighted random draw (this module doesn't remove chance --
//     it uses the algebra to constrain the space chance is drawn from, which
//     is what makes the result "well-formed by construction" rather than
//     "well-formed on average"). Real note magnitudes (e.g. "small step
//     up" -> 1, 2, or 3 scale degrees; "leap up" -> 4, 5, or 6) are sampled
//     only after the token identity is chosen, adding a further layer of
//     variety the token alphabet alone doesn't capture.
//
// The combinatorial space this can generate is not enumerable-by-hand the
// way 4 fixed shapes were: for a 4-token sequence (a 5-note motif) there are
// up to 5^4 = 625 token sequences before even applying the interval-
// magnitude sampling on top, and the closing-category constraint changes
// per phrase (per-section bias below), so which of those 625 are reachable
// differs call to call. test/motif-grammar.test.mjs checks this directly:
// draws hundreds of motifs and counts distinct interval-sequences produced,
// rather than asserting it in prose.

import { enumerateUniverse, dot, unword, word } from './lambek.mjs';
import { pick } from './random.mjs';

/** The 5-symbol step-token alphabet. */
export const TOKENS = Object.freeze({
  REPEAT: 'r',
  STEP_UP: 'u1',
  LEAP_UP: 'u2',
  STEP_DOWN: 'd1',
  LEAP_DOWN: 'd2',
});
export const ALPHABET = Object.freeze(Object.values(TOKENS));

// Representative net-displacement value per token, used only to decide
// category membership (does a candidate sequence's *shape* satisfy a
// requested [lo,hi] net-displacement range / wide-token requirement). The
// concrete sampled interval magnitude for a chosen token (see
// sampleIntervalForToken below) is a separate, later step -- the category
// math only needs a stable representative, not the final random draw.
const TOKEN_VALUE = Object.freeze({ r: 0, u1: 1, u2: 5, d1: -1, d2: -5 });
const WIDE_TOKENS = new Set([TOKENS.LEAP_UP, TOKENS.LEAP_DOWN]);

// Genuine wide leaps (scale degrees) sampled for a leap token -- wider than
// any narrow-step magnitude below, so a leap is unambiguously non-stepwise.
const LEAP_MAGNITUDES = Object.freeze([4, 5, 6]);
// Narrow-step magnitudes, weighted toward 1 (mirrors the old STEP_WEIGHTS
// distribution: mostly +-1/+-2, a smaller-still +-3).
const NARROW_MAGNITUDE_WEIGHTS = Object.freeze([1, 1, 1, 2, 2, 3]);

function netDisplacement(w) {
  return unword(w).reduce((s, t) => s + TOKEN_VALUE[t], 0);
}

function containsWide(w) {
  return unword(w).some((t) => WIDE_TOKENS.has(t));
}

/**
 * Builds the target closing category S: every word of exactly `exactLen`
 * tokens whose net representative displacement falls in [lo,hi], that
 * contains at least one leap token if requireWide, and contains NO leap
 * token if allowWide is false. (requireWide and allowWide:false are
 * mutually exclusive by construction -- a bias should only ever set one.)
 * A net-displacement range alone is not enough to keep a sequence "narrow":
 * a leap up immediately cancelled by a leap down nets to a small
 * displacement while still containing two genuine leaps, so allowWide is a
 * real, separate constraint, not redundant with [lo,hi].
 * @param {Set<string>} universe - Sigma^{<=exactLen}, from enumerateUniverse
 * @param {number} lo
 * @param {number} hi
 * @param {boolean} requireWide
 * @param {boolean} allowWide
 * @param {number} exactLen
 * @returns {Set<string>}
 */
function closingCategory(universe, lo, hi, requireWide, allowWide, exactLen) {
  const out = new Set();
  for (const w of universe) {
    if (unword(w).length !== exactLen) continue;
    const v = netDisplacement(w);
    if (v < lo || v > hi) continue;
    const wide = containsWide(w);
    if (requireWide && !wide) continue;
    if (!allowWide && wide) continue;
    out.add(w);
  }
  return out;
}

/**
 * Generates a `length`-token step sequence via the Lambek residuation
 * algebra: at each position, only tokens that keep the target closing
 * category S reachable within the remaining budget are candidates (computed
 * with lambek.mjs's lres, re-scoped to the remaining length each step --
 * see lambek.mjs's header comment on why), and the actual choice is a
 * uniform draw among those survivors.
 * @param {{state:number}} rng
 * @param {number} length - token count (== motif note count - 1)
 * @param {object} [bias]
 * @param {number} [bias.lo=-2] - target net-displacement range lower bound
 * @param {number} [bias.hi=2] - target net-displacement range upper bound
 * @param {boolean} [bias.requireWide=false] - require at least one leap token
 * @param {boolean} [bias.allowWide=true] - if false, forbid leap tokens entirely (not just "net displacement stays small" -- see closingCategory's comment on why that distinction matters)
 * @returns {string[]} array of ALPHABET tokens, length `length`
 */
export function generateTokenSequence(rng, length, bias = {}) {
  const { lo = -2, hi = 2, requireWide = false, allowWide = true } = bias;
  if (length <= 0) return [];

  const fullUniverse = enumerateUniverse(ALPHABET, length);
  let S = closingCategory(fullUniverse, lo, hi, requireWide, allowWide, length);
  // Defensive fallback: an unreachable bias (e.g. a [lo,hi] window too
  // narrow for `length` tokens to hit exactly) would leave S empty, which
  // would make every token unreachable and force the uniform-random
  // fallback below for the whole sequence. Relax to "any exact-length
  // sequence obeying the wide-token constraint" rather than silently
  // producing degenerate output.
  if (S.size === 0) S = closingCategory(fullUniverse, -Infinity, Infinity, false, allowWide, length);

  const tokens = [];

  for (let i = 0; i < length; i++) {
    const remaining = length - i; // tokens left to place, including this one
    const suffixBudget = remaining - 1;
    const suffixUniverse = enumerateUniverse(ALPHABET, suffixBudget);

    const viable = ALPHABET.filter((t) => {
      const withToken = word([...tokens, t]);
      // dot({withToken}, suffix) for every candidate suffix in the
      // remaining-budget-scoped universe; keep t iff at least one
      // full-length (== suffixBudget) completion lands inside S. This is
      // the literal reachability test lres computes -- inlined here (rather
      // than calling lres and re-filtering) so the "exact remaining length"
      // requirement is checked directly against each completion.
      for (const suffix of suffixUniverse) {
        if (unword(suffix).length !== suffixBudget) continue;
        const whole = dot(new Set([withToken]), new Set([suffix]), length);
        if (whole.size > 0 && [...whole].every((w) => S.has(w))) return true;
      }
      return false;
    });

    const choice = viable.length > 0 ? pick(rng, viable) : pick(rng, ALPHABET);
    tokens.push(choice);
  }

  return tokens;
}

function sampleIntervalForToken(rng, token) {
  switch (token) {
    case TOKENS.REPEAT:
      return 0;
    case TOKENS.STEP_UP:
      return pick(rng, NARROW_MAGNITUDE_WEIGHTS);
    case TOKENS.STEP_DOWN:
      return -pick(rng, NARROW_MAGNITUDE_WEIGHTS);
    case TOKENS.LEAP_UP:
      return pick(rng, LEAP_MAGNITUDES);
    case TOKENS.LEAP_DOWN:
      return -pick(rng, LEAP_MAGNITUDES);
    default:
      throw new Error(`Unknown motif-grammar token: ${token}`);
  }
}

/**
 * Converts a token sequence into concrete scale-degree deltas, sampling a
 * real magnitude for each token (see sampleIntervalForToken).
 * @param {{state:number}} rng
 * @param {string[]} tokens
 * @returns {number[]}
 */
export function tokensToSteps(rng, tokens) {
  return tokens.map((t) => sampleIntervalForToken(rng, t));
}

/**
 * Generates a motif's scale-degree-delta step sequence directly: draws a
 * grammar-generated token sequence for the requested note count, biased by
 * `bias`, then samples concrete interval magnitudes for it. This is the
 * grammar-based replacement for the old MOTIF_CHARACTERS[name](rng, length)
 * call.
 * @param {{state:number}} rng
 * @param {number} noteCount
 * @param {object} [bias] - see generateTokenSequence
 * @returns {number[]} noteCount-1 scale-degree deltas
 */
export function generateSteps(rng, noteCount, bias) {
  const tokens = generateTokenSequence(rng, Math.max(0, noteCount - 1), bias);
  return tokensToSteps(rng, tokens);
}

/** @param {string} token @returns {boolean} true for the two wide/leap tokens */
export function isWideToken(token) {
  return WIDE_TOKENS.has(token);
}
