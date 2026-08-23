import { mkdir, readFile, writeFile } from 'node:fs/promises';

import type { JobEvent, JobId } from '@tcg/admin-contracts';
import { isErr, unwrap } from '@tcg/shared';
import {
  ExperimentStopped,
  configHashOf,
  experimentPaths,
  type ExperimentConfig,
  type ExperimentOutcome,
} from '@tcg/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveResultLocation } from '../catalog/roots.js';
import { makeTestCatalog, testConfig, type TestCatalog } from '../catalog/test-catalog.js';
import { estimateExperiment } from '../lab/estimate.js';
import { ExperimentRunner, type RunExperimentFn } from './job-runner.js';
import { countCommittedRecords } from './progress.js';
import { JobQueue } from './queue.js';

/**
 * The queue, and the four verbs an operator has over work in flight (M08.5).
 *
 * Two drivers again, for the reason `job-runner.test.ts` gives and one more.
 *
 * **A faithful stand-in** plays most of these. It is not a mock of the queue: it
 * is a small honest implementation of the *simulator's* contract — it asks
 * `shouldStop` before each match, appends a committed record per match, counts
 * what is already there when asked to `resume`, writes a manifest only when it
 * finishes the whole schedule, and throws `ExperimentStopped` when it is
 * stopped. That is what lets a pause land at a chosen instant rather than at
 * whichever one a race produced, which is the difference between a test that
 * means something and a test that passes.
 *
 * **The real simulator** plays one of them end to end. A pause that had only
 * ever met a stand-in would be a pause that had never met a worker thread, and
 * the "in-flight matches reach their normal record boundary" half of the promise
 * lives in the pool's dispatch loop.
 *
 * One more thing the stand-in makes possible and the real runner does not: the
 * single-worker sequential path inside this process **never yields to the event
 * loop between matches** (M08.4 recorded the same limitation against progress
 * polling). An operator's pause is a file write, so it cannot land while such a
 * run is in flight — which is why the end-to-end test runs across worker
 * threads, and why that is the case an operator watching a queue is actually in.
 */

let catalog: TestCatalog;

beforeEach(async () => {
  catalog = await makeTestCatalog();
});

afterEach(async () => {
  await catalog.dispose();
});

const NOTHING_READ = undefined as unknown as ExperimentOutcome;

const delay = (milliseconds: number): Promise<void> =>
  new Promise((settle) => setTimeout(settle, milliseconds));

async function seedJob(
  overrides: Parameters<typeof testConfig>[0] = {},
  label = 'Precon smoke',
): Promise<JobId> {
  const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
  const job = unwrap(
    await catalog.store.createJob({
      batchId: batch.batchId,
      label,
      purpose: 'exploration',
      sourceClasses: ['ai', 'precon'],
      config: testConfig(overrides),
    }),
  );
  return job.jobId;
}

async function runDirectory(jobId: JobId): Promise<string> {
  return unwrap(await resolveResultLocation(catalog.roots, { rootId: 'local', directory: jobId }));
}

function makeRunner(runExperiment?: RunExperimentFn): ExperimentRunner {
  return new ExperimentRunner({
    store: catalog.store,
    roots: catalog.roots,
    resultRootId: 'local',
    pollEveryMs: 20,
    ...(runExperiment === undefined ? {} : { runExperiment }),
  });
}

function makeQueue(
  options: {
    readonly runExperiment?: RunExperimentFn;
    readonly limits?: ConstructorParameters<typeof JobQueue>[0]['limits'];
  } = {},
): JobQueue {
  return new JobQueue({
    store: catalog.store,
    runner: makeRunner(options.runExperiment),
    ...(options.limits === undefined ? {} : { limits: options.limits }),
  });
}

/* -------------------------------------------------- the faithful stand-in */

