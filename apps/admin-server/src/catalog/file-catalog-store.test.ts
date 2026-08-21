import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CATALOG_DOCUMENT_VERSION,
  JOB_STATUSES,
  NO_ANNOTATIONS,
  NO_CATALOG_FILTER,
  catalogFilterSchema,
  catalogJobViewOf,
  jobTransition,
  type CatalogJobDocument,
} from '@tcg/admin-contracts';
import { isErr, isOk, unwrap } from '@tcg/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { jobMatchesFilter } from './file-catalog-store.js';
import type { CatalogPage } from './store.js';
import {
  makeTestCatalog,
  sequentialIdSources,
  testIdentity,
  type TestCatalog,
} from './test-catalog.js';

let catalog: TestCatalog;

beforeEach(async () => {
  catalog = await makeTestCatalog();
});

afterEach(async () => {
  await catalog.dispose();
});

/** A draft batch holding one queued job, which most tests start from. */
async function seedJob(label = 'Precon smoke'): Promise<CatalogJobDocument> {
  const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
  return unwrap(
    await catalog.store.createJob({
      batchId: batch.batchId,
      label,
      purpose: 'exploration',
      sourceClasses: ['ai', 'precon'],
    }),
  );
}

describe('creating entries', () => {
  it('mints its own identifiers, and a caller has no way to supply one', () => {
    // `admin/duplicate_id` exists because minting is the store's job. The input
    // types are the structural form of that: there is no field to put an ID in.
    const input = { batchId: 'batch_x', label: '', purpose: 'exploration', sourceClasses: ['ai'] };
    expect(Object.keys(input)).not.toContain('jobId');
  });

  it('creates a batch as a draft with no members and no completion instant', async () => {
    const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
    expect(batch.status).toBe('draft');
    expect(batch.jobIds).toEqual([]);
    expect(batch.documentVersion).toBe(CATALOG_DOCUMENT_VERSION);
    expect(batch.timestamps.completedAt).toBeNull();
    expect(batch.timestamps.startedAt).toBeNull();
    expect(batch.annotations).toEqual(NO_ANNOTATIONS);
  });

  it('creates a job queued, unstarted, with no result and no failure', async () => {
    const job = await seedJob();
    expect(job.status).toBe('queued');
    expect(job.result).toBeNull();
    expect(job.failure).toBeNull();
    expect(job.progress.completedMatches).toBe(0);
    expect(job.progress.scheduledMatches).toBeNull();
  });

  it('writes documents a fresh read validates, so nothing is trusted in one direction only', async () => {
    const job = await seedJob();
    const read = unwrap(await catalog.store.readJob(job.jobId));
    expect(read).toEqual(job);
  });

  it('names the file after the ID, which is why the ID alphabet is what it is', async () => {
    const job = await seedJob();
    const onDisk = await readFile(join(catalog.catalogRoot, 'jobs', `${job.jobId}.json`), 'utf8');
    expect(JSON.parse(onDisk)).toEqual(job);
    expect(job.jobId).toMatch(/^job_[a-z0-9]{6,40}$/);
  });

  it('refuses to add a job to a batch that does not exist', async () => {
    const created = await catalog.store.createJob({
      batchId: 'batch_absent00001',
      label: 'orphan',
      purpose: 'exploration',
      sourceClasses: ['ai'],
    });
    expect(isErr(created) && created.error[0]?.code).toBe('admin/unknown_batch');
  });

  it('refuses an identifier that is not one, without touching the filesystem', async () => {
    const read = await catalog.store.readJob('job_UPPER');
    expect(isErr(read) && read.error[0]?.code).toBe('admin/unknown_job');
  });
});

