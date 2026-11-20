// compose.mjs
//
// Top-level orchestrator for the generative ambient engine. renderTrack()
// is the single entry point: given a duration and a seed/PRNG, it runs the
// driven-closure-flow macro-tick loop (flow.mjs) for the whole duration,
// and for every audio sample advances each currently-sounding voice's
// oscillator/envelope/filter (dsp/oscillator.mjs, dsp/envelope.mjs,
// dsp/filter.mjs), mixes it into the stereo bus with a slow pan LFO
// (dsp/mixer.mjs) plus a chorus effect (dsp/delay.mjs), sends the bus
// through a shared reverb (dsp/reverb.mjs), and soft-clips for safety
// (dsp/mixer.mjs) before returning the finished stereo buffer.
//
// Structural mapping, traceable module-by-module:
//   regime.mjs  -> macro-form: pad-bed section length + growth-tower onset
//                  pacing, AND (via melody.mjs's advanceMacroFormPhase,
//                  driven by the same regimeTag every tick) the melodic
//                  layer's OPENING/DEVELOPMENT/RETURN large-scale phase --
//                  one real classifier now drives both, not a classifier
//                  plus a separate clock-percentage schedule.
//   flow.mjs    -> the driven macro-tick loop itself (development/outro arc)
//   cover.mjs   -> which pitch classes are legitimately allowed to sound
//   thermo.mjs  -> jitter amount + register-spread self-balancing
//   scale.mjs   -> the always-diatonic pitch material, generated from
//                  maximal-evenness first principles rather than a 4-entry
//                  named-mode table
//   motif-grammar.mjs / lambek.mjs -> the melodic layer's motif-shape
//                  vocabulary, a real generative grammar over step-tokens
//                  rather than a 4-entry named-character table
//
// No I/O happens in this module beyond returning plain typed-array buffers;
// see render-cli.mjs (or dsp/wav-writer.mjs directly) for writing a file.

import { makeOscillator, advanceOscillator, PARTIAL_PRESETS } from "@red-cup-engineering/computer-audio-engineering-services-section/oscillator";
import { makeEnvelope, envelopeValueAt, triggerAttack, triggerRelease } from "@red-cup-engineering/computer-audio-engineering-services-section/envelope";
import { makeOnePoleLowpass, processOnePole, computeBiquadCoeffs, makeBiquad, processBiquad } from "@red-cup-engineering/computer-audio-engineering-services-section/filter";
import { makeDelayLine, writeDelay, readDelayInterpolated } from "@red-cup-engineering/computer-audio-engineering-services-section/delay";
import { makeReverb, processReverbSample, REVERB_PRESETS } from "@red-cup-engineering/computer-audio-engineering-services-section/reverb";
import { allocateStereoBuffer, mixInto, softClip, peakOf, rmsOf, hasNonFinite } from "@red-cup-engineering/computer-audio-engineering-services-section/mixer";

import { makeScale, centsToRatio, pitchClassBit, octaveToIndex } from './scale.mjs';
import { classify, windowLengthMultiplier, baseCutoffHz } from './regime.mjs';
import { makeFlowState, stepFlow } from './flow.mjs';
import { computeTemperature, sampleDetuneCents, sampleFilterJitterHz, sampleOnsetJitterMs } from './thermo.mjs';
import { makeRng, nextFloat, nextRange, pick } from './random.mjs';
import { generatePhrase, degreeToHz, makeMacroFormState, advanceMacroFormPhase } from './melody.mjs';

const BASE_WINDOW_SEC = 12;
const OUTRO_FRACTION = 0.2; // last 20% of the track: injection probability drops to 0
const BASE_INJECT_PROB = 0.15;
const RISING_INJECT_PROB = 0.03;
const MAX_VOICES = 6;
const K_HEIGHT = 3;

const VOICE_GAIN = 0.16;
const PAN_DEPTH = 0.65;
const DETUNE_SMOOTHER_HZ = 1.0; // control-rate one-pole cutoff for detune smoothing
const FILTER_Q = 0.707;
const CHORUS_BASE_MS = 15;
const CHORUS_DEPTH_MS = 6;
const CHORUS_WET = 0.22;
const CHORUS_PERIOD_SEC = 7.5;
const END_DECLICK_SEC = 0.03; // purely technical anti-click safeguard at the hard buffer boundary
const VOICE_ACTIVITY_SAMPLE_SEC = 0.5; // sampling interval for voiceActivityLog's self-verification instrumentation

