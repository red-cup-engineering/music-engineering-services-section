// improv-duo.mjs
//
// Real call-and-response duo improvisation between two instrument voices --
// a Karplus-Strong plucked string (dsp/karplus-strong.mjs) and a sustained
// bow/breath voice (dsp/bow-breath-voice.mjs) -- built on the same
// generative kernel the rest of this engine uses (regime.mjs for macro-form
// pacing, cover.mjs for harmonic coordination between the two voices,
// thermo.mjs for humanization, melody.mjs's real developing-variation
// operators and motif-grammar.mjs's Lambek-residuation-based grammar for the
// actual musical material), instead of the ambient layer's independent-
// parallel-drone-voices approach.
//
// What "call and response" means concretely here, and how it differs from
// compose.mjs's melody layer:
//   - melody.mjs's generatePhrase already does real developing-variation
//     (motif -> several statements via transpose/invert/retrograde/augment
//     -> cadence) for ONE voice. This module reuses generatePhrase directly
//     for BOTH the "call" and the "response" -- no melodic-development logic
//     is duplicated -- but adds the actual duo mechanic on top: a response
//     phrase's base motif is not a fresh grammar draw, it is a named
//     developing-variation transform (see RESPONSE_OPERATORS below) applied
//     directly to the call's own base motif, so the response is audibly
//     "answering" the call's actual material, not just independently
//     generated material that happens to share a scale.
//   - Turn-taking is genuinely variable: sometimes the response waits for
//     real silence after the call (a classic call/response gap), sometimes
//     it trades in right at the call's tail (minimal gap, "trading fours"
//     style), and sometimes it genuinely overlaps the call mid-phrase (both
//     voices audibly sounding together) -- see OVERLAP_MODES and
//     pickOverlapMode. This is picked per exchange, weighted by the current
//     macro-form phase (regime.mjs/melody.mjs's OPENING/DEVELOPMENT/RETURN),
//     so DEVELOPMENT genuinely overlaps more than OPENING/RETURN, tying the
//     dialogue's texture to the same regime-driven pacing the rest of the
//     engine uses rather than a fixed constant.
//
// Piece-level motif vocabulary ("confined to certain motifs"): a small set
// of seed motifs is generated ONCE at session creation (createImprovDuoSession)
// and is what most calls draw from and develop, the same way a real
// improviser stays "inside" a tune's own melodic material -- this is the
// literal extension of melody.mjs's existing single-motif "thematic return"
// mechanism (one captured OPENING motif, reused verbatim for RETURN) to a
// whole small vocabulary that gets drawn from continuously, not just once at
// the end. The vocabulary is allowed to slowly grow (an occasional call
// introduces a fresh grammar-drawn motif that then joins the vocabulary for
// future reuse) rather than being completely frozen -- real improv vocabularies
// do grow over a set, they don't regenerate from scratch every phrase.
//
// Harmonic coordination between the two voices (cover.mjs): a lightweight
// reuse of flow.mjs's driven-closure-flow engine (the same primitive
// compose.mjs's pad bed runs) drives a slowly-evolving chordMask across the
// session -- not rendered as its own audible voice here, just used exactly
// as melody.mjs's chooseCadenceDegree already uses it: to decide which
// scale degree a phrase's cadence should resolve to, via cover.mjs's
// subCheck. Both the call and the response consult the SAME chordMask, so
// their cadences are genuinely harmonically coordinated with each other and
// with the piece's own regime-driven pacing, not just independently picked.
//
// Open-ended / incremental architecture (no fixed-duration assumption baked
// into the generation loop): advanceImprovDuo(session, throughSec) extends
// a session's schedule and regime/harmony state up to the requested
// transport time and returns, without ever allocating an audio buffer or
// requiring a known-in-advance total duration -- it can be called again
// later with a larger throughSec to keep extending the same session (this
// is the literal "generate the next N seconds of state, given current
// state" unit the task asked for). renderImprovDuo (below) is a convenience
// wrapper that calls it once up to a fixed durationSec and then synthesizes
// audio, for producing a normal fixed-length render -- the underlying
// scheduling loop itself has no such limit. Contrast with compose.mjs's
// renderTrack, which allocates one totalSamples-sized buffer up front and
// runs its own macro-tick loop only up to that fixed bound -- that
// structural assumption is NOT fixed by this module; see this file's
// exported renderImprovDuo doc comment and the top-level README for the
// honest account of what would still need to change there.

