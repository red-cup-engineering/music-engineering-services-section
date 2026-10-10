// melody.mjs -- the foreground melodic layer: motifs drawn from the active
// scale via motif-grammar.mjs's Lambek-calculus grammar, developed with the
// four standard operators (transpose/invert/retrograde/augment-diminish),
// assembled into phrases that cadence on the tonic or covered dominant
// (cover.mjs's subCheck). Macro-form (OPENING/DEVELOPMENT/RETURN) tracks
// regime.mjs's own regime sequence; rhythmic proportions come from
// regime.mjs's growthTower(). The four operators are checked in
// melody.test.mjs for their standard identities.

import { growthTower, regimeGrowthKind } from './regime.mjs';
import { subCheck } from './cover.mjs';
import { pitchClassBit, scaleDegreeToPitchClassAndOctaveShift, OCTAVES } from './scale.mjs';
import { nextInt, nextRange, pick } from './random.mjs';
import { generateSteps } from './motif-grammar.mjs';
import { makeFraction, multiplyFractionByInt, divideFractionByInt } from '@red-cup-engineering/computer-audio-engineering-services-section/fraction';

export { makeFraction, multiplyFractionByInt, divideFractionByInt };

/**
 * @typedef {object} DurationFraction
 * @property {number} num
 * @property {number} den - a fraction of one whole note (den is always a power of 2 in this module's palette, which is what keeps augmentation/diminution exact)
 */

/**
 * @typedef {object} NoteEvent
 * @property {number} degree - scale degree relative to the tonic (0 = tonic); may be negative or exceed the scale's degree count, wrapped via scaleDegreeToPitchClassAndOctaveShift
 * @property {DurationFraction} durationFrac - exact rational duration, as a fraction of a whole note
 * @property {boolean} rest - true if this is a rest (degree is meaningless when true)
 */

/**
 * @typedef {NoteEvent & {startSec:number, durSec:number}} ScheduledNoteEvent
 */

/**
 * Converts a duration fraction to seconds, given how many seconds a quarter
 * note (1/4) lasts. A whole note is 4 quarter notes.
 * @param {DurationFraction} frac
 * @param {number} secPerQuarter
 * @returns {number} seconds
 */
export function fractionToSeconds(frac, secPerQuarter) {
  const wholeNoteSec = 4 * secPerQuarter;
  return (frac.num / frac.den) * wholeNoteSec;
}

/** Named slow note-value palette, as fractions of a whole note, suited to ambient pacing (a quarter note is the shortest value used, a whole note the longest). */
export const DURATION = Object.freeze({
  WHOLE: Object.freeze(makeFraction(1, 1)),
  DOTTED_HALF: Object.freeze(makeFraction(3, 4)),
  HALF: Object.freeze(makeFraction(1, 2)),
  DOTTED_QUARTER: Object.freeze(makeFraction(3, 8)),
  QUARTER: Object.freeze(makeFraction(1, 4)),
});

const MOTIF_DURATION_CHOICES = [DURATION.QUARTER, DURATION.QUARTER, DURATION.DOTTED_QUARTER, DURATION.HALF];
const GROWTH_TOWER_DURATION_PALETTE = [DURATION.QUARTER, DURATION.DOTTED_QUARTER, DURATION.HALF, DURATION.DOTTED_HALF];
const REST_DURATION_CHOICES = [DURATION.QUARTER, DURATION.DOTTED_QUARTER];

// --- motif generation ---------------------------------------------------

/** @typedef {'OPENING'|'DEVELOPMENT'|'RETURN'} MelodySectionTag */

// OPENING holds until the regime first differs from its starting tag
// (STRICT, per flow.mjs's makeFlowState); DEVELOPMENT is any non-STRICT
// regime; RETURN is STRICT recurring. `everLeftStrict` distinguishes that
// recurrence from still being in the opening regime.
const MACRO_FORM_START_REGIME = 'STRICT';

/**
 * Creates the initial macro-form state: OPENING, nothing left yet.
 * @returns {{phase: MelodySectionTag, everLeftStrict: boolean}}
 */
