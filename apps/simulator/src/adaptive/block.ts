import { z } from 'zod';
import type { PilotSpec } from '@tcg/bot-interface';
import type { Environment } from '../environment.js';
import { buildSchedule, type ScheduleDeck, type ScheduledMatch } from '../schedule.js';
import type { AdaptiveConfig } from './config.js';
import { adaptiveRevisionSeedPath } from './revision.js';

/**
 * The mirrored evaluation block as the adaptive run's sole decision unit
 * (M08.17A).
 *
 * A block is every game two revisions play against each other under the
 * configured `blockSize` and `mirrorSeats` — never one game. Nothing in this
 * file accepts a single game's result as an input: `decideAdaptiveBlock`
 * takes the whole block's win tally, so "never adapt from one isolated loss"
 * (CLAUDE.md's M08.17 default policy) is a fact about this file's own types,
 * not a rule a caller has to remember to apply. Actually evaluating a
 * candidate — running the games and attributing each one to a revision — is
 * M08.17B's job; actually promoting or rolling back on a decision is
 * M08.17C's. This file only schedules a block's games and turns a completed
 * block's tally into a decision.
 */

export const ADAPTIVE_BLOCK_SIDES = ['incumbent', 'opponent'] as const;
export const adaptiveBlockSideSchema = z.enum(ADAPTIVE_BLOCK_SIDES);
export type AdaptiveBlockSide = (typeof ADAPTIVE_BLOCK_SIDES)[number];

/** A completed block's win tally. `noResult` covers abnormal terminations and the like. */
export interface AdaptiveBlockOutcome {
  readonly incumbentWins: number;
  readonly opponentWins: number;
  readonly noResult: number;
}

export type AdaptiveBlockDecision =
  | { readonly kind: 'win'; readonly loser: AdaptiveBlockSide }
  | { readonly kind: 'tie' }
  | { readonly kind: 'no_decision'; readonly reason: string };

/** Mirrors `AdaptiveBlockDecision` for persistence (M08.18D): the raw/result reports need it on disk, this file only ever needs it in memory. */
export const adaptiveBlockDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('win'), loser: adaptiveBlockSideSchema }),
  z.strictObject({ kind: z.literal('tie') }),
  z.strictObject({ kind: z.literal('no_decision'), reason: z.string().min(1) }),
]);

/**
 * Deterministic block-level decision: whichever side has fewer wins among the
 * block's *decisive* games (wins + losses, `noResult` games excluded) is the
 * loser and adapts next. Equal decisive wins is a `tie`; zero decisive games
 * — every scheduled game ended without a counted result — is `no_decision`.
 * Both are terminal for this block: neither side is named a loser, so neither
 * is forced to adapt from a block that could not settle anything.
 */
export function decideAdaptiveBlock(outcome: AdaptiveBlockOutcome): AdaptiveBlockDecision {
  const decisive = outcome.incumbentWins + outcome.opponentWins;
  if (decisive === 0) {
    return {
      kind: 'no_decision',
      reason:
        outcome.noResult > 0
          ? `all ${String(outcome.noResult)} scheduled game(s) in this block ended without a counted result`
          : 'no game was scheduled for this block',
    };
  }
  if (outcome.incumbentWins === outcome.opponentWins) return { kind: 'tie' };
  return {
    kind: 'win',
    loser: outcome.incumbentWins < outcome.opponentWins ? 'incumbent' : 'opponent',
  };
}

/**
 * Games one mirrored block spends, assuming the standard evaluation shape
 * this run uses: exactly one pilot spec and exactly two decks (incumbent,
 * opponent). That assumption is only good enough for up-front budget
 * *planning* (`planAdaptiveBudget`) — the actual per-block gate
 * (`scheduleAdaptiveBlock`) always measures its own built schedule instead of
 * trusting this formula, so a caller that ever schedules more than one pilot
 * spec still cannot overspend the budget silently.
 */
export function adaptiveBlockGameCount(
  config: Pick<AdaptiveConfig, 'blockSize' | 'mirrorSeats'>,
): number {
  return config.blockSize * (config.mirrorSeats ? 2 : 1);
}

export interface AdaptiveBudgetShortfall {
  readonly blocksScheduled: number;
  readonly gamesScheduled: number;
  readonly gamesUnspent: number;
  readonly gamesPerBlock: number;
  readonly reason: string;
}

