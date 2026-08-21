import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  JOB_STATUSES,
  JOB_TERMINAL_STATUSES,
  isTerminalJobStatus,
  jobTransition,
  legalJobActions,
  reachableStates,
  JOB_LIFECYCLE,
  type JobStatus,
} from '@tcg/admin-contracts';
import { isErr, unwrap } from '@tcg/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileCatalogStore, openFileCatalogStore } from './file-catalog-store.js';
import { makeTestCatalog, type TestCatalog } from './test-catalog.js';

/**
 * What a restart does to work that was in flight.
 *
 * The milestone's sentence is *`running` work recovered after restart as an
 * explicit resumable or interrupted state and **never** as completed*, and the
 * strongest way to test it is not to assert one example but to walk every state
 * the lifecycle declares and to derive the expected answer from the table both
 * the store and the test read. A state added later is then covered the day it is
 * added.
 *
 * "Restart" here means a **new store over the same directory**, which is what a
 * restarted process actually is: the previous store's in-memory locks, clocks
 * and knowledge are gone, and all that survives is what reached the disk.
 */

let catalog: TestCatalog;

beforeEach(async () => {
  catalog = await makeTestCatalog();
});

afterEach(async () => {
  await catalog.dispose();
});

/** Drives a job into `status` using only legal transitions, or reports it cannot. */
async function driveTo(status: JobStatus): Promise<string> {
  const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
  const job = unwrap(
    await catalog.store.createJob({
      batchId: batch.batchId,
      label: `to ${status}`,
      purpose: 'exploration',
      sourceClasses: ['ai'],
    }),
  );

  const route: Readonly<Record<JobStatus, readonly string[]>> = {
    queued: [],
    running: ['start'],
    pausing: ['start', 'pause'],
    paused: ['start', 'pause', 'pause_settled'],
    cancelling: ['start', 'cancel'],
    interrupted: ['start', 'interrupt'],
    completed: ['start', 'complete'],
    failed: ['start', 'fail'],
    cancelled: ['cancel'],
  };

  for (const action of route[status]) {
    catalog.advance(1_000);
    unwrap(
      await catalog.store.applyJobAction({
        jobId: job.jobId,
        action: action as never,
        cause: 'runner',
      }),
    );
  }
  expect(unwrap(await catalog.store.readJob(job.jobId)).status).toBe(status);
  return job.jobId;
}

/** A second store over the same directory: the process came back. */
function restart(): FileCatalogStore {
  return new FileCatalogStore({ roots: catalog.roots, clock: () => new Date() });
}

describe('the recovery rule is read from the lifecycle table', () => {
  it('touches exactly the states that declare an interrupt transition', () => {
    const interruptible = JOB_STATUSES.filter(
      (status) => jobTransition(status, 'interrupt') !== null,
    );
    expect(interruptible).toEqual(['running', 'pausing', 'cancelling']);
  });

  it('cannot reach a terminal state from any of them', () => {
    for (const status of JOB_STATUSES) {
      const landing = jobTransition(status, 'interrupt');
      if (landing === null) continue;
      expect(isTerminalJobStatus(landing)).toBe(false);
      expect(JOB_TERMINAL_STATUSES).not.toContain(landing);
    }
  });

  it('leaves an interrupted job resumable, which is what makes it not a failure', () => {
    expect(legalJobActions('interrupted')).toContain('resume');
    expect(jobTransition('interrupted', 'resume')).toBe('queued');
    // And `completed` is unreachable from it however many moves are taken.
    expect(reachableStates(JOB_LIFECYCLE, 'start')).not.toContain('completed');
  });
});