import { makeKarplusString, advanceKarplusString } from "@red-cup-engineering/computer-audio-engineering-services-section/karplus-strong";
import { makeBowBreathVoice, triggerBowBreathAttack, triggerBowBreathRelease, advanceBowBreathVoice, BOW_BREATH_SHAPES } from "@red-cup-engineering/computer-audio-engineering-services-section/bow-breath-voice";
import { PARTIAL_PRESETS } from "@red-cup-engineering/computer-audio-engineering-services-section/oscillator";
import { makeReverb, processReverbSample, REVERB_PRESETS } from "@red-cup-engineering/computer-audio-engineering-services-section/reverb";
import { allocateStereoBuffer, mixInto, softClip, peakOf, rmsOf, hasNonFinite } from "@red-cup-engineering/computer-audio-engineering-services-section/mixer";

import { makeScale, pitchClassBit } from './scale.mjs';
import { classify, windowLengthMultiplier, baseCutoffHz } from './regime.mjs';
import { makeFlowState, stepFlow } from './flow.mjs';
import { computeTemperature, sampleDetuneCents, sampleOnsetJitterMs } from './thermo.mjs';
import { makeRng, nextFloat, nextRange, nextInt, pick } from './random.mjs';
import {
  generateMotif,
  transposeMotif,
  invertMotif,
  retrogradeMotif,
  augmentMotif,
  generatePhrase,
  degreeToHz,
  makeMacroFormState,
  advanceMacroFormPhase,
  pickGrammarBiasForSection,
} from './melody.mjs';

const BASE_WINDOW_SEC = 12;
const K_HEIGHT = 3;
// Matches compose.mjs's own BASE_INJECT_PROB/RISING_INJECT_PROB exactly --
// these values are what that module's own long-render verification (see
// README.md) confirmed actually produces real regime transitions (and hence
// real macro-form movement) within an ordinary piece length; there is no
// reason for this module's harmonic-coordination flow engine to behave
// differently.
const BASE_INJECT_PROB = 0.15;
const RISING_INJECT_PROB = 0.03;

const VOICE_A_INSTRUMENT = 'string'; // Karplus-Strong
const VOICE_B_INSTRUMENT = 'breath'; // bow/breath voice

const STRING_OCTAVE_INDEX = 1; // index into scale.mjs's OCTAVES for voice A's base register
const BREATH_OCTAVE_INDEX = 2; // a register above the string, so the two voices don't sit on top of each other

const GAP_SEC_RANGE = [0.6, 3.2]; // 'wait' overlap mode: silence gap before the response enters
const TRADE_OFFSET_SEC_RANGE = [-0.4, 0.5]; // 'trade' overlap mode: response enters at roughly the call's tail (negative = slightly before it ends)
const OVERLAP_FRACTION_RANGE = [0.25, 0.75]; // 'overlap' mode: response enters this far through the call's own duration

// Per-macro-form-phase weights for which overlap mode a given exchange uses.
// DEVELOPMENT is weighted toward more overlap/trading (busier, more
// interleaved dialogue); OPENING/RETURN are weighted toward the classic
// wait-for-silence call/response shape, mirroring the same "OPENING/RETURN
// stay narrow, DEVELOPMENT roams" arc melody.mjs already uses for motif
// shape and register.
const OVERLAP_MODE_WEIGHTS_BY_PHASE = Object.freeze({
  OPENING: Object.freeze({ wait: 6, trade: 3, overlap: 1 }),
  DEVELOPMENT: Object.freeze({ wait: 2, trade: 3, overlap: 4 }),
  RETURN: Object.freeze({ wait: 6, trade: 3, overlap: 1 }),
});

/** The four developing-variation operators a response can apply to the call's own base motif, plus a literal restatement (real improvisers do sometimes answer a call by echoing it back essentially unchanged, especially early in a piece). */
const RESPONSE_OPERATORS = Object.freeze(['transpose', 'invert', 'retrograde', 'augment', 'echo']);

function applyResponseOperator(rng, name, motif, sectionTag) {
  switch (name) {
    case 'transpose': {
      const choices = sectionTag === 'DEVELOPMENT' ? [-5, -4, -3, -2, -1, 1, 2, 3, 4, 5] : [-2, -1, 1, 2];
      return transposeMotif(motif, pick(rng, choices));
    }
    case 'invert':
      return invertMotif(motif, motif[0] ? motif[0].degree : 0);
    case 'retrograde':
      return retrogradeMotif(motif);
    case 'augment':
      return augmentMotif(motif, 2);
    case 'echo':
    default:
      return motif.map((n) => ({ ...n }));
  }
}

