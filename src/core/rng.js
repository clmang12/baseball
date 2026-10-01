// Seeded randomness. Every stochastic decision in the sim draws from an Rng
// passed in explicitly, so at-bats, replays and tests are reproducible.

/** cyrb53-style string hash → 32-bit seed. */
export function hashSeed(input) {
  const str = String(input);
  let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    h1 = Math.imul(h1 ^ ch, 2654435761);
    h2 = Math.imul(h2 ^ ch, 1597334677);
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
  return h1 >>> 0;
}

export class Rng {
  /** @param {number|string} seed */
  constructor(seed = 1) {
    this.state = (typeof seed === 'number' ? seed : hashSeed(seed)) >>> 0;
    this._spare = null; // cached second Box–Muller deviate
  }

  /** mulberry32: uniform in [0, 1). */
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  uniform(min = 0, max = 1) {
    return min + (max - min) * this.next();
  }

  /** Integer in [0, n). */
  int(n) {
    return Math.floor(this.next() * n);
  }

  /** Normal deviate via Box–Muller (polar form avoided to keep draw count fixed per pair). */
  gaussian(mean = 0, sigma = 1) {
    if (this._spare !== null) {
      const z = this._spare;
      this._spare = null;
      return mean + sigma * z;
    }
    const u1 = Math.max(this.next(), 1e-12);
    const u2 = this.next();
    const mag = Math.sqrt(-2 * Math.log(u1));
    this._spare = mag * Math.sin(2 * Math.PI * u2);
    return mean + sigma * mag * Math.cos(2 * Math.PI * u2);
  }

  pick(items) {
    return items[this.int(items.length)];
  }

  /** Index chosen proportionally to non-negative weights. */
  weightedIndex(weights) {
    let total = 0;
    for (const w of weights) total += Math.max(0, w);
    if (total <= 0) return this.int(weights.length);
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= Math.max(0, weights[i]);
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  /** Independent child stream (e.g. one per at-bat) that doesn't disturb this one's sequence much. */
  fork(label = '') {
    return new Rng(hashSeed(`${this.state}:${label}`));
  }
}
