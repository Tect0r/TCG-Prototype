import type { PilotSpec } from '@tcg/bot-interface';
import { digestOf } from './hash.js';
import {
  deriveSeedBundle,
  environmentSeed,
  gameSeed,
  deckPairSeed,
  seededIndex,
  type SeedBundle,
} from './seed.js';
import type { SimDeck } from './deck-search/deck.js';

/**
 * Which matches an experiment consists of, decided up front (CLAUDE.md §13.7).
 *
 * The schedule is a pure function of the configuration: no clock, no worker
 * count, no completion order. That is what lets an interrupted run resume by
 * regenerating the schedule and skipping the match IDs it already has, and what
 * makes `workers: 1` and `workers: 8` produce the same set of matches.
 *
 * **Seat mirroring.** Every deck tuple is played in every rotation of the seats,
 * and — because the seed path deliberately excludes both the pilots and the seat
 * orientation — each rotation is played on *the same shuffles*. A seat advantage
 * therefore shows up as a difference between orientations of one game index, not
 * as noise between unrelated games.
 */

export interface ScheduledSeat {
  readonly playerId: string;
  readonly deckIndex: number;
  readonly pilotIndex: number;
}

export interface ScheduledMatch {
  readonly matchId: string;
  readonly orderKey: string;
  readonly environmentId: string;
  /** Order-independent identity of the deck tuple, so mirrors share a seed. */
  readonly deckPairId: string;
  /** Identity of everything else that varies: the pilot tuple. */
  readonly variantKey: string;
  readonly gameIndex: number;
  readonly orientation: number;
  readonly seats: readonly ScheduledSeat[];
  readonly seeds: SeedBundle;
}

export interface ScheduleOptions {
  readonly experimentId: string;
  readonly experimentSeed: string;
  readonly environmentId: string;
  readonly decks: readonly SimDeck[];
  readonly pilots: readonly PilotSpec[];
  readonly pilotPairing: 'mirror' | 'all_pairs' | 'rotate';
  readonly playerCount: number;
  /** Games per deck tuple, per pilot tuple, *per seat orientation*. */
  readonly gamesPerPairing: number;
  readonly mirrorSeats: boolean;
  readonly schedule: 'round_robin' | 'sampled';
  readonly sampledPairings: number;
  /**
   * Use the environment-free seed path, so a baseline and a candidate run share
   * common random numbers for the same deck tuple and game index.
   */
  readonly pairedSeeds?: boolean;
  /**
   * Deck hashes that are masked out when deriving the seed path.
   *
   * A replacement experiment plays "deck A" and "deck A with one card swapped"
   * against the same opponent field. Those are different decks, so they land in
   * different deck tuples and would normally get different shuffles — which is
   * exactly the noise the experiment is trying to eliminate. Masking the arms
   * makes both variants of the same matchup derive one seed, so the only thing
   * that differs between the two runs is the swapped card (CLAUDE.md §13.10).
   *
   * Only the *seed* is affected. The recorded `deckPairId` is always the real
   * one, so nothing downstream can confuse the two decks.
   */
  readonly seedIgnoreDeckHashes?: readonly string[];
}

/** Every combination of `size` deck indices, in stable lexicographic order. */
export function deckTuples(deckCount: number, size: number): number[][] {
  const tuples: number[][] = [];
  const build = (start: number, current: number[]): void => {
    if (current.length === size) {
      tuples.push([...current]);
      return;
    }
    for (let index = start; index < deckCount; index += 1) {
      current.push(index);
      build(index + 1, current);
      current.pop();
    }
  };
  build(0, []);
  return tuples;
}

/** Pilot index tuples implied by the pairing mode. */
export function pilotTuples(
  pilotCount: number,
  size: number,
  mode: 'mirror' | 'all_pairs' | 'rotate',
): number[][] {
  if (pilotCount === 0) return [];
  switch (mode) {
    case 'mirror':
      // Same pilot in every seat: isolates the decks from the pilots.
      return Array.from({ length: pilotCount }, (_, index) =>
        Array.from({ length: size }, () => index),
      );
    case 'rotate':
      // Each pilot takes each seat in turn: cheap coverage of pilot mixtures.
      return Array.from({ length: pilotCount }, (_, offset) =>
        Array.from({ length: size }, (_, seat) => (seat + offset) % pilotCount),
      );
    case 'all_pairs': {
      const tuples: number[][] = [];
      const build = (current: number[]): void => {
        if (current.length === size) {
          tuples.push([...current]);
          return;
        }
        for (let index = 0; index < pilotCount; index += 1) {
          current.push(index);
          build(current);
          current.pop();
        }
      };
      build([]);
      return tuples;
    }
    default:
      return [];
  }
}