function pickOverlapMode(rng, sectionTag) {
  const weights = OVERLAP_MODE_WEIGHTS_BY_PHASE[sectionTag] || OVERLAP_MODE_WEIGHTS_BY_PHASE.DEVELOPMENT;
  const total = weights.wait + weights.trade + weights.overlap;
  let r = nextRange(rng, 0, total);
  if (r < weights.wait) return 'wait';
  r -= weights.wait;
  if (r < weights.trade) return 'trade';
  return 'overlap';
}

/**
 * Creates a fresh improv-duo session: a scale, a piece-level motif
 * vocabulary, and the regime/flow/macro-form state that will pace the whole
 * dialogue. No audio and no fixed total duration is allocated here.
 * @param {object} [opts]
 * @param {number|string|{state:number}} [opts.seed]
 * @param {number} [opts.sampleRate=44100]
 * @param {string} [opts.root='D']
 * @param {'dorian'|'aeolian'|'majorPentatonic'|'minorPentatonic'|{cardinality:number, rotation?:number, chromaticUniverse?:number}} [opts.mode='dorian'] - the same real maximal-evenness scale generator (scale.mjs) the rest of the engine uses, exposed here as a real parameter -- the "confined to a scale" input the task asked for.
 * @param {number} [opts.secPerQuarter=0.85] - rhythmic pacing unit (see melody.mjs's fractionToSeconds); a bit brisker than compose.mjs's ambient-pad default (1.0), suited to a more active dialogue.
 * @param {number} [opts.vocabularySize=4] - how many seed motifs the piece-level vocabulary starts with
 * @param {number} [opts.vocabularyGrowthProb=0.18] - per-call probability of introducing a fresh grammar-drawn motif into the vocabulary instead of drawing an existing one
 * @param {number} [opts.maxVocabularySize=8] - vocabulary growth stops once this size is reached (bounded growth, not unbounded)
 * @returns {object} session state, extended over time by advanceImprovDuo
 */
export function createImprovDuoSession({
  seed,
  sampleRate = 44100,
  root = 'D',
  mode = 'dorian',
  secPerQuarter = 0.85,
  vocabularySize = 4,
  vocabularyGrowthProb = 0.18,
  maxVocabularySize = 8,
} = {}) {
  const rng = seed && typeof seed === 'object' && typeof seed.state === 'number' ? seed : makeRng(seed !== undefined ? seed : Date.now());
  const scale = makeScale({ root, mode });

  const vocabulary = [];
  for (let i = 0; i < vocabularySize; i++) {
    const length = nextInt(rng, 3, 6);
    const bias = pickGrammarBiasForSection(rng, i === 0 ? 'OPENING' : 'DEVELOPMENT');
    vocabulary.push(generateMotif(rng, { length, bias }));
  }

  const flowEngine = makeFlowState({ initialCutoffHz: baseCutoffHz('STRICT'), initialChordMask: pitchClassBit(scale.rootPitchClass) });

  return {
    rng,
    scale,
    sampleRate,
    secPerQuarter,
    vocabulary,
    vocabularyGrowthProb,
    maxVocabularySize,
    flowEngine,
    previousCutoffHz: flowEngine.filterCutoffHz, // tracked so advanceImprovDuo can compute directFilterDelta/emaFilterDelta itself -- see that function's comment; classify() depends on these actually being updated to ever leave STRICT
    macroFormState: makeMacroFormState(),
    regimeTag: 'STRICT',
    tSec: 0, // the flow/regime engine's own clock -- how far the pacing state has been advanced
    freeSec: 0, // the "scheduling frontier": no note is scheduled to start before this time is available
    turn: nextFloat(rng) < 0.5 ? 'A' : 'B', // which voice leads the very first exchange
    schedule: { A: [], B: [] }, // per-voice arrays of ScheduledDuoNoteEvent, in ascending startSec order
    phraseLog: [], // one entry per call or response phrase: {voice, role:'call'|'response', sectionTag, startSec, endSec, vocabularyIndex|null, isFresh, responseOperator|null, baseMotifIntervals}
    macroFormLog: [{ tSec: 0, phase: 'OPENING', regimeTag: 'STRICT' }],
  };
}

function baseMotifIntervals(motif) {
  const out = [];
  for (let i = 1; i < motif.length; i++) out.push(motif[i].degree - motif[i - 1].degree);
  return out;
}

