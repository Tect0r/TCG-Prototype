import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { JobId, PlayerMetaPartition } from '@tcg/admin-contracts';
import { unwrap } from '@tcg/shared';
import { experimentPaths } from '@tcg/simulator';
import {
  freezeLiveMatchDeckSnapshot,
  type LiveMatchEnvelope,
  type LiveMatchPreActionCapture,
} from '@tcg/match-telemetry';

import { resolveCatalogRoots } from '../catalog/roots.js';
import { makeTestCatalog, testConfig, testIdentity, type TestCatalog } from '../catalog/test-catalog.js';

import { computeCatalogComparisonDelta, computePlayerMetaComparisonDelta } from './comparison-deltas.js';
import { PlayerMetaResultReader } from './player-meta-results.js';
import { ResultReader } from './results.js';

/**
 * M08.27B — the computation this module exists for: reading two runs (or
 * two Player Meta partitions) through the boundaries `results.test.ts` and
 * `player-meta-results.test.ts` already exercise, and diffing what comes
 * back. Nothing here re-tests `./comparison.ts`'s gate itself
 * (`comparison.test.ts` already does that exhaustively) — these fixtures
 * exist to prove the delta arithmetic, the missing-metric propagation and
 * the presence signal, under a gate verdict that is already known.
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

function rate(point: number, total: number): Record<string, number> {
  return {
    point,
    low: Math.max(0, point - 0.1),
    high: Math.min(1, point + 0.1),
    successes: Math.round(point * total),
    total,
    margin: 0.1,
  };
}

const BASELINE_HASHES = {
  mechanicsHash: '1111111111111111',
  pilotInputHash: '2222222222222222',
  presentationHash: '3333333333333333',
  fullContentHash: '4444444444444444',
};
/** Same mechanics and pilot input as baseline, presentation only differs — `compatible`. */
const COMPATIBLE_CANDIDATE_HASHES = {
  mechanicsHash: '1111111111111111',
  pilotInputHash: '2222222222222222',
  presentationHash: '9999999999999999',
  fullContentHash: '8888888888888888',
};
/** Mechanics differs from baseline — `deliberately_different` when declared, `refused` otherwise. */
const DIFFERENT_MECHANICS_CANDIDATE_HASHES = {
  mechanicsHash: '5555555555555555',
  pilotInputHash: '2222222222222222',
  presentationHash: '3333333333333333',
  fullContentHash: '6666666666666666',
};

function baseAggregate(): Record<string, unknown> {
  return {
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
      seatWinRates: [
        { seatIndex: 0, rate: rate(0.55, 15) },
        { seatIndex: 1, rate: rate(0.45, 15) },
      ],
      pilotWinRates: [{ pilotId: 'aggressive', rate: rate(0.5, 30) }],
      agentClassWinRates: [
        { agentClass: 'heuristic', pilotIds: ['aggressive'], rate: rate(0.5, 30) },
      ],
      environments: ['baseline'],
    },
    decks: [
      {
        deckId: 'bastion',
        deckHash: 'aaaa1111',
        commanderId: 'cmd_bastion',
        matches: 15,
        winRate: rate(0.6, 15),
        averageTurns: 12.5,
        averageDamageDealt: 24,
        averageDamageTaken: 21,
      },
      {
        deckId: 'goblins',
        deckHash: 'bbbb2222',
        commanderId: 'cmd_goblin',
        matches: 15,
        winRate: rate(0.4, 15),
        averageTurns: 12.5,
        averageDamageDealt: 21,
        averageDamageTaken: 24,
      },
    ],
    matchups: [{ deckHash: 'aaaa1111', opponentHash: 'bbbb2222', rate: rate(0.6, 15) }],
    cards: [
      {
        definitionId: 'card_one',
        decksIncluding: 2,
        seatMatches: 30,
        copiesPerDeck: 1,
        winRateWhenIncluded: rate(0.5, 30),
        winRateWhenAbsent: rate(0.5, 0),
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
      },
    ],
  };
}

function summaryDocument(aggregate: Record<string, unknown> = baseAggregate()): Record<string, unknown> {
  return {
    schemaVersion: 7,
    configHash: 'abcdef0123456789',
    aggregate,
    calibration: {
      schemaVersion: 1,
      standing: 'calibration',
      reasons: ['No pilot in this build carries a final balance conclusion.'],
      promotionRequires:
        'A run stops being calibration only when every class that flew it carries it.',
    },
  };
}

