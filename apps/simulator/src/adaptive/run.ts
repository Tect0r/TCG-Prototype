import type { PilotSpec } from '@tcg/bot-interface';
import type { Environment } from '../environment.js';
import type { MatchLimits } from '../run-match.js';
import {
  runBatch,
  type BatchOutcome,
  type BatchRetention,
  type RunBatchOptions,
} from '../run-batch.js';
import type { MatchStore } from '../reporting/match-store.js';
import type { MatchRecord } from '../telemetry/schema.js';
import type { ScheduledMatch } from '../schedule.js';
import type { StopSignal } from '../stop.js';
import type { AdaptiveConfig, AdaptiveRebuildTrigger } from './config.js';
import type { AdaptiveCheckpoint, AdaptiveCheckpointLineage } from './checkpoint.js';
import {
  ADAPTIVE_BLOCK_SIDES,
  decideAdaptiveBlock,
  scheduleAdaptiveBlock,
  type AdaptiveBlockOutcome,
  type AdaptiveBlockSide,
} from './block.js';
import {
  scheduleAdaptiveCandidateScreening,
  tallyAdaptiveScreening,
  type AdaptiveCandidateScreening,
  type AdaptiveScreeningMatch,
  type AdaptiveScreeningResult,
} from './evaluate.js';
import { generateAdaptiveCandidates } from './generate.js';
import { decideAdaptivePromotion, type AdaptiveCandidateEvidence } from './promote.js';
import { adaptiveRevisionSeedPath, type AdaptiveRevision } from './revision.js';

/**
 * Resumable Adaptive Counter orchestrator (M08.18B).
 *
 * Every earlier adaptive file only schedules, generates or decides — none of
 * them runs a game or advances a checkpoint. This file is where those pieces
 * are actually driven: one mirrored block at a time (`./block.ts`), and, when
 * a block decides a loser, that lineage's candidates (`./generate.ts`),
 * screened (`./evaluate.ts`) and promoted or retained (`./promote.ts`), in a
 * loop that stops cleanly once `totalLearningBudget` no longer affords the
 * next whole block or the next whole generation's screening.
 *
 * Resumability rests on one property every earlier file already documented on
 * its own terms: a block's schedule, a candidate's screening schedule and a
 * candidate's own generation are all pure, deterministic functions of
 * checkpoint state, never of "how much of this phase already ran." So this
 * file never invents new checkpoint fields to track partial progress within a
 * block or a generation — `runBatch`'s own identity-based resume (arm +
 * matchId, `../reporting/match-store.ts`) already skips whatever the sink has
 * already committed, and re-deriving the same phase from an *unchanged*
 * checkpoint after an interruption reproduces the exact same schedule,
 * outcome and decision as an uninterrupted run would have reached. The
 * committed checkpoint itself only ever advances once a whole phase — one
 * block's decision, or one generation's full screening-and-promotion — is
 * completely settled; a phase interrupted by `ExperimentStopped` (`../stop.js`)
 * leaves the checkpoint exactly as it was handed in.
 *
 * That is also this file's resume contract for a caller: on `ExperimentStopped`,
 * retry `runAdaptiveExperiment` with the *same* checkpoint object originally
 * passed in — never a partially-advanced one reconstructed from a failed
 * attempt — backed by the same persistent `MatchStore`. Retrying that way is
 * always safe, including when the interruption fell inside a later phase than
 * the one the checkpoint itself still names, because every phase up to and
 * including the interrupted one replays as a no-op reconciliation against
 * already-committed matches before fresh work resumes.
 */

export interface RunAdaptiveExperimentOptions {
  readonly environment: Environment;
  readonly config: AdaptiveConfig;
  readonly experimentKind: MatchRecord['experimentKind'];
  readonly pilots: readonly PilotSpec[];
  readonly limits: MatchLimits;
  readonly retention: BatchRetention;
  readonly workers: number;
  /** `null` runs in memory only, with no resume capability across attempts. */
  readonly sink: MatchStore | null;
  readonly checkpoint: AdaptiveCheckpoint;
  readonly shouldStop?: StopSignal;
  readonly softwareCommit?: string | null;
}

function activeRevisionOf(lineage: AdaptiveCheckpointLineage): AdaptiveRevision {
  const revision = lineage.revisions.find(
    (candidate) => candidate.revisionId === lineage.activeRevisionId,
  );
  if (revision === undefined) {
    throw new Error(
      `checkpoint invariant violated: active revision ${lineage.activeRevisionId} is not present ` +
        "in its own lineage's revisions.",
    );
  }
  return revision;
}

