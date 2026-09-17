import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { looksLikeFilesystemPath, type JobId } from '@tcg/admin-contracts';
import { isErr, isOk, unwrap } from '@tcg/shared';
import { experimentPaths, type AdaptiveConfig } from '@tcg/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveResultLocation } from '../catalog/roots.js';
import {
  makeTestCatalog,
  testAdaptiveConfig,
  testAdaptiveWorkloadEstimate,
  type TestCatalog,
} from '../catalog/test-catalog.js';
import { AdaptiveResultReader } from '../service/adaptive-results.js';
import { JobStopControl } from './control.js';
import { ExperimentRunner, type ExperimentRunnerOptions } from './job-runner.js';
import { countCommittedRecords, readCanonicalProgress } from './progress.js';

/**
 * The adaptive counterpart to `job-runner.test.ts` (M08.R4): dispatch and
 * lifecycle for the `adaptive_counter` job kind, which has no injectable
 * `runExperiment` seam and so is exercised end-to-end against the real
 * simulator, at the smallest budget that still plays a real block and a real
 * generation of screening (`apps/simulator/src/adaptive/run.test.ts`'s own
 * `baseConfig`).
 *
 * `JobQueue` is not used here: `#nextStartable` reads a job's configuration
 * through `readJobConfig`, which is the batch-only `ExperimentConfig` reader,
 * unconditionally for every queued job. Pointed at an adaptive job's stored
 * `AdaptiveConfig`, it refuses on shape, so `JobQueue` cannot select or start
 * an adaptive job today — that wiring is M08.R6's ("Adaptive builder and
 * queue integration"), not this slice's. The "no second owner" and "stops at
 * a safe checkpoint boundary" behaviors are therefore proven directly against
 * `ExperimentRunner`, which does not depend on the queue at all.
 */

let catalog: TestCatalog;

beforeEach(async () => {
  catalog = await makeTestCatalog();
});

afterEach(async () => {
  await catalog.dispose();
});

/** A queued job holding a real, validated Adaptive Counter configuration. */
async function seedAdaptiveJob(
  overrides: Parameters<typeof testAdaptiveConfig>[0] = {},
): Promise<{ readonly jobId: JobId; readonly config: AdaptiveConfig }> {
  const batch = unwrap(await catalog.store.createBatch({ label: 'Adaptive Wave' }));
  const config = testAdaptiveConfig(overrides);
  const job = unwrap(
    await catalog.store.createAdaptiveJob({
      batchId: batch.batchId,
      label: 'Adaptive Counter smoke',
      purpose: 'exploration',
      sourceClasses: ['ai', 'precon'],
      config,
      workloadEstimate: testAdaptiveWorkloadEstimate(config),
    }),
  );
  return { jobId: job.jobId, config };
}

/** The smallest budget that plays a real block and a real generation of screening, then stops cleanly. */
const FAST_BUDGET = {
  totalLearningBudget: 6,
  blockSize: 1,
  mirrorSeats: true,
  candidateCount: 2,
  finalValidationGames: 1,
} as const;

/** Where an adaptive run really lands: keyed on the job ID (M08.R16), not the experiment ID. */
async function runDirectory(jobId: JobId): Promise<string> {
  return unwrap(await resolveResultLocation(catalog.roots, { rootId: 'local', directory: jobId }));
}

function makeRunner(options: Partial<ExperimentRunnerOptions> = {}): ExperimentRunner {
  return new ExperimentRunner({
    store: catalog.store,
    roots: catalog.roots,
    resultRootId: 'local',
    pollEveryMs: 20,
    ...options,
  });
}

const delay = (milliseconds: number): Promise<void> =>
  new Promise((settle) => setTimeout(settle, milliseconds));