describe('duplicate identifiers are refused rather than overwritten', () => {
  it('refuses a second batch minted onto an existing one, and leaves the first intact', async () => {
    const minter = sequentialIdSources();
    const store = (await makeTestCatalog({ idSources: minter.sources })).store;

    const first = unwrap(await store.createBatch({ label: 'first' }));
    minter.repeatLast();
    const second = await store.createBatch({ label: 'second' });

    expect(isErr(second) && second.error[0]?.code).toBe('admin/duplicate_id');
    expect(unwrap(await store.readBatch(first.batchId)).label).toBe('first');
  });

  it('refuses a duplicate job, and does not add it to the batch either', async () => {
    const minter = sequentialIdSources();
    const test = await makeTestCatalog({ idSources: minter.sources });
    const batch = unwrap(await test.store.createBatch({ label: 'Wave 1' }));

    const first = unwrap(
      await test.store.createJob({
        batchId: batch.batchId,
        label: 'first',
        purpose: 'exploration',
        sourceClasses: ['ai'],
      }),
    );
    minter.repeatLast();
    const second = await test.store.createJob({
      batchId: batch.batchId,
      label: 'second',
      purpose: 'exploration',
      sourceClasses: ['ai'],
    });

    expect(isErr(second) && second.error[0]?.code).toBe('admin/duplicate_id');
    expect(unwrap(await test.store.readBatch(batch.batchId)).jobIds).toEqual([first.jobId]);
    expect(unwrap(await test.store.readJob(first.jobId)).label).toBe('first');
    await test.dispose();
  });
});

