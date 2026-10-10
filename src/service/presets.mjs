// presets.mjs
//
// Game-oriented presets and request-parameter resolution for the HTTP
// service (http-server.mjs). Everything here is a thin layer *on top of*
// renderTrack() (src/generative/compose.mjs) -- it only ever calls that
// function with the parameters it already documents (durationSec,
// sampleRate, seed, mode, root, reverbPreset, melody) and never reaches
// into the generative internals (regime.mjs/flow.mjs/cover.mjs/thermo.mjs/
// melody.mjs) directly.
//
// Two real, honest limitations documented up front (see src/service/README.md
// for the full writeup):
//
// 1. Stinger presets are short (2-6s) one-shots, but this engine has no
//    fast-attack/percussive voice (envelope.mjs's own header comment: "This
//    module deliberately has no fast-attack/percussive mode"). The pad
//    voice's attack is always randomized in [3, 6]s (compose.mjs's
//    makeRenderVoice: `Math.max(2, nextRange(rng, 3, 6))`, and nextRange(3,6)
//    is already >= 3, so the floor of 2 never actually binds). A stinger
//    clip therefore always sounds like a *swelling rise*, not a struck hit.
//    The curve is steep (exponential k=5, strongly front-loaded: ~57-82% of
//    sustain level is already reached by 1-2s in, even in the slowest
//    attack draw), so short clips are NOT silent or inaudible -- but they
//    never read as percussive. Stinger presets are named/tuned around that
//    reality ("swell", "rise") rather than promising a "hit".
//
//    Separately: melody.mjs's foreground layer *never* triggers for any
//    renderTrack() call with durationSec <= MELODY_MIN_TRAILING_SILENCE_SEC
//    (18s, a compose.mjs constant) regardless of the `melody` flag --
//    compose.mjs's own gate is `transportTimeSec < durationSec - 18`, which
//    is never true at t=0 when durationSec <= 18. So no stinger preset can
//    ever carry the (faster, more present) melodic voice; stinger presets
//    below always set melody: false explicitly to make that honest rather
//    than silently relying on a threshold the caller can't see.
//
// 2. renderTrack()'s buffer ends with a hard 30ms linear declick-to-zero at
//    the raw sample-buffer boundary (compose.mjs's END_DECLICK_SEC), purely
//    to avoid a sample discontinuity on truncation -- it is NOT a loop
//    point and concatenating two renders back-to-back is audible as a
//    fade-to-silence-then-restart gap, not a loop. renderLoopableTrack()
//    below fixes this for the "ambient bed" presets with a genuine
//    equal-power crossfade: it renders `loopSec + fadeSec` of real
//    generative material, then blends the first `fadeSec` against the
//    *tail* fadeSec of that same continuous render, so what plays right
//    after the loop point is a smooth blend into material that was always
//    the real continuation of what came right before the loop point -- not
//    a repeat of the same head content and not a hard cut. See
//    verify-loop.mjs for the measured seam quality.

import { REVERB_PRESETS } from "@red-cup-engineering/computer-audio-engineering-services-section/reverb";
import { peakOf, rmsOf } from "@red-cup-engineering/computer-audio-engineering-services-section/mixer";
import { renderTrack } from '../generative/compose.mjs';
import { DEFAULT_RANDOM_CARDINALITY_RANGE } from '../generative/scale.mjs';

export const KNOWN_MODES = Object.freeze(['dorian', 'aeolian', 'majorPentatonic', 'minorPentatonic']);
export const KNOWN_REVERB_PRESETS = Object.freeze(Object.keys(REVERB_PRESETS));
// Mirrors scale.mjs's own (unexported) NOTE_NAME_TO_PC table -- sharps only,
// no flat spellings. Kept here only so bad root names can be rejected with
// a clean 400 before a render worker is spawned; if this list ever drifts
// from scale.mjs's, makeScale()'s own "Unknown root note" throw is still
// the backstop (surfaced by http-server.mjs as a 500, since by that point
// it's already past this pre-validation).
export const KNOWN_ROOTS = Object.freeze(['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B']);

export const DEFAULT_SAMPLE_RATE = 44100;
export const DEFAULT_MODE = 'dorian';
export const DEFAULT_ROOT = 'D';
export const DEFAULT_REVERB_PRESET = 'deepAmbient';
export const DEFAULT_LOOP_FADE_SEC = 5;