describe('a real adaptive run, dispatched and indexed from what it wrote', () => {
  it('completes, writes no manifest identity, and reports the canonical documents', async () => {
    const { jobId, config } = await seedAdaptiveJob({ id: 'adaptive-fast', ...FAST_BUDGET });
    const outcome = unwrap(await makeRunner().run(jobId));

    expect(outcome.status).toBe('completed');
    expect(outcome.failure).toBeNull();
    expect(outcome.identity).toBeNull();

    const job = unwrap(await catalog.store.readJob(jobId));
    expect(job.status).toBe('completed');
    expect(job.result).toBeNull();
    expect(job.execution?.location).toEqual({ rootId: 'local', directory: jobId });

    const directory = await runDirectory(jobId);
    // `RAW_DOCUMENT` is a local, unexported constant in `job-runner.ts`; its
    // literal name is restated here rather than imported.
    const raw = JSON.parse(await readFile(join(directory, 'adaptive-raw.json'), 'utf8')) as {
      experimentId: string;
    };
    const checkpoint = JSON.parse(
      await readFile(join(directory, 'adaptive-checkpoint.json'), 'utf8'),
    ) as { experimentId: string };
    const result = JSON.parse(await readFile(join(directory, 'adaptive-result.json'), 'utf8')) as {
      experimentId: string;
    };
    expect(raw.experimentId).toBe(config.id);
    expect(checkpoint.experimentId).toBe(config.id);
    expect(result.experimentId).toBe(config.id);

    const reading = await readCanonicalProgress(directory);
    expect(outcome.progress.completedMatches).toBe(reading.completedMatches);
    // `finalValidationGames` is played per seat orientation
    // (`validate.ts`'s own doc comment), so a mirrored run doubles it.
    expect(outcome.progress.scheduledMatches).toBe(
      config.totalLearningBudget + config.finalValidationGames * (config.mirrorSeats ? 2 : 1),
    );
    expect(outcome.progress.scheduledIsBound).toBe(true);
    expect(outcome.progress.stage?.stageId).toMatch(/^gen-\d+-(pending|active)$/);
    expect(outcome.progress.stage?.total).toBeNull();
  }, 120_000);

  it('resolves to the same directory and documents the adaptive result reader already resolves', async () => {
    const { jobId, config } = await seedAdaptiveJob({ id: 'adaptive-provenance', ...FAST_BUDGET });
    unwrap(await makeRunner().run(jobId));

    const reader = new AdaptiveResultReader({
      roots: catalog.roots,
      resultRootId: 'local',
      store: catalog.store,
    });
    const byJob = await reader.readSummary({ jobId, experimentId: null });
    expect(isOk(byJob)).toBe(true);

    const byExperiment = await reader.readSummary({ jobId: null, experimentId: config.id });
    expect(isOk(byExperiment)).toBe(true);
  }, 120_000);
});

describe('two queued jobs that share one experiment ID resolve to independent output (M08.R16)', () => {
  it('never lets a later job read or overwrite an earlier one’s directory, sequentially or concurrently', async () => {
    const shared = { id: 'adaptive-shared-experiment', ...FAST_BUDGET };
    const first = await seedAdaptiveJob(shared);
    const second = await seedAdaptiveJob(shared);
    expect(first.jobId).not.toBe(second.jobId);

    const [firstOutcome, secondOutcome] = await Promise.all([
      makeRunner().run(first.jobId),
      makeRunner().run(second.jobId),
    ]);
    unwrap(firstOutcome);
    unwrap(secondOutcome);

    const firstDirectory = await runDirectory(first.jobId);
    const secondDirectory = await runDirectory(second.jobId);
    expect(firstDirectory).not.toBe(secondDirectory);

    const firstJob = unwrap(await catalog.store.readJob(first.jobId));
    const secondJob = unwrap(await catalog.store.readJob(second.jobId));
    expect(firstJob.execution?.location).toEqual({ rootId: 'local', directory: first.jobId });
    expect(secondJob.execution?.location).toEqual({ rootId: 'local', directory: second.jobId });
    expect(firstJob.status).toBe('completed');
    expect(secondJob.status).toBe('completed');

    const reader = new AdaptiveResultReader({
      roots: catalog.roots,
      resultRootId: 'local',
      store: catalog.store,
    });
    const ambiguous = await reader.readSummary({ jobId: null, experimentId: shared.id });
    expect(isErr(ambiguous) && ambiguous.error[0]?.code).toBe('admin/ambiguous_experiment');

    const byFirstJob = unwrap(await reader.readSummary({ jobId: first.jobId, experimentId: null }));
    expect(byFirstJob.jobId).toBe(first.jobId);
    const bySecondJob = unwrap(
      await reader.readSummary({ jobId: second.jobId, experimentId: null }),
    );
    expect(bySecondJob.jobId).toBe(second.jobId);
  }, 120_000);
});

