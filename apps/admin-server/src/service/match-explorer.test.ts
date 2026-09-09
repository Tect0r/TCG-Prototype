import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NO_PLAYER_META_FILTER, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from '@tcg/admin-contracts';
import { isErr, unwrap } from '@tcg/shared';
import {
  freezeLiveMatchDeckSnapshot,
  type LiveMatchEnvelope,
  type LiveMatchEventWindow,
  type LiveMatchPreActionCapture,
} from '@tcg/match-telemetry';
import type { CombatState } from '@tcg/rules-engine';

import { resolveCatalogRoots, type ResolvedCatalogRoots } from '../catalog/roots.js';

import { MatchExplorerReader } from './match-explorer.js';

/**
 * M08.26D — the Match Explorer read model over the same live-match root
 * `DeckExplorerReader`/`CardExplorerReader` already read
 * (`./deck-explorer.test.ts`/`./card-explorer.test.ts`'s own fixture
 * conventions), plus the optional per-match `raw-event.json`/`replay.json`/
 * `pre-action-capture.json` artifacts `./live-match-artifact-read.test.ts`
 * and `./live-match-surrender-read.test.ts` (`@tcg/simulator`) already cover
 * in isolation.
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tcg-admin-match-explorer-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const TARGET_DECK = freezeLiveMatchDeckSnapshot({
  commanderId: 'prototype_commander_blue',
  cards: [{ cardId: 'prototype_drone', quantity: 40 }],
});

const OPPONENT_DECK = freezeLiveMatchDeckSnapshot({
  commanderId: 'prototype_commander_red',
  cards: [{ cardId: 'prototype_scout', quantity: 40 }],
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

/** `terminationOrigin: 'concede_action'` requires `outcome.reason: 'concede'` (`liveMatchEnvelopeSchema`'s cross-field check). */
const concedeOutcome: LiveMatchEnvelope['outcome'] = { ...winOutcome, reason: 'concede' };

function envelope(matchId: string, overrides: Partial<LiveMatchEnvelope> = {}): LiveMatchEnvelope {
  return {
    schemaVersion: 3,
    matchId,
    source: 'human_ai',
    formatId: 'precon_wave_1',
    provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    seats: [
      { seatIndex: 0, playerId: 'player_1', kind: 'human', deck: TARGET_DECK },
      { seatIndex: 1, playerId: 'player_2', kind: 'bot', deck: OPPONENT_DECK },
    ],
    actionCount: 40,
    terminationOrigin: 'rules_victory',
    outcome: winOutcome,
    ...overrides,
  };
}

function writeMatch(matchId: string, match: LiveMatchEnvelope): void {
  const directory = join(root, matchId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'envelope.json'), JSON.stringify(match), 'utf8');
}

const eventCause = { actionType: null, sourceInstanceId: null, resolutionId: null };

const idleCombat: CombatState = {
  attacks: [],
  awaitingDefenders: [],
  submissions: [],
  blocks: [],
  combatantInstanceIds: [],
  damageResolved: false,
};

function eventWindow(): LiveMatchEventWindow {
  return {
    recentEvents: [
      { type: 'turn_started', sequence: 12, cause: eventCause, playerId: 'player_1', turn: 3 },
    ],
    eventDistances: [{ sequence: 12, eventsAgo: 0, actionsAgo: 0, turnsAgo: 0 }],
    currentTurnWindow: { turn: 3, startSequence: 8, endSequence: 12 },
    previousTurnWindow: { turn: 2, startSequence: 5, endSequence: 7 },
  };
}

function capture(
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
    eventWindow: eventWindow(),
    provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    deck: TARGET_DECK,
    ...overrides,
  };
}

function writeCapture(matchId: string, overrides: Partial<LiveMatchPreActionCapture> = {}): void {
  const directory = join(root, matchId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'pre-action-capture.json'),
    JSON.stringify(capture(matchId, overrides)),
    'utf8',
  );
}

function rawEventArtifact(matchId: string, log: unknown[]): Record<string, unknown> {
  return { schemaVersion: 1, matchId, log, actionLog: [] };
}

function writeRawEvent(matchId: string, log: unknown[]): void {
  const directory = join(root, matchId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'raw-event.json'),
    JSON.stringify(rawEventArtifact(matchId, log)),
    'utf8',
  );
}

function writeReplay(matchId: string): void {
  const directory = join(root, matchId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, 'replay.json'),
    JSON.stringify({ schemaVersion: 1, matchId, seed: 'seed_one', actionLog: [] }),
    'utf8',
  );
}

function roots(): ResolvedCatalogRoots {
  return unwrap(
    resolveCatalogRoots({
      catalogRoot: join(root, 'catalog'),
      resultRoots: { default: root },
    }),
  );
}

function reader(): MatchExplorerReader {
  return new MatchExplorerReader({ roots: roots(), resultRootId: 'default' });
}

