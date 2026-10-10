// leitmotif.mjs
//
// A named melodic identity generated once from a seed, plus a deterministic
// *family* of developing-variation statements built entirely on top of
// melody.mjs's existing generator (generateMotif) and its existing
// developing-variation operators (transposeMotif/invertMotif/
// retrogradeMotif/augmentMotif/diminishMotif). This module adds no new
// pitch-shape mechanism of its own -- it wraps that existing machinery with
// an *identity* (a stable id/seed a caller can hang other state on: "this
// jackpot tier's motif", "this persona's motif", "this game mode's motif")
// so the same recognizable figure can recur across a piece, or across many
// pieces, and still yield a large family of related-but-distinct statements
// instead of being restated identically every time.
//
// Representation: a leitmotif's core is exactly melody.mjs's NoteEvent[]
// shape (scale degree + rational duration + rest flag) -- deliberately
// scale-agnostic, since a "degree" is only resolved to a pitch class/Hz
// later (melody.mjs's degreeToHz) against whatever scale a caller supplies.
// This is what makes "re-harmonize the same leitmotif" a real, cheap
// operation here: replaying the identical core NoteEvent[] against a
// different scale (e.g. harmony.mjs's modal-drift output) reharmonizes it
// for free, with no separate "reharmonize" transform needed -- the harmonic
// color comes entirely from which scale degreeToHz resolves against, not
// from anything mutated on the motif itself. See reharmonizeAgainstScale
// below, which is a thin, explicit wrapper making that pattern discoverable
// rather than a mechanism unto itself.

import { makeRng, nextInt, nextRange, pick, hashStringToInt } from './random.mjs';
import {
  generateMotif,
  transposeMotif,
  invertMotif,
  retrogradeMotif,
  augmentMotif,
  diminishMotif,
  degreeToHz,
} from './melody.mjs';

/**
 * Derives a child integer seed deterministically from a parent seed plus a
 * string salt, so a leitmotif's family/variation seeds are reproducible from
 * the leitmotif's own seed alone (no extra seed a caller has to thread
 * through and remember to keep fixed) while still being a genuinely
 * different PRNG stream from the leitmotif's own core-generation stream.
 * @param {number|string} parentSeed
 * @param {string} salt
 * @returns {number}
 */
export function childSeed(parentSeed, salt) {
  return hashStringToInt(`${String(parentSeed)}::${salt}`);
}

/**
 * Generates a leitmotif: a short, seed-deterministic core motif (melody.mjs
 * NoteEvent[]) plus the identity (id, seed) a caller threads through the
 * rest of this module and through arrangement.mjs.
 * @param {number|string} seed
 * @param {object} [opts]
 * @param {string} [opts.id] - human-readable identity label (defaults to the seed's own string form)
 * @param {number} [opts.length] - note count; defaults to a random 3-5, matching melody.mjs's generateMotif default range
 * @param {number} [opts.startDegree=0]
 * @param {import('./melody.mjs').DurationFraction[]} [opts.durations]
 * @param {{lo:number, hi:number, requireWide:boolean}} [opts.bias] - motif-grammar.mjs bias (see melody.mjs's generateMotif); omit for the default narrow bias
 * @returns {{id:string, seed:number|string, core:import('./melody.mjs').NoteEvent[]}}
 */
export function makeLeitmotif(seed, opts = {}) {
  const rng = makeRng(seed);
  const length = opts.length ?? nextInt(rng, 3, 6);
  const core = generateMotif(rng, {
    length,
    startDegree: opts.startDegree ?? 0,
    durations: opts.durations,
    bias: opts.bias,
  });
  return { id: opts.id ?? String(seed), seed, core };
}

/** Names of the developing-variation transforms deriveVariation understands, in the order generateFamily cycles through them by default. */
export const TRANSFORM_NAMES = Object.freeze([
  'original',
  'transpose',
  'invert',
  'retrograde',
  'augment',
  'diminish',
  'retrogradeInvert',
  'transposeAugment',
]);

/**
 * Applies one named developing-variation transform to a leitmotif's core
 * motif (or any NoteEvent[]), returning a fresh array -- never mutates the
 * input. 'retrogradeInvert' and 'transposeAugment' are compound transforms
 * built from the same four primitive operators (retrograde-then-invert,
 * transpose-then-augment) rather than new pitch/rhythm mechanisms, exactly
 * the same "compose the existing operators" approach generatePhrase already
 * uses in melody.mjs.
 * @param {import('./melody.mjs').NoteEvent[]} motif
 * @param {'original'|'transpose'|'invert'|'retrograde'|'augment'|'diminish'|'retrogradeInvert'|'transposeAugment'} transformName
 * @param {object} [params]
 * @param {number} [params.degreeShift=2] - used by 'transpose'/'transposeAugment'
 * @param {number} [params.axisDegree] - used by 'invert'/'retrogradeInvert'; defaults to the motif's own first note's degree
 * @param {number} [params.factor=2] - used by 'augment'/'diminish'/'transposeAugment'
 * @returns {import('./melody.mjs').NoteEvent[]}
 */
