import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type JobId } from '@tcg/admin-contracts';
import { isErr, unwrap } from '@tcg/shared';
import { experimentPaths } from '@tcg/simulator';
import { freezeLiveMatchDeckSnapshot, type LiveMatchEnvelope } from '@tcg/match-telemetry';

import { makeTestCatalog, testConfig, testIdentity, type TestCatalog } from '../catalog/test-catalog.js';

import { CardExplorerReader } from './card-explorer.js';

/**
 * M08.26C — the Card Explorer read model over the same live-match root
 * `PlayerMetaResultReader`/`DeckExplorerReader` read, plus, when a caller
 * names one, one job's `'cards'` result table.
 *
 * `chief_containment_scholar` (blue commander), `goblin_warboss` (red
 * commander), `veteran_guard` (neutral), `arcane_snare`/`archive_acolyte`
 * (blue) and `banner_keeper` (white) are real cards in the bundled
 * `precon_wave_1` **format set** (`content/sets/precon_wave_1/`) — unlike
 * `live-card-evidence.test.ts`'s own `chief_containment_scholar`/
 * `veteran_guard` fixture, which belongs to the `prototype_core` set and is
 * therefore invisible to `formatDatabase('precon_wave_1')`. `CardExplorerReader`
 * calls the real `currentLiveMatchCardDatabases`/`aggregateLiveCardEvidence`
 * over that real format-scoped database, unlike Deck Explorer's identity read,
 * which never touches card legality — so this file's fixtures must be legal
 * `precon_wave_1` content, not the simulator's own generic prototype cards.
 */

let catalog: TestCatalog;

beforeEach(async () => {
  catalog = await makeTestCatalog();
});

afterEach(async () => {
  await catalog.dispose();
});

const winOutcome: LiveMatchEnvelope['outcome'] = {
  outcome: 'win',
  winnerId: 'player_1',
  loserIds: ['player_2'],
  reason: 'health_depleted',
  finalTurn: 10,
  finalSequence: 200,
  diagnostics: null,
};

const blueDeckWithSnare = () =>
  freezeLiveMatchDeckSnapshot({
    commanderId: 'chief_containment_scholar',
    cards: [
      { cardId: 'veteran_guard', quantity: 39 },
      { cardId: 'arcane_snare', quantity: 1 },
    ],
  });
const blueDeckWithoutSnare = () =>
  freezeLiveMatchDeckSnapshot({
    commanderId: 'chief_containment_scholar',
    cards: [{ cardId: 'veteran_guard', quantity: 40 }],
  });
const redDeck = () =>
  freezeLiveMatchDeckSnapshot({
    commanderId: 'goblin_warboss',
    cards: [{ cardId: 'veteran_guard', quantity: 40 }],
  });

function envelope(matchId: string, overrides: Partial<LiveMatchEnvelope> = {}): LiveMatchEnvelope {
  return {
    schemaVersion: 3,
    matchId,
    source: 'human_human',
    formatId: 'precon_wave_1',
    provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    seats: [
      { seatIndex: 0, playerId: 'player_1', kind: 'human', deck: blueDeckWithSnare() },
      { seatIndex: 1, playerId: 'player_2', kind: 'human', deck: redDeck() },
    ],
    actionCount: 40,
    terminationOrigin: 'rules_victory',
    outcome: winOutcome,
    ...overrides,
  };
}

async function writeMatch(matchId: string, match: LiveMatchEnvelope): Promise<void> {
  const directory = join(catalog.resultRoot, matchId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, 'envelope.json'), JSON.stringify(match), 'utf8');
}

function reader(): CardExplorerReader {
  return new CardExplorerReader({
    roots: catalog.roots,
    resultRootId: 'local',
    store: catalog.store,
  });
}

function cardsTableSummary(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
      cards: [
        {
          definitionId: 'arcane_snare',
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
          deadInHandShare: 0.1,
          mechanicallyUnusableShare: 0.05,
          strategicallyUnusedShare: 0.05,
          removalRate: 0.2,
        },
      ],
    },
    calibration: {
      schemaVersion: 1,
      standing: 'calibration',
      reasons: ['No pilot in this build carries a final balance conclusion.'],
      promotionRequires:
        'A run stops being calibration only when every class that flew it carries it.',
    },
    ...overrides,
  };
}

function rate(point: number, total: number): Record<string, number> {
  return {
    point,
    low: point - 0.1,
    high: point + 0.1,
    successes: Math.round(point * total),
    total,
    margin: 0.1,
  };
}

function manifestDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const identity = testIdentity();
  return {
    schemaVersion: 8,
    experimentId: identity.experimentId,
    kind: identity.kind,
    seed: identity.seed,
    configHash: identity.configHash,
    softwareCommit: identity.softwareCommit,
    environments: [
      { id: identity.environments[0]?.environmentId, hashes: identity.environments[0]?.hashes },
    ],
    matches: 16,
    abnormalMatches: 1,
    failedMatches: 0,
    resumedMatches: 3,
    ...overrides,
  };
}

async function seedJob(
  options: { readonly summary?: Record<string, unknown> } = {},
): Promise<JobId> {
  const batch = unwrap(await catalog.store.createBatch({ label: 'August sweep' }));
  const job = unwrap(
    await catalog.store.createJob({
      batchId: batch.batchId,
      label: 'Precon Smoke',
      purpose: 'exploration',
      sourceClasses: ['ai', 'precon'],
      config: testConfig(),
      origin: { kind: 'preset', presetId: 'precon_smoke', stageId: 'matches' },
    }),
  );

  const directory = 'run-1';
  const full = join(catalog.resultRoot, directory);
  await mkdir(full, { recursive: true });
  const paths = experimentPaths(full);
  await writeFile(paths.summary, JSON.stringify(options.summary ?? cardsTableSummary()), 'utf8');
  await writeFile(paths.manifest, JSON.stringify(manifestDocument()), 'utf8');

  unwrap(
    await catalog.store.attachJobResult(job.jobId, {
      identity: testIdentity(),
      location: { rootId: 'local', directory },
    }),
  );
  return job.jobId;
}