// --- Real scale-generator parameter surface (scale.mjs's maximal-evenness
// generator, exposed directly rather than gated behind the 4 legacy named
// modes) --------------------------------------------------------------------
//
// `mode` on a /generate body now accepts EITHER a legacy name (one of
// KNOWN_MODES, resolved the same way it always was) OR a direct
// {cardinality, rotation} generator-coordinate object -- the real thing
// scale.mjs's generateModeIntervals() takes, per its own header comment:
// "any cardinality 2..11 ... at any of its own rotations ... a combinatorially
// large space of valid modes (65 distinct shapes at c=12 alone) rather than 4
// retrievable names." This does not require any change to compose.mjs:
// makeScale({root, mode}) -> modeIntervals(mode) already branches on
// `typeof mode === 'object'` and calls generateModeIntervals(mode) directly,
// so an object mode has been usable since that refactor landed -- this
// service layer just needed to stop rejecting it at the door.
//
// chromaticUniverse is deliberately NOT exposed as a tunable field, and is
// always forced to 12 here even though generateModeIntervals() itself takes
// it as a parameter. Reason, traced through the actual code: scale.mjs's
// pitchClassBit() (used by buildScaleBitmask, and by every downstream
// bitmask consumer in cover.mjs/flow.mjs) always reduces mod 12 regardless
// of what chromaticUniverse produced the interval list --
// `1 << (((pc % 12) + 12) % 12)`. A chromaticUniverse other than 12 would
// generate intervals in [0, chromaticUniverse) that then get silently folded
// back onto the same 12 bits by pitchClassBit, which can collapse distinct
// generated pitch classes onto the same bit (fewer sounding pitch classes
// than the requested cardinality) rather than producing an actual
// microtonal scale. Exposing it as a free parameter would let a caller hit
// that silent collapse; rejecting anything but 12 keeps the API honest
// about what the engine's bitmask machinery can actually represent.
export const MODE_CARDINALITY_LIMITS = Object.freeze({ min: 2, max: 11 });
export const SCALE_CHROMATIC_UNIVERSE = 12;
export { DEFAULT_RANDOM_CARDINALITY_RANGE };

// Measured wall-clock-to-audio-duration ratio (src/service/README.md,
// http-server.mjs's own header comment): ~1:9, i.e. a 30s render takes
// ~3.3s. Exposed via /schema so a client (the web GUI, or any other caller)
// can show an honest "about Ns" estimate instead of either a naive blocking
// spinner or a fake progress bar with no real basis.
export const ESTIMATED_RENDER_SECONDS_PER_AUDIO_SECOND = 1 / 9;

