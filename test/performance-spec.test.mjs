// performance-spec.test.mjs
//
// Checks performance-spec.mjs: buildPerformanceSpec produces a spec that
// passes its own validatePerformanceSpec, the whole
// arrangement->schedule->spec pipeline is deterministic end to end (the
// property this task's "seed -> identical event stream" requirement is
// really asking for), and validatePerformanceSpec actually rejects
// malformed specs rather than silently accepting them.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { makeArrangement, scheduleArrangement } from '../src/generative/arrangement.mjs';
import { buildPerformanceSpec, validatePerformanceSpec, PERFORMANCE_SPEC_VERSION } from '../src/generative/performance-spec.mjs';

function buildSpec(seed, durationSec = 24, intensityFn = 0.6) {
  const arrangement = makeArrangement({ seed });
  const scheduled = scheduleArrangement(arrangement, { durationSec, intensityFn });
  return buildPerformanceSpec(arrangement, scheduled, { title: 'Test Spec', durationSec });
}

test('buildPerformanceSpec output passes validatePerformanceSpec', () => {
  const spec = buildSpec(561);
  assert.equal(validatePerformanceSpec(spec), true);
  assert.equal(spec.version, PERFORMANCE_SPEC_VERSION);
});

test('the full seed -> performance-spec pipeline is deterministic: identical seed produces a byte-identical event stream', () => {
  const a = buildSpec(561);
  const b = buildSpec(561);
  assert.deepEqual(a.events, b.events);
  assert.deepEqual(a.intensityLog, b.intensityLog);
  assert.deepEqual(a.leitmotif, b.leitmotif);
  assert.deepEqual(a.progression, b.progression);
});

test('a different seed produces a different event stream', () => {
  const a = buildSpec(561);
  const b = buildSpec(9001);
  assert.notDeepEqual(a.events, b.events);
});

test('the spec round-trips through JSON with no loss relevant to validation', () => {
  const spec = buildSpec(561);
  const roundTripped = JSON.parse(JSON.stringify(spec));
  assert.equal(validatePerformanceSpec(roundTripped), true);
  assert.deepEqual(roundTripped.events, spec.events);
});

test('validatePerformanceSpec rejects a spec missing required fields', () => {
  assert.throws(() => validatePerformanceSpec({}), /missing required field/);
});

test('validatePerformanceSpec rejects an unsupported version', () => {
  const spec = buildSpec(561);
  assert.throws(() => validatePerformanceSpec({ ...spec, version: 999 }), /unsupported version/);
});

test('validatePerformanceSpec rejects a note event with a non-finite degree', () => {
  const spec = buildSpec(561);
  const badEvents = spec.events.map((e, i) => (i === 0 ? { ...e, degree: NaN } : e));
  assert.throws(() => validatePerformanceSpec({ ...spec, events: badEvents }), /missing numeric "degree"/);
});

test('validatePerformanceSpec rejects a negative startSec', () => {
  const spec = buildSpec(561);
  const badEvents = [{ ...spec.events[0], startSec: -1 }, ...spec.events.slice(1)];
  assert.throws(() => validatePerformanceSpec({ ...spec, events: badEvents }), /startSec must be a non-negative/);
});
