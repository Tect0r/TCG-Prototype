import { join } from 'node:path';
import type { PilotSpec } from '@tcg/bot-interface';
import type { Environment } from './environment.js';
import { buildSchedule, type ScheduledMatch, type ScheduleOptions } from './schedule.js';
import { runOne } from './run-one.js';
import { seededIndex } from './seed.js';
import type { MatchLimits } from './run-match.js';
import type { SimDeck } from '@tcg/deck-generator';
import { ensureDir, writeJson } from './reporting/sinks.js';
import { compareRecords, type MatchSink } from './reporting/match-store.js';
import { isAbnormal, recordIdentity, type MatchRecord } from './telemetry/schema.js';
import { ExperimentStopped, type StopSignal } from './stop.js';
import { runJobsInPool } from './workers/pool.js';
import { workerSetupSchema, type WorkerJob } from './workers/protocol.js';

/**
 * Runs many independent matches (CLAUDE.md §13.7).
 *
 * Three properties are load bearing and are all consequences of the schedule
 * being decided up front:
 *
 * - **Resumable.** An interrupted run is restarted by regenerating the same
 *   schedule and skipping the identities already committed to the shared
 *   `matches.jsonl`. Nothing is re-run and nothing is duplicated.
 * - **Worker-count invariant.** Records are re-sorted by arm and stable order key
 *   before any aggregate is computed, so floating-point sums are added in the
 *   same order however the matches were distributed.
 * - **Streamed.** Records are appended as they finish, so a large experiment
 *   never has to fit in memory.
 *
 * The store is supplied by the caller rather than opened here, because every
 * experiment kind — including a search's generations and a comparison's two
 * arms — writes into one stream (PHASE4_HARDENING §7).
 */

export interface BatchRetention {
  readonly replaySampleRate: number;
  readonly keepLogs: boolean;
  readonly keepDecisions: boolean;
}

export interface BatchProgress {
  readonly completed: number;
  readonly total: number;
  readonly abnormal: number;
  readonly failed: number;
  readonly elapsedMs: number;
  readonly matchesPerSecond: number;
  readonly estimatedRemainingMs: number;
}

export interface RunBatchOptions {
  readonly experimentId: string;
  readonly experimentKind: MatchRecord['experimentKind'];
  readonly configHash: string;
  /** Arm label stamped on every record this batch produces. */
  readonly arm: string | null;
  readonly environment: Environment;
  readonly decks: readonly SimDeck[];
  readonly pilots: readonly PilotSpec[];
  readonly schedule: readonly ScheduledMatch[];
  readonly limits: MatchLimits;
  readonly retention: BatchRetention;
  readonly workers: number;
  readonly failFast: boolean;
  readonly softwareCommit?: string | null;
  /**
   * Where raw records are committed. `null` keeps this batch in memory only,
   * which is what an in-process test or a nested evaluation without its own
   * stream wants.
   */
  readonly sink?: MatchSink | null;
  /** Directory replays are written to. `null` writes none. */
  readonly replayDir?: string | null;
  readonly onProgress?: (progress: BatchProgress) => void;
  /** How often to report progress, in completed matches. */
  readonly progressEvery?: number;
  /**
   * Asked before each match is dispatched. A reason stops the batch (M08.5).
   *
   * Checked between matches and never inside one, so every record this batch
   * committed is a whole match played under this configuration — which is
   * exactly the set resume will skip. When it trips, the batch commits what it
   * has and then throws `ExperimentStopped`; `stop.ts` gives the two reasons
   * the answer is an exception rather than a flag on `BatchOutcome`.
   *
   * Absent by default, and absent is not the same as a signal that always says
   * `null`: with no signal there is no check at all, so a caller that does not
   * pass one runs the code path it always ran.
   */
  readonly shouldStop?: StopSignal;
}

export interface BatchOutcome {
  /** Every record produced *or resumed* for this batch, in canonical order. */
  readonly records: readonly MatchRecord[];
  /** Matches skipped because the stream already had them. */
  readonly skippedByResume: number;
  /** Matches whose runner threw outright, as opposed to terminating abnormally. */
  readonly failures: readonly { readonly matchId: string; readonly message: string }[];
  readonly elapsedMs: number;
}

/** Whether this match is in the replay sample. Derived from its ID, not a counter. */
export function shouldKeepReplay(matchId: string, sampleRate: number): boolean {
  if (sampleRate <= 0) return false;
  if (sampleRate === 1) return true;
  return seededIndex(`replay|${matchId}`, sampleRate) === 0;
}