function isPlainObject(x) {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/**
 * Validates and normalizes a /generate body's `mode` field, which may be a
 * legacy mode name (string) or a direct {cardinality, rotation,
 * chromaticUniverse?} generator-coordinate object. Pushes onto `errors` and
 * returns the value unchanged (or best-effort normalized) on failure, same
 * convention as the rest of this file's validation -- callers check
 * errors.length, not this function's return value, to decide pass/fail.
 * @param {string|{cardinality:number, rotation?:number, chromaticUniverse?:number}} mode
 * @param {string[]} errors
 * @returns {string|{cardinality:number, rotation:number, chromaticUniverse:number}}
 */
export function validateAndNormalizeMode(mode, errors) {
  if (typeof mode === 'string') {
    if (!KNOWN_MODES.includes(mode)) {
      errors.push(`mode must be one of: ${KNOWN_MODES.join(', ')}, or a {cardinality, rotation} generator-coordinate object (see GET /schema)`);
    }
    return mode;
  }

  if (isPlainObject(mode)) {
    const cardinality = Number(mode.cardinality);
    const rotation = mode.rotation === undefined ? 0 : Number(mode.rotation);
    const chromaticUniverse = mode.chromaticUniverse === undefined ? SCALE_CHROMATIC_UNIVERSE : Number(mode.chromaticUniverse);

    if (chromaticUniverse !== SCALE_CHROMATIC_UNIVERSE) {
      errors.push(`mode.chromaticUniverse must be ${SCALE_CHROMATIC_UNIVERSE} (or omitted) -- the engine's pitch-class bitmask machinery is fixed at a 12-semitone chromatic universe; a different value would silently fold generated intervals back onto the same 12 bits rather than producing a real microtonal scale`);
    }
    if (!Number.isInteger(cardinality) || cardinality < MODE_CARDINALITY_LIMITS.min || cardinality > MODE_CARDINALITY_LIMITS.max) {
      errors.push(`mode.cardinality must be an integer between ${MODE_CARDINALITY_LIMITS.min} and ${MODE_CARDINALITY_LIMITS.max} (2..11 at chromaticUniverse=12 -- 1 and 12 are the degenerate single-note/fully-chromatic cases)`);
    } else if (!Number.isInteger(rotation) || rotation < 0 || rotation >= cardinality) {
      errors.push(`mode.rotation must be an integer between 0 and mode.cardinality-1 (${cardinality - 1} for cardinality ${cardinality}) -- it selects which member of the maximally-even set becomes the new tonic`);
    }

    return { cardinality, rotation, chromaticUniverse: SCALE_CHROMATIC_UNIVERSE };
  }

  errors.push(`mode must be a known mode name (${KNOWN_MODES.join(', ')}) or a {cardinality, rotation} generator-coordinate object`);
  return mode;
}

// Server-side sanity bounds, not an engine limitation -- these exist purely
// to stop a single HTTP request from tying up the render worker for an
// unreasonable amount of time. At the measured ~1:9 render-time-to-audio-
// duration ratio, a 300s (5 minute) render costs roughly 33s of wall clock;
// that is already a long time to hold an HTTP request open and is treated
// as the practical ceiling. See src/service/README.md for the full
// reasoning and how to change these.
export const DURATION_LIMITS = Object.freeze({ minSec: 0.5, maxSec: 300 });
export const LOOP_LIMITS = Object.freeze({ minLoopSec: 10, maxLoopSec: 300, minFadeSec: 0.5, maxFadeFraction: 0.4 });

// --- Stinger presets (2-6s one-shots for game events) ----------------------
//
// All explicitly melody:false -- see header comment above for why melody
// can never trigger at these durations regardless of the flag; being
// explicit here documents that rather than leaning on an invisible
// threshold elsewhere.
export const STINGER_PRESETS = Object.freeze({
  'stinger-success': Object.freeze({
    kind: 'stinger',
    durationSec: 6,
    mode: 'majorPentatonic',
    root: 'D',
    reverbPreset: 'chamber',
    melody: false,
    description:
      'Bright pentatonic rising swell with a short, tight reverb tail. Reads as a soft "positive outcome" cue, not a percussive hit -- this engine has no fast-attack voice. 6s (the longer end of the stinger range) gives the attack curve room to actually approach its sustain level before the clip ends.',
  }),
  'stinger-tension': Object.freeze({
    kind: 'stinger',
    durationSec: 4,
    mode: 'minorPentatonic',
    root: 'A',
    reverbPreset: 'hall',
    melody: false,
    description:
      'Darker minor-pentatonic rising swell with a longer, more diffuse reverb tail. Reads as unresolved/uneasy rather than a sharp jump-scare stab -- same swell character as stinger-success, different mode/reverb.',
  }),
  'stinger-resolve': Object.freeze({
    kind: 'stinger',
    durationSec: 5,
    mode: 'dorian',
    root: 'D',
    reverbPreset: 'deepAmbient',
    melody: false,
    description:
      'Mid-length swell in the engine\'s default dorian/deepAmbient voice, for a generic "something happened" cue when success/tension framing doesn\'t apply.',
  }),
});

// --- Loopable ambient bed presets (30s-a few minutes, crossfade-looped) ----
export const BED_PRESETS = Object.freeze({
  'bed-calm': Object.freeze({
    kind: 'bed',
    loop: true,
    loopSec: 60,
    loopFadeSec: 6,
    mode: 'majorPentatonic',
    root: 'D',
    reverbPreset: 'deepAmbient',
    melody: true,
    description: 'Long-decay, bright pentatonic bed. Melody layer on (60s clears the 18s melody-gate easily).',
  }),
  'bed-tense': Object.freeze({
    kind: 'bed',
    loop: true,
    loopSec: 45,
    loopFadeSec: 5,
    mode: 'minorPentatonic',
    root: 'A',
    reverbPreset: 'hall',
    melody: true,
    description: 'Darker pentatonic bed, medium reverb decay.',
  }),
  'bed-neutral': Object.freeze({
    kind: 'bed',
    loop: true,
    loopSec: 90,
    loopFadeSec: 8,
    mode: 'dorian',
    root: 'D',
    reverbPreset: 'chamber',
    melody: true,
    description: 'Engine default mode, tightest reverb of the three bed presets -- least "wash", most legible melodic layer.',
  }),
});

export const PRESETS = Object.freeze({ ...STINGER_PRESETS, ...BED_PRESETS });

// --- Mood / intensity mapping -----------------------------------------------
//
// HONESTY NOTE (see src/service/README.md for the full version): this is
// NOT modulation of the generative engine's actual behavior. thermo.mjs's
// computeTemperature() -- the one thing in this codebase that actually
// governs "how much is happening" (detune spread, filter jitter, onset
// jitter) -- is entirely internal to compose.mjs's per-window tick loop and
// is not a parameter renderTrack() accepts. There is no legitimate way to
// reach it from this service without editing compose.mjs, which is out of
// scope (it's actively being edited by another pass). So "mood"/"intensity"
// here is *only* ever a choice among mode/root/reverbPreset -- three fixed
// buckets, picked by name or by bucketing a 0-1 number into thirds. It
// changes the pitch material and the reverb character. It does not change
// voice density, section pacing, or the humanization amount.
//
// This is also, deliberately, where a future real "energy" input would
// attach and NOT where it lives today: `intensity` already accepts a plain
// 0-1 number, which is the right *shape* for something eventually driven by
// an external signal (e.g. live activity data), but right now that number
// only selects one of 3 fixed buckets -- it does not reach thermo.mjs's
// temperature or regime.mjs's classifier, because those aren't parameters
// compose.mjs's renderTrack() exposes. Wiring a real numeric energy input
// through to compose.mjs's tick loop is future work, tracked here rather
// than silently implied by the fact that `intensity` already takes a
// number.
export const MOOD_PRESETS = Object.freeze({
  calm: Object.freeze({ mode: 'majorPentatonic', root: 'D', reverbPreset: 'deepAmbient' }),
  resolving: Object.freeze({ mode: 'dorian', root: 'D', reverbPreset: 'chamber' }),
  tense: Object.freeze({ mode: 'minorPentatonic', root: 'A', reverbPreset: 'hall' }),
});

/**
 * Buckets a continuous 0-1 intensity value into one of the three named
 * moods. Three discrete buckets, not a continuous interpolation -- there is
 * nothing underneath this to interpolate between (see honesty note above).
 * @param {number} intensity
 * @returns {'calm'|'resolving'|'tense'}
 */
export function intensityToMoodName(intensity) {
  const x = Math.max(0, Math.min(1, intensity));
  if (x < 1 / 3) return 'calm';
  if (x < 2 / 3) return 'resolving';
  return 'tense';
}

function resolveMoodParams(mood, intensity, errors) {
  if (mood !== undefined) {
    const params = MOOD_PRESETS[mood];
    if (!params) {
      errors.push(`unknown mood "${mood}" -- known moods: ${Object.keys(MOOD_PRESETS).join(', ')}`);
      return {};
    }
    return { ...params };
  }
  if (intensity !== undefined) {
    const n = Number(intensity);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      errors.push('intensity must be a number in [0, 1]');
      return {};
    }
    return { ...MOOD_PRESETS[intensityToMoodName(n)] };
  }
  return {};
}