/** Which fixed lineage slot generated `checkpoint.pendingGeneration`, derived rather than stored. */
function loserSideOf(checkpoint: AdaptiveCheckpoint): AdaptiveBlockSide {
  const generation = checkpoint.pendingGeneration;
  if (generation === null) {
    throw new Error('loserSideOf called on a checkpoint with no pending generation.');
  }
  const side = ADAPTIVE_BLOCK_SIDES.find(
    (candidate) =>
      checkpoint.lineages[candidate].activeRevisionId === generation.incumbentRevisionId,
  );
  if (side === undefined) {
    throw new Error(
      'checkpoint invariant violated: pendingGeneration.incumbentRevisionId names neither ' +
        "lineage's active revision.",
    );
  }
  return side;
}

/**
 * Consecutive `swap` ancestors above a lineage's active revision, walking
 * back until a `root` or `rebuild` breaks the chain. Not a stored count
 * (`./checkpoint.ts`'s own docstring: no field exists for it) — a lineage is
 * a straight chain, so its own `revisions` array is the only source of truth.
 */
function consecutiveLossesOf(lineage: AdaptiveCheckpointLineage): number {
  const byId = new Map(
    lineage.revisions.map((revision) => [revision.revisionId, revision] as const),
  );
  let count = 0;
  let current = byId.get(lineage.activeRevisionId);
  while (current !== undefined && current.construction === 'swap') {
    count += 1;
    current = current.parentRevisionId === null ? undefined : byId.get(current.parentRevisionId);
  }
  return count;
}

function shouldRebuildAdaptiveLineage(
  trigger: AdaptiveRebuildTrigger | null,
  lineage: AdaptiveCheckpointLineage,
  block: number,
): boolean {
  if (trigger === null) return false;
  const afterConsecutiveLosses =
    trigger.afterConsecutiveLosses !== undefined &&
    consecutiveLossesOf(lineage) + 1 >= trigger.afterConsecutiveLosses;
  const everyBlocks = trigger.everyBlocks !== undefined && (block + 1) % trigger.everyBlocks === 0;
  return afterConsecutiveLosses || everyBlocks;
}

function winnerDeckHashOf(record: MatchRecord): string | null {
  return record.seats.find((seat) => seat.won)?.deckHash ?? null;
}

function deriveBlockOutcome(
  records: readonly MatchRecord[],
  incumbentDeckHash: string,
  opponentDeckHash: string,
): AdaptiveBlockOutcome {
  let incumbentWins = 0;
  let opponentWins = 0;
  let noResult = 0;
  for (const record of records) {
    const winner = winnerDeckHashOf(record);
    if (winner === incumbentDeckHash) incumbentWins += 1;
    else if (winner === opponentDeckHash) opponentWins += 1;
    else noResult += 1;
  }
  return { incumbentWins, opponentWins, noResult };
}

/**
 * Reconciles one phase's records after `runBatch`: fresh matches from this
 * call plus whatever the sink already held for this exact schedule (a prior,
 * interrupted attempt's matches skipped by resume). `outcome.records` alone
 * only ever holds matches freshly run *this* call — never the resumed ones —
 * so a caller reading a phase's whole result has to go through the sink.
 */
function recordsForSchedule(
  sink: MatchStore | null,
  outcome: BatchOutcome,
  matches: readonly ScheduledMatch[],
): readonly MatchRecord[] {
  if (sink === null) return outcome.records;
  const ids = new Set(matches.map((match) => match.matchId));
  return sink.all().filter((record) => ids.has(record.matchId));
}

function batchOptionsBase(
  options: RunAdaptiveExperimentOptions,
  checkpoint: AdaptiveCheckpoint,
): Omit<RunBatchOptions, 'experimentId' | 'decks' | 'schedule'> {
  return {
    experimentKind: options.experimentKind,
    configHash: checkpoint.configHash,
    arm: null,
    environment: options.environment,
    pilots: options.pilots,
    limits: options.limits,
    retention: options.retention,
    workers: options.workers,
    failFast: false,
    sink: options.sink,
    softwareCommit: options.softwareCommit ?? null,
    ...(options.shouldStop === undefined ? {} : { shouldStop: options.shouldStop }),
  };
}

interface PhaseResult {
  readonly checkpoint: AdaptiveCheckpoint;
  /** False when the budget no longer affords this phase's whole work — the run's clean stop. */
  readonly scheduled: boolean;
}

