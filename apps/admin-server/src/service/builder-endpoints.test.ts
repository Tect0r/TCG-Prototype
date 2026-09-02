import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  ADMIN_CONTRACT_VERSION,
  ADMIN_ENDPOINTS,
  MAX_SAVED_CHOICES,
  adminResponse,
  savedChoiceDocumentSchema,
  type PresetChoice,
} from '@tcg/admin-contracts';
import { isErr, unwrap } from '@tcg/shared';

import { openFileCatalogStore } from '../catalog/file-catalog-store.js';
import { ExperimentRunner } from '../run/job-runner.js';
import { JobQueue } from '../run/queue.js';
import { parseServiceConfig } from './config.js';
import { AdminService } from './handlers.js';

/**
 * M08.8 — the four addresses a builder needs, over the real store.
 *
 * A real temporary catalog rather than a stub, for the reason every other
 * catalog suite gives: what is being asserted — a saved configuration survives a
 * write and a read, a listing counts what it could not read, a bound refuses the
 * next write — are claims about documents on a disk.
 *
 * Every answer is parsed through `adminResponse(ADMIN_ENDPOINTS[name].response)`
 * as well as read, because the service validates on the way out and this is the
 * same check from the other side: a handler that built a shape its own contract
 * cannot describe is a defect in the build rather than something to render.
 */

const bases: string[] = [];

afterEach(async () => {
  for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true });
});

async function makeService(): Promise<AdminService> {
  const base = await mkdtemp(join(tmpdir(), 'tcg-admin-builder-'));
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
  const runner = new ExperimentRunner({
    store: opened.store,
    roots: config.roots,
    resultRootId: 'local',
    // Nothing in this suite starts a run; the queue exists because the service
    // takes one, and a runner that was never called cannot have run anything.
    runExperiment: () => {
      throw new Error('No experiment runs in the builder suite.');
    },
  });
  return new AdminService({
    config,
    store: opened.store,
    queue: new JobQueue({ store: opened.store, runner, limits: config.limits }),
  });
}

const PRECONS = [
  'precon_bastion_guardians',
  'precon_containment_control',
  'precon_goblin_swarm',
  'precon_grave_sacrifice',
];

