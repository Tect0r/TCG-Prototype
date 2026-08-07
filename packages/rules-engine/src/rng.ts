import { z } from 'zod';

/**
 * Seeded, serializable pseudo-random number generator.
 *
 * The generator is a pure function of its state: every call returns the next
 * state rather than mutating in place, so RNG state travels inside `MatchState`
 * and an identical seed plus identical actions reproduces a match exactly
 * (CLAUDE.md §10).
 *
 * Algorithm: sfc32, seeded through cyrb128. Chosen because both are tiny,
 * dependency-free, and have well-behaved 32-bit state that survives a JSON
 * round trip without precision loss.
 */
export const rngStateSchema = z.strictObject({
  a: z.number().int().min(0).max(0xffffffff),
  b: z.number().int().min(0).max(0xffffffff),
  c: z.number().int().min(0).max(0xffffffff),
  d: z.number().int().min(0).max(0xffffffff),
});

export type RngState = z.infer<typeof rngStateSchema>;

function cyrb128(seed: string): [number, number, number, number] {
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < seed.length; i += 1) {
    const k = seed.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  return [(h1 ^ h2 ^ h3 ^ h4) >>> 0, (h2 ^ h1) >>> 0, (h3 ^ h1) >>> 0, (h4 ^ h1) >>> 0];
}

/** Deterministically derives an initial generator state from a seed string. */
export function createRngState(seed: string): RngState {
  const [a, b, c, d] = cyrb128(seed);
  let state: RngState = { a, b, c, d };
  // Discard a short warm-up run so closely related seeds diverge immediately.
  for (let i = 0; i < 16; i += 1) state = nextUint32(state).state;
  return state;
}

/** Draws the next 32-bit value and returns the successor state. */
export function nextUint32(state: RngState): { value: number; state: RngState } {
  let { a, b, c, d } = state;
  const t = (a + b) >>> 0;
  a = (b ^ (b >>> 9)) >>> 0;
  b = (c + (c << 3)) >>> 0;
  c = ((c << 21) | (c >>> 11)) >>> 0;
  d = (d + 1) >>> 0;
  const next = (t + d) >>> 0;
  c = (c + next) >>> 0;
  return { value: next, state: { a, b, c, d } };
}

/** Uniform float in [0, 1). */
export function nextFloat(state: RngState): { value: number; state: RngState } {
  const step = nextUint32(state);
  return { value: step.value / 4294967296, state: step.state };
}

/**
 * Uniform integer in [0, maxExclusive). Uses rejection sampling so the result
 * is free of modulo bias; the rejection loop is bounded because the acceptance
 * region always covers at least half the 32-bit range.
 */
export function nextInt(state: RngState, maxExclusive: number): { value: number; state: RngState } {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new Error(`nextInt requires a positive integer bound, received ${maxExclusive}`);
  }
  const limit = Math.floor(4294967296 / maxExclusive) * maxExclusive;
  let current = state;
  for (let attempt = 0; attempt < 64; attempt += 1) {
    const step = nextUint32(current);
    current = step.state;
    if (step.value < limit) return { value: step.value % maxExclusive, state: current };
  }
  // Unreachable in practice; fall back rather than loop forever.
  const step = nextUint32(current);
  return { value: step.value % maxExclusive, state: step.state };
}

/** Fisher–Yates shuffle. Returns a new array; the input is untouched. */
export function shuffle<T>(state: RngState, items: readonly T[]): { items: T[]; state: RngState } {
  const out = [...items];
  let current = state;
  for (let i = out.length - 1; i > 0; i -= 1) {
    const step = nextInt(current, i + 1);
    current = step.state;
    const j = step.value;
    const a = out[i] as T;
    const b = out[j] as T;
    out[i] = b;
    out[j] = a;
  }
  return { items: out, state: current };
}
