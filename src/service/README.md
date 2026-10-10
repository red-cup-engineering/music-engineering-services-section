# HTTP service

A plain `node:http` microservice wrapping `renderTrack()`
(`src/generative/compose.mjs`) so other services in the system -- the
`play.561.group` game sites and its siblings (`durante`, `okaga`,
`ruinfold`, `fyreside`), or anything else in this codebase -- can request
audio on demand over HTTP instead of running this package as a one-off CLI
script. No framework, no runtime dependencies, same convention the rest of
this package already follows.

This is meant as one service in a mesh, not a monolith: the API surface
below is a real, structured parameter space (`GET /schema` describes it
machine-readably) rather than a fixed preset menu, specifically so other
services -- including, eventually, a driver that turns some external signal
into generation parameters -- have something real to call. See "A note on
future 'energy' input" near the end of this file for the honest current
boundary of that idea: the shape is designed for it, the wiring isn't there
yet.

## Start it

```sh
npm run serve
# or: node src/service/http-server.mjs
```

Listens on `http://127.0.0.1:5610` by default. Env vars: `PORT`, `HOST`,
`MAX_CONCURRENT_RENDERS` (default 2), `RENDER_TIMEOUT_MS` (default 120000).

Once it's running, open `http://127.0.0.1:5610/` in a browser for the web
GUI (see "Web GUI" below), or use the HTTP API directly.

## API

### `GET /health`

Liveness check.

```json
{
  "status": "ok",
  "service": "@red-cup-engineering/music-engineering-services-section",
  "uptimeSec": 12.6,
  "activeRenders": 0,
  "queuedRenders": 0,
  "maxConcurrentRenders": 2
}
```

### `GET /presets`

Lists every stinger preset, bed preset, and mood, plus the current duration
and loop limits.

### `GET /schema`