export function makeMacroFormState() {
  return { phase: 'OPENING', everLeftStrict: false };
}

/**
 * Advances the macro-form state by one observed regime sample. Pure (returns
 * a new state rather than mutating), so it composes cleanly with a caller
 * that also owns other per-tick state (compose.mjs calls this once per
 * macro-tick, right alongside its own regimeTag bookkeeping) and so it can
 * be driven directly by a scripted regime sequence in tests without needing
 * a whole engine run.
 * @param {{phase: MelodySectionTag, everLeftStrict: boolean}} state
 * @param {import('./regime.mjs').RegimeTag} regimeTag - this tick's classify() result
 * @returns {{phase: MelodySectionTag, everLeftStrict: boolean}}
 */
export function advanceMacroFormPhase(state, regimeTag) {
  const everLeftStrict = state.everLeftStrict || regimeTag !== MACRO_FORM_START_REGIME;
  let phase;
  if (regimeTag !== MACRO_FORM_START_REGIME) {
    phase = 'DEVELOPMENT';
  } else if (everLeftStrict) {
    phase = 'RETURN';
  } else {
    phase = 'OPENING';
  }
  if (phase === state.phase && everLeftStrict === state.everLeftStrict) return state;
  return { phase, everLeftStrict };
}

// motif-grammar.mjs's generateSteps(rng, noteCount, bias) draws a step
// sequence from the Lambek-residuation-constrained space of sequences
// matching a [lo,hi] net-displacement range (plus an optional "must contain
// a genuine leap" requirement). OPENING/RETURN use one narrow bias; the
// DEVELOPMENT section makes a weighted draw among 4 wider biases.
const NARROW_BIAS = Object.freeze({ lo: -2, hi: 2, requireWide: false, allowWide: false });
const SECTION_GRAMMAR_BIASES = Object.freeze({
  OPENING: Object.freeze([{ bias: NARROW_BIAS, weight: 1 }]),
  RETURN: Object.freeze([{ bias: NARROW_BIAS, weight: 1 }]),
  DEVELOPMENT: Object.freeze([
    { bias: Object.freeze({ lo: -3, hi: 3, requireWide: false, allowWide: false }), weight: 2 },
    { bias: Object.freeze({ lo: -3, hi: 3, requireWide: true, allowWide: true }), weight: 2 },
    { bias: Object.freeze({ lo: 4, hi: 11, requireWide: true, allowWide: true }), weight: 3 },
    { bias: Object.freeze({ lo: -11, hi: -4, requireWide: true, allowWide: true }), weight: 2 },
  ]),
});

/**
 * Picks a grammar bias object for a given section, weighted per
 * SECTION_GRAMMAR_BIASES.
 * @param {{state:number}} rng
 * @param {MelodySectionTag} sectionTag
 * @returns {{lo:number, hi:number, requireWide:boolean}}
 */
export function pickGrammarBiasForSection(rng, sectionTag) {
  const weights = SECTION_GRAMMAR_BIASES[sectionTag] || SECTION_GRAMMAR_BIASES.DEVELOPMENT;
  const total = weights.reduce((s, w) => s + w.weight, 0);
  let r = nextRange(rng, 0, total);
  for (const w of weights) {
    if (r < w.weight) return w.bias;
    r -= w.weight;
  }
  return weights[weights.length - 1].bias;
}

/**
 * Derives a motif's rhythmic durations from the current regime's
 * growth-tower sequence (regime.mjs) instead of picking each duration
 * independently at random: successive tower values, taken mod the small
 * duration-palette length, select the palette entry for each note.
 * @param {import('./regime.mjs').RegimeTag} regimeTag
 * @param {number} length
 * @returns {DurationFraction[]}
 */
export function motifDurationsFromGrowthTower(regimeTag, length) {
  const kind = regimeGrowthKind(regimeTag);
  const seq = growthTower(kind, length);
  return seq.map((v) => GROWTH_TOWER_DURATION_PALETTE[v % GROWTH_TOWER_DURATION_PALETTE.length]);
}

