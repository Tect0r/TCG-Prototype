import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  cardExplorerRequestSchema,
  deckExplorerRequestSchema,
  matchExplorerEventTimelineRequestSchema,
  matchExplorerListRequestSchema,
  matchExplorerViewRequestSchema,
  matchRepresentativesRequestSchema,
  NO_PLAYER_META_FILTER,
  REPRESENTATIVE_MATCH_ENTRY_COUNT,
  type JobId,
  type PlayerMetaPartition,
} from '@tcg/admin-contracts';
import { unwrap } from '@tcg/shared';
import {
  environmentConfigForFormat,
  experimentPaths,
  parseExperimentConfig,
  resolveEnvironment,
  type ExperimentConfig,
  type ExperimentConfigInput,
} from '@tcg/simulator';
import {
  freezeLiveMatchDeckSnapshot,
  type LiveMatchEnvelope,
  type LiveMatchPreActionCapture,
} from '@tcg/match-telemetry';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { FileCatalogStore } from './catalog/file-catalog-store.js';
import { resolveCatalogRoots, resolveResultLocation, type ResolvedCatalogRoots } from './catalog/roots.js';
import { makeTestCatalog, testConfig, type TestCatalog } from './catalog/test-catalog.js';
import { PRESET_FORMAT_ID } from './lab/expand.js';
import { estimateExperiment } from './lab/estimate.js';
import { ExperimentRunner } from './run/job-runner.js';
import { countCommittedRecords } from './run/progress.js';
import { JobQueue } from './run/queue.js';
import { CardExplorerReader } from './service/card-explorer.js';
import { computeCatalogComparisonDelta, computePlayerMetaComparisonDelta } from './service/comparison-deltas.js';
import { DeckExplorerReader } from './service/deck-explorer.js';
import { MatchExplorerReader } from './service/match-explorer.js';
import { MatchRepresentativesReader } from './service/match-representatives.js';
import { PlayerMetaResultReader, readPlayerMetaSummary, readPlayerMetaTable } from './service/player-meta-results.js';
import { ResultReader } from './service/results.js';

/**
 * M08.28D — the end-to-end recovery matrix.
 *
 * Every other suite in this app proves one boundary in isolation, most of
 * them against a stand-in simulator. This file proves the boundaries compose
 * for real: a real run of every experiment kind, a real multi-worker pause
 * survived by a brand-new store instance over the same directory (a real
 * restart, not a simulated one), real human-ingested live matches with a
 * real surrender capture, every explorer reading them back, and a real
 * before/after comparison in both the catalog and Player Meta domains. No
 * dimension here recomputes arithmetic another suite already owns; it only
 * checks that the real pieces still fit together end to end.
 */

const PRECONS = [
  'precon_bastion_guardians',
  'precon_containment_control',
  'precon_goblin_swarm',
  'precon_grave_sacrifice',
];

const ENVIRONMENT_CONFIG = environmentConfigForFormat(PRESET_FORMAT_ID, {
  label: 'Precon Wave 1, for the recovery matrix',
});
const ENVIRONMENT = resolveEnvironment(ENVIRONMENT_CONFIG);
// Every card in the resolved pool is played by at least one of the four
// `PRECONS` below, and `throwing_knife` (`pool[0]`) happens to be played by
// all four — banning it left the comparison dimension's reference population
// empty in both arms (0 legal decks, 0 matches), which is a different failure
// than the slow one this file used to carry a paragraph about. `border_recruit`
// is played by exactly one of the four, so banning it excludes exactly one
// reference deck and still leaves enough legal decks in both arms.
const CANDIDATE_BANNED_CARD_ID = 'border_recruit';
const CANDIDATE_ENVIRONMENT_CONFIG = environmentConfigForFormat(PRESET_FORMAT_ID, {
  id: 'precon_wave_1_matrix_candidate',
  banCardIds: [CANDIDATE_BANNED_CARD_ID],
});