// Melodic foreground layer (melody.mjs). Kept as a separate voice pool from
// the drone/pad renderVoices map -- it uses a distinctly faster envelope
// (audible discrete onsets, still no percussive transient) and sits above
// the pad register so it reads as a foreground line, not another pad.
const MELODY_PARTIALS = PARTIAL_PRESETS.glassy; // fallback default/thinner-more-present preset, used if a scheduled note somehow carries no section-derived partialsName
const MELODY_VOICE_GAIN = 0.22;
const MELODY_ATTACK_SEC = 0.12;
const MELODY_RELEASE_SEC = 0.6;
const MELODY_SUSTAIN_MIN = 0.6;
const MELODY_SUSTAIN_MAX = 0.85;
const MELODY_FILTER_Q = 0.707;
const MELODY_CUTOFF_BOOST_HZ = 900; // brighter than the pad bed's regime cutoff so the line cuts through
const MELODY_BASE_OCTAVE_INDEX = 2; // fallback default (top of scale.mjs's OCTAVES) if a scheduled note carries no section-derived octaveIndex
const MELODY_PAN_DEPTH = 0.25; // more centered than the pad bed's PAN_DEPTH -- a foreground line, not another wide pad
const MELODY_PAN_PERIOD_SEC = 23;
const MELODY_SEC_PER_QUARTER = 1.0;
const MELODY_PHRASE_GAP_SEC_MIN = 4;
const MELODY_PHRASE_GAP_SEC_MAX = 9;
const MELODY_MIN_TRAILING_SILENCE_SEC = 18; // stop starting new phrases once this close to the end, mirroring the pad bed's own outro logic

// Register/timbre profile per large-scale melodic section (melody.mjs's
// macro-form phase, regime-driven via advanceMacroFormPhase -- see this
// file's header comment). This is compose.mjs's call, not melody.mjs's: the
// motif/interval/shape choices are melody.mjs's job (pure scale-degree
// space), but which octave index and which additive-partial preset a note
// actually sounds with is a DSP-facing decision, same division of labor as
// everywhere else this module reuses melody.mjs's output.
//
// OPENING and RETURN share the same mid register and the same thin/glassy
// timbre -- deliberately, so RETURN reads as a genuine return of *register
// and timbre*, not just of pitch material. DEVELOPMENT is allowed to roam:
// each new DEVELOPMENT phrase independently rolls an octave (mid or top)
// and a timbre preset (glassy/organLike/warmPad), so the middle of the
// piece keeps offering the ear something new to track across its whole
// length, not just one alternate preset for the entire middle third.
const MELODY_OPENING_OCTAVE_INDEX = 1; // mid register -- narrower/lower than the single fixed top register the first pass used throughout
const MELODY_RETURN_OCTAVE_INDEX = 1;
const MELODY_OPENING_PARTIALS_NAME = 'glassy';
const MELODY_RETURN_PARTIALS_NAME = 'glassy';
const MELODY_DEVELOPMENT_OCTAVE_INDICES = [1, 2];
const MELODY_DEVELOPMENT_PARTIALS_NAMES = ['glassy', 'organLike', 'warmPad'];

/**
 * Picks the register (an index into scale.mjs's OCTAVES) and additive-
 * partial timbre preset name a new melodic phrase should use, given its
 * large-scale section tag. `profiles`, when supplied, overrides this
 * module's own default register/timbre choices per section -- an additive
 * hook (defaults to this file's original OPENING/RETURN/DEVELOPMENT
 * constants when omitted, so existing callers are unaffected) that lets a
 * caller retarget the melodic layer's register/timbre without editing this
 * function's body, e.g. for a sparser/differently-timbred render mode.
 * @param {import('./melody.mjs').MelodySectionTag} sectionTag
 * @param {{state:number}} rng
 * @param {{OPENING?:{octaveIndex?:number,partialsName?:string}, RETURN?:{octaveIndex?:number,partialsName?:string}, DEVELOPMENT?:{octaveIndices?:number[],partialsNames?:string[]}}} [profiles]
 * @returns {{octaveIndex:number, partialsName:string}}
 */
function melodyVoiceProfileForSection(sectionTag, rng, profiles) {
  const p = profiles || {};
  if (sectionTag === 'OPENING') {
    const cfg = p.OPENING || {};
    return { octaveIndex: cfg.octaveIndex ?? MELODY_OPENING_OCTAVE_INDEX, partialsName: cfg.partialsName ?? MELODY_OPENING_PARTIALS_NAME };
  }
  if (sectionTag === 'RETURN') {
    const cfg = p.RETURN || {};
    return { octaveIndex: cfg.octaveIndex ?? MELODY_RETURN_OCTAVE_INDEX, partialsName: cfg.partialsName ?? MELODY_RETURN_PARTIALS_NAME };
  }
  const cfg = p.DEVELOPMENT || {};
  const octaveIndices = cfg.octaveIndices ?? MELODY_DEVELOPMENT_OCTAVE_INDICES;
  const partialsNames = cfg.partialsNames ?? MELODY_DEVELOPMENT_PARTIALS_NAMES;
  return {
    octaveIndex: pick(rng, octaveIndices),
    partialsName: pick(rng, partialsNames),
  };
}

