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

/** Where an adaptive run really lands: keyed on the experiment ID, not the job ID. */
async function runDirectory(experimentId: string): Promise<string> {
  return unwrap(
    await resolveResultLocation(catalog.roots, { rootId: 'local', directory: experimentId }),
  );
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
    expect(job.execution?.location).toEqual({ rootId: 'local', directory: config.id });

    const directory = await runDirectory(config.id);
    // `RAW_DOCUMENT` is a local, unexported constant in `job-runner.ts`; its
    // literal name is restated here rather than imported.
    const raw = JSON.parse(await readFile(join(directory, 'adaptive-raw.json'), 'utf8')) as {
      experimentId: string;
    };
    const checkpoint = JSON.parse(
      await readFile(join(directory, 'adaptive-checkpoint.json'), 'utf8'),
    ) as { experimentId: string };
    const result = JSON.parse(
      await readFile(join(directory, 'adaptive-result.json'), 'utf8'),
    ) as { experimentId: string };
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

    const reader = new AdaptiveResultReader({ roots: catalog.roots, resultRootId: 'local' });
    const summary = await reader.readSummary(config.id);
    expect(isOk(summary)).toBe(true);
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
    const { jobId, config } = await seedAdaptiveJob({ id: 'adaptive-obstructed', ...FAST_BUDGET });
    const directory = await runDirectory(config.id);
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
    const { jobId, config } = await seedAdaptiveJob({ id: 'adaptive-pause', ...FAST_BUDGET });
    const runner = makeRunner();
    const control = new JobStopControl();
    const matchesPath = experimentPaths(await runDirectory(config.id)).matches;

    const running = runner.run(jobId, { workers: 2, control });

    for (let waited = 0; waited < 10_000; waited += 25) {
      if ((await countCommittedRecords(matchesPath)) >= 1) break;
      await delay(25);
    }
    // The same two-step `JobQueue#pause` performs: the lifecycle action
    // first, then the switch a run in flight actually observes.
    unwrap(await catalog.store.applyJobAction({ jobId, action: 'pause' }));
    control.request('pause');

    const outcome = unwrap(await running);
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
  }, 120_000);
});
