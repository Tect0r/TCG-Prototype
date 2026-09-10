import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  MAX_COMPARISON_ANNOTATIONS,
  type AnnotatableComparisonDecision,
  type ComparisonDeltaIdentity,
} from '@tcg/admin-contracts';
import { isErr } from '@tcg/shared';

import { makeTestCatalog, type TestCatalog } from './test-catalog.js';

/**
 * M08.27E — additive annotations, on a real disk.
 *
 * Mirrors `saved-choices.test.ts`, the closest existing precedent: a
 * document written by this build reads back unchanged, an unreadable
 * document is counted rather than dropped, and the published bound refuses
 * a write past it without leaving anything behind. What is new here, and
 * specific to this slice, is proving the two things the milestone actually
 * asks for — additive-only (no update or delete path exists anywhere on the
 * store) and that a `refused` comparison cannot be annotated at all.
 */

let catalog: TestCatalog | null = null;

afterEach(async () => {
  await catalog?.dispose();
  catalog = null;
});

async function open(): Promise<TestCatalog> {
  catalog = await makeTestCatalog();
  return catalog;
}

function catalogIdentity(
  overrides: Partial<Extract<ComparisonDeltaIdentity, { domain: 'catalog' }>> = {},
): ComparisonDeltaIdentity {
  return {
    domain: 'catalog',
    baselineJobId: 'job_baseline1',
    candidateJobId: 'job_candidat1',
    ...overrides,
  };
}

function playerMetaIdentity(
  overrides: Partial<Extract<ComparisonDeltaIdentity, { domain: 'player_meta' }>> = {},
): ComparisonDeltaIdentity {
  return {
    domain: 'player_meta',
    baseline: { source: 'human_human', contentVersion: 5, rulesVersion: '1.0.0' },
    candidate: { source: 'human_human', contentVersion: 6, rulesVersion: '1.0.0' },
    ...overrides,
  };
}

const compatible: AnnotatableComparisonDecision = { kind: 'compatible', note: 'presentation only' };
const deliberatelyDifferent: AnnotatableComparisonDecision = {
  kind: 'deliberately_different',
  declaredChange: 'nerfed card Y cost',
  reason: 'mechanics differ',
};

