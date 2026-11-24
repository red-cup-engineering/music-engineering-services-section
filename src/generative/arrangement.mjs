// arrangement.mjs
//
// Intensity-layered stem arrangement: the primitive adaptive game music
// actually needs (idle floor -> anticipation -> celebration, without a track
// change). A piece is represented as up to four stacked stems -- bed
// (sustained harmonic pad), pulse (rhythmic ostinato), ornament (sparse
// high-register sparkle fragments), lead (full leitmotif statements) -- each
// gated by an intensity parameter in [0, 1]: below a stem's activation
// threshold it is silent; above it, its density (note count/frequency, not
// just loudness) scales continuously up to that stem's own max. Raising
// intensity therefore adds *layers*, not just volume -- the bed alone reads
// as "idle," bed+pulse as "something is happening," bed+pulse+ornament+lead
// together as "peak" -- all from one continuous knob a caller drives however
// it wants (a fixed value for a static piece, or a time-varying function for
// a scored intensity arc; see intensityFromBreakpoints below for the latter).
//
// Built entirely on existing engine idioms: scale.mjs for pitch material,
// harmony.mjs for the underlying chord progression each bar's bed/pulse
// degrees are drawn from, leitmotif.mjs for the lead/ornament material,
// melody.mjs's degree-based NoteEvent shape for every emitted note (degree +
// octaveIndex, resolved to Hz later by a renderer via melody.mjs's
// degreeToHz -- exactly compose.mjs's own noteEvent/octaveIndex/partialsName
// convention), and transitions.mjs for bar-quantized stinger/riser overlays.
// scheduleArrangement's output is plain, JSON-serializable event data (see
// performance-spec.mjs, which wraps this module's output into the engine's
// documented cross-process performance-spec contract) -- this module itself
// does not touch the DSP layer at all.

import { makeScale } from './scale.mjs';
import { makeRng, nextFloat, pick } from './random.mjs';
import { makeLeitmotif, generateFamily, childSeed } from './leitmotif.mjs';
import { generateProgression, scheduleProgression, diatonicTriadDegrees } from './harmony.mjs';
import { layOutMotifAsEvents } from './transitions.mjs';

/** The four stem roles this module schedules. Order matters only for readability -- scheduling does not depend on it. */
export const STEM_NAMES = Object.freeze(['bed', 'pulse', 'ornament', 'lead']);

/**
 * Default per-stem activation/density configuration. `activateAt` is the
 * intensity threshold below which the stem is silent; density scales
 * linearly from `minDensity` (right at the threshold) to `maxDensity` (at
 * intensity=1). bed's activateAt=0 (always present, per the "idle floor
 * never goes fully silent" adaptive-music requirement) but still has a real
 * minDensity < maxDensity, so it thins out (fewer chord tones) rather than
 * vanishing at low intensity.
 */
export const DEFAULT_STEM_LAYERS = Object.freeze({
  bed: Object.freeze({ activateAt: 0.0, minDensity: 0.35, maxDensity: 1.0 }),
  pulse: Object.freeze({ activateAt: 0.2, minDensity: 0.15, maxDensity: 1.0 }),
  ornament: Object.freeze({ activateAt: 0.45, minDensity: 0.1, maxDensity: 1.0 }),
  lead: Object.freeze({ activateAt: 0.7, minDensity: 0.2, maxDensity: 1.0 }),
});

/**
 * Maps an intensity value to a stem's current density, given its layer
 * config. Returns exactly 0 below activateAt (a real threshold, not just a
 * very small density), so a caller/renderer can treat density===0 as "this
 * stem contributes nothing right now" without a floating-point tolerance
 * check.
 * @param {{activateAt:number, minDensity:number, maxDensity:number}} layerCfg
 * @param {number} intensity - 0..1
 * @returns {number} 0..1
 */
export function stemDensityAt(layerCfg, intensity) {
  const clamped = Math.max(0, Math.min(1, intensity));
  if (clamped < layerCfg.activateAt) return 0;
  const span = Math.max(1e-9, 1 - layerCfg.activateAt);
  const t = (clamped - layerCfg.activateAt) / span;
  return layerCfg.minDensity + (layerCfg.maxDensity - layerCfg.minDensity) * Math.min(1, t);
}

