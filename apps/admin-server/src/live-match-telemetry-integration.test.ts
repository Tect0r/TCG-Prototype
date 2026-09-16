import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  cardExplorerRequestSchema,
  deckExplorerRequestSchema,
  NO_PLAYER_META_FILTER,
  playerMetaDataHealthRequestSchema,
  playerMetaRunSummaryRequestSchema,
  type PlayerMetaPartition,
} from '@tcg/admin-contracts';
import { unwrap } from '@tcg/shared';
import { freezeLiveMatchDeckSnapshot, type LiveMatchEnvelope } from '@tcg/match-telemetry';

import { openFileCatalogStore, type FileCatalogStore } from './catalog/file-catalog-store.js';
import { ExperimentRunner } from './run/job-runner.js';
import { JobQueue } from './run/queue.js';
import { parseServiceConfig, type AdminServiceConfig } from './service/config.js';
import { AdminService } from './service/handlers.js';

/**
 * M08.R9's admin-side half. `live-match-telemetry.test.ts` in
 * `apps/multiplayer-server` proves the production composition plays a real
 * match over a real socket and writes exactly one schema-valid envelope; this
 * file proves the admin process reads such an envelope back correctly, across
 * a restart, while never discovering simulator job or adaptive run
 * directories. The two files share no import — only the on-disk
 * `LiveMatchEnvelope` contract ADR 0023 requires — exactly the coupling
 * production itself uses.
 */

const MATCH_ID = 'match_integration_m08r9';
const PARTITION: PlayerMetaPartition = {
  source: 'human_human',
  contentVersion: 5,
  rulesVersion: '1.0.0',
};

const SEAT_0_DECK = freezeLiveMatchDeckSnapshot({
  commanderId: 'prototype_commander_blue',
  cards: [{ cardId: 'prototype_drone', quantity: 40 }],
});
const SEAT_1_DECK = freezeLiveMatchDeckSnapshot({
  commanderId: 'prototype_commander_red',
  cards: [{ cardId: 'prototype_scout', quantity: 40 }],
});

function envelope(): LiveMatchEnvelope {
  return {
    schemaVersion: 3,
    matchId: MATCH_ID,
    source: 'human_human',
    formatId: 'precon_wave_1',
    provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    seats: [
      { seatIndex: 0, playerId: 'player_1', kind: 'human', deck: SEAT_0_DECK },
      { seatIndex: 1, playerId: 'player_2', kind: 'human', deck: SEAT_1_DECK },
    ],
    actionCount: 40,
    terminationOrigin: 'concede_action',
    outcome: {
      outcome: 'win',
      winnerId: 'player_1',
      loserIds: ['player_2'],
      reason: 'concede',
      finalTurn: 3,
      finalSequence: 12,
      diagnostics: null,
    },
  };
}

function writeMatch(root: string, matchId: string, match: LiveMatchEnvelope): void {
  const directory = join(root, matchId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'envelope.json'), JSON.stringify(match), 'utf8');
}

async function buildService(
  config: AdminServiceConfig,
): Promise<{ service: AdminService; store: FileCatalogStore }> {
  const opened = unwrap(await openFileCatalogStore({ roots: config.roots }));
  const runner = new ExperimentRunner({
    store: opened.store,
    roots: config.roots,
    resultRootId: 'local',
    pollEveryMs: 20,
  });
  const queue = new JobQueue({ store: opened.store, runner, limits: config.limits });
  return { service: new AdminService({ config, store: opened.store, queue }), store: opened.store };
}

