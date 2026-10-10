// random.mjs
//
// A small deterministic PRNG (mulberry32) plus a few sampling helpers, used
// throughout the generative layer so a whole track is fully reproducible
// from a single seed. Nothing here touches global Math.random -- every
// caller carries its own rng state object explicitly, matching the
// no-hidden-state discipline the rest of the generative layer follows.

/**
 * Creates a new PRNG state from an integer or string seed.
 * @param {number|string} seed
 * @returns {{state: number}}
 */
export function makeRng(seed) {
  let s;
  if (typeof seed === 'string') {
    s = hashStringToInt(seed);
  } else if (typeof seed === 'number' && Number.isFinite(seed)) {
    s = seed | 0;
  } else {
    s = 0x9e3779b9;
  }
  s = s >>> 0;
  if (s === 0) s = 0x9e3779b9;
  return { state: s };
}

/**
 * Deterministic string -> 32-bit int hash (FNV-1a), used so a human-readable
 * seed string still produces a well-mixed PRNG starting state.
 * @param {string} str
 * @returns {number}
 */
export function hashStringToInt(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/**
 * Advances the PRNG and returns a float in [0, 1). mulberry32 algorithm:
 * fast, small, decent statistical quality for non-cryptographic generative
 * use, and (crucially) fully deterministic given the same starting state.
 * @param {{state:number}} rng - mutated in place
 * @returns {number} float in [0, 1)
 */
export function nextFloat(rng) {
  rng.state = (rng.state + 0x6d2b79f5) >>> 0;
  let t = rng.state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/**
 * Uniform float in [min, max).
 * @param {{state:number}} rng
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
export function nextRange(rng, min, max) {
  return min + (max - min) * nextFloat(rng);
}

/**
 * Uniform integer in [minInclusive, maxExclusive).
 * @param {{state:number}} rng
 * @param {number} minInclusive
 * @param {number} maxExclusive
 * @returns {number}
 */
export function nextInt(rng, minInclusive, maxExclusive) {
  return Math.floor(nextRange(rng, minInclusive, maxExclusive));
}

/**
 * Box-Muller gaussian sample.
 * @param {{state:number}} rng
 * @param {number} [mean=0]
 * @param {number} [stdDev=1]
 * @returns {number}
 */
export function nextGaussian(rng, mean = 0, stdDev = 1) {
  let u = 0;
  let v = 0;
  while (u === 0) u = nextFloat(rng);
  while (v === 0) v = nextFloat(rng);
  const z = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  return mean + z * stdDev;
}

/**
 * Picks a uniformly random element from an array.
 * @param {{state:number}} rng
 * @param {Array} array
 * @returns {*}
 */
export function pick(rng, array) {
  return array[nextInt(rng, 0, array.length)];
}
