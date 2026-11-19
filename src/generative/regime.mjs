// regime.mjs
//
// Port of Obsmetrologia/Closure/Regime.lean + RegimeCofinality.lean +
// Operator.lean + SettlementSpiral.lean into macro-form control.
//
// classify() reproduces the four-way strict/scott/transfiniteBounded/
// aperiodic dichotomy as a decidable, priority-ordered FSM over three
// booleans measured from the running engine state. The regime a section is
// currently in selects (a) how long that section's fixed macro-tick window
// lasts and (b) which growth-tower sequence (Padovan/Fibonacci/Tribonacci/
// rising-k k-bonacci, all seeded 1,1,1,...) drives its sub-beat onset
// timing -- used here only for the sequences' genuinely distinct growth
// rates, exactly as the source material's own disclaimer intends: this is
// not a claim that a musical "regime" IS one of these closure regimes, only
// that borrowing their arithmetic gives four audibly distinct pacings.
//
// This module also carries the closure-operator laws that apply *within* a
// section: any drifting parameter is only allowed to move monotonically
// toward its target and must settle within kHeight=3 iterations (or be
// force-clamped there) -- advanceMonotoneDrift below is a literal bounded
// convergence loop, which is what keeps timbral drift audibly steady
// (never wobbling/oscillating) inside a section.
//
// Finally, checkSettlementSpiral implements SettlementSpiral.lean's idea at
// the macro-form level: once the piece's accumulated harmonic memory
// (chordMask) has said everything the scale has to offer, that counts as a
// "settlement" -- the spiral closes and a fresh cycle of harmonic
// development begins from silence, giving the piece periodic long-form
// structure without any hand-authored section markers.

/** @typedef {'STRICT'|'SCOTT'|'TRANSFINITE_BOUNDED'|'APERIODIC'} RegimeTag */

/**
 * Decidable four-way regime classifier, branch priority
 * STRICT > SCOTT > TRANSFINITE_BOUNDED > APERIODIC.
 * @param {object} measured
 * @param {number} measured.activeVoiceCount - drives finiteBase
 * @param {number} measured.emaFilterDelta - smoothed recent filter-cutoff drift
 * @param {number} measured.directFilterDelta - this tick's raw filter-cutoff drift
 * @param {number} measured.ticksSinceLastReset - ticks since the last FIRING
 *   tick (or the last settlement spiral, if more recent) -- drives
 *   countableCofinality: as long as firings keep recurring, this stays low
 *   and the regime can be STRICT/SCOTT/TRANSFINITE_BOUNDED; a drought of
 *   firings (e.g. the outro, once injection probability is forced to 0)
 *   lets it climb past 20 and the regime settles into APERIODIC
 * @param {number} [measured.scottEps=15] - Hz tolerance for "well-behaved" drift
 * @returns {RegimeTag}
 */
export function classify({ activeVoiceCount, emaFilterDelta, directFilterDelta, ticksSinceLastReset, scottEps = 15 }) {
  const finiteBase = activeVoiceCount <= 4;
  const scottContinuous = Math.abs(emaFilterDelta - directFilterDelta) < scottEps;
  const countableCofinality = ticksSinceLastReset < 20;

  if (finiteBase && scottContinuous && countableCofinality) return 'STRICT';
  if (scottContinuous && countableCofinality) return 'SCOTT';
  if (countableCofinality) return 'TRANSFINITE_BOUNDED';
  return 'APERIODIC';
}

/**
 * Macro-tick window length multiplier applied to the base 12s window.
 * STRICT/SCOTT hold the base window; TRANSFINITE_BOUNDED and APERIODIC
 * shorten it, biasing those less-settled regimes toward more frequent
 * re-covers (see cover.mjs's "no temporal covers" scheduling rule).
 * @param {RegimeTag} regimeTag
 * @returns {number}
 */
export function windowLengthMultiplier(regimeTag) {
  switch (regimeTag) {
    case 'STRICT':
      return 1.0;
    case 'SCOTT':
      return 1.0;
    case 'TRANSFINITE_BOUNDED':
      return 0.66;
    case 'APERIODIC':
      return 0.5;
    default:
      return 1.0;
  }
}

/**
 * Target filter-cutoff brightness per regime: the more settled/structured
 * regimes are allowed to sound brighter, the less settled ones are damped
 * darker so the piece stays calm even while its macro-form is more chaotic.
 * @param {RegimeTag} regimeTag
 * @returns {number} Hz
 */
export function baseCutoffHz(regimeTag) {
  switch (regimeTag) {
    case 'STRICT':
      return 1800;
    case 'SCOTT':
      return 1500;
    case 'TRANSFINITE_BOUNDED':
      return 1100;
    case 'APERIODIC':
      return 800;
    default:
      return 1200;
  }
}

const GROWTH_TOWER_KIND_BY_REGIME = {
  STRICT: 'padovan',
  SCOTT: 'fibonacci',
  TRANSFINITE_BOUNDED: 'tribonacci',
  APERIODIC: 'kbonacciRising',
};

/** @param {RegimeTag} regimeTag @returns {string} */
export function regimeGrowthKind(regimeTag) {
  return GROWTH_TOWER_KIND_BY_REGIME[regimeTag] || 'fibonacci';
}