/**
 * Re-tunes a biquad filter's coefficients in place (b0/b1/b2/a1/a2) while
 * preserving its x1/x2/y1/y2 sample history, so recomputing a voice's
 * cutoff once per window (from the regime's target cutoff plus this
 * window's thermo-driven jitter) never introduces a filter-state
 * discontinuity the way rebuilding the whole biquad state object would.
 * @param {object} biquadState
 * @param {{b0:number,b1:number,b2:number,a1:number,a2:number}} coeffs
 */
function retuneBiquad(biquadState, coeffs) {
  biquadState.b0 = coeffs.b0;
  biquadState.b1 = coeffs.b1;
  biquadState.b2 = coeffs.b2;
  biquadState.a1 = coeffs.a1;
  biquadState.a2 = coeffs.a2;
}

function clampCutoffHz(hz, sampleRate) {
  return Math.max(80, Math.min(sampleRate / 2 - 200, hz));
}

/**
 * Builds a fresh render voice (the full DSP-facing state) for a newly
 * admitted cover.mjs voice registry entry.
 * @param {object} regEntry - {voiceId, pitchClass, octave, ...} from cover.mjs
 * @param {object} scale
 * @param {number} sampleRate
 * @param {number} cutoffHz
 * @param {number} attackAtSec
 * @param {{state:number}} rng
 * @param {Array<{ratio:number,amp:number}>} [padPartials=PARTIAL_PRESETS.warmPad] - additive-partial series for the pad bed's oscillator; defaults to this file's original hardcoded warmPad preset so omitting it changes nothing
 * @returns {object} render voice
 */
function makeRenderVoice(regEntry, scale, sampleRate, cutoffHz, attackAtSec, rng, padPartials = PARTIAL_PRESETS.warmPad) {
  const baseHz = scale.hzTable[regEntry.pitchClass][octaveToIndex(regEntry.octave)];
  const attackSec = Math.max(2, nextRange(rng, 3, 6));
  const releaseSec = Math.max(2, nextRange(rng, 3, 6));
  const coeffs = computeBiquadCoeffs({ type: 'lowpass', cutoffHz: clampCutoffHz(cutoffHz, sampleRate), Q: FILTER_Q, sampleRate });

  const voice = {
    voiceId: regEntry.voiceId,
    pitchClass: regEntry.pitchClass,
    octave: regEntry.octave,
    baseHz,
    oscillator: makeOscillator({ freqHz: baseHz, sampleRate, waveform: 'additive', partials: padPartials }),
    envelope: makeEnvelope({ attackSec, releaseSec, sustainLevel: nextRange(rng, 0.55, 0.85), curve: 5 }),
    biquad: makeBiquad(coeffs),
    detuneSmoother: makeOnePoleLowpass(DETUNE_SMOOTHER_HZ, sampleRate),
    targetDetuneCents: 0,
    filterJitterHz: 0,
    panPhase: nextFloat(rng),
    panPeriodSec: nextRange(rng, 30, 90),
    gain: VOICE_GAIN,
    retiring: false,
  };
  triggerAttack(voice.envelope, attackAtSec);
  return voice;
}

/**
 * Builds a fresh render voice for one scheduled melodic note (melody.mjs's
 * ScheduledNoteEvent, extended by compose.mjs with an octaveIndex/
 * partialsName section profile before being queued -- see
 * melodyVoiceProfileForSection). Deliberately a smaller, simpler object than
 * makeRenderVoice's pad voices -- no detune smoother/jitter (the melodic
 * line is meant to read as a clean, present foreground pitch, not a
 * softly-breathing pad) -- but it reuses the exact same oscillator/
 * envelope/biquad DSP primitives.
 * @param {import('./melody.mjs').ScheduledNoteEvent & {octaveIndex?:number, partialsName?:string}} noteEvent
 * @param {object} scale
 * @param {number} sampleRate
 * @param {number} cutoffHz
 * @param {{state:number}} rng
 * @param {string} voiceId
 * @returns {object} render voice
 */