describe('ordered batch membership, with independent jobs', () => {
  it('keeps members in the order they were created, not in a sort', async () => {
    const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
    const labels = ['third', 'first', 'second'];
    const created: string[] = [];
    for (const label of labels) {
      const job = unwrap(
        await catalog.store.createJob({
          batchId: batch.batchId,
          label,
          purpose: 'exploration',
          sourceClasses: ['ai'],
        }),
      );
      created.push(job.jobId);
    }

    expect(unwrap(await catalog.store.readBatch(batch.batchId)).jobIds).toEqual(created);
    const members = unwrap(await catalog.store.readBatchJobs(batch.batchId));
    expect(members.map((job) => job.label)).toEqual(labels);
  });

  it('moves one job without moving its siblings or its batch', async () => {
    const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
    const make = async (label: string) =>
      unwrap(
        await catalog.store.createJob({
          batchId: batch.batchId,
          label,
          purpose: 'exploration',
          sourceClasses: ['ai'],
        }),
      );
    const one = await make('one');
    const two = await make('two');
    const batchBefore = unwrap(await catalog.store.readBatch(batch.batchId));

    catalog.advance(1_000);
    unwrap(await catalog.store.applyJobAction({ jobId: one.jobId, action: 'start' }));

    expect(unwrap(await catalog.store.readJob(one.jobId)).status).toBe('running');
    expect(unwrap(await catalog.store.readJob(two.jobId))).toEqual(two);
    expect(unwrap(await catalog.store.readBatch(batch.batchId))).toEqual(batchBefore);
  });

  it('runs concurrent mutations of two jobs without either losing its change', async () => {
    const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
    const jobs: string[] = [];
    for (const label of ['a', 'b', 'c', 'd']) {
      jobs.push(
        unwrap(
          await catalog.store.createJob({
            batchId: batch.batchId,
            label,
            purpose: 'exploration',
            sourceClasses: ['ai'],
          }),
        ).jobId,
      );
    }

    await Promise.all(
      jobs.map((jobId) => catalog.store.applyJobAction({ jobId, action: 'start' })),
    );
    for (const jobId of jobs) {
      expect(unwrap(await catalog.store.readJob(jobId)).status).toBe('running');
    }
  });

  it('serializes concurrent mutations of the same job, so neither reads a stale state', async () => {
    // The discriminating case for the per-document lock. `pause` is legal from
    // `running` and illegal from `queued`, so if both calls read the document
    // before either wrote it, the second refuses. Serialized, the second reads
    // what the first wrote and the job ends up `pausing`.
    const job = await seedJob();
    const [started, paused] = await Promise.all([
      catalog.store.applyJobAction({ jobId: job.jobId, action: 'start' }),
      catalog.store.applyJobAction({ jobId: job.jobId, action: 'pause' }),
    ]);

    expect(isOk(started)).toBe(true);
    expect(isOk(paused)).toBe(true);
    expect(unwrap(await catalog.store.readJob(job.jobId)).status).toBe('pausing');
  });

  it('applies every racing write rather than losing one under the last', async () => {
    const job = await seedJob();
    await Promise.all([
      catalog.store.setJobAnnotations(job.jobId, { ...NO_ANNOTATIONS, note: 'one' }),
      catalog.store.setJobAnnotations(job.jobId, { ...NO_ANNOTATIONS, note: 'two' }),
      catalog.store.setJobAnnotations(job.jobId, { ...NO_ANNOTATIONS, note: 'three' }),
    ]);

    const notes = unwrap(await catalog.store.readJobEvents(job.jobId))
      .events.filter((event) => event.kind === 'annotated')
      .map((event) => (event.kind === 'annotated' ? event.annotations.note : ''));
    expect([...notes].sort()).toEqual(['one', 'three', 'two']);
    // The document holds the last write, and the log holds all three in order.
    expect(unwrap(await catalog.store.readJob(job.jobId)).annotations.note).toBe(notes.at(-1));
  });

  it('never hands a reader a half-written document while one is being rewritten', async () => {
    // The atomicity guarantee in its real setting. A job is rewritten many times
    // with documents of very different sizes while a reader keeps asking for it
    // through the store; every answer is a complete, schema-valid document.
    //
    // In-process this holds for two reasons working together: the write is a
    // temporary file and a `rename`, and reads take the same per-document lock
    // writes do. The second matters on Windows, where replacing a file another
    // handle has open fails outright rather than waiting.
    const job = await seedJob();
    unwrap(await catalog.store.applyJobAction({ jobId: job.jobId, action: 'start' }));

    let writing = true;
    let reads = 0;
    const reader = (async () => {
      while (writing) {
        const read = unwrap(await catalog.store.readJob(job.jobId));
        expect(read.jobId).toBe(job.jobId);
        expect(read.progress.completedMatches).toBeGreaterThanOrEqual(0);
        reads += 1;
      }
    })();

    const writer = (async () => {
      for (let played = 1; played <= 40; played += 1) {
        unwrap(
          await catalog.store.setJobAnnotations(job.jobId, {
            ...NO_ANNOTATIONS,
            note: 'n'.repeat(played * 80),
          }),
        );
        unwrap(
          await catalog.store.setJobProgress(job.jobId, {
            completedMatches: played,
            scheduledMatches: 40,
            scheduledIsBound: false,
            stage: null,
            elapsedMs: played * 10,
          }),
        );
      }
      writing = false;
    })();

    await Promise.all([reader, writer]);
    expect(reads).toBeGreaterThan(5);
    expect(unwrap(await catalog.store.readJob(job.jobId)).progress.completedMatches).toBe(40);
  });

  it('refuses a job added to a batch whose ordering has been settled', async () => {
    const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
    unwrap(await catalog.store.applyBatchAction(batch.batchId, 'enqueue'));

    const late = await catalog.store.createJob({
      batchId: batch.batchId,
      label: 'late',
      purpose: 'exploration',
      sourceClasses: ['ai'],
    });
    expect(isErr(late) && late.error[0]?.code).toBe('admin/illegal_transition');
    expect(isErr(late) && late.error[0]?.message).toContain('settled ordering');
  });
});

