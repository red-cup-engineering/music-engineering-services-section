#!/usr/bin/env node
// load-corpus-piece.mjs
//
// Reads a corpus fixture (data/corpus/guqin/*.json) and prints its decoded
// note sequence after a basic shape validation pass. This is deliberately
// dumb: it checks that required fields are present and that fields this
// project's source notation genuinely leaves unspecified (duration, and
// often pitch) are represented HONESTLY -- a real value or an explicit
// "unspecified"/null marker -- rather than silently defaulted to something
// invented (e.g. a fabricated "quarter note").
//
// This is data-preparation tooling only. It does not touch, import, or
// depend on anything in src/generative/ or src/dsp/, and it is not wired
// into compose.mjs or render-track.mjs.
//
// Usage:
//   node scripts/load-corpus-piece.mjs
//   node scripts/load-corpus-piece.mjs --file data/corpus/guqin/meihua-sannong-illustrative.json

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SERVICE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_FILE = resolve(
  SERVICE_ROOT,
  'data/corpus/guqin/meihua-sannong-illustrative.json'
);

const POSITION_TYPES = new Set(['open', 'stopped', 'harmonic']);
const UNSPECIFIED_DURATION_MARKERS = new Set(['unspecified']);

function parseArgs(argv) {
  const args = { file: DEFAULT_FILE };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--file' && argv[i + 1]) {
      args.file = resolve(argv[++i]);
    }
  }
  return args;
}

// Validates a single note-event. Returns a list of problem strings (empty
// if the note is well-formed). Every problem is a human-readable sentence
// naming the note's index and the field at fault.
function validateNoteEvent(note, sectionId) {
  const problems = [];
  const where = `section "${sectionId}" note-event ${note?.index ?? '<no index>'}`;

  if (typeof note.index !== 'number') {
    problems.push(`${where}: missing/invalid "index" (expected number)`);
  }

  if (!Number.isInteger(note.string) || note.string < 1 || note.string > 7) {
    problems.push(
      `${where}: "string" must be an integer 1-7 (got ${JSON.stringify(note.string)})`
    );
  }

  if (!note.position || typeof note.position !== 'object') {
    problems.push(`${where}: missing "position" object`);
  } else if (!POSITION_TYPES.has(note.position.type)) {
    problems.push(
      `${where}: "position.type" must be one of ${[...POSITION_TYPES].join('/')} (got ${JSON.stringify(note.position.type)})`
    );
  }

  if (!note.technique || typeof note.technique !== 'object') {
    problems.push(`${where}: missing "technique" object`);
  } else if (
    typeof note.technique.right_hand !== 'string' ||
    note.technique.right_hand.length === 0
  ) {
    problems.push(`${where}: missing "technique.right_hand"`);
  }

  // The load-bearing honesty check: duration must be either a real,
  // structured duration value, or the explicit "unspecified" marker.
  // A missing field, or a bare fabricated-looking default, is a failure --
  // this project's source notation genuinely does not give rhythm, and
  // silently filling that gap would misrepresent the source.
  if (note.duration === undefined) {
    problems.push(
      `${where}: "duration" field is missing entirely -- must be a real value or the literal string "unspecified"`
    );
  } else if (
    typeof note.duration === 'string' &&
    !UNSPECIFIED_DURATION_MARKERS.has(note.duration)
  ) {
    problems.push(
      `${where}: "duration" is a bare string ${JSON.stringify(note.duration)} that isn't the explicit "unspecified" marker -- looks like a fabricated/default value`
    );
  }

  // pitch_interpretive, if present, must carry a status explaining whether
  // it's derived or deliberately left unpopulated -- never a silent number
  // with no provenance.
  if (note.pitch_interpretive !== undefined) {
    const pi = note.pitch_interpretive;
    if (!pi || typeof pi !== 'object') {
      problems.push(`${where}: "pitch_interpretive" must be an object if present`);
    } else if (typeof pi.status !== 'string' || pi.status.length === 0) {
      problems.push(
        `${where}: "pitch_interpretive" is missing a "status" string explaining its provenance`
      );
    } else if (
      pi.note_name !== null &&
      pi.note_name !== undefined &&
      typeof pi.derivation !== 'string'
    ) {
      problems.push(
        `${where}: "pitch_interpretive.note_name" is populated (${JSON.stringify(pi.note_name)}) but has no "derivation" explaining how it was computed -- a pitch value must not appear as if it were source-given`
      );
    }
  }

  if (note.source_status !== 'synthetic_illustrative') {
    problems.push(
      `${where}: "source_status" is ${JSON.stringify(note.source_status)}, not the expected "synthetic_illustrative" -- if this fixture has been upgraded to real transcribed content, this validator's expectations need updating too, not silently passed`
    );
  }

  return problems;
}

async function main() {
  const { file } = parseArgs(process.argv.slice(2));

  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (err) {
    console.error(`Failed to read corpus file at ${file}: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  let piece;
  try {
    piece = JSON.parse(raw);
  } catch (err) {
    console.error(`Failed to parse ${file} as JSON: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const problems = [];

  if (piece.$fixture_status === undefined) {
    problems.push(
      'top level: missing "$fixture_status" -- every fixture in this corpus must state its own provenance status up front'
    );
  }

  if (!Array.isArray(piece.sections) || piece.sections.length === 0) {
    problems.push('top level: "sections" must be a non-empty array');
  }

  let totalNotes = 0;
  const decoded = [];

  for (const section of piece.sections ?? []) {
    if (!section.section_id) {
      problems.push('a section is missing "section_id"');
      continue;
    }
    if (!Array.isArray(section.note_events)) {
      problems.push(`section "${section.section_id}": missing "note_events" array`);
      continue;
    }
    for (const note of section.note_events) {
      totalNotes++;
      problems.push(...validateNoteEvent(note, section.section_id));
      decoded.push({ section: section.section_id, note });
    }
  }

  console.log(`Loaded: ${file}`);
  console.log(`Fixture status: ${piece.$fixture_status ?? '<MISSING>'}`);
  console.log(
    `Piece: ${piece.piece?.title_en ?? '<unknown>'} (${piece.piece?.title_zh ?? '?'}), from ${piece.piece?.anthology_en ?? '<unknown anthology>'}`
  );
  console.log(`Sections: ${piece.sections?.length ?? 0}, note-events: ${totalNotes}`);
  console.log('');
  console.log('Decoded note sequence:');
  for (const { section, note } of decoded) {
    const posLabel =
      note.position?.type === 'open'
        ? 'open'
        : `${note.position?.type ?? '?'} @ hui ${note.position?.hui ?? '?'}`;
    const ornament = note.technique?.left_hand_ornament
      ? ` + ${note.technique.left_hand_ornament}`
      : '';
    const pitchLabel = note.pitch_interpretive?.note_name
      ? `pitch(interpretive)=${note.pitch_interpretive.note_name}`
      : 'pitch(interpretive)=unspecified';
    console.log(
      `  [${section}] #${note.index} string ${note.string}, ${posLabel}, ` +
        `${note.technique?.right_hand ?? '?'}${ornament}, ` +
        `duration=${JSON.stringify(note.duration)}, ${pitchLabel}`
    );
  }

  console.log('');
  if (problems.length > 0) {
    console.error(`VALIDATION FAILED: ${problems.length} problem(s):`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exitCode = 1;
  } else {
    console.log(`Validation passed: ${totalNotes} note-events, no problems found.`);
  }
}

main();