interface FakeRun {
  /**
   * Awaited after each match is committed, so a test can act at a chosen point.
   *
   * *After*, deliberately: an operator's pause lands between matches, and the
   * count it sees is the count on disk. Asking before the write would put every
   * expectation in this file one out and hide which half of the boundary it is.
   */
  readonly betweenMatches?: (playedSoFar: number) => Promise<void> | void;
  /** Workers each attempt was actually given, in start order. */
  readonly workersSeen: number[];
  /** Peak simultaneous attempts, and peak simultaneous workers. */
  readonly peak: { jobs: number; workers: number };
  readonly fn: RunExperimentFn;
}

function fakeSimulator(spec: {
  total: number;
  betweenMatches?: FakeRun['betweenMatches'];
}): FakeRun {
  const workersSeen: number[] = [];
  const peak = { jobs: 0, workers: 0 };
  let liveJobs = 0;
  let liveWorkers = 0;

  const fn: RunExperimentFn = async (config: ExperimentConfig, options) => {
    const directory = options?.outputDir ?? '';
    const workers = options?.workers ?? 1;
    workersSeen.push(workers);
    liveJobs += 1;
    liveWorkers += workers;
    peak.jobs = Math.max(peak.jobs, liveJobs);
    peak.workers = Math.max(peak.workers, liveWorkers);

    try {
      await mkdir(directory, { recursive: true });
      const paths = experimentPaths(directory);
      await writeFile(
        paths.matchesHeader,
        JSON.stringify({
          experimentId: config.id,
          experimentKind: config.kind,
          configHash: configHashOf(config),
        }),
        'utf8',
      );

      // Resume is what the real store does: whatever is already committed is
      // already played, and only the remainder is scheduled.
      let played = options?.resume === true ? await countCommittedRecords(paths.matches) : 0;
      while (played < spec.total) {
        const reason = options?.shouldStop?.();
        if (reason !== undefined && reason !== null) throw new ExperimentStopped(reason, played);
        await writeFile(paths.matches, `${JSON.stringify({ matchId: `m${String(played)}` })}\n`, {
          flag: 'a',
        });
        played += 1;
        await spec.betweenMatches?.(played);
      }

      await writeFile(
        paths.manifest,
        JSON.stringify({
          schemaVersion: 8,
          experimentId: config.id,
          kind: config.kind,
          seed: config.seed,
          configHash: configHashOf(config),
          softwareCommit: '2b1a6ec',
          matches: spec.total,
          environments: [
            {
              id: 'fixture',
              hashes: {
                mechanicsHash: '1111111111111111',
                pilotInputHash: '2222222222222222',
                presentationHash: '3333333333333333',
                fullContentHash: '4444444444444444',
              },
            },
          ],
        }),
        'utf8',
      );
      return NOTHING_READ;
    } finally {
      liveJobs -= 1;
      liveWorkers -= workers;
    }
  };

  return {
    workersSeen,
    peak,
    fn,
    ...(spec.betweenMatches ? { betweenMatches: spec.betweenMatches } : {}),
  };
}

/** Every transition in a job's log, as `action:from>to:cause`. */
async function history(jobId: JobId): Promise<string[]> {
  const log = unwrap(await catalog.store.readJobEvents(jobId));
  return log.events
    .filter(
      (event: JobEvent): event is Extract<JobEvent, { kind: 'transition' }> =>
        event.kind === 'transition',
    )
    .map((event) => `${event.action}:${event.from}>${event.to}:${event.cause}`);
}

/* ------------------------------------------------------------------ tests */

