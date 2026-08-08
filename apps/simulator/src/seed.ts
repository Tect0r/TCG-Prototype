import { z } from 'zod';
import { createRngState, type RngState } from '@tcg/rules-engine';
import { digest } from './hash.js';

/**
 * Deterministic seed hierarchy (CLAUDE.md §13.4).
 *
 * Every seed in an experiment is derived by joining immutable identifiers into a
 * path and hashing it. Nothing here reads a clock, a worker ID, a process ID, an
 * array completion order or `Math.random()`, so the result of a match depends
 * only on *which* match it is — not on how many workers ran it, how fast the
 * machine was, or what order the results came back in.
 *
 * The path itself is kept alongside the derived seed in every record, so a
 * reader can see exactly why a match got the seed it got:
 *
 * ```text
 * experiment                       -> exp-2026-08
 *   environment                    -> exp-2026-08|env:baseline
 *     deck pair                    -> exp-2026-08|env:baseline|pair:a1b2…_c3d4…
 *       game index                 -> …|game:0003
 *         match RNG                -> …|game:0003|match
 *         seat assignment          -> …|game:0003|seats
 *         pilot, per seat          -> …|game:0003|pilot:0
 * ```
 *
 * Paired comparisons use common random numbers by construction: a baseline and a
 * candidate run that share an experiment ID, deck pair and game index derive the
 * *same* match, seat and pilot seeds, because the environment ID is the only
 * thing that differs and the pairing helper drops it (see `pairedGameSeed`).
 */

/** Bump when the derivation changes. Recorded in every result. */
export const SEED_DERIVATION_VERSION = 2;

export const seedBundleSchema = z.strictObject({
  derivationVersion: z.literal(SEED_DERIVATION_VERSION),
  /** The human-readable derivation path this bundle came from. */
  path: z.string().min(1),
  /** Seed handed to `createMatch`; drives shuffles and the starting-player roll. */
  matchSeed: z.string().min(1).max(128),
  /** Seed used to decide which deck sits in which seat. */
  seatSeed: z.string().min(1).max(128),
  /** One generator seed per seat, in seat order. */
  pilotSeeds: z.array(z.string().min(1).max(128)),
});
export type SeedBundle = z.infer<typeof seedBundleSchema>;

const SEPARATOR = '|';

export function experimentSeed(seed: string): string {
  return seed;
}

export function environmentSeed(experiment: string, environmentId: string): string {
  return `${experiment}${SEPARATOR}env:${environmentId}`;
}

export function deckPairSeed(environment: string, deckPairId: string): string {
  return `${environment}${SEPARATOR}pair:${deckPairId}`;
}

export function gameSeed(pair: string, gameIndex: number): string {
  return `${pair}${SEPARATOR}game:${String(gameIndex).padStart(6, '0')}`;
}

/**
 * The game seed a *paired* comparison uses.
 *
 * Deliberately omits the environment: a baseline run and a candidate run of the
 * same deck pair and game index must share their match, seat and pilot seeds, or
 * the comparison is measuring noise as well as the change (CLAUDE.md §13.4).
 */
export function pairedGameSeed(experiment: string, deckPairId: string, gameIndex: number): string {
  return gameSeed(deckPairSeed(experiment, deckPairId), gameIndex);
}

/** Compresses a derivation path into a seed short enough for `MatchState`. */
export function seedFromPath(path: string, prefix: string): string {
  return `${prefix}_${digest(path, 32)}`;
}

export function deriveSeedBundle(path: string, seats: number): SeedBundle {
  return {
    derivationVersion: SEED_DERIVATION_VERSION,
    path,
    matchSeed: seedFromPath(`${path}${SEPARATOR}match`, 'm'),
    seatSeed: seedFromPath(`${path}${SEPARATOR}seats`, 's'),
    pilotSeeds: Array.from({ length: seats }, (_, index) =>
      seedFromPath(`${path}${SEPARATOR}pilot:${index}`, 'p'),
    ),
  };
}

/** The engine generator state a pilot seed expands to. */
export function rngFor(seed: string): RngState {
  return createRngState(seed);
}

/**
 * Deterministic small integer from a seed string, for scheduling decisions such
 * as which mirrored orientation a game uses.
 */
export function seededIndex(seed: string, bound: number): number {
  if (bound <= 0) return 0;
  const hex = digest(seed, 8);
  return Number.parseInt(hex, 16) % bound;
}
