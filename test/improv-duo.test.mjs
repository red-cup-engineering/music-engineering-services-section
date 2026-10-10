// improv-duo.test.mjs
//
// Checks improv-duo.mjs's actual claims, measured against real generated
// sessions/renders rather than assumed:
//   - determinism (same seed reproduces the same schedule)
//   - real turn-taking: both voices get substantial, non-degenerate stage
//     time over a multi-hundred-second session (a statistical test, not an
//     assertion that it's "probably fine")
//   - a genuine mix of overlap modes (wait/trade/overlap) actually occurs,
//     not just one hardcoded relationship between call and response timing
//   - the response really is a developing-variation TRANSFORM of the call's
//     own base motif (checked against the exact interval-sequence algebra
//     melody.test.mjs already proves for transposeMotif/invertMotif/
//     retrogradeMotif/augmentMotif -- not duplicated here, reused as the
//     expected-value derivation)
//   - the piece-level motif vocabulary is genuinely reused (the same
//     vocabulary index's exact interval shape recurs across multiple calls)
//     and bounded (growth stops at maxVocabularySize)
//   - computeOverlapStats's sweep-line math is correct against a small
//     hand-constructed schedule with a known answer
//   - the underlying scheduling loop is genuinely incremental: calling
//     advanceImprovDuo repeatedly with increasing throughSec extends the
//     same session rather than requiring one fixed total duration up front

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createImprovDuoSession,
  advanceImprovDuo,
  computeOverlapStats,
  renderImprovDuo,
} from '../src/generative/improv-duo.mjs';

test('createImprovDuoSession + advanceImprovDuo is deterministic given the same seed', () => {
  const sessionA = createImprovDuoSession({ seed: 4242, root: 'D', mode: 'dorian' });
  advanceImprovDuo(sessionA, 200);
  const sessionB = createImprovDuoSession({ seed: 4242, root: 'D', mode: 'dorian' });
  advanceImprovDuo(sessionB, 200);

  assert.deepEqual(sessionA.phraseLog, sessionB.phraseLog);
  assert.deepEqual(sessionA.schedule, sessionB.schedule);
  assert.deepEqual(sessionA.vocabulary, sessionB.vocabulary);
});

test('different seeds produce different schedules', () => {
  const sessionA = createImprovDuoSession({ seed: 1, root: 'D', mode: 'dorian' });
  advanceImprovDuo(sessionA, 200);
  const sessionB = createImprovDuoSession({ seed: 2, root: 'D', mode: 'dorian' });
  advanceImprovDuo(sessionB, 200);

  assert.notDeepEqual(sessionA.phraseLog, sessionB.phraseLog);
});

test('the underlying scheduling loop is genuinely incremental: calling advanceImprovDuo repeatedly with increasing throughSec matches one call to the final throughSec', () => {
  const incremental = createImprovDuoSession({ seed: 561, root: 'D', mode: 'dorian' });
  for (const chunk of [50, 100, 150, 220, 300, 410]) {
    advanceImprovDuo(incremental, chunk);
    assert.ok(incremental.tSec >= chunk, `after advancing to ${chunk}, session.tSec (${incremental.tSec}) should be >= ${chunk}`);
  }

  const oneShot = createImprovDuoSession({ seed: 561, root: 'D', mode: 'dorian' });
  advanceImprovDuo(oneShot, 410);

  // Both must have produced the exact same schedule -- incremental calling
  // must not change the generated material, only when it becomes available.
  assert.deepEqual(incremental.phraseLog, oneShot.phraseLog);
  assert.deepEqual(incremental.schedule, oneShot.schedule);
});

