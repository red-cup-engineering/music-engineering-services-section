// compose-throat.mjs
//
// A second, genre-divergent composition entry point: "The Flaming Lips meets
// Tuva throat singing," taken as a real synthesis-technique problem rather
// than a vibe. renderThroatTrack() is a sibling to compose.mjs's
// renderTrack(), not a modification of it -- compose.mjs's default
// ambient-drone behavior is untouched; this file is purely additive and
// imports only the exported, stable surface of the generative kernel
// (regime.mjs, flow.mjs, cover.mjs via flow.mjs, thermo.mjs, motif-
// grammar.mjs, melody.mjs's macro-form/phrase-timing helpers, scale.mjs) and
// the DSP core (dsp/index.mjs, including the new dsp/formant.mjs and
// dsp/saturation.mjs modules built alongside this file).
//
// The two halves of the target, taken seriously as separate engineering
// problems:
//
//   1. Tuvan throat singing (khoomei) is overtone singing: a performer holds
//      a (near-)constant low fundamental and shapes their vocal tract into a
//      sequence of resonant formant positions, each reinforcing one specific
//      harmonic already present in the fundamental's own overtone series.
//      What the ear hears sweep up and down like a melody is *which
//      overtone is emphasized*, not a changing fundamental. This is
//      implemented for real, not approximated: makeThroatVoice below builds
//      one continuously-held low-fundamental voice from a genuinely
//      harmonic-rich source (dsp/formant.mjs's makeHarmonicSourcePartials --
//      a dense partial series, unlike oscillator.mjs's pad-tuned presets,
//      which roll off too fast to leave anything for a formant filter to
//      find above roughly the 6th harmonic) run through two swept resonant
//      bandpass ("formant") filters (dsp/formant.mjs's makeFormantFilter/
//      retuneFormantFilter, built on filter.mjs's new 'bandpass' biquad
//      type). generateOvertonePhrase drives each filter's target harmonic
//      over time using the *same* Lambek-residuation motif grammar
//      (motif-grammar.mjs's generateSteps) and regime-selected rhythmic
//      proportions (melody.mjs's motifDurationsFromGrowthTower) the ambient
//      layer's melody.mjs uses for scale-degree melodies -- reinterpreted
//      here as integer deltas over harmonic index instead of scale degree,
//      which is a legitimate reuse: the grammar's step tokens were never
//      scale-degree-specific, only "well-formed sequence of small
//      integer moves" specific. dsp/formant.mjs's qForHarmonic supplies the
//      real detail that isolating a higher harmonic needs a proportionally
//      higher filter Q (bandwidth ~= centerHz/Q, and harmonic spacing
//      relative to center shrinks as 1/n going up the series).
//
//   2. The Flaming Lips' instrumental character (warm/saturated/lo-fi-lush
//      analog synth, layered swelling arrangements, audible "production"
//      rather than pristine digital cleanliness) is a much fuzzier target to
//      pin down technically than (1) -- this file's honest, best-effort
//      approximation of it is: dsp/saturation.mjs's tunable driven-tanh
//      stage on the stereo mix bus (real added harmonic content, not a
//      cosmetic label), a secondary layered pad-bed voice pool (reusing
//      flow.mjs/cover.mjs/thermo.mjs exactly as compose.mjs's own drone bed
//      does, just thinner and under the throat voice rather than the whole
//      piece) for the "layered/thick arrangement" quality, and a slow
//      sine-LFO pitch/amplitude wobble (reusing dsp/oscillator.mjs's own
//      sine-phase-accumulator pattern -- the same technique compose.mjs's
//      chorus LFO already uses -- rather than a new module) for the
//      analog-instability character. See this file's own header comment
//      further down (renderThroatTrack's jsdoc) and the calling code's
//      final report for which of these is measured-working vs. aesthetic
//      best-effort.
//
// Macro-form (regime.mjs's classify(), via flow.mjs's stepFlow, exactly as
// compose.mjs uses it) drives both the secondary pad-bed voice admission
// AND (via melody.mjs's makeMacroFormState/advanceMacroFormPhase, imported
// directly rather than reimplemented) which harmonic range and grammar bias
// the overtone-melody phrase generator draws from -- OPENING/RETURN stay in
// a narrower, lower harmonic band (closer to the fundamental, more grounded/
// "throaty"); DEVELOPMENT roams a wider band including higher, more
// whistle-like overtones. This is the same real generative-decision
// discipline the rest of this engine already holds itself to: no hand-
// authored note sequence anywhere in this file.