function manifestDocument(hashes: Record<string, string>): Record<string, unknown> {
  return {
    schemaVersion: 8,
    experimentId: 'precon-smoke',
    kind: 'batch',
    seed: 'seed-1',
    configHash: 'abcdef0123456789',
    softwareCommit: '2b1a6ec',
    environments: [{ id: 'baseline', hashes }],
    matches: 16,
    abnormalMatches: 1,
    failedMatches: 0,
    resumedMatches: 3,
  };
}

async function seedRun(options: {
  readonly directory: string;
  readonly hashes: Record<string, string>;
  readonly aggregate?: Record<string, unknown>;
}): Promise<JobId> {
  const batch = unwrap(await catalog.store.createBatch({ label: 'M08.27B fixture' }));
  const job = unwrap(
    await catalog.store.createJob({
      batchId: batch.batchId,
      label: 'M08.27B fixture run',
      purpose: 'exploration',
      sourceClasses: ['ai', 'precon'],
      config: testConfig(),
      origin: { kind: 'preset', presetId: 'precon_smoke', stageId: 'matches' },
    }),
  );

  const full = join(catalog.resultRoot, options.directory);
  await mkdir(full, { recursive: true });
  const paths = experimentPaths(full);
  await writeFile(
    paths.summary,
    JSON.stringify(summaryDocument(options.aggregate ?? baseAggregate())),
    'utf8',
  );
  await writeFile(paths.manifest, JSON.stringify(manifestDocument(options.hashes)), 'utf8');

  unwrap(
    await catalog.store.attachJobResult(job.jobId, {
      identity: testIdentity(),
      location: { rootId: 'local', directory: options.directory },
    }),
  );
  return job.jobId;
}

