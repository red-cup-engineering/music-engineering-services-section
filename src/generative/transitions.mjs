// transitions.mjs
//
// Musically-aligned state changes for arrangement.mjs's event stream: bar/
// phrase quantization helpers, a stinger (a short motif statement that
// overlays on top of whatever stems are already sounding, without stopping
// or retriggering them), and a riser (a parameterized automation ramp that
// resolves exactly on a target beat/bar). This is deliberately a thin,
// stateless layer over plain event-stream data -- every function here takes
// an existing events array and returns events to concatenate onto it (or a
// {events, resolvedAtSec} pair when the caller needs to know exactly when
// the quantized/resolved transition actually lands); nothing here owns a
// clock or mutates DSP state directly, matching performance-spec.mjs's pure-
// data event-stream contract.

/**
 * The next bar boundary at or after tSec, for a given bar length in seconds.
 * Exactly on a boundary already returns tSec itself (a transition requested
 * to quantize "to the next bar" from exactly a bar line should land there,
 * not skip a full bar ahead).
 * @param {number} tSec
 * @param {number} secPerBar
 * @returns {number}
 */
export function nextBarBoundarySec(tSec, secPerBar) {
  const bars = tSec / secPerBar;
  const rounded = Math.round(bars * 1e9) / 1e9; // guard against float noise landing just past an exact boundary
  return Math.ceil(rounded - 1e-9) * secPerBar + 0; // "+ 0" normalizes a -0 result (e.g. from tSec=0) to ordinary 0
}

/**
 * The next phrase boundary at or after tSec, for a given phrase length in
 * bars -- the same quantization as nextBarBoundarySec, one level up.
 * @param {number} tSec
 * @param {number} secPerBar
 * @param {number} barsPerPhrase
 * @returns {number}
 */
export function nextPhraseBoundarySec(tSec, secPerBar, barsPerPhrase) {
  return nextBarBoundarySec(tSec, secPerBar * barsPerPhrase);
}

/**
 * Lays out a motif (melody.mjs NoteEvent[]) as absolute-time note events
 * starting at startSec, at a fixed secPerQuarter -- the same duration-to-
 * seconds conversion melody.mjs's generatePhrase uses internally, exposed
 * here so transitions/arrangement code can schedule a bare motif without
 * needing a full generatePhrase call (which also adds a cadence and
 * multiple developed statements, more than a single stinger/ornament hit
 * usually wants).
 * @param {import('./melody.mjs').NoteEvent[]} motif
 * @param {object} opts
 * @param {number} opts.startSec
 * @param {number} [opts.secPerQuarter=1.0]
 * @param {string} [opts.stem='ornament']
 * @param {string} [opts.instrumentHint='bell']
 * @param {number} [opts.octaveIndex=2]
 * @param {number} [opts.velocity=0.7]
 * @returns {{events: Array<object>, endSec:number}}
 */
export function layOutMotifAsEvents(motif, opts) {
  const { startSec, secPerQuarter = 1.0, stem = 'ornament', instrumentHint = 'bell', octaveIndex = 2, velocity = 0.7 } = opts;
  const events = [];
  let tSec = startSec;
  for (const n of motif) {
    const durSec = (n.durationFrac.num / n.durationFrac.den) * 4 * secPerQuarter;
    if (!n.rest) {
      events.push({ type: 'note', stem, instrumentHint, degree: n.degree, octaveIndex, startSec: tSec, durSec, velocity });
    }
    tSec += durSec;
  }
  return { events, endSec: tSec };
}

/**
 * Schedules a stinger: a short motif statement quantized to the next bar
 * boundary (or played immediately if quantizeSecPerBar is omitted), appended
 * to `events` as pure overlay -- existing events for other stems (the bed,
 * an in-progress pulse pattern) are untouched, so a stinger never stops or
 * retriggers anything already sounding, exactly the "overlay without
 * stopping the bed" behavior game-adaptive music needs for a one-shot
 * accent (a win tick, a level-up flourish) layered over continuous ambience.
 * @param {Array<object>} events - the arrangement's existing event list
 * @param {object} opts
 * @param {number} opts.atSec - requested time; quantized forward to the next bar if quantizeSecPerBar is given
 * @param {number} [opts.quantizeSecPerBar] - bar length in seconds to quantize atSec to; omit to fire at atSec exactly
 * @param {import('./melody.mjs').NoteEvent[]} opts.motif - typically one member of leitmotif.mjs's generateFamily
 * @param {string} [opts.stem='ornament']
 * @param {string} [opts.instrumentHint='bell']
 * @param {number} [opts.octaveIndex=2]
 * @param {number} [opts.velocity=0.8] - stingers read as accents, so default louder than a background ornament hit
 * @param {number} [opts.secPerQuarter=1.0]
 * @returns {{events:Array<object>, startSec:number, endSec:number}} a NEW events array (events concatenated with the stinger's notes plus one 'transition' marker event); does not mutate the input array
 */