/** Rotates a tuple left by `by` positions. */
function rotate<T>(items: readonly T[], by: number): T[] {
  const size = items.length;
  return items.map((_, index) => items[(index + by) % size] as T);
}

export function buildSchedule(options: ScheduleOptions): ScheduledMatch[] {
  const size = options.playerCount;
  if (options.decks.length < size) {
    throw new Error(
      `A ${size}-player schedule needs at least ${size} decks; ${options.decks.length} were supplied.`,
    );
  }

  let tuples = deckTuples(options.decks.length, size);
  if (options.schedule === 'sampled' && tuples.length > options.sampledPairings) {
    // Deterministic sampling: rank every tuple by a hash of its own identity and
    // keep the lowest. No RNG, no order dependence, stable under resume.
    tuples = [...tuples]
      .map((tuple) => ({ tuple, rank: digestOf({ experiment: options.experimentId, tuple }) }))
      .sort((left, right) => left.rank.localeCompare(right.rank))
      .slice(0, options.sampledPairings)
      .map((entry) => entry.tuple)
      .sort((left, right) => left.join(',').localeCompare(right.join(',')));
  }

  const pilotSets = pilotTuples(options.pilots.length, size, options.pilotPairing);
  const orientations = options.mirrorSeats ? size : 1;
  const environmentPath = options.pairedSeeds
    ? options.experimentSeed
    : environmentSeed(options.experimentSeed, options.environmentId);

  const matches: ScheduledMatch[] = [];

  const masked = new Set(options.seedIgnoreDeckHashes ?? []);

  for (const tuple of tuples) {
    const hashes = tuple.map((index) => options.decks[index]?.hash ?? '');
    // Sorted, so both orientations of the same table share one identity — and
    // therefore one seed path.
    const deckPairId = digestOf({ decks: [...hashes].sort() });
    const seedPairId =
      masked.size === 0
        ? deckPairId
        : digestOf({ decks: hashes.map((hash) => (masked.has(hash) ? '*' : hash)).sort() });
    const pairPath = deckPairSeed(environmentPath, seedPairId);

    for (const pilotSet of pilotSets) {
      const variantKey = digestOf({
        pilots: pilotSet.map((index) => options.pilots[index] ?? null),
      });

      for (let orientation = 0; orientation < orientations; orientation += 1) {
        for (let repeat = 0; repeat < options.gamesPerPairing; repeat += 1) {
          const gameIndex = orientation * options.gamesPerPairing + repeat;
          const path = gameSeed(pairPath, gameIndex);
          const seatDecks = rotate(tuple, orientation);

          matches.push({
            matchId: `m_${digestOf({
              experimentId: options.experimentId,
              environmentId: options.environmentId,
              deckPairId,
              variantKey,
              gameIndex,
            })}`,
            orderKey: [
              options.environmentId,
              deckPairId,
              variantKey,
              String(gameIndex).padStart(8, '0'),
            ].join(' '),
            environmentId: options.environmentId,
            deckPairId,
            variantKey,
            gameIndex,
            orientation,
            seats: seatDecks.map((deckIndex, seatIndex) => ({
              playerId: `player_${seatIndex + 1}`,
              deckIndex,
              pilotIndex: pilotSet[seatIndex] ?? 0,
            })),
            seeds: deriveSeedBundle(path, size),
          });
        }
      }
    }
  }

  // One canonical order for the whole experiment, so aggregation is
  // reproducible whatever order results arrive in.
  return matches.sort((left, right) => left.orderKey.localeCompare(right.orderKey));
}

/** Deterministic index helper, re-exported for schedulers built on top of this. */
export { seededIndex };
