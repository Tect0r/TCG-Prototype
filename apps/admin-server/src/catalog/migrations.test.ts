import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { CATALOG_DOCUMENT_VERSION } from '@tcg/admin-contracts';
import { unwrap } from '@tcg/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateCatalogDocument } from './migrations.js';
import { makeTestCatalog, testConfig, type TestCatalog } from './test-catalog.js';

/**
 * `migrateCatalogDocument` is the one migration this repository has needed
 * (M08.R3, moving `CATALOG_DOCUMENT_VERSION` 4 → 5 for the widened `spec`/
 * `origin` unions). Two levels: the function's own rewrite rule in isolation,
 * and a hand-written v4 document proven readable end-to-end through the store
 * it is wired into.
 */

describe('migrateCatalogDocument, the rewrite rule in isolation', () => {
  it('rewrites a v4 document to the current version and touches nothing else', () => {
    const v4 = { documentVersion: 4, batchId: 'batch_x', label: 'Wave 1', jobIds: ['job_a'] };
    const migrated = migrateCatalogDocument(v4);
    expect(migrated).toEqual({ ...v4, documentVersion: CATALOG_DOCUMENT_VERSION });
  });

  it('leaves a document already at the current version alone, reporting no migration', () => {
    const current = { documentVersion: CATALOG_DOCUMENT_VERSION, batchId: 'batch_x' };
    expect(migrateCatalogDocument(current)).toBeNull();
  });

  it('does not touch a document too old to migrate, so it still falls through to the older-build refusal', () => {
    expect(migrateCatalogDocument({ documentVersion: 3, batchId: 'batch_x' })).toBeNull();
    expect(migrateCatalogDocument({ documentVersion: 1, batchId: 'batch_x' })).toBeNull();
  });

  it('does not touch a document from a build newer than this migration knows about', () => {
    expect(
      migrateCatalogDocument({ documentVersion: CATALOG_DOCUMENT_VERSION + 1, batchId: 'batch_x' }),
    ).toBeNull();
  });

  it('refuses to guess at something that is not a document at all', () => {
    expect(migrateCatalogDocument(null)).toBeNull();
    expect(migrateCatalogDocument('not an object')).toBeNull();
    expect(migrateCatalogDocument([1, 2, 3])).toBeNull();
    expect(migrateCatalogDocument({})).toBeNull();
  });
});

describe('a v4 document on disk, read through the store it was written for', () => {
  let catalog: TestCatalog;

  beforeEach(async () => {
    catalog = await makeTestCatalog();
  });

  afterEach(async () => {
    await catalog.dispose();
  });

  it('reads a batch written by the previous build as if it had always been this version', async () => {
    const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
    const path = join(catalog.catalogRoot, 'batches', `${batch.batchId}.json`);
    await writeFile(path, JSON.stringify({ ...batch, documentVersion: 4 }), 'utf8');

    const read = unwrap(await catalog.store.readBatch(batch.batchId));
    expect(read).toEqual(batch);

    // The document on disk is migrated only in memory, on read — the file itself
    // is left exactly as the older build wrote it, until something writes to it.
    expect((JSON.parse(await readFile(path, 'utf8')) as { documentVersion: number }).documentVersion).toBe(4);
  });

  it('reads a job written by the previous build, whose spec and origin already had this shape', async () => {
    const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
    const job = unwrap(
      await catalog.store.createJob({
        batchId: batch.batchId,
        label: 'Precon smoke',
        purpose: 'exploration',
        sourceClasses: ['ai', 'precon'],
        config: testConfig(),
      }),
    );
    // The pre-M08.R3 job document was exactly this shape: `spec.kind` from
    // `ExperimentKind` and `origin.kind` one of `preset`/`direct`/
    // `commander_championship` — both still legal under the widened unions, so
    // the only field a v4 → v5 document ever needed rewritten is the version
    // number itself.
    const path = join(catalog.catalogRoot, 'jobs', `${job.jobId}.json`);
    await writeFile(path, JSON.stringify({ ...job, documentVersion: 4 }), 'utf8');

    const read = unwrap(await catalog.store.readJob(job.jobId));
    expect(read).toEqual(job);
  });

  it('migrates a job on the way into a listing, not only on a direct read', async () => {
    const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
    const job = unwrap(
      await catalog.store.createJob({
        batchId: batch.batchId,
        label: 'Precon smoke',
        purpose: 'exploration',
        sourceClasses: ['ai', 'precon'],
        config: testConfig(),
      }),
    );
    const path = join(catalog.catalogRoot, 'jobs', `${job.jobId}.json`);
    await writeFile(path, JSON.stringify({ ...job, documentVersion: 4 }), 'utf8');

    const page = unwrap(await catalog.store.listJobs());
    expect(page.unreadable).toHaveLength(0);
    expect(page.items.map((item) => item.jobId)).toEqual([job.jobId]);
  });

  it('still refuses a document too old for this migration, with the older-build sentence', async () => {
    const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
    const path = join(catalog.catalogRoot, 'batches', `${batch.batchId}.json`);
    await writeFile(path, JSON.stringify({ ...batch, documentVersion: 3 }), 'utf8');

    const read = await catalog.store.readBatch(batch.batchId);
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error[0]?.code).toBe('admin/unsupported_version');
      expect(read.error[0]?.message).toContain('older build');
    }
  });
});