describe('a restarted admin service reads a real live-match envelope and ignores foreign directories', () => {
  let base: string;
  let resultRoot: string;
  let liveMatchRoot: string;
  let config: AdminServiceConfig;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'tcg-admin-live-match-integration-'));
    const catalogRoot = join(base, 'catalog');
    resultRoot = join(base, 'results');
    liveMatchRoot = join(base, 'live-match');
    mkdirSync(resultRoot, { recursive: true });
    config = unwrap(
      parseServiceConfig({
        catalogRoot,
        resultRoots: { local: resultRoot, live_match: liveMatchRoot },
        liveMatchRootId: 'live_match',
        limits: { maxConcurrentJobs: 1, maxWorkers: 1, maxWorkersPerJob: 1 },
      }),
    );
    writeMatch(liveMatchRoot, MATCH_ID, envelope());
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  it('surfaces the match in Player Meta, Card Explorer and Deck Explorer, and survives a restart', async () => {
    const first = await buildService(config);
    const summary = unwrap(
      await first.service.handle(
        'playerMetaRunSummary',
        playerMetaRunSummaryRequestSchema.parse({ filter: NO_PLAYER_META_FILTER }),
      ),
    );
    expect(summary.source.recordsRead).toBe(1);
    expect(summary.source.recordsSkipped).toBe(0);

    const deckView = unwrap(
      await first.service.handle(
        'deckExplorerView',
        deckExplorerRequestSchema.parse({
          deckHash: SEAT_0_DECK.deckHash,
          adaptiveExperimentId: null,
        }),
      ),
    );
    expect(deckView.identity?.commanderId).toBe('prototype_commander_blue');

    const cardView = unwrap(
      await first.service.handle(
        'cardExplorerView',
        cardExplorerRequestSchema.parse({ cardId: 'prototype_drone', jobId: null }),
      ),
    );
    expect(cardView.contributingMatches.some((match) => match.matchId === MATCH_ID)).toBe(true);
    expect(cardView.contributingDecks.length).toBeGreaterThan(0);

    // A restart: an entirely independent store, queue and service instance
    // over the same directories. Nothing about the first process's memory
    // carries over — only what is durable on disk does.
    const second = await buildService(config);
    const restartedSummary = unwrap(
      await second.service.handle(
        'playerMetaRunSummary',
        playerMetaRunSummaryRequestSchema.parse({ filter: NO_PLAYER_META_FILTER }),
      ),
    );
    expect(restartedSummary.source.recordsRead).toBe(1);
    expect(restartedSummary.source.recordsSkipped).toBe(0);

    const restartedDeckView = unwrap(
      await second.service.handle(
        'deckExplorerView',
        deckExplorerRequestSchema.parse({
          deckHash: SEAT_0_DECK.deckHash,
          adaptiveExperimentId: null,
        }),
      ),
    );
    expect(restartedDeckView.identity?.commanderId).toBe('prototype_commander_blue');

    const restartedCardView = unwrap(
      await second.service.handle(
        'cardExplorerView',
        cardExplorerRequestSchema.parse({ cardId: 'prototype_drone', jobId: null }),
      ),
    );
    expect(restartedCardView.contributingMatches.some((match) => match.matchId === MATCH_ID)).toBe(
      true,
    );
  });

  it('never discovers simulator job or adaptive run directories placed in their own configured root', async () => {
    // Directories shaped like real simulator/adaptive output, written under
    // the *separate* result root Player Meta never reads — never inside
    // `liveMatchRoot` itself, since `readLiveMatchEnvelopes` requires every
    // one of its subdirectories to hold an `envelope.json`; a foreign
    // directory placed there would be a real corrupt-record case, not the
    // "ignored entirely" claim this test makes.
    mkdirSync(join(resultRoot, 'job_simulator_batch_1'), { recursive: true });
    writeFileSync(
      join(resultRoot, 'job_simulator_batch_1', 'manifest.json'),
      JSON.stringify({ kind: 'batch', id: 'job_simulator_batch_1' }),
      'utf8',
    );
    mkdirSync(join(resultRoot, 'adaptive_run_1'), { recursive: true });
    writeFileSync(
      join(resultRoot, 'adaptive_run_1', 'state.json'),
      JSON.stringify({ experimentId: 'adaptive_run_1' }),
      'utf8',
    );

    const { service } = await buildService(config);
    const summary = unwrap(
      await service.handle(
        'playerMetaRunSummary',
        playerMetaRunSummaryRequestSchema.parse({ filter: NO_PLAYER_META_FILTER }),
      ),
    );
    expect(summary.source.recordsRead).toBe(1);
    expect(summary.source.recordsSkipped).toBe(0);

    const health = unwrap(
      await service.handle(
        'playerMetaDataHealthView',
        playerMetaDataHealthRequestSchema.parse({ partition: PARTITION }),
      ),
    );
    expect(health.recoveredRecords.count).toBe(0);
  });
});