function makeMelodyVoice(noteEvent, scale, sampleRate, cutoffHz, rng, voiceId) {
  const octaveIndex = noteEvent.octaveIndex !== undefined ? noteEvent.octaveIndex : MELODY_BASE_OCTAVE_INDEX;
  const partials = (noteEvent.partialsName && PARTIAL_PRESETS[noteEvent.partialsName]) || MELODY_PARTIALS;
  const baseHz = degreeToHz(scale, noteEvent.degree, octaveIndex);
  const coeffs = computeBiquadCoeffs({ type: 'lowpass', cutoffHz: clampCutoffHz(cutoffHz, sampleRate), Q: MELODY_FILTER_Q, sampleRate });
  // The release is scheduled to finish by (roughly) the note's own written
  // duration: attack, then sustain, then release timed so the audible decay
  // lands near noteEvent.startSec + noteEvent.durSec, not stacked on top of
  // the next note's onset.
  const releaseAtSec = noteEvent.startSec + Math.max(noteEvent.durSec - MELODY_RELEASE_SEC, MELODY_ATTACK_SEC);

  const voice = {
    voiceId,
    degree: noteEvent.degree,
    baseHz,
    oscillator: makeOscillator({ freqHz: baseHz, sampleRate, waveform: 'additive', partials }),
    envelope: makeEnvelope({ attackSec: MELODY_ATTACK_SEC, releaseSec: MELODY_RELEASE_SEC, sustainLevel: nextRange(rng, MELODY_SUSTAIN_MIN, MELODY_SUSTAIN_MAX), curve: 4 }),
    biquad: makeBiquad(coeffs),
    releaseAtSec,
    panPhase: nextFloat(rng),
    gain: MELODY_VOICE_GAIN,
    retiring: false,
  };
  triggerAttack(voice.envelope, noteEvent.startSec);
  return voice;
}

/**
 * Renders a complete stereo ambient track.
 * @param {object} opts
 * @param {number} opts.durationSec - track length in seconds
 * @param {number} [opts.sampleRate=44100]
 * @param {number|string|{state:number}} [opts.seed] - integer/string seed, or an existing rng object from random.mjs's makeRng
 * @param {'dorian'|'aeolian'|'majorPentatonic'|'minorPentatonic'} [opts.mode='dorian']
 * @param {string} [opts.root='D']
 * @param {'deepAmbient'|'hall'|'chamber'} [opts.reverbPreset='deepAmbient']
 * @param {boolean} [opts.melody=true] - whether to layer the foreground melodic/motivic line (melody.mjs) over the drone/pad bed
 * @param {number} [opts.maxVoices=6] - polyphony budget passed straight through to cover.mjs's resolveCover (via flow.mjs's stepFlow); lower values are the real lever for a genuinely sparser pad bed (fewer simultaneous drone voices), not a post-hoc volume/mix trick
 * @param {number} [opts.baseInjectProb=0.15] - base per-macro-tick probability of injecting a new pitch class into the pad bed's chordMask (flow.mjs); lower values mean new pad voices are admitted far less often, which is what actually produces long stretches of held/settled material and real silence between gestures, not just "fewer notes" applied after the fact
 * @param {number} [opts.risingInjectProb=0.03] - per-tick-since-last-firing rise added to baseInjectProb (flow.mjs); also lowerable for sparser pacing
 * @param {number} [opts.melodyPhraseGapSecMin=4] - minimum silent gap (seconds) between melodic phrases
 * @param {number} [opts.melodyPhraseGapSecMax=9] - maximum silent gap (seconds) between melodic phrases; widening this pair is the real lever for long melodic silences, not a post-render fade
 * @param {number} [opts.melodyMinTrailingSilenceSec=18] - stop starting new melodic phrases once this close to the end of the track
 * @param {string} [opts.padPartialsName='warmPad'] - key into dsp/oscillator.mjs's PARTIAL_PRESETS used for the pad bed's oscillator timbre
 * @param {{OPENING?:{octaveIndex?:number,partialsName?:string}, RETURN?:{octaveIndex?:number,partialsName?:string}, DEVELOPMENT?:{octaveIndices?:number[],partialsNames?:string[]}}} [opts.melodySectionProfiles] - per-section register/timbre overrides for the melodic layer; defaults to this module's original OPENING/RETURN/DEVELOPMENT constants when omitted (see melodyVoiceProfileForSection)
 * @returns {{sampleRate:number, numChannels:number, left:Float32Array, right:Float32Array, durationSec:number, peak:number, rms:number, spiralCount:number, regimeTransitions:number, finalRegime:string, melodyNoteOnsets:number, melodyUniqueDegrees:number, melodyUniqueDurationsSec:number, melodyOnsetLog:Array<{startSec:number, degree:number, sectionTag:string, octaveIndex:number, partialsName:string}>, motifShapeLog:Array<{startSec:number, sectionTag:string, intervals:number[]}>, macroFormLog:Array<{tSec:number, phase:string, regimeTag:string}>, voiceActivityLog:Array<{tSec:number, padVoices:number, melodyVoices:number, totalVoices:number}>, voiceActivitySummary:{sampleCount:number, sampleIntervalSec:number, meanTotalVoices:number, fractionSilent:number, fractionSingleVoiceOrFewer:number}|null}}
 */