/**
 * Picks a base motif for a new call: usually an existing vocabulary entry
 * (developed further by generatePhrase's own operator statements, same as
 * any other phrase), occasionally a fresh grammar-drawn motif that then
 * joins the vocabulary (bounded growth -- see maxVocabularySize). This is
 * the concrete mechanism behind "a piece-level motif vocabulary that gets
 * drawn from and developed throughout, not regenerated fresh every phrase."
 * @returns {{motif:Array, vocabularyIndex:number|null, isFresh:boolean}}
 */
function pickCallMotif(session, sectionTag) {
  const canGrow = session.vocabulary.length < session.maxVocabularySize;
  if (canGrow && nextFloat(session.rng) < session.vocabularyGrowthProb) {
    const length = nextInt(session.rng, 3, 6);
    const bias = pickGrammarBiasForSection(session.rng, sectionTag);
    const fresh = generateMotif(session.rng, { length, bias });
    session.vocabulary.push(fresh);
    return { motif: fresh, vocabularyIndex: session.vocabulary.length - 1, isFresh: true };
  }
  const idx = nextInt(session.rng, 0, session.vocabulary.length);
  return { motif: session.vocabulary[idx], vocabularyIndex: idx, isFresh: false };
}

/**
 * Advances the session's regime/flow/macro-form pacing state, and the
 * per-voice note schedule, up to (at least) throughSec. Safe to call
 * repeatedly with increasing throughSec values to keep extending the same
 * session incrementally -- no fixed total duration is assumed anywhere in
 * this function. This is the "generate the next N seconds of state, given
 * current state" unit: a caller doing live/streaming generation would call
 * this in a loop with throughSec = session.tSec + someChunkSeconds forever;
 * renderImprovDuo below just calls it once up to a fixed bound for a normal
 * finite render.
 * @param {object} session - from createImprovDuoSession, mutated in place
 * @param {number} throughSec - extend scheduling/pacing state until session.tSec >= throughSec
 * @returns {object} session
 */
export function advanceImprovDuo(session, throughSec) {
  while (session.tSec < throughSec) {
    const regimeTag = classify({
      activeVoiceCount: session.flowEngine.activeVoiceIds.length,
      emaFilterDelta: session.flowEngine.emaFilterDelta,
      directFilterDelta: session.flowEngine.directFilterDelta,
      ticksSinceLastReset: session.flowEngine.ticksSinceLastReset,
    });
    session.flowEngine.regimeTag = regimeTag;
    session.regimeTag = regimeTag;

    const previousPhase = session.macroFormState.phase;
    session.macroFormState = advanceMacroFormPhase(session.macroFormState, regimeTag);
    if (session.macroFormState.phase !== previousPhase) {
      session.macroFormLog.push({ tSec: session.tSec, phase: session.macroFormState.phase, regimeTag });
    }

    const windowSec = BASE_WINDOW_SEC * windowLengthMultiplier(regimeTag);
    const targetCutoffHz = baseCutoffHz(regimeTag);

    // Reuse flow.mjs's driven-closure-flow engine purely as a harmonic-
    // coordination signal (engineState.chordMask): both voices' cadences
    // read this same mask via melody.mjs's chooseCadenceDegree (called
    // inside generatePhrase), so their cadential resolutions are genuinely
    // coordinated with each other and with the regime-driven pacing, not
    // independently guessed. This is the same primitive compose.mjs's pad
    // bed runs, reused here as pacing/harmony state only -- no pad-bed audio
    // is rendered by this module.
    stepFlow(session.flowEngine, session.rng, session.scale, {
      base: BASE_INJECT_PROB,
      rising: RISING_INJECT_PROB,
      kHeight: K_HEIGHT,
      maxVoices: 6,
      tickTime: session.tSec,
      targetCutoffHz,
    });

    // classify()'s scottContinuous check reads emaFilterDelta/directFilterDelta,
    // and (via finiteBase interacting with real voice-count churn over time)
    // this bookkeeping is what actually lets the regime leave STRICT at all
    // -- stepFlow itself does not update these two fields, exactly matching
    // compose.mjs's own per-tick bookkeeping (see that module's main loop).
    // Omitting this is a real bug, not a style choice: without it the regime
    // classifier effectively never sees the filter-cutoff drift it's meant
    // to react to and the piece can get stuck in STRICT indefinitely --
    // caught by measuring an actual multi-hundred-second render, not assumed.
    const directFilterDelta = Math.abs(session.flowEngine.filterCutoffHz - session.previousCutoffHz);
    session.flowEngine.emaFilterDelta = session.flowEngine.emaFilterDelta * 0.8 + directFilterDelta * 0.2;
    session.flowEngine.directFilterDelta = directFilterDelta;
    session.previousCutoffHz = session.flowEngine.filterCutoffHz;

    session.tSec += windowSec;

    // Lookahead scheduling: keep the schedule extended a bit past the
    // pacing engine's own clock so a note that starts near "now" always has
    // upcoming material queued, without ever pre-generating the whole piece
    // up front.
    const lookaheadSec = windowSec * 1.5;
    while (session.freeSec < session.tSec + lookaheadSec) {
      scheduleNextExchange(session);
    }
  }
  return session;
}

