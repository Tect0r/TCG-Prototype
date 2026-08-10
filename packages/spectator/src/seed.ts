/**
 * Deterministic seed derivation for a spectator match.
 *
 * The same hierarchy the simulator uses, in miniature: one root seed derives a
 * named child per seat, and nothing is drawn from a clock, a worker ID or
 * `Math.random`. That is what makes "the same seed and deck configuration
 * reproduce the same match" a property rather than a hope.
 */

/**
 * FNV-1a, 32-bit, rendered as eight hex digits.
 *
 * Chosen because it is short, stable across engines, and has no dependencies —
 * this runs in a browser as well as in Node, and a hash that differed between
 * the two would silently break exactly the reproducibility claim it exists to
 * support.
 */
export function hashString(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** The generator stream for one seat's pilot. */
export function derivePilotSeed(rootSeed: string, seatIndex: number): string {
  return `${rootSeed}:pilot:${seatIndex}:${hashString(`${rootSeed}|pilot|${seatIndex}`)}`;
}

/**
 * A fresh random seed for the "randomize" button.
 *
 * The one place randomness is legitimate: choosing which deterministic match to
 * watch. Everything downstream of the returned string is reproducible from it.
 */
export function randomSeed(): string {
  const bytes = new Uint8Array(8);
  if (typeof globalThis.crypto?.getRandomValues === 'function') {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}