/**
 * Builds a piecewise-linear intensity function from {tSec, intensity}
 * breakpoints (sorted ascending by tSec) -- the concrete tool for scoring an
 * intensity arc over time (e.g. idle floor -> a riser's ramp -> a held
 * celebration plateau) to pass as scheduleArrangement's intensityFn. Holds
 * the first breakpoint's value before the first tSec and the last
 * breakpoint's value after the last tSec, rather than extrapolating.
 * @param {Array<{tSec:number, intensity:number}>} breakpoints
 * @returns {(tSec:number) => number}
 */
export function intensityFromBreakpoints(breakpoints) {
  const pts = breakpoints.slice().sort((a, b) => a.tSec - b.tSec);
  return (tSec) => {
    if (pts.length === 0) return 0;
    if (tSec <= pts[0].tSec) return pts[0].intensity;
    if (tSec >= pts[pts.length - 1].tSec) return pts[pts.length - 1].intensity;
    for (let i = 1; i < pts.length; i++) {
      if (tSec <= pts[i].tSec) {
        const a = pts[i - 1];
        const b = pts[i];
        const t = (tSec - a.tSec) / (b.tSec - a.tSec);
        return a.intensity + (b.intensity - a.intensity) * t;
      }
    }
    return pts[pts.length - 1].intensity;
  };
}

/**
 * Builds an arrangement: everything deterministic from `seed` that
 * scheduleArrangement then lays out in time -- the scale, a harmonic
 * progression long enough to cover a generous span (extended on demand by
 * scheduleArrangement if a longer render needs more chords than requested
 * here), and a leitmotif (plus its family of developing-variation
 * statements) for the ornament/lead stems.
 * @param {object} [opts]
 * @param {number|string} [opts.seed=561]
 * @param {string} [opts.root='D']
 * @param {'dorian'|'aeolian'|'majorPentatonic'|'minorPentatonic'|{cardinality:number,rotation?:number}} [opts.mode='dorian']
 * @param {number} [opts.tempoBpm=72]
 * @param {number} [opts.beatsPerBar=4]
 * @param {number} [opts.barsPerChord=2] - how many bars each harmony.mjs progression chord holds
 * @param {number} [opts.progressionLength=8] - number of chords generated up front (see scheduleArrangement's extension behavior for longer renders)
 * @param {{activateAt:number,minDensity:number,maxDensity:number}} [opts.stemLayers] - per-stem overrides, merged over DEFAULT_STEM_LAYERS
 * @param {object} [opts.leitmotifOpts] - passed through to leitmotif.mjs's makeLeitmotif
 * @param {number} [opts.familySize=8] - passed through to leitmotif.mjs's generateFamily
 * @returns {object} arrangement (see source for the full shape: seed, id, scale, tempoBpm, secPerBeat, secPerBar, barsPerChord, chordDurationSec, progression, leitmotif, family, stemLayers)
 */
export function makeArrangement(opts = {}) {
  const seed = opts.seed ?? 561;
  const root = opts.root ?? 'D';
  const mode = opts.mode ?? 'dorian';
  const tempoBpm = opts.tempoBpm ?? 72;
  const beatsPerBar = opts.beatsPerBar ?? 4;
  const barsPerChord = opts.barsPerChord ?? 2;
  const progressionLength = opts.progressionLength ?? 8;

  const scale = makeScale({ root, mode });
  const secPerBeat = 60 / tempoBpm;
  const secPerBar = secPerBeat * beatsPerBar;
  const chordDurationSec = secPerBar * barsPerChord;

  const harmonyRng = makeRng(childSeed(seed, 'harmony'));
  const progression = scheduleProgression(generateProgression(harmonyRng, scale, { length: progressionLength }), { chordDurationSec });

  // A caller can supply a precomputed core motif (opts.leitmotifCore) instead
  // of letting this module generate one -- the seam corpus.mjs's guqin-
  // corpus-derived contour uses, so a corpus-shaped identity can flow
  // through exactly the same family/family-derived-event machinery as a
  // freshly generated one, rather than needing a parallel code path.
  const leitmotif = opts.leitmotifCore
    ? { id: opts.id ?? String(seed), seed: childSeed(seed, 'leitmotif'), core: opts.leitmotifCore }
    : makeLeitmotif(childSeed(seed, 'leitmotif'), opts.leitmotifOpts);
  const family = generateFamily(leitmotif, { size: opts.familySize ?? 8 });

  const stemLayers = {
    bed: { ...DEFAULT_STEM_LAYERS.bed, ...(opts.stemLayers?.bed || {}) },
    pulse: { ...DEFAULT_STEM_LAYERS.pulse, ...(opts.stemLayers?.pulse || {}) },
    ornament: { ...DEFAULT_STEM_LAYERS.ornament, ...(opts.stemLayers?.ornament || {}) },
    lead: { ...DEFAULT_STEM_LAYERS.lead, ...(opts.stemLayers?.lead || {}) },
  };

  return {
    seed,
    id: opts.id ?? String(seed),
    scale,
    root,
    mode,
    tempoBpm,
    beatsPerBar,
    secPerBeat,
    secPerBar,
    barsPerChord,
    chordDurationSec,
    progression,
    leitmotif,
    family,
    stemLayers,
  };
}