import { makeOscillator, advanceOscillator, PARTIAL_PRESETS } from "@red-cup-engineering/computer-audio-engineering-services-section/oscillator";
import { makeEnvelope, envelopeValueAt, triggerAttack, triggerRelease, expRamp } from "@red-cup-engineering/computer-audio-engineering-services-section/envelope";
import { makeOnePoleLowpass, processOnePole, computeBiquadCoeffs, makeBiquad, processBiquad } from "@red-cup-engineering/computer-audio-engineering-services-section/filter";
import { makeDelayLine, writeDelay, readDelayInterpolated } from "@red-cup-engineering/computer-audio-engineering-services-section/delay";
import { makeReverb, processReverbSample } from "@red-cup-engineering/computer-audio-engineering-services-section/reverb";
import { allocateStereoBuffer, mixInto, softClip, peakOf, rmsOf, hasNonFinite } from "@red-cup-engineering/computer-audio-engineering-services-section/mixer";
import { makeHarmonicSourcePartials, harmonicToHz, qForHarmonic, makeFormantFilter, retuneFormantFilter, processFormantFilter, formantMakeupGain } from "@red-cup-engineering/computer-audio-engineering-services-section/formant";
import { saturate } from "@red-cup-engineering/computer-audio-engineering-services-section/saturation";

import { makeScale, centsToRatio, pitchClassBit, octaveToIndex } from './scale.mjs';
import { classify, windowLengthMultiplier, baseCutoffHz } from './regime.mjs';
import { makeFlowState, stepFlow } from './flow.mjs';
import { computeTemperature, sampleDetuneCents, sampleFilterJitterHz, sampleOnsetJitterMs } from './thermo.mjs';
import { makeRng, nextFloat, nextRange, nextInt, pick } from './random.mjs';
import { generateSteps } from './motif-grammar.mjs';
import { makeMacroFormState, advanceMacroFormPhase, motifDurationsFromGrowthTower, pickGrammarBiasForSection, fractionToSeconds } from './melody.mjs';

// --- macro-form / voice-pool tuning ----------------------------------------

const BASE_WINDOW_SEC = 14; // slightly longer than compose.mjs's 12s -- throat/overtone material reads better unhurried
const OUTRO_FRACTION = 0.15;
const BASE_INJECT_PROB = 0.1;
const RISING_INJECT_PROB = 0.025;
// Secondary pad-bed layer -- deliberately thinner than compose.mjs's 6 (the
// throat voice is the piece's focal point, the pad bed is support), but NOT
// so thin that it structurally breaks regime.mjs's own classifier: classify()
// treats activeVoiceCount<=4 as "finiteBase" (part of what STRICT requires),
// so a maxVoices at or below 4 would pin activeVoiceCount there permanently
// and guarantee STRICT forever, regardless of anything else happening in the
// piece -- discovered by rendering at maxVoices=3 first and observing zero
// regime transitions and a macro-form that never left OPENING over a full
// 420s piece. 5 keeps the pad bed thinner than compose.mjs's default while
// leaving real room for activeVoiceCount to cross the finiteBase threshold,
// which is what lets DEVELOPMENT/RETURN actually get exercised.
const MAX_DRONE_VOICES = 5;
const K_HEIGHT = 3;

// --- secondary pad-bed voice (the "layered/thick arrangement" support layer) --

const DRONE_VOICE_GAIN = 0.13;
const DRONE_PAN_DEPTH = 0.6;
const DETUNE_SMOOTHER_HZ = 1.0;
const FILTER_Q = 0.707;

function clampCutoffHz(hz, sampleRate) {
  return Math.max(80, Math.min(sampleRate / 2 - 200, hz));
}

function retuneBiquad(biquadState, coeffs) {
  biquadState.b0 = coeffs.b0;
  biquadState.b1 = coeffs.b1;
  biquadState.b2 = coeffs.b2;
  biquadState.a1 = coeffs.a1;
  biquadState.a2 = coeffs.a2;
}

function makeDroneVoice(regEntry, scale, sampleRate, cutoffHz, attackAtSec, rng) {
  const baseHz = scale.hzTable[regEntry.pitchClass][octaveToIndex(regEntry.octave)];
  const attackSec = Math.max(3, nextRange(rng, 4, 8));
  const releaseSec = Math.max(3, nextRange(rng, 4, 8));
  const coeffs = computeBiquadCoeffs({ type: 'lowpass', cutoffHz: clampCutoffHz(cutoffHz, sampleRate), Q: FILTER_Q, sampleRate });
  const partials = pick(rng, [PARTIAL_PRESETS.warmPad, PARTIAL_PRESETS.organLike]);

  const voice = {
    voiceId: regEntry.voiceId,
    baseHz,
    oscillator: makeOscillator({ freqHz: baseHz, sampleRate, waveform: 'additive', partials }),
    envelope: makeEnvelope({ attackSec, releaseSec, sustainLevel: nextRange(rng, 0.5, 0.75), curve: 5 }),
    biquad: makeBiquad(coeffs),
    detuneSmoother: makeOnePoleLowpass(DETUNE_SMOOTHER_HZ, sampleRate),
    targetDetuneCents: 0,
    filterJitterHz: 0,
    panPhase: nextFloat(rng),
    panPeriodSec: nextRange(rng, 35, 100),
    gain: DRONE_VOICE_GAIN,
    retiring: false,
  };
  triggerAttack(voice.envelope, attackAtSec);
  return voice;
}