describe('bounded concurrency and worker limits', () => {
  it('runs one job at a time when told to, whatever is queued', async () => {
    const simulator = fakeSimulator({ total: 2, betweenMatches: () => delay(5) });
    const queue = makeQueue({
      runExperiment: simulator.fn,
      limits: { maxConcurrentJobs: 1, maxWorkers: 8, maxWorkersPerJob: 4 },
    });
    for (const id of ['one', 'two', 'three']) await seedJob({ id });

    await queue.drain();

    expect(simulator.peak.jobs).toBe(1);
    expect(simulator.workersSeen).toHaveLength(3);
  });

  it('runs several at once when the bound allows, and never more', async () => {
    const simulator = fakeSimulator({ total: 3, betweenMatches: () => delay(10) });
    const queue = makeQueue({
      runExperiment: simulator.fn,
      limits: { maxConcurrentJobs: 2, maxWorkers: 8, maxWorkersPerJob: 4 },
    });
    for (const id of ['one', 'two', 'three', 'four']) await seedJob({ id });

    await queue.drain();

    expect(simulator.peak.jobs).toBe(2);
    expect(simulator.workersSeen).toHaveLength(4);
  });

  it('keeps the total worker count inside the budget across concurrent jobs', async () => {
    // The number that decides whether the machine is oversubscribed. Three jobs
    // each asking for four workers against a budget of five: the sum in flight
    // is never above five, and a job that cannot be given at least one worker is
    // not started at all.
    const simulator = fakeSimulator({ total: 3, betweenMatches: () => delay(10) });
    const queue = makeQueue({
      runExperiment: simulator.fn,
      limits: { maxConcurrentJobs: 3, maxWorkers: 5, maxWorkersPerJob: 4 },
    });
    for (const id of ['one', 'two', 'three']) await seedJob({ id, workers: 4 });

    await queue.drain();

    expect(simulator.peak.workers).toBeLessThanOrEqual(5);
    expect(simulator.workersSeen).toHaveLength(3);
    expect(Math.max(...simulator.workersSeen)).toBeLessThanOrEqual(4);
  });

  it('records on the document the workers an attempt was actually granted', async () => {
    const simulator = fakeSimulator({ total: 1 });
    const queue = makeQueue({
      runExperiment: simulator.fn,
      limits: { maxConcurrentJobs: 1, maxWorkers: 2, maxWorkersPerJob: 2 },
    });
    const jobId = await seedJob({ workers: 8 });

    await queue.drain();

    // The configuration asked for eight, the bound granted two, and the catalog
    // says two — because it records what happened rather than what was wanted.
    expect(unwrap(await catalog.store.readJob(jobId)).execution?.workers).toBe(2);
  });

  it('leaves the budget exactly where it found it once everything settles', async () => {
    const simulator = fakeSimulator({ total: 1 });
    const queue = makeQueue({
      runExperiment: simulator.fn,
      limits: { maxConcurrentJobs: 2, maxWorkers: 4, maxWorkersPerJob: 2 },
    });
    for (const id of ['one', 'two', 'three']) await seedJob({ id });

    await queue.drain();

    expect(queue.snapshot().workersInUse).toBe(0);
    expect(queue.snapshot().inFlight).toEqual([]);
  });

  it('falls back to the conservative default rather than trusting a bad bound', async () => {
    const queue = makeQueue({ limits: { maxWorkers: 0 } });
    expect(queue.limits.maxConcurrentJobs).toBe(1);
    expect(queue.limits.maxWorkers).toBeGreaterThanOrEqual(1);
    await Promise.resolve();
  });
});

