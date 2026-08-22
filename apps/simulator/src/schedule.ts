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

/**
 * The only thing scheduling reads from a deck: its content address.
 *
 * Narrower than `SimDeck` on purpose, and for the reason M09.8 narrowed the
 * generator's input — the schedule never looks at a card, a Commander or a
 * construction record, so requiring one would mean a caller that wants to know
 * *how many* matches a configuration produces has to invent forty card IDs
 * first. `SimDeck` satisfies this structurally, so no call site had to change.
 */
export interface ScheduleDeck {
  readonly hash: string;
}

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
  readonly decks: readonly ScheduleDeck[];
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
  /**
   * Also seat a deck against itself (M03.4).
   *
   * The default schedule enumerates *combinations* of distinct decks, because a
   * search or an abuse hunt learns nothing from a deck beating a copy of itself
   * and would spend a quarter of its budget doing so. An ordered matchup matrix
   * is the opposite case: "every ordered pair of the four precons" is 4 × 4 = 16
   * cells, and the four diagonal ones are mirrors. With this set, deck tuples are
   * combinations *with repetition*.
   *
   * A mirror tuple has one distinct seat rotation rather than `playerCount` of
   * them, so it contributes one ordered matchup and not `playerCount` copies of
   * the same table on different seeds. Tuples of distinct decks are unaffected:
   * all of their rotations differ, which is why turning this on cannot move an
   * existing schedule.
   */
  readonly includeMirrorMatchups?: boolean;
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

/**
 * Every combination of `size` deck indices *with repetition*, in stable order.
 *
 * The mirror-inclusive counterpart of `deckTuples`: `[0, 0]` is a deck seated
 * against a copy of itself, which is a legitimate ordered matchup and not a
 * duplicate of anything.
 */
export function deckMultisets(deckCount: number, size: number): number[][] {
  const tuples: number[][] = [];
  const build = (start: number, current: number[]): void => {
    if (current.length === size) {
      tuples.push([...current]);
      return;
    }
    for (let index = start; index < deckCount; index += 1) {
      current.push(index);
      build(index, current);
      current.pop();
    }
  };
  build(0, []);
  return tuples;
}

/**
 * How many *distinct* seatings rotating this tuple produces.
 *
 * For a tuple of distinct decks this is its length, which is what the schedule
 * has always used. For a mirror it is 1: rotating `[0, 0]` gives `[0, 0]` back,
 * and running that twice would be two games of one matchup rather than the two
 * seat orientations the mirroring is there to measure.
 */
export function distinctRotationCount(tuple: readonly number[]): number {
  const size = tuple.length;
  for (let by = 1; by < size; by += 1) {
    if (tuple.every((value, index) => value === tuple[(index + by) % size])) return by;
  }
  return size;
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

  let tuples = options.includeMirrorMatchups
    ? deckMultisets(options.decks.length, size)
    : deckTuples(options.decks.length, size);
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
    // A tuple of distinct decks has `size` distinct rotations, so this is the
    // previous `size` for every schedule that does not include mirrors.
    const orientations = options.mirrorSeats ? distinctRotationCount(tuple) : 1;

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

/**
 * The matches in `schedule` that seat a deck from **each** of two named groups.
 *
 * Extracted in M08.3 rather than written a third time. A replacement experiment
 * and a search generation both build one round-robin over the union of two sets
 * of decks and then keep only the cells that cross between them — the arms
 * against the opponent field, the contenders against the archive — because a
 * full round robin over the union would spend most of its budget playing
 * opponents against each other. Both call sites had the same four lines, and the
 * match-count estimator needs a *third* copy of them to say how much work such a
 * configuration schedules (ADR 0023 §2). A second formula is a thing that can be
 * right today; a third is a thing that will not stay right.
 *
 * Membership is by deck hash rather than by index, because a deck can appear in
 * both groups — a search's opponent field is drawn from the archive *and* the
 * current population — and the crossing rule is about which decks a match seats,
 * not about where they landed in the tuple.
 */
export function matchesBetween(
  schedule: readonly ScheduledMatch[],
  decks: readonly ScheduleDeck[],
  left: ReadonlySet<string>,
  right: ReadonlySet<string>,
): ScheduledMatch[] {
  return schedule.filter((match) => {
    const hashes = match.seats.map((seat) => decks[seat.deckIndex]?.hash ?? '');
    return hashes.some((hash) => left.has(hash)) && hashes.some((hash) => right.has(hash));
  });
}