export function renderTrack({
  durationSec,
  sampleRate = 44100,
  seed,
  mode = 'dorian',
  root = 'D',
  reverbPreset = 'deepAmbient',
  melody = true,
  maxVoices = MAX_VOICES,
  baseInjectProb = BASE_INJECT_PROB,
  risingInjectProb = RISING_INJECT_PROB,
  melodyPhraseGapSecMin = MELODY_PHRASE_GAP_SEC_MIN,
  melodyPhraseGapSecMax = MELODY_PHRASE_GAP_SEC_MAX,
  melodyMinTrailingSilenceSec = MELODY_MIN_TRAILING_SILENCE_SEC,
  padPartialsName = 'warmPad',
  melodySectionProfiles,
} = {}) {
  if (!(durationSec > 0)) throw new Error('durationSec must be a positive number');
  const padPartials = PARTIAL_PRESETS[padPartialsName] || PARTIAL_PRESETS.warmPad;

  const rng = seed && typeof seed === 'object' && typeof seed.state === 'number' ? seed : makeRng(seed !== undefined ? seed : Date.now());

  const scale = makeScale({ root, mode });

  const totalSamples = Math.round(durationSec * sampleRate);
  const { left: busL, right: busR } = allocateStereoBuffer(totalSamples);

  // Seed drive(0) with the scale's tonic pitch class so the very first
  // macro-tick already has something to cover -- the piece's opening voice
  // is deterministic (the tonic), not dependent on the injection coin flip
  // landing on an early tick.
  const engineState = makeFlowState({
    initialCutoffHz: baseCutoffHz('STRICT'),
    initialChordMask: pitchClassBit(scale.rootPitchClass),
  });

  const reverb = makeReverb({ sampleRate, ...REVERB_PRESETS[reverbPreset] });
  const chorusL = makeDelayLine(Math.ceil(((CHORUS_BASE_MS + CHORUS_DEPTH_MS + 2) / 1000) * sampleRate) + 4);
  const chorusR = makeDelayLine(Math.ceil(((CHORUS_BASE_MS + CHORUS_DEPTH_MS + 2) / 1000) * sampleRate) + 4);
  let chorusLfoPhase = 0;
  const chorusLfoIncrement = 1 / (CHORUS_PERIOD_SEC * sampleRate);

  /** @type {Map<string, object>} voiceId -> render voice */
  const renderVoices = new Map();

  // Melodic foreground layer state: a queue of not-yet-triggered scheduled
  // notes (absolute startSec/durSec already computed by melody.mjs), a
  // separate voice pool from the pad bed's renderVoices, and the running
  // counters reported back for self-verification (melody.mjs notes are
  // meant to be audibly varied, not a repeated single pitch/duration).
  /** @type {Array<import('./melody.mjs').ScheduledNoteEvent>} */
  const melodyQueue = [];
  /** @type {Map<string, object>} voiceId -> melody render voice */
  const melodyVoices = new Map();
  let lastPhraseEndSec = 0;
  let melodyNoteOnsets = 0;
  const melodyOnsetDegrees = new Set();
  const melodyOnsetDurationsSec = new Set();
  // The piece's own OPENING-section base motif, captured the first time one
  // is generated, and reused verbatim (via generatePhrase's thematicMotif
  // opt) for RETURN-section phrases -- this is what makes the large-scale
  // arc's "return" a genuine thematic return rather than just a quieter
  // closing section.
  let openingMotif = null;
  // Per-onset log of large-scale-form-relevant facts (section, register,
  // timbre, scale degree, transport time) -- returned alongside the audio
  // buffers so a caller (the render CLI, or an offline analysis script) can
  // verify the arc actually happened in the rendered material, with real
  // numbers, instead of taking it on faith.
  /** @type {Array<{startSec:number, degree:number, sectionTag:string, octaveIndex:number, partialsName:string}>} */
  const melodyOnsetLog = [];
  // Log of every generated phrase's base motif, as its raw interval-delta
  // sequence (degree[i]-degree[i-1]) -- the concrete, checkable record of
  // "how many distinct shapes did the grammar actually produce in this
  // render" that scripts/render-track.mjs's self-check and any offline
  // analysis script read, rather than an assumption that variety happened.
  /** @type {Array<{startSec:number, sectionTag:string, intervals:number[]}>} */
  const motifShapeLog = [];
  // Log of every macro-form phase transition, paired with the regimeTag
  // that caused it and the transport time it happened at -- the concrete
  // record that section boundaries track regime transitions, not a fixed
  // clock fraction (see melody.mjs's advanceMacroFormPhase).
  /** @type {Array<{tSec:number, phase:string, regimeTag:string}>} */
  const macroFormLog = [];
  // Periodic sample of how many voices (pad bed + melody layer combined)
  // are actually sounding right now, taken every VOICE_ACTIVITY_SAMPLE_SEC
  // of transport time -- the concrete, measured record a caller (the render
  // CLI, or an offline analysis script) can use to verify a claim like "this
  // render is genuinely sparse" with real numbers (mean simultaneous voice
  // count, fraction of samples at 0 or 1 voices), instead of eyeballing the
  // waveform or trusting the generative parameters alone.
  /** @type {Array<{tSec:number, padVoices:number, melodyVoices:number, totalVoices:number}>} */
  const voiceActivityLog = [];
  const voiceActivitySampleIntervalSamples = Math.max(1, Math.round(VOICE_ACTIVITY_SAMPLE_SEC * sampleRate));

  let transportSampleIndex = 0;
  let previousCutoffHz = engineState.filterCutoffHz;
  let regimeTransitions = 0;
  let previousRegimeTag = engineState.regimeTag;
  // Melodic macro-form (OPENING/DEVELOPMENT/RETURN): driven by the actual
  // regime sequence (melody.mjs's advanceMacroFormPhase), not a fixed
  // clock-percentage schedule -- see melody.mjs's header comment for why
  // that fix matters. Updated once per macro-tick, right alongside the
  // regimeTag it reads.
  let macroFormState = makeMacroFormState();
  macroFormLog.push({ tSec: 0, phase: macroFormState.phase, regimeTag: engineState.regimeTag });

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
    const previousMacroFormPhase = macroFormState.phase;
    macroFormState = advanceMacroFormPhase(macroFormState, regimeTag);
    if (macroFormState.phase !== previousMacroFormPhase) {
      macroFormLog.push({ tSec: transportTimeSec, phase: macroFormState.phase, regimeTag });
    }

    const windowSec = BASE_WINDOW_SEC * windowLengthMultiplier(regimeTag);
    const targetCutoffHz = baseCutoffHz(regimeTag);

    const inOutro = transportTimeSec >= durationSec * (1 - OUTRO_FRACTION);
    const base = inOutro ? 0 : baseInjectProb;
    const rising = inOutro ? 0 : risingInjectProb;

    const tickResult = stepFlow(engineState, rng, scale, {
      base,
      rising,
      kHeight: K_HEIGHT,
      maxVoices,
      tickTime: transportTimeSec,
      targetCutoffHz,
    });

    const directFilterDelta = Math.abs(engineState.filterCutoffHz - previousCutoffHz);
    engineState.emaFilterDelta = engineState.emaFilterDelta * 0.8 + directFilterDelta * 0.2;
    engineState.directFilterDelta = directFilterDelta;
    previousCutoffHz = engineState.filterCutoffHz;

    const totalVoiceEvents = Math.max(1, engineState.activeVoiceIds.length);
    const temperature = computeTemperature(tickResult.addedVoices.length, totalVoiceEvents);

    // Refresh every currently-sounding (non-retiring) voice's detune/filter
    // jitter targets from this window's temperature -- applied per-voice
    // per-window, exactly as the humanization layer specifies.
    for (const voice of renderVoices.values()) {
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

    // "No temporal covers": voice-grouping decisions are frozen for the
    // whole window and only re-decided here, at the window boundary, as a
    // discrete re-cover -- new voices get a fresh ADSR attack, never a
    // mid-window crossfade.
    for (const added of tickResult.addedVoices) {
      const regEntry = engineState.voiceRegistry.find((v) => v.voiceId === added.voiceId) || added;
      const onsetJitterSec = Math.max(0, sampleOnsetJitterMs(rng, temperature) / 1000);
      const attackAtSec = transportTimeSec + Math.min(onsetJitterSec, windowSec * 0.25);
      const voice = makeRenderVoice(regEntry, scale, sampleRate, engineState.filterCutoffHz + sampleFilterJitterHz(rng, temperature), attackAtSec, rng, padPartials);
      renderVoices.set(voice.voiceId, voice);
    }

    for (const dropped of tickResult.droppedVoices) {
      const voice = renderVoices.get(dropped.voiceId);
      if (voice && !voice.retiring) {
        triggerRelease(voice.envelope, transportTimeSec);
        voice.retiring = true;
      }
    }

    // Melodic foreground layer: queue up the next phrase once the current
    // one has fully played out (melodyQueue empty), unless we're close
    // enough to the end of the track that a new ~15-28s phrase wouldn't
    // finish -- mirrors the pad bed's own outro behavior (stop starting new
    // material, let what's already sounding finish naturally). The phrase's
    // cadence is gated against engineState.chordMask (cover.mjs's subCheck)
    // so it resolves onto a pitch the drone bed is actually sounding.
    if (melody && melodyQueue.length === 0 && transportTimeSec < durationSec - melodyMinTrailingSilenceSec) {
      const gapSec = nextRange(rng, melodyPhraseGapSecMin, melodyPhraseGapSecMax);
      const phraseStartSec = Math.max(transportTimeSec, lastPhraseEndSec + gapSec);
      // Large-scale melodic section for *this* phrase: the macro-form
      // phase's current value, itself driven by the actual regime sequence
      // observed so far (see melody.mjs's advanceMacroFormPhase and this
      // file's header comment).
      const sectionTag = macroFormState.phase;
      // RETURN phrases develop the piece's own captured OPENING motif
      // (true thematic return) rather than generating fresh material; if
      // the piece is too short to have reached OPENING before RETURN
      // (openingMotif still null), generatePhrase falls back to generating
      // fresh OPENING/RETURN-weighted (narrow) material on its own.
      const thematicMotif = sectionTag === 'RETURN' && openingMotif ? openingMotif : undefined;
      const phrase = generatePhrase(rng, scale, {
        startSec: phraseStartSec,
        chordMask: engineState.chordMask,
        regimeTag: engineState.regimeTag,
        secPerQuarter: MELODY_SEC_PER_QUARTER,
        sectionTag,
        thematicMotif,
      });
      if (sectionTag === 'OPENING' && !openingMotif) {
        openingMotif = phrase.baseMotif;
      }
      const baseIntervals = [];
      for (let bi = 1; bi < phrase.baseMotif.length; bi++) baseIntervals.push(phrase.baseMotif[bi].degree - phrase.baseMotif[bi - 1].degree);
      motifShapeLog.push({ startSec: phraseStartSec, sectionTag, intervals: baseIntervals });
      const profile = melodyVoiceProfileForSection(sectionTag, rng, melodySectionProfiles);
      for (const n of phrase.notes) {
        melodyQueue.push({ ...n, sectionTag, octaveIndex: profile.octaveIndex, partialsName: profile.partialsName });
      }
      lastPhraseEndSec = phrase.endSec;
    }

    const windowSamples = Math.min(Math.round(windowSec * sampleRate), totalSamples - transportSampleIndex);

    for (let si = 0; si < windowSamples; si++) {
      const sampleTimeSec = transportTimeSec + si / sampleRate;
      const busIndex = transportSampleIndex + si;

      if (busIndex % voiceActivitySampleIntervalSamples === 0) {
        voiceActivityLog.push({
          tSec: sampleTimeSec,
          padVoices: renderVoices.size,
          melodyVoices: melodyVoices.size,
          totalVoices: renderVoices.size + melodyVoices.size,
        });
      }

      let l = 0;
      let r = 0;

      for (const voice of renderVoices.values()) {
        const smoothedCents = processOnePole(voice.detuneSmoother, voice.targetDetuneCents);
        const freq = voice.baseHz * centsToRatio(smoothedCents);
        const raw = advanceOscillator(voice.oscillator, freq);

        const elapsed = sampleTimeSec - voice.envelope.stageStartTime;
        const level = envelopeValueAt(voice.envelope, elapsed);

        const filtered = processBiquad(voice.biquad, raw * level);

        const pan = Math.sin(2 * Math.PI * (sampleTimeSec / voice.panPeriodSec + voice.panPhase)) * PAN_DEPTH;

        ({ left: l, right: r } = mixInto(l, r, filtered, voice.gain, pan));
      }

      // Melodic foreground layer: trigger any notes whose scheduled onset
      // has arrived (sample-accurate, not just at the window boundary --
      // notes are 1-4s long, far shorter than a macro-tick window, so
      // onsets have to land on the correct sample rather than only being
      // checked once per window like the pad bed's re-cover).
      while (melodyQueue.length > 0 && melodyQueue[0].startSec <= sampleTimeSec) {
        const noteEvent = melodyQueue.shift();
        const voiceId = `mel${melodyNoteOnsets}_${Math.round(noteEvent.startSec * 1000)}`;
        const cutoffHz = engineState.filterCutoffHz + MELODY_CUTOFF_BOOST_HZ + sampleFilterJitterHz(rng, temperature);
        const melodyVoice = makeMelodyVoice(noteEvent, scale, sampleRate, cutoffHz, rng, voiceId);
        melodyVoices.set(voiceId, melodyVoice);
        melodyNoteOnsets += 1;
        melodyOnsetDegrees.add(noteEvent.degree);
        melodyOnsetDurationsSec.add(Math.round(noteEvent.durSec * 100) / 100);
        melodyOnsetLog.push({
          startSec: noteEvent.startSec,
          degree: noteEvent.degree,
          sectionTag: noteEvent.sectionTag,
          octaveIndex: noteEvent.octaveIndex,
          partialsName: noteEvent.partialsName,
        });
      }

      for (const voice of melodyVoices.values()) {
        if (!voice.retiring && sampleTimeSec >= voice.releaseAtSec) {
          triggerRelease(voice.envelope, sampleTimeSec);
          voice.retiring = true;
        }

        const raw = advanceOscillator(voice.oscillator);

        const elapsed = sampleTimeSec - voice.envelope.stageStartTime;
        const level = envelopeValueAt(voice.envelope, elapsed);

        const filtered = processBiquad(voice.biquad, raw * level);

        const pan = Math.sin(2 * Math.PI * (sampleTimeSec / MELODY_PAN_PERIOD_SEC + voice.panPhase)) * MELODY_PAN_DEPTH;

        ({ left: l, right: r } = mixInto(l, r, filtered, voice.gain, pan));
      }

      // Chorus: shared stereo modulated delay applied to the summed bus.
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

      const { outL, outR } = processReverbSample(reverb, l, r);

      busL[busIndex] = softClip(outL);
      busR[busIndex] = softClip(outR);
    }

    transportSampleIndex += windowSamples;
    const windowEndSec = transportSampleIndex / sampleRate;

    // Post-window cleanup: fully-released voices stop rendering. No voice
    // is ever hard-cut -- a dropped voice keeps rendering through its full
    // release curve (checked above by continuing to iterate renderVoices
    // during the sample loop) and is only removed here once its envelope
    // has actually reached zero.
    for (const [voiceId, voice] of renderVoices) {
      if (voice.retiring) {
        const elapsed = windowEndSec - voice.envelope.stageStartTime;
        if (elapsed >= voice.envelope.releaseSec) {
          renderVoices.delete(voiceId);
        }
      }
    }

    // Same cleanup for the melodic layer's much shorter-lived voices.
    for (const [voiceId, voice] of melodyVoices) {
      if (voice.retiring) {
        const elapsed = windowEndSec - voice.envelope.stageStartTime;
        if (elapsed >= voice.envelope.releaseSec) {
          melodyVoices.delete(voiceId);
        }
      }
    }
  }

  // Technical anti-click safeguard only (not generative fade-out logic):
  // linearly ramp the last END_DECLICK_SEC of the hard buffer boundary to
  // zero so an arbitrary truncation mid-waveform never produces a sample
  // discontinuity.
  const declickSamples = Math.min(totalSamples, Math.round(END_DECLICK_SEC * sampleRate));
  for (let i = 0; i < declickSamples; i++) {
    const idx = totalSamples - declickSamples + i;
    const g = i / declickSamples;
    busL[idx] *= g;
    busR[idx] *= g;
  }

  if (hasNonFinite(busL, busR)) {
    throw new Error('renderTrack produced non-finite samples -- this indicates a DSP bug, not a valid render.');
  }

  // Real measured sparseness numbers from voiceActivityLog, not an
  // assumption -- meanTotalVoices is the average simultaneous voice count
  // (pad bed + melody combined) across the whole render; fractionSilent and
  // fractionSingleVoiceOrFewer are the fraction of sampled instants with
  // zero, or at most one, voice sounding.
  let voiceActivitySummary = null;
  if (voiceActivityLog.length > 0) {
    let sumTotal = 0;
    let silentCount = 0;
    let singleOrFewerCount = 0;
    for (const e of voiceActivityLog) {
      sumTotal += e.totalVoices;
      if (e.totalVoices === 0) silentCount += 1;
      if (e.totalVoices <= 1) singleOrFewerCount += 1;
    }
    voiceActivitySummary = {
      sampleCount: voiceActivityLog.length,
      sampleIntervalSec: VOICE_ACTIVITY_SAMPLE_SEC,
      meanTotalVoices: sumTotal / voiceActivityLog.length,
      fractionSilent: silentCount / voiceActivityLog.length,
      fractionSingleVoiceOrFewer: singleOrFewerCount / voiceActivityLog.length,
    };
  }

  return {
    sampleRate,
    numChannels: 2,
    left: Float32Array.from(busL),
    right: Float32Array.from(busR),
    durationSec,
    peak: peakOf(busL, busR),
    rms: rmsOf(busL, busR),
    spiralCount: engineState.spiralCount,
    regimeTransitions,
    finalRegime: engineState.regimeTag,
    melodyNoteOnsets,
    melodyUniqueDegrees: melodyOnsetDegrees.size,
    melodyUniqueDurationsSec: melodyOnsetDurationsSec.size,
    melodyOnsetLog,
    motifShapeLog,
    macroFormLog,
    voiceActivityLog,
    voiceActivitySummary,
  };
}
