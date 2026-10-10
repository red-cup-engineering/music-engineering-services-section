# Source note: `meihua-sannong-illustrative.json`

## Status, stated plainly up front

**This fixture is an illustrative/synthetic example, not a historical
transcription.** The note-events in `meihua-sannong-illustrative.json` are
invented. They are not decoded from the 1425 print of *Shen Qi Mi Pu*, from
any later handbook, or from any modern *dapu* (打譜, reconstruction)
recording or edition. Anyone using this file for anything beyond exercising
this project's own data-loading code should treat every `string`/`position`/
`technique`/`pitch_interpretive` value in it as made up.

This is a deliberate choice, explained below, not a shortcut.

## Why this piece, and why illustrative rather than real

The design consultation that scoped this fixture recommended a single real
piece from *Shen Qi Mi Pu* -- specifically naming *Meihua Sannong* (梅花三弄,
"Plum Blossom in Three Variations/Plays") as a well-documented, famous
candidate, checkable against existing modern reconstructions. That's a good
target in principle: it's one of the best-known pieces in the guqin
repertoire, and its broad structure is genuinely well documented in
secondary literature.

What I do not have is reliable, verbatim, note-by-note memory of the actual
jianzipu (減字譜) tablature text from the 1425 print -- the specific
string number, hui position, and technique glyph for each note-event, at the
granularity this fixture's schema asks for. That is exactly the kind of
narrow, primary-source-level detail (a specific woodblock-printed historical
document) that is easy to produce a plausible-sounding but inaccurate
guess for, and hard to verify without the source in hand. Guessing at that
level and presenting it as "the 1425 tablature for Meihua Sannong" would be
a fabrication attributed to a real historical source -- precisely the
failure mode this project's own house standard (see
`verified-structures-as-compositional-grammar.md` in the music-theory
service, which this note deliberately mirrors in structure) exists to rule
out: an invented compositional-analogy layer is fine as long as it is
labeled as invented, never presented as proved or sourced when it isn't.

So rather than fabricate a "decode," this fixture keeps the piece identity
and the well-attested structural facts about it (below), invents the
note-level content openly, and marks every invented field as such in the
JSON itself (`source_status: "synthetic_illustrative"` on every note-event,
plus a top-level `$fixture_status` warning). That is option (b) from this
task's own instructions -- a clearly-labeled illustrative example in the
target schema -- chosen over option (a), a smaller real partial
transcription, because I judged that even a "smaller" real transcription
would still require note-level primary-source recall I don't have
confidently for any specific passage of this piece.

## What's documented / attested (confident) vs. invented for this fixture (not attested)

This is the honest ledger.

**Documented, and used as-is:**

- *Shen Qi Mi Pu* (神奇秘譜, "Handbook of Spirit and Marvel") is a guqin
  tablature anthology compiled by Zhu Quan (朱權), a Ming-dynasty prince
  (Prince of Ning), with a preface dated 1425. It is widely cited as the
  earliest surviving printed collection of guqin tablature, and is in the
  public domain.
- The anthology is commonly cited as containing on the order of 64 pieces
  across three juan (volumes).
- *Meihua Sannong* is included in it, and is one of the guqin repertoire's
  most widely known pieces, with a continuous performance tradition carried
  through many later handbooks (not solely dependent on modern *dapu*
  reconstruction from this one source, unlike some rarer single-source
  pieces in the anthology).
- The piece's broad, documented macro-form: a recurring melodic idea played
  in harmonics (泛音), evoking the plum blossom, stated multiple times
  ("sannong" -- three plays/variations), alternating with contrasting
  passages of stopped-tone (按音) playing. This alternation pattern is the
  one structural fact this fixture's section layout (`harmonic-refrain-1`,
  `stopped-tone-passage-1`, `harmonic-refrain-2`, ...) is modeled on.
- Jianzipu's general notational convention -- what it does and does not
  specify -- is well documented and is not piece-specific: it encodes
  string number, hui (position marker) or open/harmonic status, and
  playing technique (which finger, which motion, ornaments like slides and
  vibrato), but historically does **not** encode absolute pitch or precise
  rhythm/duration. Those are transmitted separately, by oral tradition and
  a teacher-student performance lineage, not by the tablature text itself.
  This is the fact the fixture's schema is built to honestly represent
  (see `duration_policy` / `pitch_interpretive_policy` in the JSON).
- Yao Bingyan (姚丙炎, 1921-1983) was a real, notable 20th-century guqin
  player and *dapu* scholar associated with reconstruction work on pieces
  drawn from historical tablature collections including *Shen Qi Mi Pu*.
  I am **not** confident enough to state that he specifically produced a
  *dapu* of *Meihua Sannong* from this particular source, as opposed to
  other pieces in his known body of work, so this fixture does not claim
  or rely on that specific attribution -- it's named here only because the
  design consultation that scoped this task raised his reconstructions as
  a general checking method, and this note is being honest that no such
  check was actually performed.

**Invented for this fixture, and explicitly marked as such in the JSON:**

- Every `string`, `position.hui`, `technique`, and `pitch_interpretive`
  value on every note-event. None of it is decoded from any real source.
- The exact number of notes per section and their ordering within a
  section. Only the section-level alternation pattern (harmonic refrain /
  stopped-tone passage / harmonic refrain / ...) reflects a documented
  fact; the notes filling each section do not.
- The specific tuning reference pitch (string 1 = C3) used to compute the
  `pitch_interpretive` field. Guqin has no single historically fixed
  absolute pitch standard; this is a modern illustrative convention, not a
  claim about how the piece was historically pitched.
- The fixture is a short excerpt (13 note-events, 4 sections), not an
  attempt at a full performance-length piece. A real performance runs
  several minutes with far more note-events; this file does not pad itself
  out to that length with more invented material, and its last section is
  explicitly labeled as a truncation, not the piece's real ending.

## Confidence statement

- **High confidence:** the anthology-level facts (compiler, approximate
  date, "earliest printed guqin tablature," public-domain status), the
  general jianzipu notational convention (string/position/technique
  specified; absolute pitch and rhythm not specified), and the existence
  of a documented harmonic-refrain / stopped-tone alternation structure in
  this piece specifically.
- **Low/no confidence, and therefore not attempted as real content:**
  anything at the level of "this is what the tablature actually says" for
  any specific passage of *Meihua Sannong* -- exact string, exact hui,
  exact technique, exact note count, exact ordering. All of that is
  invented in this fixture and labeled `synthetic_illustrative`.
- **Zero confidence, and therefore not claimed:** that Yao Bingyan (or any
  other named performer/scholar) specifically reconstructed this piece
  from this anthology; that this fixture's note count, phrase lengths, or
  pitch choices resemble any real edition's in any specific way beyond the
  coarse structural pattern described above.

## What a real fixture would need

To honestly upgrade this from illustrative to real would require working
from an actual facsimile or verified transcription of the *Shen Qi Mi Pu*
print (or a scholarly edition/translation of it) with the tablature text in
hand -- not from memory. That is future work, out of scope here.

## Schema note

The JSON schema in this directory is this project's own scratch
intermediate format for note-events, designed to make the source-given vs.
interpretive distinction explicit and machine-checkable (see
`scripts/load-corpus-piece.mjs`). It is not the project's eventual
cross-tradition notation format, and it is not a general jianzipu encoding
standard -- it exists only to support this one fixture honestly.
