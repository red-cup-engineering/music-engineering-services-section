// melody.test.mjs
//
// The developing-variation operators (transposeMotif/invertMotif/
// retrogradeMotif/augmentMotif/diminishMotif) are standard, well-defined
// compositional operations with checkable algebraic identities:
// retrograde-of-retrograde recovers the original, inversion around a fixed
// axis is its own inverse, and augmentation followed by the matching
// diminution recovers the original durations exactly (not approximately --
// the whole point of representing durations as exact rationals). These
// tests check those identities directly, plus phrase assembly, pitch
// resolution, the regime-driven macro-form state machine, and the
// grammar-based motif-shape vocabulary's real variety (see also
// test/motif-grammar.test.mjs for the grammar's own, lower-level tests).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  makeFraction,
  multiplyFractionByInt,
  divideFractionByInt,
  fractionToSeconds,
  DURATION,
  generateMotif,
  transposeMotif,
  invertMotif,
  retrogradeMotif,
  augmentMotif,
  diminishMotif,
  degreeToHz,
  chooseCadenceDegree,
  generatePhrase,
  motifDurationsFromGrowthTower,
  makeMacroFormState,
  advanceMacroFormPhase,
  pickGrammarBiasForSection,
} from '../src/generative/melody.mjs';
import { makeScale, pitchClassBit } from '../src/generative/scale.mjs';
import { makeRng, pick } from '../src/generative/random.mjs';

function sampleMotif(rng) {
  // A motif with some negative degrees too, to exercise wrap-around.
  return generateMotif(rng, { length: 5, startDegree: -2 });
}

test('retrogradeMotif(retrogradeMotif(m)) recovers the original motif exactly', () => {
  const rng = makeRng(1);
  const motif = sampleMotif(rng);
  const roundTrip = retrogradeMotif(retrogradeMotif(motif));
  assert.deepEqual(roundTrip, motif);
});

test('retrogradeMotif actually reverses note order (not a no-op)', () => {
  const rng = makeRng(2);
  const motif = sampleMotif(rng);
  const reversed = retrogradeMotif(motif);
  assert.deepEqual(reversed.map((n) => n.degree), motif.map((n) => n.degree).slice().reverse());
});

test('invertMotif is its own inverse when applied twice around the same axis', () => {
  const rng = makeRng(3);
  const motif = sampleMotif(rng);
  for (const axis of [0, 2, -1, 5]) {
    const roundTrip = invertMotif(invertMotif(motif, axis), axis);
    assert.deepEqual(roundTrip.map((n) => n.degree), motif.map((n) => n.degree));
  }
});

test('invertMotif actually mirrors around the axis (not a no-op)', () => {
  const motif = [
    { degree: 0, durationFrac: DURATION.QUARTER, rest: false },
    { degree: 2, durationFrac: DURATION.QUARTER, rest: false },
    { degree: -1, durationFrac: DURATION.QUARTER, rest: false },
  ];
  const inverted = invertMotif(motif, 0);
  assert.deepEqual(inverted.map((n) => n.degree), [0, -2, 1]);
});

test('transposeMotif shifts every note by the same number of scale degrees', () => {
  const rng = makeRng(4);
  const motif = sampleMotif(rng);
  const shifted = transposeMotif(motif, 3);
  assert.deepEqual(shifted.map((n) => n.degree), motif.map((n) => n.degree + 3));
  // Durations are untouched by transposition.
  assert.deepEqual(shifted.map((n) => n.durationFrac), motif.map((n) => n.durationFrac));
});

test('augmentMotif followed by the matching diminishMotif recovers the original durations exactly (exact rational, not approximate)', () => {
  const rng = makeRng(5);
  const motif = sampleMotif(rng);
  for (const factor of [2, 3, 4]) {
    const roundTrip = diminishMotif(augmentMotif(motif, factor), factor);
    for (let i = 0; i < motif.length; i++) {
      assert.equal(roundTrip[i].durationFrac.num, motif[i].durationFrac.num, `factor=${factor} note=${i} num`);
      assert.equal(roundTrip[i].durationFrac.den, motif[i].durationFrac.den, `factor=${factor} note=${i} den`);
    }
  }
});