/**
 * Plays one mirrored block for the checkpoint's two current active revisions.
 * A decisive loss generates that side's candidates and leaves them as
 * `pendingGeneration`, atomically alongside `gamesSpent`; a tie or
 * no-decision only advances `nextBlock`. Never spends more than
 * `gamesRemaining` — a block too large to fit is the run's clean stop.
 */
async function playBlock(
  options: RunAdaptiveExperimentOptions,
  checkpoint: AdaptiveCheckpoint,
): Promise<PhaseResult> {
  const incumbentRevision = activeRevisionOf(checkpoint.lineages.incumbent);
  const opponentRevision = activeRevisionOf(checkpoint.lineages.opponent);
  const gamesRemaining = options.config.totalLearningBudget - checkpoint.gamesSpent;

  const scheduled = scheduleAdaptiveBlock({
    environment: options.environment,
    config: options.config,
    generation: incumbentRevision.generation,
    block: checkpoint.nextBlock,
    incumbentDeck: incumbentRevision.deck,
    opponentDeck: opponentRevision.deck,
    pilots: options.pilots,
    gamesRemaining,
  });
  if (!scheduled.scheduled) return { checkpoint, scheduled: false };

  const outcome = await runBatch({
    ...batchOptionsBase(options, checkpoint),
    experimentId: `${options.config.id}:block:${String(checkpoint.nextBlock).padStart(4, '0')}`,
    decks: [incumbentRevision.deck, opponentRevision.deck],
    schedule: scheduled.matches,
  });
  const records = recordsForSchedule(options.sink, outcome, scheduled.matches);
  const decision = decideAdaptiveBlock(
    deriveBlockOutcome(records, incumbentRevision.deck.hash, opponentRevision.deck.hash),
  );
  const gamesSpent = checkpoint.gamesSpent + records.length;

  if (decision.kind !== 'win') {
    return {
      scheduled: true,
      checkpoint: { ...checkpoint, gamesSpent, nextBlock: checkpoint.nextBlock + 1 },
    };
  }

  const loserSide = decision.loser;
  const winnerSide: AdaptiveBlockSide = loserSide === 'incumbent' ? 'opponent' : 'incumbent';
  const loserRevision = activeRevisionOf(checkpoint.lineages[loserSide]);
  const winnerRevision = activeRevisionOf(checkpoint.lineages[winnerSide]);
  const rebuild = shouldRebuildAdaptiveLineage(
    options.config.rebuildTrigger,
    checkpoint.lineages[loserSide],
    checkpoint.nextBlock,
  );

  const generationRecord = generateAdaptiveCandidates({
    environment: options.environment,
    config: options.config,
    incumbent: loserRevision,
    opponentRevisionId: winnerRevision.revisionId,
    block: checkpoint.nextBlock,
    rebuild,
  });

  return {
    scheduled: true,
    checkpoint: {
      ...checkpoint,
      gamesSpent,
      pendingGeneration: generationRecord,
      nextGeneration: generationRecord.generation,
      nextSeedPath: adaptiveRevisionSeedPath(
        options.config.seed,
        options.config.id,
        generationRecord.generation,
        checkpoint.nextBlock,
      ),
    },
  };
}

/** One candidate's screening games, run grouped by opponent deck so each `runBatch` call has a fixed deck pair. */
async function runCandidateScreening(
  options: RunAdaptiveExperimentOptions,
  checkpoint: AdaptiveCheckpoint,
  candidate: AdaptiveRevision,
  screening: AdaptiveCandidateScreening,
  currentOpponentDeck: { readonly hash: string },
): Promise<AdaptiveScreeningResult[]> {
  const deckByHash = new Map<string, AdaptiveRevision['deck']>();
  deckByHash.set(
    currentOpponentDeck.hash,
    activeRevisionOf(
      checkpoint.lineages[loserSideOf(checkpoint) === 'incumbent' ? 'opponent' : 'incumbent'],
    ).deck,
  );
  for (const deck of checkpoint.referenceField) deckByHash.set(deck.hash, deck);

  const groups = new Map<string, AdaptiveScreeningMatch[]>();
  for (const entry of [...screening.opponentMatches, ...screening.fieldMatches]) {
    const group = groups.get(entry.opponentDeckHash);
    if (group) group.push(entry);
    else groups.set(entry.opponentDeckHash, [entry]);
  }

  const results: AdaptiveScreeningResult[] = [];
  for (const [hash, entries] of groups) {
    const opponentDeck = deckByHash.get(hash);
    if (!opponentDeck) {
      throw new Error(
        `no deck with hash ${hash} is available to run candidate ${candidate.revisionId}'s ` +
          'screening against.',
      );
    }
    const matches = entries.map((entry) => entry.match);
    const outcome = await runBatch({
      ...batchOptionsBase(options, checkpoint),
      experimentId:
        `${options.config.id}:screen:${String(checkpoint.nextBlock).padStart(4, '0')}` +
        `:${candidate.revisionId}`,
      decks: [candidate.deck, opponentDeck],
      schedule: matches,
    });
    for (const record of recordsForSchedule(options.sink, outcome, matches)) {
      results.push({ matchId: record.matchId, winnerDeckHash: winnerDeckHashOf(record) });
    }
  }
  return results;
}

