import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { looksLikeFilesystemPath, type JobId, type Progress } from '@tcg/admin-contracts';
import { isErr, isOk, unwrap } from '@tcg/shared';
import { configHashOf, experimentPaths, type ExperimentOutcome } from '@tcg/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveResultLocation } from '../catalog/roots.js';
import { makeTestCatalog, testConfig, type TestCatalog } from '../catalog/test-catalog.js';
import {
  ExperimentRunner,
  type ExperimentRunnerOptions,
  type RunExperimentFn,
} from './job-runner.js';
import { readCanonicalProgress } from './progress.js';

/**
 * The bridge from one catalog job to one canonical experiment directory.
 *
 * The suite is deliberately split between two drivers, and the split is the
 * point rather than a convenience:
 *
 * - **The real `runExperiment`** proves the bridge produces a real run. One
 *   match, played for real, into a real directory, indexed from the manifest it
 *   really wrote. Anything mocked here would be proving the mock.
 * - **An injected `runExperiment`** proves what happens when a run *fails*, and
 *   what the poller sees while one is in flight. Both are branches that exist for
 *   events which should not happen, and the only honest way to reach them is
 *   deliberately — the same reason `FileCatalogStore` takes an injectable ID
 *   minter to test the duplicate-ID refusal.
 *
 * The seam cannot rot into a lie: `boundary.test.ts` asserts the default is the
 * simulator's own function and that no other module in the workspace can reach it.
 */

let catalog: TestCatalog;

beforeEach(async () => {
  catalog = await makeTestCatalog();
});

afterEach(async () => {
  await catalog.dispose();
});

/** A queued job holding a real, validated experiment configuration. */
async function seedJob(
  overrides: { readonly id?: string; readonly seed?: string } = {},
): Promise<JobId> {
  const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
  const job = unwrap(
    await catalog.store.createJob({
      batchId: batch.batchId,
      label: 'Precon smoke',
      purpose: 'exploration',
      sourceClasses: ['ai', 'precon'],
      config: testConfig(overrides),
    }),
  );
  return job.jobId;
}

/**
 * Where a job's run really lands, resolved the way the runner resolves it.
 *
 * Not `join(resultRoot, jobId)`: `resolveResultLocation` returns the **real**
 * path, which is the only comparison that sees a symlink — and on Windows a
 * temporary directory is frequently reached through one.
 */
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

/**
 * The runner never reads what `runExperiment` returns — it re-reads the
 * directory — so a stand-in has nothing meaningful to return, and saying so here
 * is cheaper than assembling an outcome nobody looks at.
 */
const NOTHING_READ = undefined as unknown as ExperimentOutcome;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((settle) => setTimeout(settle, milliseconds));

/** Appends `count` committed records to a run's stream, as the simulator would. */
async function appendRecords(directory: string, count: number): Promise<void> {
  await mkdir(directory, { recursive: true });
  const line = `${JSON.stringify({ matchId: 'm', filler: 'x'.repeat(40) })}\n`;
  await writeFile(experimentPaths(directory).matches, line.repeat(count), { flag: 'a' });
}

describe('one job maps to one canonical experiment directory', () => {
  it('names the directory after the job, so two jobs cannot collide on one', async () => {
    const seen: string[] = [];
    const record: RunExperimentFn = async (_config, options) => {
      seen.push(options?.outputDir ?? '');
      return NOTHING_READ;
    };
    const runner = makeRunner({ runExperiment: record });

    const first = await seedJob({ id: 'first-run' });
    const second = await seedJob({ id: 'second-run' });
    await runner.run(first);
    await runner.run(second);

    expect(seen).toEqual([await runDirectory(first), await runDirectory(second)]);
    expect(new Set(seen).size).toBe(2);
  });

  it('records the location on the document and never a path on the view', async () => {
    const runner = makeRunner({ runExperiment: async () => NOTHING_READ });
    const jobId = await seedJob();
    await runner.run(jobId);

    const job = unwrap(await catalog.store.readJob(jobId));
    expect(job.execution).toMatchObject({
      location: { rootId: 'local', directory: jobId },
      mode: 'in_process_workers',
      attempts: 1,
      resumedMatches: 0,
    });
  });

  it('reuses its own directory on a later attempt, even if the runner is reconfigured', async () => {
    // Resume identity is a property of the job, not of whatever root the process
    // happens to be configured with when somebody presses retry.
    const jobId = await seedJob();
    const seen: string[] = [];
    const record: RunExperimentFn = async (_config, options) => {
      seen.push(options?.outputDir ?? '');
      return NOTHING_READ;
    };

    await makeRunner({ runExperiment: record }).run(jobId);
    unwrap(await catalog.store.applyJobAction({ jobId, action: 'retry' }));
    // A second runner, told to write new runs somewhere else entirely.
    await makeRunner({ runExperiment: record, resultRootId: 'elsewhere' }).run(jobId);

    expect(new Set(seen).size).toBe(1);
    expect(unwrap(await catalog.store.readJob(jobId)).execution?.attempts).toBe(2);
  });

  it('refuses before playing anything when the location escapes its configured root', async () => {
    const runner = makeRunner({
      runExperiment: async () => {
        throw new Error('should never be reached');
      },
      resultRootId: 'not-configured',
    });
    const jobId = await seedJob();
    const outcome = unwrap(await runner.run(jobId));

    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.code).toBe('admin/unsafe_result_reference');
    expect(unwrap(await catalog.store.readJob(jobId)).status).toBe('failed');
  });
});

