import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { generatePopulation } from '@tcg/deck-generator';
import { aggregate } from './analysis/aggregate.js';
import { experimentConfigSchema } from './config.js';
import { runExperiment } from './experiment.js';
import { MatchStore } from './reporting/match-store.js';
import { experimentPaths } from './reporting/sinks.js';
import { runBatch, type RunBatchOptions } from './run-batch.js';
import { buildSchedule } from './schedule.js';
import { ExperimentStopped, isExperimentStopped } from './stop.js';
import {
  AGGRESSIVE_PILOT,
  FAST_LIMITS,
  NO_RETENTION,
  VALUE_PILOT,
  tinyEnvironment,
} from './test-fixtures.js';

/**
 * Asking a run in flight to stop (M08.5).
 *
 * The contract has three halves and each of them is a claim about evidence
 * rather than about control flow:
 *
 * - **A stop stops dispatch, not a match.** Every match that had started
 *   finishes and its record is committed, so the stream on disk holds only whole
 *   matches played under this configuration.
 * - **Nothing is lost and nothing is doubled.** Resuming after a stop plays
 *   exactly the matches the stop prevented, and the result is the result an
 *   uninterrupted run would have produced.
 * - **A stopped run is not a finished one.** It unwinds with
 *   `ExperimentStopped`, which is what keeps `runExperiment` from writing a
 *   manifest, a summary and a report over half a schedule.
 *
 * Real matches throughout, in both the sequential and the worker-pool paths,
 * because the two hand out work in completely different ways and only one of
 * them can be reasoned about by reading the loop.
 */

const roots: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'tcg-stop-'));
  roots.push(dir);
  return dir;
}

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

const env = tinyEnvironment();
const decks = generatePopulation(env, 'stop-pop', 3).decks;
const CONFIG_HASH = 'stop-config-hash';

function schedule(games = 1) {
  return buildSchedule({
    experimentId: 'stop',
    experimentSeed: 'stop-seed',
    environmentId: env.id,
    decks,
    pilots: [VALUE_PILOT, AGGRESSIVE_PILOT],
    pilotPairing: 'mirror',
    playerCount: 2,
    gamesPerPairing: games,
    mirrorSeats: true,
    schedule: 'round_robin',
    sampledPairings: 100,
  });
}

function batchStore(root: string | null, resume = false): MatchStore {
  return new MatchStore(root, {
    experimentId: 'stop',
    experimentKind: 'batch',
    configHash: CONFIG_HASH,
    resume,
  });
}

async function run(overrides: Partial<RunBatchOptions> = {}) {
  return runBatch({
    experimentId: 'stop',
    experimentKind: 'batch',
    configHash: CONFIG_HASH,
    arm: null,
    environment: env,
    decks,
    pilots: [VALUE_PILOT, AGGRESSIVE_PILOT],
    schedule: schedule(),
    limits: FAST_LIMITS,
    retention: NO_RETENTION,
    workers: 1,
    failFast: false,
    sink: null,
    softwareCommit: null,
    ...overrides,
  });
}

/** A signal that carries on for `after` dispatches and then stops for good. */
function stopAfter(after: number): { signal: () => string | null; asked: () => number } {
  let asked = 0;
  return {
    signal: () => {
      asked += 1;
      return asked > after ? 'pause' : null;
    },
    asked: () => asked,
  };
}

