# Music Engineering Services Section

A generative music engine: given a duration and a seed, it composes and
renders a complete stereo track and writes it out as a WAV file. No
arrangement is hand-authored -- every note, chord change, filter sweep, and
section boundary in a given render is produced by the generative layer
running on top of the DSP core, deterministically, from that one seed.

Two composition modes currently exist on top of the same DSP core and the
same generative kernel (`scale.mjs`'s maximal-evenness scale generator,
`regime.mjs`'s macro-form pacing, `motif-grammar.mjs`/`lambek.mjs`'s
Lambek-residuation motif grammar, `melody.mjs`'s developing-variation
operators):

- The original ambient pad/drone engine (`compose.mjs`'s `renderTrack`,
  `npm run render`): sustained additive-oscillator pads with a foreground
  melodic line layered on top. This is the engine's original identity and is
  kept as-is (see Verification below).
- Call-and-response duo improvisation (`improv-duo.mjs`'s `renderImprovDuo`,
  `npm run render:duo`): two idiomatic instrument voices -- a Karplus-Strong
  plucked string and a bow/breath voice -- trading real developing-variation
  phrases drawn from a piece-level motif vocabulary, instead of sustained
  drone voices. See "Call-and-response duo improvisation" below for the full
  account, including how honestly close this gets to "sounds like real
  music" versus what's still a pad-bed-shaped piece with different oscillators.
- Intensity-layered stem arrangement (`arrangement.mjs`'s
  `makeArrangement`/`scheduleArrangement`, `npm run render:arrangement` /
  `npm run render:demos`): a piece as four stacked stems (bed/pulse/
  ornament/lead) gated by a single continuous intensity parameter, plus a
  leitmotif system, a functional-harmony engine, and bar-quantized
  transitions (stingers/risers) -- the primitive adaptive game/casino music
  needs (idle floor -> anticipation -> celebration, no track change). See
  "Seeded adaptive arrangement" below for the full account, including its
  serializable performance-spec output contract for a downstream realtime
  player.

## Zero-dependency, pure-Node DSP

`src/dsp/` is a from-scratch digital signal processing core with no runtime
dependencies -- only Node's standard library (`node:fs/promises`) is used,
and only by the WAV writer. Everything else (oscillators, envelopes,
one-pole and biquad filters, a delay line used for chorus, a multi-comb/
allpass reverb, and the stereo mixing/panning/metering utilities) is plain
arithmetic over `Float64Array` buffers. The whole render pipeline works in
float64 internally and only quantizes once, at the very last step, when
writing 24-bit PCM samples to disk.

This is a deliberate choice, not an oversight: it keeps the signal chain
fully inspectable (every stage is a small, readable module you can trace
sample-by-sample) and keeps the service free of supply-chain surface area
from third-party audio libraries.

`dsp/oscillator.mjs`'s additive-partial timbres (`PARTIAL_PRESETS`) are
generated, not hand-listed: `generatePartials({count, rolloffExponent,
oddEvenBias})` derives a harmonic series from a spectral-rolloff exponent
(how fast upper harmonics fall off) and an odd/even bias (0 = full harmonic
series, 1 = odd-only), a real 3-parameter continuous space. The three named
presets (`warmPad`/`organLike`/`glassy`) are specific points in that space,
tuned by ear to land close to (not numerically identical to) their original
hand-listed values -- see that module's header comment for why an exact
match isn't the right bar here, unlike the scale generator below.

## Generative composition layer

`src/generative/` sits on top of the DSP core and is the part that actually
decides what to play. A seeded PRNG (`random.mjs`) drives every stochastic
decision, so a given `--seed` reproduces an identical track byte-for-byte.

### Pitch material: a real scale generator, not a 4-entry table

`scale.mjs` used to fix the pitch material to four hardcoded named modes
(dorian/aeolian/majorPentatonic/minorPentatonic), each a hand-listed
interval array. It now generates interval sets from combinatorial first
principles: **maximal evenness** (Clough & Douthett 1991) -- for a chromatic
universe of `c` pitch classes and a target cardinality `d`, the maximally
even `d`-note subset spreads its members as evenly as possible around the
chromatic circle (`J(d,c)_i = ceil(i*c/d)`). Rotating that set to start at
each of its own members in turn reproduces, exactly (checked in
`test/scale.test.mjs`), all seven classical diatonic modes at `(d=7, c=12)`
and both pentatonic collections at `(d=5, c=12)` -- the four modes this
module used to hardcode are the exact same four points in this generator's
space, not a separate mechanism kept alongside it. `generateModeIntervals`
exposes the full space: any cardinality 2..11 at any of its own rotations,
over any chromatic universe size -- 65 distinct `(cardinality, rotation)`
coordinates at `c=12` alone, times 12 possible roots, versus 4 retrievable
names. `randomModeCoordinates` picks from a genre-appropriate cardinality
range (5-8, avoiding the sparser/near-chromatic extremes) for callers that
want a random mode instead of always defaulting to dorian.

`scale.mjs` still exposes pitch classes two ways: a numerically-sorted list
(for bitmask/set-membership work) and a scale-degree-ordered list starting
at the tonic (for real diatonic transposition, where "up one degree" is a
whole or half step depending on where in the mode it falls -- not a fixed
semitone count).

### Macro-form: driven by the regime classifier, not clock percentages

`regime.mjs`, `flow.mjs`, `cover.mjs`, and `thermo.mjs` together govern
macro-form (section pacing and transitions), voice admission (which pitches
are allowed to sound and when), and humanization (detune/filter/onset
jitter, register self-balancing) as the track develops. `regime.mjs`'s
`classify()` is the one real reactive classifier in the system: it reads
actual engine state (active voice count, recent filter drift, ticks since
the last firing tick) and returns one of four regimes (`STRICT`/`SCOTT`/
`TRANSFINITE_BOUNDED`/`APERIODIC`).

A prior revision of the melodic layer's large-scale form
(`classifyMelodySection`) explicitly avoided using this classifier, splitting
the piece into fixed OPENING/DEVELOPMENT/RETURN time-fraction windows
(0-28%/28-80%/80-100% of the clock) instead -- its own header comment argued
that bending `classify()` to also mean "which third of the piece we're in"
would be curve-fitting, since `classify()` is reactive rather than a
pre-planned arc. That reasoning was backwards: a fixed clock-percentage
schedule *is* the curve-fit (it can't be wrong about whether anything
actually happened, only about whether the clock has ticked past 80% yet),
while `classify()`'s booleans are exactly what the engine's own state has
done. This is now fixed: `melody.mjs`'s `makeMacroFormState()` /
`advanceMacroFormPhase(state, regimeTag)` drive OPENING/DEVELOPMENT/RETURN
directly from the same `regimeTag` sequence `regime.mjs` already computes
every macro-tick, with no separate schedule. OPENING lasts exactly until the
regime first leaves `STRICT` (its starting regime); DEVELOPMENT is any
non-`STRICT` regime after that; RETURN is `STRICT` recurring *after* the
piece has left it at least once -- a genuine "the regime has returned to its
opening state after passing through the others" condition. Because regimes
are not monotone in time, RETURN can recur multiple times over a long piece
(a real rondo-like structure), and its windows can be short -- both are
honest consequences of driving this from real state instead of a schedule,
not bugs. `compose.mjs` logs every phase transition (`macroFormLog`) paired
with the `regimeTag` that caused it, so this alignment is checkable against
real render data, not just asserted; see Verification below.