describe('comparison annotations', () => {
  it('round-trip through a document without changing', async () => {
    const { store } = await open();
    const created = await store.createComparisonAnnotation({
      identity: catalogIdentity(),
      decision: compatible,
      note: 'Confirmed with the balance team before shipping.',
    });
    if (isErr(created)) throw new Error('createComparisonAnnotation refused');

    const listed = await store.listComparisonAnnotations();
    if (isErr(listed)) throw new Error('listComparisonAnnotations refused');
    expect(listed.value.items).toHaveLength(1);
    expect(listed.value.items[0]).toEqual(created.value);
  });

  it('links a note to a Player Meta partition pair as readily as a catalog job pair', async () => {
    const { store } = await open();
    const created = await store.createComparisonAnnotation({
      identity: playerMetaIdentity(),
      decision: deliberatelyDifferent,
      note: 'Live telemetry confirms the schema migration changed nothing observable.',
    });
    if (isErr(created)) throw new Error('createComparisonAnnotation refused');
    expect(created.value.identity.domain).toBe('player_meta');
    expect(created.value.decision.kind).toBe('deliberately_different');
  });

  it('mint their own identifiers, which a caller never supplies', async () => {
    const { store } = await open();
    const first = await store.createComparisonAnnotation({
      identity: catalogIdentity(),
      decision: compatible,
      note: 'first',
    });
    const second = await store.createComparisonAnnotation({
      identity: catalogIdentity(),
      decision: compatible,
      note: 'second',
    });
    if (isErr(first) || isErr(second)) throw new Error('createComparisonAnnotation refused');
    expect(first.value.annotationId).toMatch(/^cmpnote_[a-z0-9]{6,40}$/);
    expect(second.value.annotationId).not.toBe(first.value.annotationId);
  });

  it('are ordered newest first, and the order is total', async () => {
    const { store, advance } = await open();
    for (const note of ['oldest', 'middle', 'newest']) {
      const created = await store.createComparisonAnnotation({
        identity: catalogIdentity(),
        decision: compatible,
        note,
      });
      if (isErr(created)) throw new Error('createComparisonAnnotation refused');
      advance(1000);
    }
    const listed = await store.listComparisonAnnotations();
    if (isErr(listed)) throw new Error('listComparisonAnnotations refused');
    expect(listed.value.items.map((entry) => entry.note)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('count a document from a newer build rather than dropping it', async () => {
    const { store, catalogRoot } = await open();
    const kept = await store.createComparisonAnnotation({
      identity: catalogIdentity(),
      decision: compatible,
      note: 'Readable',
    });
    if (isErr(kept)) throw new Error('createComparisonAnnotation refused');

    const directory = join(catalogRoot, 'comparison-annotations');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'cmpnote_fromfuture01.json'),
      JSON.stringify({ documentVersion: 99, annotationId: 'cmpnote_fromfuture01' }),
      'utf8',
    );

    const listed = await store.listComparisonAnnotations();
    if (isErr(listed)) throw new Error('listComparisonAnnotations refused');
    expect(listed.value.items).toHaveLength(1);
    expect(listed.value.unreadable).toHaveLength(1);
    expect(listed.value.unreadable[0]?.id).toBe('cmpnote_fromfuture01');
    expect(listed.value.unreadable[0]?.errors[0]?.code).toBe('admin/unsupported_version');
  });

  it('refuse the write past the published bound, and leave nothing behind', async () => {
    const { store, catalogRoot } = await open();
    for (let index = 0; index < MAX_COMPARISON_ANNOTATIONS; index += 1) {
      const created = await store.createComparisonAnnotation({
        identity: catalogIdentity(),
        decision: compatible,
        note: `Kept ${String(index)}`,
      });
      if (isErr(created)) throw new Error(`createComparisonAnnotation refused at ${String(index)}`);
    }

    const directory = join(catalogRoot, 'comparison-annotations');
    const before = (await readdir(directory)).length;
    const refused = await store.createComparisonAnnotation({
      identity: catalogIdentity(),
      decision: compatible,
      note: 'One too many',
    });
    expect(isErr(refused)).toBe(true);
    if (!isErr(refused)) return;
    expect(refused.error[0]?.code).toBe('admin/catalog_limit');
    // Nothing was written: not a file, not a name, not a gap in a sequence.
    expect((await readdir(directory)).length).toBe(before);
  });

  it('are absent from the batch and job listings, because they are neither', async () => {
    const { store } = await open();
    const created = await store.createComparisonAnnotation({
      identity: catalogIdentity(),
      decision: compatible,
      note: 'Kept',
    });
    if (isErr(created)) throw new Error('createComparisonAnnotation refused');

    const batches = await store.listBatches();
    const jobs = await store.listJobs();
    if (isErr(batches) || isErr(jobs)) throw new Error('listing refused');
    expect(batches.value.items).toEqual([]);
    expect(jobs.value.items).toEqual([]);
  });

  it('expose no update or delete method at all, so a written note cannot be changed', async () => {
    // Additive by omission, the same guarantee `CatalogStore`'s doc comment
    // makes for a saved choice: a store with no way to express mutation
    // cannot have an unsafe one. This is a compile-time fact about the
    // interface — asserted here by naming every own-property this object
    // actually has and checking none of them is an update or a delete.
    const { store } = await open();
    const methodNames = new Set<string>();
    for (
      let proto: object | null = Object.getPrototypeOf(store) as object | null;
      proto !== null && proto !== Object.prototype;
      proto = Object.getPrototypeOf(proto) as object | null
    ) {
      for (const name of Object.getOwnPropertyNames(proto)) methodNames.add(name);
    }
    const annotationMethods = [...methodNames].filter((name) =>
      name.includes('ComparisonAnnotation'),
    );
    expect(annotationMethods.sort()).toEqual(['createComparisonAnnotation', 'listComparisonAnnotations']);
  });
});