function batchConfig(
  id: string,
  environment = ENVIRONMENT_CONFIG,
  decks: Record<string, unknown> = { kind: 'precon', preconIds: PRECONS.slice(0, 2) },
): ExperimentConfig {
  return parseExperimentConfig({
    schemaVersion: 1,
    kind: 'batch',
    id,
    seed: `${id}-seed`,
    playerCount: 2,
    pilots: [{ id: 'value' }],
    pilotPairing: 'mirror',
    environment,
    decks,
    schedule: 'round_robin',
    gamesPerPairing: 1,
    mirrorSeats: false,
  } as ExperimentConfigInput);
}

function searchConfig(id: string): ExperimentConfig {
  return parseExperimentConfig({
    schemaVersion: 1,
    kind: 'search',
    id,
    seed: `${id}-seed`,
    pilots: [{ id: 'value' }],
    environment: ENVIRONMENT_CONFIG,
    populationSize: 4,
    generations: 1,
    replicates: 1,
    opponentsPerEvaluation: 1,
    gamesPerOpponent: 1,
  } as ExperimentConfigInput);
}

function robustnessConfig(id: string): ExperimentConfig {
  return parseExperimentConfig({
    schemaVersion: 1,
    kind: 'robustness',
    id,
    seed: `${id}-seed`,
    pilots: [{ id: 'value' }],
    environment: ENVIRONMENT_CONFIG,
    decks: { kind: 'precon', preconIds: PRECONS.slice(0, 2) },
    profiles: ['combat_forward'],
    gamesPerPairing: 1,
  } as ExperimentConfigInput);
}

function comparisonConfig(id: string): ExperimentConfig {
  return parseExperimentConfig({
    schemaVersion: 1,
    kind: 'comparison',
    id,
    seed: `${id}-seed`,
    pilots: [{ id: 'value' }],
    baseline: ENVIRONMENT_CONFIG,
    candidate: CANDIDATE_ENVIRONMENT_CONFIG,
    declaredChanges: { cardsRemoved: [CANDIDATE_BANNED_CARD_ID] },
    referenceDecks: { kind: 'precon', preconIds: PRECONS },
    gamesPerPairing: 1,
    mirrorSeats: false,
    // `searchBothEnvironments` defaults to true and runs a full displacement
    // search (population x generations x opponents x games, twice, once per
    // environment, plus replicates) on top of the reference matches — that
    // search, not the reference decks, is what made this dimension take
    // upward of ten minutes for what looked like "a handful of matches". The
    // search feature itself is real and out of this slice's scope; this test
    // only needs the baseline/candidate reference comparison to really run.
    searchBothEnvironments: false,
  } as ExperimentConfigInput);
}

function replacementConfig(id: string): ExperimentConfig {
  return parseExperimentConfig({
    schemaVersion: 1,
    kind: 'replacement',
    id,
    seed: `${id}-seed`,
    pilots: [{ id: 'value' }],
    environment: ENVIRONMENT_CONFIG,
    baseDecks: { kind: 'precon', preconIds: PRECONS.slice(0, 2) },
    opponentDecks: { kind: 'precon', preconIds: PRECONS.slice(2) },
    subjectCardId: ENVIRONMENT.pool[0]?.id ?? '',
    gamesPerPairing: 1,
  } as ExperimentConfigInput);
}

/* -------------------------------------------------------------- dimension 1 */

