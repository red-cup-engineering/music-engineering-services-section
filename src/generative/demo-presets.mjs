// demo-presets.mjs
//
// Five worked arrangements exercising the range of arrangement.mjs +
// transitions.mjs + leitmotif.mjs added by this pass: a static ambient bed
// (lounge-noir), an intensity-arc riser resolving on a target bar
// (anticipation-riser), a motif-driven stinger over a bright/high-intensity
// arrangement (celebration-fanfare), a stem exercising ornament density
// specifically (sparkle-ornament), and one exercising the guqin corpus
// pipeline (guqin-echo, corpus.mjs). Each builder returns a fully-assembled
// {arrangement, scheduled, spec, reverbPreset} -- everything
// scripts/render-demos.mjs (or a test) needs to render straight to a WAV via
// compose-arrangement.mjs's renderPerformanceSpecToBuffer, with no further
// per-preset knowledge required outside this module.
//
// All five are fully deterministic from their (string) seed -- see
// test/demo-presets.test.mjs.

import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeArrangement, scheduleArrangement, intensityFromBreakpoints } from './arrangement.mjs';
import { buildPerformanceSpec } from './performance-spec.mjs';
import { scheduleRiser, scheduleStinger } from './transitions.mjs';
import { deriveVariation } from './leitmotif.mjs';
import { motifFromGuqinCorpus } from './corpus.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CORPUS_PATH = resolve(HERE, '..', '..', 'data', 'corpus', 'guqin', 'meihua-sannong-illustrative.json');

export const DEMO_PRESET_NAMES = Object.freeze(['lounge-noir', 'anticipation-riser', 'celebration-fanfare', 'sparkle-ornament', 'guqin-echo']);

function buildLoungeNoir(opts) {
  const arrangement = makeArrangement({
    seed: opts.seed ?? 'lounge-noir-561',
    root: 'A',
    mode: 'aeolian',
    tempoBpm: 64,
    barsPerChord: 2,
    progressionLength: 6,
    stemLayers: {
      pulse: { activateAt: 0.0, minDensity: 0.15, maxDensity: 0.4 },
      ornament: { activateAt: 0.6, minDensity: 0.1, maxDensity: 0.3 },
      lead: { activateAt: 0.85, minDensity: 0.1, maxDensity: 0.3 },
    },
  });
  const durationSec = opts.durationSec ?? 36;
  const scheduled = scheduleArrangement(arrangement, {
    durationSec,
    intensityFn: 0.3, // a static, low idle-floor intensity -- bed plus a thin pulse, nothing else activates
    pulseInstrument: 'pluck',
    pluckPreset: 'nylon',
    leadInstrument: 'bell',
  });
  const spec = buildPerformanceSpec(arrangement, scheduled, { title: 'Lounge Noir', durationSec });
  return { arrangement, scheduled, spec, reverbPreset: 'chamber' };
}

function buildAnticipationRiser(opts) {
  const arrangement = makeArrangement({
    seed: opts.seed ?? 'anticipation-riser-561',
    root: 'D',
    mode: 'dorian',
    tempoBpm: 96,
    barsPerChord: 2,
    progressionLength: 6,
  });
  const durationSec = opts.durationSec ?? 24;
  // The worked adaptive-music arc this preset exists to demonstrate: an
  // idle floor (bed + a little pulse) that climbs into full activation of
  // every stem by the end -- the continuous intensity knob doing exactly
  // the "idle -> anticipation -> celebration, no track change" job the
  // README's arrangement.mjs section describes.
  const intensityFn = intensityFromBreakpoints([
    { tSec: 0, intensity: 0.15 },
    { tSec: durationSec * 0.55, intensity: 0.35 },
    { tSec: durationSec, intensity: 0.95 },
  ]);
  const scheduledBase = scheduleArrangement(arrangement, {
    durationSec,
    intensityFn,
    pulseInstrument: 'percussion',
    leadInstrument: 'bell',
    ornamentInstrument: 'bell',
  });
  // A real riser: a bar-quantized brightness ramp on the ornament stem,
  // starting partway through and resolving exactly on the final bar --
  // transitions.mjs's scheduleRiser, not a hand-tuned fade.
  const riser = scheduleRiser(scheduledBase.events, {
    fromSec: durationSec * 0.45,
    targetBeatSec: durationSec,
    quantizeSecPerBar: arrangement.secPerBar,
    stem: 'ornament',
    param: 'cutoffHz',
    fromValue: 700,
    toValue: 7500,
    curve: 'exp',
  });
  const scheduled = { ...scheduledBase, events: riser.events };
  const spec = buildPerformanceSpec(arrangement, scheduled, { title: 'Anticipation Riser', durationSec });
  return { arrangement, scheduled, spec, reverbPreset: 'hall' };
}