describe('pause and resume', () => {
  it('stops scheduling new matches, keeps what it played, and settles as paused', async () => {
    const jobId = await seedJob({ id: 'pausable' });
    const simulator = fakeSimulator({
      total: 6,
      betweenMatches: async (played) => {
        // Once, with one match committed. The stand-in is *inside* the run when
        // this lands, which is exactly the window a real pause has.
        if (played === 1) unwrap(await queue.pause(jobId));
      },
    });
    const queue = makeQueue({ runExperiment: simulator.fn });

    await queue.drain();

    const job = unwrap(await catalog.store.readJob(jobId));
    expect(job.status).toBe('paused');
    expect(job.progress.completedMatches).toBe(1);
    expect(await countCommittedRecords(experimentPaths(await runDirectory(jobId)).matches)).toBe(1);
    expect(job.result).toBeNull();
    expect(await history(jobId)).toEqual([
      'start:queued>running:runner',
      'pause:running>pausing:operator',
      'pause_settled:pausing>paused:runner',
    ]);
  });

  it('writes no manifest for a run that stopped, so a partial run is not indexed', async () => {
    const jobId = await seedJob({ id: 'unindexed' });
    const simulator = fakeSimulator({
      total: 4,
      betweenMatches: async (played) => {
        if (played === 1) unwrap(await queue.pause(jobId));
      },
    });
    const queue = makeQueue({ runExperiment: simulator.fn });

    await queue.drain();

    const paths = experimentPaths(await runDirectory(jobId));
    await expect(readFile(paths.manifest, 'utf8')).rejects.toThrow();
    expect(unwrap(await catalog.store.readJob(jobId)).result).toBeNull();
  });

  it('resumes into the same stream and finishes the schedule exactly once', async () => {
    let stops = 0;
    const jobId = await seedJob({ id: 'resumable' });
    const simulator = fakeSimulator({
      total: 5,
      betweenMatches: async (played) => {
        if (played === 2 && stops === 0) {
          stops += 1;
          unwrap(await queue.pause(jobId));
        }
      },
    });
    const queue = makeQueue({ runExperiment: simulator.fn });

    await queue.drain();
    expect(unwrap(await catalog.store.readJob(jobId)).status).toBe('paused');

    unwrap(await queue.resume(jobId));
    await queue.drain();

    const job = unwrap(await catalog.store.readJob(jobId));
    expect(job.status).toBe('completed');
    expect(job.execution?.attempts).toBe(2);
    // The second attempt found two matches already on disk and played three.
    expect(job.execution?.resumedMatches).toBe(2);
    expect(await countCommittedRecords(experimentPaths(await runDirectory(jobId)).matches)).toBe(5);
  });

  it('refuses a second resume of a job that is already back in the queue', async () => {
    // The duplicate-resume case. `resume` lands in `queued`, which has no
    // `resume` transition — so the refusal is the lifecycle table's rather than
    // a flag, and the job is queued once however many times a button is pressed.
    let stops = 0;
    const jobId = await seedJob({ id: 'twiceresumed' });
    const simulator = fakeSimulator({
      total: 3,
      betweenMatches: async (played) => {
        if (played === 1 && stops === 0) {
          stops += 1;
          unwrap(await queue.pause(jobId));
        }
      },
    });
    const queue = makeQueue({
      runExperiment: simulator.fn,
      limits: { maxConcurrentJobs: 1, maxWorkers: 1, maxWorkersPerJob: 1 },
    });

    await queue.drain();

    const [first, second] = await Promise.all([queue.resume(jobId), queue.resume(jobId)]);
    const refused = isErr(first) ? first : second;
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/illegal_transition');

    await queue.drain();
    // Two attempts, not three: the refused resume started nothing.
    expect(unwrap(await catalog.store.readJob(jobId)).execution?.attempts).toBe(2);
  });

  it('refuses to pause a job that is not running', async () => {
    const queue = makeQueue({ runExperiment: fakeSimulator({ total: 1 }).fn });
    const jobId = await seedJob();

    const refused = await queue.pause(jobId);

    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/illegal_transition');
    expect(unwrap(await catalog.store.readJob(jobId)).status).toBe('queued');
  });
});