describe('a restart over a real directory', () => {
  it('recovers running, pausing and cancelling work as interrupted', async () => {
    const inFlight: Record<string, string> = {};
    for (const status of ['running', 'pausing', 'cancelling'] as const) {
      inFlight[status] = await driveTo(status);
    }

    const recovery = unwrap(await restart().recover());
    expect(recovery.recovered.map((job) => job.from).sort()).toEqual([
      'cancelling',
      'pausing',
      'running',
    ]);
    expect(recovery.recovered.every((job) => job.to === 'interrupted')).toBe(true);

    const after = restart();
    for (const jobId of Object.values(inFlight)) {
      expect(unwrap(await after.readJob(jobId)).status).toBe('interrupted');
    }
  });

  it('never recovers in-flight work as completed, for any state', async () => {
    for (const status of JOB_STATUSES) {
      const test = await makeTestCatalog();
      catalog = test;
      const jobId = await driveTo(status);
      unwrap(await restart().recover());
      const after = unwrap(await restart().readJob(jobId));
      if (status === 'completed') {
        expect(after.status).toBe('completed');
      } else {
        expect(after.status).not.toBe('completed');
      }
      await test.dispose();
    }
  });

  it('leaves settled work exactly where it was', async () => {
    // `queued` and `paused` are durable, and a terminal job is finished. A sweep
    // that touched them would be deciding something rather than reading it.
    const settled: [JobStatus, string][] = [];
    for (const status of ['queued', 'paused', 'completed', 'failed', 'cancelled'] as const) {
      settled.push([status, await driveTo(status)]);
    }

    const before = new Map<string, string>();
    for (const [, jobId] of settled) {
      before.set(jobId, await readFile(join(catalog.catalogRoot, 'jobs', `${jobId}.json`), 'utf8'));
    }

    const recovery = unwrap(await restart().recover());
    expect(recovery.recovered).toEqual([]);

    for (const [status, jobId] of settled) {
      const after = await readFile(join(catalog.catalogRoot, 'jobs', `${jobId}.json`), 'utf8');
      expect(`${status}: unchanged=${String(after === before.get(jobId))}`).toBe(
        `${status}: unchanged=true`,
      );
    }
  });

  it('says a recovered job was recovered, and not that an operator stopped it', async () => {
    const jobId = await driveTo('running');
    unwrap(await restart().recover());

    const log = unwrap(await restart().readJobEvents(jobId));
    const last = log.events.at(-1);
    expect(last?.kind).toBe('transition');
    expect(last?.kind === 'transition' && last.action).toBe('interrupt');
    expect(last?.kind === 'transition' && last.cause).toBe('recovery');
  });

  it('is idempotent: sweeping twice interrupts nothing the second time', async () => {
    await driveTo('running');
    expect(unwrap(await restart().recover()).recovered).toHaveLength(1);
    expect(unwrap(await restart().recover()).recovered).toHaveLength(0);
  });

  it('resumes an interrupted job back into the queue, not straight into running', async () => {
    // A job that resumed into `running` would be claiming a worker M08.5 has
    // not given it, so `resume` returns to `queued` and only `start` runs work.
    const jobId = await driveTo('running');
    unwrap(await restart().recover());

    const after = restart();
    const resumed = unwrap(await after.applyJobAction({ jobId, action: 'resume' }));
    expect(resumed.status).toBe('queued');
    expect(resumed.timestamps.completedAt).toBeNull();
  });

  it('recovers a batch’s jobs without inventing a batch state for it', async () => {
    // `BATCH_STATUSES` has no `interrupted`: a batch owns no worker, so a
    // restart interrupts its jobs and finds the batch where it left it.
    const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
    const job = unwrap(
      await catalog.store.createJob({
        batchId: batch.batchId,
        label: 'one',
        purpose: 'exploration',
        sourceClasses: ['ai'],
      }),
    );
    unwrap(await catalog.store.applyBatchAction(batch.batchId, 'enqueue'));
    unwrap(await catalog.store.applyBatchAction(batch.batchId, 'start'));
    unwrap(await catalog.store.applyJobAction({ jobId: job.jobId, action: 'start' }));

    unwrap(await restart().recover());
    const after = restart();
    expect(unwrap(await after.readJob(job.jobId)).status).toBe('interrupted');
    expect(unwrap(await after.readBatch(batch.batchId)).status).toBe('running');
  });
});