test('augmentMotif exactly doubles durations (rational, checked as exact fractions)', () => {
  const motif = [{ degree: 0, durationFrac: DURATION.DOTTED_QUARTER, rest: false }];
  const augmented = augmentMotif(motif, 2);
  // DOTTED_QUARTER = 3/8 of a whole note; doubled = 3/4 = DOTTED_HALF.
  assert.deepEqual(augmented[0].durationFrac, makeFraction(3, 4));
  assert.deepEqual(augmented[0].durationFrac, DURATION.DOTTED_HALF);
});

test('multiplyFractionByInt / divideFractionByInt reduce to lowest terms', () => {
  const f = makeFraction(2, 4); // should already reduce to 1/2
  assert.deepEqual(f, { num: 1, den: 2 });
  assert.deepEqual(multiplyFractionByInt(makeFraction(1, 4), 2), { num: 1, den: 2 });
  assert.deepEqual(divideFractionByInt(makeFraction(1, 2), 2), { num: 1, den: 4 });
});

test('fractionToSeconds gives real rhythmic proportion: half is exactly 2x quarter, whole is exactly 4x quarter', () => {
  const secPerQuarter = 1.25;
  const quarterSec = fractionToSeconds(DURATION.QUARTER, secPerQuarter);
  const halfSec = fractionToSeconds(DURATION.HALF, secPerQuarter);
  const wholeSec = fractionToSeconds(DURATION.WHOLE, secPerQuarter);
  assert.equal(quarterSec, secPerQuarter);
  assert.equal(halfSec, 2 * quarterSec);
  assert.equal(wholeSec, 4 * quarterSec);
});

test('degreeToHz resolves scale degrees to ascending pitch with no octave-wrap discontinuities', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });
  // Degrees -3..3 around the tonic should be strictly ascending in Hz --
  // this is the regression check for the octave-shift bug where a scale
  // degree whose raw pitch-class number wraps past 0 (e.g. C relative to a
  // D root) was previously placed a full octave too low.
  const hzs = [];
  for (let d = -3; d <= 3; d++) hzs.push(degreeToHz(scale, d, 2));
  for (let i = 1; i < hzs.length; i++) {
    assert.ok(hzs[i] > hzs[i - 1], `degree ${i - 4} -> ${i - 3} should ascend in Hz (${hzs[i - 1]} -> ${hzs[i]})`);
  }
});

test('degreeToHz: one full scale cycle (degree 0 vs degree = scale length) is exactly one octave apart', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' }); // 7 degrees
  const tonicHz = degreeToHz(scale, 0, 1);
  const octaveUpHz = degreeToHz(scale, 7, 1);
  assert.ok(Math.abs(octaveUpHz / tonicHz - 2) < 1e-9, `expected exactly one octave (2x), got ratio ${octaveUpHz / tonicHz}`);
});

test('chooseCadenceDegree prefers the tonic when the chordMask sounds it', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });
  const chordMask = pitchClassBit(scale.rootPitchClass);
  assert.equal(chooseCadenceDegree(scale, chordMask), 0);
});

test('chooseCadenceDegree falls back to the dominant when the tonic is not sounding but the dominant is', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });
  const dominantDegree = Math.min(4, scale.degreePitchClasses.length - 1);
  const dominantPc = scale.degreePitchClasses[dominantDegree];
  const chordMask = pitchClassBit(dominantPc); // tonic bit not set
  assert.equal(chooseCadenceDegree(scale, chordMask), dominantDegree);
});

test('chooseCadenceDegree falls back to the tonic when neither tonic nor dominant is sounding', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });
  // Pick some other scale degree's pitch class, not tonic or dominant.
  const otherPc = scale.degreePitchClasses[2];
  const chordMask = pitchClassBit(otherPc);
  assert.equal(chooseCadenceDegree(scale, chordMask), 0);
});

test('motifDurationsFromGrowthTower returns one duration per requested note, drawn from the palette', () => {
  const durations = motifDurationsFromGrowthTower('STRICT', 5);
  assert.equal(durations.length, 5);
  const paletteValues = new Set([DURATION.QUARTER, DURATION.DOTTED_QUARTER, DURATION.HALF, DURATION.DOTTED_HALF]);
  for (const d of durations) assert.ok(paletteValues.has(d));
});

