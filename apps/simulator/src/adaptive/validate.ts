import type { SimDeck } from '@tcg/deck-generator';
import type { PilotSpec } from '@tcg/bot-interface';
import type { Environment } from '../environment.js';
import { buildSchedule, type ScheduledMatch } from '../schedule.js';
import { proportion, type ProportionEstimate } from '../analysis/stats.js';
import type { AdaptiveConfig } from './config.js';
import type { AdaptiveCheckpoint } from './checkpoint.js';
import { activeAdaptiveRevisionOf } from './checkpoint.js';

/**
 * Frozen fresh-seed final validation (M08.18C).
 *
 * A learning series measures which side wins the mirrored blocks it actually
 * played — decks whose lineage may still change on the very next block. This
 * file measures something different and deliberately separate: how the two
 * lineages' **final** decks fare against each other, on a seed family that
 * shares nothing with anything either lineage adapted against.
 *
 * Two things keep the learned series and the validation standing from ever
 * blending into one number:
 *
 * - **Freezing.** `freezeAdaptiveFinalDecks` reads only `checkpoint.lineages`
 *   — never `gamesSpent`, `pendingGeneration` or any block/screening
 *   evidence — and refuses a checkpoint whose current block has not finished
 *   deciding a promotion, because a deck that could still be replaced next
 *   block is not yet a "final" deck. `AdaptiveFrozenDecks` is its own type
 *   rather than `AdaptiveCheckpointLineage`, so nothing downstream of this
 *   file can reach back into series state through it.
 * - **A fresh seed family.** `adaptiveValidationSeedPath` derives one more
 *   branch of the same deterministic seed tree `./revision.ts`'s
 *   `adaptiveRevisionSeedPath` uses for every block and generation
 *   (`gen:____|block:____`) — but a distinct branch, so this stage's shuffles
 *   never repeat a shuffle either lineage's learning series already played on
 *   its way here.
 *
 * Like `./block.ts` and `./evaluate.ts`, this file only schedules and tallies
 * — it never calls `runBatch` itself. Actually playing the validation games is
 * `./run.ts`'s `runAdaptiveFinalValidation`.
 */

export interface AdaptiveFrozenRevision {
  readonly revisionId: string;
  readonly deck: SimDeck;
}

/** The two lineages' final decks, decoupled from the checkpoint they were frozen from. */
export interface AdaptiveFrozenDecks {
  readonly incumbent: AdaptiveFrozenRevision;
  readonly opponent: AdaptiveFrozenRevision;
}

/**
 * Freezes a checkpoint's two currently active revisions as the run's final
 * deck list. Refuses a checkpoint with an undecided `pendingGeneration`: that
 * block's promotion has not been decided yet, so its active revision is not
 * yet final and could still be replaced.
 */
export function freezeAdaptiveFinalDecks(checkpoint: AdaptiveCheckpoint): AdaptiveFrozenDecks {
  if (checkpoint.pendingGeneration !== null) {
    throw new Error(
      'cannot freeze final decks from a checkpoint with an undecided pending generation ' +
        `(generation ${String(checkpoint.pendingGeneration.generation)}, block ` +
        `${String(checkpoint.pendingGeneration.block)}); finish deciding that block's promotion ` +
        'before validating a final deck list that could still change.',
    );
  }
  const incumbent = activeAdaptiveRevisionOf(checkpoint.lineages.incumbent);
  const opponent = activeAdaptiveRevisionOf(checkpoint.lineages.opponent);
  return {
    incumbent: { revisionId: incumbent.revisionId, deck: incumbent.deck },
    opponent: { revisionId: opponent.revisionId, deck: opponent.deck },
  };
}

/**
 * The seed-derivation path the frozen validation stage uses, in the same
 * pipe-joined style `../seed.ts` uses throughout (CLAUDE.md §13.4) — but one
 * more branch below the run's root seed than `adaptiveRevisionSeedPath` ever
 * derives, so it shares no seed with any block or screening the learning
 * series played. Deterministic and reproducible from the run's own root seed,
 * never from a clock: "fresh" here means "a family this run has not spent
 * yet," not "random."
 */
export function adaptiveValidationSeedPath(experimentSeed: string, experimentId: string): string {
  return `${experimentSeed}|adaptive:${experimentId}|validation`;
}

export interface AdaptiveValidationScheduleInput {
  readonly environment: Environment;
  readonly config: Pick<AdaptiveConfig, 'id' | 'seed' | 'mirrorSeats' | 'finalValidationGames'>;
  readonly decks: AdaptiveFrozenDecks;
  readonly pilots: readonly PilotSpec[];
}

/**
 * Schedules the frozen validation stage: `finalValidationGames` games per
 * seat orientation between the two frozen decks, on the fresh seed family
 * above. Mirrored under `config.mirrorSeats`, the same run-wide seat-mirroring
 * setting every other adaptive schedule reads (CLAUDE.md §13.7).
 */
export function scheduleAdaptiveValidation(
  input: AdaptiveValidationScheduleInput,
): readonly ScheduledMatch[] {
  return buildSchedule({
    experimentId: `${input.config.id}:validation`,
    experimentSeed: adaptiveValidationSeedPath(input.config.seed, input.config.id),
    environmentId: input.environment.id,
    decks: [input.decks.incumbent.deck, input.decks.opponent.deck],
    pilots: input.pilots,
    pilotPairing: 'mirror',
    playerCount: 2,
    gamesPerPairing: input.config.finalValidationGames,
    mirrorSeats: input.config.mirrorSeats,
    schedule: 'round_robin',
    sampledPairings: 1,
  });
}

/** One validation game's outcome. `winnerDeckHash` is `null` for an abnormal or otherwise uncounted result. */
export interface AdaptiveValidationResult {
  readonly matchId: string;
  readonly winnerDeckHash: string | null;
}

/** The frozen validation stage's win tally. `noResult` covers abnormal terminations and missing results alike. */
export interface AdaptiveValidationOutcome {
  readonly incumbentWins: number;
  readonly opponentWins: number;
  readonly noResult: number;
}

/** Tallies a completed validation stage's results against the frozen decks that produced them. */
export function tallyAdaptiveValidation(
  decks: AdaptiveFrozenDecks,
  results: readonly AdaptiveValidationResult[],
): AdaptiveValidationOutcome {
  let incumbentWins = 0;
  let opponentWins = 0;
  let noResult = 0;
  for (const result of results) {
    if (result.winnerDeckHash === decks.incumbent.deck.hash) incumbentWins += 1;
    else if (result.winnerDeckHash === decks.opponent.deck.hash) opponentWins += 1;
    else noResult += 1;
  }
  return { incumbentWins, opponentWins, noResult };
}

/**
 * The incumbent's Wilson-interval win rate over the validation stage's
 * decisive games (`noResult` excluded), the same interval `./promote.ts`'s
 * `adaptivePromotionScore` computes for screening evidence — but never fed by
 * it: this reads only `AdaptiveValidationOutcome`, which nothing in this file
 * ever derives from a series or screening tally.
 */
export function adaptiveValidationStanding(outcome: AdaptiveValidationOutcome): ProportionEstimate {
  return proportion(outcome.incumbentWins, outcome.incumbentWins + outcome.opponentWins);
}