function choice(overrides: Record<string, unknown> = {}): PresetChoice {
  return {
    presetId: 'precon_standard',
    experimentId: 'builder-run',
    seed: 'builder-seed',
    preconIds: PRECONS,
    pilotIds: ['value'],
    settings: {
      workload: { mode: 'preset' },
      replicates: 1,
      mirrorSeats: true,
      retention: { replaySampleRate: 50 },
      workers: 1,
    },
    ...overrides,
  } as unknown as PresetChoice;
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

/* --------------------------------------------------------------- content */

describe('the content endpoint', () => {
  it('answers with the active format’s precons and pilots', async () => {
    const service = await makeService();
    const answer = await service.handle('content', {});
    expect(isErr(answer)).toBe(false);
    if (isErr(answer)) return;

    valid('content', answer.value);
    expect(answer.value.formatId).toBe('precon_wave_1');
    expect(answer.value.precons.length).toBeGreaterThan(1);
    expect(answer.value.pilots.map((pilot) => pilot.pilotId)).toContain('random_legal');
  });

  it('names no filesystem location anywhere in the answer', async () => {
    const service = await makeService();
    const answer = await service.handle('content', {});
    if (isErr(answer)) throw new Error('content refused');
    const text = JSON.stringify(answer.value);
    expect(text).not.toContain('tcg-admin-builder-');
    expect(text).not.toContain(tmpdir().replace(/\\/g, '\\\\'));
  });
});

/* -------------------------------------------------------------- estimate */

describe('the estimate endpoint', () => {
  it('answers the exact total before anything is created', async () => {
    const service = await makeService();
    const answer = await service.handle('estimateChoice', { choice: choice() });
    if (isErr(answer)) throw new Error(answer.error.map((problem) => problem.message).join('; '));

    valid('estimateChoice', answer.value);
    const { estimate, expansion } = answer.value;
    if (!('totalMatches' in estimate) || !('stages' in expansion)) {
      throw new Error('expected a staged preset estimate, not an adaptive one');
    }
    expect(estimate.basis).toBe('exact');
    expect(estimate.totalMatches).toBeGreaterThan(0);
    expect(expansion.stages).toHaveLength(1);

    // Nothing was created: the catalog is still empty of batches.
    const batches = await service.handle('listBatches', { page: { limit: 50, cursor: null } });
    if (isErr(batches)) throw new Error('listBatches refused');
    expect(batches.value.items).toEqual([]);
  });

  it('agrees with what enqueueing the same choice actually creates', async () => {
    // M08.6 declined a separate estimate endpoint partly because it *could*
    // disagree with the enqueue. Both go through `estimatePreset`, so they can
    // only differ if the content moved between the two calls.
    const service = await makeService();
    const preview = await service.handle('estimateChoice', {
      choice: choice({
        settings: {
          workload: { mode: 'custom', gamesPerSeatOrder: 2 },
          replicates: 2,
          mirrorSeats: true,
          retention: { replaySampleRate: 10 },
          workers: 1,
        },
      }),
    });
    if (isErr(preview)) throw new Error('estimate refused');

    const batch = await service.handle('createBatch', {
      label: 'Preview agreement',
      annotations: { tags: [], note: '', baseline: false },
    });
    if (isErr(batch)) throw new Error('createBatch refused');

    const enqueued = await service.handle('enqueuePreset', {
      batchId: batch.value.batchId,
      choice: choice({
        settings: {
          workload: { mode: 'custom', gamesPerSeatOrder: 2 },
          replicates: 2,
          mirrorSeats: true,
          retention: { replaySampleRate: 10 },
          workers: 1,
        },
      }),
    });
    if (isErr(enqueued)) throw new Error('enqueuePreset refused');

    expect(enqueued.value.estimate).toEqual(preview.value.estimate);
    expect(enqueued.value.expansion).toEqual(preview.value.expansion);
    // Two replicates are two jobs, which is why the expansion travels with the
    // preview rather than only the total.
    expect(enqueued.value.jobs).toHaveLength(2);
  });

  it('refuses a precon this content does not publish, naming the field', async () => {
    const service = await makeService();
    const answer = await service.handle('estimateChoice', {
      choice: choice({ preconIds: ['precon_goblin_swarm', 'precon_withdrawn_yesterday'] }),
    });
    expect(isErr(answer)).toBe(true);
    if (!isErr(answer)) return;
    expect(answer.error[0]?.code).toBe('admin/schema');
    expect(answer.error.map((problem) => problem.message).join(' ')).toContain(
      'precon_withdrawn_yesterday',
    );
  });

  it('refuses a single precon, because a benchmark needs an opponent', async () => {
    const service = await makeService();
    const answer = await service.handle('estimateChoice', {
      choice: choice({ preconIds: ['precon_goblin_swarm'] }),
    });
    expect(isErr(answer)).toBe(true);
  });
});

/* --------------------------------------------------- adaptive_counter (M08.19A) */

function adaptiveChoice(overrides: Record<string, unknown> = {}): PresetChoice {
  return {
    presetId: 'adaptive_counter',
    experimentId: 'adaptive-search',
    seed: 'adaptive-seed',
    startingPreconIds: ['precon_goblin_swarm'],
    totalLearningBudget: 100,
    blockSize: 10,
    candidateCount: 4,
    finalValidationGames: 20,
    ...overrides,
  } as unknown as PresetChoice;
}

describe('adaptive_counter, on its own narrower door', () => {
  it('answers a workload, not a match-count schedule, and shows it before enqueueing', async () => {
    const service = await makeService();
    const answer = await service.handle('estimateChoice', { choice: adaptiveChoice() });
    if (isErr(answer)) throw new Error(answer.error.map((problem) => problem.message).join('; '));

    valid('estimateChoice', answer.value);
    const { estimate, expansion } = answer.value;
    if ('totalMatches' in estimate || 'stages' in expansion) {
      throw new Error('expected an adaptive workload estimate, not a staged preset one');
    }
    expect(estimate).toMatchObject({
      gamesPerBlock: 20,
      blocksScheduled: 5,
      gamesScheduled: 100,
      gamesUnspent: 0,
      finalValidationGames: 20,
    });
  });

  it('restores every control through a save and reopen, unchanged', async () => {
    const service = await makeService();
    const full = adaptiveChoice({
      commanderPolicy: 'selected',
      selectedCommanderIds: ['goblin_warboss'],
      informationPolicy: 'analysis_full_deck',
      mirrorSeats: false,
      blockSize: 5,
      swapBound: { minCards: 2, maxCards: 3 },
      referenceFieldShare: 0.25,
      rebuildTrigger: { afterConsecutiveLosses: 3 },
    });
    const saved = await service.handle('saveChoice', { label: 'Adaptive draft', choice: full });
    if (isErr(saved)) throw new Error('saveChoice refused');
    valid('saveChoice', saved.value);

    const listed = await service.handle('listSavedChoices', {});
    if (isErr(listed)) throw new Error('listSavedChoices refused');
    expect(listed.value.items[0]?.choice).toEqual(full);
  });

  it('is refused as an unsupported preset when the choice cannot validate', async () => {
    const service = await makeService();
    const answer = await service.handle('estimateChoice', {
      choice: adaptiveChoice({ startingPreconIds: ['precon_not_real'] }),
    });
    expect(isErr(answer)).toBe(true);
    if (!isErr(answer)) return;
    expect(answer.error[0]?.code).toBe('admin/schema');
  });

  it('still refuses to enqueue, because scheduling an adaptive run is not in this build', async () => {
    const service = await makeService();
    const batch = await service.handle('createBatch', {
      label: 'Adaptive attempt',
      annotations: { tags: [], note: '', baseline: false },
    });
    if (isErr(batch)) throw new Error('createBatch refused');

    const enqueued = await service.handle('enqueuePreset', {
      batchId: batch.value.batchId,
      choice: adaptiveChoice(),
    });
    expect(isErr(enqueued)).toBe(true);
  });
});

/* --------------------------------------------------- saved configurations */

describe('saving and reopening a form', () => {
  it('stores a choice and lists it back unchanged', async () => {
    const service = await makeService();
    const saved = await service.handle('saveChoice', {
      label: 'Four precons, value pilot',
      choice: choice(),
    });
    if (isErr(saved)) throw new Error('saveChoice refused');
    valid('saveChoice', saved.value);

    const listed = await service.handle('listSavedChoices', {});
    if (isErr(listed)) throw new Error('listSavedChoices refused');
    valid('listSavedChoices', listed.value);

    expect(listed.value.total).toBe(1);
    expect(listed.value.unreadable).toBe(0);
    expect(listed.value.items[0]?.label).toBe('Four precons, value pilot');
    // The whole point of reopening: what comes back is what went in.
    expect(listed.value.items[0]?.choice).toEqual(saved.value.choice);
  });

  it('keeps every setting through the round trip, which is what reopening means', async () => {
    const service = await makeService();
    const settings = {
      workload: { mode: 'custom', gamesPerSeatOrder: 7 },
      replicates: 3,
      mirrorSeats: false,
      retention: { replaySampleRate: 0 },
      workers: 2,
    };
    const saved = await service.handle('saveChoice', {
      label: 'Everything moved',
      choice: choice({ settings }),
    });
    if (isErr(saved)) throw new Error('saveChoice refused');

    const listed = await service.handle('listSavedChoices', {});
    if (isErr(listed)) throw new Error('listSavedChoices refused');
    const restored = listed.value.items[0]?.choice;
    expect(restored && 'settings' in restored ? restored.settings : null).toEqual(settings);
  });

  it('lists the newest first, so the last one saved is the one at the top', async () => {
    const service = await makeService();
    for (const label of ['first', 'second', 'third']) {
      const saved = await service.handle('saveChoice', { label, choice: choice() });
      if (isErr(saved)) throw new Error('saveChoice refused');
    }
    const listed = await service.handle('listSavedChoices', {});
    if (isErr(listed)) throw new Error('listSavedChoices refused');
    expect(listed.value.items.map((entry) => entry.label)).toEqual(['third', 'second', 'first']);
  });

  it('duplicates by saving the same choice under a different name', async () => {
    // There is no duplicate verb, and that is the design: a kept form is opened,
    // edited and kept again, which is a new one rather than an update to the old.
    const service = await makeService();
    const original = await service.handle('saveChoice', { label: 'Original', choice: choice() });
    if (isErr(original)) throw new Error('saveChoice refused');
    const copy = await service.handle('saveChoice', {
      label: 'Copy, deeper',
      choice: choice({ settings: { workload: { mode: 'custom', gamesPerSeatOrder: 12 } } }),
    });
    if (isErr(copy)) throw new Error('saveChoice refused');

    expect(copy.value.savedChoiceId).not.toBe(original.value.savedChoiceId);
    const listed = await service.handle('listSavedChoices', {});
    if (isErr(listed)) throw new Error('listSavedChoices refused');
    expect(listed.value.total).toBe(2);
  });

  it('refuses to store a choice that could never run', async () => {
    // Checked before the write, so the refusal arrives while the screen still has
    // the values that caused it rather than a month later on reopening.
    const service = await makeService();
    const answer = await service.handle('saveChoice', {
      label: 'Never runnable',
      choice: choice({ preconIds: ['precon_goblin_swarm', 'precon_withdrawn_yesterday'] }),
    });
    expect(isErr(answer)).toBe(true);

    const listed = await service.handle('listSavedChoices', {});
    if (isErr(listed)) throw new Error('listSavedChoices refused');
    expect(listed.value.total).toBe(0);
  });

  it('never starts, never completes, and holds no location', async () => {
    const service = await makeService();
    const saved = await service.handle('saveChoice', { label: 'Timestamps', choice: choice() });
    if (isErr(saved)) throw new Error('saveChoice refused');
    expect(saved.value.timestamps.startedAt).toBeNull();
    expect(saved.value.timestamps.completedAt).toBeNull();
    expect(JSON.stringify(saved.value)).not.toContain('tcg-admin-builder-');
  });

  it('is a document this build can validate on the way back in', async () => {
    const service = await makeService();
    const saved = await service.handle('saveChoice', { label: 'Document', choice: choice() });
    if (isErr(saved)) throw new Error('saveChoice refused');
    const parsed = savedChoiceDocumentSchema.safeParse({ documentVersion: 1, ...saved.value });
    expect(parsed.success).toBe(true);
  });
});

/* ---------------------------------------------------------------- bounds */

describe('the saved-configuration bound', () => {
  it('is a number the contract states rather than an unbounded directory', () => {
    // The refusal itself is exercised by the store suite, which can write
    // `MAX_SAVED_CHOICES` documents without going through the expansion each
    // time. What matters here is that the bound is one number, published.
    expect(MAX_SAVED_CHOICES).toBeGreaterThan(0);
  });
});

/* ---------------------------------------------------------- request shape */

describe('what the builder’s requests cannot carry', () => {
  it('has no field anywhere for an output root, a path or a configuration', () => {
    // ADR 0023 §5, restated at the two request shapes M08.8 adds.
    const shapes = JSON.stringify([
      Object.keys(ADMIN_ENDPOINTS.estimateChoice.request.def as object),
      Object.keys(ADMIN_ENDPOINTS.saveChoice.request.def as object),
    ]);
    for (const forbidden of ['output', 'path', 'root', 'directory', 'file']) {
      expect(`${forbidden}: ${String(shapes.includes(forbidden))}`).toBe(`${forbidden}: false`);
    }
  });

  it('refuses an unknown field rather than ignoring it', () => {
    const parsed = ADMIN_ENDPOINTS.saveChoice.request.safeParse({
      label: 'Extra',
      choice: choice(),
      outputRoot: 'anywhere',
    });
    expect(parsed.success).toBe(false);
  });
});
