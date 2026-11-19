// scale.mjs
//
// Fixes the pitch material for the whole engine: a single modal,
// drone-friendly scale expressed as a 12-bit pitch-class bitmask (bit i set
// means pitch class i -- standard MIDI convention, C=0 .. B=11 -- belongs to
// the scale) plus a Hz lookup table spanning three octaves (roughly C2-C5).
//
// Every downstream bitmask operation in the generative layer -- chordMask in
// flow.mjs, the sub-check/join-check cover in cover.mjs, the CRDT chord
// merge -- operates directly on these bits. Because flow.mjs only ever
// injects pitch classes drawn from scale.scalePitchClasses, every chord the
// engine can produce is automatically diatonic to the mode: there is no
// path anywhere in the generative layer for a chromatic or dissonant note to
// enter the piece.
//
// Interval sets are no longer a 4-entry named lookup table. They are
// generated from combinatorial first principles: maximal evenness (Clough &
// Douthett 1991) -- for a chromatic universe of `chromaticUniverse` pitch
// classes (12 by default) and a target cardinality `d`, the maximally even
// d-note subset is the one whose members are spread as evenly as possible
// around the chromatic circle, J(d,c)_i = ceil(i*c/d). This is not a loose
// analogy: computing this for (d=7, c=12) and rotating the result reproduces
// all seven classical diatonic modes exactly (Ionian/Dorian/Phrygian/
// Lydian/Mixolydian/Aeolian/Locrian -- checked in test/scale.test.mjs), and
// (d=5, c=12) reproduces both pentatonic collections exactly the same way.
// The four named modes this module used to hardcode (dorian/aeolian/
// majorPentatonic/minorPentatonic) are kept below as named (cardinality,
// rotation) coordinates into that same generator -- recognizable special
// cases, not a separate mechanism -- while generateModeIntervals exposes the
// full space: any cardinality 2..11 (11 excludes only the degenerate d=1/
// d=12 cases) at any of its own rotations, over any chromatic universe size,
// which is a combinatorially large space of valid modes (65 distinct
// (cardinality, rotation) shapes at c=12 alone, times 12 possible roots)
// rather than 4 retrievable names.

import { nextInt } from './random.mjs';

const A4_HZ = 440;
const A4_MIDI = 69;

/**
 * The maximally even d-note subset of a c-note chromatic universe (Clough &
 * Douthett 1991): J(d,c)_i = ceil(i*c/d) mod c, for i = 0..d-1. Spreads d
 * points as evenly as possible around a c-point circle -- this single
 * formula is what generates the diatonic collection at (7,12), the
 * pentatonic collection at (5,12), the whole-tone collection at (6,12), and
 * so on for every cardinality in between, all from one combinatorial rule
 * rather than d separate hand-picked interval lists.
 * @param {number} cardinality - d, the number of notes in the generated set (1..chromaticUniverse)
 * @param {number} [chromaticUniverse=12] - c, the size of the chromatic universe
 * @returns {number[]} d pitch-class-like values in [0, chromaticUniverse), ascending, starting at 0
 */
export function maximallyEvenIntervals(cardinality, chromaticUniverse = 12) {
  if (!Number.isInteger(cardinality) || cardinality < 1 || cardinality > chromaticUniverse) {
    throw new Error(`maximallyEvenIntervals: cardinality must be an integer in [1, ${chromaticUniverse}], got ${cardinality}`);
  }
  const out = [];
  for (let i = 0; i < cardinality; i++) {
    out.push(Math.ceil((i * chromaticUniverse) / cardinality) % chromaticUniverse);
  }
  return out;
}

/**
 * Rotates a maximally-even interval set to start at its own rotationIndex-th
 * member -- this is what turns "the diatonic collection" into "Dorian" vs.
 * "Aeolian" vs. any of the other modes: same pitch-class set, different
 * member chosen as the new degree-0 tonic, re-expressed as intervals above
 * that new root (wrapping through chromaticUniverse).
 * @param {number[]} intervals - ascending, from maximallyEvenIntervals
 * @param {number} chromaticUniverse
 * @param {number} rotationIndex
 * @returns {number[]} ascending intervals above the new root, degree 0 = 0
 */
export function rotateIntervalsToDegree(intervals, chromaticUniverse, rotationIndex) {
  const n = intervals.length;
  const idx = ((rotationIndex % n) + n) % n;
  const start = intervals[idx];
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(((intervals[(idx + i) % n] - start + chromaticUniverse) % chromaticUniverse));
  }
  return out;
}