const firstPage = { limit: PAGE_SIZE_DEFAULT, cursor: null };

describe('MatchExplorerReader.readList (M08.26D)', () => {
  it('lists matches deterministically ordered by matchId, with observedIn evidence', async () => {
    writeMatch('match_b', envelope('match_b'));
    writeMatch('match_a', envelope('match_a'));

    const list = unwrap(
      await reader().readList({ filter: NO_PLAYER_META_FILTER, page: firstPage }),
    );

    expect(list.items.map((row) => row.matchId)).toEqual(['match_a', 'match_b']);
    expect(list.items[0]?.observedIn).toEqual({
      realm: 'live_match',
      source: 'human_ai',
      contentVersion: 5,
      rulesVersion: '1.0.0',
    });
    expect(list.items[0]?.seats).toEqual([
      {
        seatIndex: 0,
        playerId: 'player_1',
        kind: 'human',
        commanderId: 'prototype_commander_blue',
        deckHash: TARGET_DECK.deckHash,
        deckRef: { kind: 'deck', deckHash: TARGET_DECK.deckHash },
      },
      {
        seatIndex: 1,
        playerId: 'player_2',
        kind: 'bot',
        commanderId: 'prototype_commander_red',
        deckHash: OPPONENT_DECK.deckHash,
        deckRef: { kind: 'deck', deckHash: OPPONENT_DECK.deckHash },
      },
    ]);
    expect(list.page).toEqual({ returned: 2, limit: 50, nextCursor: null, total: 2 });
  });

  it('applies the playerMetaFilter reused verbatim, narrowing by terminationOrigin', async () => {
    writeMatch('match_a', envelope('match_a'));
    writeMatch(
      'match_b',
      envelope('match_b', { terminationOrigin: 'concede_action', outcome: concedeOutcome }),
    );

    const list = unwrap(
      await reader().readList({
        filter: { ...NO_PLAYER_META_FILTER, terminations: ['concede_action'] },
        page: firstPage,
      }),
    );

    expect(list.items.map((row) => row.matchId)).toEqual(['match_b']);
  });

  it('pages via the shared cursor, round-tripping to the next page', async () => {
    writeMatch('match_a', envelope('match_a'));
    writeMatch('match_b', envelope('match_b'));
    writeMatch('match_c', envelope('match_c'));

    const first = unwrap(
      await reader().readList({ filter: NO_PLAYER_META_FILTER, page: { limit: 2, cursor: null } }),
    );
    expect(first.items.map((row) => row.matchId)).toEqual(['match_a', 'match_b']);
    expect(first.page.nextCursor).not.toBeNull();

    const second = unwrap(
      await reader().readList({
        filter: NO_PLAYER_META_FILTER,
        page: { limit: 2, cursor: first.page.nextCursor },
      }),
    );
    expect(second.items.map((row) => row.matchId)).toEqual(['match_c']);
    expect(second.page.nextCursor).toBeNull();
  });

  it('bounds a genuinely large match set at PAGE_SIZE_MAX rather than the browser ever seeing more', async () => {
    const total = PAGE_SIZE_MAX + 5;
    for (let index = 0; index < total; index += 1) {
      const matchId = `match_${String(index).padStart(4, '0')}`;
      writeMatch(matchId, envelope(matchId));
    }

    const first = unwrap(
      await reader().readList({
        filter: NO_PLAYER_META_FILTER,
        page: { limit: PAGE_SIZE_MAX, cursor: null },
      }),
    );
    expect(first.items).toHaveLength(PAGE_SIZE_MAX);
    expect(first.page).toEqual({
      returned: PAGE_SIZE_MAX,
      limit: PAGE_SIZE_MAX,
      nextCursor: expect.any(String),
      total,
    });

    const second = unwrap(
      await reader().readList({
        filter: NO_PLAYER_META_FILTER,
        page: { limit: PAGE_SIZE_MAX, cursor: first.page.nextCursor },
      }),
    );
    expect(second.items).toHaveLength(5);
    expect(second.page.nextCursor).toBeNull();

    const seenIds = new Set([...first.items, ...second.items].map((row) => row.matchId));
    expect(seenIds.size).toBe(total);
  });

  it('refuses a resultRootId that is not configured, rather than guessing another root', async () => {
    const refused = await new MatchExplorerReader({
      roots: roots(),
      resultRootId: 'unconfigured',
    }).readList({ filter: NO_PLAYER_META_FILTER, page: firstPage });

    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/unsafe_result_reference');
  });
});

