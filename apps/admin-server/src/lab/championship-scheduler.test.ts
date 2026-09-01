import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isErr, unwrap } from '@tcg/shared';
import {
  experimentPaths,
  makeDeck,
  parseExperimentConfig,
  type ExperimentConfig,
  type SimDeck,
} from '@tcg/simulator';

import { makeTestCatalog, testIdentity, type TestCatalog } from '../catalog/test-catalog.js';
import { ChampionshipScheduler } from './championship.js';

/**
 * M08.15 — `ChampionshipScheduler` against a real, file-backed store, but with
 * jobs seeded directly rather than through `commander_search`'s own preset
 * expansion.
 *
 * `commander_search` only ever names Commanders the resolved environment
 * actually publishes (`requireCommanders`), and this repository's bundled
 * content has four. The refusals below — a batch naming more Commanders than
 * a championship can record finalists for, and two search jobs whose pilots
 * disagree — need more distinct inputs than that pool has, and
 * `ChampionshipScheduler` itself never re-validates a Commander against real
 * content (only `expandPreset` does, before a search job is ever created), so
 * a job seeded directly with a synthetic Commander ID is exactly as valid a
 * subject for these tests as one a real search produced.
 */

let catalog: TestCatalog;

beforeEach(async () => {
  catalog = await makeTestCatalog();
});

afterEach(async () => {
  await catalog.dispose();
});

function searchConfig(
  id: string,
  seed: string,
  commanderId: string,
  pilotIds: readonly string[],
): ExperimentConfig {
  return parseExperimentConfig({
    schemaVersion: 1,
    id,
    seed,
    playerCount: 2,
    pilots: pilotIds.map((pilotId) => ({ id: pilotId })),
    pilotPairing: 'mirror',
    kind: 'search',
    environment: { id: 'test_env' },
    generator: { commanderIds: [commanderId] },
  });
}

function deckWith(commanderId: string, distinctCards: readonly string[]): SimDeck {
  const cards = [
    ...distinctCards.map((cardId) => ({ cardId, quantity: 1 })),
    { cardId: 'card_a', quantity: 40 - distinctCards.length },
  ].filter((entry) => entry.quantity > 0);
  return makeDeck({ commanderId, cards, label: `${commanderId}-deck` });
}

/** Seeds one completed `commander_search`-origin job, its result and its archive. */
async function seedCompletedSearch(
  batchId: string,
  options: {
    readonly commanderId: string;
    readonly pilotIds: readonly string[];
    readonly archive: readonly SimDeck[];
  },
): Promise<void> {
  const slug = options.commanderId.replace(/[^a-z0-9]/g, '');
  const config = searchConfig(
    `search-${slug}`,
    `seed-${slug}`,
    options.commanderId,
    options.pilotIds,
  );
  const job = unwrap(
    await catalog.store.createJob({
      batchId,
      label: `Search: ${options.commanderId}`,
      purpose: 'exploration',
      sourceClasses: ['ai', 'search'],
      config,
      origin: { kind: 'preset', presetId: 'commander_search', stageId: `search-${slug}` },
    }),
  );
  unwrap(await catalog.store.applyJobAction({ jobId: job.jobId, action: 'start' }));
  const directory = join(catalog.resultRoot, job.jobId);
  await mkdir(directory, { recursive: true });
  await writeFile(experimentPaths(directory).decks, JSON.stringify(options.archive), 'utf8');
  unwrap(
    await catalog.store.attachJobResult(job.jobId, {
      identity: testIdentity({ experimentId: config.id, kind: 'search', seed: config.seed }),
      location: { rootId: 'local', directory: job.jobId },
    }),
  );
  unwrap(await catalog.store.applyJobAction({ jobId: job.jobId, action: 'complete' }));
}

function scheduler(): ChampionshipScheduler {
  return new ChampionshipScheduler({ store: catalog.store, roots: catalog.roots });
}

