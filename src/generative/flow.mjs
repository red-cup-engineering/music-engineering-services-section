// flow.mjs
//
// Port of Dynamics/Flow/ClosureFlowDynamics.lean: the literal driven closure
// flow drive(n+1) = closureOp(join(drive(n), u(n))), and the actual
// macro-tick control loop that drives the whole piece forward in time.
//
// Each macro-tick (a fixed window whose length regime.mjs decides):
//   1. Optionally sample one new pitch-class injection u(n) from the scale,
//      with probability pInject = base + rising*ticksSinceLastFiring (rising
//      with time-since-last-firing, so the piece always eventually returns
//      to development rather than flatlining forever).
//   2. Fold u(n) into chordMask via the literal CRDT join (mergeChord).
//   3. Run the resolver -- cover.mjs's sub-check/join-check voice admission,
//      then thermo.mjs's H-theorem register-balancing migration, then
//      regime.mjs's monotone-bounded filter-cutoff drift -- for up to
//      kHeight=3 iterations, stopping early if a candidate state is
//      identical to the previous iteration's (closure-operator idempotence:
//      "settles within kHeight" rather than always spending all 3 steps).
//   4. Classify the tick: if the state coming out is deepEqual to the state
//      going in, the tick is SMOOTH (existing voices sustain, no spawns
//      audible); otherwise it's FIRING (voices audibly added/dropped/
//      retargeted this window) and ticksSinceLastFiring resets to 0.
//
// The outro is implemented exactly as the source material's own
// terminal-smoothness proof suggests: the caller (compose.mjs) simply sets
// base=0, rising=0 for the closing stretch of the track, so injection stops,
// every subsequent tick resolves to SMOOTH, and the run becomes -- in the
// proof's sense -- permanently quiet (no more firing events; the last
// sounding chord just holds, tended by the DSP envelope's own release curve
// whenever a voice does eventually get dropped). No separate fade-out logic
// is written here.

import { pitchClassBit } from './scale.mjs';
import { resolveCover, mergeChord } from './cover.mjs';
import { hTheoremMigrate } from './thermo.mjs';
import { advanceMonotoneDrift, checkSettlementSpiral } from './regime.mjs';
import { nextFloat, pick } from './random.mjs';

function flowSnapshot(engineState) {
  return {
    chordMask: engineState.chordMask,
    activeVoiceIds: engineState.activeVoiceIds.slice().sort(),
    filterCutoffHz: Math.round(engineState.filterCutoffHz),
    regimeTag: engineState.regimeTag,
  };
}

function snapshotsEqual(a, b) {
  if (a.chordMask !== b.chordMask) return false;
  if (a.filterCutoffHz !== b.filterCutoffHz) return false;
  if (a.regimeTag !== b.regimeTag) return false;
  if (a.activeVoiceIds.length !== b.activeVoiceIds.length) return false;
  for (let i = 0; i < a.activeVoiceIds.length; i++) {
    if (a.activeVoiceIds[i] !== b.activeVoiceIds[i]) return false;
  }
  return true;
}

function dedupeById(events) {
  const byId = new Map();
  for (const e of events) byId.set(e.voiceId, e);
  return Array.from(byId.values());
}

/**
 * Creates a fresh flow/engine state object. This is the superset of the
 * four "logical" flow fields the source primitive names (chordMask,
 * activeVoiceIds, filterCutoffHz, regimeTag) plus the bookkeeping the
 * driven-flow loop and regime classifier need to actually run over time.
 * @param {object} opts
 * @param {number} opts.initialCutoffHz
 * @param {number} [opts.initialChordMask=0] - drive(0)'s seed value; a
 *   non-zero seed (e.g. the scale's tonic pitch class) guarantees the very
 *   first macro-tick has something to cover, rather than leaving the
 *   opening of the piece dependent on the injection coin flip landing early
 * @returns {object} engine state
 */
export function makeFlowState({ initialCutoffHz, initialChordMask = 0 }) {
  return {
    chordMask: initialChordMask,
    activeVoiceIds: [],
    filterCutoffHz: initialCutoffHz,
    regimeTag: 'STRICT',
    voiceRegistry: [], // [{voiceId, pitchClass, bits, octave, lastTouchedTick}]
    ticksSinceLastFiring: 0,
    ticksSinceLastReset: 0,
    emaFilterDelta: 0,
    directFilterDelta: 0,
    spiralCount: 0,
    filterDrift: { value: initialCutoffHz, lastTarget: initialCutoffHz, iterations: 0 },
  };
}