export interface AdaptiveBudgetPlan {
  readonly gamesPerBlock: number;
  /** How many whole blocks `totalLearningBudget` affords. */
  readonly blocksScheduled: number;
  readonly gamesScheduled: number;
  /** `null` when the budget divides evenly; otherwise the explained leftover. */
  readonly shortfall: AdaptiveBudgetShortfall | null;
}

/**
 * How many whole blocks this run's `totalLearningBudget` affords, and the
 * explained shortfall when it does not divide evenly — never a partial final
 * block scheduled to spend the remainder.
 */
export function planAdaptiveBudget(
  config: Pick<AdaptiveConfig, 'totalLearningBudget' | 'blockSize' | 'mirrorSeats'>,
): AdaptiveBudgetPlan {
  const gamesPerBlock = adaptiveBlockGameCount(config);
  const blocksScheduled = Math.floor(config.totalLearningBudget / gamesPerBlock);
  const gamesScheduled = blocksScheduled * gamesPerBlock;
  const gamesUnspent = config.totalLearningBudget - gamesScheduled;

  return {
    gamesPerBlock,
    blocksScheduled,
    gamesScheduled,
    shortfall:
      gamesUnspent === 0
        ? null
        : {
            blocksScheduled,
            gamesScheduled,
            gamesUnspent,
            gamesPerBlock,
            reason:
              `totalLearningBudget ${String(config.totalLearningBudget)} is not an exact multiple ` +
              `of ${String(gamesPerBlock)} games per block (blockSize ${String(config.blockSize)} ` +
              `x ${config.mirrorSeats ? '2 mirrored orientations' : '1 orientation'}); the final ` +
              `${String(gamesUnspent)} game(s) do not fill a whole block and are left unscheduled.`,
          },
  };
}

export interface AdaptiveBlockScheduleInput {
  readonly environment: Environment;
  readonly config: Pick<AdaptiveConfig, 'id' | 'seed' | 'blockSize' | 'mirrorSeats'>;
  /** The incumbent revision's generation, feeding `adaptiveRevisionSeedPath`. */
  readonly generation: number;
  readonly block: number;
  readonly incumbentDeck: ScheduleDeck;
  readonly opponentDeck: ScheduleDeck;
  readonly pilots: readonly PilotSpec[];
  /** Games left in `totalLearningBudget` before this block is scheduled. */
  readonly gamesRemaining: number;
}

export interface AdaptiveBlockShortfall {
  readonly gamesNeeded: number;
  readonly gamesRemaining: number;
  readonly reason: string;
}

export type AdaptiveBlockScheduleResult =
  | { readonly scheduled: true; readonly matches: readonly ScheduledMatch[] }
  | { readonly scheduled: false; readonly shortfall: AdaptiveBlockShortfall };

/**
 * Schedules one mirrored block's games and gates them against the budget that
 * remains: a block that would need more games than `gamesRemaining` is
 * refused outright and reported as a shortfall, never truncated to whatever
 * partial work fits (M08.17A: "schedule only whole work that fits the
 * declared learning budget").
 */
export function scheduleAdaptiveBlock(
  input: AdaptiveBlockScheduleInput,
): AdaptiveBlockScheduleResult {
  const matches = buildSchedule({
    experimentId: `${input.config.id}:block:${String(input.block).padStart(4, '0')}`,
    experimentSeed: adaptiveRevisionSeedPath(
      input.config.seed,
      input.config.id,
      input.generation,
      input.block,
    ),
    environmentId: input.environment.id,
    decks: [input.incumbentDeck, input.opponentDeck],
    pilots: input.pilots,
    pilotPairing: 'mirror',
    playerCount: 2,
    gamesPerPairing: input.config.blockSize,
    mirrorSeats: input.config.mirrorSeats,
    schedule: 'round_robin',
    sampledPairings: adaptiveBlockGameCount(input.config) * Math.max(1, input.pilots.length),
  });

  if (matches.length > input.gamesRemaining) {
    return {
      scheduled: false,
      shortfall: {
        gamesNeeded: matches.length,
        gamesRemaining: input.gamesRemaining,
        reason:
          `block ${String(input.block)} needs ${String(matches.length)} game(s) but only ` +
          `${String(input.gamesRemaining)} remain in totalLearningBudget; scheduling only whole ` +
          `blocks, this run stops here instead of playing a partial block.`,
      },
    };
  }

  return { scheduled: true, matches };
}