// --- the throat/overtone voice ---------------------------------------------
//
// One continuously-held low fundamental (never retriggered -- the whole
// point of the technique is that the fundamental drone stays fixed while
// the *emphasis* moves) plus two swept formant filters. F1 is the primary
// overtone-melody filter; F2 sits a generated offset above F1, giving the
// two-resonance "vowel"-like character real two-formant khoomei styles
// (e.g. sygyt) have, rather than a single isolated sine-like whistle.

const THROAT_SOURCE_PARTIAL_COUNT = 22;
const THROAT_SOURCE_ROLLOFF = 0.85;
const THROAT_ATTACK_SEC = 6;
const THROAT_RELEASE_SEC = 8;
const THROAT_SUSTAIN_LEVEL = 0.85;
const THROAT_GAIN = 0.55;
const THROAT_PAN_DEPTH = 0.12; // deliberately narrow -- the throat voice is the piece's vocal-like focal point, kept close to center
const THROAT_PAN_PERIOD_SEC = 41;
const THROAT_RAW_BLEND = 0.12; // a little unfiltered source blended under the formant emphasis, for low-end body under the swept overtone

const F1_GAIN = 0.64;
const F2_GAIN = 0.36;
const F2_OFFSET_RANGE = [3, 8]; // F2 sits this many harmonics above F1
const MIN_HARMONIC = 3;
const MAX_HARMONIC = 22;
const RETUNE_EPSILON_HZ = 0.25; // only recompute a formant's biquad coefficients when its target has actually moved this much -- most samples are mid-hold, not mid-glide

function clampHarmonic(h) {
  return Math.max(MIN_HARMONIC, Math.min(MAX_HARMONIC, Math.round(h)));
}

function makeThroatVoice({ fundamentalHz, sampleRate, initialH1, initialH2 }) {
  const partials = makeHarmonicSourcePartials({ count: THROAT_SOURCE_PARTIAL_COUNT, rolloffExponent: THROAT_SOURCE_ROLLOFF });
  return {
    fundamentalHz,
    oscillator: makeOscillator({ freqHz: fundamentalHz, sampleRate, waveform: 'additive', partials }),
    envelope: makeEnvelope({ attackSec: THROAT_ATTACK_SEC, releaseSec: THROAT_RELEASE_SEC, sustainLevel: THROAT_SUSTAIN_LEVEL, curve: 4 }),
    f1: makeFormantFilter({ centerHz: harmonicToHz(fundamentalHz, initialH1), Q: qForHarmonic(initialH1), sampleRate }),
    f2: makeFormantFilter({ centerHz: harmonicToHz(fundamentalHz, initialH2), Q: qForHarmonic(initialH2), sampleRate }),
    f1FromRatio: initialH1,
    f1TargetRatio: initialH1,
    f1GlideStartSec: 0,
    f1GlideDurSec: 0,
    f1LastTunedHz: harmonicToHz(fundamentalHz, initialH1),
    f1MakeupGain: formantMakeupGain(partials, initialH1),
    f2FromRatio: initialH2,
    f2TargetRatio: initialH2,
    f2GlideStartSec: 0,
    f2GlideDurSec: 0,
    f2LastTunedHz: harmonicToHz(fundamentalHz, initialH2),
    f2MakeupGain: formantMakeupGain(partials, initialH2),
    detuneSmoother: makeOnePoleLowpass(DETUNE_SMOOTHER_HZ, sampleRate),
    targetDetuneCents: 0,
  };
}

/**
 * Schedules a new overtone-melody note onto the throat voice: captures
 * wherever each formant's ratio actually is right now (which may be
 * mid-glide from the previous note -- this is what keeps back-to-back notes
 * from clicking/jumping discontinuously) as the new glide's starting point.
 */
function scheduleThroatNote(voice, note) {
  voice.f1FromRatio = currentFormantRatio(voice, 'f1', note.startSec);
  voice.f1TargetRatio = note.h1;
  voice.f1GlideStartSec = note.startSec;
  voice.f1GlideDurSec = note.glideSec;

  voice.f2FromRatio = currentFormantRatio(voice, 'f2', note.startSec);
  voice.f2TargetRatio = note.h2;
  voice.f2GlideStartSec = note.startSec;
  voice.f2GlideDurSec = note.glideSec;
}

function currentFormantRatio(voice, which, tSec) {
  const from = voice[`${which}FromRatio`];
  const to = voice[`${which}TargetRatio`];
  const start = voice[`${which}GlideStartSec`];
  const dur = voice[`${which}GlideDurSec`];
  if (dur <= 0) return to;
  const frac = (tSec - start) / dur;
  if (frac >= 1) return to;
  if (frac <= 0) return from;
  return expRamp(from, to, frac);
}

/**
 * Advances the throat voice by exactly one sample: the harmonic-rich source
 * oscillator, both formant filters (re-tuned only when their swept target
 * has moved enough to matter -- RETUNE_EPSILON_HZ -- since most samples are
 * mid-hold between notes, not mid-glide), mixed and shaped by the voice's
 * own envelope.
 * @param {object} voice
 * @param {number} sampleTimeSec
 * @param {number} sampleRate
 * @param {number} [wobbleCents=0] - this sample's slow pitch-wobble LFO offset (continuous, not smoothed -- it's already a slow sine, so it doesn't need the one-pole smoother the per-window thermo jitter target does), added on top of the smoothed thermo-jitter detune
 * @returns {number} mono sample
 */
