import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JobId, PlayerMetaPartition } from '@tcg/admin-contracts';
import {
  CARD_SCHEMA_VERSION,
  CardDatabase,
  isColorIdentityLegal,
  type CardDefinition,
} from '@tcg/card-data';
import { unwrap } from '@tcg/shared';
import {
  environmentConfigForFormat,
  experimentPaths,
  freezeEnvironment,
  resolveEnvironment,
  type ResolvedEnvironment,
} from '@tcg/simulator';
import { freezeLiveMatchDeckSnapshot, type LiveMatchEnvelope } from '@tcg/match-telemetry';

import { resolveCatalogRoots } from '../catalog/roots.js';
import {
  makeTestCatalog,
  testConfig,
  testIdentity,
  type TestCatalog,
} from '../catalog/test-catalog.js';

import { computeCatalogCoverage, computePlayerMetaCoverage } from './coverage.js';
import { PlayerMetaResultReader } from './player-meta-results.js';
import { ResultReader } from './results.js';

/**
 * M08.27C — proving the two funnels `./coverage.ts` computes, over real
 * bundled card data and the actual `ResultReader`/`PlayerMetaResultReader`
 * boundaries, the same way `comparison-deltas.test.ts` proves its own
 * computation over the same boundaries.
 */

/* ---------------------------------------------------------- catalog domain */

let catalog: TestCatalog;
let reader: ResultReader;

beforeEach(async () => {
  catalog = await makeTestCatalog();
  reader = new ResultReader({ store: catalog.store, roots: catalog.roots });
});

afterEach(async () => {
  await catalog.dispose();
});

function resolvedFixtureEnvironment(): ResolvedEnvironment {
  const config = environmentConfigForFormat('precon_wave_1', {
    label: 'Precon Wave 1, for a coverage fixture',
  });
  return freezeEnvironment(resolveEnvironment(config));
}

function cardsAggregate(playedCardId: string): Record<string, unknown> {
  return {
    definitionId: playedCardId,
    decksIncluding: 2,
    seatMatches: 30,
    copiesPerDeck: 1,
    winRateWhenIncluded: { point: 0.5, low: 0.4, high: 0.6, successes: 15, total: 30, margin: 0.1 },
    winRateWhenAbsent: { point: 0.5, low: 0.4, high: 0.6, successes: 0, total: 0, margin: 0.1 },
    inclusionWinRateLift: 0,
    drawRate: 0.4,
    playsPerDraw: 0.9,
    gamesDrawnAndPlayedShare: 0.8,
    gamesDrawn: 12,
    activationsPerMatch: 0.3,
    averageEnergySpent: 2.1,
    averageTriggers: 0.4,
    deadInHandShare: 0.1,
    mechanicallyUnusableShare: 0.05,
    strategicallyUnusedShare: 0.05,
    removalRate: 0.2,
  };
}

function summaryDocument(cards: readonly Record<string, unknown>[]): Record<string, unknown> {
  return {
    schemaVersion: 7,
    configHash: 'abcdef0123456789',
    aggregate: {
      run: {
        matches: 16,
        usableMatches: 15,
        abnormalMatches: 1,
        abnormalShare: 0.0625,
        terminations: { last_player_standing: 14, draw: 1, turn_limit: 1 },
        endReasons: { defeat: 14 },
        draws: 1,
        turns: { mean: 12.5, median: 12, p10: 8, p90: 18, max: 22 },
        decisionsPerMatch: 44.2,
        botFailures: 0,
        seatWinRates: [],
        pilotWinRates: [],
        agentClassWinRates: [],
        environments: ['baseline'],
      },
      decks: [],
      matchups: [],
      cards,
    },
    calibration: {
      schemaVersion: 1,
      standing: 'calibration',
      reasons: ['No pilot in this build carries a final balance conclusion.'],
      promotionRequires:
        'A run stops being calibration only when every class that flew it carries it.',
    },
  };
}