describe('every primary and advanced test style really runs, end to end', () => {
  let catalog: TestCatalog;

  beforeEach(async () => {
    catalog = await makeTestCatalog();
  });

  afterEach(async () => {
    await catalog.dispose();
  });

  async function seedRealJob(config: ExperimentConfig, label: string): Promise<JobId> {
    const batch = unwrap(await catalog.store.createBatch({ label: 'Recovery matrix' }));
    const job = unwrap(
      await catalog.store.createJob({
        batchId: batch.batchId,
        label,
        purpose: 'exploration',
        sourceClasses: ['ai', 'precon'],
        config,
      }),
    );
    return job.jobId;
  }

  async function runDirectory(jobId: JobId): Promise<string> {
    return unwrap(await resolveResultLocation(catalog.roots, { rootId: 'local', directory: jobId }));
  }

  it.each([
    ['batch', batchConfig],
    ['search', searchConfig],
    ['robustness', robustnessConfig],
    ['comparison', comparisonConfig],
    ['replacement', replacementConfig],
  ] as const)('completes a real %s run and indexes it from what it wrote', async (kind, build) => {
    const config = build(`matrix-${kind}`);
    const jobId = await seedRealJob(config, `A real ${kind} run`);
    const runner = new ExperimentRunner({
      store: catalog.store,
      roots: catalog.roots,
      resultRootId: 'local',
      pollEveryMs: 20,
    });
    const outcome = unwrap(await runner.run(jobId));

    expect(outcome.status).toBe('completed');
    expect(outcome.failure).toBeNull();

    const job = unwrap(await catalog.store.readJob(jobId));
    expect(job.status).toBe('completed');
    const directory = await runDirectory(jobId);
    const manifest = JSON.parse(await readFile(experimentPaths(directory).manifest, 'utf8')) as {
      readonly matches: number;
    };
    expect(manifest.matches).toBeGreaterThan(0);
    expect(job.progress.completedMatches).toBe(manifest.matches);
  }, 120_000);

  it('refuses the reserved adaptive_counter preset before anything can run', () => {
    expect(() =>
      parseExperimentConfig({
        schemaVersion: 1,
        kind: 'adaptive_counter',
        id: 'matrix-reserved',
        seed: 'matrix-reserved-seed',
      } as unknown as ExperimentConfigInput),
    ).toThrow();
  });
});

/* -------------------------------------------------------------- dimension 2 */

