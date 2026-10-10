// lambek.mjs
//
// Port of Obsmetrologia/Calculus/Logic/LambekCalculus.lean's actual algebraic
// structure -- a (possibly non-commutative) lattice-ordered monoid with two
// residuals satisfying bi-residuation -- into a concrete, computable, tested
// instance: the standard "formal languages over a finite alphabet, bounded to
// a finite length" model.
//
// Why this instance and not something more abstract: the Lean file's
// LambekAlgebra is a structure (lattice + monoid + two residuals satisfying
// `dot a b <= c <-> b <= a\c` and `dot a b <= c <-> a <= c/b`), proved
// abstractly and witnessed there only by the trivial one-element algebra. To
// borrow the actual structure (not just the names `\` and `/`) for motif
// generation, a *non-trivial*, computable instance is needed. Finite
// languages over a finite alphabet, ordered by set inclusion, with `dot` as
// (length-bounded) concatenation, are exactly the standard model semanticists
// use for the Lambek calculus (syntactic concept lattices, Wurm 2012, cited
// in the Lean file's own header) -- this is a genuine instance of the same
// algebra, not a renamed unrelated structure:
//   - carrier: finite subsets of Sigma^{<=maxLen} (Sigma a finite alphabet)
//   - meet/join: set intersection/union (a genuine bounded lattice --
//     Boolean, even, since the carrier is a finite powerset)
//   - dot(A, B): { a++b : a in A, b in B, len(a++b) <= maxLen } -- ordinary
//     concatenation, truncated to stay inside the carrier
//   - e: the singleton language {epsilon} (the empty word)
//   - lres(A, C) ("A \ C"): the left quotient { w : dot(A, {w}) subsetOf C }
//     -- "what must follow every word in A to land inside C"
//   - rres(C, B) ("C / B"): the right quotient { w : dot({w}, B) subsetOf C }
//     -- "what must precede every word in B to land inside C"
//
// dot's truncation makes it associative only because the bound is applied
// consistently (see test/lambek.test.mjs's associativity property test,
// which checks this directly rather than assuming it): for any bound N and
// words a,b,c, len(a)+len(b)+len(c) <= N is a single fact that (A.B).C and
// A.(B.C) both reduce to, so truncating at each pairwise step never discards
// a combination the other order would have kept. The residuals are the
// ordinary formal-language left/right quotients, restricted to the same
// bounded alphabet -- also checked against the bi-residuation adjunction
// directly (dot(A,B) subsetOf C <=> B subsetOf lres(A,C) <=> A subsetOf
// rres(C,B)) by property-based tests over random finite languages, which is
// the honest way to confirm this ported instance actually satisfies the
// algebra the Lean file proves things about, rather than merely gesturing at
// it.
//
// IMPORTANT CALLER OBLIGATION: lres/rres's own domain of quantification (the
// `universe` argument) must itself be bounded to no more than the *remaining*
// length budget for a given call, not the full max length -- otherwise a
// candidate word long enough to make dot(A,{w}) truncate to the empty set
// will be vacuously (and wrongly) accepted, since the empty set is a subset
// of everything. motif-grammar.mjs's generateTokenSequence is the concrete
// caller and handles this by re-deriving a fresh, remaining-budget-sized
// universe at every generation step -- see its header comment.

const SEP = '';

/** The empty word (monoid unit `e`'s sole member). */
export const EMPTY_WORD = '';

/** @param {string[]} tokens @returns {string} a word (tokens joined by the internal separator) */
export function word(tokens) {
  return tokens.join(SEP);
}

/** @param {string} w @returns {string[]} the word's tokens */
export function unword(w) {
  return w === EMPTY_WORD ? [] : w.split(SEP);
}

/** @param {string} w @returns {number} token count */
export function wordLen(w) {
  return w === EMPTY_WORD ? 0 : w.split(SEP).length;
}