describe('lifecycle transitions go through the contract, never around it', () => {
  it('applies a legal action and records where it landed', async () => {
    const job = await seedJob();
    const started = unwrap(
      await catalog.store.applyJobAction({ jobId: job.jobId, action: 'start' }),
    );
    expect(started.status).toBe('running');
    expect(started.timestamps.startedAt).not.toBeNull();
    expect(started.timestamps.completedAt).toBeNull();
  });

  it('refuses an illegal one and names what was available instead', async () => {
    const job = await seedJob();
    const paused = await catalog.store.applyJobAction({ jobId: job.jobId, action: 'pause' });
    expect(isErr(paused) && paused.error[0]?.code).toBe('admin/illegal_transition');
    expect(isErr(paused) && paused.error[0]?.context?.available).toEqual(['start', 'cancel']);
    expect(unwrap(await catalog.store.readJob(job.jobId)).status).toBe('queued');
  });

  it('gives a terminal job a completion instant and a non-terminal one none', async () => {
    const job = await seedJob();
    unwrap(await catalog.store.applyJobAction({ jobId: job.jobId, action: 'start' }));
    catalog.advance(5_000);
    const done = unwrap(
      await catalog.store.applyJobAction({ jobId: job.jobId, action: 'complete' }),
    );
    expect(done.status).toBe('completed');
    expect(done.timestamps.completedAt).toBe(catalog.now());
  });

  it('clears the completion instant on retry, so a queued job never claims it finished', async () => {
    const job = await seedJob();
    unwrap(await catalog.store.applyJobAction({ jobId: job.jobId, action: 'start' }));
    const failed = unwrap(
      await catalog.store.applyJobAction({
        jobId: job.jobId,
        action: 'fail',
        cause: 'runner',
        failure: {
          severity: 'error',
          code: 'admin/schema',
          message: 'The configuration no longer matches current content.',
        },
      }),
    );
    expect(failed.timestamps.completedAt).not.toBeNull();
    expect(failed.failure?.code).toBe('admin/schema');

    const retried = unwrap(
      await catalog.store.applyJobAction({ jobId: job.jobId, action: 'retry' }),
    );
    expect(retried.status).toBe('queued');
    expect(retried.timestamps.completedAt).toBeNull();
    // The start instant is kept: the job really did start once, and M08.5 needs
    // the elapsed history a cleared one would erase.
    expect(retried.timestamps.startedAt).not.toBeNull();
  });

  it('records every move in the log, so retry is visible and not a silent success', async () => {
    const job = await seedJob();
    for (const action of ['start', 'fail', 'retry', 'start', 'complete'] as const) {
      unwrap(await catalog.store.applyJobAction({ jobId: job.jobId, action }));
      catalog.advance(1_000);
    }

    const log = unwrap(await catalog.store.readJobEvents(job.jobId));
    expect(log.skipped).toEqual([]);
    expect(log.events[0]?.kind).toBe('created');
    expect(
      log.events.filter((event) => event.kind === 'transition').map((event) => event.action),
    ).toEqual(['start', 'fail', 'retry', 'start', 'complete']);
    // The document alone would spell `completed`, and would not say it failed once.
    expect(unwrap(await catalog.store.readJob(job.jobId)).status).toBe('completed');
  });

  it('separates who decided a move from what the move was', async () => {
    const job = await seedJob();
    unwrap(await catalog.store.applyJobAction({ jobId: job.jobId, action: 'start' }));
    unwrap(
      await catalog.store.applyJobAction({ jobId: job.jobId, action: 'cancel', cause: 'operator' }),
    );

    const log = unwrap(await catalog.store.readJobEvents(job.jobId));
    const causes = log.events
      .filter((event) => event.kind === 'transition')
      .map((event) => event.cause);
    expect(causes).toEqual(['operator', 'operator']);
  });

  it('moves a batch through its own table, which is not the job table', async () => {
    const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
    unwrap(await catalog.store.applyBatchAction(batch.batchId, 'enqueue'));
    const running = unwrap(await catalog.store.applyBatchAction(batch.batchId, 'start'));
    expect(running.status).toBe('running');
    expect(running.timestamps.startedAt).not.toBeNull();

    // There is no batch `interrupt` and no batch `fail`: a batch owns no worker.
    const interrupted = await catalog.store.applyBatchAction(batch.batchId, 'interrupt' as never);
    expect(isErr(interrupted) && interrupted.error[0]?.code).toBe('admin/illegal_transition');
  });
});