describe('cancel', () => {
  it('stops a running job gracefully and leaves every partial record', async () => {
    const jobId = await seedJob({ id: 'cancellable' });
    const simulator = fakeSimulator({
      total: 6,
      betweenMatches: async (played) => {
        if (played === 2) unwrap(await queue.cancel(jobId));
      },
    });
    const queue = makeQueue({ runExperiment: simulator.fn });

    await queue.drain();

    const job = unwrap(await catalog.store.readJob(jobId));
    expect(job.status).toBe('cancelled');
    expect(job.progress.completedMatches).toBe(2);
    expect(await countCommittedRecords(experimentPaths(await runDirectory(jobId)).matches)).toBe(2);
    expect(await history(jobId)).toEqual([
      'start:queued>running:runner',
      'cancel:running>cancelling:operator',
      'cancel_settled:cancelling>cancelled:runner',
    ]);
  });

  it('escalates a pause into a cancel, and settles as cancelled', async () => {
    // The settling action is read from the document rather than from the first
    // request, so the operator's second word is the one that counts.
    const jobId = await seedJob({ id: 'escalated' });
    const simulator = fakeSimulator({
      total: 6,
      betweenMatches: async (played) => {
        if (played !== 1) return;
        unwrap(await queue.pause(jobId));
        unwrap(await queue.cancel(jobId));
      },
    });
    const queue = makeQueue({ runExperiment: simulator.fn });

    await queue.drain();

    expect(unwrap(await catalog.store.readJob(jobId)).status).toBe('cancelled');
    expect(await history(jobId)).toEqual([
      'start:queued>running:runner',
      'pause:running>pausing:operator',
      'cancel:pausing>cancelling:operator',
      'cancel_settled:cancelling>cancelled:runner',
    ]);
  });

  it('cancels a queued job outright, with no run to stop', async () => {
    const queue = makeQueue({ runExperiment: fakeSimulator({ total: 1 }).fn });
    const jobId = await seedJob();

    unwrap(await queue.cancel(jobId));
    expect(unwrap(await catalog.store.readJob(jobId)).status).toBe('cancelled');

    await queue.drain();
    // And the pump does not pick it up afterwards.
    expect(unwrap(await catalog.store.readJob(jobId)).execution).toBeNull();
  });

  it('cancels a paused job, keeping the partial output it had', async () => {
    const jobId = await seedJob({ id: 'pausedcancel' });
    const simulator = fakeSimulator({
      total: 4,
      betweenMatches: async (played) => {
        if (played === 1) unwrap(await queue.pause(jobId));
      },
    });
    const queue = makeQueue({ runExperiment: simulator.fn });

    await queue.drain();
    unwrap(await queue.cancel(jobId));

    expect(unwrap(await catalog.store.readJob(jobId)).status).toBe('cancelled');
    expect(await countCommittedRecords(experimentPaths(await runDirectory(jobId)).matches)).toBe(1);
  });
});

describe('retry is an explicit action with its own record', () => {
  /** Leaves one committed record and then throws, which is what a killed run leaves. */
  const fails: RunExperimentFn = async (_config, options) => {
    await mkdir(options?.outputDir ?? '', { recursive: true });
    await writeFile(experimentPaths(options?.outputDir ?? '').matches, '{"matchId":"m0"}\n', {
      flag: 'a',
    });
    throw new Error('the pilot pool ran out');
  };

  it('never retries by itself, however many times the queue is pumped', async () => {
    const queue = makeQueue({ runExperiment: fails });
    const jobId = await seedJob();

    await queue.drain();
    await queue.pump();
    await queue.drain();

    const job = unwrap(await catalog.store.readJob(jobId));
    expect(job.status).toBe('failed');
    expect(job.execution?.attempts).toBe(1);
    expect(await history(jobId)).toEqual([
      'start:queued>running:runner',
      'fail:running>failed:runner',
    ]);
  });

  it('is an operator’s line in the log, and the document alone cannot tell', async () => {
    // The whole reason the event log exists. A job that failed, was retried and
    // then succeeded spells `completed`; only the log says it took two attempts,
    // and only `cause` says a person asked for the second.
    let attempt = 0;
    const failsThenSucceeds: RunExperimentFn = async (config, options) => {
      attempt += 1;
      if (attempt === 1) return fails(config, options);
      return fakeSimulator({ total: 1 }).fn(config, options);
    };
    const queue = makeQueue({ runExperiment: failsThenSucceeds });
    const jobId = await seedJob({ id: 'retried' });

    await queue.drain();
    unwrap(await queue.retry(jobId));
    await queue.drain();

    const job = unwrap(await catalog.store.readJob(jobId));
    expect(job.status).toBe('completed');
    expect(job.failure).toBeNull();
    expect(await history(jobId)).toEqual([
      'start:queued>running:runner',
      'fail:running>failed:runner',
      'retry:failed>queued:operator',
      'start:queued>running:runner',
      'complete:running>completed:runner',
    ]);
  });

  it('continues the stream the failed attempt left rather than starting a second', async () => {
    let attempt = 0;
    const resumeSeen: (boolean | undefined)[] = [];
    const failsThenSucceeds: RunExperimentFn = async (config, options) => {
      attempt += 1;
      resumeSeen.push(options?.resume);
      if (attempt === 1) return fails(config, options);
      return fakeSimulator({ total: 3 }).fn(config, options);
    };
    const queue = makeQueue({ runExperiment: failsThenSucceeds });
    const jobId = await seedJob({ id: 'continued' });

    await queue.drain();
    unwrap(await queue.retry(jobId));
    await queue.drain();

    expect(resumeSeen).toEqual([true, true]);
    const job = unwrap(await catalog.store.readJob(jobId));
    expect(job.execution?.attempts).toBe(2);
    expect(job.execution?.resumedMatches).toBe(1);
    expect(await countCommittedRecords(experimentPaths(await runDirectory(jobId)).matches)).toBe(3);
  });

  it('refuses to retry a job that has not failed', async () => {
    const queue = makeQueue({ runExperiment: fakeSimulator({ total: 1 }).fn });
    const jobId = await seedJob();

    await queue.drain();

    const refused = await queue.retry(jobId);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/illegal_transition');
  });
});