describe('computeCatalogComparisonDelta', () => {
  it('refuses to compute a delta for byte-identical content, and carries no rows', async () => {
    const baselineJobId = await seedRun({ directory: 'baseline', hashes: BASELINE_HASHES });
    const candidateJobId = await seedRun({ directory: 'candidate', hashes: BASELINE_HASHES });

    const result = unwrap(
      await computeCatalogComparisonDelta(reader, 'deck_matchups', baselineJobId, candidateJobId),
    );
    expect(result.decision.kind).toBe('refused');
    expect(result.columns).toEqual([]);
    expect(result.rows).toEqual([]);
  });

  it('computes a deck_matchups delta under a compatible verdict, on point and support only', async () => {
    const baselineJobId = await seedRun({ directory: 'baseline', hashes: BASELINE_HASHES });
    const candidateAggregate = baseAggregate();
    (candidateAggregate as { matchups: unknown[] }).matchups = [
      { deckHash: 'aaaa1111', opponentHash: 'bbbb2222', rate: rate(0.75, 20) },
    ];
    const candidateJobId = await seedRun({
      directory: 'candidate',
      hashes: COMPATIBLE_CANDIDATE_HASHES,
      aggregate: candidateAggregate,
    });

    const result = unwrap(
      await computeCatalogComparisonDelta(reader, 'deck_matchups', baselineJobId, candidateJobId),
    );
    expect(result.decision.kind).toBe('compatible');
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row).toMatchObject({
      deckHash: 'aaaa1111',
      opponentHash: 'bbbb2222',
      presence: 'both',
      baselineRateGames: 15,
      candidateRateGames: 20,
    });
    expect(row?.baselineRate).toBeCloseTo(0.6, 5);
    expect(row?.candidateRate).toBeCloseTo(0.75, 5);
    expect(row?.deltaRate).toBeCloseTo(0.15, 5);
    // No new bound was fabricated for the delta itself.
    expect(result.columns.some((column) => column.key === 'deltaRateLow')).toBe(false);
    expect(result.columns.some((column) => column.key === 'deltaRateHigh')).toBe(false);
  });

  it('reads a zero-support metric as null on both sides rather than a fabricated point difference', async () => {
    const baselineJobId = await seedRun({ directory: 'baseline', hashes: BASELINE_HASHES });
    const candidateAggregate = baseAggregate();
    const candidateCard = (candidateAggregate as { cards: Array<Record<string, unknown>> }).cards[0];
    if (candidateCard === undefined) throw new Error('fixture card missing');
    candidateCard.winRateWhenIncluded = rate(0.7, 30);
    const candidateJobId = await seedRun({
      directory: 'candidate',
      hashes: COMPATIBLE_CANDIDATE_HASHES,
      aggregate: candidateAggregate,
    });

    const result = unwrap(
      await computeCatalogComparisonDelta(reader, 'card_inclusion', baselineJobId, candidateJobId),
    );
    const row = result.rows.find((entry) => entry.definitionId === 'card_one');
    expect(row).toBeDefined();
    // winRateWhenAbsent has zero support on both sides (unchanged fixture) — null, not 0.5 - 0.5.
    expect(row?.baselineWinRateWhenAbsent).toBeNull();
    expect(row?.candidateWinRateWhenAbsent).toBeNull();
    expect(row?.deltaWinRateWhenAbsent).toBeNull();
    expect(row?.baselineWinRateWhenAbsentGames).toBe(0);
    expect(row?.candidateWinRateWhenAbsentGames).toBe(0);
    // winRateWhenIncluded has real support on both sides and a real delta.
    expect(row?.baselineWinRateWhenIncluded).toBeCloseTo(0.5, 5);
    expect(row?.candidateWinRateWhenIncluded).toBeCloseTo(0.7, 5);
    expect(row?.deltaWinRateWhenIncluded).toBeCloseTo(0.2, 5);
  });

  it('computes a duration delta from the run readings, not a table of its own', async () => {
    const baselineJobId = await seedRun({ directory: 'baseline', hashes: BASELINE_HASHES });
    const candidateAggregate = baseAggregate();
    (candidateAggregate as { run: Record<string, unknown> }).run = {
      ...(baseAggregate() as { run: Record<string, unknown> }).run,
      matches: 20,
      usableMatches: 19,
      turns: { mean: 14, median: 13, p10: 9, p90: 20, max: 24 },
    };
    const candidateJobId = await seedRun({
      directory: 'candidate',
      hashes: COMPATIBLE_CANDIDATE_HASHES,
      aggregate: candidateAggregate,
    });

    const result = unwrap(
      await computeCatalogComparisonDelta(reader, 'duration', baselineJobId, candidateJobId),
    );
    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    expect(row?.baselineMatches).toBe(16);
    expect(row?.candidateMatches).toBe(20);
    expect(row?.deltaMatches).toBe(4);
    expect(row?.deltaTurnsMean).toBeCloseTo(1.5, 5);
  });

  it('computes a terminations delta, marking a kind present on only one side', async () => {
    const baselineJobId = await seedRun({ directory: 'baseline', hashes: BASELINE_HASHES });
    const candidateAggregate = baseAggregate();
    (candidateAggregate as { run: Record<string, unknown> }).run = {
      ...(baseAggregate() as { run: Record<string, unknown> }).run,
      terminations: { last_player_standing: 16, draw: 0, timeout: 2 },
    };
    const candidateJobId = await seedRun({
      directory: 'candidate',
      hashes: COMPATIBLE_CANDIDATE_HASHES,
      aggregate: candidateAggregate,
    });

    const result = unwrap(
      await computeCatalogComparisonDelta(reader, 'terminations', baselineJobId, candidateJobId),
    );
    const byKind = new Map(result.rows.map((row) => [row.kind, row]));
    expect(byKind.get('last_player_standing')).toMatchObject({
      presence: 'both',
      baselineMatches: 14,
      candidateMatches: 16,
      deltaMatches: 2,
    });
    expect(byKind.get('turn_limit')).toMatchObject({
      presence: 'baseline_only',
      baselineMatches: 1,
      candidateMatches: null,
      deltaMatches: null,
    });
    expect(byKind.get('timeout')).toMatchObject({
      presence: 'candidate_only',
      baselineMatches: null,
      candidateMatches: 2,
      deltaMatches: null,
    });
  });

  it('computes a deck_family delta, keyed by the stable deckId rather than the content-addressed deckHash', async () => {
    const baselineJobId = await seedRun({ directory: 'baseline', hashes: BASELINE_HASHES });
    const candidateAggregate = baseAggregate();
    const bastion = (baseAggregate() as { decks: Array<Record<string, unknown>> }).decks[0];
    if (bastion === undefined) throw new Error('fixture deck missing');
    (candidateAggregate as { decks: Array<Record<string, unknown>> }).decks = [
      bastion,
      {
        deckId: 'aurora',
        deckHash: 'cccc3333',
        commanderId: 'cmd_aurora',
        matches: 15,
        winRate: rate(0.5, 15),
        averageTurns: 11,
        averageDamageDealt: 20,
        averageDamageTaken: 20,
      },
    ];
    const candidateJobId = await seedRun({
      directory: 'candidate',
      hashes: COMPATIBLE_CANDIDATE_HASHES,
      aggregate: candidateAggregate,
    });

    const result = unwrap(
      await computeCatalogComparisonDelta(reader, 'deck_family', baselineJobId, candidateJobId),
    );
    const byId = new Map(result.rows.map((row) => [row.deckId, row]));
    expect(byId.get('bastion')?.presence).toBe('both');
    expect(byId.get('goblins')?.presence).toBe('baseline_only');
    expect(byId.get('aurora')?.presence).toBe('candidate_only');
  });

  it('refuses without a declared change when mechanics differ, and computes once one is given', async () => {
    const baselineJobId = await seedRun({ directory: 'baseline', hashes: BASELINE_HASHES });
    const candidateJobId = await seedRun({
      directory: 'candidate',
      hashes: DIFFERENT_MECHANICS_CANDIDATE_HASHES,
    });

    const undeclared = unwrap(
      await computeCatalogComparisonDelta(reader, 'deck_matchups', baselineJobId, candidateJobId),
    );
    expect(undeclared.decision.kind).toBe('refused');
    expect(undeclared.rows).toEqual([]);

    const declared = unwrap(
      await computeCatalogComparisonDelta(
        reader,
        'deck_matchups',
        baselineJobId,
        candidateJobId,
        'buffed the aggro deck',
      ),
    );
    expect(declared.decision).toMatchObject({
      kind: 'deliberately_different',
      declaredChange: 'buffed the aggro deck',
    });
    expect(declared.rows).toHaveLength(1);
  });
});