A structured, machine-readable description of the actual `/generate`
parameter space -- the same information the table below states in prose,
but as JSON a program can read: every field's type, bounds, default, and a
plain-language description (`presets.mjs`'s `buildParameterSchema()`). This
is what `src/service/web/app.js` reads to build its form controls, and it's
the intended integration point for any other caller that wants to build UI
or validation without hardcoding this service's parameter list -- if a
field is added or a bound changes, `/schema` reflects it immediately.

`mode`, in particular, is described as a `oneOf`: a legacy named-mode enum,
or a direct `{cardinality, rotation}` generator-coordinate object (see
below) -- the schema spells out both shapes and their bounds rather than
just listing 4 strings.

### `POST /generate`

Body (all fields optional, JSON) -- this is the real, complete parameter
surface `renderTrack()`/`renderLoopableTrack()` accept, not a subset gated
behind presets. `GET /schema` is the authoritative, structured version of
this table.

| field          | type    | notes |
|----------------|---------|-------|
| `preset`       | string  | one of the preset ids below; supplies defaults for the other fields |
| `mood`         | string  | `calm` \| `resolving` \| `tense` -- convenience only, see "adaptive intensity" below |
| `intensity`    | number  | 0-1, bucketed into the same three moods -- convenience only, see below |
| `durationSec`  | number  | non-loop renders; 0.5-300s |
| `loop`         | boolean | request a crossfade-looped bed instead of a plain clip |
| `loopSec`      | number  | loop renders; 10-300s |
| `loopFadeSec`  | number  | loop renders; >=0.5s, and <=40% of `loopSec` |
| `mode`         | string \| object | a legacy name (`dorian` \| `aeolian` \| `majorPentatonic` \| `minorPentatonic`) **or** `{cardinality, rotation}` generator coordinates -- see "Scale/mode: a real generator, not 4 names" below |
| `root`         | string  | `C C# D D# E F F# G G# A A# B` |
| `reverbPreset` | string  | `deepAmbient` \| `hall` \| `chamber` |
| `melody`       | boolean | foreground melodic layer -- see the melody-gate limitation below |
| `seed`         | number/string | omit for a time-based (non-reproducible) seed |
| `sampleRate`   | number  | 8000-192000, default 44100 |

**Precedence when a field is set multiple ways:** an explicit field in the
body always wins > a named `preset` > `mood`/`intensity` > built-in
defaults. So `{"preset": "stinger-tension", "reverbPreset": "chamber"}`
gets everything from `stinger-tension` except the reverb.

Response: `200` with an `audio/wav` body (24-bit PCM stereo, the same
format `scripts/render-track.mjs` writes to disk) and these headers:
`Content-Length`, `X-Track-Duration-Sec`, `X-Track-Sample-Rate`,
`X-Track-Peak`, `X-Track-Rms`, `X-Track-Loop`, `X-Track-Final-Regime`,
`X-Track-Spiral-Count`, `X-Track-Melody-Note-Onsets`, and (non-loop renders
only, since `renderLoopableTrack()` doesn't compute these)
`X-Track-Regime-Transitions`, `X-Track-Melody-Unique-Degrees`,
`X-Track-Melody-Unique-Durations`. These are real numbers `renderTrack()`
already computed about what the render actually did (how many times the
macro-form regime changed, how many distinct scale degrees/durations the
melodic grammar produced) -- exposed as headers rather than left buried in
the worker's internal response, on the theory that a caller showing "what
did this render actually do" should get real facts, not just audio bytes.

Errors are always JSON, never a crash/hang:

- `400` -- bad input (`{"error": "invalid request", "details": [...]}`, one
  string per problem)
- `404` / `405` -- unknown route / wrong method
- `413` -- request body over 64KB
- `500` -- render threw after passing validation (an actual bug, or a root
  spelling not in the known-roots list -- see "known limitations" below)
- `504` -- render exceeded `RENDER_TIMEOUT_MS`

### Duration / loop limits

`durationSec`: 0.5-300s. `loopSec`: 10-300s. `loopFadeSec`: >=0.5s and
<=40% of `loopSec`. These are server-side sanity bounds, not engine limits
-- they exist to stop one request from tying up a render worker for an
unreasonable amount of time. At the measured ~1:9 render-time-to-audio
ratio, the 300s ceiling costs roughly 33s of wall clock, already a long
time to hold an HTTP request open. Change via `presets.mjs`'s
`DURATION_LIMITS`/`LOOP_LIMITS` if a different ceiling is needed.

### Scale/mode: a real generator, not 4 names

`scale.mjs` no longer looks modes up from a 4-entry table. It generates
interval sets from maximal evenness (Clough & Douthett 1991): for a target
note count `cardinality` (2-11) out of a 12-pitch-class chromatic universe,
the maximally-even subset spreads its members as evenly as possible around
the pitch-class circle; `rotation` (0..cardinality-1) picks which member of
that set becomes the new tonic. This isn't a loose analogy -- rotating the
cardinality-7 set reproduces all seven classical diatonic modes exactly
(Dorian = rotation 5, Aeolian = rotation 2, etc.), and cardinality-5
reproduces both pentatonic collections exactly (checked in
`test/scale.test.mjs`).

`POST /generate`'s `mode` field accepts either shape directly:

```json
{ "durationSec": 30, "mode": "dorian" }
{ "durationSec": 30, "mode": { "cardinality": 6, "rotation": 2 } }
```

No change to `compose.mjs` was needed to expose this -- `renderTrack()`'s
`mode` parameter already accepted a `{cardinality, rotation}` object before
this pass; this service was simply rejecting anything but the 4 legacy
names at the validation layer. `chromaticUniverse` is deliberately **not**
a free parameter: it's always 12, because `scale.mjs`'s pitch-class bitmask
machinery (`pitchClassBit`, reused throughout `cover.mjs`/`flow.mjs`)
always reduces mod 12 regardless of what generated the interval list. A
`chromaticUniverse` other than 12 would silently fold generated pitch
classes back onto the same 12 bits (a real bug users could hit) rather than
producing an actual microtonal scale, so the API rejects it explicitly
instead of accepting a value it can't honor.

## Presets

### Stinger presets (2-6s one-shots for game events)

| id | duration | mode | root | reverb | what it actually is |
|----|----------|------|------|--------|----------------------|
| `stinger-success`  | 6s | majorPentatonic | D | chamber | bright rising swell, "positive outcome" cue |
| `stinger-tension`  | 4s | minorPentatonic | A | hall    | darker rising swell, unresolved/uneasy |
| `stinger-resolve`  | 5s | dorian          | D | deepAmbient | generic "something happened" swell |

**All three are swells, not hits.** `melody: false` is explicit in every
stinger preset, not just a default -- see the limitation below.

### Loopable ambient bed presets (crossfade-looped, 45-90s)

| id | loopSec | loopFadeSec | mode | root | reverb | melody |
|----|---------|-------------|------|------|--------|--------|
| `bed-calm`    | 60 | 6 | majorPentatonic | D | deepAmbient | on |
| `bed-tense`   | 45 | 5 | minorPentatonic | A | hall        | on |
| `bed-neutral` | 90 | 8 | dorian          | D | chamber     | on |

## Known limitations (read before relying on any of this)

### 1. Stingers are swells, not hits

`envelope.mjs` has no fast-attack/percussive mode by design ("This module
deliberately has no fast-attack/percussive mode" -- its own header
comment). The pad voice's attack is always randomized in `[3, 6]`s
(`compose.mjs`'s `makeRenderVoice`: `Math.max(2, nextRange(rng, 3, 6))`,
where `nextRange(3, 6)` is already `>= 3`, so the `2` floor never actually
binds). A 2-6s stinger clip is always a *rising swell*, never a struck/
plucked hit.

The curve is steep enough that this isn't the same as "silent" -- it's an
exponential attack with steepness k=5, strongly front-loaded (the curve
formula's own ratio, independent of the absolute attack time, puts roughly
57-82% of sustain level reached by the time 1/6 to 1/3 of the attack has
elapsed). Measured directly on a rendered `stinger-success` clip (6s,
majorPentatonic/chamber, seed 561), RMS per second was:

```
0-1s: 0.0103   1-2s: 0.0220   2-3s: 0.0252   3-4s: 0.0211   4-5s: 0.0222   5-6s: 0.0195
```

Audible content builds within the first 1-2 seconds; it isn't a rise that
only becomes audible near the very end. But it never has the character of
a "hit" -- there's no transient, no decay-from-peak shape, just a rise.
Stinger presets are named around that reality ("success"/"tension"/
"resolve" swells), not oversold as percussive stabs.

Separately: `melody.mjs`'s foreground layer never triggers for any
`renderTrack()` call with `durationSec <=` `MELODY_MIN_TRAILING_SILENCE_SEC`
(18s, a `compose.mjs` constant), because that module's own gate is
`transportTimeSec < durationSec - 18`, which is false at `t=0` whenever
`durationSec <= 18`. So no stinger preset -- and no `/generate` request
under 18s -- can ever carry the faster, more present melodic voice,
regardless of the `melody` flag. This service does not work around that
(it would mean reaching into `compose.mjs`, out of scope for this pass);
it just documents it and sets `melody: false` explicitly on every stinger
preset so the behavior is visible in the preset definition rather than
hidden behind a threshold the caller can't see.

### 2. Concurrency: renders run in worker threads, not the main thread, but this is still not a real job queue

`renderTrack()` is synchronous, CPU-bound JS. Running it on the HTTP
server's own thread would block `/health` and every other in-flight
request for the render's full wall-clock duration. To avoid that, every
render runs in a separate `node:worker_threads` `Worker`
(`render-worker.mjs`) rather than inline in `http-server.mjs`.

This was verified directly: with two concurrent 20s `/generate` requests in
flight (`activeRenders: 2`), `GET /health` still responded in ~21ms.

What this is *not*: a real job queue. There's no persistence, no job IDs,
no polling -- a request just holds its HTTP connection open until its
worker finishes, or queues in-process (FIFO, bounded by
`MAX_CONCURRENT_RENDERS`, default 2) behind whatever else got there first.
A process restart silently drops any in-flight or queued request. Each
concurrent render is real CPU work on a real OS thread -- raising
`MAX_CONCURRENT_RENDERS` past the available core count just means more
renders competing for the same cores, not more real throughput. Fine for
"give me a short clip on demand"; not a general-purpose render pipeline.

### 3. Looping is a genuine crossfade, not a guess -- and it measures well

`renderTrack()`'s buffer ends with a hard 30ms linear declick-to-zero at
the raw sample boundary (`compose.mjs`'s `END_DECLICK_SEC`) -- a purely
technical anti-click safeguard, not a loop point. Confirmed by reading
`compose.mjs`: concatenating two independent renders back-to-back is
audible as a fade-to-silence-then-restart gap, not a loop.

`renderLoopableTrack()` (`presets.mjs`) fixes this for real: it renders
`loopSec + loopFadeSec` seconds of one continuous generative take, then
equal-power-crossfades the tail `loopFadeSec` seconds into the head
`loopFadeSec` seconds, producing an output buffer exactly `loopSec` long.
Because both the "head" and "tail" come from the same continuous render,
the crossfade always blends between two points that were already adjacent
in time -- it never splices in unrelated material.

Verified with `verify-loop.mjs`, which concatenates a rendered loop with
itself and compares the sample jump at the seam to the typical
sample-to-sample jump elsewhere in the buffer (not just "it ran without
error"). Measured on `bed-neutral` (90s loop, 8s crossfade, seed 561):

```
typical sample-to-sample jump:  1.2233e-3  (-58.25 dBFS)
seam sample-to-sample jump:     1.0567e-3  (-59.52 dBFS)
ratio (seam / typical):         0.864x
```

The seam jump is *smaller* than a typical in-buffer jump -- i.e. the loop
point is not distinguishable from ordinary signal movement by this metric.
Re-run with `node src/service/verify-loop.mjs <bed-preset-id> [seed]` to
check any other preset/seed combination.

### 4. "Adaptive" intensity/mood is a handful of presets, not real modulation

Be skeptical of the word "adaptive" here. `thermo.mjs`'s
`computeTemperature()` is the one thing in this codebase that actually
governs "how much is happening" (detune spread, filter jitter, onset
jitter) -- and it is entirely internal to `compose.mjs`'s per-window tick
loop, driven by `tickResult.addedVoices.length` vs. total active voices.
`renderTrack()` does not accept it as a parameter, and there is no
legitimate way to reach it from this service without editing
`compose.mjs` (out of scope for this pass, and actively being edited by
another workstream anyway).

So `mood`/`intensity` here only ever pick among three fixed combinations of
`mode`/`root`/`reverbPreset`:

| mood        | mode            | root | reverbPreset |
|-------------|-----------------|------|--------------|
| `calm`      | majorPentatonic | D    | deepAmbient  |
| `resolving` | dorian          | D    | chamber      |
| `tense`     | minorPentatonic | A    | hall         |

`intensity` (a 0-1 number) is bucketed into thirds onto the same three
rows -- not interpolated, because there is nothing continuous underneath
to interpolate. This changes the pitch material and the reverb character.
It does **not** change voice density, section pacing, or how much
humanization/jitter the render applies -- that machinery exists
(`thermo.mjs`) but isn't reachable from here.

### A note on future "energy" input

The long-term direction for this service is a mesh of small services with
this one as (part of) the app face, potentially eventually driven by an
external signal -- e.g. some other system's own activity data turned into
"how much is happening" in the generated audio, rather than a person
picking parameters by hand each time. `intensity` already has the right
*shape* for that (a plain 0-1 number over HTTP), which is why it's
described that way in `GET /schema` rather than as an opaque enum -- but as
of this pass it still only selects one of the 3 fixed mood bundles above.
It does not reach `thermo.mjs`'s temperature or `regime.mjs`'s classifier,
which are the actual "how much is happening" machinery and are internal to
`compose.mjs`'s tick loop, not parameters `renderTrack()` exposes. Wiring a
real externally-driven numeric energy input through to `compose.mjs` is
future work this pass deliberately did not do (`compose.mjs` is out of
scope here, actively being edited by other workstreams) -- this note exists
so that boundary is stated once, clearly, rather than left to be
inferred from `intensity` already accepting a number.

## Web GUI

`src/service/web/` is a static, zero-dependency web GUI (`index.html`,
`style.css`, `app.js` -- plain HTML/CSS/vanilla JS, no build step, no
framework) served by `http-server.mjs` itself at `GET /` (also reachable at
`/index.html`, `/app.js`, `/style.css`; `/README.md` is served as plain
text too, for the "see ../README.md" link in the page). Visit
`http://127.0.0.1:5610/` once the server is running.

**Design intent:** built in the spirit of Edward Tufte's typographic
principles (see the reference implementation this borrows structure from,
https://edwardtufte.github.io/tufte-css/, not imported here to keep this at
zero external dependencies) -- dense body text, sidenotes placed directly
beside the control they explain instead of behind a tooltip/modal, real
measured numbers shown directly (the reverb preset's actual
`decaySec`/`dampingHz`/`stereoSpread`/`wetMix`, the render's actual peak/RMS/
regime-transition counts) rather than gauges or dials, and a plain min/max
amplitude-over-time waveform plot instead of an animated "visualizer".

**Genuinely schema-driven, not hardcoded to today's fields:** on load, the
page fetches `GET /schema` and builds every parameter control (type,
bounds, default, description) from that response -- if a field's bounds
change, or a new field is added to `buildParameterSchema()` in
`presets.mjs`, the form picks it up without any change to `app.js`. The one
deliberate exception, documented in `app.js` itself
(`SKIP_AS_FORM_FIELDS`): `preset`/`mood`/`intensity` are rendered as
"Quick start" buttons (from `GET /presets`) that only *prefill* the other
fields client-side -- the request the GUI actually sends always carries
concrete, explicit values for every other field, never a preset name. This
mirrors `resolveGenerateParams()`'s own precedence rule (explicit fields
always win) by construction rather than depending on it.

**Render wait:** this is real synchronous rendering, not instant. The page
shows a real elapsed-time counter plus an estimate derived from
`schema.estimatedRenderSecondsPerAudioSecond` (the measured ~1:9 ratio) --
not a fake progress bar and not a spinner with no context. A 30s clip is
about a 3s wait; a 300s (5 minute) clip is about a 30s wait. There's a
cancel button, but it only aborts the client-side fetch -- if the server's
worker thread already started rendering, it runs to completion regardless
(this service has no cancel-in-flight API; see "Concurrency" above).

## Client example

`client-example.mjs` is a runnable example of another Node service pulling
audio out of this one over plain `fetch()` -- no client library:

```sh
npm run serve &                     # in one terminal
node src/service/client-example.mjs stinger-success ./out/success.wav
node src/service/client-example.mjs bed-calm ./out/bed-calm.wav
```

It checks `/health` first, requests a preset, validates the response is a
well-formed WAV (RIFF/WAVE header, data chunk size matches the actual
response size), and writes it to disk -- exiting nonzero on any failure, so
it doubles as a smoke test for a running server.

## What was actually verified for this pass

- `GET /health` and `GET /presets` respond correctly.
- `POST /generate` with `stinger-success` and `bed-tense` both returned
  valid WAV bytes (correct `RIFF`/`WAVE`/`fmt ` headers, data chunk size
  matching the actual response size, correct implied duration, no
  clipping, not silent -- checked by directly decoding the 24-bit PCM data,
  not just trusting the header).
- Bad input (unknown preset, out-of-range duration, unknown mode, unknown
  root, malformed JSON body, unknown route, wrong HTTP method) all return
  the documented 4xx JSON error shapes, not a crash or hang.
- Two concurrent 20s `/generate` requests ran with `/health` staying
  responsive (~21ms) throughout, confirming the worker-thread offload
  actually works, not just that it compiles.
- The loop-seam crossfade was measured (not assumed) via
  `verify-loop.mjs`: seam jump 0.86x the typical in-buffer sample jump on
  `bed-neutral`, seed 561.

### Schema/GUI pass (this revision)

- `renderTrack({ mode: { cardinality, rotation } })` was called directly
  (bypassing the HTTP layer entirely) to confirm the object-mode form
  actually renders real, non-silent audio -- it does, and needed zero
  changes to `compose.mjs`; only this service's own validation was
  rejecting the object form before this pass.
- `GET /schema` was fetched and its `mode` field's two option shapes
  (`named`, `coordinates`) checked directly.
- `POST /generate` was exercised with: legacy string `mode`, object
  `{cardinality, rotation}` `mode` (both producing valid, decodable WAV
  files -- checked byte-for-byte, not just a 200 status), an out-of-range
  `cardinality` (12), an out-of-range `rotation`, a non-12
  `chromaticUniverse`, a `loop:true` request with object-coordinate `mode`,
  a malformed JSON body, and an unknown legacy mode name -- every case
  returned the documented success/error shape, not a crash.
- A 30s `/generate` request was timed directly: 3.30s wall clock, matching
  the documented ~1:9 ratio this exactly (not just "roughly").
- The static file routes (`/`, `/app.js`, `/style.css`, `/README.md`) were
  checked for correct `Content-Type`/`Content-Length` and non-empty bodies.
- **The GUI was driven in a real headless browser** (Playwright + Chromium,
  installed on-demand for this verification pass only -- it is not a
  project dependency and nothing in `package.json` changed), not just
  read as source or checked structurally: loaded the live page against the
  running server, confirmed the schema-driven form actually rendered 10
  parameter rows and 6 preset quick-start buttons from the live `/schema`
  and `/presets` responses, exercised the `mode` oneOf toggle (switched
  from `named` to `coordinates`, set cardinality/rotation, confirmed the
  right sub-fields appeared), filled the form, clicked Generate, and
  confirmed a real round trip through this GUI's own `fetch()` code: the
  `<audio>` element got a real `blob:` URL, the download link got a real
  `blob:` URL, the metrics table populated with the real response-header
  numbers, and the waveform `<canvas>` was confirmed to have actual drawn
  pixel content (not a blank canvas) by reading back its pixel data. Zero
  browser console errors during the run. Screenshots were taken and
  visually reviewed at each step, which caught and led to fixing two real
  bugs a purely structural check would have missed: a parameter-label
  formatting bug (`(sec)durationSec` instead of `durationSec (sec)`) and
  overlapping peak/RMS labels on the waveform when the two values were
  close together. Both are fixed and re-verified with a second live run.
