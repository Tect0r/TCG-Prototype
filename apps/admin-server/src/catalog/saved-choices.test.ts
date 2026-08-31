import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { MAX_SAVED_CHOICES, type PresetChoice } from '@tcg/admin-contracts';
import { isErr } from '@tcg/shared';

import { makeTestCatalog, type TestCatalog } from './test-catalog.js';

/**
 * M08.8 — a kept builder form, on a real disk.
 *
 * The store is where "save, reopen and duplicate" stops being a screen's promise
 * and becomes a document. Three things are asserted that only a filesystem can
 * answer: a document written by this build is read back as the same choice, a
 * document this build cannot read is **counted rather than dropped**, and the
 * published bound refuses the write that would exceed it without leaving a
 * partial record behind.
 *
 * The store is exercised directly rather than through the service, because the
 * service expands every choice before storing it and this suite needs to write
 * two hundred of them.
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

function choice(experimentId = 'kept-run'): PresetChoice {
  return {
    presetId: 'precon_standard',
    experimentId,
    seed: 'kept-seed',
    preconIds: ['precon_bastion_guardians', 'precon_goblin_swarm'],
    pilotIds: ['value'],
    settings: {
      workload: { mode: 'preset' },
      replicates: 1,
      mirrorSeats: true,
      retention: { replaySampleRate: 50 },
      workers: 1,
    },
  } as unknown as PresetChoice;
}

describe('saved test configurations', () => {
  it('round-trip through a document without changing', async () => {
    const { store } = await open();
    const created = await store.createSavedChoice({ label: 'Kept', choice: choice() });
    if (isErr(created)) throw new Error('createSavedChoice refused');

    const listed = await store.listSavedChoices();
    if (isErr(listed)) throw new Error('listSavedChoices refused');
    expect(listed.value.items).toHaveLength(1);
    expect(listed.value.items[0]).toEqual(created.value);
  });

  it('mint their own identifiers, which a caller never supplies', async () => {
    const { store } = await open();
    const first = await store.createSavedChoice({ label: 'One', choice: choice('a') });
    const second = await store.createSavedChoice({ label: 'Two', choice: choice('b') });
    if (isErr(first) || isErr(second)) throw new Error('createSavedChoice refused');
    expect(first.value.savedChoiceId).toMatch(/^saved_[a-z0-9]{6,40}$/);
    expect(second.value.savedChoiceId).not.toBe(first.value.savedChoiceId);
  });

  it('are ordered newest first, and the order is total', async () => {
    const { store, advance } = await open();
    for (const label of ['oldest', 'middle', 'newest']) {
      const saved = await store.createSavedChoice({ label, choice: choice() });
      if (isErr(saved)) throw new Error('createSavedChoice refused');
      advance(1000);
    }
    const listed = await store.listSavedChoices();
    if (isErr(listed)) throw new Error('listSavedChoices refused');
    expect(listed.value.items.map((entry) => entry.label)).toEqual(['newest', 'middle', 'oldest']);
  });

  it('count a document from a newer build rather than dropping it', async () => {
    // The distinction `SavedChoiceList.unreadable` exists to keep: a
    // configuration written by a build this one cannot read and a configuration
    // that was never saved are different facts.
    const { store, catalogRoot } = await open();
    const kept = await store.createSavedChoice({ label: 'Readable', choice: choice() });
    if (isErr(kept)) throw new Error('createSavedChoice refused');

    const directory = join(catalogRoot, 'saved-choices');
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, 'saved_fromfuture01.json'),
      JSON.stringify({ documentVersion: 99, savedChoiceId: 'saved_fromfuture01' }),
      'utf8',
    );

    const listed = await store.listSavedChoices();
    if (isErr(listed)) throw new Error('listSavedChoices refused');
    expect(listed.value.items).toHaveLength(1);
    expect(listed.value.unreadable).toHaveLength(1);
    expect(listed.value.unreadable[0]?.id).toBe('saved_fromfuture01');
    expect(listed.value.unreadable[0]?.errors[0]?.code).toBe('admin/unsupported_version');
  });

  it('refuse the write past the published bound, and leave nothing behind', async () => {
    const { store, catalogRoot } = await open();
    for (let index = 0; index < MAX_SAVED_CHOICES; index += 1) {
      const saved = await store.createSavedChoice({
        label: `Kept ${String(index)}`,
        choice: choice(),
      });
      if (isErr(saved)) throw new Error(`createSavedChoice refused at ${String(index)}`);
    }

    const before = (await readdir(join(catalogRoot, 'saved-choices'))).length;
    const refused = await store.createSavedChoice({ label: 'One too many', choice: choice() });
    expect(isErr(refused)).toBe(true);
    if (!isErr(refused)) return;
    expect(refused.error[0]?.code).toBe('admin/catalog_limit');
    // Nothing was written: not a file, not a name, not a gap in a sequence.
    expect((await readdir(join(catalogRoot, 'saved-choices'))).length).toBe(before);
  });

  it('are absent from the batch and job listings, because they are neither', async () => {
    const { store } = await open();
    const saved = await store.createSavedChoice({ label: 'Kept', choice: choice() });
    if (isErr(saved)) throw new Error('createSavedChoice refused');

    const batches = await store.listBatches();
    const jobs = await store.listJobs();
    if (isErr(batches) || isErr(jobs)) throw new Error('listing refused');
    expect(batches.value.items).toEqual([]);
    expect(jobs.value.items).toEqual([]);
    expect(batches.value.unreadable).toEqual([]);
    expect(jobs.value.unreadable).toEqual([]);
  });
});