### Motif shape: a real generative grammar, not a 4-entry enum

`melody.mjs` is the foreground melodic/motivic layer, layered over the
drone/pad bed the rest of this section describes. It generates short
pitch-interval/rhythmic-duration motifs from the active scale and develops
them with the four standard compositional operators -- transposition (by
scale degree, not semitone), inversion, retrograde, and rhythmic
augmentation/diminution (exact rational duration scaling, not approximated)
-- then assembles developed statements into phrases that close on a real
cadence: a resolution to the tonic, or the dominant if that's what the drone
bed is currently sounding, gated by `cover.mjs`'s sub-check admission logic
so the cadence lands on a pitch the bed actually voices.

The motif's own step-by-step shape used to come from `MOTIF_CHARACTERS`, a
4-entry enum of hand-designed contour-generator functions (stepwise/arch/
risingLeapDescent/repeatedLeap). It's now generated by `motif-grammar.mjs`,
built on `lambek.mjs` -- a port of `Obsmetrologia/Calculus/Logic/
LambekCalculus.lean`'s actual bi-residuation algebra (a lattice-ordered
monoid with two residuals, `a \ c` = "what must follow `a` to reach `c`" and
`c / b` = "what must precede `b` to reach `c`"), instantiated as the standard
formal-languages-under-concatenation model (finite languages over a small
step-token alphabet, bounded to a finite length; `dot` = truncated
concatenation; `lres`/`rres` = the ordinary left/right quotients). This is a
genuine instance of the algebra the Lean file proves things about -- checked
directly in `test/lambek.test.mjs` (dot's associativity, the full
bi-residuation adjunction, both modus-ponens laws, all as property-based
tests over random finite languages), not just borrowed terminology.

`motif-grammar.mjs`'s `generateTokenSequence` uses that algebra as an actual
generative mechanism: a target "closing category" (a net-displacement range,
optionally requiring or forbidding a genuine leap token) is built as a real
computed language, and at each position in the sequence, only tokens that
keep that category reachable within the remaining budget survive (computed
via a literal left-residual reachability test -- `modus_ponens_left` /
`dot_lres_adj` from the Lean file, applied directly). The result is
well-formed *by construction*, not well-formed on average, and it draws from
a combinatorially large space rather than 4 fixed shapes -- 5^N raw token
sequences before the per-token interval-magnitude sampling adds further
variety on top, filtered per call by the requested category.
`melody.mjs`'s `pickGrammarBiasForSection` still decides *which bias* a
section draws from (OPENING/RETURN: narrow, no leaps; DEVELOPMENT: a
weighted draw among narrow/leap-required/wide-net-displacement biases) --
that weighting is a real compositional choice, same as the old per-section
character weights were -- but the concrete shape for a chosen bias now comes
from the grammar's space, not a lookup.

A motif's rhythmic proportions are drawn from the same regime-selected
growth-tower sequence (`regime.mjs`) that paces the drone bed's onset timing
elsewhere -- reused for its genuinely distinct growth rates, not as a new
claim about which proportions sound best; see `melody.mjs`'s own header
comment for the full, honest account of which touchpoints are load-bearing
mechanism versus aesthetic reuse. In `compose.mjs`, the melodic voice reuses
the same oscillator/envelope/filter DSP primitives as the pad bed but with
settings suited to a foreground line: a fast (tens-to-low-hundreds-of-ms)
attack instead of the pad bed's 2-8s, a thinner partial preset, a brighter
filter cutoff, and a narrower stereo spread. OPENING/RETURN phrases share a
mid register and `glassy` timbre; DEVELOPMENT phrases roam across two
octaves and three timbre presets, so register/timbre variety tracks the same
regime-driven arc.

### Call-and-response duo improvisation: instruments, not pad-wash

Every generative mechanism described above -- the maximal-evenness scale
generator, the Lambek-residuation motif grammar, regime-driven macro-form --
was, until this addition, only ever pointed at sustained additive-oscillator
pad/drone voices (`dsp/oscillator.mjs`'s `additiveSample`, a multi-second
attack, held indefinitely). That's a real gap: the generative depth was
real, but nothing in the signal chain was an idiomatic instrument. This
section (`dsp/karplus-strong.mjs`, `dsp/bow-breath-voice.mjs`,
`generative/improv-duo.mjs`) adds two new instrument-synthesis techniques and
a real two-voice call-and-response dialogue built on the existing kernel,
addressing that gap directly -- as a second mode alongside the pad-bed
engine, not a replacement for it.

**Two instrument voices, not one:**

- `dsp/karplus-strong.mjs` is a real Karplus-Strong plucked string: a delay
  line tuned to the target pitch, seeded once with a burst of noise (the
  pluck), circulating through a one-pole lowpass "damping" filter each pass
  (the same `filter.mjs` primitive `reverb.mjs`'s comb filters use for their
  own damping) with feedback gain just under 1. The lowpass removes energy
  from high harmonics faster than the fundamental every time around the
  loop, which is what gives Karplus-Strong its characteristic bright-attack,
  darkening-decay pluck -- the whole amplitude envelope is the loop's own
  physics, not an applied ADSR curve. Verified against actual rendered
  samples (`test/karplus-strong.test.mjs`), not assumed from the
  implementation compiling: RMS in a 100ms window late in a 2-second decay
  drops to well under 20% of the RMS in the first three 100ms windows (real
  exponential-shaped decay); a Goertzel-DFT probe at the fundamental and its
  integer multiples shows several times the magnitude of a probe at an
  inharmonic frequency (a real comb-filtered harmonic spectrum, not noise);
  and the ratio of a high harmonic's magnitude to the fundamental's drops to
  under half its onset value by the end of the decay (the "highs die faster"
  darkening character specifically, not just an overall volume decay).
- `dsp/bow-breath-voice.mjs` is a sustained bow/blown-style voice: the
  existing additive oscillator (reused, not reimplemented) layered with
  genuine breath/bow noise -- lowpass-filtered white noise, mixed against the
  tone at a ratio that itself crossfades from heavier (at onset -- the
  breath "chiff" / bow "catch") to lighter (through the sustain), not a
  static breathy-sounding partial spectrum. Its attack is a real, audible
  swell (150-400ms depending on the flute/bowedString shape preset) --
  clearly faster than the pad bed's 2-8 second attack, clearly slower than a
  percussive onset. Verified against actual rendered samples
  (`test/bow-breath-voice.test.mjs`): level at the very onset measures well
  below the settled sustain level with a real (non-instantaneous) ramp
  between them; a Goertzel-DFT probe at a frequency between two harmonics
  shows measurable nonzero energy (the noise component, absent from a pure
  tone); and that probe's magnitude relative to the fundamental is
  measurably higher during the attack than during the sustain, matching the
  claimed crossfade.