describe('a restart, and the interrupted state it leaves', () => {
  it('recovers in-flight work as interrupted and starts nothing on its own', async () => {
    // The crash: a run that never returns, abandoned mid-flight, and the store's
    // own recovery run over it the way a restarted process would.
    const abandoned: RunExperimentFn = async (_config, options) => {
      await mkdir(options?.outputDir ?? '', { recursive: true });
      await writeFile(experimentPaths(options?.outputDir ?? '').matches, '{"matchId":"m0"}\n', {
        flag: 'a',
      });
      await new Promise(() => {
        /* never settles, like a process that was killed */
      });
      return NOTHING_READ;
    };
    const queue = makeQueue({ runExperiment: abandoned });
    const jobId = await seedJob({ id: 'crashed' });

    void queue.pump();
    for (let waited = 0; waited < 400; waited += 1) {
      if (unwrap(await catalog.store.readJob(jobId)).status === 'running') break;
      await delay(10);
    }

    const restarted = unwrap(await catalog.store.recover());
    expect(restarted.recovered).toEqual([{ jobId, from: 'running', to: 'interrupted' }]);

    const afterRestart = makeQueue({ runExperiment: fakeSimulator({ total: 3 }).fn });
    await afterRestart.pump();

    // An interrupted job is not queued, so nothing picked it up. Deciding that
    // the crash did not matter is not this class's decision to make.
    expect(unwrap(await catalog.store.readJob(jobId)).status).toBe('interrupted');
  });

  it('resumes an interrupted job without duplicating a match or a line of lineage', async () => {
    const jobId = await seedJob({ id: 'interrupted' });
    const directory = await runDirectory(jobId);

    // Driven through the real transitions rather than simulated: start it, leave
    // one committed record behind, and recover the way a restart does.
    unwrap(await catalog.store.applyJobAction({ jobId, action: 'start', cause: 'runner' }));
    await mkdir(directory, { recursive: true });
    await writeFile(experimentPaths(directory).matches, '{"matchId":"m0"}\n', { flag: 'a' });
    unwrap(await catalog.store.recover());
    expect(unwrap(await catalog.store.readJob(jobId)).status).toBe('interrupted');

    const queue = makeQueue({ runExperiment: fakeSimulator({ total: 3 }).fn });
    unwrap(await queue.resume(jobId));
    await queue.drain();

    expect(await countCommittedRecords(experimentPaths(directory).matches)).toBe(3);
    expect(unwrap(await catalog.store.readJob(jobId)).status).toBe('completed');
    expect(await history(jobId)).toEqual([
      'start:queued>running:runner',
      'interrupt:running>interrupted:recovery',
      'resume:interrupted>queued:operator',
      'start:queued>running:runner',
      'complete:running>completed:runner',
    ]);
  });

  it('cancels an interrupted job without ever running it again', async () => {
    const jobId = await seedJob({ id: 'interruptedcancel' });
    unwrap(await catalog.store.applyJobAction({ jobId, action: 'start', cause: 'runner' }));
    unwrap(await catalog.store.recover());

    const queue = makeQueue({ runExperiment: fakeSimulator({ total: 1 }).fn });
    unwrap(await queue.cancel(jobId));
    await queue.drain();

    expect(unwrap(await catalog.store.readJob(jobId)).status).toBe('cancelled');
  });
});