describe('partial work survives a restart, and a fresh process finishes it', () => {
  let catalog: TestCatalog;

  beforeEach(async () => {
    catalog = await makeTestCatalog();
  });

  afterEach(async () => {
    await catalog.dispose();
  });

  const delay = (milliseconds: number): Promise<void> =>
    new Promise((settle) => setTimeout(settle, milliseconds));

  async function runDirectory(jobId: JobId): Promise<string> {
    return unwrap(await resolveResultLocation(catalog.roots, { rootId: 'local', directory: jobId }));
  }

  it('pauses a real multi-worker run, restarts onto a new store instance, and resumes to the real total', async () => {
    const runner = new ExperimentRunner({
      store: catalog.store,
      roots: catalog.roots,
      resultRootId: 'local',
      pollEveryMs: 20,
    });
    const queue = new JobQueue({
      store: catalog.store,
      runner,
      limits: { maxConcurrentJobs: 1, maxWorkers: 2, maxWorkersPerJob: 2 },
    });

    const batch = unwrap(await catalog.store.createBatch({ label: 'Recovery matrix restart' }));
    const job = unwrap(
      await catalog.store.createJob({
        batchId: batch.batchId,
        label: 'A real pause, a real restart',
        purpose: 'exploration',
        sourceClasses: ['ai', 'precon'],
        config: testConfig({ id: 'matrix-restart', gamesPerPairing: 12, mirrorSeats: true, workers: 2 }),
      }),
    );
    unwrap(await catalog.store.applyBatchAction(batch.batchId, 'enqueue'));
    const jobId = job.jobId;

    const paths = experimentPaths(await runDirectory(jobId));
    // The denominator is the same estimator the runner uses, not arithmetic
    // repeated here — the second formula ADR 0023 §2 refuses.
    const total = estimateExperiment(unwrap(await catalog.store.readJobConfig(jobId))).totalMatches;
    expect(total).toBeGreaterThan(8);

    void queue.pump();
    for (let waited = 0; waited < 2_000; waited += 1) {
      if ((await countCommittedRecords(paths.matches)) >= 1) break;
      await delay(25);
    }
    unwrap(await queue.pause(jobId));
    await queue.drain();

    const paused = unwrap(await catalog.store.readJob(jobId));
    expect(paused.status).toBe('paused');
    const partial = await countCommittedRecords(paths.matches);
    expect(partial).toBeGreaterThanOrEqual(1);
    expect(partial).toBeLessThan(total);

    // The restart itself: a brand-new store, runner and queue over the same
    // directories. The original instances' in-memory locks and clocks are
    // never reused — only what reached disk survives, which is what a real
    // process restart actually leaves behind.
    const restartedStore = new FileCatalogStore({ roots: catalog.roots, clock: () => new Date() });
    const restartedRunner = new ExperimentRunner({
      store: restartedStore,
      roots: catalog.roots,
      resultRootId: 'local',
      pollEveryMs: 20,
    });
    const restartedQueue = new JobQueue({ store: restartedStore, runner: restartedRunner });

    unwrap(await restartedQueue.resume(jobId));
    await restartedQueue.drain();

    const finished = unwrap(await restartedStore.readJob(jobId));
    expect(finished.status).toBe('completed');
    expect(finished.execution?.attempts).toBe(2);
    expect(finished.execution?.resumedMatches).toBe(partial);
    expect(finished.progress.completedMatches).toBe(total);
    expect(await countCommittedRecords(paths.matches)).toBe(total);

    const identities = (await readFile(paths.matches, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => (JSON.parse(line) as { matchId: string }).matchId);
    expect(new Set(identities).size).toBe(total);
  }, 300_000);
});

/* -------------------------------------------------------------- dimensions 3-5 */

const winOutcome: LiveMatchEnvelope['outcome'] = {
  outcome: 'win',
  winnerId: 'player_1',
  loserIds: ['player_2'],
  reason: 'health_depleted',
  finalTurn: 10,
  finalSequence: 200,
  diagnostics: null,
};

const surrenderOutcome: LiveMatchEnvelope['outcome'] = {
  outcome: 'win',
  winnerId: 'player_2',
  loserIds: ['player_1'],
  reason: 'concede',
  finalTurn: 3,
  finalSequence: 12,
  diagnostics: null,
};

const FIXTURE_DECK_SEAT_0 = freezeLiveMatchDeckSnapshot({
  commanderId: 'prototype_commander_blue',
  cards: [{ cardId: 'prototype_drone', quantity: 40 }],
});
const FIXTURE_DECK_SEAT_1 = freezeLiveMatchDeckSnapshot({
  commanderId: 'prototype_commander_red',
  cards: [{ cardId: 'prototype_scout', quantity: 40 }],
});

function envelope(
  matchId: string,
  overrides: Partial<LiveMatchEnvelope> = {},
): LiveMatchEnvelope {
  return {
    schemaVersion: 3,
    matchId,
    source: 'human_human',
    formatId: 'precon_wave_1',
    provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    seats: [
      { seatIndex: 0, playerId: 'player_1', kind: 'human', deck: FIXTURE_DECK_SEAT_0 },
      { seatIndex: 1, playerId: 'player_2', kind: 'human', deck: FIXTURE_DECK_SEAT_1 },
    ],
    actionCount: 40,
    terminationOrigin: 'rules_victory',
    outcome: winOutcome,
    ...overrides,
  };
}

function writeMatch(root: string, matchId: string, match: LiveMatchEnvelope): void {
  const directory = join(root, matchId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'envelope.json'), JSON.stringify(match), 'utf8');
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
  overrides: Partial<LiveMatchPreActionCapture> = {},
): LiveMatchPreActionCapture {
  return {
    schemaVersion: 3,
    matchId,
    playerId: 'player_1',
    origin: 'concede_action',
    turn: 3,
    phase: 'main_1',
    activePlayerId: 'player_1',
    sequence: 12,
    pendingChoice: null,
    combat: idleCombat,
    reactionWindow: null,
    eventWindow: {
      recentEvents: [
        {
          type: 'unit_deployed',
          sequence: 12,
          cause: { actionType: null, sourceInstanceId: null, resolutionId: null },
          playerId: 'player_2',
          instanceId: 'matrix_unit_9',
          definitionId: 'prototype_scout',
        },
      ],
      eventDistances: [{ sequence: 12, eventsAgo: 0, actionsAgo: 0, turnsAgo: 0 }],
      currentTurnWindow: { turn: 3, startSequence: 8, endSequence: 12 },
      previousTurnWindow: { turn: 2, startSequence: 5, endSequence: 7 },
    },
    provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    deck: FIXTURE_DECK_SEAT_0,
    ...overrides,
  };
}