**Real call-and-response, not independent parallel layers**
(`generative/improv-duo.mjs`): one voice states a "call" phrase (built with
`melody.mjs`'s existing `generatePhrase`, exactly as the pad bed's melodic
layer already does -- no phrase-assembly logic is duplicated), and the other
voice's "response" phrase's base motif is a literal developing-variation
transform (transpose / invert / retrograde / augment / an unaltered echo --
`melody.mjs`'s existing operators, not new ones) applied directly to the
call's own base motif, then developed further by the same `generatePhrase`
machinery. This is checked directly against the exact interval-sequence
algebra `melody.test.mjs` already proves for those operators (invert negates
the interval sequence, retrograde reverses-and-negates it, transpose/augment
leave it unchanged) -- `test/improv-duo.test.mjs` confirms every logged
response really does match its call under its logged operator, not just that
an operator name got recorded.

Turn-taking timing is genuinely variable, not a fixed wait-for-silence
rule: each exchange picks one of three overlap modes -- `wait` (a real
silence gap before the response enters), `trade` (response enters right at
the call's tail, minimal gap), or `overlap` (response enters partway through
the call, true simultaneous sounding) -- weighted by the current macro-form
phase (DEVELOPMENT leans toward trading/overlapping, OPENING/RETURN lean
toward the classic wait-and-answer shape, mirroring the same "OPENING/RETURN
stay narrow, DEVELOPMENT roams" arc `melody.mjs` already uses for motif
shape and register). `computeOverlapStats` measures the actual scheduled
outcome exactly (a sweep-line over both voices' note intervals, not sampled
from audio) -- see Verification below for a real render's numbers.

**A piece-level motif vocabulary, not fresh material every phrase**
(the "confined to certain motifs" the operator asked for): a small set of
seed motifs is generated once per session and is what most calls draw from
and develop -- the literal extension of `melody.mjs`'s existing single-motif
OPENING/RETURN thematic-return mechanism to a whole small vocabulary drawn
from continuously. The vocabulary is allowed to grow slowly (an occasional
call introduces a fresh grammar-drawn motif, bounded by `maxVocabularySize`)
rather than being either completely frozen or regenerated every phrase.
Instruments and scale are likewise real, explicit inputs to
`renderImprovDuo`/`createImprovDuoSession` (`mode` accepts anything
`scale.mjs` accepts, including direct `{cardinality, rotation}` generator
coordinates, not just the four named modes), not hardcoded.

Harmonic coordination between the two voices reuses `flow.mjs`'s driven
closure-flow engine (the same primitive the pad bed's own voice-admission
logic runs) purely as a slowly-evolving `chordMask` signal: both the call's
and the response's cadences read the *same* mask via `cover.mjs`'s
`subCheck` (through `melody.mjs`'s existing `chooseCadenceDegree`), so their
cadential resolutions are genuinely coordinated with each other and with the
regime-driven pacing, not independently guessed. No pad-bed audio is
rendered by this module -- the flow engine is reused as pacing/harmony
state only.

**Open-ended architecture:** `createImprovDuoSession` allocates no audio
buffer and assumes no total duration. `advanceImprovDuo(session, throughSec)`
extends a session's schedule and regime/harmony state up to `throughSec` and
can be called again later with a larger value to keep extending the same
session indefinitely -- the literal "generate the next N seconds of state,
given current state" unit, and the real building block a future live/
streaming caller would drive in a loop. `test/improv-duo.test.mjs` checks
this directly: calling `advanceImprovDuo` in several increasing chunks
produces byte-identical scheduling state to calling it once for the final
duration. `renderImprovDuo` (the convenience wrapper used by
`scripts/render-improv-duo.mjs`) *does* allocate one fixed-size buffer up
front to actually synthesize audio for a normal finite render -- turning
that into a true incremental/streaming *audio* renderer is a buffering
concern the task this was built against explicitly scoped out ("you don't
need to build a full streaming HTTP endpoint"). **Honest comparison to the
older engine:** `compose.mjs`'s `renderTrack` has the same
allocate-one-buffer-up-front shape and additionally bakes `durationSec`
into its own macro-tick loop's outro logic (`OUTRO_FRACTION`, computed from
the total duration) -- `renderTrack`'s core loop, unlike
`advanceImprovDuo`'s, was not restructured by this work and would need
similar treatment later if the live-data-driven stretch goal is ever
pursued against the pad-bed engine specifically.

**Usage:**

```sh
npm run render:duo -- --duration 720 --seed 561 --title "String and Breath Duo"
```

Flags: the same `--duration`/`--seed`/`--title`/`--out`/`--mode`/`--root`
shape as `render-track.mjs`, plus `--reverbPreset` (default `chamber` here,
not `deepAmbient` -- a duo dialogue needs to stay legible/present, not
washed into a long reverb tail; chorus is not applied at all in this mode,
by design, to keep the two voices' spectra distinguishable). The CLI's
self-checks mirror `render-track.mjs`'s duration-gated approach (a `--duration
20` smoke test doesn't fail for not yet exhibiting motif recurrence that
needs several exchanges to show up) and add: real call-and-response
turn-taking (both-sounding, string-only, AND breath-only time must all
occur, `--duration >= 120`), neither voice dominating the phrase count
(`--duration >= 60`), motif-vocabulary recurrence (`--duration >= 180`), and
-- measured directly from the rendered audio via a small Goertzel-DFT probe
grid, not assumed -- spectral distinctness between the two voices in their
isolated (non-overlapping) sounding windows (`--duration >= 60`).

### What didn't change here, and why

`instrument.mjs` (a generic instrument-definition -> voice-state builder) and
a "style config" layer (`styles/ambient-drone.mjs`, `styles/game-stinger.mjs`)
were added in an earlier, interrupted refactor. The style-config layer was
**removed**: it was two hand-picked preset objects behind a name, which is
exactly the hardcoded-enum pattern the rest of this refactor replaced
elsewhere -- adding a second style preset did not fix "not algorithmic
enough," it repeated the pattern one level up. `instrument.mjs` survives
because it isn't a preset table itself, just a reusable definition->voice
constructor; it remains unused by `compose.mjs` (which still builds its two
voice recipes inline) and untested for that reason. If a continuous
parameter vector (duration, energy/temperature, attack-time bias, density)
ever needs to reach the DSP layer, this is the shape it should target --
that wiring hasn't been done.

The generative layer draws its structural vocabulary -- closure operators,
regime classification, settlement spirals, driven closure flow, sheaf
covers, and now bi-residuated categorial grammar -- from Obsmetrologia.
That borrowing is arithmetic and structural only (distinct, well-behaved
growth/convergence dynamics, a real admission test, and a real residuation
algebra, that happen to make good macro-form pacing, voice gating, and motif
generation), not a claim that ambient music composition literally is the
mathematics it's named after. See the Music Sciences generative-theory note
in music-theory-services-section for the fuller account of that mapping.

## Seeded adaptive arrangement (leitmotif / harmony / transitions)

Everything above renders one fixed-duration, non-interactive piece. This
section adds a second, generic layer on top of the same DSP core and
generative kernel, built specifically so a caller can drive one continuous
`intensity` parameter over time and get a musically coherent adaptive
result -- the primitive a game (or a social-casino UI: `casino.561.group`
was this pass's proving ground, not its scope) needs for "idle floor ->
anticipation -> celebration" without switching tracks. None of it replaces
`compose.mjs`'s `renderTrack` or `improv-duo.mjs`'s `renderImprovDuo`; it is
a third mode, reusing `scale.mjs`, `melody.mjs`'s developing-variation
operators, and the DSP core exactly as they already existed.

**Honest connection to existing code:** `src/service/presets.mjs`'s own
header comment above `MOOD_PRESETS`/`intensityToMoodName` already flagged
this gap explicitly: `intensity` there is a real 0-1 number, but it only
selects one of 3 fixed mood buckets (calm/resolving/tense) -- it doesn't
reach voice density, section pacing, or humanization, because those
weren't parameters `renderTrack()` exposed, and the comment says wiring a
real continuous energy input through is "future work, tracked here rather
than silently implied." `arrangement.mjs`'s `stemDensityAt` is that future
work, implemented -- but as a new, separate arrangement primitive
alongside `compose.mjs`'s tick loop, not by retrofitting continuous
intensity into `renderTrack()`'s own macro-tick loop. That retrofit remains
undone; a real numeric intensity input into `compose.mjs` specifically
would still be new work, same as before this pass.

### Leitmotif system (`leitmotif.mjs`)

Generates a short, seed-deterministic identity motif (`makeLeitmotif(seed,
opts)`, returning `{id, seed, core}` where `core` is exactly `melody.mjs`'s
`NoteEvent[]` shape) and a deterministic family of developing-variation
statements from it (`generateFamily(leitmotif, {size, names})`), built
entirely on `melody.mjs`'s existing operators -- `transposeMotif`/
`invertMotif`/`retrogradeMotif`/`augmentMotif`/`diminishMotif` -- plus two
compound transforms (`retrogradeInvert`, `transposeAugment`) composed from
the same four primitives, not new pitch/rhythm mechanisms
(`deriveVariation(motif, transformName, params)`). "Re-harmonizing" a
leitmotif is not a mutation at all: `reharmonizeAgainstScale(motif, scale,
baseOctaveIndex)` replays the identical degree/duration sequence through
`melody.mjs`'s `degreeToHz` against a *different* scale, so the same
identity sounds in a different harmonic color for free (checked in
`test/leitmotif.test.mjs`: identical degrees, different Hz). A game, a
persona, or a jackpot tier owns one seed and gets a recognizable recurring
figure plus a large, deterministic family of variations, not a single fixed
riff repeated identically.

### Functional harmony engine (`harmony.mjs`)

Ordinary common-practice harmony (tertian triads, tonic/predominant/
dominant function, tension/resolution), encoded generatively rather than as
a hand-picked progression table -- this is *not* a port of Obsmetrologia
material like `regime.mjs`/`cover.mjs`/`flow.mjs`/`thermo.mjs`/`lambek.mjs`
are; the Music Sciences generative-theory note this README points to above
doesn't currently cover functional harmony, so this module is standard
theory in the same "real classifier/real generator, not an enum" spirit as
the rest of the codebase.

- `diatonicTriadDegrees(degree)` / `triadMask(scale, degree)`: stacked-third
  triads built directly in scale-degree space (works for any cardinality,
  not just 7-note diatonic scales); `triadMask` returns the same 12-bit
  pitch-class bitmask shape `cover.mjs`'s `chordMask` already uses.
- `classifyFunction(scale, degree)`: generalizes "V is a fifth above I" /
  "IV is a fourth above I" to any mode by finding the scale degree closest
  (by real semitone distance) to a perfect fifth/fourth above the tonic,
  then classifies every other degree by shared-tone substitution (>=2
  common pitch classes with the tonic or dominant triad) -- the standard
  "common-tone" account of why vi/iii/ii/IV group functionally the way they
  do, computed from real triad bitmasks, not asserted per scale degree by
  name.
- `generateProgression(rng, scale, {length, startFunction,
  requireResolution})`: a weighted Markov grammar over the three functional
  categories (dominant resolves to tonic far more often than it wanders to
  predominant; predominant moves on to dominant far more often than it
  returns straight to tonic), each chord carrying a real tension value
  (`FUNCTION_TENSION`: tonic 0.1, predominant 0.5, dominant 0.9). With
  `requireResolution` (default true) the progression's *final* chord is
  guaranteed to be the literal tonic (scale degree 0), appended if the walk
  didn't already land there.
- `scheduleProgression(progression, {startSec, chordDurationSec})`: lays a
  progression out in absolute transport time -- the real, checkable
  tension-over-time curve an intensity/mix layer can read.
- Modal drift (`makeModalDriftState`/`stepModalDrift`): a slow long-form
  harmonic-color-change walker over `scale.mjs`'s own maximal-evenness
  generator coordinates -- most steps rotate within the same underlying
  pitch-class collection (a small color shift, e.g. Dorian drifting to
  Phrygian), rarer steps change the collection's cardinality itself (a
  bigger shift, e.g. diatonic drifting toward pentatonic). Every reachable
  coordinate is a real point in `generateModeIntervals`'s space, checked
  directly in `test/harmony.test.mjs`, not a hand-picked "next mode" table.

### Arrangement / intensity layering (`arrangement.mjs`) -- the key adaptive-music primitive

`makeArrangement(opts)` builds a scale, a harmony.mjs progression, and a
leitmotif+family from one seed. `scheduleArrangement(arrangement,
{durationSec, intensityFn})` walks the piece bar by bar and, at every bar,
reads `intensityFn(tSec)` (a plain 0-1 number, or a function of transport
time -- see `intensityFromBreakpoints` below) to decide which of four stems
sound and how densely:

| stem       | role                                    | default activateAt |
|------------|-----------------------------------------|---------------------|
| `bed`      | sustained harmonic pad (chord tones)    | 0.0 (always present, but thins to fewer chord tones at low intensity) |
| `pulse`    | rhythmic ostinato (root/fifth)          | 0.2 |
| `ornament` | sparse high-register sparkle fragments  | 0.45 |
| `lead`     | full leitmotif-family statements        | 0.7 |

`stemDensityAt(layerCfg, intensity)` is the actual primitive: exactly 0
below `activateAt`, scaling linearly from `minDensity` to `maxDensity`
above it. Raising intensity therefore **adds layers** (more stems
contributing, more notes per stem), not just volume -- checked directly in
`test/arrangement.test.mjs` (`stemDensityAt` is monotonically
non-decreasing; a low-intensity schedule activates strictly fewer stems
than a high-intensity one; a stem's own note count never decreases as
intensity rises). `intensityFromBreakpoints(breakpoints)` builds a
piecewise-linear function of time from `{tSec, intensity}` points -- the
tool for scoring a real arc (idle floor -> ramp -> celebration plateau).
Everything is deterministic given the same arrangement and a pure
`intensityFn`: `scheduleArrangement` derives its own scheduling PRNG from
`arrangement.seed` alone (`leitmotif.mjs`'s `childSeed` convention), never
from wall-clock time or call order.

### Transitions (`transitions.mjs`)

Musically-aligned state changes over the same plain event-stream data:

- `nextBarBoundarySec(tSec, secPerBar)` / `nextPhraseBoundarySec(tSec,
  secPerBar, barsPerPhrase)`: quantize a requested time forward to the next
  bar/phrase line (a no-op if already exactly on one).
- `scheduleStinger(events, {atSec, quantizeSecPerBar, motif, stem,
  instrumentHint})`: lays a motif (typically one `leitmotif.mjs` family
  member) out as new note events on top of an existing event list --
  **pure overlay**: existing events for every other stem are untouched, so
  a stinger never stops or retriggers the bed/pulse already sounding.
- `scheduleRiser(events, {fromSec, targetBeatSec, quantizeSecPerBar, stem,
  param, fromValue, toValue, curve})`: a parameterized automation ramp
  whose *resolution* (not just its start) lands exactly on a target
  bar/beat -- a riser that reads as scored to the moment it resolves into,
  not an arbitrary-length swell.

### DSP voice families

Extended in the DSP core's own idiom (a real generator over a continuous
parameter space, named presets as specific points in it -- the same
discipline `generatePartials`/`generateModeIntervals` already established):

- **bell** (`dsp/oscillator.mjs`'s `generateBellPartials` +
  `PARTIAL_PRESETS.bell`): an inharmonic partial series via the standard
  stiff-string/plate stretching formula (`ratio(n) = n * sqrt(1 +
  inharmonicity * n^2)`) -- a real acoustic model, not a hand-picked bell
  spectrum, degenerating to an exact harmonic series at `inharmonicity=0`.
- **bass** (`PARTIAL_PRESETS.subBass`): a generated harmonic series plus one
  sub-octave partial (ratio 0.5) prepended -- `additiveSample` places no
  constraint on ratio being >=1, so this reuses the existing additive
  oscillator slightly outside its usual integer-harmonic range rather than
  adding a new synthesis mechanism.
- **pluck** (`dsp/karplus-strong.mjs`'s `PLUCK_PRESETS`): named
  (`decay`, `dampingHz`) points in the existing Karplus-Strong algorithm's
  own parameter space -- `nylon`/`steel`/`muted`/`guqinAdjacent`.
- **percussion** (`dsp/percussion.mjs`, new): a filtered-noise-burst voice
  -- seeded white noise through an RBJ bandpass biquad (the same primitive
  `formant.mjs`'s overtone sweep uses, fixed at one center frequency) with
  a fast-attack/exponential-decay envelope. Named presets:
  `shaker`/`tick`/`softMallet`/`rimClick`. This is the "idiomatic short hit"
  character the DSP core had nothing built for previously (pitched-sustain,
  pitched-decay, and sustain-plus-noise voices already existed; a fourth,
  unpitched-hit character did not).
- **Per-stem mix chain** (`dsp/mixer.mjs`'s `makeStemChannel`/
  `mixStemSample`): level/pan/reverb-send per stem, layered on top of
  `mixInto`'s existing per-voice gain/pan rather than replacing it -- a
  stem's `space` (0-1) controls how much of it is routed to the shared
  reverb send bus versus straight to the dry bus, the "how far back in the
  mix" control per stem.

### Performance-spec contract -- the integration seam

Two pure outputs, both built from the same `arrangement.mjs` +
`transitions.mjs` event data:

1. **Offline WAV**, via the existing render path: `buildPerformanceSpec` ->
   `compose-arrangement.mjs`'s `renderPerformanceSpecToBuffer` ->
   `dsp/wav-writer.mjs`'s `writeWavFile` (see `scripts/render-arrangement.mjs`
   and `scripts/render-demos.mjs`).
2. **A serializable performance spec**: a plain, JSON-serializable note/
   automation event stream with absolute timing, for a downstream realtime
   consumer (a game's audio kit -- `resonator`, ported from this engine and
   under concurrent development, is the intended first consumer) to play
   the same material this package can also render offline. Every event uses
   absolute `startSec`/`durSec` (not bar/beat position or a delta from the
   previous event) so a consumer never has to reconstruct tempo math to
   know when something happens.

`buildPerformanceSpec(arrangement, scheduled, meta)`
(`performance-spec.mjs`) produces:

```js
{
  version: 1,                         // PERFORMANCE_SPEC_VERSION
  id: string,
  title: string,
  seed: number | string,
  durationSec: number,
  tempoBpm: number,
  beatsPerBar: number,
  secPerBeat: number,
  secPerBar: number,
  numBars: number,
  scale: {
    root: string,                     // e.g. 'D'
    mode: string | { cardinality: number, rotation?: number }, // scale.mjs mode spec, exactly as passed to makeArrangement
    modeLabel: string,
    degreePitchClasses: number[],
  },
  progression: Array<{                // harmony.mjs's scheduled chord progression
    degree: number, functionLabel: 'tonic'|'predominant'|'dominant',
    tension: number, startSec: number, durSec: number,
  }>,
  leitmotif: { id: string, seed: number|string, core: NoteEvent[] }, // melody.mjs NoteEvent[] shape: {degree, durationFrac:{num,den}, rest}
  stemLayers: {                        // per-stem activation config actually used (arrangement.mjs's DEFAULT_STEM_LAYERS shape)
    bed: {activateAt, minDensity, maxDensity}, pulse: {...}, ornament: {...}, lead: {...},
  },
  intensityLog: Array<{ tSec: number, intensity: number }>, // one entry per bar, the actual sampled intensity curve
  events: Array<
    | { type: 'note', stem: 'bed'|'pulse'|'ornament'|'lead', instrumentHint: 'pad'|'bass'|'bell'|'pluck'|'percussion',
        degree: number, octaveIndex: number, startSec: number, durSec: number, velocity: number,
        pluckPreset?: string, transformName?: string }
    | { type: 'automation', stem: string, param: string, startSec: number, durSec: number,
        fromValue: number, toValue: number, curve: 'linear'|'exp' }
    | { type: 'transition', kind: 'stinger'|'riser', stem: string, startSec: number, durSec: number }
  >,
}
```

`degree` is always a `scale.mjs` scale degree (0 = tonic), exactly
`melody.mjs`'s existing convention -- a consumer resolves it to Hz/MIDI via
its own copy of the same `(root, mode)` scale (`degreeToHz`'s algorithm:
maximal-evenness generator degree -> pitch class -> octave, see
`scale.mjs`). `automation` events describe a parameter ramp a live
consumer should apply itself (this package's own offline renderer
interprets `cutoffHz`/`bandHz` by sampling the ramp once per note's own
onset -- see `compose-arrangement.mjs`'s header comment for exactly what
is and isn't realized offline; `density` automation carries no direct audio
meaning offline since `arrangement.mjs` already bakes density into discrete
note events, but is meaningful to a live scheduler deciding whether to add/
remove notes in real time). `validatePerformanceSpec(spec)`
(`performance-spec.mjs`) is a cheap shape check (required fields, valid
event types, finite non-negative timing) available to any consumer, not
just this package's own tests.

**Worked adaptive-music example** (one seed, floor -> riser -> fanfare):

```js
import { makeArrangement, scheduleArrangement, intensityFromBreakpoints } from './src/generative/arrangement.mjs';
import { buildPerformanceSpec } from './src/generative/performance-spec.mjs';
import { scheduleRiser } from './src/generative/transitions.mjs';
import { renderPerformanceSpecToBuffer } from './src/generative/compose-arrangement.mjs';

const arrangement = makeArrangement({ seed: 561, root: 'D', mode: 'dorian', tempoBpm: 96 });
const durationSec = 40;

// Idle floor (0.15) -> anticipation ramp -> near-full celebration (0.95).
const intensityFn = intensityFromBreakpoints([
  { tSec: 0, intensity: 0.15 },
  { tSec: durationSec * 0.6, intensity: 0.35 },
  { tSec: durationSec, intensity: 0.95 },
]);

let scheduled = scheduleArrangement(arrangement, { durationSec, intensityFn });

// A bar-quantized riser resolving exactly on the final bar.
const riser = scheduleRiser(scheduled.events, {
  fromSec: durationSec * 0.5, targetBeatSec: durationSec, quantizeSecPerBar: arrangement.secPerBar,
  stem: 'ornament', param: 'cutoffHz', fromValue: 700, toValue: 7500, curve: 'exp',
});
scheduled = { ...scheduled, events: riser.events };

const spec = buildPerformanceSpec(arrangement, scheduled, { title: 'Floor to Fanfare', durationSec });
const { left, right, sampleRate } = renderPerformanceSpecToBuffer(spec, { reverbPreset: 'hall' });
// ...or hand `spec` (JSON.stringify-able) to a realtime consumer instead of rendering it here.
```

This exact shape (minus the riser) is `scripts/render-arrangement.mjs`'s
CLI; the full worked example including the riser and a motif-driven stinger
is `src/generative/demo-presets.mjs`'s `anticipation-riser` and
`celebration-fanfare` presets, rendered by `npm run render:demos` into
`data/renders/anticipation-riser.wav` / `celebration-fanfare.wav` (see
`data/renders/demo-presets-note.md`).

### Demo presets (`demo-presets.mjs`, `npm run render:demos`)

Five presets proving the range, each a fully worked
`{arrangement, scheduled, spec, reverbPreset}`:

- **`lounge-noir`**: a static-intensity (0.3) ambient bed, A aeolian, nylon
  pluck pulse, `chamber` reverb.
- **`anticipation-riser`**: an intensity arc activating every stem in turn,
  plus a `transitions.mjs` riser brightening the ornament stem.
- **`celebration-fanfare`**: D Ionian/major, held high intensity, plus a
  motif-driven stinger (the piece's own leitmotif, transposed) at the first
  downbeat.
- **`sparkle-ornament`**: tuned so only bed + a heavily-favored ornament
  stem are reachable -- exercises ornament density in isolation.
- **`guqin-echo`**: exercises the guqin corpus pipeline (`corpus.mjs`) --
  see below.

### Guqin corpus pipeline (`corpus.mjs`)

`motifFromGuqinCorpus(filePath)` derives a leitmotif-compatible core motif
from `data/corpus/guqin/meihua-sannong-illustrative.json`'s note-events,
using **only the fixture's real, given `string` field** (string number 1-7,
thickest/lowest-pitched through thinnest/highest-pitched -- an attested
jianzipu convention per `data/corpus/guqin/source-note.md`, not invented for
this fixture): `degree = string - 1`. It does **not** read the fixture's own
`pitch_interpretive` field (already labeled invented/interpretive by the
fixture itself) -- using only the real `string` field keeps this module one
honesty layer removed from the fixture's own labeled invention. Rhythm is
**not** read from the fixture's `duration` field (documented as
overwhelmingly `"unspecified"` -- jianzipu does not encode rhythm at all);
this module openly substitutes its own generic duration palette to make the
bare contour renderable, and never presents that substituted rhythm as
sourced. `makeArrangement`'s new `leitmotifCore` option accepts this
corpus-derived core directly, bypassing the generated-motif path so a
corpus-shaped identity flows through the same family/transform/scheduling
machinery as a freshly generated one. `guqin-echo`
(`npm run render:demos -- --preset guqin-echo`) is the worked example; see
`data/renders/demo-presets-note.md` for the exact honesty accounting on that
render specifically.

### Tests

`test/leitmotif.test.mjs`, `test/harmony.test.mjs`, `test/arrangement.test.mjs`,
`test/transitions.test.mjs`, `test/performance-spec.test.mjs`,
`test/demo-presets.test.mjs`, `test/dsp-additions.test.mjs`, and
`test/corpus.test.mjs` cover this whole layer: determinism (seed ->
byte-identical event stream, checked at the leitmotif, arrangement, and
full-spec levels independently), theory sanity (every triad stays diatonic;
every scale degree gets a valid function label; generated progressions
always resolve to the literal tonic; tension values track `FUNCTION_TENSION`
exactly), and layering behavior (intensity is monotonically non-decreasing
in `stemDensityAt`; a low-intensity schedule activates strictly fewer stems
than a high-intensity one; a stem's note count never decreases as intensity
rises). All existing tests continue to pass unchanged -- nothing in
`compose.mjs`, `improv-duo.mjs`, or the DSP core's existing exports was
modified, only added to.

## Usage

```sh
npm run render -- --duration 120 --seed 561 --title "Settling Spiral" \
  --out ./data/renders/settling-spiral.wav
```

or directly:

```sh
node scripts/render-track.mjs --duration 120 --seed 561 --title "Settling Spiral"
```

Flags (all optional): `--duration` (seconds, default 120), `--seed`
(integer or string; omit for a time-based seed), `--title` (default
"Settling Spiral", also used to derive the output filename when `--out` is
omitted), `--out` (output WAV path, default
`data/renders/<slug-of-title>.wav`), `--mode` (`dorian`/`aeolian`/
`majorPentatonic`/`minorPentatonic` -- named special cases of `scale.mjs`'s
maximal-evenness generator; call `renderTrack({mode: {cardinality, rotation}
, ...})` directly, not via this CLI flag yet, to reach the rest of the
generator's space), `--root` (default `D`), `--reverbPreset`
(`deepAmbient`/`hall`/`chamber`), `--melody` (default on; the foreground
melodic/motivic layer described above) / `--no-melody` (pad bed only,
reproducing the original drone-only behavior).

The CLI self-verifies the rendered audio before writing anything to disk --
finite samples, no clipping, an RMS floor so a near-silent render fails loud
instead of shipping quietly, a duration sanity check, (when `--melody`
is on and `--duration` is at least 30s) a check that the melodic layer
actually produced varied note onsets, not a silent or monotone one, and
(when `--melody` is on and `--duration` is at least 120s) a large-scale-form
check that DEVELOPMENT's average melodic interval actually came out wider
than OPENING's in the rendered onset log -- and exits nonzero (naming the
failing check) if any of that fails, so it's safe to use as a CI/verify
step, e.g. `npm run render -- --duration 5` as a fast smoke test. On any
render long enough to exercise it, the printed report also breaks the
melodic layer's onset log down by large-scale section (mean interval size,
register, timbre) -- real numbers from the actual render, not an assumption
that the arc happened. `renderTrack()`'s return value also includes
`macroFormLog` (every phase transition, paired with the regimeTag that
caused it) and `motifShapeLog` (every generated phrase's base motif as a raw
interval-delta sequence) for offline analysis -- these are what back the
measured evidence below, not printed by the CLI report itself.

`npm run check` runs `node --check` over every `.mjs` file in `src/` and
`scripts/`. `npm test` (`node --test`) runs the test suite in `test/`:

- `leitmotif.test.mjs`, `harmony.test.mjs`, `arrangement.test.mjs`,
  `transitions.test.mjs`, `performance-spec.test.mjs`,
  `demo-presets.test.mjs`, `dsp-additions.test.mjs`, `corpus.test.mjs`: the
  seeded adaptive arrangement layer -- see "Seeded adaptive arrangement"
  above for what each checks.
- `cover.test.mjs`: the sub-check/join-check admission primitives.
- `regime.test.mjs`: bounded monotone drift, growth-tower sequences, the
  regime classifier.
- `thermo.test.mjs`: the Boltzmann register-balancing migration.
- `scale.test.mjs`: the maximal-evenness generator reproduces all seven
  diatonic modes and both pentatonic collections exactly; the legacy named
  modes are byte-identical to their pre-refactor hardcoded interval lists;
  the generator's combinatorial space (cardinality x rotation) is checked
  directly, not just described.
- `lambek.test.mjs`: the ported Lambek-calculus instance's own algebraic
  laws -- `dot` associativity, the full bi-residuation adjunction, both
  modus-ponens laws -- as property-based tests over random finite languages,
  plus a concrete non-commutativity example (the reason two residuals are
  needed instead of one).
- `motif-grammar.test.mjs`: every generated token sequence is well-formed by
  construction (satisfies its own requested bias, including the defensive
  fallback path); the generated space is measurably large (>30 distinct
  sequences across 500 draws at one fixed length/bias).
- `melody.test.mjs`: the developing-variation operators' algebraic
  identities (retrograde-of-retrograde recovers the original; inversion
  around a fixed axis is its own inverse; augment-then-matching-diminish
  recovers exact rational durations); the regime-driven macro-form state
  machine (OPENING never recurs once left; section boundaries track
  scripted regime transitions exactly, at any tick count); the grammar-based
  motif variety (>50 distinct interval-sequence shapes across 400 draws);
  and DEVELOPMENT-section phrases measurably using wider average melodic
  intervals than OPENING-section phrases across many seeds.
- `oscillator.test.mjs`: the generated partial-series timbre model
  (monotonic decay with rolloff exponent, exact odd-harmonic removal,
  normalization holds across the parameter space).
- `karplus-strong.test.mjs`: the plucked-string voice's decay is real and
  exponential-shaped (measured RMS, not assumed), its spectrum is genuinely
  comb-filtered/harmonic (Goertzel-DFT probes), and its damping filter
  removes high harmonics faster than the fundamental (the specific
  "darkening decay" claim, checked separately from overall volume decay).
- `bow-breath-voice.test.mjs`: the bow/breath voice's attack is a real,
  measurable, non-instantaneous swell in the claimed 150-400ms range; its
  noise component is measurably present (nonzero energy at an inharmonic
  probe frequency) and measurably heavier during the attack than the
  sustain, matching the claimed crossfade.
- `improv-duo.test.mjs`: determinism; the scheduling loop is genuinely
  incremental (chunked `advanceImprovDuo` calls match one call to the final
  duration); real turn-taking (neither voice's phrase count nor sounding
  time collapses to near-zero over a long session); a genuine mix of all
  three overlap modes occurs; `computeOverlapStats`'s sweep-line math is
  checked against a hand-worked example with a known answer; the piece-level
  motif vocabulary recurs with byte-identical interval shapes across
  multiple calls and stays bounded at `maxVocabularySize`; every logged
  response phrase's interval sequence matches the exact algebraic transform
  of its call under its logged operator; call and response always swap both
  voice and instrument; and the rendered audio is finite/non-silent and
  responds to real scale-parameterization (named modes vs. direct generator
  coordinates produce different, valid audio).

## Verification: measured evidence, not just "it's more algorithmic now"

A 900-second (15-minute) render, seed `561`, dorian/D/deepAmbient (see
`data/renders/regime-rondo.wav`, reproducible via `npm run render --
--duration 900 --seed 561 --title "Regime Rondo"`):

- **Macro-form now tracks regime transitions, checked against the actual
  render log, not asserted:** 14 raw `classify()` regime changes occurred;
  8 of them caused a macro-form phase change (OPENING->DEVELOPMENT->RETURN->
  DEVELOPMENT->RETURN->...), and *every single one* of those phase changes
  coincided with a real `regimeTag` change in `macroFormLog` -- checked
  programmatically (`allAligned === true`), not eyeballed. RETURN recurred
  three times over the piece (a real rondo-like structure, not a single
  scripted arc), at t=624s, t=747s, and t=870s -- none of which land near a
  fixed 80%-of-duration boundary the old system would have used.
- **Motif variety, counted, not assumed:** 23 phrases were generated;
  **22 of the 23 produced a distinct interval-sequence shape** (the one
  repeat was two separate phrases both landing on `[-1,1]`, out of a
  combinatorial space, not a sign of clustering). Shannon entropy of the
  shape distribution across those 23 draws: **4.437 bits**, against a
  maximum possible 4.524 bits for 23 draws -- i.e. close to maximally
  diverse -- and far above the 2.0-bit ceiling a 4-shape enum could ever
  produce regardless of how it was weighted.
- Standard checks still hold: `melody.mjs`'s own developing-variation
  operators still round-trip exactly; DEVELOPMENT's mean melodic interval
  (3.427, from the CLI's own report) came out well above OPENING's (0.886).

**Honest limitation, not smoothed over:** in this specific render, no new
phrase happened to *start* while the macro-form was in RETURN -- RETURN
windows were short (about 12 seconds each here) relative to the average gap
between phrases (4-9s) plus phrase length (10-60s), so the phrase-scheduling
loop's next opportunity to start a phrase sometimes landed just after RETURN
had already ended. RETURN is real and does get exercised in other renders
(both a 720-second/seed-`20260819` render and a 720-second/seed-`561`-as-a
-string render produced 1 and 13 RETURN-section onsets respectively), and
its thematic-return mechanism -- reusing the piece's own captured OPENING
motif -- is unit-tested directly (`melody.test.mjs`) independent of whether
any particular render happens to land a phrase inside a RETURN window. But
its window can legitimately be too brief to catch a phrase start on a given
seed, which is a genuine consequence of deriving it from real, sometimes-
short-lived engine state rather than a guaranteed-20%-of-the-clock reservation
-- and that tradeoff is not hidden here.

The Lambek-calculus port is not a full formalization of a "phrase grammar"
in the sense of assigning categories to every possible melodic function
(subject/predicate-style categorial grammar) -- it is a real, tested
instance of the bi-residuation algebra applied narrowly to one concrete
question (which step token can legally come next, given what must still be
reachable), which is the part of the Lean file's structure this engine
actually had a use for. A grammar that also typed larger phrase-level
combinations (motif -> phrase -> section) the same way would be a further,
larger piece of work, not attempted here.

## Verification: call-and-response duo improvisation

A 900-second (15-minute) render, seed `561`, dorian/D/chamber (see
`data/renders/string-and-breath-duo.wav`, reproducible via `npm run
render:duo -- --duration 900 --seed 561 --title "String and Breath Duo"`):

- **Real turn-taking, measured exactly from the scheduled note intervals
  (a sweep-line, not sampled from audio):** both voices sounding
  simultaneously **7.8%** of the piece (70.1s), the string alone **39.0%**
  (351.0s), the breath voice alone **39.9%** (358.9s), and real silence
  **13.3%** (119.9s) -- a genuine mix of all three call-and-response
  textures the task asked for (overlapping, trading, and clear silence-gapped
  answering), not wall-to-wall simultaneous layering and not a rigid
  always-wait-for-silence alternation either.
- **Neither voice dominates:** 40 total phrases, split exactly 20/20 between
  the string and the breath voice.
- **Spectral distinctness, measured from the actual rendered audio** (a
  Goertzel-DFT probe grid over 12 isolated single-voice windows per
  instrument, i.e. windows where the overlap sweep-line above says only that
  one voice is sounding): the string's mean spectral centroid measured
  **1167.9 Hz**, the breath voice's **739.1 Hz** -- a real, substantial
  (429 Hz) measured difference, not an assumption that two different DSP
  techniques must sound different because they're implemented differently.
- **Motif vocabulary genuinely recurs, not regenerated fresh every phrase:**
  the vocabulary started at 4 seed motifs and grew to 8 over the piece; 7 of
  those 8 were drawn by at least one call; **5 vocabulary entries recurred
  across multiple separate calls** (14 total draws of recurring entries),
  and every recurrence reproduced the *exact same* interval-sequence shape
  (checked programmatically, `allShapesConsistent === true`) -- the same
  material genuinely came back and got developed by the response operators,
  not merely similar-sounding material regenerated from scratch.
- **Macro-form pacing is real and regime-driven, the same mechanism
  `compose.mjs` uses:** 5 phase transitions over the piece --
  `OPENING@0s(STRICT) -> DEVELOPMENT@456s(SCOTT) -> RETURN@662s(STRICT) ->
  DEVELOPMENT@674s(TRANSFINITE_BOUNDED) -> RETURN@785s(STRICT) ->
  DEVELOPMENT@797s(TRANSFINITE_BOUNDED)` -- a real rondo-like structure
  driven by `regime.mjs`'s reactive classifier, not a scripted arc.

**How honestly close this gets to "sounds like real music":** the
measurements above are real and confirm the mechanisms work as designed --
two spectrally distinct, idiomatic-sounding instrument voices; genuine
overlap/trading/silence-gap variety in the timing; exact motif recurrence
and development; regime-driven macro-form. Whether the *result* actually
reads to a human listener as two musicians in conversation, versus "two
different synthesizer patches taking turns over an ambient backdrop," is a
subjective aesthetic judgment this document cannot make on your behalf --
listen to the render. Some concrete, honest limitations that measurement
alone can't paper over:

- The Karplus-Strong string's pitch/timing is scheduled from `melody.mjs`'s
  scale-degree/duration output exactly like the pad bed's melodic line --
  there is no idiomatic string-specific phrasing (no legato slides, no
  variable pluck position/brightness per note beyond what pitch and duration
  already imply, no dynamics beyond a fixed pluck gain). Real plucked-string
  playing varies attack character note-to-note far more than this does.
- The bow/breath voice's vibrato, dynamics, and phrasing are similarly
  whatever `melody.mjs`'s existing note-scheduling produces -- there is no
  breath-phrase-length modeling (a real wind player can't sustain forever
  mid-phrase; this voice can, and does, whenever a scheduled note happens to
  be long).
- "Call and response" here means "the response's *base motif* is a real
  transform of the call's" -- it does not mean the response voice reacts to
  *how* the call was actually played (its exact timing/dynamics/register in
  that specific instance) beyond what the transform and the shared
  `chordMask` already encode. A human improviser reacts to nuance a
  scale-degree/duration event stream doesn't carry.
- 900 seconds and 40 phrases is enough to measure the statistics above
  confidently; it is not enough to rule out the ear noticing repetition in
  the vocabulary-reuse pattern on a careful re-listen, the way a much longer
  or more varied session might avoid.

None of this is a claim that the earlier ambient pad-bed engine is somehow
more honest by comparison -- it never claimed to be idiomatic instrument
writing in the first place. This section's job was specifically to close
the "generative math has never been pointed at anything that sounds like an
instrument playing real music" gap, and the measurements above are the
concrete evidence for how far that got, not a substitute for listening to
`data/renders/string-and-breath-duo.wav` and deciding for yourself.