/**
 * Generates a short motif: a sequence of scale-degree/duration pairs, whose
 * melodic shape is drawn from motif-grammar.mjs's Lambek-residuation-based
 * generative grammar.
 * @param {{state:number}} rng
 * @param {object} [opts]
 * @param {number} [opts.length] - note count; defaults to a random 3-5
 * @param {number} [opts.startDegree=0] - scale degree of the first note
 * @param {DurationFraction[]} [opts.durations] - explicit per-note durations (e.g. from motifDurationsFromGrowthTower); randomly chosen from MOTIF_DURATION_CHOICES per-note if omitted
 * @param {{lo:number, hi:number, requireWide:boolean}} [opts.bias] - grammar bias (see motif-grammar.mjs's generateTokenSequence); defaults to the narrow bias if omitted
 * @returns {NoteEvent[]}
 */
export function generateMotif(rng, opts = {}) {
  const length = opts.length ?? nextInt(rng, 3, 6);
  const durations = opts.durations;
  const bias = opts.bias || NARROW_BIAS;
  const steps = generateSteps(rng, length, bias);
  const notes = [];
  let degree = opts.startDegree ?? 0;
  for (let i = 0; i < length; i++) {
    if (i > 0) degree += steps[i - 1];
    const durationFrac = durations ? durations[i % durations.length] : pick(rng, MOTIF_DURATION_CHOICES);
    notes.push({ degree, durationFrac, rest: false });
  }
  return notes;
}

// --- developing-variation operators -------------------------------------

/**
 * Transposes a motif by a fixed number of scale degrees (not semitones --
 * this respects the mode's actual interval pattern, since a "step" is a
 * whole or half step depending on where in the scale it falls).
 * @param {NoteEvent[]} motif
 * @param {number} degreeShift
 * @returns {NoteEvent[]}
 */
export function transposeMotif(motif, degreeShift) {
  return motif.map((n) => (n.rest ? { ...n } : { ...n, degree: n.degree + degreeShift }));
}

/**
 * Melodic inversion: mirrors each note's scale degree around a fixed axis
 * degree (newDegree = 2*axis - degree). Applying invertMotif twice around
 * the same axis is its own inverse and recovers the original motif exactly
 * -- checked in test/melody.test.mjs.
 * @param {NoteEvent[]} motif
 * @param {number} [axisDegree] - defaults to the motif's own first note's degree
 * @returns {NoteEvent[]}
 */
export function invertMotif(motif, axisDegree) {
  const axis = axisDegree !== undefined ? axisDegree : (motif[0] ? motif[0].degree : 0);
  return motif.map((n) => (n.rest ? { ...n } : { ...n, degree: 2 * axis - n.degree }));
}

/**
 * Retrograde: reverses the note order (both pitch and rhythm run
 * backwards). retrogradeMotif(retrogradeMotif(m)) recovers the original
 * order exactly -- checked in test/melody.test.mjs.
 * @param {NoteEvent[]} motif
 * @returns {NoteEvent[]}
 */
export function retrogradeMotif(motif) {
  return motif.slice().reverse().map((n) => ({ ...n }));
}

/**
 * Rhythmic augmentation: every note's duration is multiplied by an integer
 * factor (default 2, i.e. doubled), pitches unchanged.
 * @param {NoteEvent[]} motif
 * @param {number} [factor=2]
 * @returns {NoteEvent[]}
 */
export function augmentMotif(motif, factor = 2) {
  return motif.map((n) => ({ ...n, durationFrac: multiplyFractionByInt(n.durationFrac, factor) }));
}

/**
 * Rhythmic diminution: every note's duration is divided by an integer
 * factor (default 2, i.e. halved), pitches unchanged. augmentMotif(m, k)
 * followed by diminishMotif(_, k) recovers the original durations exactly
 * -- checked in test/melody.test.mjs.
 * @param {NoteEvent[]} motif
 * @param {number} [factor=2]
 * @returns {NoteEvent[]}
 */
export function diminishMotif(motif, factor = 2) {
  return motif.map((n) => ({ ...n, durationFrac: divideFractionByInt(n.durationFrac, factor) }));
}