describe('progress is stored and is not history', () => {
  it('records progress on the document', async () => {
    const job = await seedJob();
    unwrap(await catalog.store.applyJobAction({ jobId: job.jobId, action: 'start' }));
    const moved = unwrap(
      await catalog.store.setJobProgress(job.jobId, {
        completedMatches: 12,
        scheduledMatches: 40,
        scheduledIsBound: false,
        stage: null,
        elapsedMs: 4_000,
      }),
    );
    expect(moved.progress.completedMatches).toBe(12);
  });

  it('refuses progress the contract calls impossible, and leaves the document alone', async () => {
    const job = await seedJob();
    const bad = await catalog.store.setJobProgress(job.jobId, {
      completedMatches: 41,
      scheduledMatches: 40,
      scheduledIsBound: false,
      stage: null,
      elapsedMs: null,
    });
    expect(isErr(bad) && bad.error[0]?.code).toBe('admin/schema');
    expect(unwrap(await catalog.store.readJob(job.jobId)).progress.completedMatches).toBe(0);
  });

  it('writes no log line for a counter, so the four decision kinds stay findable', async () => {
    const job = await seedJob();
    unwrap(await catalog.store.applyJobAction({ jobId: job.jobId, action: 'start' }));
    for (let played = 1; played <= 5; played += 1) {
      unwrap(
        await catalog.store.setJobProgress(job.jobId, {
          completedMatches: played,
          scheduledMatches: 40,
          scheduledIsBound: false,
          stage: null,
          elapsedMs: null,
        }),
      );
    }
    const log = unwrap(await catalog.store.readJobEvents(job.jobId));
    expect(log.events).toHaveLength(2);
  });
});

describe('annotations are stored beside the run', () => {
  it('replaces the block and logs the replacement', async () => {
    const job = await seedJob();
    const annotated = unwrap(
      await catalog.store.setJobAnnotations(job.jobId, {
        tags: ['precon-smoke', 'wave-1'],
        note: 'Tested after the Q49 token change.',
        baseline: true,
      }),
    );
    expect(annotated.annotations.baseline).toBe(true);

    const log = unwrap(await catalog.store.readJobEvents(job.jobId));
    const last = log.events.at(-1);
    expect(last?.kind).toBe('annotated');
    expect(last?.kind === 'annotated' && last.annotations.tags).toEqual(['precon-smoke', 'wave-1']);
  });

  it('keeps the previous block readable after it was replaced', async () => {
    // M08.27 requires annotations to be additive and never to rewrite history.
    // The document is replaced; the log is not.
    const job = await seedJob();
    unwrap(await catalog.store.setJobAnnotations(job.jobId, { ...NO_ANNOTATIONS, note: 'first' }));
    unwrap(await catalog.store.setJobAnnotations(job.jobId, { ...NO_ANNOTATIONS, note: 'second' }));

    const notes = unwrap(await catalog.store.readJobEvents(job.jobId))
      .events.filter((event) => event.kind === 'annotated')
      .map((event) => (event.kind === 'annotated' ? event.annotations.note : ''));
    expect(notes).toEqual(['first', 'second']);
  });

  it('refuses an annotation block the contract calls illegal', async () => {
    const job = await seedJob();
    const bad = await catalog.store.setJobAnnotations(job.jobId, {
      ...NO_ANNOTATIONS,
      tags: ['same', 'same'],
    });
    expect(isErr(bad) && bad.error[0]?.code).toBe('admin/schema');
  });
});

