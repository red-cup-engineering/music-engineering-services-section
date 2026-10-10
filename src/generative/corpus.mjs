// corpus.mjs
//
// Optional bridge from data/corpus/*/*.json fixtures (currently just the
// illustrative guqin fixture, data/corpus/guqin/meihua-sannong-illustrative.json)
// into this engine's own leitmotif.mjs core-motif shape (melody.mjs's
// NoteEvent[]). Deliberately narrow and honest about what it does and
// doesn't claim, mirroring the corpus fixture's own source-note.md
// conventions:
//
// - Contour comes from the fixture's real, given `string` field (string
//   number 1-7, thickest/lowest-pitched through thinnest/highest-pitched --
//   an attested jianzipu convention per source-note.md, not invented for
//   this fixture) via a direct structural mapping (degree = string - 1,
//   so string 1 -> scale degree 0, string 7 -> scale degree 6 -- pitch
//   height tracks string height, which is the one real ordering fact the
//   corpus attests). This module does NOT read `pitch_interpretive` (the
//   fixture's own already-invented/interpretive pitch field) at all --
//   using only the real `string` field keeps this module one honesty layer
//   removed from the fixture's own labeled invention, rather than stacking
//   a second invented-pitch interpretation on top of the first.
// - Rhythm is NOT read from the fixture's `duration` field, which the
//   fixture's own schema documents as overwhelmingly "unspecified"
//   (jianzipu does not encode rhythm at all -- see source-note.md). This
//   module openly substitutes its own generic motif-duration palette
//   (melody.mjs's DURATION) to make an otherwise unplayable bare contour
//   renderable. It never presents that substituted rhythm as sourced.
//
// This module imports nothing from the DSP layer and is not wired into any
// default render path -- a caller opts in explicitly (see the "guqin-echo"
// preset in scripts/render-demos.mjs), consistent with the corpus fixture's
// own $fixture_status warning and this package's data/renders/
// zen-soundscape-pine-in-snow-note.md precedent of never using the guqin
// fixture's invented note content as if it were real transcribed material.

import { readFile } from 'node:fs/promises';
import { DURATION } from './melody.mjs';

const RENDER_DURATION_CYCLE = Object.freeze([DURATION.QUARTER, DURATION.DOTTED_QUARTER, DURATION.HALF]);

/**
 * Reads a guqin corpus fixture (scripts/load-corpus-piece.mjs's own schema)
 * and derives a leitmotif-compatible core motif from its note-events'
 * `string` field, in note-index order.
 * @param {string} filePath - path to a data/corpus/guqin/*.json fixture
 * @returns {Promise<{core: import('./melody.mjs').NoteEvent[], meta: {title:string, fixtureStatus:string}}>}
 */
export async function motifFromGuqinCorpus(filePath) {
  const raw = await readFile(filePath, 'utf8');
  const piece = JSON.parse(raw);

  const notes = [];
  for (const section of piece.sections ?? []) {
    for (const note of section.note_events ?? []) {
      notes.push(note);
    }
  }
  notes.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));

  const core = notes.map((note, i) => {
    const string = Number.isInteger(note.string) && note.string >= 1 && note.string <= 7 ? note.string : 4;
    const degree = string - 1; // real, given field (string height) -> scale-degree height; see this module's header comment
    return { degree, durationFrac: RENDER_DURATION_CYCLE[i % RENDER_DURATION_CYCLE.length], rest: false };
  });

  return {
    core,
    meta: {
      title: piece.piece?.title_en ?? 'unknown',
      fixtureStatus: piece.$fixture_status ?? 'unknown',
    },
  };
}