export async function runBatch(options: RunBatchOptions): Promise<BatchOutcome> {
  const started = Date.now();
  const sink = options.sink ?? null;
  const replayDir = options.replayDir ?? null;

  const identityOf = (matchId: string): string => recordIdentity({ matchId, arm: options.arm });

  // Anything already committed to the stream under this arm is done. That is
  // the whole resume mechanism: the file on disk *is* the progress.
  const pending = options.schedule.filter(
    (match) => sink === null || !sink.has(identityOf(match.matchId)),
  );
  const skippedByResume = options.schedule.length - pending.length;

  const jobs: WorkerJob[] = pending.map((match) => ({
    matchId: match.matchId,
    orderKey: match.orderKey,
    deckPairId: match.deckPairId,
    variantKey: match.variantKey,
    gameIndex: match.gameIndex,
    orientation: match.orientation,
    seats: match.seats.map((seat) => ({ ...seat })),
    seeds: match.seeds,
    keepReplay: shouldKeepReplay(match.matchId, options.retention.replaySampleRate),
  }));

  const records: MatchRecord[] = [];
  const failures: { matchId: string; message: string }[] = [];
  let abnormal = 0;
  let completed = 0;

  // Remembered rather than re-asked, for the reason the pool gives: once a
  // batch has decided to stop, a signal that changed its mind must not be able
  // to hand out another match.
  let stoppedFor: string | null = null;
  const stopRequested = (): boolean => {
    if (options.shouldStop === undefined) return false;
    stoppedFor ??= options.shouldStop();
    return stoppedFor !== null;
  };

  if (replayDir !== null) ensureDir(replayDir);

  const progressEvery = options.progressEvery ?? 25;
  const report = (): void => {
    if (!options.onProgress) return;
    const elapsedMs = Date.now() - started;
    const rate = elapsedMs > 0 ? (completed / elapsedMs) * 1000 : 0;
    options.onProgress({
      completed,
      total: jobs.length,
      abnormal,
      failed: failures.length,
      elapsedMs,
      matchesPerSecond: rate,
      estimatedRemainingMs: rate > 0 ? ((jobs.length - completed) / rate) * 1000 : 0,
    });
  };

  const accept = (matchId: string, record: MatchRecord | null, replay: unknown, error?: string) => {
    completed += 1;
    if (record === null) {
      failures.push({ matchId, message: error ?? 'unknown failure' });
    } else {
      records.push(record);
      if (isAbnormal(record.termination)) abnormal += 1;
      sink?.append(record);
      if (replay !== null && replay !== undefined && replayDir !== null) {
        writeJson(join(replayDir, `${matchId}.json`), replay);
      }
    }
    if (completed % progressEvery === 0) report();
  };

  if (options.workers > 1 && jobs.length > 1) {
    const setup = workerSetupSchema.parse({
      experimentId: options.experimentId,
      experimentKind: options.experimentKind,
      configHash: options.configHash,
      arm: options.arm,
      environment: options.environment.config,
      decks: options.decks,
      pilots: options.pilots,
      limits: options.limits,
      retention: options.retention,
      softwareCommit: options.softwareCommit ?? null,
    });
    await runJobsInPool(jobs, {
      workers: options.workers,
      setup,
      onResult: (result) => {
        if (result.type === 'done') accept(result.matchId, result.record, result.replay);
        else accept(result.matchId, null, null, result.message);
      },
      ...(options.shouldStop === undefined
        ? {}
        : { shouldStop: () => (stopRequested() ? stoppedFor : null) }),
    });
  } else {
    for (const job of jobs) {
      if (stopRequested()) break;
      try {
        const outcome = await runOne({
          experimentId: options.experimentId,
          experimentKind: options.experimentKind,
          configHash: options.configHash,
          arm: options.arm,
          environment: options.environment,
          decks: options.decks,
          pilots: options.pilots,
          limits: options.limits,
          retention: options.retention,
          softwareCommit: options.softwareCommit ?? null,
          job,
        });
        accept(job.matchId, outcome.record, outcome.replay);
      } catch (error) {
        accept(job.matchId, null, null, error instanceof Error ? error.message : String(error));
      }
      if (options.failFast && (failures.length > 0 || abnormal > 0)) break;
    }
  }

  report();

  // Canonical order, always — this is what makes the aggregates independent of
  // the order results happened to arrive in.
  records.sort(compareRecords);

  // After the sort and after every `accept`, so the sink holds every record the
  // in-flight matches produced before anything unwinds. A stop that threw
  // earlier would lose exactly the matches it promised to keep — and the flush
  // is the same promise applied to the disk rather than to the array, because a
  // stopped run never reaches the write-up that would otherwise have done it.
  if (stoppedFor !== null) {
    sink?.flush?.();
    throw new ExperimentStopped(stoppedFor, completed);
  }

  return {
    records,
    skippedByResume,
    failures,
    elapsedMs: Date.now() - started,
  };
}

export function scheduleFor(options: ScheduleOptions): ScheduledMatch[] {
  return buildSchedule(options);
}
