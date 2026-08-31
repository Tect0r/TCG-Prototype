import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ADMIN_CONTRACT_VERSION,
  ADMIN_ENDPOINTS,
  adminResponse,
  type BatchDetail,
  type BatchId,
  type CatalogJobView,
  type JobId,
  type PresetChoice,
} from '@tcg/admin-contracts';
import { isErr, unwrap } from '@tcg/shared';
import { configHashOf, experimentPaths, type ExperimentConfig } from '@tcg/simulator';

import { openFileCatalogStore, type FileCatalogStore } from '../catalog/file-catalog-store.js';
import { ExperimentRunner, type RunExperimentFn } from '../run/job-runner.js';
import { JobQueue } from '../run/queue.js';
import { parseServiceConfig } from './config.js';
import { AdminService } from './handlers.js';

/**
 * M08.9 — the three addresses a queue needs, over the real store.
 *
 * The tranche's acceptance asks for state-transition, restart-recovery,
 * concurrent-update and action-failure tests. Three of those four are server
 * facts and are here; the fourth — what a screen does with a refusal — is in
 * `apps/admin-client/src/queue-flow.test.tsx`, because a refusal that is
 * rendered is a different claim from a refusal that is returned.
 *
 * Nothing in this suite plays a match. What is under test is the *window*: a
 * batch that holds its jobs until somebody releases it, an order that can be
 * rewritten while it does, and a copy that is a copy rather than the same run
 * twice.
 */

const bases: string[] = [];
const labs: JobQueue[] = [];

afterEach(async () => {
  // Drained before anything is deleted. A started batch leaves attempts in
  // flight, and removing the catalog underneath a write is a failure of the
  // teardown rather than of the code.
  for (const queue of labs.splice(0)) await queue.drain();
  for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true });
});

interface Lab {
  readonly service: AdminService;
  readonly store: FileCatalogStore;
  readonly queue: JobQueue;
  /** How many attempts the queue actually started, so "nothing ran" is observable. */
  started(): number;
}

/**
 * A simulator stand-in that commits one record per match and writes a manifest.
 *
 * The same shape `http.test.ts` uses, and for the same reason: these tests
 * observe a *lifecycle* reaching the API, and playing real matches to watch a
 * document move from `queued` to `completed` would cost a minute per assertion
 * without making any of them stronger.
 */