test('generatePhrase produces a phrase with real cadence, non-decreasing schedule, and non-trivial duration', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });
  const rng = makeRng(561);
  const phrase = generatePhrase(rng, scale, { startSec: 10, chordMask: scale.scaleMask, regimeTag: 'STRICT', secPerQuarter: 1.0 });

  assert.ok(phrase.notes.length >= 3, 'a phrase should contain more than a single motif note');
  assert.equal(phrase.notes[0].startSec, 10, 'phrase should begin at the requested startSec');
  assert.ok(phrase.endSec > phrase.startSec);

  // Notes must be scheduled in non-decreasing time order with no overlap.
  for (let i = 1; i < phrase.notes.length; i++) {
    assert.ok(phrase.notes[i].startSec >= phrase.notes[i - 1].startSec + phrase.notes[i - 1].durSec - 1e-9, `note ${i} overlaps note ${i - 1}`);
  }

  // Cadence: the last note is held longer than the average of the
  // preceding notes -- a real "this is the end" gesture, not just a stop.
  const last = phrase.notes[phrase.notes.length - 1];
  const precedingDurs = phrase.notes.slice(0, -1).map((n) => n.durSec);
  const avgPreceding = precedingDurs.reduce((a, b) => a + b, 0) / precedingDurs.length;
  assert.ok(last.durSec > avgPreceding, 'cadence note should be longer than the phrase average');
  assert.deepEqual(last.durationFrac, DURATION.WHOLE);

  // Phrase length should land in the ambient-pacing target range. Upper
  // bound widened from the old system's 45s: the grammar's DEVELOPMENT
  // biases can produce wider net-displacement motifs than the old 4-shape
  // enum did, so a long run of statements (up to 6, per
  // NUM_STATEMENTS_RANGE_BY_SECTION) legitimately runs a bit longer on
  // occasion -- this is real variety, not a runaway bug (checked directly
  // above via the note-by-note non-overlap assertion).
  const phraseLenSec = phrase.endSec - phrase.startSec;
  assert.ok(phraseLenSec >= 10 && phraseLenSec <= 60, `phrase length ${phraseLenSec}s outside expected range`);

  // Not a monotone drone: the phrase should visit more than one distinct
  // pitch and more than one distinct duration.
  const distinctDegrees = new Set(phrase.notes.map((n) => n.degree));
  const distinctDurations = new Set(phrase.notes.map((n) => `${n.durationFrac.num}/${n.durationFrac.den}`));
  assert.ok(distinctDegrees.size > 1, 'phrase should have melodic contour, not a single repeated pitch');
  assert.ok(distinctDurations.size > 1, 'phrase should have rhythmic variety, not one repeated duration');
});

test('generatePhrase is deterministic given the same rng seed', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });
  const phraseA = generatePhrase(makeRng(42), scale, { startSec: 0, chordMask: scale.scaleMask, regimeTag: 'STRICT' });
  const phraseB = generatePhrase(makeRng(42), scale, { startSec: 0, chordMask: scale.scaleMask, regimeTag: 'STRICT' });
  assert.deepEqual(phraseA, phraseB);
});

// --- macro-form: regime-driven, not clock-driven -------------------------

test('makeMacroFormState starts in OPENING', () => {
  assert.equal(makeMacroFormState().phase, 'OPENING');
});

test('advanceMacroFormPhase: stays OPENING while regime stays STRICT, moves to DEVELOPMENT on the first non-STRICT regime, and only reaches RETURN once STRICT recurs after that', () => {
  let state = makeMacroFormState();
  state = advanceMacroFormPhase(state, 'STRICT');
  assert.equal(state.phase, 'OPENING');
  state = advanceMacroFormPhase(state, 'STRICT');
  assert.equal(state.phase, 'OPENING');

  state = advanceMacroFormPhase(state, 'SCOTT');
  assert.equal(state.phase, 'DEVELOPMENT');
  state = advanceMacroFormPhase(state, 'TRANSFINITE_BOUNDED');
  assert.equal(state.phase, 'DEVELOPMENT');
  state = advanceMacroFormPhase(state, 'APERIODIC');
  assert.equal(state.phase, 'DEVELOPMENT');

  // Regime settles back into STRICT: this is now a genuine return, not the
  // opening, because the piece has left STRICT at least once already.
  state = advanceMacroFormPhase(state, 'STRICT');
  assert.equal(state.phase, 'RETURN');

  // Leaving STRICT again goes back to DEVELOPMENT (not OPENING -- OPENING
  // is a one-time-only phase, checked separately below), and STRICT
  // recurring again is RETURN again: a real rondo-like structure driven by
  // the actual regime sequence, not a single one-shot arc.
  state = advanceMacroFormPhase(state, 'SCOTT');
  assert.equal(state.phase, 'DEVELOPMENT');
  state = advanceMacroFormPhase(state, 'STRICT');
  assert.equal(state.phase, 'RETURN');
});