/**
 * Schedules exactly one call-and-response exchange (a call phrase from the
 * current leader voice, then a response phrase from the other voice, with a
 * real turn-taking timing relationship between them -- see pickOverlapMode),
 * advances session.freeSec, and flips session.turn for next time (usually,
 * not always -- see continuationProb below).
 * @param {object} session - mutated in place
 */
function scheduleNextExchange(session) {
  const { rng, scale } = session;
  const sectionTag = session.macroFormState.phase;
  const chordMask = session.flowEngine.chordMask;

  const leader = session.turn;
  const responder = leader === 'A' ? 'B' : 'A';
  const leaderInstrument = leader === 'A' ? VOICE_A_INSTRUMENT : VOICE_B_INSTRUMENT;
  const responderInstrument = responder === 'A' ? VOICE_A_INSTRUMENT : VOICE_B_INSTRUMENT;

  const callStartSec = Math.max(session.freeSec, session.tSec) + Math.max(0, sampleOnsetJitterMs(rng, 0.4) / 1000);

  const { motif: callMotif, vocabularyIndex, isFresh } = pickCallMotif(session, sectionTag);
  const callPhrase = generatePhrase(rng, scale, {
    startSec: callStartSec,
    chordMask,
    regimeTag: session.regimeTag,
    secPerQuarter: session.secPerQuarter,
    sectionTag,
    thematicMotif: callMotif,
  });

  pushPhraseToSchedule(session, leader, leaderInstrument, callPhrase);
  session.phraseLog.push({
    voice: leader,
    instrument: leaderInstrument,
    role: 'call',
    sectionTag,
    startSec: callPhrase.startSec,
    endSec: callPhrase.endSec,
    vocabularyIndex,
    isFresh,
    responseOperator: null,
    baseMotifIntervals: baseMotifIntervals(callPhrase.baseMotif),
  });

  // The response's base motif is a real developing-variation transform of
  // the CALL's own base motif -- the concrete "answering" mechanism, not an
  // independently generated phrase that merely shares a scale.
  const responseOperator = pick(rng, RESPONSE_OPERATORS);
  const responseMotif = applyResponseOperator(rng, responseOperator, callPhrase.baseMotif, sectionTag);

  const overlapMode = pickOverlapMode(rng, sectionTag);
  const callDurSec = callPhrase.endSec - callPhrase.startSec;
  let responseStartSec;
  if (overlapMode === 'wait') {
    responseStartSec = callPhrase.endSec + nextRange(rng, GAP_SEC_RANGE[0], GAP_SEC_RANGE[1]);
  } else if (overlapMode === 'trade') {
    responseStartSec = callPhrase.endSec + nextRange(rng, TRADE_OFFSET_SEC_RANGE[0], TRADE_OFFSET_SEC_RANGE[1]);
  } else {
    responseStartSec = callPhrase.startSec + callDurSec * nextRange(rng, OVERLAP_FRACTION_RANGE[0], OVERLAP_FRACTION_RANGE[1]);
  }
  // A 'trade'/'overlap' offset could in principle push the response before
  // t=0 right at the very start of a session -- clamp to a real non-negative
  // transport time.
  responseStartSec = Math.max(responseStartSec, 0);

  const responsePhrase = generatePhrase(rng, scale, {
    startSec: responseStartSec,
    chordMask,
    regimeTag: session.regimeTag,
    secPerQuarter: session.secPerQuarter,
    sectionTag,
    thematicMotif: responseMotif,
  });

  pushPhraseToSchedule(session, responder, responderInstrument, responsePhrase);
  session.phraseLog.push({
    voice: responder,
    instrument: responderInstrument,
    role: 'response',
    sectionTag,
    startSec: responsePhrase.startSec,
    endSec: responsePhrase.endSec,
    vocabularyIndex,
    isFresh: false,
    responseOperator,
    overlapMode,
    baseMotifIntervals: baseMotifIntervals(responsePhrase.baseMotif),
  });

  session.freeSec = Math.max(callPhrase.endSec, responsePhrase.endSec);

  // Usually swap leadership (a genuine back-and-forth), but sometimes the
  // same voice leads twice in a row (a "double call") -- real trading
  // between improvisers is not perfectly alternating either.
  const continuationProb = 0.22;
  session.turn = nextFloat(rng) < continuationProb ? leader : responder;
}

