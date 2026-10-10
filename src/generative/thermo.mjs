// thermo.mjs
//
// Port of Thermodynamics/BoltzmannEntropy.lean + Temperature.lean into
// stochastic micro-variation ("humanization"): the amount of jitter applied
// each window, and register-spread self-balancing across the voices.
//
// Temperature T = mints/flux, derived from the piece's own material rather
// than hand-set: T = (newly-injected pitch classes this window) / (total
// pitch-class events this window), which reproduces the proved exact poles
// at 0 (a pure-repeat window: nothing new, T=0, no jitter, dead calm) and 1
// (an all-new window: every voice just spawned, T=1, maximally alive). T
// scales gaussian detune-cents, gaussian filter-cutoff jitter-Hz, and
// uniform onset-jitter-ms.
//
// Separately, an 8-bin register-occupation table runs the literal Boltzmann
// H-theorem "fuller-to-emptier exchange" migration each tick: with
// probability p = (log(nFull+1) - log(nEmpty+1)) / log(nFull+1) (the exact
// entropy-increment form, self-normalized to land in [0,1]), the newest
// voice in the fullest register bin is retargeted one octave toward the
// emptiest bin. This is a proof-backed self-balancing register spread that
// prevents the classic generative-ambient failure mode of every voice
// clumping into one octave.

import { nextFloat, nextGaussian } from './random.mjs';
import { OCTAVES } from './scale.mjs';

const NUM_REGISTER_BINS = 8;

/**
 * Temperature = mints/flux, clamped into [0,1] as a defensive measure
 * against floating-point edge cases; the poles at 0 and 1 are exact by
 * construction whenever mintedPitchClasses is 0 or equals the total.
 * @param {number} mintedPitchClassesThisWindow
 * @param {number} totalPitchClassEventsThisWindow
 * @returns {number} T in [0, 1]
 */
export function computeTemperature(mintedPitchClassesThisWindow, totalPitchClassEventsThisWindow) {
  if (totalPitchClassEventsThisWindow <= 0) return 0;
  const t = mintedPitchClassesThisWindow / totalPitchClassEventsThisWindow;
  return Math.max(0, Math.min(1, t));
}

/** @param {{state:number}} rng @param {number} temperature @returns {number} cents */
export function sampleDetuneCents(rng, temperature) {
  return nextGaussian(rng, 0, temperature * 6);
}

/** @param {{state:number}} rng @param {number} temperature @returns {number} Hz */
export function sampleFilterJitterHz(rng, temperature) {
  return nextGaussian(rng, 0, temperature * 80);
}

/** @param {{state:number}} rng @param {number} temperature @returns {number} milliseconds */
export function sampleOnsetJitterMs(rng, temperature) {
  return (nextFloat(rng) * 2 - 1) * temperature * 150;
}

function octaveToBin(octave) {
  const octIndex = OCTAVES.indexOf(octave);
  const clamped = octIndex < 0 ? 0 : octIndex;
  const bin = Math.round((clamped / (OCTAVES.length - 1)) * (NUM_REGISTER_BINS - 1));
  return Math.max(0, Math.min(NUM_REGISTER_BINS - 1, bin));
}

/** @returns {number[]} a fresh all-zero 8-bin register-occupation table */
export function makeRegisterTable() {
  return new Array(NUM_REGISTER_BINS).fill(0);
}

/**
 * Tallies how many voices currently occupy each of the 8 register bins.
 * @param {Array<{octave:number}>} voices
 * @returns {number[]}
 */
export function computeOccupation(voices) {
  const table = makeRegisterTable();
  for (const v of voices) table[octaveToBin(v.octave)] += 1;
  return table;
}

/**
 * Boltzmann H-theorem register-balancing migration: finds the fullest and
 * emptiest register bins and, with probability p derived from the exact
 * entropy-increment formula, retargets the newest voice in the fullest bin
 * one octave step toward the emptiest bin. No-ops (migrated:false) when the
 * voice list is too small to meaningfully compare, when the fullest and
 * emptiest bins coincide (already balanced), or when the coin flip misses.
 * @param {Array<{voiceId:string, octave:number, lastTouchedTick:number}>} voices
 * @param {{state:number}} rng
 * @returns {{voices:Array, migrated:boolean}}
 */
export function hTheoremMigrate(voices, rng) {
  if (voices.length < 2) return { voices, migrated: false };

  const table = computeOccupation(voices);
  let fullBin = 0;
  let emptyBin = 0;
  for (let b = 1; b < table.length; b++) {
    if (table[b] > table[fullBin]) fullBin = b;
    if (table[b] < table[emptyBin]) emptyBin = b;
  }

  const nFull = table[fullBin];
  const nEmpty = table[emptyBin];
  if (fullBin === emptyBin || nFull === nEmpty) return { voices, migrated: false };

  const norm = Math.log(nFull + 1);
  const p = norm > 0 ? (Math.log(nFull + 1) - Math.log(nEmpty + 1)) / norm : 0;

  if (nextFloat(rng) >= p) return { voices, migrated: false };

  let newestIdx = -1;
  let newestTick = -Infinity;
  for (let i = 0; i < voices.length; i++) {
    if (octaveToBin(voices[i].octave) === fullBin && voices[i].lastTouchedTick > newestTick) {
      newestTick = voices[i].lastTouchedTick;
      newestIdx = i;
    }
  }
  if (newestIdx === -1) return { voices, migrated: false };

  const direction = emptyBin > fullBin ? 1 : -1;
  const currentOctIndex = OCTAVES.indexOf(voices[newestIdx].octave);
  const nextOctIndex = Math.max(0, Math.min(OCTAVES.length - 1, currentOctIndex + direction));
  const nextOctave = OCTAVES[nextOctIndex];

  if (nextOctave === voices[newestIdx].octave) return { voices, migrated: false };

  const updated = voices.slice();
  updated[newestIdx] = { ...updated[newestIdx], octave: nextOctave };
  return { voices: updated, migrated: true };
}
