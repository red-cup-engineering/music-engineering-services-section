// transitions.test.mjs
//
// Checks transitions.mjs: bar/phrase quantization lands exactly on
// boundaries (including the "already on a boundary" edge case), a scheduled
// stinger overlays new events without touching/removing existing ones, and
// a scheduled riser's automation event resolves exactly at its requested
// (possibly bar-quantized) target time.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { nextBarBoundarySec, nextPhraseBoundarySec, layOutMotifAsEvents, scheduleStinger, scheduleRiser } from '../src/generative/transitions.mjs';
import { makeLeitmotif } from '../src/generative/leitmotif.mjs';

test('nextBarBoundarySec rounds forward to the next bar, and is a no-op exactly on a boundary', () => {
  assert.equal(nextBarBoundarySec(0, 2), 0);
  assert.equal(nextBarBoundarySec(2, 2), 2);
  assert.equal(nextBarBoundarySec(2.5, 2), 4);
  assert.equal(nextBarBoundarySec(3.999999999, 2), 4);
});

test('nextPhraseBoundarySec is nextBarBoundarySec at barsPerPhrase*secPerBar granularity', () => {
  assert.equal(nextPhraseBoundarySec(0, 2, 4), 0);
  assert.equal(nextPhraseBoundarySec(1, 2, 4), 8);
  assert.equal(nextPhraseBoundarySec(9, 2, 4), 16);
});

test('layOutMotifAsEvents converts a motif into absolute-time note events with no rests emitted', () => {
  const motif = [
    { degree: 0, durationFrac: { num: 1, den: 4 }, rest: false },
    { degree: 1, durationFrac: { num: 1, den: 4 }, rest: true },
    { degree: 2, durationFrac: { num: 1, den: 2 }, rest: false },
  ];
  const { events, endSec } = layOutMotifAsEvents(motif, { startSec: 10, secPerQuarter: 1 });
  assert.equal(events.length, 2);
  assert.equal(events[0].startSec, 10);
  assert.equal(events[0].durSec, 1);
  assert.equal(events[1].startSec, 12); // 10 + 1 (note) + 1 (rest, still advances the clock)
  assert.equal(events[1].durSec, 2);
  assert.equal(endSec, 14);
});

test('scheduleStinger overlays new events without mutating or removing the existing event list', () => {
  const existing = [{ type: 'note', stem: 'bed', degree: 0, startSec: 0, durSec: 5 }];
  const { core: motif } = makeLeitmotif(561, { length: 3 });
  const { events, startSec } = scheduleStinger(existing, { atSec: 2.3, quantizeSecPerBar: 2, motif, stem: 'ornament' });

  assert.equal(existing.length, 1, 'input array must not be mutated');
  assert.equal(startSec, 4); // 2.3 quantized forward to the next 2-second bar boundary
  assert.ok(events.includes(existing[0]), 'existing event must still be present, unmodified');
  const newNotes = events.filter((e) => e.type === 'note' && e.stem === 'ornament');
  assert.equal(newNotes.length, motif.filter((n) => !n.rest).length);
  const marker = events.find((e) => e.type === 'transition' && e.kind === 'stinger');
  assert.ok(marker, 'expected a transition marker event');
  assert.equal(marker.startSec, 4);
});

test('scheduleRiser resolves exactly at an explicit targetBeatSec, quantized forward when requested', () => {
  const existing = [];
  const { events, resolvedAtSec } = scheduleRiser(existing, {
    fromSec: 1,
    targetBeatSec: 9.2,
    quantizeSecPerBar: 4,
    stem: 'pulse',
    param: 'cutoffHz',
    fromValue: 500,
    toValue: 5000,
  });
  assert.equal(resolvedAtSec, 12); // 9.2 quantized forward to the next 4-second bar boundary
  const automation = events.find((e) => e.type === 'automation');
  assert.ok(automation);
  assert.equal(automation.startSec, 1);
  assert.equal(automation.durSec, 11);
  assert.equal(automation.fromValue, 500);
  assert.equal(automation.toValue, 5000);
});

test('scheduleRiser without a target falls back to fromSec+durationSec', () => {
  const { resolvedAtSec } = scheduleRiser([], { fromSec: 5, durationSec: 3 });
  assert.equal(resolvedAtSec, 8);
});