function chordAtTime(progression, chordDurationSec, tSec) {
  const idx = Math.min(progression.length - 1, Math.max(0, Math.floor(tSec / chordDurationSec)));
  return progression[idx];
}

/**
 * Schedules a complete arrangement's event stream over `durationSec`,
 * driven bar-by-bar by `intensityFn` (a function of transport time in
 * seconds -> intensity 0..1, e.g. intensityFromBreakpoints's output; a bare
 * number is also accepted for a static-intensity piece). Deterministic:
 * calling this twice with the same arrangement and an intensityFn that is
 * itself a pure function of tSec produces byte-identical events (the
 * scheduling RNG is derived from arrangement.seed alone, per
 * leitmotif.mjs's childSeed convention, not from wall-clock or call order).
 *
 * If the harmony progression built into `arrangement` is shorter than
 * durationSec needs, it is cycled (not regenerated) so a long render still
 * has a chord to read at every bar -- this is a real, if simple, form of
 * long-form harmonic repetition; callers wanting harmony.mjs's modal drift
 * instead of repetition should build a longer progression up front via
 * makeArrangement's progressionLength option.
 * @param {object} arrangement - from makeArrangement
 * @param {object} opts
 * @param {number} opts.durationSec
 * @param {((tSec:number) => number)|number} opts.intensityFn
 * @param {number} [opts.leadPhraseBars=4] - how many bars between lead-stem phrase opportunities
 * @param {string} [opts.pulseInstrument='pluck'] - 'pluck'|'bass'|'percussion'
 * @param {string} [opts.pluckPreset] - dsp/karplus-strong.mjs PLUCK_PRESETS name, forwarded onto pulse (and, when leadInstrument/ornamentInstrument is 'pluck', lead/ornament) note events
 * @param {string} [opts.leadInstrument='bell'] - 'bell'|'pluck'|'pad'|'bass'
 * @param {string} [opts.ornamentInstrument='bell'] - 'bell'|'pluck'|'pad'|'bass'|'percussion'
 * @param {string} [opts.padOctaveIndex=0]
 * @returns {{events:Array<object>, intensityLog:Array<{tSec:number, intensity:number}>, numBars:number}}
 */