describe('starting an adaptive job twice', () => {
  it('refuses the second caller through the lifecycle table before recording any execution', async () => {
    const { jobId } = await seedAdaptiveJob({ id: 'adaptive-twice', ...FAST_BUDGET });
    unwrap(await catalog.store.applyJobAction({ jobId, action: 'start', cause: 'runner' }));

    const outcome = await makeRunner().run(jobId);
    expect(isErr(outcome) && outcome.error[0]?.code).toBe('admin/illegal_transition');
    expect(unwrap(await catalog.store.readJob(jobId)).execution).toBeNull();
  });
});

describe('an adaptive job cannot escape its configured result root', () => {
  it('refuses before playing anything, and never accepts an arbitrary client path', async () => {
    const { jobId } = await seedAdaptiveJob({ id: 'adaptive-unsafe', ...FAST_BUDGET });
    const outcome = unwrap(await makeRunner({ resultRootId: 'not-configured' }).run(jobId));

    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.code).toBe('admin/unsafe_result_reference');
    expect(unwrap(await catalog.store.readJob(jobId)).status).toBe('failed');
  });
});

describe('the adaptive configuration a job holds cannot drift out from under it', () => {
  it('refuses when the stored configuration no longer matches the recorded address', async () => {
    const { jobId, config } = await seedAdaptiveJob({ id: 'adaptive-drift', ...FAST_BUDGET });
    await writeFile(
      join(catalog.catalogRoot, 'configs', `${jobId}.json`),
      JSON.stringify(
        testAdaptiveConfig({ ...FAST_BUDGET, id: config.id, seed: 'a-different-seed' }),
      ),
      'utf8',
    );

    const outcome = unwrap(await makeRunner().run(jobId));
    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.code).toBe('admin/run_failed');
    expect(outcome.failure?.path).toBe('spec.configHash');
  });
});

describe('an adaptive failure says what went wrong without saying where', () => {
  it('sanitizes a real filesystem error raised while opening the run', async () => {
    const { jobId } = await seedAdaptiveJob({ id: 'adaptive-obstructed', ...FAST_BUDGET });
    const directory = await runDirectory(jobId);
    // A plain file where the run needs a directory: `MatchStore`'s writer
    // throws a real fs error naming this exact path.
    await mkdir(dirname(directory), { recursive: true });
    await writeFile(directory, 'obstruction', 'utf8');

    const outcome = unwrap(await makeRunner().run(jobId));
    const failure = outcome.failure;

    expect(outcome.status).toBe('failed');
    expect(failure?.code).toBe('admin/run_failed');
    for (const token of (failure?.message ?? '').split(/\s+/)) {
      expect(`${token}: ${String(looksLikeFilesystemPath(token))}`).toBe(`${token}: false`);
    }
    for (const value of Object.values(failure?.context ?? {})) {
      expect(looksLikeFilesystemPath(String(value))).toBe(false);
    }
  });
});

describe('a corrupted raw-evidence document fails the job instead of crashing the runner', () => {
  it('resolves run() to a failed outcome rather than throwing out of it', async () => {
    const { jobId } = await seedAdaptiveJob({ id: 'adaptive-corrupt-raw', ...FAST_BUDGET });
    const directory = await runDirectory(jobId);
    // `#loadOrCreateAdaptiveRaw` runs after `#prepareAdaptive` succeeds, so a
    // fresh directory with only a corrupted `adaptive-raw.json` reproduces a
    // crash mid-attempt (e.g. a prior process killed while writing it) rather
    // than an obstruction `#prepareAdaptive` itself would already catch.
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'adaptive-raw.json'), '{not valid json', 'utf8');

    const outcome = unwrap(await makeRunner().run(jobId));

    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.code).toBe('admin/run_failed');
    expect(unwrap(await catalog.store.readJob(jobId)).status).toBe('failed');
  });
});

