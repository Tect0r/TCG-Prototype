import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { PilotSpec } from '@tcg/bot-interface';
import type { Environment } from './environment.js';
import { buildSchedule, type ScheduledMatch, type ScheduleOptions } from './schedule.js';
import { runOne } from './run-one.js';
import { seededIndex } from './seed.js';
import type { MatchLimits } from './run-match.js';
import type { SimDeck } from './deck-search/deck.js';
import { JsonlWriter, ensureDir, readJsonl, writeJson } from './reporting/sinks.js';
import { matchRecordSchema, isAbnormal, type MatchRecord } from './telemetry/schema.js';
import { runJobsInPool } from './workers/pool.js';
import { workerSetupSchema, type WorkerJob } from './workers/protocol.js';

/**
 * Runs many independent matches (CLAUDE.md §13.7).
 *
 * Three properties are load bearing and are all consequences of the schedule
 * being decided up front:
 *
 * - **Resumable.** An interrupted run is restarted by regenerating the same
 *   schedule and skipping the match IDs already on disk. Nothing is re-run and
 *   nothing is duplicated.
 * - **Worker-count invariant.** Records are re-sorted by their stable order key
 *   before any aggregate is computed, so floating-point sums are added in the
 *   same order however the matches were distributed.
 * - **Streamed.** Records are appended to `matches.jsonl` as they finish, so a
 *   large experiment never has to fit in memory.
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
  readonly environment: Environment;
  readonly decks: readonly SimDeck[];
  readonly pilots: readonly PilotSpec[];
  readonly schedule: readonly ScheduledMatch[];
  readonly limits: MatchLimits;
  readonly retention: BatchRetention;
  readonly workers: number;
  readonly failFast: boolean;
  readonly softwareCommit?: string | null;
  /** Experiment directory. `null` keeps everything in memory (used by tests). */
  readonly outputDir: string | null;
  /** Skip matches already present in `matches.jsonl`. */
  readonly resume?: boolean;
  readonly onProgress?: (progress: BatchProgress) => void;
  /** How often to report progress, in completed matches. */
  readonly progressEvery?: number;
}

export interface BatchOutcome {
  /** Every record for this run, in canonical order key order. */
  readonly records: readonly MatchRecord[];
  readonly skippedByResume: number;
  /** Matches whose runner threw outright, as opposed to terminating abnormally. */
  readonly failures: readonly { readonly matchId: string; readonly message: string }[];
  /** Damaged JSONL lines found while resuming. */
  readonly recovered: readonly { readonly line: number; readonly reason: string }[];
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
  const paths = options.outputDir;
  const matchesPath = paths === null ? null : join(paths, 'matches.jsonl');

  let existing: readonly MatchRecord[] = [];
  let recovered: readonly { line: number; reason: string }[] = [];
  if (matchesPath !== null && options.resume) {
    const read = readJsonl(matchesPath, matchRecordSchema);
    existing = read.records;
    recovered = read.skipped;
  }
  const alreadyDone = new Set(existing.map((record) => record.matchId));

  const pending = options.schedule.filter((match) => !alreadyDone.has(match.matchId));
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

  const records: MatchRecord[] = [...existing];
  const failures: { matchId: string; message: string }[] = [];
  let abnormal = records.filter((record) => isAbnormal(record.termination)).length;
  let completed = 0;

  const writer =
    matchesPath === null
      ? null
      : new JsonlWriter(options.resume ? matchesPath : freshFile(matchesPath));
  if (paths !== null) ensureDir(join(paths, 'replays'));

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
      writer?.append(record);
      if (replay !== null && replay !== undefined && paths !== null) {
        writeJson(join(paths, 'replays', `${matchId}.json`), replay);
      }
    }
    if (completed % progressEvery === 0) report();
  };

  if (options.workers > 1 && jobs.length > 1) {
    const setup = workerSetupSchema.parse({
      experimentId: options.experimentId,
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
    });
  } else {
    for (const job of jobs) {
      try {
        const outcome = await runOne({
          experimentId: options.experimentId,
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

  writer?.flush();
  report();

  // Canonical order, always — this is what makes the aggregates independent of
  // the order results happened to arrive in.
  records.sort((left, right) => left.orderKey.localeCompare(right.orderKey));

  return {
    records,
    skippedByResume: alreadyDone.size,
    failures,
    recovered,
    elapsedMs: Date.now() - started,
  };
}

/** Starts a fresh `matches.jsonl`, so a non-resumed run never appends to an old one. */
function freshFile(path: string): string {
  ensureDir(dirname(path));
  writeFileSync(path, '', 'utf8');
  return path;
}

export function scheduleFor(options: ScheduleOptions): ScheduledMatch[] {
  return buildSchedule(options);
}