describe('a result is a reference, and never a copy', () => {
  it('links a run and records its identity in the log', async () => {
    const job = await seedJob();
    const attached = unwrap(
      await catalog.store.attachJobResult(job.jobId, {
        identity: testIdentity(),
        location: { rootId: 'local', directory: 'precon-smoke' },
      }),
    );
    expect(attached.result?.identity.experimentId).toBe('precon-smoke');

    const last = unwrap(await catalog.store.readJobEvents(job.jobId)).events.at(-1);
    expect(last?.kind).toBe('result_attached');
    expect(JSON.stringify(last)).not.toContain('rootId');
  });

  it('holds no field that could carry a number a run produced', async () => {
    const job = await seedJob();
    const attached = unwrap(
      await catalog.store.attachJobResult(job.jobId, {
        identity: testIdentity(),
        location: { rootId: 'local', directory: 'precon-smoke' },
      }),
    );
    const flattened = JSON.stringify(attached);
    for (const word of ['winRate', 'wins', 'losses', 'summary', 'report']) {
      expect(flattened).not.toContain(word);
    }
  });

  it('strips the location on the way to a client, through the contract’s one route', async () => {
    const job = await seedJob();
    const attached = unwrap(
      await catalog.store.attachJobResult(job.jobId, {
        identity: testIdentity(),
        location: { rootId: 'local', directory: 'precon-smoke' },
      }),
    );
    const view = catalogJobViewOf(attached);
    expect(JSON.stringify(view)).not.toContain('local');
    expect(view.result?.identity.experimentId).toBe('precon-smoke');
  });
});

describe('a document written by something else is refused, not loaded', () => {
  it('reports unparseable bytes and leaves the file where it is', async () => {
    const job = await seedJob();
    const path = join(catalog.catalogRoot, 'jobs', `${job.jobId}.json`);
    await writeFile(path, '{ this is not json', 'utf8');

    const read = await catalog.store.readJob(job.jobId);
    expect(isErr(read) && read.error[0]?.code).toBe('admin/malformed');
    expect(await readFile(path, 'utf8')).toBe('{ this is not json');
  });

  it('refuses a document from a newer build with the repository’s sentence', async () => {
    const job = await seedJob();
    const path = join(catalog.catalogRoot, 'jobs', `${job.jobId}.json`);
    await writeFile(
      path,
      JSON.stringify({ ...job, documentVersion: CATALOG_DOCUMENT_VERSION + 1 }),
      'utf8',
    );

    const read = await catalog.store.readJob(job.jobId);
    expect(isErr(read) && read.error[0]?.code).toBe('admin/unsupported_version');
    expect(isErr(read) && read.error[0]?.message).toContain('written by a newer build');
    expect(isErr(read) && read.error[0]?.message).toContain('Update the application.');
  });

  it('refuses a document whose status and timestamps disagree', async () => {
    // `statusTimestampProblems` is the contract's rule and the store applies it
    // on read as well as on write, so a hand-edited file cannot smuggle a
    // completed job that never finished into a listing.
    const job = await seedJob();
    const path = join(catalog.catalogRoot, 'jobs', `${job.jobId}.json`);
    await writeFile(path, JSON.stringify({ ...job, status: 'completed' }), 'utf8');

    const read = await catalog.store.readJob(job.jobId);
    expect(isErr(read) && read.error[0]?.code).toBe('admin/schema');
    expect(isErr(read) && read.error[0]?.message).toContain('completedAt');
  });

  it('reports a damaged entry in a listing rather than hiding it or failing the page', async () => {
    const good = await seedJob('good');
    const bad = await seedJob('bad');
    await writeFile(join(catalog.catalogRoot, 'jobs', `${bad.jobId}.json`), 'nonsense', 'utf8');

    const page = unwrap(await catalog.store.listJobs());
    expect(page.items.map((job) => job.jobId)).toEqual([good.jobId]);
    expect(page.unreadable).toHaveLength(1);
    expect(page.unreadable[0]?.id).toBe(bad.jobId);
    expect(page.unreadable[0]?.errors[0]?.code).toBe('admin/malformed');
  });
});