function writeCapture(root: string, matchId: string, capture: LiveMatchPreActionCapture): void {
  const directory = join(root, matchId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'pre-action-capture.json'), JSON.stringify(capture), 'utf8');
}

describe('human ingestion, surrender capture and explorer drill-down share one live-match root', () => {
  let catalog: TestCatalog;
  let liveBase: string;
  let liveRoot: string;
  let liveRoots: ResolvedCatalogRoots;
  let explorerJobId: JobId;

  const SURRENDER_MATCH_ID = 'matrix_live_surrender';
  const PLAIN_MATCH_ID = 'matrix_live_plain';

  beforeAll(async () => {
    catalog = await makeTestCatalog();
    const runner = new ExperimentRunner({
      store: catalog.store,
      roots: catalog.roots,
      resultRootId: 'local',
      pollEveryMs: 20,
    });
    const batch = unwrap(await catalog.store.createBatch({ label: 'Recovery matrix explorer' }));
    const job = unwrap(
      await catalog.store.createJob({
        batchId: batch.batchId,
        label: 'For cross-boundary card evidence',
        purpose: 'exploration',
        sourceClasses: ['ai', 'precon'],
        config: batchConfig('matrix-explorer-catalog'),
      }),
    );
    unwrap(await runner.run(job.jobId));
    explorerJobId = job.jobId;

    liveBase = mkdtempSync(join(tmpdir(), 'tcg-admin-recovery-matrix-live-'));
    liveRoot = join(liveBase, 'live');
    liveRoots = unwrap(
      resolveCatalogRoots({
        catalogRoot: join(liveBase, 'catalog'),
        resultRoots: { local: catalog.resultRoot, live: liveRoot },
      }),
    );

    writeMatch(
      liveRoot,
      SURRENDER_MATCH_ID,
      envelope(SURRENDER_MATCH_ID, { terminationOrigin: 'concede_action', outcome: surrenderOutcome }),
    );
    writeCapture(liveRoot, SURRENDER_MATCH_ID, surrenderCapture(SURRENDER_MATCH_ID));
    writeMatch(liveRoot, PLAIN_MATCH_ID, envelope(PLAIN_MATCH_ID));
  }, 120_000);

  afterAll(async () => {
    await catalog.dispose();
    rmSync(liveBase, { recursive: true, force: true });
  });

  it('ingests real human matches into the Player Meta read model, free functions and reader agreeing', () => {
    const summary = unwrap(readPlayerMetaSummary(liveRoot, NO_PLAYER_META_FILTER));
    expect(summary.source.recordsRead).toBe(2);

    const reader = new PlayerMetaResultReader({ roots: liveRoots, resultRootId: 'live' });
    const readerSummary = unwrap(reader.readSummary(NO_PLAYER_META_FILTER));
    expect(readerSummary.source.recordsRead).toBe(2);
  });

  it('surfaces the real surrender capture through the surrender tables', () => {
    const turns = unwrap(readPlayerMetaTable(liveRoot, 'surrender_turns', NO_PLAYER_META_FILTER, { limit: 50, cursor: null }));
    expect(turns.rows).toEqual([expect.objectContaining({ turn: 3, surrenders: 1 })]);

    const phases = unwrap(readPlayerMetaTable(liveRoot, 'surrender_phases', NO_PLAYER_META_FILTER, { limit: 50, cursor: null }));
    expect(phases.rows).toEqual([expect.objectContaining({ phase: 'main_1', surrenders: 1 })]);
  });

  it('reads a real deck identity for the drilled-down deck hash', async () => {
    const reader = new DeckExplorerReader({ roots: liveRoots, resultRootId: 'live' });
    const view = unwrap(
      await reader.readView(deckExplorerRequestSchema.parse({ deckHash: FIXTURE_DECK_SEAT_0.deckHash })),
    );
    expect(view.deckHash).toBe(FIXTURE_DECK_SEAT_0.deckHash);
    expect(view.identity).not.toBeNull();
    expect(view.identity?.commanderId).toBe('prototype_commander_blue');
  });

  it('combines live-match evidence with a real job\'s result table for one card', async () => {
    const reader = new CardExplorerReader({ roots: liveRoots, resultRootId: 'live', store: catalog.store });
    const view = unwrap(
      await reader.readView(
        cardExplorerRequestSchema.parse({ cardId: 'prototype_drone', jobId: explorerJobId }),
      ),
    );
    expect(view.cardId).toBe('prototype_drone');
    expect(view.experimentEvidence?.jobId).toBe(explorerJobId);
    // The card is real in the live fixtures but absent from the unrelated real
    // job's 'cards' table — checked, not found, which is the documented shape.
    expect(view.experimentEvidence?.row).toBeNull();
    expect(view.contributingDecks.length).toBeGreaterThan(0);
    expect(view.contributingMatches.length).toBeGreaterThan(0);
  });

  it('lists, views and paginates the event timeline for a real surrender match', async () => {
    const reader = new MatchExplorerReader({ roots: liveRoots, resultRootId: 'live' });

    const list = unwrap(await reader.readList(matchExplorerListRequestSchema.parse({})));
    expect(list.items.map((row) => row.matchId).sort()).toEqual(
      [SURRENDER_MATCH_ID, PLAIN_MATCH_ID].sort(),
    );

    const view = unwrap(
      await reader.readView(matchExplorerViewRequestSchema.parse({ matchId: SURRENDER_MATCH_ID })),
    );
    expect(view.matchId).toBe(SURRENDER_MATCH_ID);
    expect(view.artifacts.preActionCapture).toBe('present');
    expect(view.decisionDiagnostics).not.toBeNull();
    expect(view.decisionDiagnostics?.origin).toBe('concede_action');

    const timeline = unwrap(
      await reader.readEventTimeline(
        matchExplorerEventTimelineRequestSchema.parse({ matchId: SURRENDER_MATCH_ID }),
      ),
    );
    expect(['present', 'not_retained']).toContain(timeline.status);
    expect(timeline.status === 'present' ? timeline.page !== null : timeline.page === null).toBe(true);
  });

  it('carries every representative kind and pages the abnormal-match list', async () => {
    const reader = new MatchRepresentativesReader({ roots: liveRoots, resultRootId: 'live' });
    const view = unwrap(
      await reader.readView(matchRepresentativesRequestSchema.parse({})),
    );
    expect(view.representatives).toHaveLength(REPRESENTATIVE_MATCH_ENTRY_COUNT);
    expect(view.abnormalMatches.items).toBeInstanceOf(Array);
    expect(view.abnormalMatches.page).toBeDefined();
  });
});