// --- pitch resolution -----------------------------------------------------

/**
 * Resolves a scale degree to a concrete frequency, given a base octave
 * index (an index into scale.mjs's OCTAVES, not an absolute octave number)
 * that a degree of 0 with no wrap resolves into.
 * @param {object} scale - from scale.mjs's makeScale
 * @param {number} degree
 * @param {number} [baseOctaveIndex=1] - index into OCTAVES; clamped to a valid index after applying the degree's own octave shift
 * @returns {number} Hz
 */
export function degreeToHz(scale, degree, baseOctaveIndex = 1) {
  const { pitchClass, octaveShift } = scaleDegreeToPitchClassAndOctaveShift(scale, degree);
  const octIndex = Math.max(0, Math.min(OCTAVES.length - 1, baseOctaveIndex + octaveShift));
  return scale.hzTable[pitchClass][octIndex];
}

// --- cadence selection ----------------------------------------------------

/**
 * Chooses which scale degree a phrase's closing cadence should resolve to.
 * Prefers the tonic (degree 0) if the drone bed's current chordMask is
 * actually sounding it (cover.mjs's subCheck -- the same admission
 * primitive used to gate pad-voice groupings), else the dominant (scale
 * degree 4, or the highest available degree below that in a shorter
 * pentatonic scale) if that is sounding instead, else the tonic regardless
 * -- a cadence has to resolve to *something*, and tonic is the ordinary
 * default even if the bed hasn't voiced it yet this window.
 * @param {object} scale
 * @param {number} chordMask - the drone bed's current sounding chordMask (flow.mjs's engineState.chordMask)
 * @returns {number} scale degree
 */
export function chooseCadenceDegree(scale, chordMask) {
  const tonicPc = scale.degreePitchClasses[0];
  if (subCheck(pitchClassBit(tonicPc), chordMask)) return 0;

  const dominantDegree = Math.min(4, scale.degreePitchClasses.length - 1);
  const dominantPc = scale.degreePitchClasses[dominantDegree];
  if (subCheck(pitchClassBit(dominantPc), chordMask)) return dominantDegree;

  return 0;
}

// --- phrase assembly -------------------------------------------------------

const OPERATOR_NAMES = ['original', 'transpose', 'invert', 'retrograde', 'augment'];

// Per-section transposition ranges for the 'transpose' developing-variation
// operator. OPENING/RETURN stay close to the motif's own register (small
// shifts); DEVELOPMENT is allowed to range considerably further, which is
// part of what makes its restatements feel like real development rather
// than the same shape nudged slightly.
const TRANSPOSE_CHOICES_BY_SECTION = {
  OPENING: [-2, -1, 1, 2],
  DEVELOPMENT: [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5],
  RETURN: [-2, -1, 1, 2],
};

// Per-section statement-count range: how many times the base motif (or its
// developing-variation restatements) is heard before the phrase's cadence.
// DEVELOPMENT phrases run longer/busier; OPENING/RETURN stay closer to the
// original's 2-3 statements.
const NUM_STATEMENTS_RANGE_BY_SECTION = {
  OPENING: [2, 4],
  DEVELOPMENT: [3, 6],
  RETURN: [2, 4],
};

function applyOperator(name, rng, baseMotif, sectionTag = 'DEVELOPMENT') {
  switch (name) {
    case 'transpose': {
      const choices = TRANSPOSE_CHOICES_BY_SECTION[sectionTag] || TRANSPOSE_CHOICES_BY_SECTION.DEVELOPMENT;
      return transposeMotif(baseMotif, pick(rng, choices));
    }
    case 'invert':
      return invertMotif(baseMotif, baseMotif[0] ? baseMotif[0].degree : 0);
    case 'retrograde':
      return retrogradeMotif(baseMotif);
    case 'augment':
      return augmentMotif(baseMotif, 2);
    case 'original':
    default:
      return baseMotif.map((n) => ({ ...n }));
  }
}