function advanceThroatVoice(voice, sampleTimeSec, sampleRate, wobbleCents = 0) {
  const smoothedCents = processOnePole(voice.detuneSmoother, voice.targetDetuneCents);
  const freq = voice.fundamentalHz * centsToRatio(smoothedCents + wobbleCents);
  const raw = advanceOscillator(voice.oscillator, freq);

  const elapsed = sampleTimeSec - voice.envelope.stageStartTime;
  const level = envelopeValueAt(voice.envelope, elapsed);

  const f1Ratio = currentFormantRatio(voice, 'f1', sampleTimeSec);
  const f2Ratio = currentFormantRatio(voice, 'f2', sampleTimeSec);
  const f1Hz = harmonicToHz(voice.fundamentalHz, f1Ratio);
  const f2Hz = harmonicToHz(voice.fundamentalHz, f2Ratio);

  if (Math.abs(f1Hz - voice.f1LastTunedHz) > RETUNE_EPSILON_HZ) {
    retuneFormantFilter(voice.f1, { centerHz: f1Hz, Q: qForHarmonic(f1Ratio), sampleRate });
    voice.f1LastTunedHz = f1Hz;
    voice.f1MakeupGain = formantMakeupGain(voice.oscillator.partials, f1Ratio);
  }
  if (Math.abs(f2Hz - voice.f2LastTunedHz) > RETUNE_EPSILON_HZ) {
    retuneFormantFilter(voice.f2, { centerHz: f2Hz, Q: qForHarmonic(f2Ratio), sampleRate });
    voice.f2LastTunedHz = f2Hz;
    voice.f2MakeupGain = formantMakeupGain(voice.oscillator.partials, f2Ratio);
  }

  // formantMakeupGain corrects a real normalization fact (see its own
  // header comment in dsp/formant.mjs): additiveSample divides by the sum
  // of every partial's amplitude, so an isolated single harmonic is only a
  // small, harmonic-dependent fraction of that -- without this, sweeping
  // toward higher (lower-amplitude) target harmonics would get quieter
  // purely as a side effect of the source's own normalization, not as a
  // deliberate musical choice.
  const filtered1 = processFormantFilter(voice.f1, raw) * voice.f1MakeupGain;
  const filtered2 = processFormantFilter(voice.f2, raw) * voice.f2MakeupGain;
  const formantMix = filtered1 * F1_GAIN + filtered2 * F2_GAIN;
  const blended = formantMix * (1 - THROAT_RAW_BLEND) + raw * THROAT_RAW_BLEND;

  return blended * level;
}

// --- overtone-melody phrase generation --------------------------------------
//
// The direct analogue of melody.mjs's generatePhrase, but the "pitch"
// dimension is harmonic index (which overtone of the fixed fundamental is
// emphasized) instead of scale degree. Reuses the same real mechanisms
// melody.mjs's phrases use: motif-grammar.mjs's generateSteps (the Lambek-
// residuation-constrained grammar) for the step sequence, melody.mjs's
// motifDurationsFromGrowthTower (regime-selected growth-tower rhythmic
// proportions) for timing, and melody.mjs's pickGrammarBiasForSection for
// which bias a given macro-form section draws from -- three real,
// already-tested generative mechanisms, applied to a different target
// dimension rather than reimplemented.

const F1_HARMONIC_RANGE_BY_SECTION = {
  OPENING: [5, 9],
  RETURN: [5, 9],
  DEVELOPMENT: [4, 16],
};
const OVERTONE_SEC_PER_UNIT = 1.3; // seconds per growth-tower rhythmic unit -- slower than melody.mjs's 1.0s default, since overtone-emphasis transitions read best unhurried
const NOTE_GLIDE_SEC_RANGE = [0.12, 0.4];
const OVERTONE_NOTE_COUNT_RANGE = [4, 8];

function generateOvertonePhrase(rng, { startSec, regimeTag, sectionTag }) {
  const noteCount = nextInt(rng, OVERTONE_NOTE_COUNT_RANGE[0], OVERTONE_NOTE_COUNT_RANGE[1] + 1);
  const bias = pickGrammarBiasForSection(rng, sectionTag);
  const steps = generateSteps(rng, noteCount, bias); // noteCount-1 integer deltas over harmonic index
  const durations = motifDurationsFromGrowthTower(regimeTag, noteCount);
  const [lo, hi] = F1_HARMONIC_RANGE_BY_SECTION[sectionTag] || F1_HARMONIC_RANGE_BY_SECTION.DEVELOPMENT;
  let h1 = nextInt(rng, lo, hi + 1);
  const f2Offset = nextInt(rng, F2_OFFSET_RANGE[0], F2_OFFSET_RANGE[1] + 1);

  const notes = [];
  let tSec = startSec;
  for (let i = 0; i < noteCount; i++) {
    if (i > 0) h1 = clampHarmonic(h1 + steps[i - 1]);
    const durSec = fractionToSeconds(durations[i], OVERTONE_SEC_PER_UNIT);
    const h2 = clampHarmonic(h1 + f2Offset);
    const glideSec = nextRange(rng, NOTE_GLIDE_SEC_RANGE[0], NOTE_GLIDE_SEC_RANGE[1]);
    notes.push({ startSec: tSec, durSec, h1, h2, glideSec, sectionTag });
    tSec += durSec;
  }
  return { notes, startSec, endSec: tSec };
}