function pushPhraseToSchedule(session, voice, instrument, phrase) {
  for (const n of phrase.notes) {
    session.schedule[voice].push({ ...n, instrument, sectionTag: phrase.sectionTag });
  }
}

/**
 * Computes exact turn-taking/overlap statistics from a session's schedule:
 * the fraction of [0, totalSec] where both voices sound, only voice A, only
 * voice B, or neither -- computed analytically from the note intervals
 * (merged per voice into non-overlapping sounding spans first), not sampled
 * from rendered audio, so this is an exact measurement of the *scheduled*
 * dialogue's structure.
 * @param {object} session
 * @param {number} totalSec
 * @returns {{bothSec:number, onlyASec:number, onlyBSec:number, silenceSec:number, bothFrac:number, onlyAFrac:number, onlyBFrac:number, silenceFrac:number}}
 */
export function computeOverlapStats(session, totalSec) {
  function mergedSpans(events) {
    const spans = events.map((e) => [e.startSec, e.startSec + e.durSec]).sort((a, b) => a[0] - b[0]);
    const merged = [];
    for (const [s, e] of spans) {
      if (merged.length > 0 && s <= merged[merged.length - 1][1] + 1e-9) {
        merged[merged.length - 1][1] = Math.max(merged[merged.length - 1][1], e);
      } else {
        merged.push([s, e]);
      }
    }
    return merged;
  }

  const spansA = mergedSpans(session.schedule.A);
  const spansB = mergedSpans(session.schedule.B);

  // Sweep-line over both voices' merged spans, sampling coverage at every
  // boundary point, clamped to [0, totalSec].
  const boundaries = new Set([0, totalSec]);
  for (const [s, e] of spansA) {
    if (s >= 0 && s <= totalSec) boundaries.add(s);
    if (e >= 0 && e <= totalSec) boundaries.add(e);
  }
  for (const [s, e] of spansB) {
    if (s >= 0 && s <= totalSec) boundaries.add(s);
    if (e >= 0 && e <= totalSec) boundaries.add(e);
  }
  const points = Array.from(boundaries).sort((a, b) => a - b);

  function coversAt(spans, t) {
    // t is a boundary point; check the tiny interval just after it.
    for (const [s, e] of spans) {
      if (s <= t && t < e) return true;
    }
    return false;
  }

  let bothSec = 0;
  let onlyASec = 0;
  let onlyBSec = 0;
  let silenceSec = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const t0 = points[i];
    const t1 = points[i + 1];
    const dur = t1 - t0;
    if (dur <= 0) continue;
    const mid = (t0 + t1) / 2;
    const aOn = coversAt(spansA, mid);
    const bOn = coversAt(spansB, mid);
    if (aOn && bOn) bothSec += dur;
    else if (aOn) onlyASec += dur;
    else if (bOn) onlyBSec += dur;
    else silenceSec += dur;
  }

  return {
    bothSec,
    onlyASec,
    onlyBSec,
    silenceSec,
    bothFrac: bothSec / totalSec,
    onlyAFrac: onlyASec / totalSec,
    onlyBFrac: onlyBSec / totalSec,
    silenceFrac: silenceSec / totalSec,
  };
}

// --- audio rendering -------------------------------------------------------

const STRING_PARTIAL_HINT = 'karplusStrong'; // not a PARTIAL_PRESETS key -- karplus-strong.mjs doesn't use additive partials at all, noted here only for readability of makeRenderVoiceForNote below
const REVERB_WET_MIX_OVERRIDE = 0.22; // lighter than the ambient layer's deepAmbient preset default -- a duo dialogue needs to stay legible/present, not washed into a long reverb tail