describe('a stop stops dispatch, not a match', () => {
  it('commits every match that had started, and plays no more', async () => {
    const store = batchStore(tempDir());
    const plan = schedule();
    expect(plan.length).toBeGreaterThan(2);

    await expect(
      run({ sink: store, shouldStop: stopAfter(2).signal, workers: 1 }),
    ).rejects.toBeInstanceOf(ExperimentStopped);

    // Two dispatches were allowed, so two whole matches are on disk. The third
    // ask is the one that stopped it, and nothing was handed out afterwards.
    expect(store.all()).toHaveLength(2);
    expect(store.all().every((record) => record.termination !== undefined)).toBe(true);
  });

  it('carries the reason and the count it stopped at', async () => {
    const store = batchStore(tempDir());
    let thrown: unknown;
    try {
      await run({ sink: store, shouldStop: stopAfter(1).signal });
    } catch (error) {
      thrown = error;
    }
    expect(isExperimentStopped(thrown)).toBe(true);
    const stopped = thrown as ExperimentStopped;
    expect(stopped.reason).toBe('pause');
    expect(stopped.completedThisAttempt).toBe(1);
    expect(stopped.name).toBe('ExperimentStopped');
    expect(stopped.message).toContain('asked to');
  });

  it('plays nothing at all when the stop is already asked for', async () => {
    const store = batchStore(tempDir());
    await expect(run({ sink: store, shouldStop: () => 'cancel' })).rejects.toBeInstanceOf(
      ExperimentStopped,
    );
    expect(store.all()).toHaveLength(0);
  });

  it('does the same across worker threads, where dispatch is not a loop', async () => {
    // The pool hands jobs out on demand from a message handler rather than from
    // a `for`, so its stop is a different piece of code with the same promise:
    // in-flight matches are delivered to `onResult` and committed, and no
    // further job is posted to a thread.
    const store = batchStore(tempDir());
    await expect(
      run({ sink: store, shouldStop: stopAfter(2).signal, workers: 3 }),
    ).rejects.toBeInstanceOf(ExperimentStopped);

    const committed = store.all();
    expect(committed.length).toBeGreaterThanOrEqual(2);
    expect(committed.length).toBeLessThan(schedule().length);
    expect(new Set(committed.map((record) => record.matchId)).size).toBe(committed.length);
  });

  it('never asks the signal once the whole schedule has been handed out', async () => {
    // A run that played everything it had is *complete*, and a signal that
    // happened to trip on the last dispatch must not turn it into a stop. The
    // dispatch loops check "is there more work" before they check the signal.
    const counter = stopAfter(1_000);
    const outcome = await run({ shouldStop: counter.signal });
    expect(outcome.records).toHaveLength(schedule().length);
    expect(counter.asked()).toBe(schedule().length);
  });

  it('is not asked at all when no signal is supplied', async () => {
    // Absent is not the same as a signal that always says `null`: with no signal
    // there is no check, so a caller that does not pass one runs the code path
    // it always ran.
    const outcome = await run();
    expect(outcome.records).toHaveLength(schedule().length);
  });
});

describe('a stopped run resumes into the run it would have been', () => {
  it('plays exactly the matches the stop prevented, and doubles none', async () => {
    const root = tempDir();
    const first = batchStore(root);
    await expect(run({ sink: first, shouldStop: stopAfter(2).signal })).rejects.toBeInstanceOf(
      ExperimentStopped,
    );
    const afterStop = first.all().length;
    expect(afterStop).toBe(2);

    const second = batchStore(root, true);
    const resumed = await run({ sink: second });
    expect(resumed.skippedByResume).toBe(afterStop);

    const all = second.all();
    expect(all).toHaveLength(schedule().length);
    expect(new Set(all.map((record) => record.matchId)).size).toBe(all.length);
  });

  it('aggregates to the same numbers an uninterrupted run does', async () => {
    const interruptedRoot = tempDir();
    const first = batchStore(interruptedRoot);
    await expect(run({ sink: first, shouldStop: stopAfter(2).signal })).rejects.toBeInstanceOf(
      ExperimentStopped,
    );
    const resumedStore = batchStore(interruptedRoot, true);
    await run({ sink: resumedStore });

    const straight = batchStore(tempDir());
    await run({ sink: straight });

    expect(JSON.stringify(aggregate(resumedStore.all()))).toBe(
      JSON.stringify(aggregate(straight.all())),
    );
  });

  it('leaves the stream and its header exactly where they are', async () => {
    // "Cancel preserves inspectable partial output" is a property of nothing
    // removing anything, so this checks the files rather than the behaviour.
    const root = tempDir();
    const store = batchStore(root);
    await expect(run({ sink: store, shouldStop: stopAfter(1).signal })).rejects.toBeInstanceOf(
      ExperimentStopped,
    );
    // No flush here on purpose: a stopped run puts its own records on disk,
    // because it never reaches the write-up that would otherwise have done it.
    const paths = experimentPaths(root);
    expect(existsSync(paths.matches)).toBe(true);
    expect(existsSync(paths.matchesHeader)).toBe(true);
    const header = JSON.parse(readFileSync(paths.matchesHeader, 'utf8')) as {
      configHash: string;
    };
    expect(header.configHash).toBe(CONFIG_HASH);
    expect(readFileSync(paths.matches, 'utf8').trimEnd().split('\n')).toHaveLength(1);
  });
});