/**
 * Assembles one phrase: a short motif, developed across several statements
 * via the standard developing-variation operators, followed by a real
 * cadence (a resolution to a stable scale degree, held longer than the
 * surrounding material). Returns notes with absolute start/duration times
 * in seconds, ready for scheduling by compose.mjs.
 * @param {{state:number}} rng
 * @param {object} scale
 * @param {object} opts
 * @param {number} opts.startSec - absolute transport time the phrase begins at
 * @param {number} [opts.chordMask=scale.scaleMask] - drone bed's current chordMask, used only for cadence selection
 * @param {import('./regime.mjs').RegimeTag} [opts.regimeTag='STRICT'] - selects the growth-tower family used for the opening motif's rhythmic proportions
 * @param {number} [opts.secPerQuarter=1.0] - seconds per quarter-note duration unit; the whole palette scales from this
 * @param {MelodySectionTag} [opts.sectionTag='DEVELOPMENT'] - which large-scale melodic section this phrase falls in; biases motif character, transposition range, and statement count
 * @param {NoteEvent[]} [opts.thematicMotif] - if supplied, this exact motif is used as the phrase's base motif instead of generating a fresh one (true thematic return -- the RETURN section's phrases pass the piece's own OPENING-section motif here so the same material genuinely recurs, developed by the same operators as anywhere else, rather than a new motif that merely resembles it)
 * @returns {{notes:ScheduledNoteEvent[], startSec:number, endSec:number, baseMotif:NoteEvent[], sectionTag:MelodySectionTag}}
 */
export function generatePhrase(rng, scale, opts) {
  const { startSec, chordMask = scale.scaleMask, regimeTag = 'STRICT', secPerQuarter = 1.0, sectionTag = 'DEVELOPMENT', thematicMotif } = opts;

  let baseMotif;
  if (thematicMotif && thematicMotif.length > 0) {
    baseMotif = thematicMotif.map((n) => ({ ...n }));
  } else {
    const motifLength = nextInt(rng, 3, 5); // 3-4 notes
    const growthDurations = motifDurationsFromGrowthTower(regimeTag, motifLength);
    const bias = pickGrammarBiasForSection(rng, sectionTag);
    baseMotif = generateMotif(rng, { length: motifLength, durations: growthDurations, bias });
  }

  const statementsRange = NUM_STATEMENTS_RANGE_BY_SECTION[sectionTag] || NUM_STATEMENTS_RANGE_BY_SECTION.DEVELOPMENT;
  const numStatements = nextInt(rng, statementsRange[0], statementsRange[1]);
  const statements = [baseMotif];
  for (let i = 1; i < numStatements; i++) {
    statements.push(applyOperator(pick(rng, OPERATOR_NAMES), rng, baseMotif, sectionTag));
  }

  const notes = [];
  let tSec = startSec;
  for (let s = 0; s < statements.length; s++) {
    if (s > 0) {
      const restFrac = pick(rng, REST_DURATION_CHOICES);
      tSec += fractionToSeconds(restFrac, secPerQuarter);
    }
    for (const n of statements[s]) {
      const durSec = fractionToSeconds(n.durationFrac, secPerQuarter);
      notes.push({ degree: n.degree, durationFrac: n.durationFrac, rest: false, startSec: tSec, durSec });
      tSec += durSec;
    }
  }

  // Cadence: a short breath, then a single held note resolving to a stable
  // degree (tonic if the bed is sounding it, else dominant, else tonic
  // anyway), a full whole note long -- audibly longer than any note in the
  // preceding development, which is what marks it as a phrase ending rather
  // than just another motif note.
  tSec += fractionToSeconds(DURATION.QUARTER, secPerQuarter);
  const cadenceDegree = chooseCadenceDegree(scale, chordMask);
  const cadenceDurSec = fractionToSeconds(DURATION.WHOLE, secPerQuarter);
  notes.push({ degree: cadenceDegree, durationFrac: DURATION.WHOLE, rest: false, startSec: tSec, durSec: cadenceDurSec });
  tSec += cadenceDurSec;

  return { notes, startSec, endSec: tSec, baseMotif, sectionTag };
}