test('advanceMacroFormPhase: OPENING never recurs once the regime has left STRICT, across many scripted regime sequences', () => {
  const regimes = ['STRICT', 'SCOTT', 'TRANSFINITE_BOUNDED', 'APERIODIC'];
  const rng = makeRng(561);
  let state = makeMacroFormState();
  let sawNonOpening = false;
  for (let i = 0; i < 500; i++) {
    const regimeTag = pick(rng, regimes);
    state = advanceMacroFormPhase(state, regimeTag);
    if (state.phase !== 'OPENING') sawNonOpening = true;
    if (sawNonOpening) assert.notEqual(state.phase, 'OPENING', `iteration ${i}: OPENING recurred after leaving it (regime=${regimeTag})`);
  }
});

test('advanceMacroFormPhase: section boundaries track regime transitions exactly, not any fixed tick count or fraction', () => {
  // A short opening run of STRICT, then a long run of a non-STRICT regime,
  // then STRICT again -- the phase transition must land exactly where the
  // regime changes, regardless of how many ticks each run takes.
  for (const openingTicks of [1, 5, 50]) {
    for (const developmentTicks of [1, 3, 40]) {
      let state = makeMacroFormState();
      for (let i = 0; i < openingTicks; i++) {
        state = advanceMacroFormPhase(state, 'STRICT');
        assert.equal(state.phase, 'OPENING', `openingTicks=${openingTicks} tick=${i}`);
      }
      for (let i = 0; i < developmentTicks; i++) {
        state = advanceMacroFormPhase(state, 'SCOTT');
        assert.equal(state.phase, 'DEVELOPMENT', `developmentTicks=${developmentTicks} tick=${i}`);
      }
      state = advanceMacroFormPhase(state, 'STRICT');
      assert.equal(state.phase, 'RETURN', `openingTicks=${openingTicks} developmentTicks=${developmentTicks}`);
    }
  }
});

// --- motif-shape vocabulary: grammar-based, not a 4-entry enum -----------

test('pickGrammarBiasForSection: OPENING and RETURN only ever pick the narrow (no-leap-required) bias, across many draws', () => {
  const rng = makeRng(561);
  for (let i = 0; i < 200; i++) {
    const bias = pickGrammarBiasForSection(rng, 'OPENING');
    assert.equal(bias.requireWide, false, 'OPENING should never require a leap');
    assert.ok(bias.hi - bias.lo <= 4, 'OPENING bias should stay narrow');
  }
  for (let i = 0; i < 200; i++) {
    const bias = pickGrammarBiasForSection(rng, 'RETURN');
    assert.equal(bias.requireWide, false, 'RETURN should never require a leap');
  }
});

test('pickGrammarBiasForSection: DEVELOPMENT draws leap-requiring biases across many draws (not just the narrow one)', () => {
  const rng = makeRng(561);
  let sawWideRequired = false;
  for (let i = 0; i < 200; i++) {
    const bias = pickGrammarBiasForSection(rng, 'DEVELOPMENT');
    if (bias.requireWide) sawWideRequired = true;
  }
  assert.ok(sawWideRequired, 'expected DEVELOPMENT to draw at least one leap-requiring bias in 200 tries');
});

test('generateMotif with a wide-requiring bias always contains a genuine leap (>=4 scale degrees); the narrow bias never does', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const rng = makeRng(seed * 97 + 3);
    const motif = generateMotif(rng, { length: 5, startDegree: 0, bias: { lo: 4, hi: 11, requireWide: true } });
    const intervals = [];
    for (let i = 1; i < motif.length; i++) intervals.push(Math.abs(motif[i].degree - motif[i - 1].degree));
    assert.ok(intervals.some((iv) => iv >= 4), `seed ${seed}: expected a leap >=4 in a wide-required motif, got ${intervals}`);
  }
  for (let seed = 1; seed <= 30; seed++) {
    const rng = makeRng(seed * 131 + 7);
    const motif = generateMotif(rng, { length: 5, startDegree: 0, bias: { lo: -2, hi: 2, requireWide: false, allowWide: false } });
    for (let i = 1; i < motif.length; i++) {
      const iv = Math.abs(motif[i].degree - motif[i - 1].degree);
      assert.ok(iv <= 3, `seed ${seed}: narrow-bias motif produced interval ${iv}, expected <=3`);
    }
  }
});