/**
 * Generates the first `length` terms of a named growth-tower sequence, all
 * seeded 1,1,1,... per the source material's convention.
 * @param {'padovan'|'fibonacci'|'tribonacci'|'kbonacciRising'} kind
 * @param {number} length
 * @returns {number[]}
 */
export function growthTower(kind, length) {
  const n = Math.max(1, Math.floor(length));

  if (kind === 'padovan') {
    // P(n) = P(n-2) + P(n-3), seeded 1,1,1.
    const s = [1, 1, 1];
    for (let i = 3; i < n; i++) s.push(s[i - 2] + s[i - 3]);
    return s.slice(0, n);
  }

  if (kind === 'fibonacci') {
    const s = [1, 1];
    for (let i = 2; i < n; i++) s.push(s[i - 1] + s[i - 2]);
    return s.slice(0, n);
  }

  if (kind === 'tribonacci') {
    const s = [1, 1, 1];
    for (let i = 3; i < n; i++) s.push(s[i - 1] + s[i - 2] + s[i - 3]);
    return s.slice(0, n);
  }

  if (kind === 'kbonacciRising') {
    // k-bonacci with k itself rising every 3 terms: each new term sums the
    // last k terms (seeded with 1s), so growth rate itself accelerates --
    // deliberately the "wildest" of the four sequences, matching APERIODIC.
    const s = [1];
    let k = 2;
    let stepsAtCurrentK = 0;
    while (s.length < n) {
      const start = Math.max(0, s.length - k);
      const sum = s.slice(start).reduce((a, b) => a + b, 0) || 1;
      s.push(sum);
      stepsAtCurrentK++;
      if (stepsAtCurrentK >= 3) {
        k++;
        stepsAtCurrentK = 0;
      }
    }
    return s.slice(0, n);
  }

  throw new Error(`Unknown growth tower kind: ${kind}`);
}

/**
 * Sub-beat onset-interval schedule for grain/swell timing inside a window:
 * the regime's growth tower scaled by a base unit, with every interval
 * clamped below 2^index * baseUnitSec so even the fastest-growing sequence
 * (rising-k k-bonacci, which approaches doubling growth as k grows) can
 * never produce a runaway gap between onsets.
 * @param {RegimeTag} regimeTag
 * @param {number} baseUnitSec
 * @param {number} count
 * @returns {number[]} onset interval lengths, in seconds
 */
export function onsetIntervalsSec(regimeTag, baseUnitSec, count) {
  const kind = regimeGrowthKind(regimeTag);
  const seq = growthTower(kind, count);
  return seq.map((v, i) => {
    const raw = baseUnitSec * v;
    const cap = Math.pow(2, i) * baseUnitSec;
    return Math.min(raw, cap);
  });
}

/**
 * Creates a monotone-drift state object for one drifting parameter (e.g.
 * filter cutoff), used with advanceMonotoneDrift.
 * @param {number} initialValue
 * @returns {{value:number, lastTarget:number, iterations:number}}
 */
export function makeMonotoneDrift(initialValue) {
  return { value: initialValue, lastTarget: initialValue, iterations: 0 };
}

/**
 * Closure-operator-law bounded convergence step: moves drift.value
 * monotonically toward targetValue, guaranteed to land exactly on
 * targetValue by the kHeight-th call after a retarget (the fractional step
 * size grows each iteration so the remaining gap is fully closed by then),
 * with a force-clamp as a defensive fallback. Retargeting (a new
 * targetValue) resets the iteration counter, so each new target gets its
 * own fresh kHeight-bounded settle -- this is what keeps drift always
 * monotonic and always steady rather than wobbling/oscillating.
 * @param {{value:number, lastTarget:number, iterations:number}} drift - mutated in place
 * @param {number} targetValue
 * @param {number} [kHeight=3]
 * @returns {number} the new drift.value
 */
export function advanceMonotoneDrift(drift, targetValue, kHeight = 3) {
  if (targetValue !== drift.lastTarget) {
    drift.lastTarget = targetValue;
    drift.iterations = 0;
  }
  drift.iterations += 1;

  if (drift.iterations >= kHeight || Math.abs(targetValue - drift.value) < 1e-9) {
    drift.value = targetValue;
    return drift.value;
  }

  const remainingSteps = kHeight - drift.iterations + 1;
  drift.value = drift.value + (targetValue - drift.value) / remainingSteps;
  return drift.value;
}

/**
 * SettlementSpiral.lean at the macro-form level: once the piece's
 * accumulated harmonic memory (chordMask) covers every pitch class the
 * current scale offers, the section has "settled" -- everything the mode
 * has to say has been said. Returns true so the caller (flow.mjs) can reset
 * chordMask back to 0 and start a fresh cycle of harmonic development,
 * giving the piece periodic long-form structure with no hand-authored
 * section markers.
 * @param {number} chordMask
 * @param {number} scaleMask
 * @returns {boolean}
 */
export function checkSettlementSpiral(chordMask, scaleMask) {
  return (chordMask & scaleMask) === scaleMask;
}