function standInSimulator(onRun: () => void): RunExperimentFn {
  return (async (config: ExperimentConfig, options) => {
    onRun();
    const directory = options?.outputDir ?? '';
    await mkdir(directory, { recursive: true });
    const paths = experimentPaths(directory);
    const record = JSON.stringify({ matchId: 'm0' });
    await writeFile(paths.matches, record + '\n', { flag: 'a' });
    await writeFile(
      paths.manifest,
      JSON.stringify({
        schemaVersion: 8,
        experimentId: config.id,
        kind: config.kind,
        seed: config.seed,
        configHash: configHashOf(config),
        softwareCommit: '2b1a6ec',
        matches: 1,
        environments: [
          {
            id: 'baseline',
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
    return undefined as never;
  }) as RunExperimentFn;
}

async function makeLab(): Promise<Lab> {
  const base = await mkdtemp(join(tmpdir(), 'tcg-admin-queue-'));
  bases.push(base);
  const config = unwrap(
    parseServiceConfig({
      host: '127.0.0.1',
      port: 0,
      catalogRoot: join(base, 'catalog'),
      resultRoots: { local: join(base, 'results') },
      limits: { maxConcurrentJobs: 1, maxWorkers: 1, maxWorkersPerJob: 1 },
    }),
  );
  const opened = unwrap(await openFileCatalogStore({ roots: config.roots }));

  let attempts = 0;
  const runner = new ExperimentRunner({
    store: opened.store,
    roots: config.roots,
    resultRootId: 'local',
    pollEveryMs: 20,
    runExperiment: standInSimulator(() => {
      attempts += 1;
    }),
  });

  const queue = new JobQueue({ store: opened.store, runner, limits: config.limits });
  labs.push(queue);

  return {
    service: new AdminService({ config, store: opened.store, queue }),
    store: opened.store,
    queue,
    started: () => attempts,
  };
}

const PRECONS = [
  'precon_bastion_guardians',
  'precon_containment_control',
  'precon_goblin_swarm',
  'precon_grave_sacrifice',
];

function smoke(overrides: Record<string, unknown> = {}): PresetChoice {
  return {
    presetId: 'precon_smoke',
    experimentId: 'precon-smoke',
    seed: 'preset-2026-08',
    preconIds: PRECONS,
    pilotIds: ['value'],
    settings: {
      workload: { mode: 'preset' },
      replicates: 3,
      mirrorSeats: true,
      retention: { replaySampleRate: 0 },
      workers: 1,
    },
    ...overrides,
  } as unknown as PresetChoice;
}

/** A draft batch holding three jobs, which is what a replicated smoke expands to. */
async function draft(lab: Lab): Promise<{ batchId: BatchId; jobIds: JobId[] }> {
  const batch = await lab.service.handle('createBatch', {
    label: 'August sweep',
    annotations: { tags: [], note: '', baseline: false },
  });
  if (isErr(batch)) throw new Error(JSON.stringify(batch.error));
  const batchId = batch.value.batchId;

  const filled = await lab.service.handle('enqueuePreset', { batchId, choice: smoke() });
  if (isErr(filled)) throw new Error(JSON.stringify(filled.error));
  return { batchId, jobIds: filled.value.jobs.map((job) => job.jobId) };
}

function detailOf(answer: unknown): BatchDetail {
  return answer as BatchDetail;
}

/** Asserts the answer is one this endpoint's own response schema describes. */
function valid<N extends keyof typeof ADMIN_ENDPOINTS>(name: N, payload: unknown): void {
  const parsed = adminResponse(ADMIN_ENDPOINTS[name].response).safeParse({
    ok: true,
    contractVersion: ADMIN_CONTRACT_VERSION,
    payload,
  });
  expect(parsed.success ? 'valid' : JSON.stringify(parsed.error?.issues)).toBe('valid');
}

/* ------------------------------------------------------- the editing window */

describe('a batch is a draft until somebody starts it', () => {
  it('creates jobs, starts nothing, and says so on the batch', async () => {
    const lab = await makeLab();
    const { batchId, jobIds } = await draft(lab);
    expect(jobIds).toHaveLength(3);

    const detail = await lab.service.handle('batchDetail', { batchId });
    expect(isErr(detail)).toBe(false);
    if (isErr(detail)) return;

    expect(detail.value.batch.status).toBe('draft');
    expect(detail.value.jobs.map((job) => job.status)).toEqual(['queued', 'queued', 'queued']);
    expect(detail.value.batch.timestamps.startedAt).toBeNull();
  });

  it('holds a queued job back while its batch is a draft, however hard the queue is pumped', async () => {
    // The whole reason the window exists. A job is created `queued` — there is no
    // job `draft` state — so before M08.9 the queue would have picked this up the
    // instant it was created, and an administrator reordering it would have been
    // reordering matches that were already being played.
    const lab = await makeLab();
    const { batchId } = await draft(lab);

    await new Promise((settle) => setTimeout(settle, 40));
    expect(lab.started()).toBe(0);

    const detail = await lab.service.handle('batchDetail', { batchId });
    if (isErr(detail)) throw new Error('unreadable');
    expect(detail.value.jobs.every((job) => job.status === 'queued')).toBe(true);
  });

  it('releases the batch when it is started, and refuses a second start', async () => {
    const lab = await makeLab();
    const { batchId } = await draft(lab);

    const started = await lab.service.handle('startBatch', { batchId });
    expect(isErr(started)).toBe(false);
    if (isErr(started)) return;
    valid('startBatch', started.value);
    expect(started.value.batch.status).not.toBe('draft');

    const again = await lab.service.handle('startBatch', { batchId });
    expect(isErr(again)).toBe(true);
    if (!isErr(again)) return;
    expect(again.error[0]?.code).toBe('admin/illegal_transition');
  });

  it('refuses another preset once the batch has been started', async () => {
    const lab = await makeLab();
    const { batchId } = await draft(lab);
    await lab.service.handle('startBatch', { batchId });

    const again = await lab.service.handle('enqueuePreset', { batchId, choice: smoke() });
    expect(isErr(again)).toBe(true);
    if (!isErr(again)) return;
    expect(again.error[0]?.code).toBe('admin/illegal_transition');
  });
});

/* ------------------------------------------------------------- reordering */

describe('reordering a draft', () => {
  it('writes the order it was given and answers with the batch in it', async () => {
    const lab = await makeLab();
    const { batchId, jobIds } = await draft(lab);
    const reversed = [...jobIds].reverse();

    const answer = await lab.service.handle('reorderBatch', { batchId, jobIds: reversed });
    expect(isErr(answer)).toBe(false);
    if (isErr(answer)) return;
    valid('reorderBatch', answer.value);

    expect(answer.value.batch.jobIds).toEqual(reversed);
    expect(answer.value.jobs.map((job) => job.jobId)).toEqual(reversed);
  });

  it('refuses an order that has lost a job, and writes nothing', async () => {
    const lab = await makeLab();
    const { batchId, jobIds } = await draft(lab);

    const answer = await lab.service.handle('reorderBatch', {
      batchId,
      jobIds: jobIds.slice(0, 2),
    });
    expect(isErr(answer)).toBe(true);
    if (!isErr(answer)) return;
    expect(answer.error[0]?.code).toBe('admin/schema');
    expect(answer.error[0]?.message).toContain(jobIds[2] ?? 'missing');

    const detail = await lab.service.handle('batchDetail', { batchId });
    if (isErr(detail)) throw new Error('unreadable');
    expect(detail.value.batch.jobIds).toEqual(jobIds);
  });

  it('refuses an order naming a job that is not in this batch', async () => {
    const lab = await makeLab();
    const first = await draft(lab);
    const second = await draft(lab);

    const answer = await lab.service.handle('reorderBatch', {
      batchId: first.batchId,
      jobIds: [...first.jobIds.slice(1), second.jobIds[0] as JobId],
    });
    expect(isErr(answer)).toBe(true);
    if (!isErr(answer)) return;
    expect(answer.error[0]?.message).toContain('which is not in this batch');
  });

  it('refuses the stale order a second screen would send after a job was added', async () => {
    // The concurrent-update case, and the reason the request carries the *whole*
    // order rather than a move. One screen read three jobs; another duplicated
    // one; the first screen's reorder now describes a batch that no longer
    // exists, and it is told exactly that instead of quietly dropping the fourth.
    const lab = await makeLab();
    const { batchId, jobIds } = await draft(lab);
    const stale = [...jobIds].reverse();

    await lab.service.handle('duplicateJob', { jobId: jobIds[0] as JobId });

    const answer = await lab.service.handle('reorderBatch', { batchId, jobIds: stale });
    expect(isErr(answer)).toBe(true);
    if (!isErr(answer)) return;
    expect(answer.error[0]?.message).toContain('The batch changed after this order was read');

    const detail = await lab.service.handle('batchDetail', { batchId });
    if (isErr(detail)) throw new Error('unreadable');
    expect(detail.value.jobs).toHaveLength(4);
  });

  it('refuses to reorder a batch that has been started', async () => {
    const lab = await makeLab();
    const { batchId, jobIds } = await draft(lab);
    await lab.service.handle('startBatch', { batchId });

    const answer = await lab.service.handle('reorderBatch', {
      batchId,
      jobIds: [...jobIds].reverse(),
    });
    expect(isErr(answer)).toBe(true);
    if (!isErr(answer)) return;
    expect(answer.error[0]?.code).toBe('admin/illegal_transition');
  });
});

/* ------------------------------------------------------------- duplicating */

describe('duplicating a job in a draft', () => {
  it('puts the copy immediately after its source', async () => {
    const lab = await makeLab();
    const { jobIds } = await draft(lab);

    const answer = await lab.service.handle('duplicateJob', { jobId: jobIds[0] as JobId });
    expect(isErr(answer)).toBe(false);
    if (isErr(answer)) return;
    valid('duplicateJob', answer.value);

    const order = answer.value.jobs.map((job) => job.jobId);
    expect(order).toHaveLength(4);
    expect(order[0]).toBe(jobIds[0]);
    expect(order.slice(2)).toEqual(jobIds.slice(1));
    expect(order[1]).not.toBe(jobIds[0]);
  });

  it('gives the copy its own seed family, so it is not the same run twice', async () => {
    // The one thing a duplicate must not be. Two jobs on one seed play the same
    // matches, and the catalog would then hold two records that look like
    // independent evidence and are one measurement counted twice.
    const lab = await makeLab();
    const { jobIds } = await draft(lab);
    const source = unwrap(await lab.store.readJob(jobIds[0] as JobId));

    const answer = await lab.service.handle('duplicateJob', { jobId: jobIds[0] as JobId });
    if (isErr(answer)) throw new Error(JSON.stringify(answer.error));
    const copy = answer.value.jobs[1] as CatalogJobView;

    expect(copy.spec.seed).not.toBe(source.spec.seed);
    expect(copy.spec.seed).toBe(`${source.spec.seed}|c2`);
    expect(copy.spec.experimentId).toBe(`${source.spec.experimentId}-c2`);
    expect(copy.spec.configHash).not.toBe(source.spec.configHash);
  });

  it('keeps the origin, so a copy of a preset stage still carries its limitations', async () => {
    const lab = await makeLab();
    const { jobIds } = await draft(lab);
    const source = unwrap(await lab.store.readJob(jobIds[0] as JobId));

    const answer = await lab.service.handle('duplicateJob', { jobId: jobIds[0] as JobId });
    if (isErr(answer)) throw new Error(JSON.stringify(answer.error));
    const copy = answer.value.jobs[1] as CatalogJobView;

    expect(copy.origin).toEqual(source.origin);
    expect(copy.purpose).toBe(source.purpose);
    expect(copy.sourceClasses).toEqual(source.sourceClasses);
  });

  it('numbers a copy of a copy from the base rather than nesting suffixes', async () => {
    const lab = await makeLab();
    const { jobIds } = await draft(lab);

    const first = await lab.service.handle('duplicateJob', { jobId: jobIds[0] as JobId });
    if (isErr(first)) throw new Error('refused');
    const copy = first.value.jobs[1] as CatalogJobView;

    const second = await lab.service.handle('duplicateJob', { jobId: copy.jobId });
    if (isErr(second)) throw new Error('refused');
    const grandchild = second.value.jobs[2] as CatalogJobView;

    expect(grandchild.spec.experimentId).toBe('precon-smoke-r1-c3');
    expect(grandchild.spec.seed).toBe('preset-2026-08|r1|c3');
  });

  it('refuses to duplicate into a batch that has been started', async () => {
    const lab = await makeLab();
    const { batchId, jobIds } = await draft(lab);
    await lab.service.handle('startBatch', { batchId });

    const answer = await lab.service.handle('duplicateJob', { jobId: jobIds[0] as JobId });
    expect(isErr(answer)).toBe(true);
    if (!isErr(answer)) return;
    expect(answer.error[0]?.code).toBe('admin/illegal_transition');
  });
});

/* --------------------------------------------------------------- removing */

describe('removing a job before start', () => {
  it('is the existing cancel verb, and the job stays in its batch as cancelled', async () => {
    // M08.9 adds no removal address. ADR 0023 §3 gives this workspace no delete,
    // and a job withdrawn from a draft is a job that will never run — which the
    // lifecycle table has been able to say since M08.1.
    const lab = await makeLab();
    const { batchId, jobIds } = await draft(lab);

    const withdrawn = await lab.service.handle('jobAction', {
      jobId: jobIds[1] as JobId,
      action: 'cancel',
    });
    expect(isErr(withdrawn)).toBe(false);
    if (isErr(withdrawn)) return;
    expect(withdrawn.value.status).toBe('cancelled');

    const detail = await lab.service.handle('batchDetail', { batchId });
    if (isErr(detail)) throw new Error('unreadable');
    expect(detail.value.jobs.map((job) => job.jobId)).toEqual(jobIds);
    expect(detail.value.jobs.map((job) => job.status)).toEqual(['queued', 'cancelled', 'queued']);
  });

  it('never runs a withdrawn job when the batch is started', async () => {
    const lab = await makeLab();
    const { batchId, jobIds } = await draft(lab);
    for (const jobId of jobIds) await lab.service.handle('jobAction', { jobId, action: 'cancel' });

    await lab.service.handle('startBatch', { batchId });
    await new Promise((settle) => setTimeout(settle, 40));
    expect(lab.started()).toBe(0);
  });

  it('settles a batch whose every job was withdrawn, rather than leaving it queued forever', async () => {
    const lab = await makeLab();
    const { batchId, jobIds } = await draft(lab);
    for (const jobId of jobIds) await lab.service.handle('jobAction', { jobId, action: 'cancel' });

    const started = await lab.service.handle('startBatch', { batchId });
    if (isErr(started)) throw new Error('refused');
    expect(detailOf(started.value).batch.status).toBe('completed');
  });
});

/* ------------------------------------------------- what the batch then says */

describe('a batch says what its members did', () => {
  it('moves to completed once every member has finished', async () => {
    const lab = await makeLab();
    const { batchId } = await draft(lab);
    await lab.service.handle('startBatch', { batchId });

    for (let waited = 0; waited < 60; waited += 1) {
      const detail = await lab.service.handle('batchDetail', { batchId });
      if (isErr(detail)) throw new Error('unreadable');
      if (detail.value.batch.status === 'completed') {
        expect(detail.value.jobs.every((job) => job.status === 'completed')).toBe(true);
        expect(detail.value.batch.timestamps.startedAt).not.toBeNull();
        return;
      }
      await new Promise((settle) => setTimeout(settle, 25));
    }
    throw new Error('the batch never settled');
  });
});