describe('a real adaptive run, paused and resumed across worker threads', () => {
  it('stops at a safe checkpoint boundary under a concurrent pause, and resume finishes it without a second owner', async () => {
    // No stand-in: a real Adaptive Counter run across two worker threads,
    // paused once it has shown it played something. The same technique
    // `queue.test.ts`'s own `'realpause'` test uses for a batch run — polling
    // the committed stream rather than a fixed delay — because with a
    // single worker the match loop never yields to the event loop between
    // matches, and a genuinely concurrent stop needs real worker dispatch.
    //
    // `cancelled` is terminal in the job lifecycle table (no outgoing row at
    // all), so a mid-run stop that is meant to be resumed has to be a pause,
    // not a cancel — `resume` only exists from `paused`/`interrupted`, and
    // `retry` only from `failed`.
    const { jobId } = await seedAdaptiveJob({ id: 'adaptive-pause', ...FAST_BUDGET });
    const runner = makeRunner();
    const control = new JobStopControl();
    const matchesPath = experimentPaths(await runDirectory(jobId)).matches;

    const running = runner.run(jobId, { workers: 2, control });

    for (let waited = 0; waited < 10_000; waited += 25) {
      if ((await countCommittedRecords(matchesPath)) >= 1) break;
      await delay(25);
    }
    // The same two-step `JobQueue#pause` performs: the lifecycle action
    // first, then the switch a run in flight actually observes. FAST_BUDGET's
    // whole remaining run is only a handful of games, so on a fast or lightly
    // loaded machine it can finish before this lands — the store then refuses
    // `pause` from `completed`. That race loss is accepted the same way the
    // sibling "paused exactly before final result publication" test accepts
    // its own: it is not what this test means to exercise, but it is not a
    // defect either.
    const pauseResult = await catalog.store.applyJobAction({ jobId, action: 'pause' });
    const pauseLostTheRace =
      isErr(pauseResult) && pauseResult.error[0]?.code === 'admin/illegal_transition';
    if (!pauseLostTheRace) unwrap(pauseResult);
    control.request('pause');

    const outcome = unwrap(await running);

    if (pauseLostTheRace) {
      expect(outcome.status).toBe('completed');
      return;
    }

    expect(outcome.status).toBe('stopped');
    expect(outcome.stopReason).toBe('pause');
    expect(outcome.failure).toBeNull();

    const paused = unwrap(await catalog.store.readJob(jobId));
    expect(paused.status).toBe('paused');
    const partial = await countCommittedRecords(matchesPath);
    expect(partial).toBeGreaterThanOrEqual(1);
    expect(paused.progress.completedMatches).toBe(partial);

    unwrap(await catalog.store.applyJobAction({ jobId, action: 'resume' }));
    const resumedOutcome = unwrap(await runner.run(jobId));

    expect(resumedOutcome.status).toBe('completed');
    const finished = unwrap(await catalog.store.readJob(jobId));
    expect(finished.execution).toMatchObject({ attempts: 2, resumedMatches: partial });

    // M08.R5: the pause landed mid-phase, so the interrupted attempt's own
    // raw event (if it had produced one yet) and the resumed attempt's
    // re-decision of that same phase must have collapsed onto one entry per
    // `block`, never a duplicate, across the two attempts' writes to the
    // same `adaptive-raw.json`.
    const directory = await runDirectory(jobId);
    const raw = JSON.parse(await readFile(join(directory, 'adaptive-raw.json'), 'utf8')) as {
      series: { block: number }[];
      generations: { block: number }[];
      screeningRounds: { block: number }[];
    };
    for (const kind of ['series', 'generations', 'screeningRounds'] as const) {
      const blocks = raw[kind].map((record) => record.block);
      expect(new Set(blocks).size).toBe(blocks.length);
    }
  }, 120_000);
});