const OVERTONE_PHRASE_GAP_SEC_RANGE = [1.5, 4];
const OVERTONE_MIN_TRAILING_SILENCE_SEC = 20;

// --- analog character: saturation + wobble ---------------------------------

const SATURATION_DRIVE = 1.6;
const SATURATION_MIX = 0.55;
const SATURATION_ASYMMETRY = 0.05;

// Slow sine-LFO pitch/amplitude wobble -- reuses the exact phase-accumulator
// pattern compose.mjs's own chorus LFO uses (a plain incrementing phase,
// wrapped into [0,1), fed through sin()), not a new mechanism, applied here
// to (a) the throat voice's fundamental for an analog-tape-like slow pitch
// drift and (b) the whole mix bus's level for a slow "breathing" swell --
// both read as the un-pristine, alive-feeling instability the brief asks
// for, distinct from thermo.mjs's per-window stochastic jitter (which is
// still used too, for the same humanization role it plays in compose.mjs).
const WOBBLE_PITCH_LFO_HZ = 0.09;
const WOBBLE_PITCH_DEPTH_CENTS = 5;
const WOBBLE_AMP_LFO_HZ = 0.13;
const WOBBLE_AMP_DEPTH = 0.05;

// --- chorus + reverb (reusing compose.mjs's own techniques, reimplemented
// here rather than imported since compose.mjs doesn't export them as
// standalone functions) ------------------------------------------------------

const CHORUS_BASE_MS = 18;
const CHORUS_DEPTH_MS = 8;
const CHORUS_WET = 0.28;
const CHORUS_PERIOD_SEC = 9;

const END_DECLICK_SEC = 0.03;

/**
 * Renders a complete stereo "Flaming Lips meets Tuva throat singing" track:
 * a continuously-held low fundamental drone run through two swept resonant
 * formant filters (the real overtone-singing synthesis mechanism -- see
 * this file's header comment), driven as a genuine generative overtone
 * melody by the same motif-grammar/regime-growth-tower/macro-form machinery
 * melody.mjs's diatonic phrases use, layered with a thinner secondary
 * pad-bed voice pool (flow.mjs/cover.mjs/thermo.mjs, same admission kernel
 * compose.mjs's drone bed uses) for arrangement thickness, and finished
 * with a tunable analog-saturation stage plus a slow pitch/amplitude wobble
 * for the psych-rock production character.
 *
 * Which part of this is *measured* to work versus best-effort aesthetic
 * approximation: the formant-sweep mechanism is measured directly (see
 * test/formant.test.mjs and scripts/render-throat-track.mjs's own
 * verification step, which runs the same Goertzel-power measurement against
 * this function's actual rendered output, not just a synthetic test tone).
 * The "Flaming Lips" instrumental character is not a technically
 * falsifiable target the way a bandpass filter's passband is -- saturation,
 * layering, and wobble are real, working DSP mechanisms, but whether their
 * combination actually reads as "Flaming Lips" is a judgment call, not a
 * measurement, and is reported honestly as such rather than dressed up as
 * verified.
 *
 * @param {object} opts
 * @param {number} opts.durationSec
 * @param {number} [opts.sampleRate=44100]
 * @param {number|string|{state:number}} [opts.seed]
 * @param {'dorian'|'aeolian'|'majorPentatonic'|'minorPentatonic'|{cardinality:number, rotation?:number}} [opts.mode='dorian']
 * @param {string} [opts.root='D']
 * @param {number} [opts.saturationDrive=1.6]
 * @param {number} [opts.saturationMix=0.55]
 * @returns {{sampleRate:number, numChannels:number, left:Float32Array, right:Float32Array, durationSec:number, peak:number, rms:number, regimeTransitions:number, finalRegime:string, overtoneNoteOnsets:number, overtoneUniqueH1:number, overtoneNoteLog:Array<{startSec:number, durSec:number, glideSec:number, h1:number, h2:number, sectionTag:string, fundamentalHz:number}>, macroFormLog:Array<{tSec:number, phase:string, regimeTag:string}>, fundamentalHz:number}}
 */