/* -------------------------------------------------------------- dimension 5 */

describe('before/after comparison crosses catalog and Player Meta domains for real', () => {
  let catalog: TestCatalog;
  let baselineJobId: JobId;
  let candidateJobId: JobId;
  let liveBase: string;
  let liveRoot: string;

  beforeAll(async () => {
    catalog = await makeTestCatalog();
    const runner = new ExperimentRunner({
      store: catalog.store,
      roots: catalog.roots,
      resultRootId: 'local',
      pollEveryMs: 20,
    });

    async function seed(config: ExperimentConfig, label: string): Promise<JobId> {
      const batch = unwrap(await catalog.store.createBatch({ label: 'Recovery matrix comparison' }));
      const job = unwrap(
        await catalog.store.createJob({
          batchId: batch.batchId,
          label,
          purpose: 'exploration',
          sourceClasses: ['ai', 'precon'],
          config,
        }),
      );
      const outcome = unwrap(await runner.run(job.jobId));
      expect(outcome.status).toBe('completed');
      expect(outcome.failure).toBeNull();
      return job.jobId;
    }

    baselineJobId = await seed(batchConfig('matrix-cmp-baseline'), 'Baseline environment');
    candidateJobId = await seed(
      batchConfig('matrix-cmp-candidate', CANDIDATE_ENVIRONMENT_CONFIG, { kind: 'generated', count: 4 }),
      'Candidate environment, cards banned',
    );

    liveBase = mkdtempSync(join(tmpdir(), 'tcg-admin-recovery-matrix-cmp-'));
    liveRoot = join(liveBase, 'live');
    writeMatch(liveRoot, 'matrix_cmp_v5', envelope('matrix_cmp_v5'));
    writeMatch(
      liveRoot,
      'matrix_cmp_v6',
      envelope('matrix_cmp_v6', {
        provenance: { softwareVersion: '1.0.0', contentVersion: 6, rulesVersion: '1.0.0' },
      }),
    );
  }, 120_000);

  afterAll(async () => {
    await catalog.dispose();
    rmSync(liveBase, { recursive: true, force: true });
  });

  it('refuses byte-identical catalog content, then computes a delta once a real change is declared', async () => {
    const reader = new ResultReader({ store: catalog.store, roots: catalog.roots });

    const undeclared = unwrap(
      await computeCatalogComparisonDelta(reader, 'card_inclusion', baselineJobId, baselineJobId),
    );
    expect(undeclared.decision.kind).toBe('refused');
    expect(undeclared.rows).toEqual([]);

    const declared = unwrap(
      await computeCatalogComparisonDelta(
        reader,
        'card_inclusion',
        baselineJobId,
        candidateJobId,
        'banned a card for the recovery matrix',
      ),
    );
    expect(declared.decision).toMatchObject({
      kind: 'deliberately_different',
      declaredChange: 'banned a card for the recovery matrix',
    });
  });

  it('computes a real Player Meta delta once a declared change crosses two content versions', () => {
    const reader = new PlayerMetaResultReader({
      roots: unwrap(
        resolveCatalogRoots({ catalogRoot: join(liveBase, 'catalog2'), resultRoots: { live: liveRoot } }),
      ),
      resultRootId: 'live',
    });
    const baseline: PlayerMetaPartition = { source: 'human_human', contentVersion: 5, rulesVersion: '1.0.0' };
    const candidate: PlayerMetaPartition = { source: 'human_human', contentVersion: 6, rulesVersion: '1.0.0' };

    const undeclared = unwrap(
      computePlayerMetaComparisonDelta(reader, 'surrender_state', baseline, candidate),
    );
    expect(undeclared.decision.kind).toBe('refused');

    const declared = unwrap(
      computePlayerMetaComparisonDelta(
        reader,
        'surrender_state',
        baseline,
        candidate,
        'moved to content version 6 for the recovery matrix',
      ),
    );
    expect(declared.decision).toMatchObject({
      kind: 'deliberately_different',
      declaredChange: 'moved to content version 6 for the recovery matrix',
    });
  });

  it('refuses a population-confounded Player Meta comparison across different sources', () => {
    const reader = new PlayerMetaResultReader({
      roots: unwrap(
        resolveCatalogRoots({ catalogRoot: join(liveBase, 'catalog3'), resultRoots: { live: liveRoot } }),
      ),
      resultRootId: 'live',
    });
    const humanBaseline: PlayerMetaPartition = { source: 'human_human', contentVersion: 5, rulesVersion: '1.0.0' };
    const aiCandidate: PlayerMetaPartition = { source: 'ai_ai', contentVersion: 5, rulesVersion: '1.0.0' };

    const result = unwrap(
      computePlayerMetaComparisonDelta(
        reader,
        'surrender_state',
        humanBaseline,
        aiCandidate,
        'declared anyway',
      ),
    );
    expect(result.decision.kind).toBe('refused');
  });
});