function manifestDocument(): Record<string, unknown> {
  return {
    schemaVersion: 8,
    experimentId: 'precon-smoke',
    kind: 'batch',
    seed: 'seed-1',
    configHash: 'abcdef0123456789',
    softwareCommit: '2b1a6ec',
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
    matches: 16,
    abnormalMatches: 1,
    failedMatches: 0,
    resumedMatches: 3,
  };
}

async function seedRun(options: {
  readonly directory: string;
  readonly cards?: readonly Record<string, unknown>[];
  readonly withResolvedEnvironment?: ResolvedEnvironment;
}): Promise<JobId> {
  const batch = unwrap(await catalog.store.createBatch({ label: 'M08.27C fixture' }));
  const job = unwrap(
    await catalog.store.createJob({
      batchId: batch.batchId,
      label: 'M08.27C fixture run',
      purpose: 'exploration',
      sourceClasses: ['ai', 'precon'],
      config: testConfig(),
      origin: { kind: 'preset', presetId: 'precon_smoke', stageId: 'matches' },
    }),
  );

  const full = join(catalog.resultRoot, options.directory);
  await mkdir(full, { recursive: true });
  const paths = experimentPaths(full);
  await writeFile(paths.summary, JSON.stringify(summaryDocument(options.cards ?? [])), 'utf8');
  await writeFile(paths.manifest, JSON.stringify(manifestDocument()), 'utf8');
  if (options.withResolvedEnvironment !== undefined) {
    await writeFile(
      paths.resolvedEnvironment,
      JSON.stringify(options.withResolvedEnvironment),
      'utf8',
    );
  }

  unwrap(
    await catalog.store.attachJobResult(job.jobId, {
      identity: testIdentity(),
      location: { rootId: 'local', directory: options.directory },
    }),
  );
  return job.jobId;
}

describe('computeCatalogCoverage', () => {
  it('reports unavailable, with empty cards and mechanics, when the run has no resolved environment', async () => {
    const jobId = await seedRun({ directory: 'no-environment' });

    const result = unwrap(await computeCatalogCoverage(reader, jobId));
    expect(result.cards).toEqual([]);
    expect(result.mechanics).toEqual([]);
    expect(result.unavailableReason).not.toBeNull();
  });

  it('marks a played pool card reached on inclusion/draw/play/activation/trigger, and an unplayed one not_reached', async () => {
    const environment = resolvedFixtureEnvironment();
    const playedCardId = environment.poolCardIds[0];
    if (playedCardId === undefined) throw new Error('fixture pool is empty');
    const unplayedCardId = environment.poolCardIds.find((id) => id !== playedCardId);
    if (unplayedCardId === undefined) throw new Error('fixture pool has only one card');

    const jobId = await seedRun({
      directory: 'played',
      cards: [cardsAggregate(playedCardId)],
      withResolvedEnvironment: environment,
    });

    const result = unwrap(await computeCatalogCoverage(reader, jobId));
    expect(result.unavailableReason).toBeNull();

    const played = result.cards.find((card) => card.cardId === playedCardId);
    expect(played).toMatchObject({
      inclusion: 'reached',
      draw: 'reached',
      play: 'reached',
      activation: 'reached',
      trigger: 'reached',
    });

    const unplayed = result.cards.find((card) => card.cardId === unplayedCardId);
    expect(unplayed).toMatchObject({
      inclusion: 'not_reached',
      draw: 'not_reached',
      play: 'not_reached',
      activation: 'not_reached',
      trigger: 'not_reached',
    });
  });

  it('computes eligibility independently of whether a card was ever played', async () => {
    const environment = resolvedFixtureEnvironment();
    const database = new CardDatabase(environment.cards);
    const commanders = environment.commanderCardIds
      .map((id) => database.get(id))
      .filter((card): card is CardDefinition => card !== undefined);

    const eligible = environment.poolCardIds.find((id) => {
      const card = database.get(id);
      return (
        card !== undefined &&
        commanders.some((commander) =>
          isColorIdentityLegal(card.colorIdentity, commander.colorIdentity),
        )
      );
    });
    if (eligible === undefined) throw new Error('fixture has no eligible pool card');

    const jobId = await seedRun({ directory: 'eligibility', withResolvedEnvironment: environment });

    const result = unwrap(await computeCatalogCoverage(reader, jobId));
    const row = result.cards.find((card) => card.cardId === eligible);
    expect(row).toMatchObject({ eligibility: 'reached', inclusion: 'not_reached' });
  });

  it('reports every MECHANIC_KINDS entry, marking telemetry-none and zero-usage mechanics unavailable', async () => {
    const environment = resolvedFixtureEnvironment();
    const jobId = await seedRun({ directory: 'mechanics', withResolvedEnvironment: environment });

    const result = unwrap(await computeCatalogCoverage(reader, jobId));
    expect(result.mechanics.length).toBeGreaterThan(0);
    for (const mechanic of result.mechanics) {
      if (mechanic.status === 'unavailable') {
        expect(mechanic.unavailableReason).not.toBeNull();
      } else {
        expect(mechanic.cardsUsing).toBeGreaterThan(0);
      }
    }
  });
});