/**
 * Resolves a POST /generate JSON body into a concrete parameter object
 * ready to hand to renderTrack() (or renderLoopableTrack()), applying
 * defaults, presets, mood/intensity, and validation. Precedence (highest
 * first): explicit fields in the request body > named preset > mood/
 * intensity > built-in defaults. That order is deliberate: a preset
 * pins down a whole known-good combination, mood/intensity only fills in
 * what a preset didn't, and any field the caller states outright always
 * wins.
 * @param {object} body
 * @returns {{ok:true, params:object}|{ok:false, errors:string[]}}
 */
export function resolveGenerateParams(body = {}) {
  const errors = [];

  let preset;
  if (body.preset !== undefined) {
    preset = PRESETS[body.preset];
    if (!preset) errors.push(`unknown preset "${body.preset}" -- known presets: ${Object.keys(PRESETS).join(', ')}`);
  }

  const moodParams = resolveMoodParams(body.mood, body.intensity, errors);

  const loop = body.loop !== undefined ? Boolean(body.loop) : Boolean(preset?.loop);

  const merged = {
    sampleRate: DEFAULT_SAMPLE_RATE,
    mode: DEFAULT_MODE,
    root: DEFAULT_ROOT,
    reverbPreset: DEFAULT_REVERB_PRESET,
    melody: loop, // loopable beds default melody on, stingers default off
    ...moodParams,
    ...(preset ? { mode: preset.mode, root: preset.root, reverbPreset: preset.reverbPreset, melody: preset.melody } : {}),
    seed: body.seed,
    loop,
  };

  if (body.mode !== undefined) merged.mode = body.mode;
  if (body.root !== undefined) merged.root = body.root;
  if (body.reverbPreset !== undefined) merged.reverbPreset = body.reverbPreset;
  if (body.melody !== undefined) merged.melody = Boolean(body.melody);
  if (body.sampleRate !== undefined) merged.sampleRate = Number(body.sampleRate);

  if (loop) {
    merged.loopSec = body.loopSec ?? body.durationSec ?? preset?.loopSec;
    merged.loopFadeSec = body.loopFadeSec ?? preset?.loopFadeSec ?? DEFAULT_LOOP_FADE_SEC;
  } else {
    merged.durationSec = body.durationSec ?? preset?.durationSec;
  }

  // --- validation --------------------------------------------------------
  merged.mode = validateAndNormalizeMode(merged.mode, errors);
  if (!KNOWN_REVERB_PRESETS.includes(merged.reverbPreset)) {
    errors.push(`reverbPreset must be one of: ${KNOWN_REVERB_PRESETS.join(', ')}`);
  }
  if (!KNOWN_ROOTS.includes(merged.root)) {
    errors.push(`root must be one of: ${KNOWN_ROOTS.join(', ')}`);
  }
  if (merged.sampleRate !== undefined && (!Number.isFinite(merged.sampleRate) || merged.sampleRate < 8000 || merged.sampleRate > 192000)) {
    errors.push('sampleRate must be a number between 8000 and 192000');
  }

  if (loop) {
    if (!Number.isFinite(merged.loopSec) || merged.loopSec <= 0) {
      errors.push('loopSec (or durationSec, or a bed preset) must be a positive number when loop is requested');
    } else if (merged.loopSec < LOOP_LIMITS.minLoopSec || merged.loopSec > LOOP_LIMITS.maxLoopSec) {
      errors.push(`loopSec must be between ${LOOP_LIMITS.minLoopSec} and ${LOOP_LIMITS.maxLoopSec} seconds`);
    }
    if (!Number.isFinite(merged.loopFadeSec) || merged.loopFadeSec < LOOP_LIMITS.minFadeSec) {
      errors.push(`loopFadeSec must be at least ${LOOP_LIMITS.minFadeSec} seconds`);
    } else if (Number.isFinite(merged.loopSec) && merged.loopFadeSec > merged.loopSec * LOOP_LIMITS.maxFadeFraction) {
      errors.push(`loopFadeSec must not exceed ${LOOP_LIMITS.maxFadeFraction * 100}% of loopSec (crossfade can't be most of the loop)`);
    }
  } else {
    if (!Number.isFinite(merged.durationSec) || merged.durationSec <= 0) {
      errors.push('durationSec (or a stinger/bed preset) must be a positive number');
    } else if (merged.durationSec < DURATION_LIMITS.minSec || merged.durationSec > DURATION_LIMITS.maxSec) {
      errors.push(`durationSec must be between ${DURATION_LIMITS.minSec} and ${DURATION_LIMITS.maxSec} seconds`);
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, params: merged };
}

/**
 * Renders a genuinely loop-friendly ambient bed by rendering
 * `loopSec + loopFadeSec` seconds of real continuous generative material
 * and equal-power-crossfading the tail `loopFadeSec` seconds into the head
 * `loopFadeSec` seconds, producing an output buffer exactly `loopSec` long.
 *
 * Why this works: renderTrack() produces one continuous buffer, so the
 * "tail" region [loopSec, loopSec+loopFadeSec) is the *actual* generative
 * continuation of the "head" region [0, loopFadeSec) -- not synthesized
 * separately. At the very start of the crossfade window the output is
 * dominated by the tail (i.e. it continues smoothly from whatever was
 * playing right before the loop point), and it smoothly hands off to the
 * true head content by the end of the window. Concatenating the output
 * with itself therefore never has the sample sequence "jump" to unrelated
 * material -- it only ever blends between two points that were already
 * adjacent-in-time in one continuous render. See verify-loop.mjs for a
 * measured check of how small the seam discontinuity actually is.
 *
 * The engine's own END_DECLICK_SEC (0.03s) fade-to-zero always lands at the
 * very end of the rendered buffer, i.e. inside the tail region near the end
 * of the crossfade window, where the equal-power fade-out weight is already
 * ~0 -- so it does not introduce an audible dip in the loop.
 *
 * @param {object} params - loopSec, loopFadeSec, plus the usual renderTrack params (sampleRate, seed, mode, root, reverbPreset, melody)
 * @returns {{sampleRate:number, numChannels:number, left:Float32Array, right:Float32Array, durationSec:number, loopSec:number, loopFadeSec:number, peak:number, rms:number, sourceDurationSec:number, finalRegime:string, spiralCount:number, melodyNoteOnsets:number}}
 */
export function renderLoopableTrack({ loopSec, loopFadeSec = DEFAULT_LOOP_FADE_SEC, sampleRate = DEFAULT_SAMPLE_RATE, seed, mode = DEFAULT_MODE, root = DEFAULT_ROOT, reverbPreset = DEFAULT_REVERB_PRESET, melody = true } = {}) {
  if (!(loopSec > 0)) throw new Error('loopSec must be a positive number');
  if (!(loopFadeSec > 0)) throw new Error('loopFadeSec must be a positive number');

  const loopSamples = Math.round(loopSec * sampleRate);
  const fadeSamples = Math.round(loopFadeSec * sampleRate);
  const totalSamples = loopSamples + fadeSamples;
  // Feed renderTrack an exact, sample-aligned duration (rather than
  // loopSec + loopFadeSec as floats) so totalSamples below is guaranteed to
  // match Math.round(durationSec * sampleRate) inside renderTrack exactly.
  const totalDurationSec = totalSamples / sampleRate;

  const track = renderTrack({ durationSec: totalDurationSec, sampleRate, seed, mode, root, reverbPreset, melody });
  const { left, right } = track;

  if (left.length !== totalSamples) {
    // Defensive: should not happen given the sample-aligned duration above,
    // but if renderTrack's rounding ever changes, fail loudly rather than
    // silently reading out of bounds.
    throw new Error(`renderLoopableTrack: expected ${totalSamples} samples from renderTrack, got ${left.length}`);
  }

  const outL = new Float32Array(loopSamples);
  const outR = new Float32Array(loopSamples);

  // Middle: unchanged, straight copy of the real render.
  for (let i = fadeSamples; i < loopSamples; i++) {
    outL[i] = left[i];
    outR[i] = right[i];
  }

  // Crossfade window: equal-power blend of head=[0,fadeSamples) against
  // tail=[loopSamples,loopSamples+fadeSamples).
  for (let i = 0; i < fadeSamples; i++) {
    const t = fadeSamples > 1 ? i / (fadeSamples - 1) : 1;
    const gIn = Math.sin((Math.PI / 2) * t); // head fades in
    const gOut = Math.cos((Math.PI / 2) * t); // tail (loop continuation) fades out
    const tailIdx = loopSamples + i;
    outL[i] = left[i] * gIn + left[tailIdx] * gOut;
    outR[i] = right[i] * gIn + right[tailIdx] * gOut;
  }

  return {
    sampleRate,
    numChannels: 2,
    left: outL,
    right: outR,
    durationSec: loopSamples / sampleRate,
    loopSec: loopSamples / sampleRate,
    loopFadeSec: fadeSamples / sampleRate,
    peak: peakOf(outL, outR),
    rms: rmsOf(outL, outR),
    sourceDurationSec: totalDurationSec,
    finalRegime: track.finalRegime,
    spiralCount: track.spiralCount,
    melodyNoteOnsets: track.melodyNoteOnsets,
  };
}

/**
 * Measures how discontinuous a crossfade-looped buffer's seam actually is,
 * by concatenating it with itself and comparing the sample-to-sample jump
 * at the seam (last sample of copy 1 -> first sample of copy 2) against the
 * typical sample-to-sample jump size elsewhere in the buffer. A seam jump
 * on the same order as (or smaller than) the typical in-buffer jump means
 * the loop point is not distinguishable from ordinary signal movement; a
 * seam jump much larger than typical is an audible click/gap.
 * @param {{left:Float32Array, right:Float32Array}} track
 * @returns {{typicalJump:number, seamJump:number, ratio:number, seamJumpDb:number, typicalJumpDb:number}}
 */
export function measureLoopSeam(track) {
  const { left, right } = track;
  const n = left.length;

  let sumAbsDiff = 0;
  for (let i = 1; i < n; i++) {
    sumAbsDiff += Math.abs(left[i] - left[i - 1]) + Math.abs(right[i] - right[i - 1]);
  }
  const typicalJump = sumAbsDiff / (2 * (n - 1));

  const seamJump = (Math.abs(left[0] - left[n - 1]) + Math.abs(right[0] - right[n - 1])) / 2;

  const toDb = (x) => (x > 0 ? 20 * Math.log10(x) : -Infinity);

  return {
    typicalJump,
    seamJump,
    ratio: typicalJump > 0 ? seamJump / typicalJump : Infinity,
    seamJumpDb: toDb(seamJump),
    typicalJumpDb: toDb(typicalJump),
  };
}

// --- GET /schema -------------------------------------------------------
//
// A structured, machine-readable description of the actual /generate
// parameter space -- every field below is a real parameter checked in
// resolveGenerateParams() above, not aspirational. Each entry's `type` is
// one of a small generic vocabulary (number, boolean, enum, oneOf) a client
// can dispatch on without knowing the field names in advance, which is what
// lets the web GUI (src/service/web/) build its controls by reading this
// response rather than hardcoding today's parameter set. If a field is ever
// added or changed here, the GUI adapts without a code change on its side.
//
// This is deliberately flat and typed rather than a hand-drawn form
// description: a future numeric input (e.g. an externally-driven "energy"
// signal, see the honesty note above MOOD_PRESETS) would be one more entry
// of type "number" in this same list, not a new response shape.

/**
 * Builds the GET /schema response: a structured description of every real
 * /generate field, its type/bounds, and a plain-language note on what it
 * actually does (and, where relevant, what it does NOT reach -- see the
 * mood/intensity and reverbPreset entries).
 * @returns {object}
 */
export function buildParameterSchema() {
  return {
    parameters: {
      durationSec: {
        type: 'number',
        min: DURATION_LIMITS.minSec,
        max: DURATION_LIMITS.maxSec,
        default: 30,
        unit: 'sec',
        step: 0.5,
        appliesWhen: { loop: false },
        description: 'Track length. Ignored when loop is true (use loopSec instead). Render wall-clock time scales with this -- see estimatedRenderSecondsPerAudioSecond below.',
      },
      loop: {
        type: 'boolean',
        default: false,
        description: 'Request a crossfade-looped ambient bed instead of a single plain clip. renderTrack() itself has no loop concept -- renderLoopableTrack() (presets.mjs) renders loopSec+loopFadeSec seconds of one continuous take and equal-power-crossfades the tail into the head, so the seam blends two points that were always adjacent in the same render rather than splicing unrelated material.',
      },
      loopSec: {
        type: 'number',
        min: LOOP_LIMITS.minLoopSec,
        max: LOOP_LIMITS.maxLoopSec,
        default: 60,
        unit: 'sec',
        step: 1,
        appliesWhen: { loop: true },
        description: 'Audible loop length when loop is true.',
      },
      loopFadeSec: {
        type: 'number',
        min: LOOP_LIMITS.minFadeSec,
        maxFractionOfLoopSec: LOOP_LIMITS.maxFadeFraction,
        default: DEFAULT_LOOP_FADE_SEC,
        unit: 'sec',
        step: 0.5,
        appliesWhen: { loop: true },
        description: `Crossfade length at the loop point, must not exceed ${LOOP_LIMITS.maxFadeFraction * 100}% of loopSec.`,
      },
      sampleRate: {
        type: 'number',
        min: 8000,
        max: 192000,
        default: DEFAULT_SAMPLE_RATE,
        unit: 'Hz',
        step: 100,
        description: 'Output sample rate.',
      },
      seed: {
        type: 'string',
        optional: true,
        description: 'Integer or string PRNG seed. Omit for a time-based (non-reproducible) seed; the same seed plus the same other parameters reproduces the same render exactly (random.mjs is a deterministic PRNG).',
      },
      root: {
        type: 'enum',
        values: KNOWN_ROOTS,
        default: DEFAULT_ROOT,
        description: 'Tonic pitch class name (sharps only, e.g. "D#" not "Eb").',
      },
      mode: {
        type: 'oneOf',
        default: DEFAULT_MODE,
        description:
          'The scale/mode. Generated from maximal evenness (Clough & Douthett 1991), not looked up from a fixed table: for a chromatic universe of 12 pitch classes and a target note count d ("cardinality"), the maximally-even d-note subset spreads its members as evenly as possible around the 12-pitch-class circle. Rotating that set to start at a different member ("rotation") is what turns the same underlying collection into different named modes -- e.g. cardinality 7 rotation 5 is exactly Dorian, rotation 2 is exactly Aeolian; cardinality 5 rotation 3/2 are the two pentatonic collections. Any (cardinality, rotation) pair is a real, valid mode, not just the 4 named ones.',
        options: [
          {
            kind: 'named',
            values: KNOWN_MODES,
            description: 'The 4 classically-recognizable special cases, by name -- shorthand for specific (cardinality, rotation) coordinates (dorian = 7,5; aeolian = 7,2; majorPentatonic = 5,3; minorPentatonic = 5,2).',
          },
          {
            kind: 'coordinates',
            description: 'Direct generator coordinates, for the full space beyond the 4 named modes.',
            fields: {
              cardinality: {
                type: 'number',
                min: MODE_CARDINALITY_LIMITS.min,
                max: MODE_CARDINALITY_LIMITS.max,
                default: 7,
                step: 1,
                recommendedRange: DEFAULT_RANDOM_CARDINALITY_RANGE,
                description: `Notes per octave. ${MODE_CARDINALITY_LIMITS.min}..${MODE_CARDINALITY_LIMITS.max} (1 and 12 are the degenerate single-note / fully-chromatic cases, excluded). 7 = diatonic-family collections (includes major/minor and the church modes), 5 = pentatonic-family, 6 = whole-tone. recommendedRange is scale.mjs's own genre-appropriateness suggestion for this engine specifically (wide enough for whole-tone/diatonic-adjacent collections, narrow enough to avoid the sparse low end and the near-chromatic, dissonance-prone high end) -- not an API limit, just a starting-point hint.`,
              },
              rotation: {
                type: 'number',
                min: 0,
                maxExclusive: 'cardinality',
                default: 0,
                step: 1,
                description: 'Which member of the maximally-even set becomes the new tonic (0..cardinality-1). Changes which of the cardinality-many rotations of the same underlying collection you get -- same pitch-class set, different starting/resolving note.',
              },
              chromaticUniverse: {
                type: 'number',
                fixed: SCALE_CHROMATIC_UNIVERSE,
                description: `Always ${SCALE_CHROMATIC_UNIVERSE} -- not tunable. The engine's pitch-class bitmask machinery (scale.mjs's pitchClassBit, reused throughout cover.mjs/flow.mjs) always reduces mod 12, so any other chromaticUniverse would silently fold generated intervals back onto the same 12 bits rather than producing a real microtonal scale. Included here only so the field is self-describing if it's ever loosened.`,
              },
            },
          },
        ],
      },
      reverbPreset: {
        type: 'enum',
        values: REVERB_PRESETS,
        default: DEFAULT_REVERB_PRESET,
        description: 'Named reverb character. Not independently tunable per-parameter through this API -- compose.mjs only accepts a preset name and looks up its {decaySec, dampingHz, stereoSpread, wetMix} internally (see dsp/reverb.mjs). The actual DSP numbers for each preset are included in `values` above (real numbers, not a black-box label) so a caller/GUI can show what "hall" vs "chamber" actually means in seconds and Hz.',
      },
      melody: {
        type: 'boolean',
        default: true,
        description: `Layer the foreground melodic line (melody.mjs, motif shapes drawn from motif-grammar.mjs's Lambek-calculus-based grammar) over the drone/pad bed. Has no audible effect when the render is short: melody.mjs's own gate never fires within the last ${18}s of a render's trailing silence budget, so any durationSec/loopSec <= 18 never has room for a phrase to complete regardless of this flag.`,
      },
      mood: {
        type: 'enum',
        values: Object.keys(MOOD_PRESETS),
        optional: true,
        description: 'Convenience: picks one of 3 fixed (mode, root, reverbPreset) bundles by name -- see moodBundles for the actual values. NOT a generation-energy control (see intensity below); any explicit mode/root/reverbPreset field in the same request still wins over this.',
      },
      intensity: {
        type: 'number',
        min: 0,
        max: 1,
        optional: true,
        description: 'Convenience: buckets a 0-1 number into thirds onto the same 3 mood bundles as `mood` (not a continuous interpolation -- there is nothing continuous underneath it to interpolate). HONESTY NOTE: this does not reach thermo.mjs\'s temperature or regime.mjs\'s classifier -- those govern the actual "how much is happening" (voice density, jitter, section pacing) but are internal to compose.mjs\'s tick loop and are not renderTrack() parameters. A real externally-driven energy input (e.g. from a live activity signal) would need to be wired into compose.mjs itself, which does not exist yet; this field only ever changes pitch material and reverb character, exactly like `mood`.',
      },
      preset: {
        type: 'enum',
        values: Object.keys(PRESETS),
        optional: true,
        description: 'Named starting point (see GET /presets) supplying defaults for the fields above; any field also given explicitly in the same request body overrides the preset\'s value for that field.',
      },
    },
    moodBundles: MOOD_PRESETS,
    limits: { duration: DURATION_LIMITS, loop: LOOP_LIMITS, modeCardinality: MODE_CARDINALITY_LIMITS },
    estimatedRenderSecondsPerAudioSecond: ESTIMATED_RENDER_SECONDS_PER_AUDIO_SECOND,
    notes: [
      'estimatedRenderSecondsPerAudioSecond is a measured ratio (see src/service/README.md), not a guarantee -- actual render time depends on the host machine and how many renders are running concurrently (MAX_CONCURRENT_RENDERS).',
      'Fields not listed here (e.g. per-voice timbre, filter cutoff, register spread, section length) are real machinery in this engine (thermo.mjs, regime.mjs, dsp/oscillator.mjs) but are not parameters renderTrack() accepts, so this service has no legitimate way to expose them yet.',
    ],
  };
}