export function renderThroatTrack({
  durationSec,
  sampleRate = 44100,
  seed,
  mode = 'dorian',
  root = 'D',
  saturationDrive = SATURATION_DRIVE,
  saturationMix = SATURATION_MIX,
} = {}) {
  if (!(durationSec > 0)) throw new Error('durationSec must be a positive number');

  const rng = seed && typeof seed === 'object' && typeof seed.state === 'number' ? seed : makeRng(seed !== undefined ? seed : Date.now());

  const scale = makeScale({ root, mode });
  const fundamentalHz = scale.hzTable[scale.rootPitchClass][0]; // lowest octave in scale.mjs's OCTAVES -- a grounded, low drone register

  const totalSamples = Math.round(durationSec * sampleRate);
  const { left: busL, right: busR } = allocateStereoBuffer(totalSamples);

  const engineState = makeFlowState({
    initialCutoffHz: baseCutoffHz('STRICT'),
    initialChordMask: pitchClassBit(scale.rootPitchClass),
  });

  const reverb = makeReverb({ sampleRate, decaySec: 3.4, dampingHz: 4200, stereoSpread: 0.8, wetMix: 0.3 });
  const chorusL = makeDelayLine(Math.ceil(((CHORUS_BASE_MS + CHORUS_DEPTH_MS + 2) / 1000) * sampleRate) + 4);
  const chorusR = makeDelayLine(Math.ceil(((CHORUS_BASE_MS + CHORUS_DEPTH_MS + 2) / 1000) * sampleRate) + 4);
  let chorusLfoPhase = 0;
  const chorusLfoIncrement = 1 / (CHORUS_PERIOD_SEC * sampleRate);
  let wobblePitchPhase = nextFloat(rng);
  let wobbleAmpPhase = nextFloat(rng);
  const wobblePitchIncrement = WOBBLE_PITCH_LFO_HZ / sampleRate;
  const wobbleAmpIncrement = WOBBLE_AMP_LFO_HZ / sampleRate;

  /** @type {Map<string, object>} */
  const droneVoices = new Map();

  // Macro-form, driven directly by the regime sequence (melody.mjs's own
  // machinery, reused rather than reimplemented -- see this file's header
  // comment).
  let macroFormState = makeMacroFormState();
  /** @type {Array<{tSec:number, phase:string, regimeTag:string}>} */
  const macroFormLog = [{ tSec: 0, phase: macroFormState.phase, regimeTag: engineState.regimeTag }];

  // The overtone-melody phrase queue (mirrors compose.mjs's melodyQueue
  // pattern): generated one phrase ahead, notes popped off as their
  // scheduled startSec arrives.
  /** @type {Array<{startSec:number, durSec:number, h1:number, h2:number, glideSec:number, sectionTag:string}>} */
  let overtoneQueue = [];
  let lastOvertonePhraseEndSec = 0;

  // Seed the very first phrase before the render loop starts, so the throat
  // voice's formant filters can be initialized at real starting targets
  // (rather than an arbitrary default) with no discontinuity at t=0.
  const firstPhrase = generateOvertonePhrase(rng, { startSec: 0, regimeTag: engineState.regimeTag, sectionTag: macroFormState.phase });
  overtoneQueue = firstPhrase.notes.slice();
  lastOvertonePhraseEndSec = firstPhrase.endSec;
  const firstNote = overtoneQueue[0];

  const throatVoice = makeThroatVoice({ fundamentalHz, sampleRate, initialH1: firstNote.h1, initialH2: firstNote.h2 });
  triggerAttack(throatVoice.envelope, 0);
  const throatReleaseAtSec = Math.max(0, durationSec - THROAT_RELEASE_SEC - 1);
  let throatReleaseTriggered = false;

  let overtoneNoteOnsets = 0;
  const overtoneH1Set = new Set();
  /** @type {Array<{startSec:number, durSec:number, h1:number, h2:number, sectionTag:string, fundamentalHz:number}>} */
  const overtoneNoteLog = [];

  let transportSampleIndex = 0;
  let previousCutoffHz = engineState.filterCutoffHz;
  let regimeTransitions = 0;
  let previousRegimeTag = engineState.regimeTag;

  while (transportSampleIndex < totalSamples) {
    const transportTimeSec = transportSampleIndex / sampleRate;

    const regimeTag = classify({
      activeVoiceCount: engineState.activeVoiceIds.length,
      emaFilterDelta: engineState.emaFilterDelta,
      directFilterDelta: engineState.directFilterDelta,
      ticksSinceLastReset: engineState.ticksSinceLastReset,
    });
    if (regimeTag !== previousRegimeTag) {
      regimeTransitions += 1;
      previousRegimeTag = regimeTag;
    }
    engineState.regimeTag = regimeTag;
    if (process.env.DEBUG_THROAT) {
      console.error(`t=${transportTimeSec.toFixed(1)} regime=${regimeTag} activeVoices=${engineState.activeVoiceIds.length} chordMask=${engineState.chordMask.toString(2)} ticksSinceLastReset=${engineState.ticksSinceLastReset}`);
    }
    const previousMacroFormPhase = macroFormState.phase;
    macroFormState = advanceMacroFormPhase(macroFormState, regimeTag);
    if (macroFormState.phase !== previousMacroFormPhase) {
      macroFormLog.push({ tSec: transportTimeSec, phase: macroFormState.phase, regimeTag });
    }

    const windowSec = BASE_WINDOW_SEC * windowLengthMultiplier(regimeTag);
    const targetCutoffHz = baseCutoffHz(regimeTag);

    const inOutro = transportTimeSec >= durationSec * (1 - OUTRO_FRACTION);
    const base = inOutro ? 0 : BASE_INJECT_PROB;
    const rising = inOutro ? 0 : RISING_INJECT_PROB;

    const tickResult = stepFlow(engineState, rng, scale, {
      base,
      rising,
      kHeight: K_HEIGHT,
      maxVoices: MAX_DRONE_VOICES,
      tickTime: transportTimeSec,
      targetCutoffHz,
    });

    const directFilterDelta = Math.abs(engineState.filterCutoffHz - previousCutoffHz);
    engineState.emaFilterDelta = engineState.emaFilterDelta * 0.8 + directFilterDelta * 0.2;
    engineState.directFilterDelta = directFilterDelta;
    previousCutoffHz = engineState.filterCutoffHz;

    const totalVoiceEvents = Math.max(1, engineState.activeVoiceIds.length);
    const temperature = computeTemperature(tickResult.addedVoices.length, totalVoiceEvents);

    // Refresh jitter targets for every currently-sounding drone voice and
    // for the throat voice's own fundamental (a small, slow amount --
    // enough to feel alive, far short of enough to blur which harmonic the
    // formant sweep is targeting).
    for (const voice of droneVoices.values()) {
      if (voice.retiring) continue;
      voice.targetDetuneCents = sampleDetuneCents(rng, temperature);
      voice.filterJitterHz = sampleFilterJitterHz(rng, temperature);
      const coeffs = computeBiquadCoeffs({
        type: 'lowpass',
        cutoffHz: clampCutoffHz(engineState.filterCutoffHz + voice.filterJitterHz, sampleRate),
        Q: FILTER_Q,
        sampleRate,
      });
      retuneBiquad(voice.biquad, coeffs);
    }
    throatVoice.targetDetuneCents = sampleDetuneCents(rng, temperature * 0.4);

    for (const added of tickResult.addedVoices) {
      const regEntry = engineState.voiceRegistry.find((v) => v.voiceId === added.voiceId) || added;
      const onsetJitterSec = Math.max(0, sampleOnsetJitterMs(rng, temperature) / 1000);
      const attackAtSec = transportTimeSec + Math.min(onsetJitterSec, windowSec * 0.25);
      const voice = makeDroneVoice(regEntry, scale, sampleRate, engineState.filterCutoffHz + sampleFilterJitterHz(rng, temperature), attackAtSec, rng);
      droneVoices.set(voice.voiceId, voice);
    }

    for (const dropped of tickResult.droppedVoices) {
      const voice = droneVoices.get(dropped.voiceId);
      if (voice && !voice.retiring) {
        triggerRelease(voice.envelope, transportTimeSec);
        voice.retiring = true;
      }
    }

    // Overtone-melody phrase scheduling: queue up the next generated phrase
    // once the current one has fully played out, unless close enough to the
    // end of the track that a new phrase wouldn't finish -- mirrors
    // compose.mjs's melody-layer scheduling discipline exactly.
    if (overtoneQueue.length === 0 && transportTimeSec < durationSec - OVERTONE_MIN_TRAILING_SILENCE_SEC) {
      const gapSec = nextRange(rng, OVERTONE_PHRASE_GAP_SEC_RANGE[0], OVERTONE_PHRASE_GAP_SEC_RANGE[1]);
      const phraseStartSec = Math.max(transportTimeSec, lastOvertonePhraseEndSec + gapSec);
      const phrase = generateOvertonePhrase(rng, { startSec: phraseStartSec, regimeTag: engineState.regimeTag, sectionTag: macroFormState.phase });
      overtoneQueue = overtoneQueue.concat(phrase.notes);
      lastOvertonePhraseEndSec = phrase.endSec;
    }

    const windowSamples = Math.min(Math.round(windowSec * sampleRate), totalSamples - transportSampleIndex);

    for (let si = 0; si < windowSamples; si++) {
      const sampleTimeSec = transportTimeSec + si / sampleRate;
      const busIndex = transportSampleIndex + si;

      // Trigger any overtone notes whose scheduled onset has arrived
      // (sample-accurate, like compose.mjs's melody-note scheduling).
      while (overtoneQueue.length > 0 && overtoneQueue[0].startSec <= sampleTimeSec) {
        const note = overtoneQueue.shift();
        scheduleThroatNote(throatVoice, note);
        overtoneNoteOnsets += 1;
        overtoneH1Set.add(note.h1);
        overtoneNoteLog.push({ startSec: note.startSec, durSec: note.durSec, glideSec: note.glideSec, h1: note.h1, h2: note.h2, sectionTag: note.sectionTag, fundamentalHz });
      }

      if (!throatReleaseTriggered && sampleTimeSec >= throatReleaseAtSec) {
        triggerRelease(throatVoice.envelope, sampleTimeSec);
        throatReleaseTriggered = true;
      }

      let l = 0;
      let r = 0;

      // Slow pitch-wobble LFO (analog-instability character), advanced here
      // (before the throat voice reads it) so it's this sample's actual
      // value, not last sample's.
      wobblePitchPhase += wobblePitchIncrement;
      if (wobblePitchPhase >= 1) wobblePitchPhase -= Math.floor(wobblePitchPhase);
      const wobbleCents = Math.sin(2 * Math.PI * wobblePitchPhase) * WOBBLE_PITCH_DEPTH_CENTS;

      // Throat voice: the piece's focal point, kept close to center.
      const throatSample = advanceThroatVoice(throatVoice, sampleTimeSec, sampleRate, wobbleCents);
      const throatPan = Math.sin(2 * Math.PI * (sampleTimeSec / THROAT_PAN_PERIOD_SEC)) * THROAT_PAN_DEPTH;
      ({ left: l, right: r } = mixInto(l, r, throatSample, THROAT_GAIN, throatPan));

      // Secondary pad-bed voices: arrangement thickness under the throat voice.
      for (const voice of droneVoices.values()) {
        const smoothedCents = processOnePole(voice.detuneSmoother, voice.targetDetuneCents);
        const freq = voice.baseHz * centsToRatio(smoothedCents);
        const raw = advanceOscillator(voice.oscillator, freq);

        const elapsed = sampleTimeSec - voice.envelope.stageStartTime;
        const level = envelopeValueAt(voice.envelope, elapsed);
        const filtered = processBiquad(voice.biquad, raw * level);

        const pan = Math.sin(2 * Math.PI * (sampleTimeSec / voice.panPeriodSec + voice.panPhase)) * DRONE_PAN_DEPTH;
        ({ left: l, right: r } = mixInto(l, r, filtered, voice.gain, pan));
      }

      // Chorus (same modulated-delay technique compose.mjs's bus uses).
      chorusLfoPhase += chorusLfoIncrement;
      if (chorusLfoPhase >= 1) chorusLfoPhase -= Math.floor(chorusLfoPhase);
      const delaySamplesL = ((CHORUS_BASE_MS + CHORUS_DEPTH_MS * Math.sin(2 * Math.PI * chorusLfoPhase)) / 1000) * sampleRate;
      const delaySamplesR = ((CHORUS_BASE_MS + CHORUS_DEPTH_MS * Math.sin(2 * Math.PI * chorusLfoPhase + Math.PI / 2)) / 1000) * sampleRate;
      const chorusWetL = readDelayInterpolated(chorusL, delaySamplesL);
      const chorusWetR = readDelayInterpolated(chorusR, delaySamplesR);
      writeDelay(chorusL, l);
      writeDelay(chorusR, r);
      l = l * (1 - CHORUS_WET) + chorusWetL * CHORUS_WET;
      r = r * (1 - CHORUS_WET) + chorusWetR * CHORUS_WET;

      // Slow amplitude wobble ("breathing") -- analog-instability character.
      // (Pitch wobble was already advanced and applied above, before the
      // throat voice read it.)
      wobbleAmpPhase += wobbleAmpIncrement;
      if (wobbleAmpPhase >= 1) wobbleAmpPhase -= Math.floor(wobbleAmpPhase);
      const ampWobble = 1 + Math.sin(2 * Math.PI * wobbleAmpPhase) * WOBBLE_AMP_DEPTH;
      l *= ampWobble;
      r *= ampWobble;

      // Analog saturation stage: real, tunable driven-tanh warmth.
      l = saturate(l, { drive: saturationDrive, asymmetryBias: SATURATION_ASYMMETRY, mix: saturationMix });
      r = saturate(r, { drive: saturationDrive, asymmetryBias: -SATURATION_ASYMMETRY, mix: saturationMix });

      const { outL, outR } = processReverbSample(reverb, l, r);

      busL[busIndex] = softClip(outL);
      busR[busIndex] = softClip(outR);
    }

    transportSampleIndex += windowSamples;
    const windowEndSec = transportSampleIndex / sampleRate;

    for (const [voiceId, voice] of droneVoices) {
      if (voice.retiring) {
        const elapsed = windowEndSec - voice.envelope.stageStartTime;
        if (elapsed >= voice.envelope.releaseSec) {
          droneVoices.delete(voiceId);
        }
      }
    }
  }

  const declickSamples = Math.min(totalSamples, Math.round(END_DECLICK_SEC * sampleRate));
  for (let i = 0; i < declickSamples; i++) {
    const idx = totalSamples - declickSamples + i;
    const g = i / declickSamples;
    busL[idx] *= g;
    busR[idx] *= g;
  }

  if (hasNonFinite(busL, busR)) {
    throw new Error('renderThroatTrack produced non-finite samples -- this indicates a DSP bug, not a valid render.');
  }

  return {
    sampleRate,
    numChannels: 2,
    left: Float32Array.from(busL),
    right: Float32Array.from(busR),
    durationSec,
    peak: peakOf(busL, busR),
    rms: rmsOf(busL, busR),
    regimeTransitions,
    finalRegime: engineState.regimeTag,
    overtoneNoteOnsets,
    overtoneUniqueH1: overtoneH1Set.size,
    overtoneNoteLog,
    macroFormLog,
    fundamentalHz,
  };
}
