import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JobId, PlayerMetaPartition } from '@tcg/admin-contracts';
import { CARD_SCHEMA_VERSION } from '@tcg/card-data';
import { unwrap } from '@tcg/shared';
import { experimentPaths } from '@tcg/simulator';
import { freezeLiveMatchDeckSnapshot, type LiveMatchEnvelope } from '@tcg/match-telemetry';

import { resolveCatalogRoots } from '../catalog/roots.js';
import {
  makeTestCatalog,
  testConfig,
  testIdentity,
  type TestCatalog,
} from '../catalog/test-catalog.js';

import { computeCatalogDataHealth, computePlayerMetaDataHealth } from './data-health.js';
import { PlayerMetaResultReader } from './player-meta-results.js';
import { ResultReader } from './results.js';

/**
 * M08.27D (model half) — proving both domains' nine-category split over the
 * real `ResultReader`/`PlayerMetaResultReader` boundaries, the same way
 * `coverage.test.ts` proves its own two funnels.
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

function summaryDocument(overrides: {
  readonly terminations?: Record<string, number> | undefined;
  readonly flags?: readonly Record<string, unknown>[] | undefined;
  readonly displacement?: readonly Record<string, unknown>[] | undefined;
}): Record<string, unknown> {
  return {
    schemaVersion: 10,
    configHash: 'abcdef0123456789',
    aggregate: {
      run: {
        matches: 16,
        usableMatches: 13,
        abnormalMatches: 3,
        abnormalShare: 0.1875,
        terminations: overrides.terminations ?? { last_player_standing: 13, draw: 0 },
        endReasons: { defeat: 13 },
        draws: 0,
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
      cards: [],
    },
    calibration: {
      schemaVersion: 1,
      standing: 'calibration',
      reasons: ['No pilot in this build carries a final balance conclusion.'],
      promotionRequires:
        'A run stops being calibration only when every class that flew it carries it.',
    },
    flags: overrides.flags ?? [],
    displacement: overrides.displacement ?? [],
  };
}

function manifestDocument(overrides: {
  readonly recoveredLines?: readonly { line: number; reason: string }[] | undefined;
  readonly abnormalMatchIds?: readonly string[] | undefined;
}): Record<string, unknown> {
  return {
    schemaVersion: 8,
    experimentId: 'data-health-smoke',
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
    abnormalMatches: 3,
    failedMatches: 0,
    resumedMatches: 0,
    recoveredLines: overrides.recoveredLines ?? [],
    abnormalMatchIds: overrides.abnormalMatchIds ?? [],
  };
}

async function seedRun(options: {
  readonly directory: string;
  readonly terminations?: Record<string, number>;
  readonly flags?: readonly Record<string, unknown>[];
  readonly displacement?: readonly Record<string, unknown>[];
  readonly recoveredLines?: readonly { line: number; reason: string }[];
  readonly abnormalMatchIds?: readonly string[];
  readonly noResult?: boolean;
}): Promise<JobId> {
  const batch = unwrap(await catalog.store.createBatch({ label: 'M08.27D fixture' }));
  const job = unwrap(
    await catalog.store.createJob({
      batchId: batch.batchId,
      label: 'M08.27D fixture run',
      purpose: 'exploration',
      sourceClasses: ['ai', 'precon'],
      config: testConfig(),
      origin: { kind: 'preset', presetId: 'precon_smoke', stageId: 'matches' },
    }),
  );

  if (options.noResult === true) return job.jobId;

  const full = join(catalog.resultRoot, options.directory);
  await mkdir(full, { recursive: true });
  const paths = experimentPaths(full);
  await writeFile(
    paths.summary,
    JSON.stringify(
      summaryDocument({
        terminations: options.terminations,
        flags: options.flags,
        displacement: options.displacement,
      }),
    ),
    'utf8',
  );
  await writeFile(
    paths.manifest,
    JSON.stringify(
      manifestDocument({
        recoveredLines: options.recoveredLines,
        abnormalMatchIds: options.abnormalMatchIds,
      }),
    ),
    'utf8',
  );

  unwrap(
    await catalog.store.attachJobResult(job.jobId, {
      identity: testIdentity(),
      location: { rootId: 'local', directory: options.directory },
    }),
  );
  return job.jobId;
}

describe('computeCatalogDataHealth', () => {
  it('reports unavailable, with every category zeroed, when the run has no result', async () => {
    const jobId = await seedRun({ directory: 'unused', noResult: true });

    const result = unwrap(await computeCatalogDataHealth(reader, jobId));
    expect(result.unavailableReason).not.toBeNull();
    expect(result.recoveredRecords).toEqual({ count: 0, entries: [] });
    expect(result.failures.count).toBe(0);
    expect(result.stalled.count).toBe(0);
  });

  it('splits abnormalByKind into failures and stalled by @tcg/simulator kind', async () => {
    const jobId = await seedRun({
      directory: 'terminations',
      terminations: {
        last_player_standing: 10,
        engine_error: 2,
        pilot_error: 1,
        turn_limit: 3,
      },
    });

    const result = unwrap(await computeCatalogDataHealth(reader, jobId));
    expect(result.failures).toEqual({
      count: 3,
      byKind: { engine_error: 2, pilot_error: 1 },
      unavailableReason: null,
    });
    expect(result.stalled).toEqual({
      count: 3,
      byKind: { turn_limit: 3 },
      unavailableReason: null,
    });
  });

  it('surfaces flags as exclusions/seatBias/pilotSensitivity/unsupportedMechanics by level/reason', async () => {
    const jobId = await seedRun({
      directory: 'flags',
      flags: [
        {
          level: 'insufficient_data',
          reason: 'candidate_displacement',
          subject: 'card_a',
          message: 'Too few observations to call this a real displacement.',
          sampleSize: 4,
        },
        {
          level: 'review_recommended',
          reason: 'seat_sensitivity',
          subject: 'deck_b',
          message: 'Win rate diverges by seat.',
          sampleSize: 40,
        },
        {
          level: 'review_recommended',
          reason: 'pilot_sensitivity',
          subject: 'deck_c',
          message: 'Win rate diverges by pilot.',
          sampleSize: 40,
        },
        {
          level: 'run_quality',
          reason: 'unsupported_mechanics',
          subject: 'card_d',
          message: 'This mechanic has no telemetry support.',
          sampleSize: 1,
        },
      ],
    });

    const result = unwrap(await computeCatalogDataHealth(reader, jobId));
    expect(result.exclusions.count).toBe(1);
    expect(result.exclusions.entries[0]?.subject).toBe('card_a');
    expect(result.seatBias.count).toBe(1);
    expect(result.seatBias.entries[0]?.subject).toBe('deck_b');
    expect(result.pilotSensitivity.count).toBe(1);
    expect(result.pilotSensitivity.entries[0]?.subject).toBe('deck_c');
    expect(result.unsupportedMechanics.count).toBe(1);
    expect(result.unsupportedMechanics.entries[0]?.subject).toBe('card_d');
  });

  it('surfaces displacement entries at insufficient_evidence as replicateDisagreement, excluding others', async () => {
    const jobId = await seedRun({
      directory: 'displacement',
      displacement: [
        {
          definitionId: 'card_stable',
          betweenReplicateVariation: 0.02,
          replicates: 5,
          shareDelta: 0.01,
          status: 'stable',
        },
        {
          definitionId: 'card_noisy',
          betweenReplicateVariation: 0.09,
          replicates: 3,
          shareDelta: -0.03,
          status: 'insufficient_evidence',
        },
      ],
    });

    const result = unwrap(await computeCatalogDataHealth(reader, jobId));
    expect(result.replicateDisagreement.count).toBe(1);
    expect(result.replicateDisagreement.entries).toEqual([
      {
        definitionId: 'card_noisy',
        betweenReplicateVariation: 0.09,
        replicates: 3,
        shareDelta: -0.03,
      },
    ]);
  });

  it('surfaces manifest recoveredLines as recoveredRecords', async () => {
    const jobId = await seedRun({
      directory: 'recovered',
      recoveredLines: [{ line: 42, reason: 'unparseable JSON' }],
    });

    const result = unwrap(await computeCatalogDataHealth(reader, jobId));
    expect(result.recoveredRecords).toEqual({
      count: 1,
      entries: [{ line: 42, reason: 'unparseable JSON' }],
    });
  });

  it('always reports replayStatus unavailable — this build has no catalog-run replay reader', async () => {
    const jobId = await seedRun({ directory: 'replay' });

    const result = unwrap(await computeCatalogDataHealth(reader, jobId));
    expect(result.replayStatus.unavailableReason).not.toBeNull();
    expect(result.replayStatus.matchesChecked).toBe(0);
  });
});

/* ------------------------------------------------------------- player meta */