export function scheduleStinger(events, opts) {
  const { atSec, quantizeSecPerBar, motif, stem = 'ornament', instrumentHint = 'bell', octaveIndex = 2, velocity = 0.8, secPerQuarter = 1.0 } = opts;
  const startSec = quantizeSecPerBar ? nextBarBoundarySec(atSec, quantizeSecPerBar) : atSec;
  const { events: noteEvents, endSec } = layOutMotifAsEvents(motif, { startSec, secPerQuarter, stem, instrumentHint, octaveIndex, velocity });
  const marker = { type: 'transition', kind: 'stinger', stem, startSec, durSec: endSec - startSec };
  return { events: [...events, marker, ...noteEvents], startSec, endSec };
}

/**
 * Schedules a riser: a parameterized automation ramp on one stem/param,
 * running from fromSec for durationSec (or until an explicit
 * targetBeatSec/quantizeSecPerBar-resolved target, whichever is supplied),
 * so the ramp's *resolution* -- not just its start -- lands exactly on a
 * musically meaningful instant (a target beat/bar), which is what makes a
 * riser feel scored to the moment it resolves into (a stinger, a fanfare, a
 * section change) rather than an arbitrary-length swell that happens to stop
 * around when something else starts.
 * @param {Array<object>} events - the arrangement's existing event list
 * @param {object} opts
 * @param {number} opts.fromSec
 * @param {number} [opts.durationSec] - used when neither targetBeatSec nor quantizeSecPerBar is given
 * @param {number} [opts.targetBeatSec] - explicit resolution time; if quantizeSecPerBar is also given, this is quantized forward to the next bar
 * @param {number} [opts.quantizeSecPerBar] - bar length in seconds to quantize the resolution time to
 * @param {string} [opts.stem='pulse']
 * @param {string} [opts.param='density'] - the automation parameter name a downstream renderer/player is expected to interpret (arrangement.mjs uses 'density' and 'cutoffHz'; a performance-spec consumer can define others)
 * @param {number} [opts.fromValue=0]
 * @param {number} [opts.toValue=1]
 * @param {'linear'|'exp'} [opts.curve='exp']
 * @returns {{events:Array<object>, startSec:number, resolvedAtSec:number}} a NEW events array (events concatenated with one 'automation' event plus one 'transition' marker); does not mutate the input array
 */
export function scheduleRiser(events, opts) {
  const {
    fromSec,
    durationSec,
    targetBeatSec,
    quantizeSecPerBar,
    stem = 'pulse',
    param = 'density',
    fromValue = 0,
    toValue = 1,
    curve = 'exp',
  } = opts;

  let resolvedAtSec;
  if (targetBeatSec !== undefined) {
    resolvedAtSec = quantizeSecPerBar ? nextBarBoundarySec(targetBeatSec, quantizeSecPerBar) : targetBeatSec;
  } else if (quantizeSecPerBar) {
    resolvedAtSec = nextBarBoundarySec(fromSec + (durationSec ?? quantizeSecPerBar), quantizeSecPerBar);
  } else {
    resolvedAtSec = fromSec + (durationSec ?? 0);
  }
  resolvedAtSec = Math.max(resolvedAtSec, fromSec + 1e-6);

  const automation = {
    type: 'automation',
    stem,
    param,
    startSec: fromSec,
    durSec: resolvedAtSec - fromSec,
    fromValue,
    toValue,
    curve,
  };
  const marker = { type: 'transition', kind: 'riser', stem, startSec: fromSec, durSec: resolvedAtSec - fromSec };
  return { events: [...events, marker, automation], startSec: fromSec, resolvedAtSec };
}