test('advanceImprovDuo never shrinks state: tSec and freeSec are monotonically non-decreasing across repeated calls, and previously-scheduled phrases are never removed or altered', () => {
  const session = createImprovDuoSession({ seed: 99, root: 'A', mode: 'aeolian' });
  let previousPhraseLogLength = 0;
  let previousTSec = 0;
  for (const chunk of [30, 90, 180, 300]) {
    advanceImprovDuo(session, chunk);
    assert.ok(session.tSec >= previousTSec, 'tSec should never decrease');
    assert.ok(session.phraseLog.length >= previousPhraseLogLength, 'phraseLog should never shrink');
    previousTSec = session.tSec;
    previousPhraseLogLength = session.phraseLog.length;
  }
  assert.ok(previousPhraseLogLength > 0, 'expected at least some phrases scheduled over 300s');
});

test('real turn-taking: over a long session, both voices get substantial stage time -- neither voice dominates to the point the other is a decoration', () => {
  const session = createImprovDuoSession({ seed: 561, root: 'D', mode: 'dorian' });
  advanceImprovDuo(session, 900);

  const voiceCounts = { A: 0, B: 0 };
  for (const p of session.phraseLog) voiceCounts[p.voice] += 1;

  assert.ok(voiceCounts.A > 0 && voiceCounts.B > 0, 'both voices should get at least some phrases');
  const total = voiceCounts.A + voiceCounts.B;
  const minorityFraction = Math.min(voiceCounts.A, voiceCounts.B) / total;
  assert.ok(minorityFraction >= 0.3, `expected the less-active voice to still carry at least 30% of phrases, got A=${voiceCounts.A} B=${voiceCounts.B} (minority fraction ${minorityFraction.toFixed(3)})`);

  // Also true of actual sounding time (computeOverlapStats), not just phrase
  // counts -- a voice could get many short phrases and still be inaudible in
  // aggregate duration, so check duration too.
  const stats = computeOverlapStats(session, 900);
  assert.ok(stats.onlyAFrac > 0.05, `voice A alone should cover a real fraction of the piece, got ${stats.onlyAFrac}`);
  assert.ok(stats.onlyBFrac > 0.05, `voice B alone should cover a real fraction of the piece, got ${stats.onlyBFrac}`);
});

test('a genuine mix of overlap modes occurs across a long session: wait, trade, AND overlap all show up at least once (not just one relationship between call and response timing)', () => {
  const session = createImprovDuoSession({ seed: 561, root: 'D', mode: 'dorian' });
  advanceImprovDuo(session, 900);

  const modeCounts = { wait: 0, trade: 0, overlap: 0 };
  for (const p of session.phraseLog) {
    if (p.overlapMode) modeCounts[p.overlapMode] += 1;
  }
  assert.ok(modeCounts.wait > 0, 'expected at least one wait-for-silence exchange');
  assert.ok(modeCounts.trade > 0, 'expected at least one trade (minimal-gap) exchange');
  assert.ok(modeCounts.overlap > 0, 'expected at least one genuinely overlapping exchange');
});

test('true simultaneous playing actually occurs: computeOverlapStats reports a nonzero "both voices sounding" fraction over a long session', () => {
  const session = createImprovDuoSession({ seed: 561, root: 'D', mode: 'dorian' });
  advanceImprovDuo(session, 900);
  const stats = computeOverlapStats(session, 900);
  assert.ok(stats.bothSec > 0, 'expected some real simultaneous-sounding time across a 900s session');
  assert.ok(stats.silenceSec > 0, 'expected some real silence too -- not wall-to-wall sound');
  // Sanity: the four categories should account for the whole duration.
  const sum = stats.bothSec + stats.onlyASec + stats.onlyBSec + stats.silenceSec;
  assert.ok(Math.abs(sum - 900) < 1e-6, `the four overlap categories should sum to the total duration, got ${sum}`);
});