/**
 * Enumerates the full bounded universe Sigma^{<=maxLen}: every word of
 * length 0..maxLen over the given finite alphabet. This is the carrier's
 * "top element" (join of every singleton) for a given bound, and also the
 * required domain of quantification for lres/rres (see this module's header
 * comment on why that domain must be re-derived per call, sized to the
 * actual remaining budget, not reused from a larger bound).
 * @param {string[]} alphabet
 * @param {number} maxLen
 * @returns {Set<string>}
 */
export function enumerateUniverse(alphabet, maxLen) {
  let frontier = new Set([EMPTY_WORD]);
  const all = new Set(frontier);
  for (let len = 1; len <= maxLen; len++) {
    const next = new Set();
    for (const w of frontier) {
      for (const a of alphabet) {
        const nw = w === EMPTY_WORD ? a : w + SEP + a;
        next.add(nw);
        all.add(nw);
      }
    }
    frontier = next;
  }
  return all;
}

/** Lattice meet: set intersection. @param {Set<string>} A @param {Set<string>} B @returns {Set<string>} */
export function meet(A, B) {
  const out = new Set();
  for (const w of A) if (B.has(w)) out.add(w);
  return out;
}

/** Lattice join: set union. @param {Set<string>} A @param {Set<string>} B @returns {Set<string>} */
export function join(A, B) {
  return new Set([...A, ...B]);
}

/** Lattice order: A <= B iff meet(A,B) === A, i.e. A is a subset of B. @param {Set<string>} A @param {Set<string>} B @returns {boolean} */
export function isSubsetOf(A, B) {
  for (const w of A) if (!B.has(w)) return false;
  return true;
}

/** @param {string} a @param {string} b @returns {string} */
function concatWords(a, b) {
  if (a === EMPTY_WORD) return b;
  if (b === EMPTY_WORD) return a;
  return a + SEP + b;
}

/**
 * The monoid product `dot` (`.` / `*` in the Lean file's LambekAlgebra):
 * length-bounded concatenation of two languages.
 * @param {Set<string>} A
 * @param {Set<string>} B
 * @param {number} maxLen
 * @returns {Set<string>}
 */
export function dot(A, B, maxLen) {
  const out = new Set();
  for (const a of A) {
    const la = wordLen(a);
    if (la > maxLen) continue;
    for (const b of B) {
      const lb = wordLen(b);
      if (la + lb > maxLen) continue;
      out.add(concatWords(a, b));
    }
  }
  return out;
}

/**
 * The left residual `A \ C` (`lres` in the Lean file): "what word, appended
 * on the right of every word in A, lands inside C" -- the left quotient,
 * restricted to the given bounded universe. Per this module's header
 * comment, `universe` MUST be sized to the real remaining length budget for
 * the call site, not reused from a larger bound, or the truncation in `dot`
 * will vacuously admit over-length candidates.
 * @param {Set<string>} A
 * @param {Set<string>} C
 * @param {Set<string>} universe - candidate words to test, e.g. from enumerateUniverse
 * @param {number} maxLen
 * @returns {Set<string>}
 */
export function lres(A, C, universe, maxLen) {
  const out = new Set();
  for (const w of universe) {
    const d = dot(A, new Set([w]), maxLen);
    if (isSubsetOf(d, C)) out.add(w);
  }
  return out;
}

/**
 * The right residual `C / B` (`rres` in the Lean file): "what word, prepended
 * on the left of every word in B, lands inside C" -- the right quotient. Same
 * bounded-universe obligation as lres.
 * @param {Set<string>} C
 * @param {Set<string>} B
 * @param {Set<string>} universe
 * @param {number} maxLen
 * @returns {Set<string>}
 */
export function rres(C, B, universe, maxLen) {
  const out = new Set();
  for (const w of universe) {
    const d = dot(new Set([w]), B, maxLen);
    if (isSubsetOf(d, C)) out.add(w);
  }
  return out;
}