describe('CardExplorerReader (M08.26C)', () => {
  it('reports a played card’s inclusion, its partner and its contributing deck/match, leaving experimentEvidence null when no job was named', async () => {
    await writeMatch('match_a', envelope('match_a'));
    const view = unwrap(
      await reader().readView({ cardId: 'arcane_snare', jobId: null }),
    );

    const blue = view.inclusions.find((entry) => entry.commanderId === 'chief_containment_scholar');
    expect(blue?.status).toBe('played');
    expect(blue?.matchesIncluding).toBe(1);
    expect(blue?.inclusion).toBe(1);
    expect(blue?.observedIn).toEqual({
      realm: 'live_match',
      source: 'human_human',
      contentVersion: 5,
      rulesVersion: '1.0.0',
    });

    const partner = view.partners.find((entry) => entry.partnerCardId === 'veteran_guard');
    expect(partner?.commanderId).toBe('chief_containment_scholar');
    expect(partner?.matchesIncludingBoth).toBe(1);

    expect(view.contributingDecks).toHaveLength(1);
    expect(view.contributingDecks[0]?.commanderId).toBe('chief_containment_scholar');
    expect(view.contributingMatches).toEqual([
      {
        matchId: 'match_a',
        deckHash: view.contributingDecks[0]?.deckHash,
        commanderId: 'chief_containment_scholar',
        observedIn: {
          realm: 'live_match',
          source: 'human_human',
          contentVersion: 5,
          rulesVersion: '1.0.0',
        },
      },
    ]);

    expect(view.unavailablePartitions).toEqual([]);
    expect(view.experimentEvidence).toBeNull();
  });

  it('reports a held legal card as inclusion 0 (not unusable) and an off-colour card as unusable with a null inclusion rate', async () => {
    await writeMatch('match_a', envelope('match_a', { seats: [
      { seatIndex: 0, playerId: 'player_1', kind: 'human', deck: blueDeckWithoutSnare() },
      { seatIndex: 1, playerId: 'player_2', kind: 'human', deck: redDeck() },
    ] }));

    const held = unwrap(await reader().readView({ cardId: 'archive_acolyte', jobId: null }));
    const heldBlue = held.inclusions.find(
      (entry) => entry.commanderId === 'chief_containment_scholar',
    );
    expect(heldBlue?.status).toBe('held');
    expect(heldBlue?.matchesIncluding).toBe(0);
    expect(heldBlue?.inclusion).toBe(0);
    expect(held.contributingDecks).toEqual([]);
    expect(held.contributingMatches).toEqual([]);

    const unusable = unwrap(await reader().readView({ cardId: 'banner_keeper', jobId: null }));
    const unusableBlue = unusable.inclusions.find(
      (entry) => entry.commanderId === 'chief_containment_scholar',
    );
    expect(unusableBlue?.status).toBe('unusable');
    expect(unusableBlue?.inclusion).toBeNull();
    expect(unusableBlue?.inclusionByUniqueDeck).toBeNull();
  });

  it('reports an unavailable partition, with a stated reason, when no card database is supplied for its content version', async () => {
    await writeMatch(
      'match_a',
      envelope('match_a', { provenance: { softwareVersion: '1.0.0', contentVersion: 999, rulesVersion: '1.0.0' } }),
    );

    const view = unwrap(await reader().readView({ cardId: 'arcane_snare', jobId: null }));

    expect(view.inclusions).toEqual([]);
    expect(view.unavailablePartitions).toHaveLength(1);
    expect(view.unavailablePartitions[0]?.observedIn.contentVersion).toBe(999);
    expect(view.unavailablePartitions[0]?.reason.length).toBeGreaterThan(0);
  });

  it('reads experimentEvidence with a found row, stamped with the job’s own sourceClasses and environment', async () => {
    await writeMatch('match_a', envelope('match_a'));
    const jobId = await seedJob();

    const view = unwrap(await reader().readView({ cardId: 'arcane_snare', jobId }));

    expect(view.experimentEvidence?.jobId).toBe(jobId);
    expect(view.experimentEvidence?.row?.definitionId).toBe('arcane_snare');
    expect(view.experimentEvidence?.observedIn).toEqual({
      realm: 'experiment',
      sourceClasses: ['ai', 'precon'],
      environment: { environmentId: 'baseline', hashes: testIdentity().environments[0]?.hashes },
    });
  });

  it('reports experimentEvidence with row null when the named job’s cards table has no row for this card — checked, not found', async () => {
    await writeMatch('match_a', envelope('match_a'));
    const jobId = await seedJob();

    const view = unwrap(await reader().readView({ cardId: 'no_such_card', jobId }));

    expect(view.experimentEvidence).not.toBeNull();
    expect(view.experimentEvidence?.row).toBeNull();
  });

  it('fails the whole request when the named job cannot be read, rather than reporting experimentEvidence null or row null', async () => {
    const refused = await reader().readView({
      cardId: 'arcane_snare',
      jobId: 'job_does_not_exist' as JobId,
    });

    expect(isErr(refused)).toBe(true);
  });

  it('refuses a resultRootId that is not configured, rather than guessing another root', async () => {
    const unconfigured = new CardExplorerReader({
      roots: catalog.roots,
      resultRootId: 'unconfigured',
      store: catalog.store,
    });

    const refused = await unconfigured.readView({ cardId: 'arcane_snare', jobId: null });

    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/unsafe_result_reference');
  });
});