/* ------------------------------------------------------------- player meta */

describe('computePlayerMetaComparisonDelta', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tcg-admin-comparison-deltas-'));
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function partition(overrides: Partial<PlayerMetaPartition> = {}): PlayerMetaPartition {
    return { source: 'human_human', contentVersion: 5, rulesVersion: '1.0.0', ...overrides };
  }

  const winOutcome: LiveMatchEnvelope['outcome'] = {
    outcome: 'win',
    winnerId: 'player_2',
    loserIds: ['player_1'],
    reason: 'concede',
    finalTurn: 3,
    finalSequence: 12,
    diagnostics: null,
  };

  function envelope(
    matchId: string,
    partitionOverrides: Partial<PlayerMetaPartition>,
    overrides: Partial<LiveMatchEnvelope> = {},
  ): LiveMatchEnvelope {
    const p = partition(partitionOverrides);
    return {
      schemaVersion: 3,
      matchId,
      source: p.source,
      formatId: 'precon_wave_1',
      provenance: { softwareVersion: '1.0.0', contentVersion: p.contentVersion, rulesVersion: p.rulesVersion },
      seats: [
        {
          seatIndex: 0,
          playerId: 'player_1',
          kind: 'human',
          deck: freezeLiveMatchDeckSnapshot({
            commanderId: 'prototype_commander_blue',
            cards: [{ cardId: 'prototype_drone', quantity: 40 }],
          }),
        },
        {
          seatIndex: 1,
          playerId: 'player_2',
          kind: 'human',
          deck: freezeLiveMatchDeckSnapshot({
            commanderId: 'prototype_commander_red',
            cards: [{ cardId: 'prototype_scout', quantity: 40 }],
          }),
        },
      ],
      actionCount: 40,
      terminationOrigin: 'concede_action',
      outcome: winOutcome,
      ...overrides,
    };
  }

  const idleCombat = {
    attacks: [],
    awaitingDefenders: [],
    submissions: [],
    blocks: [],
    combatantInstanceIds: [],
    damageResolved: false,
  };

  function surrenderCapture(
    matchId: string,
    partitionOverrides: Partial<PlayerMetaPartition>,
    overrides: Partial<LiveMatchPreActionCapture> = {},
  ): LiveMatchPreActionCapture {
    const p = partition(partitionOverrides);
    const turn = overrides.turn ?? 3;
    return {
      schemaVersion: 3,
      matchId,
      playerId: 'player_1',
      origin: 'concede_action',
      turn,
      phase: 'main_1',
      activePlayerId: 'player_1',
      sequence: 12,
      pendingChoice: null,
      combat: idleCombat,
      reactionWindow: null,
      eventWindow: {
        recentEvents: [],
        eventDistances: [],
        currentTurnWindow: { turn, startSequence: 8, endSequence: 12 },
        previousTurnWindow: { turn: turn - 1, startSequence: 5, endSequence: 7 },
      },
      provenance: { softwareVersion: '1.0.0', contentVersion: p.contentVersion, rulesVersion: p.rulesVersion },
      deck: freezeLiveMatchDeckSnapshot({
        commanderId: 'prototype_commander_blue',
        cards: [{ cardId: 'prototype_drone', quantity: 40 }],
      }),
      ...overrides,
    };
  }

  function writeMatch(matchId: string, match: LiveMatchEnvelope): void {
    const directory = join(root, matchId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'envelope.json'), JSON.stringify(match), 'utf8');
  }

  function writeCapture(matchId: string, capture: LiveMatchPreActionCapture): void {
    const directory = join(root, matchId);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'pre-action-capture.json'), JSON.stringify(capture), 'utf8');
  }

  function reader(): PlayerMetaResultReader {
    const roots = unwrap(
      resolveCatalogRoots({ catalogRoot: join(root, 'catalog'), resultRoots: { local: root } }),
    );
    return new PlayerMetaResultReader({ roots, resultRootId: 'local' });
  }

  it('refuses to compute a delta for the same partition on both sides', () => {
    writeMatch('match_a', envelope('match_a', {}));
    writeCapture('match_a', surrenderCapture('match_a', {}));

    const result = unwrap(
      computePlayerMetaComparisonDelta(reader(), 'surrender_turns', partition(), partition()),
    );
    expect(result.decision.kind).toBe('refused');
    expect(result.rows).toEqual([]);
  });

  it('refuses across a different source, a population confound no declaration can fix', () => {
    const result = unwrap(
      computePlayerMetaComparisonDelta(
        reader(),
        'surrender_turns',
        partition({ source: 'human_human' }),
        partition({ source: 'human_ai' }),
        'declared anyway',
      ),
    );
    expect(result.decision.kind).toBe('refused');
    expect(result.rows).toEqual([]);
  });

  it('computes surrender_turns/phases/state deltas under a deliberately-different verdict', () => {
    const baseline = partition({ contentVersion: 5 });
    const candidate = partition({ contentVersion: 6 });

    writeMatch('match_a', envelope('match_a', { contentVersion: 5 }));
    writeCapture('match_a', surrenderCapture('match_a', { contentVersion: 5 }));
    writeMatch('match_b', envelope('match_b', { contentVersion: 6 }, { matchId: 'match_b' }));
    writeCapture(
      'match_b',
      surrenderCapture('match_b', { contentVersion: 6 }, { matchId: 'match_b', phase: 'main_2', turn: 5 }),
    );

    const turns = unwrap(
      computePlayerMetaComparisonDelta(
        reader(),
        'surrender_turns',
        baseline,
        candidate,
        'card database moved from v5 to v6',
      ),
    );
    expect(turns.decision).toMatchObject({ kind: 'deliberately_different' });
    const turnRows = new Map(turns.rows.map((row) => [row.turn, row]));
    expect(turnRows.get(3)).toMatchObject({ presence: 'baseline_only', baselineSurrenders: 1, candidateSurrenders: null });
    expect(turnRows.get(5)).toMatchObject({ presence: 'candidate_only', baselineSurrenders: null, candidateSurrenders: 1 });

    const phases = unwrap(
      computePlayerMetaComparisonDelta(reader(), 'surrender_phases', baseline, candidate, 'declared'),
    );
    const phaseRows = new Map(phases.rows.map((row) => [row.phase, row]));
    expect(phaseRows.get('main_1')).toMatchObject({ presence: 'baseline_only', baselineSurrenders: 1 });
    expect(phaseRows.get('main_2')).toMatchObject({ presence: 'candidate_only', candidateSurrenders: 1 });

    const state = unwrap(
      computePlayerMetaComparisonDelta(reader(), 'surrender_state', baseline, candidate, 'declared'),
    );
    expect(state.rows).toHaveLength(1);
    expect(state.rows[0]).toMatchObject({ baselineTotal: 1, candidateTotal: 1, deltaTotal: 0 });
  });
});