/* ------------------------------------------------------------- player meta */

describe('computePlayerMetaCoverage', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tcg-admin-coverage-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function partition(overrides: Partial<PlayerMetaPartition> = {}): PlayerMetaPartition {
    return {
      source: 'human_human',
      contentVersion: CARD_SCHEMA_VERSION,
      rulesVersion: '1.0.0',
      ...overrides,
    };
  }

  function envelope(matchId: string, p: PlayerMetaPartition): LiveMatchEnvelope {
    return {
      schemaVersion: 3,
      matchId,
      source: p.source,
      formatId: 'precon_wave_1',
      provenance: {
        softwareVersion: '1.0.0',
        contentVersion: p.contentVersion,
        rulesVersion: p.rulesVersion,
      },
      seats: [
        {
          seatIndex: 0,
          playerId: 'player_1',
          kind: 'human',
          deck: freezeLiveMatchDeckSnapshot({
            commanderId: 'bastion_commander',
            cards: [{ cardId: 'border_recruit', quantity: 40 }],
          }),
        },
        {
          seatIndex: 1,
          playerId: 'player_2',
          kind: 'human',
          deck: freezeLiveMatchDeckSnapshot({
            commanderId: 'goblin_warboss',
            cards: [{ cardId: 'goblin_spearman', quantity: 40 }],
          }),
        },
      ],
      actionCount: 40,
      terminationOrigin: 'concede_action',
      outcome: {
        outcome: 'win',
        winnerId: 'player_2',
        loserIds: ['player_1'],
        reason: 'concede',
        finalTurn: 3,
        finalSequence: 12,
        diagnostics: null,
      },
    };
  }

  function writeMatch(matchId: string, match: LiveMatchEnvelope): void {
    const directory = join(root, matchId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'envelope.json'), JSON.stringify(match), 'utf8');
  }

  function playerMetaReader(): PlayerMetaResultReader {
    const roots = unwrap(
      resolveCatalogRoots({ catalogRoot: join(root, 'catalog'), resultRoots: { local: root } }),
    );
    return new PlayerMetaResultReader({ roots, resultRootId: 'local' });
  }

  it('reports unavailable when no live match matches the partition', () => {
    const result = unwrap(computePlayerMetaCoverage(playerMetaReader(), partition()));
    expect(result.cards).toEqual([]);
    expect(result.unavailableReason).not.toBeNull();
  });

  it('marks each played deck-list card reached', () => {
    const p = partition();
    writeMatch('match_a', envelope('match_a', p));

    const result = unwrap(computePlayerMetaCoverage(playerMetaReader(), p));

    const recruitRow = result.cards.find((card) => card.cardId === 'border_recruit');
    expect(recruitRow?.observation).toBe('reached');
    const spearmanRow = result.cards.find((card) => card.cardId === 'goblin_spearman');
    expect(spearmanRow?.observation).toBe('reached');
  });
});
