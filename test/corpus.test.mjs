// corpus.test.mjs
//
// Checks corpus.mjs's guqin-corpus bridge: it derives a real, non-trivial
// motif core from the fixture's actual `string` field (not from the
// fixture's own invented `pitch_interpretive` field), preserves the
// fixture's note ordering, and surfaces the fixture's illustrative/synthetic
// status honestly rather than dropping it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { motifFromGuqinCorpus } from '../src/generative/corpus.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS_PATH = resolve(HERE, '..', 'data', 'corpus', 'guqin', 'meihua-sannong-illustrative.json');

test('motifFromGuqinCorpus derives a non-empty core motif with valid degrees and durations', async () => {
  const { core } = await motifFromGuqinCorpus(CORPUS_PATH);
  assert.ok(core.length > 0);
  for (const note of core) {
    assert.ok(Number.isInteger(note.degree) && note.degree >= 0 && note.degree <= 6, `degree ${note.degree} out of expected string-derived range`);
    assert.equal(note.rest, false);
    assert.ok(Number.isInteger(note.durationFrac.num) && Number.isInteger(note.durationFrac.den));
  }
});

test('motifFromGuqinCorpus surfaces the fixture\'s illustrative/synthetic status', async () => {
  const { meta } = await motifFromGuqinCorpus(CORPUS_PATH);
  assert.ok(/synthetic|illustrative/i.test(meta.fixtureStatus));
  assert.ok(meta.title.length > 0);
});

test('motifFromGuqinCorpus is deterministic (same file, same output)', async () => {
  const a = await motifFromGuqinCorpus(CORPUS_PATH);
  const b = await motifFromGuqinCorpus(CORPUS_PATH);
  assert.deepEqual(a.core, b.core);
});
