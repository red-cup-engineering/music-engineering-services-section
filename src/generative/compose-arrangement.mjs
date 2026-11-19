// compose-arrangement.mjs
//
// The offline half of performance-spec.mjs's cross-process contract:
// renderPerformanceSpecToBuffer walks a performance spec's note/automation
// event stream and synthesizes it to a finished stereo buffer, using this
// package's existing DSP primitives -- additive oscillator (pad/bell/bass
// families, dsp/oscillator.mjs), Karplus-Strong (pluck family,
// dsp/karplus-strong.mjs), filtered noise burst (percussion family,
// dsp/percussion.mjs) -- mixed through dsp/mixer.mjs's per-stem channels
// (level/pan/reverb-send) into one shared reverb, exactly the two-bus (dry +
// reverb-send) architecture dsp/mixer.mjs's header comment describes.
//
// This module deliberately consumes the *serialized* performance-spec shape
// (plain data: degree/octaveIndex/startSec/durSec, not live arrangement.mjs
// objects) rather than being handed an arrangement directly -- the same
// spec a downstream realtime player would receive is what this renderer
// plays, which is the concrete guarantee that "the WAV and the spec agree"
// isn't just asserted: they are computed from the exact same data. See
// composeArrangement below for the one-call seed->WAV-ready-buffer path
// scripts/render-arrangement.mjs actually uses.
//
// Automation events: 'density' automation (transitions.mjs's scheduleRiser)
// is a scheduling-time signal a live player would use to add/remove notes
// in real time -- it carries no direct audio meaning here, since
// arrangement.mjs already bakes note density into the discrete events this
// renderer plays. 'cutoffHz' (or any other numeric per-stem parameter)
// automation IS realized here: any oscillator-family note event whose stem/
// startSec falls inside a matching automation event's window has its filter
// cutoff overridden by the automation's interpolated value at that instant
// (sampled once, at the note's own onset -- a real riser's audible brighten-
// over-time comes from successive notes each picking up a brighter cutoff,
// not from continuously re-filtering a single sustained note's biquad
// mid-flight, which this renderer does not do).

import { makeOscillator, advanceOscillator, PARTIAL_PRESETS } from "@red-cup-engineering/computer-audio-engineering-services-section/oscillator";
import { makeEnvelope, envelopeValueAt, triggerAttack, triggerRelease } from "@red-cup-engineering/computer-audio-engineering-services-section/envelope";
import { computeBiquadCoeffs, makeBiquad, processBiquad } from "@red-cup-engineering/computer-audio-engineering-services-section/filter";
import { makeReverb, processReverbSample, REVERB_PRESETS } from "@red-cup-engineering/computer-audio-engineering-services-section/reverb";
import { allocateStereoBuffer, makeStemChannel, mixStemSample, softClip, peakOf, rmsOf, hasNonFinite } from "@red-cup-engineering/computer-audio-engineering-services-section/mixer";
import { makeKarplusString, advanceKarplusString, PLUCK_PRESETS } from "@red-cup-engineering/computer-audio-engineering-services-section/karplus-strong";
import { makeNoiseBurstVoice, advanceNoiseBurstVoice, PERCUSSION_PRESETS } from "@red-cup-engineering/computer-audio-engineering-services-section/percussion";

import { makeScale, OCTAVES } from './scale.mjs';
import { degreeToHz } from './melody.mjs';
import { makeRng, nextFloat } from './random.mjs';
import { makeArrangement, scheduleArrangement } from './arrangement.mjs';
import { buildPerformanceSpec, validatePerformanceSpec } from './performance-spec.mjs';

/** Default per-stem mix channel (level/pan/reverb-send) -- a starting point matching arrangement.mjs's stem roles; override per-render via renderPerformanceSpecToBuffer's stemChannels option. */
export const DEFAULT_STEM_CHANNELS = Object.freeze({
  bed: Object.freeze({ level: 0.85, pan: 0, space: 0.55 }),
  pulse: Object.freeze({ level: 0.6, pan: -0.15, space: 0.2 }),
  ornament: Object.freeze({ level: 0.5, pan: 0.3, space: 0.45 }),
  lead: Object.freeze({ level: 0.75, pan: 0.05, space: 0.3 }),
});

function clampCutoffHz(hz, sampleRate) {
  return Math.max(80, Math.min(sampleRate / 2 - 200, hz));
}

/**
 * Finds the interpolated value of the (at most one, latest-starting) 'stem'/
 * 'param' automation event covering tSec, or undefined if none applies.
 * @param {Array<object>} events - spec.events
 * @param {string} stem
 * @param {string} param
 * @param {number} tSec
 * @returns {number|undefined}
 */
function automationValueAt(events, stem, param, tSec) {
  let value;
  for (const e of events) {
    if (e.type !== 'automation' || e.stem !== stem || e.param !== param) continue;
    if (tSec < e.startSec || tSec > e.startSec + e.durSec) continue;
    const t = e.durSec > 0 ? (tSec - e.startSec) / e.durSec : 1;
    const eased = e.curve === 'exp' ? 1 - (1 - t) * (1 - t) : t;
    value = e.fromValue + (e.toValue - e.fromValue) * eased;
  }
  return value;
}

