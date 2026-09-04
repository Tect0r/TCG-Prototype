import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { adaptiveExperimentIdSchema } from '@tcg/admin-contracts';
import { isErr, unwrap } from '@tcg/shared';
import { freezeLiveMatchDeckSnapshot, type LiveMatchEnvelope } from '@tcg/match-telemetry';

import { resolveCatalogRoots, type ResolvedCatalogRoots } from '../catalog/roots.js';

import { DeckExplorerReader } from './deck-explorer.js';

/**
 * M08.26B — the Deck Explorer read model over the same live-match root
 * `PlayerMetaResultReader` reads (`./player-meta-results.test.ts`'s own
 * fixture conventions) plus, when a caller names one, an Adaptive Counter
 * experiment directory under that same root (`./adaptive-results.test.ts`'s).
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tcg-admin-deck-explorer-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
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

const TARGET_DECK = freezeLiveMatchDeckSnapshot({
  commanderId: 'prototype_commander_blue',
  cards: [{ cardId: 'prototype_drone', quantity: 40 }],
});

function envelope(matchId: string, overrides: Partial<LiveMatchEnvelope> = {}): LiveMatchEnvelope {
  return {
    schemaVersion: 3,
    matchId,
    source: 'human_ai',
    formatId: 'precon_wave_1',
    provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    seats: [
      { seatIndex: 0, playerId: 'player_1', kind: 'human', deck: TARGET_DECK },
      {
        seatIndex: 1,
        playerId: 'player_2',
        kind: 'bot',
        deck: freezeLiveMatchDeckSnapshot({
          commanderId: 'prototype_commander_red',
          cards: [{ cardId: 'prototype_scout', quantity: 40 }],
        }),
      },
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

function deck(commanderId: string, hash: string): Record<string, unknown> {
  return {
    id: `d_${hash}`,
    label: `deck ${hash}`,
    commanderId,
    cards: [{ cardId: 'card_one', quantity: 1 }],
    hash,
  };
}

function revision(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    revisionId: 'rev_root_incumbent',
    experimentId: 'goblin_counter',
    parentRevisionId: null,
    generation: 0,
    block: 0,
    opponentRevisionId: null,
    construction: 'root',
    swaps: [],
    seedPath: 'seed|adaptive:goblin_counter|gen:0000|block:0000',
    deck: deck('cmd_bastion', TARGET_DECK.deckHash),
    ...overrides,
  };
}

function resultDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 3,
    experimentId: 'goblin_counter',
    configHash: 'abcdef0123456789',
    informationPolicy: 'public_observation',
    lineages: {
      incumbent: [revision()],
      opponent: [
        revision({ revisionId: 'rev_root_opponent', deck: deck('cmd_goblin', 'bbbb2222') }),
      ],
    },
    seriesTally: { incumbentWins: 0, opponentWins: 0, ties: 0, noDecisions: 0 },
    series: [],
    screeningRounds: [],
    referenceField: null,
    finalDeckDiff: {
      incumbent: {
        rootRevisionId: 'rev_root_incumbent',
        finalRevisionId: 'rev_root_incumbent',
        swaps: [],
        commanderChanged: false,
      },
      opponent: {
        rootRevisionId: 'rev_root_opponent',
        finalRevisionId: 'rev_root_opponent',
        swaps: [],
        commanderChanged: false,
      },
    },
    cycles: [],
    validation: null,
    ...overrides,
  };
}

function roots(): ResolvedCatalogRoots {
  return unwrap(
    resolveCatalogRoots({
      catalogRoot: join(root, 'catalog'),
      resultRoots: { default: root },
    }),
  );
}

describe('DeckExplorerReader (M08.26B)', () => {
  it('reads identity off the lowest-matchId envelope carrying the requested deck hash, with knownRevisions null when no experiment is named', async () => {
    writeMatch('match_b', envelope('match_b'));
    writeMatch('match_a', envelope('match_a'));
    const reader = new DeckExplorerReader({ roots: roots(), resultRootId: 'default' });

    const view = unwrap(
      await reader.readView({ deckHash: TARGET_DECK.deckHash, adaptiveExperimentId: null }),
    );

    expect(view.identity).not.toBeNull();
    expect(view.identity?.commanderId).toBe('prototype_commander_blue');
    expect(view.identity?.cards).toEqual([{ cardId: 'prototype_drone', quantity: 40 }]);
    expect(view.identity?.observedIn).toEqual({
      realm: 'live_match',
      source: 'human_ai',
      contentVersion: 5,
      rulesVersion: '1.0.0',
    });
    expect(view.knownRevisions).toBeNull();
  });

  it('reports identity null when no live match carries the requested deck hash', async () => {
    const reader = new DeckExplorerReader({ roots: roots(), resultRootId: 'default' });

    const view = unwrap(
      await reader.readView({ deckHash: TARGET_DECK.deckHash, adaptiveExperimentId: null }),
    );

    expect(view.identity).toBeNull();
    expect(view.knownRevisions).toBeNull();
  });

  it('reports knownRevisions as [] once a named experiment was checked and held no matching row', async () => {
    const experimentId = adaptiveExperimentIdSchema.parse('goblin_counter');
    const runDirectory = join(root, experimentId);
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(
      join(runDirectory, 'adaptive-result.json'),
      JSON.stringify(
        resultDocument({
          lineages: {
            incumbent: [revision({ deck: deck('cmd_bastion', 'no_match_here') })],
            opponent: [
              revision({ revisionId: 'rev_root_opponent', deck: deck('cmd_goblin', 'bbbb2222') }),
            ],
          },
        }),
      ),
      'utf8',
    );
    const reader = new DeckExplorerReader({ roots: roots(), resultRootId: 'default' });

    const view = unwrap(
      await reader.readView({ deckHash: TARGET_DECK.deckHash, adaptiveExperimentId: experimentId }),
    );

    expect(view.knownRevisions).toEqual([]);
  });

  it('collects the matching revision when a named experiment holds one', async () => {
    const experimentId = adaptiveExperimentIdSchema.parse('goblin_counter');
    const runDirectory = join(root, experimentId);
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(
      join(runDirectory, 'adaptive-result.json'),
      JSON.stringify(resultDocument()),
      'utf8',
    );
    const reader = new DeckExplorerReader({ roots: roots(), resultRootId: 'default' });

    const view = unwrap(
      await reader.readView({ deckHash: TARGET_DECK.deckHash, adaptiveExperimentId: experimentId }),
    );

    expect(view.knownRevisions).toEqual([
      {
        side: 'incumbent',
        revisionId: 'rev_root_incumbent',
        parentRevisionId: null,
        generation: 0,
        block: 0,
        opponentRevisionId: null,
        construction: 'root',
        swapCount: 0,
      },
    ]);
  });

  it('fails the whole request when the named experiment cannot be read, rather than reporting null or []', async () => {
    const experimentId = adaptiveExperimentIdSchema.parse('nothing_here');
    const reader = new DeckExplorerReader({ roots: roots(), resultRootId: 'default' });

    const refused = await reader.readView({
      deckHash: TARGET_DECK.deckHash,
      adaptiveExperimentId: experimentId,
    });

    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
  });

  it('refuses a resultRootId that is not configured, rather than guessing another root', async () => {
    const reader = new DeckExplorerReader({ roots: roots(), resultRootId: 'unconfigured' });

    const refused = await reader.readView({
      deckHash: TARGET_DECK.deckHash,
      adaptiveExperimentId: null,
    });

    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/unsafe_result_reference');
  });
});