/**
 * The generative replacement for the old MODE_INTERVALS lookup table:
 * computes a mode's interval set directly from (cardinality, rotation)
 * coordinates via maximallyEvenIntervals + rotateIntervalsToDegree, rather
 * than retrieving one of a handful of named entries.
 * @param {object} opts
 * @param {number} opts.cardinality - d, notes per octave (2..11 at c=12)
 * @param {number} [opts.rotation=0] - which member of the maximally-even set is the new tonic
 * @param {number} [opts.chromaticUniverse=12]
 * @returns {number[]} ascending semitone intervals above the root, degree 0 = 0
 */
export function generateModeIntervals({ cardinality, rotation = 0, chromaticUniverse = 12 }) {
  const base = maximallyEvenIntervals(cardinality, chromaticUniverse);
  return rotateIntervalsToDegree(base, chromaticUniverse, rotation);
}

// The four modes this module originally hardcoded, kept as named
// (cardinality, rotation) coordinates into generateModeIntervals -- verified
// in test/scale.test.mjs to reproduce the exact same interval lists the old
// MODE_INTERVALS table used to hand-list. Real special cases of one
// generator, not four separate recipes.
const NAMED_MODE_COORDS = {
  // D Dorian (default): minor-flavored but with a bright natural 6th.
  // Rotation 5 of the (cardinality 7) maximally-even/diatonic collection.
  dorian: { cardinality: 7, rotation: 5 },
  // Natural minor: rotation 2 of the same diatonic collection.
  aeolian: { cardinality: 7, rotation: 2 },
  // Pentatonic subsets of the maximally-even (cardinality 5) collection --
  // any two members of a maximally-even 5-note set stay consonant together,
  // which is why these were originally described as "strip the
  // dissonance-prone degrees": that is exactly what generating from
  // cardinality 5 instead of 7 does structurally, not a separate hand-tuned
  // rule.
  majorPentatonic: { cardinality: 5, rotation: 3 },
  minorPentatonic: { cardinality: 5, rotation: 2 },
};

const NOTE_NAME_TO_PC = { C: 0, 'C#': 1, D: 2, 'D#': 3, E: 4, F: 5, 'F#': 6, G: 7, 'G#': 8, A: 9, 'A#': 10, B: 11 };

// Octave register the engine draws voices from: three octaves, roughly C2
// (~65Hz) up to just under C5 (~494Hz) -- comfortably in pad/drone
// territory, low enough to feel grounded, high enough to stay clear of mud.
export const OCTAVES = [2, 3, 4];

/**
 * @param {number} pc - pitch class 0-11
 * @returns {number} 12-bit bitmask with just that pitch class's bit set
 */
export function pitchClassBit(pc) {
  return 1 << (((pc % 12) + 12) % 12);
}

/**
 * @param {number} cents
 * @returns {number} frequency ratio, e.g. 1200 cents -> 2.0 (one octave up)
 */
export function centsToRatio(cents) {
  return Math.pow(2, cents / 1200);
}

/** @param {number} midiNote @returns {number} Hz */
export function midiToHz(midiNote) {
  return A4_HZ * Math.pow(2, (midiNote - A4_MIDI) / 12);
}

/**
 * @param {number} pc - pitch class 0-11
 * @param {number} octave - e.g. 4 means "the octave containing MIDI C4"
 * @returns {number} Hz
 */
export function pitchClassToHz(pc, octave) {
  const midi = 12 * (octave + 1) + pc;
  return midiToHz(midi);
}

/**
 * Index of an absolute octave number within OCTAVES (i.e. which column of
 * hzTable[pc] to read), clamped to a valid index if the octave is outside
 * OCTAVES's range.
 * @param {number} octave
 * @returns {number} index into OCTAVES / hzTable[pc]
 */
export function octaveToIndex(octave) {
  const idx = OCTAVES.indexOf(octave);
  return idx < 0 ? 0 : idx;
}

/**
 * Resolves a mode specifier to its interval set (semitones above the root,
 * ascending from 0). Accepts either a legacy named mode (resolved to its
 * (cardinality, rotation) coordinates via NAMED_MODE_COORDS, then generated
 * -- not looked up from a separate interval list) or a direct
 * {cardinality, rotation, chromaticUniverse} generator-coordinate object,
 * throwing on an unknown mode name.
 * @param {'dorian'|'aeolian'|'majorPentatonic'|'minorPentatonic'|{cardinality:number, rotation?:number, chromaticUniverse?:number}} mode
 * @returns {number[]}
 */