function seededSampleFn(rng) {
  return () => nextFloat(rng) * 2 - 1;
}

/**
 * Synthesizes one voice's note event into the stereo bus over its actual
 * sounding duration, sample-accurately, mixing into busL/busR starting at
 * startSampleIndex. String notes (Karplus-Strong) are a single pluck-and-
 * decay per note, rendered for min(durSec, a generous decay tail) so the
 * string's own physics -- not an artificial cutoff -- determines when it
 * actually goes quiet. Breath notes use a real ADSR-style attack/release via
 * dsp/bow-breath-voice.mjs.
 */
function renderNoteIntoBus(note, { busL, busR, sampleRate, scale, rng, panBase }) {
  const octaveIndex = note.instrument === VOICE_A_INSTRUMENT ? STRING_OCTAVE_INDEX : BREATH_OCTAVE_INDEX;
  const baseHz = degreeToHz(scale, note.degree, octaveIndex);
  const detuneCents = sampleDetuneCents(rng, 0.3); // light, constant humanization -- this module doesn't run the full per-window temperature loop the ambient bed does, so a small fixed-temperature draw stands in for it
  const freqHz = baseHz * Math.pow(2, detuneCents / 1200);

  const startSample = Math.max(0, Math.round(note.startSec * sampleRate));
  if (startSample >= busL.length) return { peakContribution: 0 };

  if (note.instrument === VOICE_A_INSTRUMENT) {
    // Karplus-Strong pluck: decay/dampingHz chosen from the note's own
    // duration and pitch, so short notes decay quickly and long/cadence
    // notes ring out longer, all still genuinely physical (no artificial
    // envelope is applied on top).
    const targetTailSec = Math.max(0.4, Math.min(4.5, note.durSec * 1.6));
    // decay^(sampleRate*targetTailSec) ~= 0.01 (about -40dB) sets decay from
    // the desired tail length directly.
    const decay = Math.pow(0.01, 1 / (sampleRate * targetTailSec));
    const dampingHz = Math.max(1200, Math.min(9000, freqHz * 14));
    const str = makeKarplusString({ freqHz, sampleRate, decay, dampingHz, exciteGain: 0.9, exciteSample: seededSampleFn(rng) });

    const renderSamples = Math.min(Math.round(targetTailSec * sampleRate), busL.length - startSample);
    let peak = 0;
    for (let i = 0; i < renderSamples; i++) {
      const s = advanceKarplusString(str);
      const idx = startSample + i;
      const pan = panBase + 0.12 * Math.sin((2 * Math.PI * i) / (sampleRate * 9));
      const { left, right } = mixInto(busL[idx], busR[idx], s, 0.5, pan);
      busL[idx] = left;
      busR[idx] = right;
      if (Math.abs(s) > peak) peak = Math.abs(s);
    }
    return { peakContribution: peak };
  }

  // Breath voice: real attack/release via envelope.mjs, through
  // bow-breath-voice.mjs.
  const shape = pick(rng, [BOW_BREATH_SHAPES.flute, BOW_BREATH_SHAPES.flute, BOW_BREATH_SHAPES.bowedString]); // weighted toward flute (the primary "flute" voice of the duo), bowedString as an occasional textural variant
  const partials = PARTIAL_PRESETS.breathyFlute;
  const voice = makeBowBreathVoice({ freqHz, sampleRate, partials, shape, noiseSample: seededSampleFn(rng) });
  triggerBowBreathAttack(voice, note.startSec);
  const releaseAtSec = note.startSec + Math.max(note.durSec - shape.releaseSec, shape.attackSec);
  const tailSec = note.durSec + shape.releaseSec + 0.05;
  const renderSamples = Math.min(Math.round(tailSec * sampleRate), busL.length - startSample);
  let peak = 0;
  let released = false;
  for (let i = 0; i < renderSamples; i++) {
    const tSec = note.startSec + i / sampleRate;
    if (!released && tSec >= releaseAtSec) {
      triggerBowBreathRelease(voice, tSec);
      released = true;
    }
    const s = advanceBowBreathVoice(voice, tSec, freqHz);
    const idx = startSample + i;
    if (idx < 0 || idx >= busL.length) continue;
    const pan = panBase + 0.1 * Math.sin((2 * Math.PI * i) / (sampleRate * 13));
    const { left, right } = mixInto(busL[idx], busR[idx], s, 0.6, pan);
    busL[idx] = left;
    busR[idx] = right;
    if (Math.abs(s) > peak) peak = Math.abs(s);
  }
  return { peakContribution: peak };
}