describe('computePlayerMetaDataHealth', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tcg-admin-data-health-'));
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

  function baseSeats(): LiveMatchEnvelope['seats'] {
    return [
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
    ];
  }

  function ordinaryEnvelope(matchId: string, p: PlayerMetaPartition): LiveMatchEnvelope {
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
      seats: baseSeats(),
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

  function serverFailureEnvelope(matchId: string, p: PlayerMetaPartition): LiveMatchEnvelope {
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
      seats: baseSeats(),
      actionCount: 12,
      terminationOrigin: 'server_failure',
      outcome: {
        outcome: 'draw',
        winnerId: null,
        loserIds: ['player_1', 'player_2'],
        reason: 'engine_error',
        finalTurn: 1,
        finalSequence: 3,
        diagnostics: 'panic',
      },
    };
  }

  function disconnectTimeoutEnvelope(matchId: string, p: PlayerMetaPartition): LiveMatchEnvelope {
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
      seats: baseSeats(),
      actionCount: 8,
      terminationOrigin: 'disconnect_timeout',
      outcome: {
        outcome: 'draw',
        winnerId: null,
        loserIds: ['player_1', 'player_2'],
        reason: 'timeout',
        finalTurn: 1,
        finalSequence: 2,
        diagnostics: null,
      },
    };
  }

  function abandonedEnvelope(matchId: string, p: PlayerMetaPartition): LiveMatchEnvelope {
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
      seats: baseSeats(),
      actionCount: 0,
      terminationOrigin: 'abandoned_unrecordable',
      outcome: null,
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
    const result = unwrap(computePlayerMetaDataHealth(playerMetaReader(), partition()));
    expect(result.unavailableReason).not.toBeNull();
    expect(result.recoveredRecords).toEqual({ count: 0, entries: [] });
  });

  it('splits matches into failures/stalled by termination origin, and exclusions by null outcome', () => {
    const p = partition();
    writeMatch('match_ordinary', ordinaryEnvelope('match_ordinary', p));
    writeMatch('match_failure', serverFailureEnvelope('match_failure', p));
    writeMatch('match_timeout', disconnectTimeoutEnvelope('match_timeout', p));
    writeMatch('match_abandoned', abandonedEnvelope('match_abandoned', p));

    const result = unwrap(computePlayerMetaDataHealth(playerMetaReader(), p));

    expect(result.failures).toEqual({
      count: 1,
      byKind: { server_failure: 1 },
      unavailableReason: null,
    });
    expect(result.stalled).toEqual({
      count: 2,
      byKind: { disconnect_timeout: 1, abandoned_unrecordable: 1 },
      unavailableReason: null,
    });
    expect(result.exclusions.count).toBe(1);
    expect(result.exclusions.entries[0]?.matchId).toBe('match_abandoned');
  });

  it('reports replicateDisagreement/seatBias/pilotSensitivity/unsupportedMechanics as structurally unavailable', () => {
    const p = partition();
    writeMatch('match_a', ordinaryEnvelope('match_a', p));

    const result = unwrap(computePlayerMetaDataHealth(playerMetaReader(), p));
    expect(result.replicateDisagreement).toEqual({
      count: 0,
      entries: [],
      unavailableReason: expect.any(String),
    });
    expect(result.seatBias.unavailableReason).toEqual(expect.any(String));
    expect(result.pilotSensitivity.unavailableReason).toEqual(expect.any(String));
    expect(result.unsupportedMechanics.unavailableReason).toEqual(expect.any(String));
  });

  it("measures replayStatus over this partition's abnormal-origin matches only", () => {
    const p = partition();
    writeMatch('match_ordinary', ordinaryEnvelope('match_ordinary', p));
    writeMatch('match_failure', serverFailureEnvelope('match_failure', p));

    const result = unwrap(computePlayerMetaDataHealth(playerMetaReader(), p));
    expect(result.replayStatus).toEqual({
      matchesChecked: 1,
      withReplay: 0,
      withoutReplay: 1,
      unavailableReason: null,
    });
  });

  it("reports every partition's skipped-envelope list identically, root-wide", () => {
    const p = partition();
    writeMatch('match_a', ordinaryEnvelope('match_a', p));
    const brokenDirectory = join(root, 'match_broken');
    mkdirSync(brokenDirectory, { recursive: true });
    writeFileSync(join(brokenDirectory, 'envelope.json'), '{not json', 'utf8');

    const result = unwrap(computePlayerMetaDataHealth(playerMetaReader(), p));
    expect(result.recoveredRecords.count).toBe(1);
    expect(result.recoveredRecords.entries[0]?.matchId).toBe('match_broken');
  });
});