describe('a job runs for real, and is indexed from what it wrote', () => {
  it('plays the configuration, links the manifest, and completes', async () => {
    const jobId = await seedJob({ id: 'real-smoke' });
    const outcome = unwrap(await makeRunner().run(jobId));

    expect(outcome.status).toBe('completed');
    expect(outcome.failure).toBeNull();

    const job = unwrap(await catalog.store.readJob(jobId));
    expect(job.status).toBe('completed');
    expect(job.timestamps.completedAt).not.toBeNull();

    // The reference is the manifest's identity, read back rather than assumed.
    const directory = await runDirectory(jobId);
    const manifest = JSON.parse(
      await readFile(experimentPaths(directory).manifest, 'utf8'),
    ) as Record<string, unknown>;
    expect(job.result?.identity.experimentId).toBe(manifest.experimentId);
    expect(job.result?.identity.configHash).toBe(manifest.configHash);
    expect(job.result?.identity.manifestSchemaVersion).toBe(manifest.schemaVersion);
    expect(job.result?.location).toEqual({ rootId: 'local', directory: jobId });
  }, 120_000);

  it('reports a completed count the canonical stream and the manifest both agree with', async () => {
    const jobId = await seedJob({ id: 'counted-smoke' });
    const outcome = unwrap(await makeRunner().run(jobId));

    const directory = await runDirectory(jobId);
    const manifest = JSON.parse(await readFile(experimentPaths(directory).manifest, 'utf8')) as {
      readonly matches: number;
    };
    const reading = await readCanonicalProgress(directory);

    expect(outcome.progress.completedMatches).toBe(manifest.matches);
    expect(reading.completedMatches).toBe(manifest.matches);
    // And the denominator is M08.3's estimator, which counts a real schedule.
    expect(outcome.progress.scheduledMatches).toBe(manifest.matches);
    expect(outcome.progress.scheduledIsBound).toBe(false);
  }, 120_000);

  it('records the spec’s address before it runs, and the run agrees with it', async () => {
    const config = testConfig({ id: 'addressed' });
    const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
    const job = unwrap(
      await catalog.store.createJob({
        batchId: batch.batchId,
        label: 'addressed',
        purpose: 'exploration',
        sourceClasses: ['ai', 'precon'],
        config,
      }),
    );
    expect(job.status).toBe('queued');
    expect(job.spec).toEqual({
      experimentId: 'addressed',
      kind: 'batch',
      seed: 'fixture-seed',
      configHash: configHashOf(config),
      configSchemaVersion: 1,
    });

    const outcome = unwrap(await makeRunner().run(job.jobId));
    expect(outcome.identity?.configHash).toBe(job.spec.configHash);
  }, 120_000);
});

describe('starting a job twice', () => {
  it('refuses the second caller through the lifecycle table, and runs once', async () => {
    let calls = 0;
    const slow: RunExperimentFn = async () => {
      calls += 1;
      await delay(60);
      return NOTHING_READ;
    };
    const runner = makeRunner({ runExperiment: slow });
    const jobId = await seedJob();

    const [first, second] = await Promise.all([runner.run(jobId), runner.run(jobId)]);
    const refused = isErr(first) ? first : second;
    const accepted = isOk(first) ? first : second;

    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/illegal_transition');
    expect(isOk(accepted)).toBe(true);
    // The run itself happened exactly once, which is the claim. This stand-in
    // writes no manifest, so the accepted call ends in `failed` for its own
    // reason rather than for the refusal's.
    expect(calls).toBe(1);
    expect(unwrap(await catalog.store.readJob(jobId)).execution?.attempts).toBe(1);
  });

  it('refuses a job that has already finished, rather than replaying it', async () => {
    const runner = makeRunner({ runExperiment: async () => NOTHING_READ });
    const jobId = await seedJob();
    await runner.run(jobId);
    const again = await runner.run(jobId);
    expect(isErr(again) && again.error[0]?.code).toBe('admin/illegal_transition');
  });
});