test('computeOverlapStats sweep-line math is correct against a small hand-constructed schedule with a known answer', () => {
  // Voice A sounds [0,10) and [20,30). Voice B sounds [5,25). Over [0,30):
  //   [0,5):   A only  (5s)
  //   [5,10):  both     (5s)
  //   [10,20): B only  (10s)
  //   [20,25): both     (5s)
  //   [25,30): A only  (5s)  -- A's second span runs all the way to 30
  const session = {
    schedule: {
      A: [
        { startSec: 0, durSec: 10 },
        { startSec: 20, durSec: 10 },
      ],
      B: [{ startSec: 5, durSec: 20 }],
    },
  };
  const stats = computeOverlapStats(session, 30);
  assert.ok(Math.abs(stats.bothSec - 10) < 1e-9, `expected bothSec=10, got ${stats.bothSec}`);
  assert.ok(Math.abs(stats.onlyASec - 10) < 1e-9, `expected onlyASec=10, got ${stats.onlyASec}`);
  assert.ok(Math.abs(stats.onlyBSec - 10) < 1e-9, `expected onlyBSec=10, got ${stats.onlyBSec}`);
  assert.ok(Math.abs(stats.silenceSec - 0) < 1e-9, `expected silenceSec=0, got ${stats.silenceSec}`);
});

test('the piece-level motif vocabulary is genuinely reused: the same vocabulary index recurs across multiple distinct calls with the exact same interval shape', () => {
  const session = createImprovDuoSession({ seed: 561, root: 'D', mode: 'dorian', vocabularySize: 4 });
  advanceImprovDuo(session, 900);

  const calls = session.phraseLog.filter((p) => p.role === 'call' && p.vocabularyIndex !== null && !p.isFresh);
  assert.ok(calls.length >= 4, `expected several vocabulary-drawing calls over 900s, got ${calls.length}`);

  const byVocabIndex = new Map();
  for (const c of calls) {
    if (!byVocabIndex.has(c.vocabularyIndex)) byVocabIndex.set(c.vocabularyIndex, []);
    byVocabIndex.get(c.vocabularyIndex).push(c.baseMotifIntervals.join(','));
  }

  let sawRecurrence = false;
  for (const [, shapes] of byVocabIndex) {
    if (shapes.length >= 2) {
      sawRecurrence = true;
      // Every call drawing the same vocabulary index must produce the exact
      // same base-motif interval shape (the vocabulary motif itself is
      // reused verbatim as the call's baseMotif -- generatePhrase's
      // thematicMotif path, same mechanism melody.mjs's OPENING/RETURN
      // thematic return already uses).
      const uniqueShapes = new Set(shapes);
      assert.equal(uniqueShapes.size, 1, `all calls drawing the same vocabulary index should produce the identical interval shape, got ${JSON.stringify([...uniqueShapes])}`);
    }
  }
  assert.ok(sawRecurrence, 'expected at least one vocabulary index to be drawn by more than one call over 900s');
});

test('the vocabulary grows but stays bounded at maxVocabularySize', () => {
  const session = createImprovDuoSession({ seed: 561, root: 'D', mode: 'dorian', vocabularySize: 4, maxVocabularySize: 6, vocabularyGrowthProb: 0.9 });
  advanceImprovDuo(session, 900);
  assert.ok(session.vocabulary.length <= 6, `vocabulary should never exceed maxVocabularySize=6, got ${session.vocabulary.length}`);
  assert.ok(session.vocabulary.length > 4, `with a high growth probability over 900s, expected the vocabulary to have grown past its starting size of 4, got ${session.vocabulary.length}`);
});

// --- response-as-real-transform-of-the-call --------------------------------

// `v === 0 ? 0 : -v` rather than plain `-v` so a repeat token's 0 interval
// negates to +0, not -0 -- otherwise assert.deepEqual's Object.is-based
// primitive comparison spuriously fails on -0 !== 0 even though they are
// the same interval musically.
function negate(intervals) {
  return intervals.map((v) => (v === 0 ? 0 : -v));
}
function reverseAndNegate(intervals) {
  return intervals.slice().reverse().map((v) => (v === 0 ? 0 : -v));
}