/**
 * Renders a complete stereo improv-duo track: extends a fresh session's
 * schedule up to durationSec (via advanceImprovDuo -- see that function's
 * doc comment for why the underlying scheduling loop itself is not
 * duration-limited, only this convenience wrapper is), then synthesizes
 * every scheduled note into a stereo buffer through a shared reverb.
 *
 * Honest limitation versus advanceImprovDuo: this function DOES allocate
 * one totalSamples-sized buffer up front (same as compose.mjs's
 * renderTrack), because turning this into a truly incremental audio
 * renderer (yielding chunks of PCM as they're generated) is a streaming/
 * buffering concern the task described as out of scope for this pass ("you
 * don't need to build a full streaming HTTP endpoint"). The part that
 * genuinely has no fixed-duration assumption baked in is the scheduling/
 * pacing logic above (createImprovDuoSession + advanceImprovDuo) -- a
 * caller building a real incremental/streaming renderer would drive THAT in
 * a loop and render each newly-scheduled note as it appears, rather than
 * needing this function at all.
 * @param {object} opts
 * @param {number} opts.durationSec
 * @param {number} [opts.sampleRate=44100]
 * @param {number|string} [opts.seed]
 * @param {string} [opts.root='D']
 * @param {'dorian'|'aeolian'|'majorPentatonic'|'minorPentatonic'|object} [opts.mode='dorian']
 * @param {'deepAmbient'|'hall'|'chamber'} [opts.reverbPreset='chamber']
 * @param {number} [opts.secPerQuarter=0.85]
 * @param {number} [opts.vocabularySize=4]
 * @returns {{sampleRate:number, numChannels:number, left:Float32Array, right:Float32Array, durationSec:number, peak:number, rms:number, phraseLog:Array, macroFormLog:Array, vocabulary:Array, overlapStats:object, session:object}}
 */
export function renderImprovDuo({
  durationSec,
  sampleRate = 44100,
  seed,
  root = 'D',
  mode = 'dorian',
  reverbPreset = 'chamber',
  secPerQuarter = 0.85,
  vocabularySize = 4,
} = {}) {
  if (!(durationSec > 0)) throw new Error('renderImprovDuo: durationSec must be a positive number');

  const session = createImprovDuoSession({ seed, sampleRate, root, mode, secPerQuarter, vocabularySize });
  advanceImprovDuo(session, durationSec);

  const totalSamples = Math.round(durationSec * sampleRate);
  const { left: busL, right: busR } = allocateStereoBuffer(totalSamples);

  const allNotes = [];
  for (const n of session.schedule.A) allNotes.push({ ...n, voice: 'A' });
  for (const n of session.schedule.B) allNotes.push({ ...n, voice: 'B' });
  allNotes.sort((a, b) => a.startSec - b.startSec);

  for (const note of allNotes) {
    if (note.startSec >= durationSec) continue;
    const panBase = note.voice === 'A' ? -0.35 : 0.4;
    renderNoteIntoBus(note, { busL, busR, sampleRate, scale: session.scale, rng: session.rng, panBase });
  }

  const reverb = makeReverb({ sampleRate, ...REVERB_PRESETS[reverbPreset], wetMix: REVERB_WET_MIX_OVERRIDE });
  for (let i = 0; i < totalSamples; i++) {
    const { outL, outR } = processReverbSample(reverb, busL[i], busR[i]);
    busL[i] = softClip(outL);
    busR[i] = softClip(outR);
  }

  const declickSamples = Math.min(totalSamples, Math.round(0.03 * sampleRate));
  for (let i = 0; i < declickSamples; i++) {
    const idx = totalSamples - declickSamples + i;
    const g = i / declickSamples;
    busL[idx] *= g;
    busR[idx] *= g;
  }

  if (hasNonFinite(busL, busR)) {
    throw new Error('renderImprovDuo produced non-finite samples -- this indicates a DSP bug, not a valid render.');
  }

  const overlapStats = computeOverlapStats(session, durationSec);

  return {
    sampleRate,
    numChannels: 2,
    left: Float32Array.from(busL),
    right: Float32Array.from(busR),
    durationSec,
    peak: peakOf(busL, busR),
    rms: rmsOf(busL, busR),
    phraseLog: session.phraseLog,
    macroFormLog: session.macroFormLog,
    vocabulary: session.vocabulary,
    overlapStats,
    session,
  };
}
