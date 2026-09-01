import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { type BatchId, type PresetChoice } from '@tcg/admin-contracts';
import { isErr, unwrap } from '@tcg/shared';
import {
  configHashOf,
  experimentPaths,
  makeDeck,
  type ExperimentConfig,
  type SimDeck,
} from '@tcg/simulator';

import { openFileCatalogStore, type FileCatalogStore } from '../catalog/file-catalog-store.js';
import { ExperimentRunner, type RunExperimentFn } from '../run/job-runner.js';
import { JobQueue } from '../run/queue.js';
import { parseServiceConfig } from './config.js';
import { AdminService } from './handlers.js';

/**
 * M08.15 end-to-end: a completed Commander Search batch turned into a
 * scheduled, frozen finalist championship.
 *
 * Like `queue-endpoints.test.ts`, no real match is played — a stand-in
 * simulator commits one record and writes the canonical documents a real run
 * would, which is enough to exercise the *admin layer's* lifecycle. What is
 * different here is that the stand-in also writes `decks.json`, because
 * `ChampionshipScheduler` reads a completed search job's own archive back out
 * of it, and a lifecycle test that never wrote one could not exercise that at
 * all.
 */

const bases: string[] = [];
const labs: JobQueue[] = [];

afterEach(async () => {
  for (const queue of labs.splice(0)) await queue.drain();
  for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true });
});

interface Lab {
  readonly service: AdminService;
  readonly store: FileCatalogStore;
}

/** A deck naming `distinctCards` synthetic filler cards, the rest padded with `card_a`. */
function deckWith(commanderId: string, distinctCards: readonly string[], label: string): SimDeck {
  const cards = [
    ...distinctCards.map((cardId) => ({ cardId, quantity: 1 })),
    { cardId: 'card_a', quantity: 40 - distinctCards.length },
  ].filter((entry) => entry.quantity > 0);
  return makeDeck({ commanderId, cards, label });
}

/**
 * Two decks per Commander, exactly four card-swaps apart — clearing the
 * default distinctness threshold regardless of which one sorts first by hash,
 * since with exactly two candidates the pairwise distance is the only one that
 * matters either way.
 */
const ARCHIVES: Readonly<Record<string, readonly SimDeck[]>> = {
  goblin_warboss: [
    deckWith('goblin_warboss', [], 'baseline'),
    deckWith('goblin_warboss', ['card_b', 'card_c', 'card_d', 'card_e'], 'four-off'),
  ],
  grave_matriarch: [
    deckWith('grave_matriarch', [], 'baseline'),
    deckWith('grave_matriarch', ['card_f', 'card_g', 'card_h', 'card_i'], 'four-off'),
  ],
};

function standInSimulator(): RunExperimentFn {
  return (async (config: ExperimentConfig, options) => {
    const directory = options?.outputDir ?? '';
    await mkdir(directory, { recursive: true });
    const paths = experimentPaths(directory);
    await writeFile(paths.matches, `${JSON.stringify({ matchId: 'm0' })}\n`, { flag: 'a' });
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
    if (config.kind === 'search') {
      const commanderId = config.generator.commanderIds[0];
      const archive = commanderId !== undefined ? (ARCHIVES[commanderId] ?? []) : [];
      await writeFile(paths.decks, JSON.stringify(archive), 'utf8');
    }
    return undefined as never;
  }) as RunExperimentFn;
}

async function makeLab(): Promise<Lab> {
  const base = await mkdtemp(join(tmpdir(), 'tcg-admin-championship-'));
  bases.push(base);
  const config = unwrap(
    parseServiceConfig({
      host: '127.0.0.1',
      port: 0,
      catalogRoot: join(base, 'catalog'),
      resultRoots: { local: join(base, 'results') },
      limits: { maxConcurrentJobs: 2, maxWorkers: 2, maxWorkersPerJob: 1 },
    }),
  );
  const opened = unwrap(await openFileCatalogStore({ roots: config.roots }));

  const runner = new ExperimentRunner({
    store: opened.store,
    roots: config.roots,
    resultRootId: 'local',
    pollEveryMs: 20,
    runExperiment: standInSimulator(),
  });

  const queue = new JobQueue({ store: opened.store, runner, limits: config.limits });
  labs.push(queue);

  return {
    service: new AdminService({ config, store: opened.store, queue }),
    store: opened.store,
  };
}

function commanderSearch(): PresetChoice {
  return {
    presetId: 'commander_search',
    experimentId: 'commander-search',
    seed: 'preset-2026-08',
    commanderIds: ['goblin_warboss', 'grave_matriarch'],
    pilotIds: ['value'],
    populationSize: 4,
    generations: 1,
    replicates: 1,
  };
}