function modeIntervals(mode) {
  if (typeof mode === 'object' && mode !== null) {
    return generateModeIntervals(mode);
  }
  const coords = NAMED_MODE_COORDS[mode];
  if (!coords) throw new Error(`Unknown mode: ${mode}. Use one of: ${Object.keys(NAMED_MODE_COORDS).join(', ')}, or a {cardinality, rotation} generator-coordinate object.`);
  return generateModeIntervals(coords);
}

/**
 * Builds a 12-bit scale bitmask from a root note name and a mode specifier
 * (legacy name or generator coordinates -- see modeIntervals).
 * @param {string} rootName - e.g. 'D'
 * @param {'dorian'|'aeolian'|'majorPentatonic'|'minorPentatonic'|{cardinality:number, rotation?:number, chromaticUniverse?:number}} mode
 * @returns {number} 12-bit bitmask, bit i set = pitch class i is in scale
 */
export function buildScaleBitmask(rootName, mode) {
  const rootPc = NOTE_NAME_TO_PC[rootName];
  if (rootPc === undefined) throw new Error(`Unknown root note: ${rootName}`);
  const intervals = modeIntervals(mode);
  let mask = 0;
  for (const iv of intervals) mask |= pitchClassBit(rootPc + iv);
  return mask;
}

/**
 * @param {number} mask - 12-bit pitch-class bitmask
 * @returns {number[]} sorted list of pitch classes present in mask
 */
export function bitmaskToPitchClasses(mask) {
  const pcs = [];
  for (let pc = 0; pc < 12; pc++) {
    if (mask & pitchClassBit(pc)) pcs.push(pc);
  }
  return pcs;
}

/**
 * Builds the Hz lookup table across OCTAVES for every one of the 12 pitch
 * classes (not just the active scale), so the table stays reusable even if
 * the scale changes at runtime. Callers should only ever *index* this table
 * with pitch classes drawn from scale.scalePitchClasses -- that restriction
 * (enforced by flow.mjs's injection step, not by this table) is what keeps
 * every generated note diatonic.
 * @returns {Record<number, number[]>} pc -> [hz at OCTAVES[0], hz at OCTAVES[1], hz at OCTAVES[2]]
 */
export function buildScaleHzTable() {
  const table = {};
  for (let pc = 0; pc < 12; pc++) {
    table[pc] = OCTAVES.map((oct) => pitchClassToHz(pc, oct));
  }
  return table;
}

/**
 * Creates the full scale description threaded through the generative layer.
 *
 * Two different pitch-class orderings are exposed, deliberately, because
 * they answer different questions:
 *   - scalePitchClasses is numerically sorted (0-11) -- convenient for
 *     bitmask/set-membership work (cover.mjs, flow.mjs's injection draw).
 *   - degreePitchClasses is ordered by *scale degree*, starting at the
 *     root (index 0 = tonic, index 1 = supertonic, ...) -- this is what
 *     melody.mjs needs for real diatonic transposition ("up one scale
 *     degree" instead of "up one semitone"), since numeric pitch-class
 *     sort order has nothing to do with a mode's actual degree order.
 * @param {object} [opts]
 * @param {string} [opts.root='D']
 * @param {'dorian'|'aeolian'|'majorPentatonic'|'minorPentatonic'|{cardinality:number, rotation?:number, chromaticUniverse?:number}} [opts.mode='dorian'] - a legacy named mode, or direct maximal-evenness generator coordinates
 * @returns {{root:string, mode:string|object, modeLabel:string, rootPitchClass:number, scaleMask:number, scalePitchClasses:number[], degreeIntervals:number[], degreePitchClasses:number[], hzTable:Record<number,number[]>}}
 */
export function makeScale({ root = 'D', mode = 'dorian' } = {}) {
  const scaleMask = buildScaleBitmask(root, mode);
  const rootPitchClass = NOTE_NAME_TO_PC[root];
  if (rootPitchClass === undefined) throw new Error(`Unknown root note: ${root}`);
  const intervals = modeIntervals(mode);
  const degreePitchClasses = intervals.map((iv) => (((rootPitchClass + iv) % 12) + 12) % 12);
  const modeLabel = typeof mode === 'string' ? mode : `me${mode.cardinality}r${mode.rotation ?? 0}`;
  return {
    root,
    mode,
    modeLabel,
    rootPitchClass,
    scaleMask,
    scalePitchClasses: bitmaskToPitchClasses(scaleMask),
    // degreeIntervals is the raw semitones-above-root list (e.g. D dorian:
    // [0,2,3,5,7,9,10]) -- kept alongside degreePitchClasses because octave
    // math (scaleDegreeToPitchClassAndOctaveShift) needs actual semitone
    // distance from the root, not just which of the 12 pitch classes a
    // degree lands on. Pitch class alone is not enough: two scales can put
    // the same pitch class at different semitone distances from the root
    // depending on the mode, and the *octave* a degree belongs in depends
    // on that distance crossing a 12-semitone boundary, not on how many
    // scale-degree steps were taken.
    degreeIntervals: intervals.slice(),
    degreePitchClasses,
    hzTable: buildScaleHzTable(),
  };
}