test('grammar variety: many motifs drawn with DEVELOPMENT-style biases produce far more than 4 distinct interval-sequence shapes', () => {
  const rng = makeRng(9001);
  const shapes = new Set();
  const N = 400;
  for (let i = 0; i < N; i++) {
    const bias = pickGrammarBiasForSection(rng, 'DEVELOPMENT');
    const motif = generateMotif(rng, { length: 5, startDegree: 0, bias });
    const intervals = [];
    for (let j = 1; j < motif.length; j++) intervals.push(motif[j].degree - motif[j - 1].degree);
    shapes.add(intervals.join(','));
  }
  // The old system had exactly 4 named shapes to draw from; this checks the
  // new one is not quietly clustering into a similarly small number of
  // buckets despite having a combinatorially larger nominal space.
  assert.ok(shapes.size > 50, `expected >50 distinct interval-sequence shapes across ${N} draws, got ${shapes.size}`);
});

test('generatePhrase: a RETURN-section phrase given an explicit thematicMotif reuses that exact motif as its base (true thematic return), not a freshly generated one', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });
  const thematicMotif = [
    { degree: 0, durationFrac: DURATION.QUARTER, rest: false },
    { degree: 2, durationFrac: DURATION.HALF, rest: false },
    { degree: -1, durationFrac: DURATION.QUARTER, rest: false },
  ];
  const phrase = generatePhrase(makeRng(9001), scale, {
    startSec: 0,
    chordMask: scale.scaleMask,
    regimeTag: 'STRICT',
    sectionTag: 'RETURN',
    thematicMotif,
  });
  assert.deepEqual(phrase.baseMotif, thematicMotif);
  // The phrase's very first notes (before any developing-variation
  // restatement) must literally be the thematic motif's degrees in order.
  assert.deepEqual(phrase.notes.slice(0, thematicMotif.length).map((n) => n.degree), thematicMotif.map((n) => n.degree));
});

test('generatePhrase: sectionTag is carried through to the returned phrase', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });
  for (const sectionTag of ['OPENING', 'DEVELOPMENT', 'RETURN']) {
    const phrase = generatePhrase(makeRng(561), scale, { startSec: 0, chordMask: scale.scaleMask, regimeTag: 'STRICT', sectionTag });
    assert.equal(phrase.sectionTag, sectionTag);
  }
});

test('large-scale-form claim, checked with real numbers: DEVELOPMENT-section phrases have a wider average melodic interval than OPENING-section phrases, averaged over many phrases/seeds', () => {
  const scale = makeScale({ root: 'D', mode: 'dorian' });

  function meanAbsIntervalForSection(sectionTag, seedCount) {
    let totalInterval = 0;
    let count = 0;
    for (let seed = 1; seed <= seedCount; seed++) {
      const phrase = generatePhrase(makeRng(seed * 331 + 17), scale, {
        startSec: 0,
        chordMask: scale.scaleMask,
        regimeTag: 'STRICT',
        sectionTag,
      });
      for (let i = 1; i < phrase.notes.length; i++) {
        totalInterval += Math.abs(phrase.notes[i].degree - phrase.notes[i - 1].degree);
        count++;
      }
    }
    return totalInterval / count;
  }

  const openingMean = meanAbsIntervalForSection('OPENING', 60);
  const developmentMean = meanAbsIntervalForSection('DEVELOPMENT', 60);
  assert.ok(
    developmentMean > openingMean,
    `expected DEVELOPMENT mean interval (${developmentMean.toFixed(3)}) > OPENING mean interval (${openingMean.toFixed(3)})`
  );
  // Not just numerically larger -- meaningfully so, given DEVELOPMENT's
  // leap-requiring biases are supposed to be a real, audible difference
  // rather than a rounding-noise one.
  assert.ok(developmentMean > openingMean * 1.15, `expected a meaningfully wider DEVELOPMENT mean interval, got opening=${openingMean.toFixed(3)} development=${developmentMean.toFixed(3)}`);
});
