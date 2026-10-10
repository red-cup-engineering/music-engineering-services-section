// performance-spec.mjs
//
// The engine's cross-process integration seam: a pure, JSON-serializable
// "performance spec" -- a note/automation event stream with absolute
// timing, plus enough metadata (scale, tempo, stem config, leitmotif
// definitions) for a downstream realtime consumer (a game's audio kit) to
// resolve and play the same material this package can also render offline
// to WAV. buildPerformanceSpec wraps arrangement.mjs's scheduleArrangement
// output into this documented shape; validatePerformanceSpec checks that
// shape holds (used by this package's own tests and available to a
// downstream consumer that wants a cheap sanity check before trying to play
// an externally-supplied spec). See the top-level README's "Performance
// spec" section for the authoritative, versioned field-by-field contract --
// this module's JSDoc mirrors it but the README is what a downstream
// consumer should treat as the source of truth for the wire format.
//
// Design choice: every event's timing is an absolute startSec/durSec (not
// bar/beat position or a delta from the previous event). This costs a
// little size/redundancy but means a consumer never has to reconstruct
// tempo math to know when something happens -- it can seek/merge/filter the
// event list directly. tempoBpm/secPerBeat are still included because a
// realtime consumer scheduling its OWN quantized overlays (a stinger fired
// live in response to a game event, not baked into this spec) needs the
// same bar-grid transitions.mjs's nextBarBoundarySec expects.

export const PERFORMANCE_SPEC_VERSION = 1;

/**
 * Builds a performance spec from an arrangement (arrangement.mjs's
 * makeArrangement) and a scheduling result (arrangement.mjs's
 * scheduleArrangement), plus optional caller metadata.
 * @param {object} arrangement - from makeArrangement
 * @param {{events:Array<object>, intensityLog:Array<{tSec:number,intensity:number}>, numBars:number}} scheduled - from scheduleArrangement
 * @param {object} [meta]
 * @param {string} [meta.title]
 * @param {number} [meta.durationSec] - defaults to the last event's startSec+durSec if omitted
 * @returns {object} performance spec -- see this module's header comment and the README for the field contract
 */
export function buildPerformanceSpec(arrangement, scheduled, meta = {}) {
  const { events, intensityLog, numBars } = scheduled;
  const durationSec = meta.durationSec ?? events.reduce((max, e) => Math.max(max, (e.startSec ?? 0) + (e.durSec ?? 0)), 0);

  return {
    version: PERFORMANCE_SPEC_VERSION,
    id: arrangement.id,
    title: meta.title ?? arrangement.id,
    seed: arrangement.seed,
    durationSec,
    tempoBpm: arrangement.tempoBpm,
    beatsPerBar: arrangement.beatsPerBar,
    secPerBeat: arrangement.secPerBeat,
    secPerBar: arrangement.secPerBar,
    numBars,
    scale: {
      root: arrangement.root,
      mode: arrangement.mode,
      modeLabel: arrangement.scale.modeLabel,
      degreePitchClasses: arrangement.scale.degreePitchClasses,
    },
    progression: arrangement.progression.map((c) => ({ degree: c.degree, functionLabel: c.functionLabel, tension: c.tension, startSec: c.startSec, durSec: c.durSec })),
    leitmotif: { id: arrangement.leitmotif.id, seed: arrangement.leitmotif.seed, core: arrangement.leitmotif.core },
    stemLayers: arrangement.stemLayers,
    intensityLog,
    events,
  };
}

const REQUIRED_TOP_LEVEL_FIELDS = ['version', 'seed', 'durationSec', 'tempoBpm', 'secPerBeat', 'scale', 'events'];
const VALID_EVENT_TYPES = new Set(['note', 'automation', 'transition']);

/**
 * Validates a performance spec's shape: required top-level fields present,
 * every event has a recognized type and non-negative finite startSec/durSec,
 * and note events carry a numeric degree while automation events carry a
 * param name and from/to values. Throws a descriptive Error naming the
 * first problem found rather than collecting every problem -- this is meant
 * as a cheap pre-flight check (for this package's own tests and for a
 * downstream consumer), not a full JSON-schema validator.
 * @param {object} spec
 * @returns {true}
 */
export function validatePerformanceSpec(spec) {
  if (!spec || typeof spec !== 'object') throw new Error('validatePerformanceSpec: spec must be an object');
  for (const field of REQUIRED_TOP_LEVEL_FIELDS) {
    if (spec[field] === undefined) throw new Error(`validatePerformanceSpec: missing required field "${field}"`);
  }
  if (spec.version !== PERFORMANCE_SPEC_VERSION) {
    throw new Error(`validatePerformanceSpec: unsupported version ${spec.version} (this package understands version ${PERFORMANCE_SPEC_VERSION})`);
  }
  if (!Array.isArray(spec.events)) throw new Error('validatePerformanceSpec: "events" must be an array');

  for (let i = 0; i < spec.events.length; i++) {
    const e = spec.events[i];
    const where = `events[${i}]`;
    if (!VALID_EVENT_TYPES.has(e.type)) throw new Error(`validatePerformanceSpec: ${where}: unknown type "${e.type}"`);
    if (!Number.isFinite(e.startSec) || e.startSec < 0) throw new Error(`validatePerformanceSpec: ${where}: startSec must be a non-negative finite number`);
    if (!Number.isFinite(e.durSec) || e.durSec < 0) throw new Error(`validatePerformanceSpec: ${where}: durSec must be a non-negative finite number`);
    if (e.type === 'note') {
      if (!Number.isFinite(e.degree)) throw new Error(`validatePerformanceSpec: ${where}: note event missing numeric "degree"`);
      if (typeof e.stem !== 'string') throw new Error(`validatePerformanceSpec: ${where}: note event missing "stem"`);
    }
    if (e.type === 'automation') {
      if (typeof e.param !== 'string') throw new Error(`validatePerformanceSpec: ${where}: automation event missing "param"`);
      if (!Number.isFinite(e.fromValue) || !Number.isFinite(e.toValue)) throw new Error(`validatePerformanceSpec: ${where}: automation event needs finite fromValue/toValue`);
    }
  }
  return true;
}