export function scheduleArrangement(arrangement, opts) {
  const { durationSec, intensityFn } = opts;
  const leadPhraseBars = opts.leadPhraseBars ?? 4;
  const pulseInstrument = opts.pulseInstrument ?? 'pluck';
  // Spread as {pluckPreset} only when actually set, rather than always
  // including the key with value undefined -- keeps every emitted event a
  // clean, minimal, JSON-round-trip-stable object (JSON.stringify silently
  // drops undefined-valued keys, which would otherwise make a spec's
  // in-memory shape and its serialized shape subtly disagree).
  const pluckPresetField = opts.pluckPreset ? { pluckPreset: opts.pluckPreset } : {};
  const leadInstrument = opts.leadInstrument ?? 'bell';
  const ornamentInstrument = opts.ornamentInstrument ?? 'bell';
  const padOctaveIndex = opts.padOctaveIndex ?? 0;

  const { scale, secPerBar, secPerBeat, beatsPerBar, chordDurationSec, progression, family, stemLayers } = arrangement;
  const numBars = Math.max(1, Math.ceil(durationSec / secPerBar));
  const rng = makeRng(childSeed(arrangement.seed, 'schedule'));

  const readIntensity = typeof intensityFn === 'function' ? intensityFn : () => intensityFn;

  const events = [];
  const intensityLog = [];
  let familyCursor = 0;

  for (let bar = 0; bar < numBars; bar++) {
    const barStartSec = bar * secPerBar;
    const intensity = Math.max(0, Math.min(1, readIntensity(barStartSec)));
    intensityLog.push({ tSec: barStartSec, intensity });

    const cycledTime = barStartSec % (progression.length * chordDurationSec);
    const chord = chordAtTime(progression, chordDurationSec, cycledTime);
    const triad = diatonicTriadDegrees(chord.degree);

    // --- bed: 1-3 held chord tones spanning the bar, tone count scaling
    // with density (thin at low intensity, full triad at high).
    const bedDensity = stemDensityAt(stemLayers.bed, intensity);
    if (bedDensity > 0) {
      const toneCount = Math.max(1, Math.min(3, Math.round(1 + bedDensity * 2)));
      for (let t = 0; t < toneCount; t++) {
        events.push({
          type: 'note',
          stem: 'bed',
          instrumentHint: 'pad',
          degree: triad[t],
          octaveIndex: padOctaveIndex,
          startSec: barStartSec,
          durSec: secPerBar * 1.05,
          velocity: 0.35 + 0.25 * bedDensity,
        });
      }
    }

    // --- pulse: subdivided ostinato alternating root/fifth, subdivision
    // count scaling with density.
    const pulseDensity = stemDensityAt(stemLayers.pulse, intensity);
    if (pulseDensity > 0) {
      const subdivisions = Math.max(1, Math.round(pulseDensity * beatsPerBar * 2));
      const stepSec = secPerBar / subdivisions;
      for (let s = 0; s < subdivisions; s++) {
        const degree = s % 2 === 0 ? triad[0] : triad[2];
        events.push({
          type: 'note',
          stem: 'pulse',
          instrumentHint: pulseInstrument,
          ...pluckPresetField,
          degree,
          octaveIndex: padOctaveIndex + 1,
          startSec: barStartSec + s * stepSec,
          durSec: stepSec * 0.9,
          velocity: 0.3 + 0.4 * pulseDensity,
        });
      }
    }

    // --- ornament: per-beat probabilistic sparkle hits, one leitmotif-core
    // note each, in the top register; probability of a hit on any given
    // beat scales with density.
    const ornamentDensity = stemDensityAt(stemLayers.ornament, intensity);
    if (ornamentDensity > 0) {
      for (let b = 0; b < beatsPerBar; b++) {
        if (nextFloat(rng) < ornamentDensity) {
          const corePool = arrangement.leitmotif.core.length ? arrangement.leitmotif.core : [{ degree: 0 }];
          const note = pick(rng, corePool);
          events.push({
            type: 'note',
            stem: 'ornament',
            instrumentHint: ornamentInstrument,
            ...pluckPresetField,
            degree: chord.degree + note.degree,
            octaveIndex: padOctaveIndex + 2,
            startSec: barStartSec + b * secPerBeat,
            durSec: secPerBeat * 0.8,
            velocity: 0.4 + 0.3 * ornamentDensity,
          });
        }
      }
    }

    // --- lead: at phrase boundaries only, probabilistically (probability =
    // density) fire one full leitmotif-family statement, cycling through
    // the family deterministically rather than picking randomly every time
    // so a listener can start to recognize specific variations recurring.
    if (bar % leadPhraseBars === 0) {
      const leadDensity = stemDensityAt(stemLayers.lead, intensity);
      if (leadDensity > 0 && nextFloat(rng) < leadDensity) {
        const variation = family[familyCursor % family.length];
        familyCursor += 1;
        const { events: leadEvents } = layOutMotifAsEvents(variation.motif.map((n) => (n.rest ? n : { ...n, degree: chord.degree + n.degree })), {
          startSec: barStartSec,
          secPerQuarter: secPerBeat,
          stem: 'lead',
          instrumentHint: leadInstrument,
          octaveIndex: padOctaveIndex + 2,
          velocity: 0.55 + 0.3 * leadDensity,
        });
        for (const e of leadEvents) events.push({ ...e, ...pluckPresetField, transformName: variation.name });
      }
    }
  }

  return { events, intensityLog, numBars };
}
