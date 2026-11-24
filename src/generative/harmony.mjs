// harmony.mjs
//
// A functional-harmony engine layered on top of scale.mjs's maximal-evenness
// scale generator: tertian (stacked-third) triads built directly in scale-
// degree space, a generalized tonic/predominant/dominant function
// classification, a weighted progression generator that assembles a
// tension-building-then-resolving chord sequence from those functions, and a
// modal-drift walker for slow long-form harmonic color change.
//
// This is ordinary common-practice functional-harmony theory (tertian
// harmony, functional categories, tension/resolution), not a port of
// anything in Obsmetrologia -- unlike regime.mjs/cover.mjs/flow.mjs/
// thermo.mjs/lambek.mjs, which the top-level README documents as borrowing
// structural vocabulary from that source material. The Music Sciences
// generative-theory note this engine's README points to
// (verified-structures-as-compositional-grammar.md) does not currently
// contain functional-harmony content to build on, so this module is
// standard music theory, encoded generatively (a real classifier + a real
// weighted grammar over functions, not a hand-picked progression table) in
// the same spirit as the rest of this codebase's generators.
//
// Function classification is generalized beyond the 7-note diatonic case
// it's most commonly taught in: for any scale.mjs scale (any cardinality),
// the "dominant" and "predominant" degrees are whichever scale degrees land
// closest (by actual semitone distance from the root) to a perfect fifth
// (7 semitones) and perfect fourth (5 semitones) above the tonic --
// generalizing "V is a fifth above I" and "IV is a fourth above I" to any
// mode/cardinality rather than assuming a 7-degree scale. Every other degree
// is classified by shared-tone substitution (a chord sharing 2 of the tonic
// triad's 3 pitch classes behaves like a tonic substitute, e.g. vi/iii in a
// major scale; failing that, substitution against the dominant triad; the
// residual default is predominant) -- the standard "common-tone" account of
// why vi/iii/ii/IV group the way they do in functional harmony, computed
// from real triad bitmasks (cover.mjs's own pitch-class-bitmask idiom) not
// asserted per scale degree by name.

import { pitchClassBit, scaleDegreeToPitchClassAndOctaveShift, randomModeCoordinates, generateModeIntervals } from './scale.mjs';
import { nextFloat, nextInt, pick } from './random.mjs';

/** @typedef {'tonic'|'predominant'|'dominant'} HarmonicFunction */

/**
 * The scale-degree-space stacked-third triad rooted at `degree`: [degree,
 * degree+2, degree+4] -- "skip one scale degree twice," the scale-degree-
 * space definition of tertian harmony, independent of the scale's
 * cardinality (works identically for a 5-note pentatonic or 7-note diatonic
 * scale; degrees simply wrap via scaleDegreeToPitchClassAndOctaveShift for
 * short scales the way melody.mjs's transposition already relies on).
 * @param {number} degree
 * @returns {[number, number, number]}
 */
export function diatonicTriadDegrees(degree) {
  return [degree, degree + 2, degree + 4];
}

/**
 * Resolves a scale-degree triad to its 12-bit pitch-class bitmask (the same
 * bitmask shape flow.mjs/cover.mjs use for chordMask), so the rest of the
 * engine's admission/cadence machinery can gate against a harmony.mjs chord
 * exactly the way it already gates against flow.mjs's accumulated chordMask.
 * @param {object} scale - from scale.mjs's makeScale
 * @param {number} degree
 * @returns {number} 12-bit pitch-class bitmask
 */
export function triadMask(scale, degree) {
  return diatonicTriadDegrees(degree).reduce((mask, d) => {
    const { pitchClass } = scaleDegreeToPitchClassAndOctaveShift(scale, d);
    return mask | pitchClassBit(pitchClass);
  }, 0);
}

function countSetBits(mask) {
  let n = 0;
  let m = mask;
  while (m) {
    m &= m - 1;
    n++;
  }
  return n;
}

/**
 * Finds the scale degree (1..degreeCount-1, i.e. excluding the tonic) whose
 * semitone distance from the root is closest to `targetSemitones` -- the
 * generalized "which degree is (closest to) a fifth/fourth above the tonic"
 * lookup classifyFunction below uses for the dominant/predominant degrees.
 * @param {object} scale
 * @param {number} targetSemitones
 * @returns {number} scale degree
 */
export function closestDegreeToInterval(scale, targetSemitones) {
  const len = scale.degreeIntervals.length;
  let best = 1 % len || 1;
  let bestDelta = Infinity;
  for (let d = 1; d < len; d++) {
    const delta = Math.abs(scale.degreeIntervals[d] - targetSemitones);
    if (delta < bestDelta) {
      bestDelta = delta;
      best = d;
    }
  }
  return best;
}

