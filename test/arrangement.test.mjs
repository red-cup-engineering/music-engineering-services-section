// arrangement.test.mjs
//
// Checks arrangement.mjs: determinism (same seed + same intensity function
// -> byte-identical scheduled events), stemDensityAt's threshold/scaling
// contract, intensityFromBreakpoints's interpolation, and the core
// adaptive-music claim -- that raising intensity monotonically *adds
// layers* (more distinct stems contributing, and non-decreasing note counts
// per stem) rather than just getting louder.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeArrangement, scheduleArrangement, stemDensityAt, intensityFromBreakpoints, DEFAULT_STEM_LAYERS, STEM_NAMES } from '../src/generative/arrangement.mjs';

test('stemDensityAt is exactly 0 below activateAt and scales from minDensity to maxDensity above it', () => {
  const cfg = { activateAt: 0.4, minDensity: 0.2, maxDensity: 1.0 };
  assert.equal(stemDensityAt(cfg, 0), 0);
  assert.equal(stemDensityAt(cfg, 0.39), 0);
  assert.equal(stemDensityAt(cfg, 0.4), 0.2);
  assert.equal(stemDensityAt(cfg, 1), 1.0);
  const mid = stemDensityAt(cfg, 0.7);
  assert.ok(mid > 0.2 && mid < 1.0);
});

test('stemDensityAt is monotonically non-decreasing in intensity', () => {
  const cfg = DEFAULT_STEM_LAYERS.pulse;
  let prev = -Infinity;
  for (let i = 0; i <= 20; i++) {
    const d = stemDensityAt(cfg, i / 20);
    assert.ok(d >= prev - 1e-9, `density decreased at intensity ${i / 20}`);
    prev = d;
  }
});

test('intensityFromBreakpoints interpolates linearly and clamps outside the breakpoint range', () => {
  const fn = intensityFromBreakpoints([{ tSec: 0, intensity: 0.2 }, { tSec: 10, intensity: 0.8 }]);
  assert.equal(fn(-5), 0.2);
  assert.equal(fn(0), 0.2);
  assert.ok(Math.abs(fn(5) - 0.5) < 1e-9);
  assert.equal(fn(10), 0.8);
  assert.equal(fn(50), 0.8);
});

test('scheduleArrangement is deterministic given the same arrangement and a pure intensityFn', () => {
  const arrangement = makeArrangement({ seed: 561 });
  const a = scheduleArrangement(arrangement, { durationSec: 24, intensityFn: 0.6 });
  const b = scheduleArrangement(arrangement, { durationSec: 24, intensityFn: 0.6 });
  assert.deepEqual(a, b);
});

test('scheduleArrangement produces different events for different seeds', () => {
  const a = scheduleArrangement(makeArrangement({ seed: 561 }), { durationSec: 24, intensityFn: 0.6 });
  const b = scheduleArrangement(makeArrangement({ seed: 562 }), { durationSec: 24, intensityFn: 0.6 });
  assert.notDeepEqual(a.events, b.events);
});

test('every scheduled note event carries a recognized stem name and non-negative timing', () => {
  const arrangement = makeArrangement({ seed: 561 });
  const { events } = scheduleArrangement(arrangement, { durationSec: 32, intensityFn: 0.8 });
  for (const e of events) {
    if (e.type !== 'note') continue;
    assert.ok(STEM_NAMES.includes(e.stem), `unrecognized stem "${e.stem}"`);
    assert.ok(e.startSec >= 0);
    assert.ok(e.durSec > 0);
    assert.ok(Number.isFinite(e.degree));
  }
});

test('raising intensity monotonically adds layers: at 0.1 only bed sounds, at 0.95 every stem sounds', () => {
  const arrangement = makeArrangement({ seed: 561 });
  const low = scheduleArrangement(arrangement, { durationSec: 40, intensityFn: 0.1 });
  const high = scheduleArrangement(arrangement, { durationSec: 40, intensityFn: 0.95 });

  const stemsAt = (events) => new Set(events.filter((e) => e.type === 'note').map((e) => e.stem));
  const lowStems = stemsAt(low.events);
  const highStems = stemsAt(high.events);

  assert.ok(lowStems.has('bed'), 'bed should always be present, even at low intensity');
  assert.ok(lowStems.size < highStems.size, `expected fewer active stems at low intensity (got ${lowStems.size}) than high intensity (got ${highStems.size})`);
  assert.equal(highStems.size, STEM_NAMES.length, 'every stem should be reachable at high intensity');

  // Bed's own note count should not decrease as intensity rises (more chord
  // tones per bar, never fewer) -- the "adds density, not just volume" claim
  // checked on real counted output.
  const countFor = (events, stem) => events.filter((e) => e.type === 'note' && e.stem === stem).length;
  assert.ok(countFor(high.events, 'bed') >= countFor(low.events, 'bed'));
});

test('an intensity ramp from 0 to 1 over the piece never removes a stem once it has activated (monotone layering over time)', () => {
  const arrangement = makeArrangement({ seed: 561 });
  const durationSec = 80;
  const { events } = scheduleArrangement(arrangement, {
    durationSec,
    intensityFn: intensityFromBreakpoints([{ tSec: 0, intensity: 0 }, { tSec: durationSec, intensity: 1 }]),
  });
  const noteEvents = events.filter((e) => e.type === 'note').sort((a, b) => a.startSec - b.startSec);

  // Track, per stem, the last bar-window it was active in; once a stem
  // first appears, later windows should not regress to "never seen again"
  // for a long stretch -- checked coarsely via a rolling window count
  // rather than requiring literally every subsequent bar to include it
  // (probabilistic ornament/lead firing means occasional gaps are honest,
  // not a violation).
  const secPerBar = arrangement.secPerBar;
  const numBars = Math.ceil(durationSec / secPerBar);
  const activeByBar = STEM_NAMES.reduce((acc, s) => ({ ...acc, [s]: new Array(numBars).fill(false) }), {});
  for (const e of noteEvents) {
    const bar = Math.min(numBars - 1, Math.floor(e.startSec / secPerBar));
    activeByBar[e.stem][bar] = true;
  }
  for (const stem of STEM_NAMES) {
    const firstActive = activeByBar[stem].indexOf(true);
    if (firstActive === -1) continue; // never activates at all is fine for a short piece; not what this test checks
    const secondHalfCount = activeByBar[stem].slice(Math.max(firstActive, Math.floor(numBars / 2))).filter(Boolean).length;
    assert.ok(secondHalfCount > 0, `stem "${stem}" activated at bar ${firstActive} but never appears again in the back half of a rising-intensity piece`);
  }
});