describe('ChampionshipScheduler', () => {
  it('refuses a batch whose Commander Search jobs disagree about which pilots searched them', async () => {
    const batch = unwrap(await catalog.store.createBatch({ label: 'mixed pilots' }));
    await seedCompletedSearch(batch.batchId, {
      commanderId: 'commander_a',
      pilotIds: ['value'],
      archive: [
        deckWith('commander_a', []),
        deckWith('commander_a', ['card_b', 'card_c', 'card_d', 'card_e']),
      ],
    });
    await seedCompletedSearch(batch.batchId, {
      commanderId: 'commander_b',
      pilotIds: ['aggressive'],
      archive: [
        deckWith('commander_b', []),
        deckWith('commander_b', ['card_f', 'card_g', 'card_h', 'card_i']),
      ],
    });

    const scheduled = await scheduler().schedule({
      batchId: batch.batchId,
      finalistsPerCommander: 2,
      gamesPerPairing: 4,
      seed: 'champ-seed',
    });

    expect(isErr(scheduled)).toBe(true);
    if (!isErr(scheduled)) throw new Error('unreachable');
    expect(scheduled.error[0]?.message).toContain('different');
    expect(scheduled.error[0]?.message).toContain('pilots');
  });

  it('refuses a batch naming more Commanders than a championship can record finalists for', async () => {
    const batch = unwrap(await catalog.store.createBatch({ label: 'too many commanders' }));
    for (let index = 0; index < 17; index += 1) {
      const commanderId = `commander_${String(index).padStart(2, '0')}`;
      await seedCompletedSearch(batch.batchId, {
        commanderId,
        pilotIds: ['value'],
        archive: [
          deckWith(commanderId, []),
          deckWith(commanderId, ['card_b', 'card_c', 'card_d', 'card_e']),
        ],
      });
    }

    const scheduled = await scheduler().schedule({
      batchId: batch.batchId,
      finalistsPerCommander: 2,
      gamesPerPairing: 4,
      seed: 'champ-seed',
    });

    expect(isErr(scheduled)).toBe(true);
    if (!isErr(scheduled)) throw new Error('unreachable');
    expect(scheduled.error[0]?.message).toContain('17');
  });

  it('refuses a selection that freezes fewer than two finalist decks in total', async () => {
    const batch = unwrap(await catalog.store.createBatch({ label: 'one deck only' }));
    await seedCompletedSearch(batch.batchId, {
      commanderId: 'commander_a',
      pilotIds: ['value'],
      // Only one deck exists at all, so exactly one finalist can ever be chosen.
      archive: [deckWith('commander_a', [])],
    });

    const scheduled = await scheduler().schedule({
      batchId: batch.batchId,
      finalistsPerCommander: 3,
      gamesPerPairing: 4,
      seed: 'champ-seed',
    });

    expect(isErr(scheduled)).toBe(true);
    if (!isErr(scheduled)) throw new Error('unreachable');
    expect(scheduled.error[0]?.message).toContain('at least two');
  });

  it('schedules successfully for a single Commander whose archive freezes two or more finalists', async () => {
    const batch = unwrap(await catalog.store.createBatch({ label: 'single commander' }));
    await seedCompletedSearch(batch.batchId, {
      commanderId: 'commander_a',
      pilotIds: ['value'],
      archive: [
        deckWith('commander_a', []),
        deckWith('commander_a', ['card_b', 'card_c', 'card_d', 'card_e']),
      ],
    });

    const scheduled = await scheduler().schedule({
      batchId: batch.batchId,
      finalistsPerCommander: 2,
      gamesPerPairing: 4,
      seed: 'champ-seed',
    });

    if (isErr(scheduled)) throw new Error(JSON.stringify(scheduled.error));
    const championshipBatch = unwrap(await catalog.store.readBatch(scheduled.value.batchId));
    const championshipJobId = championshipBatch.jobIds[0];
    if (championshipJobId === undefined) throw new Error('unreachable');
    const config = unwrap(await catalog.store.readJobConfig(championshipJobId));
    if (config.kind !== 'batch' || config.decks.kind !== 'inline') throw new Error('unreachable');
    expect(config.decks.decks).toHaveLength(2);
  });
});