describe('MatchExplorerReader.readView (M08.26D)', () => {
  it('reports full seat/deck snapshots and outcome, with all three artifacts not_retained when none were written', async () => {
    writeMatch(
      'match_a',
      envelope('match_a', { terminationOrigin: 'concede_action', outcome: concedeOutcome }),
    );

    const view = unwrap(await reader().readView({ matchId: 'match_a' }));

    expect(view.seats[0]).toEqual({
      seatIndex: 0,
      playerId: 'player_1',
      kind: 'human',
      deck: {
        commanderId: 'prototype_commander_blue',
        cards: TARGET_DECK.cards.map((card) => ({
          ...card,
          cardRef: { kind: 'card', cardId: card.cardId },
        })),
        deckHash: TARGET_DECK.deckHash,
      },
      deckRef: { kind: 'deck', deckHash: TARGET_DECK.deckHash },
    });
    expect(view.outcome).toEqual(concedeOutcome);
    expect(view.artifacts).toEqual({
      rawEvent: 'not_retained',
      replay: 'not_retained',
      preActionCapture: 'not_retained',
    });
    expect(view.decisionDiagnostics).toBeNull();
  });

  it('reports preActionCapture not_applicable on a non-voluntary termination, even if a stray capture file exists', async () => {
    writeMatch('match_a', envelope('match_a', { terminationOrigin: 'rules_victory' }));
    writeCapture('match_a');

    const view = unwrap(await reader().readView({ matchId: 'match_a' }));

    expect(view.artifacts.preActionCapture).toBe('not_applicable');
    expect(view.decisionDiagnostics).toBeNull();
  });

  it('reports preActionCapture present and populates decisionDiagnostics on a voluntary termination with a capture', async () => {
    writeMatch(
      'match_a',
      envelope('match_a', { terminationOrigin: 'concede_action', outcome: concedeOutcome }),
    );
    writeCapture('match_a');

    const view = unwrap(await reader().readView({ matchId: 'match_a' }));

    expect(view.artifacts.preActionCapture).toBe('present');
    expect(view.decisionDiagnostics).toEqual({
      playerId: 'player_1',
      origin: 'concede_action',
      turn: 3,
      phase: 'main_1',
      activePlayerId: 'player_1',
      sequence: 12,
      inCombat: false,
      reactionWindowOpen: false,
      pendingChoiceOpen: false,
      pendingChoiceType: null,
      recentEvents: [
        { sequence: 12, type: 'turn_started', summary: expect.stringContaining('turn_started') },
      ],
    });
  });

  it('reports rawEvent and replay present when written, with flattened summaries never restating the raw union', async () => {
    writeMatch('match_a', envelope('match_a'));
    writeRawEvent('match_a', [
      { type: 'turn_started', sequence: 1, cause: eventCause, playerId: 'player_1', turn: 1 },
    ]);
    writeReplay('match_a');

    const view = unwrap(await reader().readView({ matchId: 'match_a' }));

    expect(view.artifacts.rawEvent).toBe('present');
    expect(view.artifacts.replay).toBe('present');
  });

  it('refuses an unknown matchId with admin/no_result rather than a null view', async () => {
    const refused = await reader().readView({ matchId: 'does_not_exist' });

    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
  });

  it('refuses a resultRootId that is not configured', async () => {
    const refused = await new MatchExplorerReader({
      roots: roots(),
      resultRootId: 'unconfigured',
    }).readView({ matchId: 'match_a' });

    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/unsafe_result_reference');
  });
});

describe('MatchExplorerReader.readEventTimeline (M08.26D)', () => {
  it('reports not_retained with a null page when no raw-event artifact exists', async () => {
    writeMatch('match_a', envelope('match_a'));

    const timeline = unwrap(
      await reader().readEventTimeline({ matchId: 'match_a', page: firstPage }),
    );

    expect(timeline).toEqual({ status: 'not_retained', page: null });
  });

  it('paginates flattened events when a raw-event artifact exists, round-tripping the cursor', async () => {
    writeMatch('match_a', envelope('match_a'));
    writeRawEvent('match_a', [
      { type: 'turn_started', sequence: 1, cause: eventCause, playerId: 'player_1', turn: 1 },
      { type: 'turn_started', sequence: 2, cause: eventCause, playerId: 'player_2', turn: 1 },
      { type: 'turn_started', sequence: 3, cause: eventCause, playerId: 'player_1', turn: 2 },
    ]);

    const first = unwrap(
      await reader().readEventTimeline({ matchId: 'match_a', page: { limit: 2, cursor: null } }),
    );
    expect(first.status).toBe('present');
    expect(first.page?.items.map((event) => event.sequence)).toEqual([1, 2]);
    expect(first.page?.page.nextCursor).not.toBeNull();

    const second = unwrap(
      await reader().readEventTimeline({
        matchId: 'match_a',
        page: { limit: 2, cursor: first.page?.page.nextCursor ?? null },
      }),
    );
    expect(second.page?.items.map((event) => event.sequence)).toEqual([3]);
    expect(second.page?.page.nextCursor).toBeNull();
  });

  it('refuses an unknown matchId with admin/no_result', async () => {
    const refused = await reader().readEventTimeline({
      matchId: 'does_not_exist',
      page: firstPage,
    });

    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
  });
});