/**
 * Classifies a scale degree's harmonic function relative to the tonic. See
 * this module's header comment for the generalization rule.
 * @param {object} scale
 * @param {number} degree - 0..degreeCount-1 (degree 0 is always tonic)
 * @returns {HarmonicFunction}
 */
export function classifyFunction(scale, degree) {
  const len = scale.degreeIntervals.length;
  const d = ((degree % len) + len) % len;
  if (d === 0) return 'tonic';

  const dominantDegree = closestDegreeToInterval(scale, 7);
  const predominantDegree = closestDegreeToInterval(scale, 5);
  if (d === dominantDegree) return 'dominant';
  if (d === predominantDegree) return 'predominant';

  const tonicMask = triadMask(scale, 0);
  const dominantMask = triadMask(scale, dominantDegree);
  const thisMask = triadMask(scale, d);

  if (countSetBits(thisMask & tonicMask) >= 2) return 'tonic';
  if (countSetBits(thisMask & dominantMask) >= 2) return 'dominant';
  return 'predominant';
}

/** Relative tension level assigned per harmonic function, used both to order a progression's real tension arc and to derive scheduleTensionResolution's numeric curve. Dominant carries the most unresolved tension (it "wants" to move to tonic); predominant is a real step up from tonic but a real step down from dominant; tonic is rest. */
export const FUNCTION_TENSION = Object.freeze({ tonic: 0.1, predominant: 0.5, dominant: 0.9 });

// Weighted function-to-function transition table: a real (if small) Markov
// grammar over the three functional categories, encoding standard
// functional-harmony practice (tonic moves on to either function; dominant
// resolves back to tonic far more often than it moves to predominant;
// predominant moves on to dominant far more often than it returns straight
// to tonic) rather than picking the next chord uniformly at random.
const TRANSITION_WEIGHTS = Object.freeze({
  tonic: Object.freeze({ tonic: 1, predominant: 3, dominant: 2 }),
  predominant: Object.freeze({ tonic: 1, predominant: 1, dominant: 4 }),
  dominant: Object.freeze({ tonic: 5, predominant: 1, dominant: 1 }),
});

function weightedPick(rng, weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = nextFloat(rng) * total;
  for (const [key, w] of entries) {
    if (r < w) return key;
    r -= w;
  }
  return entries[entries.length - 1][0];
}

/**
 * Picks a concrete scale degree implementing a requested harmonic function,
 * among however many scale degrees classify that way (there is always at
 * least one: the dominant/predominant degrees themselves, even if no other
 * degree substitutes for them).
 * @param {{state:number}} rng
 * @param {object} scale
 * @param {HarmonicFunction} fn
 * @returns {number} scale degree
 */
export function pickDegreeForFunction(rng, scale, fn) {
  const len = scale.degreeIntervals.length;
  const candidates = [];
  for (let d = 0; d < len; d++) {
    if (classifyFunction(scale, d) === fn) candidates.push(d);
  }
  return candidates.length > 0 ? pick(rng, candidates) : 0;
}

/**
 * Generates a functional chord progression: a sequence of scale degrees
 * whose harmonic functions follow TRANSITION_WEIGHTS's tonic/predominant/
 * dominant grammar, real tension/resolution scheduling (each chord carries
 * its function's FUNCTION_TENSION value), and -- when requireResolution is
 * true (the default) -- a guaranteed final return to the tonic, appended if
 * the walk didn't already land there, so a generated progression always
 * actually resolves rather than merely being likely to.
 * @param {{state:number}} rng
 * @param {object} scale
 * @param {object} [opts]
 * @param {number} [opts.length=4] - number of chords before the guaranteed final resolution (not counting an appended resolution chord)
 * @param {HarmonicFunction} [opts.startFunction='tonic']
 * @param {boolean} [opts.requireResolution=true] - guarantees the progression's final chord is the literal tonic (scale degree 0) -- not merely a tonic-*function* substitute (e.g. the relative/submediant chord, which classifyFunction also labels 'tonic' via the shared-tone rule but which is not itself a full resolution)
 * @returns {Array<{degree:number, functionLabel:HarmonicFunction, tension:number, mask:number}>}
 */
export function generateProgression(rng, scale, opts = {}) {
  const length = Math.max(1, opts.length ?? 4);
  const requireResolution = opts.requireResolution ?? true;
  let fn = opts.startFunction ?? 'tonic';

  const progression = [];
  for (let i = 0; i < length; i++) {
    const degree = pickDegreeForFunction(rng, scale, fn);
    progression.push({ degree, functionLabel: fn, tension: FUNCTION_TENSION[fn], mask: triadMask(scale, degree) });
    fn = weightedPick(rng, TRANSITION_WEIGHTS[fn]);
  }

  if (requireResolution && progression[progression.length - 1].degree !== 0) {
    progression.push({ degree: 0, functionLabel: 'tonic', tension: FUNCTION_TENSION.tonic, mask: triadMask(scale, 0) });
  }

  return progression;
}

