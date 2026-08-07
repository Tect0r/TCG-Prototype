const CROCKFORD_BASE32 = '0123456789abcdefghjkmnpqrstvwxyz';

function encodeBase32(value: number, length: number): string {
  let out = '';
  let remaining = Math.floor(value);
  for (let i = 0; i < length; i += 1) {
    out = CROCKFORD_BASE32[remaining % 32] + out;
    remaining = Math.floor(remaining / 32);
  }
  return out;
}

export interface IdSources {
  /** Epoch milliseconds. */
  readonly now: () => number;
  /** Float in [0, 1). */
  readonly random: () => number;
}

const defaultSources: IdSources = { now: () => Date.now(), random: () => Math.random() };

/**
 * Lexicographically sortable, URL-safe local identifier: `<prefix>_<time><random>`.
 * Sources are injectable so tests stay deterministic.
 */
export function generateId(prefix: string, sources: IdSources = defaultSources): string {
  const time = encodeBase32(sources.now(), 10);
  const random = encodeBase32(Math.floor(sources.random() * 32 ** 8), 8);
  return `${prefix}_${time}${random}`;
}