describe('a real run, paused and resumed across worker threads', () => {
  it('stops at a match boundary, keeps what it played, and finishes the schedule', async () => {
    // The one test with no stand-in anywhere. A real precon schedule across two
    // worker threads, paused once the run has shown it played something: the
    // pool's message-driven dispatch is the code that has to honour the stop,
    // and a `for` loop's reasoning does not cover it.
    const queue = makeQueue({
      limits: { maxConcurrentJobs: 1, maxWorkers: 2, maxWorkersPerJob: 2 },
    });
    const jobId = await seedJob(
      { id: 'realpause', gamesPerPairing: 12, mirrorSeats: true, workers: 2 },
      'A real pause',
    );
    const paths = experimentPaths(await runDirectory(jobId));
    // The denominator comes from the same estimator the runner uses rather than
    // from arithmetic repeated here — the second formula ADR 0023 §2 refuses.
    const total = estimateExperiment(unwrap(await catalog.store.readJobConfig(jobId))).totalMatches;
    expect(total).toBeGreaterThan(8);

    void queue.pump();
    // Waited for rather than timed. A fixed delay would decide how far the run
    // had got from how busy the machine was, and the claim being made — that a
    // pause lands *between* matches and keeps what was already played — needs
    // the run to have played something first. The stream on disk is the only
    // honest signal that it has, and it is the same one resume reads.
    for (let waited = 0; waited < 2_000; waited += 1) {
      if ((await countCommittedRecords(paths.matches)) >= 1) break;
      await delay(25);
    }
    unwrap(await queue.pause(jobId));
    await queue.drain();

    const paused = unwrap(await catalog.store.readJob(jobId));
    expect(paused.status).toBe('paused');
    const partial = await countCommittedRecords(paths.matches);
    expect(partial).toBeGreaterThanOrEqual(1);
    expect(partial).toBeLessThan(total);
    // The count on disk and the count the catalog recorded are one number: a
    // stopped run flushes its own stream, because it never reaches the write-up
    // that would otherwise have done it.
    expect(paused.progress.completedMatches).toBe(partial);
    await expect(readFile(paths.manifest, 'utf8')).rejects.toThrow();

    unwrap(await queue.resume(jobId));
    await queue.drain();

    const finished = unwrap(await catalog.store.readJob(jobId));
    expect(finished.status).toBe('completed');
    expect(finished.execution?.attempts).toBe(2);
    expect(finished.execution?.resumedMatches).toBe(partial);
    expect(finished.progress.completedMatches).toBe(total);
    expect(await countCommittedRecords(paths.matches)).toBe(total);

    // Distinct matches, not a line count that happens to add up.
    const identities = (await readFile(paths.matches, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => (JSON.parse(line) as { matchId: string }).matchId);
    expect(new Set(identities).size).toBe(total);
    expect(finished.result?.identity.configHash).toBe(finished.spec.configHash);
  }, 300_000);
});