function buildVoiceForNoteEvent(evt, scale, sampleRate, rng, allEvents) {
  const octaveIndex = Math.max(0, Math.min(OCTAVES.length - 1, evt.octaveIndex ?? 1));
  const baseHz = degreeToHz(scale, evt.degree, octaveIndex);
  const startSec = evt.startSec;
  const durSec = Math.max(0.02, evt.durSec ?? 0.3);
  const gain = evt.velocity ?? 0.6;
  const pan = evt.pan ?? 0;

  if (evt.instrumentHint === 'pluck') {
    const preset = PLUCK_PRESETS[evt.pluckPreset] || PLUCK_PRESETS.nylon;
    const str = makeKarplusString({
      freqHz: baseHz,
      sampleRate,
      decay: preset.decay,
      dampingHz: preset.dampingHz,
      exciteGain: 1,
      exciteSample: () => nextFloat(rng) * 2 - 1,
    });
    return { kind: 'karplus', stem: evt.stem, str, startSec, endSec: startSec + Math.max(durSec, 1.2), gain, pan };
  }

  if (evt.instrumentHint === 'percussion') {
    const preset = PERCUSSION_PRESETS[evt.percussionPreset] || PERCUSSION_PRESETS.tick;
    const automatedBandHz = automationValueAt(allEvents, evt.stem, 'bandHz', startSec);
    const voice = makeNoiseBurstVoice({
      sampleRate,
      bandHz: evt.bandHz ?? automatedBandHz ?? preset.bandHz,
      Q: preset.Q,
      decaySec: preset.decaySec,
      attackSec: preset.attackSec,
      atSec: startSec,
      exciteSample: () => nextFloat(rng) * 2 - 1,
    });
    return { kind: 'noise', stem: evt.stem, voice, startSec, endSec: startSec + preset.attackSec + preset.decaySec + 0.05, gain, pan };
  }

  // 'pad' | 'bell' | 'bass' | anything else -> additive oscillator voice.
  const partialsName = evt.partialsName || (evt.instrumentHint === 'bell' ? 'bell' : evt.instrumentHint === 'bass' ? 'subBass' : 'warmPad');
  const partials = PARTIAL_PRESETS[partialsName] || PARTIAL_PRESETS.warmPad;
  const isBell = evt.instrumentHint === 'bell';

  const envSpec = evt.envelope || (isBell
    ? { attackSec: 0.008, releaseSec: Math.max(durSec, 0.6), sustainLevel: 0.7, curve: 6 }
    : { attackSec: Math.min(0.6, Math.max(0.05, durSec * 0.15)), releaseSec: Math.max(0.4, durSec * 0.35), sustainLevel: 0.75, curve: 5 });

  const automatedCutoff = automationValueAt(allEvents, evt.stem, 'cutoffHz', startSec);
  const cutoffHz = evt.cutoffHz ?? automatedCutoff ?? (isBell ? 6000 : 3200);

  const osc = makeOscillator({ freqHz: baseHz, sampleRate, waveform: 'additive', partials });
  const env = makeEnvelope(envSpec);
  const biquad = makeBiquad(computeBiquadCoeffs({ type: 'lowpass', cutoffHz: clampCutoffHz(cutoffHz, sampleRate), Q: 0.707, sampleRate }));
  triggerAttack(env, startSec);

  const releaseAtSec = isBell ? startSec + Math.max(durSec * 0.2, 0.02) : startSec + Math.max(durSec - envSpec.releaseSec, envSpec.attackSec);

  return {
    kind: 'osc',
    stem: evt.stem,
    osc,
    env,
    biquad,
    startSec,
    releaseAtSec,
    endSec: releaseAtSec + envSpec.releaseSec + 0.05,
    gain,
    pan,
    released: false,
  };
}

/**
 * Renders a performance spec (performance-spec.mjs's buildPerformanceSpec
 * output) to a finished stereo buffer.
 * @param {object} spec - a validated performance spec
 * @param {object} [opts]
 * @param {number} [opts.sampleRate=44100]
 * @param {'deepAmbient'|'hall'|'chamber'} [opts.reverbPreset='deepAmbient']
 * @param {Record<string,{level:number,pan:number,space:number}>} [opts.stemChannels] - per-stem mix overrides, merged over DEFAULT_STEM_CHANNELS
 * @param {number} [opts.tailSec=1.5] - extra buffer length appended past spec.durationSec so envelope releases and the reverb tail have room to finish rather than being hard-cut
 * @returns {{sampleRate:number, numChannels:number, left:Float32Array, right:Float32Array, durationSec:number, peak:number, rms:number}}
 */