/**
 * Lays a generated progression out in absolute transport time, one chord per
 * `chordDurationSec`, starting at `startSec` -- the concrete tension-over-
 * time curve (a real, checkable sequence of {tSec, tension} points) an
 * intensity/mix automation layer (arrangement.mjs) can read directly, rather
 * than an abstract chord list with no timing.
 * @param {Array<{degree:number, functionLabel:HarmonicFunction, tension:number, mask:number}>} progression - from generateProgression
 * @param {object} opts
 * @param {number} [opts.startSec=0]
 * @param {number} opts.chordDurationSec
 * @returns {Array<{degree:number, functionLabel:HarmonicFunction, tension:number, mask:number, startSec:number, durSec:number}>}
 */
export function scheduleProgression(progression, { startSec = 0, chordDurationSec }) {
  return progression.map((chord, i) => ({ ...chord, startSec: startSec + i * chordDurationSec, durSec: chordDurationSec }));
}

// --- modal drift ------------------------------------------------------

/**
 * Creates modal-drift state from a starting (cardinality, rotation,
 * chromaticUniverse) coordinate triple (scale.mjs's generator-coordinate
 * shape) -- the slow long-form harmonic-color-change mechanism ambient
 * pieces want: a mode that occasionally shifts to an adjacent point in
 * scale.mjs's maximal-evenness generator space, rather than fixing one mode
 * for the piece's whole duration or jumping to a wholly unrelated one.
 * @param {{cardinality:number, rotation:number, chromaticUniverse?:number}} startCoords
 * @returns {{coords:{cardinality:number, rotation:number, chromaticUniverse:number}, driftCount:number}}
 */
export function makeModalDriftState(startCoords) {
  return {
    coords: { chromaticUniverse: 12, ...startCoords },
    driftCount: 0,
  };
}

/**
 * Advances modal-drift state by one step. With probability pRotate, rotates
 * to an adjacent member of the same maximally-even set (a small color shift:
 * same cardinality, new tonic-relative starting point, e.g. Dorian drifting
 * to Phrygian on the same underlying diatonic collection). With probability
 * pCardinality (independent, checked after), additionally steps the
 * cardinality by +-1 within cardinalityRange (a bigger color shift: the
 * underlying pitch-class collection itself changes size, e.g. diatonic
 * drifting toward pentatonic or toward a fuller 8-note collection) -- rarer
 * than a rotation-only drift by design (opts default pCardinality well below
 * pRotate), since a cardinality change is a much larger perceptual jump than
 * a rotation. Both are genuine generator-coordinate moves (scale.mjs's own
 * generateModeIntervals space), not a hand-picked "next mode" table.
 * @param {{coords:object, driftCount:number}} state - mutated in place
 * @param {{state:number}} rng
 * @param {object} [opts]
 * @param {number} [opts.pRotate=0.5]
 * @param {number} [opts.pCardinality=0.15]
 * @param {[number,number]} [opts.cardinalityRange=[5,8]]
 * @returns {{coords:object, drifted:boolean, kind:'none'|'rotation'|'cardinality'}}
 */
export function stepModalDrift(state, rng, opts = {}) {
  const pRotate = opts.pRotate ?? 0.5;
  const pCardinality = opts.pCardinality ?? 0.15;
  const [loC, hiC] = opts.cardinalityRange ?? [5, 8];

  let { cardinality, rotation, chromaticUniverse } = state.coords;
  let kind = 'none';

  if (nextFloat(rng) < pCardinality) {
    const direction = nextFloat(rng) < 0.5 ? -1 : 1;
    const nextCardinality = Math.max(loC, Math.min(hiC, cardinality + direction));
    if (nextCardinality !== cardinality) {
      cardinality = nextCardinality;
      rotation = rotation % cardinality;
      kind = 'cardinality';
    }
  }

  if (kind === 'none' && nextFloat(rng) < pRotate) {
    const direction = nextFloat(rng) < 0.5 ? -1 : 1;
    rotation = ((rotation + direction) % cardinality + cardinality) % cardinality;
    kind = 'rotation';
  }

  const drifted = kind !== 'none';
  if (drifted) {
    state.coords = { cardinality, rotation, chromaticUniverse };
    state.driftCount += 1;
    // Sanity: coordinates must still resolve to a real interval set. Thrown
    // errors here would indicate a bug in the clamping above, not a
    // reachable runtime condition for a caller to handle.
    generateModeIntervals(state.coords);
  }

  return { coords: state.coords, drifted, kind };
}

/**
 * Convenience: a random valid starting coordinate for modal drift, reusing
 * scale.mjs's own genre-appropriate cardinality range rather than picking
 * arbitrary values here.
 * @param {{state:number}} rng
 * @returns {{cardinality:number, rotation:number, chromaticUniverse:number}}
 */
export function randomDriftStartCoords(rng) {
  return randomModeCoordinates(rng);
}