export function deriveVariation(motif, transformName, params = {}) {
  const degreeShift = params.degreeShift ?? 2;
  const factor = params.factor ?? 2;
  switch (transformName) {
    case 'original':
      return motif.map((n) => ({ ...n }));
    case 'transpose':
      return transposeMotif(motif, degreeShift);
    case 'invert':
      return invertMotif(motif, params.axisDegree);
    case 'retrograde':
      return retrogradeMotif(motif);
    case 'augment':
      return augmentMotif(motif, factor);
    case 'diminish':
      return diminishMotif(motif, factor);
    case 'retrogradeInvert':
      return retrogradeMotif(invertMotif(motif, params.axisDegree));
    case 'transposeAugment':
      return augmentMotif(transposeMotif(motif, degreeShift), factor);
    default:
      throw new Error(`deriveVariation: unknown transform "${transformName}". Use one of: ${TRANSFORM_NAMES.join(', ')}`);
  }
}

/**
 * Generates a deterministic family of variations from one leitmotif: `size`
 * statements, each a named transform (cycling through `names`, default
 * TRANSFORM_NAMES) applied with parameters drawn from the leitmotif's own
 * derived PRNG stream (childSeed(leitmotif.seed, 'family') unless a caller
 * overrides opts.seed) -- so calling this twice on the same leitmotif always
 * produces byte-identical output, with no extra seed for a caller to
 * remember to keep fixed.
 * @param {{id:string, seed:number|string, core:import('./melody.mjs').NoteEvent[]}} leitmotif
 * @param {object} [opts]
 * @param {number} [opts.size=8]
 * @param {string[]} [opts.names] - transform names to cycle through; defaults to TRANSFORM_NAMES
 * @param {number|string} [opts.seed] - overrides the derived family seed
 * @returns {Array<{name:string, params:object, motif:import('./melody.mjs').NoteEvent[]}>}
 */
export function generateFamily(leitmotif, opts = {}) {
  const rng = makeRng(opts.seed ?? childSeed(leitmotif.seed, 'family'));
  const size = opts.size ?? TRANSFORM_NAMES.length;
  const names = opts.names ?? TRANSFORM_NAMES;
  const axisDegree = leitmotif.core[0] ? leitmotif.core[0].degree : 0;
  const family = [];
  for (let i = 0; i < size; i++) {
    const name = names[i % names.length];
    const params = {
      degreeShift: pick(rng, [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5]),
      factor: pick(rng, [2, 2, 3]),
      axisDegree,
    };
    family.push({ name, params, motif: deriveVariation(leitmotif.core, name, params) });
  }
  return family;
}

/**
 * Replays a leitmotif's exact core NoteEvent[] (or any developed variation
 * of it) against a different scale -- the "re-harmonize the same identity"
 * operation: the note sequence (scale degrees + durations) is untouched, but
 * resolving each degree via degreeToHz against a new scale changes which
 * actual pitches/intervals sound, since a given scale degree's semitone
 * distance from the tonic depends on the mode. This is a thin, explicit
 * wrapper around melody.mjs's own degreeToHz, not a new transform -- see
 * this module's header comment for why no separate mutation is needed.
 * @param {import('./melody.mjs').NoteEvent[]} motif
 * @param {object} scale - from scale.mjs's makeScale (the *new* harmonic context)
 * @param {number} [baseOctaveIndex=1]
 * @returns {Array<import('./melody.mjs').NoteEvent & {hz:number}>}
 */
export function reharmonizeAgainstScale(motif, scale, baseOctaveIndex = 1) {
  return motif.map((n) => ({ ...n, hz: n.rest ? null : degreeToHz(scale, n.degree, baseOctaveIndex) }));
}

/**
 * Convenience: total duration of a motif in whole-note units (sum of
 * durationFrac.num/den), used by arrangement.mjs to lay statements out in
 * absolute seconds without re-deriving this from generatePhrase's fuller
 * (and pad-bed-cadence-aware) phrase-assembly machinery, which a stem-level
 * leitmotif statement doesn't need.
 * @param {import('./melody.mjs').NoteEvent[]} motif
 * @returns {number} whole notes
 */
export function motifLengthWholeNotes(motif) {
  return motif.reduce((sum, n) => sum + n.durationFrac.num / n.durationFrac.den, 0);
}