describe('listing, filtering and paging', () => {
  async function seedMany(count: number): Promise<CatalogJobDocument[]> {
    const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
    const jobs: CatalogJobDocument[] = [];
    for (let index = 0; index < count; index += 1) {
      catalog.advance(1_000);
      jobs.push(
        unwrap(
          await catalog.store.createJob({
            batchId: batch.batchId,
            label: `job ${String(index)}`,
            purpose: index % 2 === 0 ? 'exploration' : 'validation',
            sourceClasses: index % 2 === 0 ? ['ai', 'precon'] : ['human'],
          }),
        ),
      );
    }
    return jobs;
  }

  it('orders by creation instant then identifier', async () => {
    const jobs = await seedMany(5);
    const page = unwrap(await catalog.store.listJobs());
    expect(page.items.map((job) => job.jobId)).toEqual(jobs.map((job) => job.jobId));
    expect(page.page.total).toBe(5);
  });

  it('walks every row exactly once across pages, and stops when the cursor is null', async () => {
    const jobs = await seedMany(7);
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page: CatalogPage<CatalogJobDocument> = unwrap(
        await catalog.store.listJobs(NO_CATALOG_FILTER, { limit: 3, cursor }),
      );
      seen.push(...page.items.map((job) => job.jobId));
      cursor = page.page.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(10);
    } while (cursor !== null);

    expect(seen).toEqual(jobs.map((job) => job.jobId));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('does not skip or repeat a row when an entry is created mid-listing', async () => {
    // A cursor is a position in an ordering rather than an offset, which is the
    // only form that survives the catalog growing while somebody reads it.
    const jobs = await seedMany(4);
    const first = unwrap(await catalog.store.listJobs(NO_CATALOG_FILTER, { limit: 2 }));

    catalog.advance(1_000);
    const late = unwrap(
      await catalog.store.createJob({
        batchId: jobs[0]?.batchId ?? '',
        label: 'late arrival',
        purpose: 'exploration',
        sourceClasses: ['ai'],
      }),
    );

    const second = unwrap(
      await catalog.store.listJobs(NO_CATALOG_FILTER, {
        limit: 10,
        cursor: first.page.nextCursor,
      }),
    );
    const seen = [...first.items, ...second.items].map((job) => job.jobId);
    expect(seen).toEqual([...jobs.map((job) => job.jobId), late.jobId]);
  });

  it('refuses a continuation token it did not issue', async () => {
    await seedMany(2);
    for (const cursor of ['not-a-real-cursor', Buffer.from('c9 x y').toString('base64url')]) {
      const page = await catalog.store.listJobs(NO_CATALOG_FILTER, { limit: 2, cursor });
      expect(isErr(page) && page.error[0]?.code).toBe('admin/invalid_cursor');
    }
  });

  it('bounds a page at the contract’s maximum, whatever was asked for', async () => {
    await seedMany(3);
    const page = await catalog.store.listJobs(NO_CATALOG_FILTER, { limit: 1_000 });
    expect(isErr(page) && page.error[0]?.code).toBe('admin/schema');
  });

  it('filters by status, purpose, source class, batch, tags and baseline', async () => {
    const jobs = await seedMany(4);
    const first = jobs[0];
    if (first === undefined) throw new Error('fixture');
    unwrap(await catalog.store.applyJobAction({ jobId: first.jobId, action: 'start' }));
    unwrap(
      await catalog.store.setJobAnnotations(first.jobId, {
        ...NO_ANNOTATIONS,
        tags: ['wave-1'],
        baseline: true,
      }),
    );

    const only = async (filter: Record<string, unknown>) =>
      unwrap(await catalog.store.listJobs(catalogFilterSchema.parse(filter))).items.map(
        (job) => job.jobId,
      );

    expect(await only({ status: ['running'] })).toEqual([first.jobId]);
    expect(await only({ purpose: 'validation' })).toHaveLength(2);
    expect(await only({ sourceClasses: ['human'] })).toHaveLength(2);
    expect(await only({ tags: ['wave-1'] })).toEqual([first.jobId]);
    expect(await only({ baseline: true })).toEqual([first.jobId]);
    expect(await only({ batchId: first.batchId })).toHaveLength(4);
  });

  it('ANDs across fields and ORs within one', async () => {
    const jobs = await seedMany(4);
    const filter = catalogFilterSchema.parse({
      purpose: 'exploration',
      sourceClasses: ['human', 'precon'],
    });
    const matched = unwrap(await catalog.store.listJobs(filter)).items;
    expect(matched).toHaveLength(2);
    expect(matched.every((job) => job.purpose === 'exploration')).toBe(true);
    expect(jobs).toHaveLength(4);
  });

  it('filters an inclusive created range', async () => {
    const jobs = await seedMany(4);
    const second = jobs[1];
    const third = jobs[2];
    if (second === undefined || third === undefined) throw new Error('fixture');
    const filter = catalogFilterSchema.parse({
      createdAfter: second.timestamps.createdAt,
      createdBefore: third.timestamps.createdAt,
    });
    expect(unwrap(await catalog.store.listJobs(filter)).items.map((job) => job.jobId)).toEqual([
      second.jobId,
      third.jobId,
    ]);
  });

  it('matches a run’s kind and content hash only once the run exists', async () => {
    // The honest limitation: `kinds` and `fullContentHash` read the run identity,
    // and a job acquires one when its experiment directory does. M08.4 is the
    // tranche that could give a job a kind before it runs.
    const job = await seedJob();
    const byKind = catalogFilterSchema.parse({ kinds: ['batch'] });
    expect(unwrap(await catalog.store.listJobs(byKind)).items).toEqual([]);

    unwrap(
      await catalog.store.attachJobResult(job.jobId, {
        identity: testIdentity(),
        location: { rootId: 'local', directory: 'precon-smoke' },
      }),
    );
    expect(unwrap(await catalog.store.listJobs(byKind)).items).toHaveLength(1);
    expect(
      unwrap(
        await catalog.store.listJobs(
          catalogFilterSchema.parse({ fullContentHash: '4444444444444444' }),
        ),
      ).items,
    ).toHaveLength(1);
  });

  it('lists batches by the same ordering', async () => {
    const created: string[] = [];
    for (const label of ['one', 'two', 'three']) {
      catalog.advance(1_000);
      created.push(unwrap(await catalog.store.createBatch({ label })).batchId);
    }
    expect(unwrap(await catalog.store.listBatches()).items.map((b) => b.batchId)).toEqual(created);
  });
});

describe('the filter predicate itself', () => {
  it('lets an empty filter match everything', async () => {
    const job = await seedJob();
    expect(jobMatchesFilter(job, NO_CATALOG_FILTER)).toBe(true);
  });

  it('is total over every job status', async () => {
    const job = await seedJob();
    for (const status of JOB_STATUSES) {
      const filter = catalogFilterSchema.parse({ status: [status] });
      expect(jobMatchesFilter({ ...job, status }, filter)).toBe(true);
      expect(
        JOB_STATUSES.filter((other) => other !== status).every(
          (other) => !jobMatchesFilter({ ...job, status: other }, filter),
        ),
      ).toBe(true);
    }
  });

  it('never has to answer for a status the lifecycle cannot reach', () => {
    // Every status this store can write is one the table declares, so the
    // predicate is total by construction rather than by enumeration.
    expect(JOB_STATUSES.some((status) => jobTransition(status, 'interrupt') === 'completed')).toBe(
      false,
    );
  });
});

describe('nothing in the store can express removing a run', () => {
  it('offers no delete, unlink or move of any kind', async () => {
    const store = catalog.store as unknown as Record<string, unknown>;
    for (const name of ['delete', 'deleteJob', 'remove', 'removeJob', 'purge', 'move']) {
      expect(typeof store[name]).toBe('undefined');
    }
  });

  it('keeps an experiment directory that has no catalog entry perfectly valid', async () => {
    // Nothing is written into the result root at all, so a run is a run whether
    // or not the catalog has heard of it.
    const listing = await catalog.store.listJobs();
    expect(isOk(listing)).toBe(true);
  });
});