describe('a real adaptive run, paused exactly before final result publication', () => {
  it('keeps the learning series’ raw evidence and checkpoint durable, with no result yet, until a resumed attempt publishes it', async () => {
    // Pausing once the on-disk checkpoint itself shows the learning series
    // fully decided (`pendingGeneration` reset to null by the last
    // generation's promotion, `gamesSpent` at the full learning budget)
    // lands the stop inside (or immediately before) the frozen-seed
    // validation stage — strictly after the learning series' own raw
    // evidence and checkpoint are durable (M08.R5's third fault-injection
    // point), but strictly before this run's final result is built and
    // written (its fourth). Total *committed match records* is not a safe
    // proxy for that: FAST_BUDGET's own screening games share the same
    // match log, so their count can cross `totalLearningBudget` while a
    // generation is still being screened — `pendingGeneration` is exactly
    // the property under test, so wait on it directly instead of
    // approximating it from an unrelated count.
    const { jobId, config } = await seedAdaptiveJob({
      id: 'adaptive-pause-before-result',
      ...FAST_BUDGET,
    });
    const runner = makeRunner();
    const control = new JobStopControl();
    const directory = await runDirectory(jobId);
    const matchesPath = experimentPaths(directory).matches;
    const checkpointPath = join(directory, 'adaptive-checkpoint.json');

    const running = runner.run(jobId, { workers: 2, control });

    // Poll for the terminal checkpoint rather than waiting a fixed budget:
    // the screening phase this waits out is real simulation work, and a
    // fixed cap that is generous locally can still be too short on a slower
    // or more heavily loaded CI runner. Racing each tick against `running`
    // itself (instead of falling through to pause on a timeout regardless)
    // means a run that finishes before the terminal state ever appears is
    // handled by the same "pause lost the race" branch below, never by
    // pausing mid-screening against a stale, not-yet-terminal checkpoint.
    let runFinished = false;
    running
      .finally(() => {
        runFinished = true;
      })
      .catch(() => {
        // Observed via `outcome`/`unwrap(await running)` below.
      });

    let observedTerminal = false;
    while (!runFinished) {
      try {
        const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
          pendingGeneration: unknown;
          gamesSpent: number;
        };
        if (
          checkpoint.pendingGeneration === null &&
          checkpoint.gamesSpent >= config.totalLearningBudget
        ) {
          observedTerminal = true;
          break;
        }
      } catch {
        // Not written yet — keep polling.
      }
      await delay(10);
    }

    if (observedTerminal) {
      const pauseResult = await catalog.store.applyJobAction({ jobId, action: 'pause' });
      const pauseLostTheRace =
        isErr(pauseResult) && pauseResult.error[0]?.code === 'admin/illegal_transition';
      if (!pauseLostTheRace) unwrap(pauseResult);
      control.request('pause');
    }

    const outcome = unwrap(await running);

    if (outcome.status === 'stopped') {
      const checkpoint = JSON.parse(await readFile(checkpointPath, 'utf8')) as {
        pendingGeneration: unknown;
        gamesSpent: number;
        nextBlock: number;
      };
      // The learning series is fully decided (promotion settled) before
      // validation ever starts, so a stop inside validation always finds it
      // this way on disk.
      expect(checkpoint.pendingGeneration).toBeNull();
      await expect(readFile(join(directory, 'adaptive-result.json'), 'utf8')).rejects.toThrow();

      unwrap(await catalog.store.applyJobAction({ jobId, action: 'resume' }));
      const resumedOutcome = unwrap(await runner.run(jobId));
      expect(resumedOutcome.status).toBe('completed');
    } else {
      // The run finished on its own before the terminal checkpoint was ever
      // observed (or before a since-observed pause landed) — the property
      // under test (a durable, complete result) still holds, just without
      // exercising the resume path.
      expect(outcome.status).toBe('completed');
    }

    const result = JSON.parse(await readFile(join(directory, 'adaptive-result.json'), 'utf8')) as {
      experimentId: string;
    };
    expect(result.experimentId).toBe(config.id);

    const matchLines = (await readFile(matchesPath, 'utf8')).trim().split('\n');
    const matchIds = matchLines.map((line) => (JSON.parse(line) as { matchId: string }).matchId);
    expect(matchIds).toHaveLength(
      config.totalLearningBudget + config.finalValidationGames * (config.mirrorSeats ? 2 : 1),
    );
    expect(new Set(matchIds).size).toBe(matchIds.length);
  }, 120_000);
});
