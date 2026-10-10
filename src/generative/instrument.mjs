// instrument.mjs
//
// Generalizes the DSP "voice recipe" that compose.mjs still hardcodes once
// per role (one fixed oscillator/envelope/filter/pan recipe for the pad bed,
// a second fixed recipe for the melody line) into a plain data shape -- an
// "instrument definition" -- plus one builder function that turns a
// definition into a concrete voice's oscillator/envelope/filter/pan state.
//
// Status: this module is genuine, generic DSP-level infrastructure (a
// definition -> voice builder, not a musical decision of any kind) written
// during an earlier, interrupted refactor that also added a "style config"
// layer (src/generative/styles/ambient-drone.mjs, styles/game-stinger.mjs)
// to supply instrument definitions. That style-config layer was removed: it
// was two hand-picked preset objects behind a name, which is exactly the
// "hardcoded enum" pattern the rest of this refactor replaced elsewhere
// (scale.mjs's modes, melody.mjs's motif shapes) with real generators --
// adding a second style preset did not fix that, it repeated it one level
// up. This module survives that removal because it isn't itself a preset
// table: it is a reusable constructor a *future* continuous parameter
// vector (duration/energy/attack-bias/density -> instrument definition)
// could target instead of a style name. It is currently unused by
// compose.mjs (which still builds its two voice recipes inline) and
// untested for that reason -- kept as available infrastructure, not wired
// in, so as not to overstate what changed. See the top-level README for the
// fuller account.
//
// Instrument definition shape (plain data, JSON-serializable except for the
// PARTIAL_PRESETS lookup):
//   {
//     waveform: 'additive'|'sine'|'triangle',
//     partialsName: string, // key into dsp/oscillator.mjs's PARTIAL_PRESETS; only read when waveform is 'additive' and no partialsOverride is supplied
//     envelope: {
//       attackSec: number | [min, max],  // fixed value, or a range to randomize per-voice-instance from
//       releaseSec: number | [min, max],
//       sustainLevel: number | [min, max],
//       curve: number, // always fixed -- curve steepness isn't meaningfully "ranged" the way timing/level are
//     },
//     filter: { type: 'lowpass'|'highpass', Q: number },
//     gain: number, // linear
//     pan: { depth: number, periodSec: number | [min, max] },
//   }
//
// A number|[min,max] field is resolved once per instantiateVoice() call via
// resolveParam -- this is the same "some knobs are randomized within a
// style-chosen range, some are pinned exact" pattern compose.mjs's old
// makeRenderVoice/makeMelodyVoice already used (e.g. the pad bed's attack
// was always a random draw in a range, the melody line's attack was always
// a single fixed value); it's just data now instead of two separate call
// sites each doing their own nextRange/plain-literal split.

import { makeOscillator, PARTIAL_PRESETS } from "@red-cup-engineering/computer-audio-engineering-services-section/oscillator";
import { makeEnvelope } from "@red-cup-engineering/computer-audio-engineering-services-section/envelope";
import { computeBiquadCoeffs, makeBiquad } from "@red-cup-engineering/computer-audio-engineering-services-section/filter";
import { nextRange, nextFloat } from './random.mjs';

/**
 * Resolves a number|[min,max] instrument-definition field to a concrete
 * number, randomizing from the range (uniform) if given one.
 * @param {{state:number}} rng
 * @param {number|[number,number]} value
 * @returns {number}
 */
function resolveParam(rng, value) {
  if (Array.isArray(value)) return nextRange(rng, value[0], value[1]);
  return value;
}

/**
 * Clamps a filter cutoff into a sane audio-band range for the given sample
 * rate: above a small floor (so it never collapses toward DC) and safely
 * below Nyquist (so a biquad's coefficients never become degenerate).
 * @param {number} hz
 * @param {number} sampleRate
 * @returns {number}
 */
export function clampCutoffHz(hz, sampleRate) {
  return Math.max(80, Math.min(sampleRate / 2 - 200, hz));
}

/**
 * Resolves an instrument definition's named partial preset to the actual
 * {ratio,amp}[] array, falling back to warmPad if the name is missing or
 * unknown -- the same fallback compose.mjs's original hardcoded recipes
 * used implicitly by always specifying a real preset name.
 * @param {object} instrumentDef
 * @returns {Array<{ratio:number, amp:number}>}
 */
export function resolvePartials(instrumentDef) {
  return (instrumentDef.partialsName && PARTIAL_PRESETS[instrumentDef.partialsName]) || PARTIAL_PRESETS.warmPad;
}

/**
 * Builds the oscillator/envelope/biquad/pan state for one voice from an
 * instrument definition. Pure construction only -- does not trigger the
 * envelope's attack; callers (compose.mjs's makeRenderVoice/makeMelodyVoice)
 * do that once they know the voice's actual onset time, since that's a
 * scheduling concern outside an instrument definition's job.
 * @param {object} instrumentDef - see this module's header comment for the shape
 * @param {object} opts
 * @param {number} opts.baseHz - the voice's fundamental frequency
 * @param {number} opts.sampleRate
 * @param {number} opts.cutoffHz - this voice's filter cutoff for right now (jitter/register-driven, computed by the caller)
 * @param {{state:number}} opts.rng
 * @param {Array<{ratio:number,amp:number}>} [opts.partialsOverride] - used instead of resolvePartials(instrumentDef) when the caller has already resolved a different partial set (e.g. melody.mjs's per-section timbre choice)
 * @returns {{oscillator:object, envelope:object, biquad:object, gain:number, panDepth:number, panPhase:number, panPeriodSec:number, attackSec:number, releaseSec:number, sustainLevel:number}}
 */
export function instantiateVoice(instrumentDef, { baseHz, sampleRate, cutoffHz, rng, partialsOverride }) {
  const partials = partialsOverride || resolvePartials(instrumentDef);
  const envSpec = instrumentDef.envelope || {};
  const attackSec = resolveParam(rng, envSpec.attackSec ?? 5);
  const releaseSec = resolveParam(rng, envSpec.releaseSec ?? 6);
  const sustainLevel = resolveParam(rng, envSpec.sustainLevel ?? 0.8);
  const curve = envSpec.curve ?? 5;

  const filterSpec = instrumentDef.filter || { type: 'lowpass', Q: 0.707 };
  const coeffs = computeBiquadCoeffs({
    type: filterSpec.type,
    cutoffHz: clampCutoffHz(cutoffHz, sampleRate),
    Q: filterSpec.Q,
    sampleRate,
  });

  const panSpec = instrumentDef.pan || { depth: 0.5, periodSec: 60 };

  return {
    oscillator: makeOscillator({ freqHz: baseHz, sampleRate, waveform: instrumentDef.waveform || 'additive', partials }),
    envelope: makeEnvelope({ attackSec, releaseSec, sustainLevel, curve }),
    biquad: makeBiquad(coeffs),
    gain: instrumentDef.gain ?? 0.2,
    panDepth: panSpec.depth ?? 0.5,
    panPhase: nextFloat(rng),
    panPeriodSec: resolveParam(rng, panSpec.periodSec ?? 60),
    attackSec,
    releaseSec,
    sustainLevel,
  };
}