describe('a run that falls over', () => {
  /** Writes two committed records and then throws, which is what a killed run leaves. */
  const failsPartway: RunExperimentFn = async (_config, options) => {
    await appendRecords(options?.outputDir ?? '', 2);
    throw new Error('the pilot pool ran out at C:\\runs\\job_x\\matches.jsonl');
  };

  it('fails the job with structured diagnostics rather than throwing', async () => {
    const jobId = await seedJob();
    const outcome = unwrap(await makeRunner({ runExperiment: failsPartway }).run(jobId));

    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.code).toBe('admin/run_failed');
    expect(unwrap(await catalog.store.readJob(jobId)).failure?.code).toBe('admin/run_failed');
  });

  it('says what went wrong without saying where', async () => {
    const jobId = await seedJob();
    const outcome = unwrap(await makeRunner({ runExperiment: failsPartway }).run(jobId));
    const failure = outcome.failure;

    expect(failure?.message).toContain('the pilot pool ran out');
    expect(failure?.message).toContain('<path>');
    for (const token of (failure?.message ?? '').split(/\s+/)) {
      expect(`${token}: ${String(looksLikeFilesystemPath(token))}`).toBe(`${token}: false`);
    }
    for (const value of Object.values(failure?.context ?? {})) {
      expect(looksLikeFilesystemPath(String(value))).toBe(false);
    }
  });

  it('leaves every partial record it wrote, and reports them as progress', async () => {
    const jobId = await seedJob();
    const outcome = unwrap(await makeRunner({ runExperiment: failsPartway }).run(jobId));

    const directory = await runDirectory(jobId);
    expect((await readCanonicalProgress(directory)).completedMatches).toBe(2);
    expect(outcome.progress.completedMatches).toBe(2);
    expect(unwrap(await catalog.store.readJob(jobId)).progress.completedMatches).toBe(2);
  });

  it('withholds the denominator when the stream contradicts an exact schedule', async () => {
    // This configuration schedules one match and the stand-in leaves two
    // committed records, which cannot both be true. `progressSchema` refuses
    // "two of one", and the answer is the third state it provides rather than a
    // number the evidence contradicts: the directory outranks the estimate.
    const jobId = await seedJob();
    const outcome = unwrap(await makeRunner({ runExperiment: failsPartway }).run(jobId));
    expect(outcome.progress.completedMatches).toBe(2);
    expect(outcome.progress.scheduledMatches).toBeNull();
    expect(outcome.progress.scheduledIsBound).toBe(false);
  });

  it('keeps the resume identity, so a retry continues rather than restarts', async () => {
    const jobId = await seedJob();
    await makeRunner({ runExperiment: failsPartway }).run(jobId);

    const failed = unwrap(await catalog.store.readJob(jobId));
    expect(failed.execution).toMatchObject({ attempts: 1, resumedMatches: 0 });

    unwrap(await catalog.store.applyJobAction({ jobId, action: 'retry' }));
    const resumed: { outputDir?: string; resume?: boolean }[] = [];
    const succeeds: RunExperimentFn = async (_config, options) => {
      resumed.push({ ...(options ?? {}) });
      return NOTHING_READ;
    };
    await makeRunner({ runExperiment: succeeds }).run(jobId);

    // Same directory, resuming, and the attempt knows what it inherited.
    expect(resumed[0]?.outputDir).toBe(await runDirectory(jobId));
    expect(resumed[0]?.resume).toBe(true);
    expect(unwrap(await catalog.store.readJob(jobId)).execution).toMatchObject({
      attempts: 2,
      resumedMatches: 2,
    });
  });

  it('never removes anything, so the failure is inspectable', async () => {
    const jobId = await seedJob();
    await makeRunner({ runExperiment: failsPartway }).run(jobId);
    expect(await readdir(await runDirectory(jobId))).toContain('matches.jsonl');
  });

  it('fails a run whose manifest never appeared, rather than completing it', async () => {
    // The stand-in "succeeds" without writing a manifest. A job that completed
    // here would be a catalog entry pointing at a run that does not exist.
    const jobId = await seedJob();
    const outcome = unwrap(
      await makeRunner({
        runExperiment: async (_config, options) => {
          await appendRecords(options?.outputDir ?? '', 1);
          return NOTHING_READ;
        },
      }).run(jobId),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.code).toBe('admin/run_failed');
    expect(outcome.failure?.message).toContain('no manifest');
  });
});