test('a response phrase\'s base-motif interval sequence is the exact algebraic transform of its call\'s, per the logged responseOperator (transpose/augment/echo preserve intervals exactly; invert negates them; retrograde reverses-and-negates them)', () => {
  const session = createImprovDuoSession({ seed: 561, root: 'D', mode: 'dorian' });
  advanceImprovDuo(session, 900);

  let checked = 0;
  for (let i = 0; i < session.phraseLog.length - 1; i++) {
    const call = session.phraseLog[i];
    const response = session.phraseLog[i + 1];
    if (call.role !== 'call' || response.role !== 'response') continue;

    const callIntervals = call.baseMotifIntervals;
    const responseIntervals = response.baseMotifIntervals;

    switch (response.responseOperator) {
      case 'transpose':
      case 'augment':
      case 'echo':
        assert.deepEqual(responseIntervals, callIntervals, `${response.responseOperator}: response intervals should exactly match the call's`);
        checked++;
        break;
      case 'invert':
        assert.deepEqual(responseIntervals, negate(callIntervals), 'invert: response intervals should be the exact negation of the call\'s');
        checked++;
        break;
      case 'retrograde':
        assert.deepEqual(responseIntervals, reverseAndNegate(callIntervals), 'retrograde: response intervals should be the reversed-and-negated call intervals');
        checked++;
        break;
      default:
        throw new Error(`unexpected responseOperator: ${response.responseOperator}`);
    }
  }
  assert.ok(checked >= 4, `expected to check several call/response pairs over 900s, checked ${checked}`);
});

test('call and response are voiced by different instruments every exchange (voice A = string, voice B = breath), and every call/response pair genuinely swaps voice', () => {
  const session = createImprovDuoSession({ seed: 561, root: 'D', mode: 'dorian' });
  advanceImprovDuo(session, 300);

  let pairsChecked = 0;
  for (let i = 0; i < session.phraseLog.length - 1; i++) {
    const call = session.phraseLog[i];
    const response = session.phraseLog[i + 1];
    if (call.role !== 'call' || response.role !== 'response') continue;
    assert.notEqual(call.voice, response.voice, 'a response should be voiced by the OTHER voice from its call');
    assert.notEqual(call.instrument, response.instrument, 'a response should use the other instrument');
    pairsChecked++;
  }
  assert.ok(pairsChecked > 0, 'expected at least one call/response pair');
});

// --- rendered audio ----------------------------------------------------------

test('renderImprovDuo produces a finite, correctly-sized, non-silent stereo render', () => {
  const track = renderImprovDuo({ durationSec: 25, seed: 561, root: 'D', mode: 'dorian' });
  const expectedSamples = Math.round(25 * track.sampleRate);
  assert.equal(track.left.length, expectedSamples);
  assert.equal(track.right.length, expectedSamples);
  assert.ok(Number.isFinite(track.peak) && track.peak > 0 && track.peak < 1, `peak should be finite and in (0,1), got ${track.peak}`);
  assert.ok(Number.isFinite(track.rms) && track.rms > 0, `rms should be finite and positive, got ${track.rms}`);
  for (let i = 0; i < track.left.length; i += 977) {
    assert.ok(Number.isFinite(track.left[i]) && Number.isFinite(track.right[i]), `non-finite sample at index ${i}`);
  }
});

test('renderImprovDuo exposes the same real scale-parameterization the rest of the engine uses (mode is a real input, not hardcoded)', () => {
  const trackDorian = renderImprovDuo({ durationSec: 15, seed: 7, root: 'D', mode: 'dorian' });
  const trackPent = renderImprovDuo({ durationSec: 15, seed: 7, root: 'D', mode: 'majorPentatonic' });
  assert.notDeepEqual(Array.from(trackDorian.left), Array.from(trackPent.left), 'different modes should produce audibly different material');
  const trackCoords = renderImprovDuo({ durationSec: 15, seed: 7, root: 'D', mode: { cardinality: 6, rotation: 1 } });
  assert.ok(Number.isFinite(trackCoords.peak), 'direct (cardinality, rotation) generator coordinates should also work, not just named modes');
});