describe('a stopped experiment is not a finished one', () => {
  /** The same small prototype batch `experiment.test.ts` uses, at four matches. */
  const stoppableConfig = () =>
    experimentConfigSchema.parse({
      schemaVersion: 1,
      kind: 'batch',
      id: 'stoppable_batch',
      label: 'Stoppable batch',
      seed: 'stop-fixture-seed',
      output: 'results',
      playerCount: 2,
      pilots: [{ id: 'value' }],
      pilotPairing: 'mirror',
      environment: {
        id: 'fixture_env',
        allowCardIds: [
          'prototype_drone',
          'prototype_scout',
          'prototype_guard',
          'trench_guard',
          'unstable_construct',
          'surveyors_lens',
          'energy_font',
          'field_survey',
          'prototype_commander_blue',
          'prototype_commander_red',
        ],
        deckFormat: { deckSize: 12, copyLimit: 2 },
      },
      limits: { maxTurns: 80 },
      retention: { replaySampleRate: 0 },
      workers: 1,
      decks: { kind: 'generated', count: 3 },
      gamesPerPairing: 2,
      mirrorSeats: true,
    });

  it('writes no manifest, no summary and no report over a partial schedule', async () => {
    // The whole reason a stop unwinds rather than returning. `finish()` is what
    // writes an experiment up, and a run that stopped has nothing to write up:
    // ADR 0012 makes the directory the deliverable, and a report over half a
    // schedule would be a deliverable that is wrong.
    const root = tempDir();
    await expect(
      runExperiment(stoppableConfig(), {
        outputDir: root,
        softwareCommit: 'test-commit',
        shouldStop: stopAfter(1).signal,
      }),
    ).rejects.toBeInstanceOf(ExperimentStopped);

    const paths = experimentPaths(root);
    expect(existsSync(paths.manifest)).toBe(false);
    expect(existsSync(paths.summary)).toBe(false);
    expect(existsSync(paths.report)).toBe(false);

    // What it did play is on disk, whole, and under this configuration's header.
    expect(existsSync(paths.matches)).toBe(true);
    expect(readFileSync(paths.matches, 'utf8').trimEnd().split('\n')).toHaveLength(1);
  }, 120_000);

  it('resumes into the same directory and writes the run up once it finishes', async () => {
    const root = tempDir();
    await expect(
      runExperiment(stoppableConfig(), {
        outputDir: root,
        softwareCommit: 'test-commit',
        shouldStop: stopAfter(1).signal,
      }),
    ).rejects.toBeInstanceOf(ExperimentStopped);

    const finished = await runExperiment(stoppableConfig(), {
      outputDir: root,
      softwareCommit: 'test-commit',
      resume: true,
    });

    expect(finished.resumedMatches).toBe(1);
    expect(existsSync(experimentPaths(root).manifest)).toBe(true);
    expect(existsSync(experimentPaths(root).report)).toBe(true);
    expect(new Set(finished.records.map((record) => record.matchId)).size).toBe(
      finished.records.length,
    );

    const straight = tempDir();
    const uninterrupted = await runExperiment(stoppableConfig(), {
      outputDir: straight,
      softwareCommit: 'test-commit',
    });
    expect(JSON.stringify(aggregate(finished.records))).toBe(
      JSON.stringify(aggregate(uninterrupted.records)),
    );
  }, 120_000);
});