describe('opening a catalog sweeps before anything can read a lie', () => {
  it('recovers as part of opening, so no caller can forget to', async () => {
    const jobId = await driveTo('running');
    const opened = unwrap(
      await openFileCatalogStore({ roots: catalog.roots, clock: () => new Date() }),
    );
    expect(opened.recovery.recovered.map((job) => job.jobId)).toEqual([jobId]);
    expect(unwrap(await opened.store.readJob(jobId)).status).toBe('interrupted');
  });

  it('creates its layout on a root that does not exist yet', async () => {
    const fresh = await makeTestCatalog();
    const opened = unwrap(
      await openFileCatalogStore({ roots: fresh.roots, clock: () => new Date() }),
    );
    expect(opened.recovery.scannedJobs).toBe(0);
    expect(unwrap(await opened.store.listJobs()).items).toEqual([]);
    await fresh.dispose();
  });
});

describe('a damaged document survives a restart rather than being rewritten', () => {
  it('reports it and leaves the bytes untouched', async () => {
    const jobId = await driveTo('running');
    const path = join(catalog.catalogRoot, 'jobs', `${jobId}.json`);
    await writeFile(path, '{"documentVersion": 1, "jobId":', 'utf8');

    const recovery = unwrap(await restart().recover());
    expect(recovery.recovered).toEqual([]);
    expect(recovery.unreadable).toHaveLength(1);
    expect(recovery.unreadable[0]?.id).toBe(jobId);
    expect(await readFile(path, 'utf8')).toBe('{"documentVersion": 1, "jobId":');
  });

  it('recovers its readable neighbours anyway', async () => {
    const damaged = await driveTo('running');
    const healthy = await driveTo('running');
    await writeFile(join(catalog.catalogRoot, 'jobs', `${damaged}.json`), 'broken', 'utf8');

    const recovery = unwrap(await restart().recover());
    expect(recovery.recovered.map((job) => job.jobId)).toEqual([healthy]);
    expect(recovery.unreadable.map((entry) => entry.id)).toEqual([damaged]);
  });

  it('refuses a document from a newer build rather than sweeping it', async () => {
    const jobId = await driveTo('running');
    const path = join(catalog.catalogRoot, 'jobs', `${jobId}.json`);
    const document = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...document, documentVersion: 99 }), 'utf8');

    const recovery = unwrap(await restart().recover());
    expect(recovery.unreadable[0]?.errors[0]?.code).toBe('admin/unsupported_version');
    expect(recovery.recovered).toEqual([]);
  });
});

describe('a damaged event log does not damage the job', () => {
  it('drops and reports a truncated final line, and keeps the rest', async () => {
    const jobId = await driveTo('running');
    const logPath = join(catalog.catalogRoot, 'events', `${jobId}.jsonl`);
    const text = await readFile(logPath, 'utf8');
    await writeFile(logPath, `${text}{"eventVersion":1,"jobId":"${jobId}","at":`, 'utf8');

    const log = unwrap(await restart().readJobEvents(jobId));
    expect(log.events).toHaveLength(2);
    expect(log.skipped).toHaveLength(1);
    expect(log.skipped[0]?.reason).toContain('truncated tail');
  });

  it('reports a line from a newer build with the readable refusal', async () => {
    const jobId = await driveTo('running');
    const logPath = join(catalog.catalogRoot, 'events', `${jobId}.jsonl`);
    await writeFile(
      logPath,
      `${await readFile(logPath, 'utf8')}${JSON.stringify({
        eventVersion: 99,
        jobId,
        at: '2026-08-21T09:00:00.000Z',
        kind: 'transition',
      })}\n`,
      'utf8',
    );

    const log = unwrap(await restart().readJobEvents(jobId));
    expect(log.skipped[0]?.reason).toContain('written by a newer build');
    expect(log.events).toHaveLength(2);
  });

  it('still lets the job be recovered and read', async () => {
    const jobId = await driveTo('running');
    await writeFile(join(catalog.catalogRoot, 'events', `${jobId}.jsonl`), 'garbage\n', 'utf8');

    const store = restart();
    expect(unwrap(await store.recover()).recovered).toHaveLength(1);
    expect(unwrap(await store.readJob(jobId)).status).toBe('interrupted');
    expect(unwrap(await store.readJobEvents(jobId)).skipped).toHaveLength(1);
  });

  it('has no log at all for a job that never had one, without failing', async () => {
    const log = await restart().readJobEvents('job_absent0001');
    expect(isErr(log)).toBe(false);
    expect(unwrap(log).events).toEqual([]);
  });
});