describe('the configuration a job holds cannot drift out from under it', () => {
  it('refuses when the stored configuration no longer matches the recorded address', async () => {
    const jobId = await seedJob({ id: 'first-config' });
    // Somebody edits the stored file. Its hash no longer matches `spec`.
    await writeFile(
      join(catalog.catalogRoot, 'configs', `${jobId}.json`),
      JSON.stringify(testConfig({ id: 'first-config', seed: 'a-different-seed' })),
      'utf8',
    );

    const outcome = unwrap(
      await makeRunner({
        runExperiment: async () => {
          throw new Error('should never be reached');
        },
      }).run(jobId),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.code).toBe('admin/run_failed');
    expect(outcome.failure?.path).toBe('spec.configHash');
  });

  it('refuses to resume into a stream another configuration opened', async () => {
    const jobId = await seedJob();
    const directory = await runDirectory(jobId);
    await appendRecords(directory, 3);
    await writeFile(
      experimentPaths(directory).matchesHeader,
      JSON.stringify({
        schemaVersion: 1,
        experimentId: 'somebody-else',
        experimentKind: 'batch',
        configHash: 'ffffffffffffffff',
        telemetrySchemaVersion: 6,
        seedDerivationVersion: 2,
        hashVersion: 1,
      }),
      'utf8',
    );

    const outcome = unwrap(
      await makeRunner({
        runExperiment: async () => {
          throw new Error('should never be reached');
        },
      }).run(jobId),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.message).toContain('different configuration');
  });

  it('refuses a job whose stored configuration was written by another build', async () => {
    const jobId = await seedJob();
    const stored = JSON.parse(
      await readFile(join(catalog.catalogRoot, 'configs', `${jobId}.json`), 'utf8'),
    ) as Record<string, unknown>;
    await writeFile(
      join(catalog.catalogRoot, 'configs', `${jobId}.json`),
      JSON.stringify({ ...stored, schemaVersion: 99 }),
      'utf8',
    );

    const outcome = unwrap(
      await makeRunner({
        runExperiment: async () => {
          throw new Error('should never be reached');
        },
      }).run(jobId),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.failure?.code).toBe('admin/unsupported_version');
    expect(outcome.failure?.message).toContain('written by a newer build');
  });
});

describe('progress while a run is in flight', () => {
  it('rises as the canonical stream grows, without being told anything', async () => {
    const seen: Progress[] = [];
    const store = catalog.store;
    const write = store.setJobProgress.bind(store);
    store.setJobProgress = async (jobId, progress) => {
      seen.push(progress);
      return write(jobId, progress);
    };

    const jobId = await seedJob();
    const dribble: RunExperimentFn = async (_config, options) => {
      for (let index = 0; index < 3; index += 1) {
        await appendRecords(options?.outputDir ?? '', 1);
        await delay(80);
      }
      return NOTHING_READ;
    };
    await makeRunner({ runExperiment: dribble, pollEveryMs: 20 }).run(jobId);

    const counts = seen.map((progress) => progress.completedMatches);
    expect(counts[0]).toBe(0);
    expect(counts.at(-1)).toBe(3);
    // Strictly non-decreasing: a committed stream only grows, so a reading that
    // is behind the last one written is a stale sample and is dropped. A
    // per-attempt counter would go backwards on a resumed run, and a poll that
    // finished reading after the run settled would go backwards on any run.
    expect([...counts].sort((left, right) => left - right)).toEqual(counts);
    expect(new Set(counts).size).toBeGreaterThan(1);
  });

  it('sums elapsed time across attempts rather than restarting the clock', async () => {
    let now = Date.UTC(2026, 7, 22, 10, 0, 0, 0);
    const runner = () =>
      makeRunner({
        runExperiment: async () => {
          now += 5_000;
          return NOTHING_READ;
        },
        clock: () => new Date(now),
      });

    const jobId = await seedJob();
    await runner().run(jobId);
    const first = unwrap(await catalog.store.readJob(jobId)).progress.elapsedMs;
    expect(first).toBe(5_000);

    unwrap(await catalog.store.applyJobAction({ jobId, action: 'retry' }));
    await runner().run(jobId);
    expect(unwrap(await catalog.store.readJob(jobId)).progress.elapsedMs).toBe(10_000);
  });

  it('does not abandon a healthy run because a progress write failed', async () => {
    // A counter that could not be persisted is a screen briefly out of date.
    // Abandoning the run over one would throw away real matches to protect a
    // number that is re-read from the directory anyway.
    const store = catalog.store;
    let refusals = 0;
    store.setJobProgress = async () => {
      refusals += 1;
      throw new Error('the catalog is momentarily unwritable');
    };

    const jobId = await seedJob();
    const outcome = await makeRunner({ runExperiment: async () => NOTHING_READ }).run(jobId);
    expect(refusals).toBeGreaterThan(0);
    // It still fails — this stand-in writes no manifest — but it fails for the
    // run's own reason rather than for the counter's.
    expect(isOk(outcome) && outcome.value.failure?.message).toContain('no manifest');
  });
});