export function renderPerformanceSpecToBuffer(spec, opts = {}) {
  validatePerformanceSpec(spec);
  const sampleRate = opts.sampleRate ?? 44100;
  const reverbPreset = opts.reverbPreset ?? 'deepAmbient';
  const tailSec = opts.tailSec ?? 1.5;
  const stemChannels = {
    bed: { ...DEFAULT_STEM_CHANNELS.bed, ...(opts.stemChannels?.bed || {}) },
    pulse: { ...DEFAULT_STEM_CHANNELS.pulse, ...(opts.stemChannels?.pulse || {}) },
    ornament: { ...DEFAULT_STEM_CHANNELS.ornament, ...(opts.stemChannels?.ornament || {}) },
    lead: { ...DEFAULT_STEM_CHANNELS.lead, ...(opts.stemChannels?.lead || {}) },
  };
  for (const key of Object.keys(stemChannels)) stemChannels[key] = makeStemChannel(stemChannels[key]);

  const scale = makeScale({ root: spec.scale.root, mode: spec.scale.mode });
  const totalSamples = Math.max(1, Math.round((spec.durationSec + tailSec) * sampleRate));
  const { left: busL, right: busR } = allocateStereoBuffer(totalSamples);
  const reverb = makeReverb({ sampleRate, ...REVERB_PRESETS[reverbPreset] });
  const rng = makeRng(spec.seed ?? 0);

  const noteEvents = spec.events.filter((e) => e.type === 'note').slice().sort((a, b) => a.startSec - b.startSec);

  let nextIdx = 0;
  const activeVoices = [];

  for (let i = 0; i < totalSamples; i++) {
    const tSec = i / sampleRate;

    while (nextIdx < noteEvents.length && noteEvents[nextIdx].startSec <= tSec) {
      activeVoices.push(buildVoiceForNoteEvent(noteEvents[nextIdx], scale, sampleRate, rng, spec.events));
      nextIdx += 1;
    }

    let dryL = 0;
    let dryR = 0;
    let sendL = 0;
    let sendR = 0;

    for (let vi = activeVoices.length - 1; vi >= 0; vi--) {
      const voice = activeVoices[vi];
      if (tSec >= voice.endSec) {
        activeVoices.splice(vi, 1);
        continue;
      }

      let sample;
      if (voice.kind === 'karplus') {
        sample = advanceKarplusString(voice.str);
      } else if (voice.kind === 'noise') {
        sample = advanceNoiseBurstVoice(voice.voice, tSec);
      } else {
        if (!voice.released && tSec >= voice.releaseAtSec) {
          triggerRelease(voice.env, tSec);
          voice.released = true;
        }
        const raw = advanceOscillator(voice.osc);
        const elapsed = tSec - voice.env.stageStartTime;
        const level = envelopeValueAt(voice.env, elapsed);
        sample = processBiquad(voice.biquad, raw * level);
      }

      const channel = stemChannels[voice.stem] || stemChannels.bed;
      const mixed = mixStemSample({ dryL, dryR, sendL, sendR }, sample, voice.gain, voice.pan, channel);
      dryL = mixed.dryL;
      dryR = mixed.dryR;
      sendL = mixed.sendL;
      sendR = mixed.sendR;
    }

    const { outL: wetL, outR: wetR } = processReverbSample(reverb, sendL, sendR);
    busL[i] = dryL + wetL;
    busR[i] = dryR + wetR;
  }

  // Same purely-technical anti-click safeguard renderTrack (compose.mjs)
  // applies at its own hard buffer boundary.
  const declickSamples = Math.min(totalSamples, Math.round(0.03 * sampleRate));
  for (let i = 0; i < declickSamples; i++) {
    const idx = totalSamples - declickSamples + i;
    const g = i / declickSamples;
    busL[idx] *= g;
    busR[idx] *= g;
  }

  for (let i = 0; i < totalSamples; i++) {
    busL[i] = softClip(busL[i]);
    busR[i] = softClip(busR[i]);
  }

  if (hasNonFinite(busL, busR)) {
    throw new Error('renderPerformanceSpecToBuffer produced non-finite samples -- this indicates a DSP bug, not a valid render.');
  }

  return {
    sampleRate,
    numChannels: 2,
    left: Float32Array.from(busL),
    right: Float32Array.from(busR),
    durationSec: totalSamples / sampleRate,
    peak: peakOf(busL, busR),
    rms: rmsOf(busL, busR),
  };
}

/**
 * One-call convenience: seed/opts -> arrangement -> scheduled events ->
 * performance spec -> rendered stereo buffer. This is what
 * scripts/render-arrangement.mjs uses; test/arrangement.test.mjs and
 * test/performance-spec.test.mjs exercise the earlier stages individually
 * (makeArrangement/scheduleArrangement/buildPerformanceSpec) since those are
 * where the actually-interesting generative/determinism behavior lives --
 * this function's own job is just wiring them together in the documented
 * order.
 * @param {object} opts - see makeArrangement for arrangement-building options and scheduleArrangement for durationSec/intensityFn/etc; see renderPerformanceSpecToBuffer for sampleRate/reverbPreset/stemChannels
 * @returns {{spec:object, buffer:object}}
 */
export function composeArrangement(opts = {}) {
  const arrangement = makeArrangement(opts);
  const scheduled = scheduleArrangement(arrangement, opts);
  const spec = buildPerformanceSpec(arrangement, scheduled, opts);
  const buffer = renderPerformanceSpecToBuffer(spec, opts);
  return { spec, buffer };
}