/** Runs a Commander Search batch to completion, over the real store and queue. */
async function completedSearchBatch(lab: Lab): Promise<BatchId> {
  const batch = await lab.service.handle('createBatch', {
    label: 'Commander Search for the championship test',
    annotations: { tags: [], note: '', baseline: false },
  });
  if (isErr(batch)) throw new Error(JSON.stringify(batch.error));
  const batchId = batch.value.batchId;

  const filled = await lab.service.handle('enqueuePreset', { batchId, choice: commanderSearch() });
  if (isErr(filled)) throw new Error(JSON.stringify(filled.error));

  await lab.service.handle('startBatch', { batchId });

  for (let waited = 0; waited < 80; waited += 1) {
    const detail = await lab.service.handle('batchDetail', { batchId });
    if (isErr(detail)) throw new Error('unreadable');
    if (detail.value.batch.status === 'completed') return batchId;
    await new Promise((settle) => setTimeout(settle, 25));
  }
  throw new Error('the search batch never settled');
}

describe('scheduling a finalist championship (M08.15)', () => {
  it('freezes sufficiently distinct finalists per Commander into a fresh, mirrored batch', async () => {
    const lab = await makeLab();
    const batchId = await completedSearchBatch(lab);

    const scheduled = await lab.service.handle('scheduleChampionship', {
      batchId,
      finalistsPerCommander: 2,
      gamesPerPairing: 3,
      seed: 'championship-seed',
    });
    if (isErr(scheduled)) throw new Error(JSON.stringify(scheduled.error));

    expect(scheduled.value.jobs).toHaveLength(1);
    const job = scheduled.value.jobs[0];
    if (job === undefined) throw new Error('unreachable');
    expect(job.status).toBe('queued');
    expect(job.origin.kind).toBe('commander_championship');
    if (job.origin.kind !== 'commander_championship') throw new Error('unreachable');
    expect(job.origin.sourceBatchId).toBe(batchId);

    const byCommander = new Map(job.origin.finalists.map((entry) => [entry.commanderId, entry]));
    // Both Commanders' archives hold exactly two decks, four card-swaps apart —
    // clearing the default threshold — so both of the two requested finalists
    // are kept for each.
    expect(byCommander.get('goblin_warboss')).toEqual({
      commanderId: 'goblin_warboss',
      requested: 2,
      selected: 2,
      diversityRule: 'greedy_min_pairwise_deck_distance',
      minDistance: 4,
    });
    expect(byCommander.get('grave_matriarch')).toEqual({
      commanderId: 'grave_matriarch',
      requested: 2,
      selected: 2,
      diversityRule: 'greedy_min_pairwise_deck_distance',
      minDistance: 4,
    });

    const config = await lab.store.readJobConfig(job.jobId);
    if (isErr(config)) throw new Error('config unreadable');
    if (config.value.kind !== 'batch') throw new Error('championship must be an ordinary batch');
    expect(config.value.schedule).toBe('round_robin');
    expect(config.value.mirrorSeats).toBe(true);
    expect(config.value.gamesPerPairing).toBe(3);
    expect(config.value.seed).toBe('championship-seed');
    if (config.value.decks.kind !== 'inline') throw new Error('finalists must be frozen inline');
    expect(config.value.decks.decks).toHaveLength(4);
    expect(config.value.decks.decks.map((deck) => deck.commanderId).sort()).toEqual([
      'goblin_warboss',
      'goblin_warboss',
      'grave_matriarch',
      'grave_matriarch',
    ]);

    // Scheduling created a new, still-draft batch — starting it is left to the
    // operator, exactly the way `enqueuePreset` leaves its own batch draft.
    expect(scheduled.value.batch.status).toBe('draft');
    expect(scheduled.value.batch.batchId).not.toBe(batchId);
  });

  it('refuses to schedule while any Commander Search job in the batch is still running', async () => {
    const lab = await makeLab();
    const batch = await lab.service.handle('createBatch', {
      label: 'in flight',
      annotations: { tags: [], note: '', baseline: false },
    });
    if (isErr(batch)) throw new Error('setup failed');
    const filled = await lab.service.handle('enqueuePreset', {
      batchId: batch.value.batchId,
      choice: commanderSearch(),
    });
    if (isErr(filled)) throw new Error('setup failed');
    // Never started: every job stays `queued`, never `completed`.

    const scheduled = await lab.service.handle('scheduleChampionship', {
      batchId: batch.value.batchId,
      finalistsPerCommander: 2,
      gamesPerPairing: 3,
      seed: 'championship-seed',
    });
    expect(isErr(scheduled)).toBe(true);
    if (!isErr(scheduled)) throw new Error('unreachable');
    expect(scheduled.error[0]?.code).toBe('admin/no_result');
  });

  it('refuses a batch with no Commander Search jobs at all', async () => {
    const lab = await makeLab();
    const batch = await lab.service.handle('createBatch', {
      label: 'empty',
      annotations: { tags: [], note: '', baseline: false },
    });
    if (isErr(batch)) throw new Error('setup failed');

    const scheduled = await lab.service.handle('scheduleChampionship', {
      batchId: batch.value.batchId,
      finalistsPerCommander: 2,
      gamesPerPairing: 3,
      seed: 'championship-seed',
    });
    expect(isErr(scheduled)).toBe(true);
    if (!isErr(scheduled)) throw new Error('unreachable');
    expect(scheduled.error[0]?.code).toBe('admin/schema');
  });
});
