// cover.mjs
//
// Port of Site/Basic.lean + Site/Sheaf.lean into the polyphony gatekeeper:
// decides which candidate pad voices are legitimately allowed to sound
// together in the current window, and computes the sounding chord from
// asynchronously-arriving voice events deterministically.
//
// Two checks gate every admission, exactly mirroring the site's basis
// axioms:
//   - subCheck(memberBits, target): a candidate voice grouping's bits must
//     be a submask of the target chordMask ("member & target === member").
//     Groupings failing this are rejected outright, not silently allowed.
//   - joinCheck(groupings, target): the OR-reduction of every *admitted*
//     grouping's bits must reconstruct target exactly. When it doesn't
//     (freshly-injected pitch classes not yet covered by any sounding
//     voice), resolveCover retargets by admitting new groupings for the
//     missing bits -- this is the concrete mechanism that turns a chordMask
//     update into an actual new voice, and it is the only path by which a
//     voice gets added.
//
// The "no temporal covers" theorem (covers refine only the clopen leg at a
// fixed context, never across time) is enforced as a scheduling rule by the
// caller (flow.mjs): resolveCover is invoked once per macro-tick window,
// and its result is frozen for that whole window -- voice groupings are
// re-decided only at the next window boundary as a discrete re-cover (a
// fresh ADSR attack for newly-admitted voices), never crossfaded mid-window.
//
// mergeChord is the literal CRDT knowledge-join (joinList_congr / H1=0):
// order-independent OR-reduction of pitch-class events, used whenever
// voice-on events arrive to be folded into the running chordMask.

export const OVERLAP = Object.freeze({ NONE: 'NONE', ONLY_A: 'ONLY_A', ONLY_B: 'ONLY_B', BOTH: 'BOTH' });

/**
 * Site sub-check: is memberBits a legitimate sub-cover of targetMask?
 * @param {number} memberBits
 * @param {number} targetMask
 * @returns {boolean}
 */
export function subCheck(memberBits, targetMask) {
  return (memberBits & targetMask) === memberBits;
}

/**
 * Site join-check: do the admitted groupings' bits, OR-reduced together,
 * reconstruct targetMask exactly (sheaf separation -- a section is uniquely
 * pinned by its cover)?
 * @param {Array<{bits:number}>} groupings
 * @param {number} targetMask
 * @returns {boolean}
 */
export function joinCheck(groupings, targetMask) {
  const union = groupings.reduce((m, g) => m | g.bits, 0);
  return union === targetMask;
}

/**
 * Pairwise overlap classification between two voice groupings' bitmasks,
 * used by resolveCover's eviction heuristic to prefer keeping harmonically
 * distinct (NONE-overlap) voices over fully redundant (BOTH) ones.
 * @param {number} aBits
 * @param {number} bBits
 * @returns {'NONE'|'ONLY_A'|'ONLY_B'|'BOTH'}
 */
export function pairwiseOverlap(aBits, bBits) {
  if ((aBits & bBits) !== 0) return OVERLAP.BOTH;
  if (aBits !== 0 && bBits === 0) return OVERLAP.ONLY_A;
  if (bBits !== 0 && aBits === 0) return OVERLAP.ONLY_B;
  return OVERLAP.NONE;
}

/**
 * The literal CRDT knowledge-join: order-independent OR-reduction of a
 * batch of pitch-class events into a single mask. Used whenever new
 * voice-on events need folding into the running chordMask.
 * @param {Array<{pitchClassBit:number}>} events
 * @returns {number}
 */
export function mergeChord(events) {
  return events.reduce((m, e) => m | e.pitchClassBit, 0);
}

const DEFAULT_OCTAVE = 3; // middle of scale.mjs's OCTAVES=[2,3,4]; H-theorem migration spreads voices out from here.

function makeVoiceId(pc, tickTime) {
  return `v${pc}_${Math.round(tickTime * 1000)}`;
}

/**
 * Resolves which voices should be sounding this window, given the target
 * chordMask and the voices currently registered from the previous window.
 *
 * Algorithm:
 *  1. subCheck every currently-registered voice against the (possibly
 *     grown) target; anything that fails is rejected (defensive -- target
 *     only ever grows via OR, so this should not normally trigger, but the
 *     check is real and load-bearing, not decorative).
 *  2. joinCheck the admitted set against target; any target bits not
 *     covered are "missing" -- for each missing pitch class, admit a new
 *     singleton voice grouping (this is how a fresh chordMask injection
 *     actually becomes an audible new voice).
 *  3. Enforce the polyphony budget (maxVoices): if admission pushed the
 *     count over budget, evict voices, preferring to evict ones that are
 *     harmonically redundant (BOTH-overlap with another kept voice) before
 *     falling back to oldest-first.
 *
 * @param {object} opts
 * @param {number} opts.targetMask - current chordMask to cover
 * @param {Array<{voiceId:string, pitchClass:number, bits:number, octave:number, lastTouchedTick:number}>} opts.currentVoices
 * @param {number} [opts.maxVoices=6]
 * @param {number} opts.tickTime - current transport time, used for new voice ids and recency scoring
 * @returns {{admittedVoices:Array, addedVoices:Array, droppedVoices:Array, coveredMask:number, fullyCovered:boolean}}
 */
export function resolveCover({ targetMask, currentVoices, maxVoices = 6, tickTime }) {
  const admitted = currentVoices.filter((v) => subCheck(v.bits, targetMask));
  const rejected = currentVoices.filter((v) => !subCheck(v.bits, targetMask));

  const dropped = rejected.map((v) => ({ ...v, reason: 'sub-check-failed' }));

  const coveredMask = admitted.reduce((m, v) => m | v.bits, 0);
  const missingMask = targetMask & ~coveredMask;

  let working = admitted.slice();
  const added = [];

  for (let pc = 0; pc < 12; pc++) {
    const bit = 1 << pc;
    if ((missingMask & bit) === 0) continue;
    // subCheck on the new singleton grouping: trivially true by
    // construction (bit is a subset of target since it came from target's
    // own missing bits), but run for real -- this is the exact same
    // primitive gating every other admission, not a special case.
    if (!subCheck(bit, targetMask)) continue;
    const newVoice = {
      voiceId: makeVoiceId(pc, tickTime),
      pitchClass: pc,
      bits: bit,
      octave: DEFAULT_OCTAVE,
      lastTouchedTick: tickTime,
    };
    working.push(newVoice);
    added.push(newVoice);
  }

  while (working.length > maxVoices) {
    let worstIdx = 0;
    let worstScore = -Infinity;
    for (let i = 0; i < working.length; i++) {
      let redundancy = 0;
      for (let j = 0; j < working.length; j++) {
        if (i === j) continue;
        if (pairwiseOverlap(working[i].bits, working[j].bits) === OVERLAP.BOTH) redundancy++;
      }
      const age = tickTime - working[i].lastTouchedTick;
      const score = redundancy * 1000 + age;
      if (score > worstScore) {
        worstScore = score;
        worstIdx = i;
      }
    }
    const evicted = working.splice(worstIdx, 1)[0];
    dropped.push({ ...evicted, reason: 'polyphony-budget' });
  }

  const finalCoveredMask = working.reduce((m, v) => m | v.bits, 0);

  return {
    admittedVoices: working,
    addedVoices: added,
    droppedVoices: dropped,
    coveredMask: finalCoveredMask,
    fullyCovered: finalCoveredMask === targetMask,
  };
}