/**
 * Screens every one of `pendingGeneration`'s candidates against the current
 * opponent (and reference field), then promotes or retains. Every candidate's
 * total game count is computed up front, pure and zero I/O, and the whole
 * generation is refused — not partially screened — when it would need more
 * than `gamesRemaining`, mirroring `scheduleAdaptiveBlock`'s own "measure the
 * real schedule, never truncate" rule extended to a multi-candidate phase.
 */
async function processGeneration(
  options: RunAdaptiveExperimentOptions,
  checkpoint: AdaptiveCheckpoint,
): Promise<PhaseResult> {
  const generation = checkpoint.pendingGeneration;
  if (generation === null) {
    throw new Error('processGeneration called on a checkpoint with no pending generation.');
  }
  const loserSide = loserSideOf(checkpoint);
  const winnerSide: AdaptiveBlockSide = loserSide === 'incumbent' ? 'opponent' : 'incumbent';
  const opponentRevision = activeRevisionOf(checkpoint.lineages[winnerSide]);

  const plans = generation.candidates.map((candidate) => ({
    candidate,
    screening: scheduleAdaptiveCandidateScreening({
      environment: options.environment,
      config: options.config,
      candidate,
      block: checkpoint.nextBlock,
      opponentDeck: opponentRevision.deck,
      referenceField: checkpoint.referenceField,
      pilots: options.pilots,
    }),
  }));
  const totalGames = plans.reduce(
    (sum, plan) => sum + plan.screening.opponentMatches.length + plan.screening.fieldMatches.length,
    0,
  );
  const gamesRemaining = options.config.totalLearningBudget - checkpoint.gamesSpent;
  if (totalGames > gamesRemaining) return { checkpoint, scheduled: false };

  const evidence: AdaptiveCandidateEvidence[] = [];
  for (const plan of plans) {
    const results = await runCandidateScreening(
      options,
      checkpoint,
      plan.candidate,
      plan.screening,
      opponentRevision.deck,
    );
    evidence.push({
      candidate: plan.candidate,
      screening: plan.screening,
      tallies: tallyAdaptiveScreening(plan.screening, plan.candidate.deck.hash, results),
    });
  }

  const loserRevision = activeRevisionOf(checkpoint.lineages[loserSide]);
  const decision = decideAdaptivePromotion({
    incumbent: loserRevision,
    opponentRevision,
    candidates: evidence,
  });
  if (decision.kind === 'stale') {
    throw new Error(
      'invariant violated: a strictly sequential adaptive run produced a stale promotion ' +
        `decision (${decision.reason})`,
    );
  }

  const updatedLineage: AdaptiveCheckpointLineage =
    decision.kind === 'promoted'
      ? {
          activeRevisionId: decision.revision.revisionId,
          revisions: [...checkpoint.lineages[loserSide].revisions, decision.revision],
        }
      : checkpoint.lineages[loserSide];

  return {
    scheduled: true,
    checkpoint: {
      ...checkpoint,
      gamesSpent: checkpoint.gamesSpent + totalGames,
      lineages: { ...checkpoint.lineages, [loserSide]: updatedLineage },
      pendingGeneration: null,
      nextBlock: checkpoint.nextBlock + 1,
    },
  };
}

/**
 * Drives an adaptive run from `options.checkpoint` until its budget no longer
 * affords the next whole block or the next whole generation's screening,
 * returning the final checkpoint. Throws `ExperimentStopped` (never returns
 * one) when `options.shouldStop` trips mid-phase — see this file's own
 * docstring for the exact resume contract that follows from that.
 */
export async function runAdaptiveExperiment(
  options: RunAdaptiveExperimentOptions,
): Promise<AdaptiveCheckpoint> {
  let checkpoint = options.checkpoint;
  for (;;) {
    const step =
      checkpoint.pendingGeneration === null
        ? await playBlock(options, checkpoint)
        : await processGeneration(options, checkpoint);
    if (!step.scheduled) return step.checkpoint;
    checkpoint = step.checkpoint;
  }
}