function buildCelebrationFanfare(opts) {
  const arrangement = makeArrangement({
    seed: opts.seed ?? 'celebration-fanfare-561',
    root: 'D',
    mode: { cardinality: 7, rotation: 4 }, // Ionian/major -- scale.mjs's maximal-evenness generator, rotation 4 (see test/scale.test.mjs)
    tempoBpm: 120,
    barsPerChord: 1,
    progressionLength: 8,
    familySize: 8,
    stemLayers: {
      lead: { activateAt: 0.0, minDensity: 0.8, maxDensity: 1 },
      ornament: { activateAt: 0.0, minDensity: 0.4, maxDensity: 0.9 },
    },
  });
  const durationSec = opts.durationSec ?? 20;
  const scheduledBase = scheduleArrangement(arrangement, {
    durationSec,
    intensityFn: 0.9, // held high throughout -- a celebration/payout moment, not a build
    leadPhraseBars: 2,
    pulseInstrument: 'percussion',
    leadInstrument: 'bell',
    ornamentInstrument: 'bell',
  });
  // Motif-driven stinger: the piece's own leitmotif, transposed up a fifth
  // and left rhythmically un-augmented (factor:1, i.e. a genuine transform
  // still drawn from leitmotif.mjs's operator set, not a bespoke one-off),
  // fired at the very first downbeat as an accent layered on top of the
  // arrangement -- it does not remove or retrigger the bed/pulse/lead
  // events already scheduled.
  const stingerMotif = deriveVariation(arrangement.leitmotif.core, 'transpose', { degreeShift: 4 });
  const stinger = scheduleStinger(scheduledBase.events, {
    atSec: 0,
    quantizeSecPerBar: arrangement.secPerBar,
    motif: stingerMotif,
    stem: 'lead',
    instrumentHint: 'bell',
    octaveIndex: 2,
    velocity: 0.95,
    secPerQuarter: arrangement.secPerBeat,
  });
  const scheduled = { ...scheduledBase, events: stinger.events };
  const spec = buildPerformanceSpec(arrangement, scheduled, { title: 'Celebration Fanfare', durationSec });
  return { arrangement, scheduled, spec, reverbPreset: 'hall' };
}

function buildSparkleOrnament(opts) {
  const arrangement = makeArrangement({
    seed: opts.seed ?? 'sparkle-ornament-561',
    root: 'E',
    mode: 'majorPentatonic',
    tempoBpm: 90,
    barsPerChord: 2,
    progressionLength: 6,
    stemLayers: {
      bed: { activateAt: 0.0, minDensity: 0.2, maxDensity: 0.35 },
      pulse: { activateAt: 0.9, minDensity: 0.1, maxDensity: 0.3 },
      ornament: { activateAt: 0.0, minDensity: 0.55, maxDensity: 1.0 },
      lead: { activateAt: 0.95, minDensity: 0.1, maxDensity: 0.3 },
    },
  });
  const durationSec = opts.durationSec ?? 24;
  const scheduled = scheduleArrangement(arrangement, {
    durationSec,
    intensityFn: 0.8, // high enough to keep the ornament stem consistently active without also pulling pulse/lead in (their activateAt thresholds sit above this)
    ornamentInstrument: 'bell',
  });
  const spec = buildPerformanceSpec(arrangement, scheduled, { title: 'Sparkle Ornament', durationSec });
  return { arrangement, scheduled, spec, reverbPreset: 'hall' };
}

async function buildGuqinEcho(opts) {
  const corpusPath = opts.corpusPath ?? DEFAULT_CORPUS_PATH;
  const { core, meta } = await motifFromGuqinCorpus(corpusPath);
  const arrangement = makeArrangement({
    seed: opts.seed ?? 'guqin-echo-561',
    root: 'D',
    mode: 'aeolian',
    tempoBpm: 58,
    barsPerChord: 4,
    progressionLength: 4,
    leitmotifCore: core,
    stemLayers: {
      pulse: { activateAt: 0.9, minDensity: 0.1, maxDensity: 0.3 },
      ornament: { activateAt: 0.35, minDensity: 0.1, maxDensity: 0.4 },
      lead: { activateAt: 0.4, minDensity: 0.5, maxDensity: 0.9 },
    },
  });
  const durationSec = opts.durationSec ?? 30;
  const scheduled = scheduleArrangement(arrangement, {
    durationSec,
    intensityFn: 0.5,
    leadPhraseBars: 6,
    pulseInstrument: 'pluck',
    pluckPreset: 'guqinAdjacent',
    leadInstrument: 'pluck',
    ornamentInstrument: 'pluck',
  });
  const spec = buildPerformanceSpec(arrangement, scheduled, {
    title: `Guqin Echo (corpus-derived contour from "${meta.title}"; ${meta.fixtureStatus})`,
    durationSec,
  });
  return { arrangement, scheduled, spec, reverbPreset: 'deepAmbient', meta };
}

const BUILDERS = Object.freeze({
  'lounge-noir': buildLoungeNoir,
  'anticipation-riser': buildAnticipationRiser,
  'celebration-fanfare': buildCelebrationFanfare,
  'sparkle-ornament': buildSparkleOrnament,
  'guqin-echo': buildGuqinEcho,
});

/**
 * Builds one named demo preset's full performance spec (plus the
 * intermediate arrangement/scheduled-events objects and a suggested
 * reverbPreset). All builders are async-safe to call (guqin-echo genuinely
 * awaits a corpus file read; the others resolve synchronously-computed
 * values through the same async interface for a uniform call site).
 * @param {'lounge-noir'|'anticipation-riser'|'celebration-fanfare'|'sparkle-ornament'|'guqin-echo'} name
 * @param {object} [opts]
 * @param {number|string} [opts.seed] - overrides the preset's own default seed
 * @param {number} [opts.durationSec] - overrides the preset's own default duration
 * @param {string} [opts.corpusPath] - guqin-echo only
 * @returns {Promise<{arrangement:object, scheduled:object, spec:object, reverbPreset:string, meta?:object}>}
 */
export async function buildDemoPerformanceSpec(name, opts = {}) {
  const builder = BUILDERS[name];
  if (!builder) throw new Error(`Unknown demo preset "${name}". Use one of: ${DEMO_PRESET_NAMES.join(', ')}`);
  return builder(opts);
}