/**
 * Maps a (possibly out-of-range or negative) scale-degree number onto a
 * pitch class plus an octave-shift count (in absolute octaves, matching
 * OCTAVES's step-by-1 numbering), wrapping through the scale's own degree
 * count (not always 12 -- pentatonic modes have 5 degrees, diatonic modes
 * have 7). Degree 0 is always the tonic.
 *
 * This is computed from actual semitone distance from the root
 * (degreeIntervals), not from degree-index // degreeCount: the two disagree
 * whenever a scale degree's pitch class number is numerically less than the
 * root's (e.g. in D Dorian, the 7th degree is C, pitch class 0, "below" D's
 * pitch class 2 by number even though it sounds *above* D -- a major
 * seventh up, landing in the octave above D's, not the same octave). Octave
 * boundaries are fixed at pitch class C regardless of the scale's root, so
 * only true semitone distance gets the octave right.
 *
 * This is also the operation that makes "transpose by scale degree"
 * (melody.mjs) meaningfully different from "transpose by semitone": the
 * interval between two adjacent scale degrees is not constant (it's a
 * whole or half step depending on the mode), exactly as real diatonic
 * transposition requires.
 * @param {{rootPitchClass:number, degreeIntervals:number[]}} scale - from makeScale
 * @param {number} degree - 0 = tonic, may be negative or exceed the scale's degree count
 * @returns {{pitchClass:number, octaveShift:number}}
 */
export function scaleDegreeToPitchClassAndOctaveShift(scale, degree) {
  const len = scale.degreeIntervals.length;
  const idx = ((degree % len) + len) % len;
  const cycle = Math.floor(degree / len);
  const semitonesFromRoot = scale.degreeIntervals[idx] + 12 * cycle;
  const absolutePc = scale.rootPitchClass + semitonesFromRoot;
  const pitchClass = ((absolutePc % 12) + 12) % 12;
  const octaveShift = Math.floor(absolutePc / 12);
  return { pitchClass, octaveShift };
}

/** Named starting points for makeScale, all consonant/non-dissonant. */
export const MODE_PRESETS = Object.freeze({
  dDorian: Object.freeze({ root: 'D', mode: 'dorian' }),
  aAeolian: Object.freeze({ root: 'A', mode: 'aeolian' }),
  dMajorPentatonic: Object.freeze({ root: 'D', mode: 'majorPentatonic' }),
  aMinorPentatonic: Object.freeze({ root: 'A', mode: 'minorPentatonic' }),
});

/** The legacy mode names' underlying (cardinality, rotation) coordinates, exposed for introspection/testing. */
export const NAMED_MODE_LIST = Object.freeze(Object.keys(NAMED_MODE_COORDS));

// Cardinalities considered reasonable defaults for *random* scale generation
// -- wide enough to include the whole-tone (6) and diatonic-adjacent (5, 7,
// 8) collections, narrow enough to avoid the sparse, wide-gapped sets at the
// low end (2, 3, 4) and the near-chromatic (hence more dissonance-prone)
// sets at the high end (9, 10, 11). This is a genre-appropriateness choice
// for *this engine's* random-mode helper only -- generateModeIntervals
// itself supports the full 2..11 range for any caller that wants it.
export const DEFAULT_RANDOM_CARDINALITY_RANGE = Object.freeze([5, 8]);

/**
 * Picks random (cardinality, rotation) generator coordinates -- the
 * generative alternative to always defaulting to one of the 4 named modes.
 * @param {{state:number}} rng - from random.mjs's makeRng
 * @param {object} [opts]
 * @param {[number,number]} [opts.cardinalityRange=DEFAULT_RANDOM_CARDINALITY_RANGE] - inclusive [min,max] cardinality range
 * @param {number} [opts.chromaticUniverse=12]
 * @returns {{cardinality:number, rotation:number, chromaticUniverse:number}}
 */
export function randomModeCoordinates(rng, { cardinalityRange = DEFAULT_RANDOM_CARDINALITY_RANGE, chromaticUniverse = 12 } = {}) {
  const [lo, hi] = cardinalityRange;
  const cardinality = nextInt(rng, lo, hi + 1);
  const rotation = nextInt(rng, 0, cardinality);
  return { cardinality, rotation, chromaticUniverse };
}