/**
 * Advances the driven closure flow by exactly one macro-tick, mutating
 * engineState in place.
 * @param {object} engineState - from makeFlowState, mutated in place
 * @param {{state:number}} rng
 * @param {{scalePitchClasses:number[], scaleMask:number}} scale
 * @param {object} params
 * @param {number} params.base - base injection probability
 * @param {number} params.rising - per-tick-since-firing rise in injection probability
 * @param {number} [params.kHeight=3]
 * @param {number} [params.maxVoices=6]
 * @param {number} params.tickTime - transport time (seconds) at the start of this tick
 * @param {number} params.targetCutoffHz - this tick's regime-selected filter-cutoff target
 * @returns {{tickType:'SMOOTH'|'FIRING', addedVoices:Array, droppedVoices:Array, iterations:number, converged:boolean, settled:boolean}}
 */
export function stepFlow(engineState, rng, scale, params) {
  const { base, rising, kHeight = 3, maxVoices = 6, tickTime, targetCutoffHz } = params;

  const startSnapshot = flowSnapshot(engineState);

  const pInject = Math.max(0, Math.min(1, base + rising * engineState.ticksSinceLastFiring));

  const injectionEvents = [];
  if (nextFloat(rng) < pInject) {
    const pc = pick(rng, scale.scalePitchClasses);
    injectionEvents.push({ pitchClass: pc, pitchClassBit: pitchClassBit(pc) });
  }
  // Literal CRDT join: fold this tick's injection event(s) into chordMask.
  // With at most one event per tick this is trivially order-independent,
  // but the same mergeChord primitive is used here as everywhere else an
  // async voice-on event needs folding in, per the source material.
  const injectedMask = mergeChord(injectionEvents);
  const workingChordMask = engineState.chordMask | injectedMask;

  let voiceRegistry = engineState.voiceRegistry;
  let candidate = {
    chordMask: workingChordMask,
    activeVoiceIds: voiceRegistry.map((v) => v.voiceId),
    filterCutoffHz: engineState.filterCutoffHz,
    regimeTag: engineState.regimeTag,
  };

  let allAdded = [];
  let allDropped = [];
  let iterations = 0;
  let converged = false;

  for (let k = 0; k < kHeight; k++) {
    iterations++;
    const prevIterationSnapshot = { ...candidate, activeVoiceIds: candidate.activeVoiceIds.slice().sort() };

    const coverResult = resolveCover({
      targetMask: candidate.chordMask,
      currentVoices: voiceRegistry,
      maxVoices,
      tickTime,
    });

    const balanced = hTheoremMigrate(coverResult.admittedVoices, rng);
    voiceRegistry = balanced.voices;

    allAdded = allAdded.concat(coverResult.addedVoices);
    allDropped = allDropped.concat(coverResult.droppedVoices);

    const newCutoff = advanceMonotoneDrift(engineState.filterDrift, targetCutoffHz, kHeight);

    const nextCandidate = {
      chordMask: candidate.chordMask,
      activeVoiceIds: voiceRegistry.map((v) => v.voiceId),
      filterCutoffHz: newCutoff,
      regimeTag: engineState.regimeTag,
    };
    const nextSnapshot = { ...nextCandidate, activeVoiceIds: nextCandidate.activeVoiceIds.slice().sort() };

    candidate = nextCandidate;

    if (snapshotsEqual(nextSnapshot, prevIterationSnapshot)) {
      converged = true;
      break;
    }
  }

  const endSnapshot = flowSnapshot({ ...engineState, ...candidate });
  const tickType = snapshotsEqual(endSnapshot, startSnapshot) ? 'SMOOTH' : 'FIRING';

  if (tickType === 'FIRING') {
    engineState.ticksSinceLastFiring = 0;
    // countableCofinality (regime.mjs's classify()) reads ticksSinceLastReset
    // as "how long since a firing last recurred" -- a FIRING tick is itself
    // a reset. This is what lets STRICT/SCOTT/TRANSFINITE_BOUNDED keep
    // recurring throughout an actively-developing piece rather than the
    // regime collapsing into permanent APERIODIC once the clock first
    // passes 20 ticks: as long as firings keep showing up "cofinally" in
    // time, the count keeps getting pulled back down.
    engineState.ticksSinceLastReset = 0;
  } else {
    engineState.ticksSinceLastFiring += 1;
    engineState.ticksSinceLastReset += 1;
  }

  engineState.chordMask = candidate.chordMask;
  engineState.activeVoiceIds = candidate.activeVoiceIds;
  engineState.filterCutoffHz = candidate.filterCutoffHz;
  engineState.voiceRegistry = voiceRegistry;

  // SettlementSpiral: once the accumulated harmonic memory covers the whole
  // scale, close the spiral and start a fresh development cycle.
  let settled = false;
  if (checkSettlementSpiral(engineState.chordMask, scale.scaleMask)) {
    engineState.chordMask = 0;
    engineState.ticksSinceLastReset = 0;
    engineState.spiralCount += 1;
    settled = true;
  }

  return {
    tickType,
    addedVoices: dedupeById(allAdded),
    droppedVoices: dedupeById(allDropped),
    iterations,
    converged,
    settled,
  };
}
