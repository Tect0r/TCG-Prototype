import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  NO_PLAYER_META_FILTER,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  adaptiveExperimentIdSchema,
} from '@tcg/admin-contracts';
import { isErr, unwrap } from '@tcg/shared';
import { freezeLiveMatchDeckSnapshot, type LiveMatchEnvelope } from '@tcg/match-telemetry';

import { resolveCatalogRoots, type ResolvedCatalogRoots } from '../catalog/roots.js';

import {
  commanderRecordsOf,
  decisiveMatchesOf,
  MatchRepresentativesReader,
  selectClosest,
} from './match-representatives.js';

/**
 * M08.26E — the Match Representatives read model over the same live-match
 * root `MatchExplorerReader` reads (`./match-explorer.test.ts`'s own fixture
 * conventions), plus, when a caller names one, an Adaptive Counter experiment
 * directory under that same root (`./adaptive-results.test.ts`'s).
 */

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'tcg-admin-match-representatives-'));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const BLUE_DECK = freezeLiveMatchDeckSnapshot({
  commanderId: 'prototype_commander_blue',
  cards: [{ cardId: 'prototype_drone', quantity: 40 }],
});

const RED_DECK = freezeLiveMatchDeckSnapshot({
  commanderId: 'prototype_commander_red',
  cards: [{ cardId: 'prototype_scout', quantity: 40 }],
});

function outcomeOf(winnerId: string, loserId: string): NonNullable<LiveMatchEnvelope['outcome']> {
  return {
    outcome: 'win',
    winnerId,
    loserIds: [loserId],
    reason: 'health_depleted',
    finalTurn: 10,
    finalSequence: 200,
    diagnostics: null,
  };
}

function envelope(matchId: string, overrides: Partial<LiveMatchEnvelope> = {}): LiveMatchEnvelope {
  return {
    schemaVersion: 3,
    matchId,
    source: 'human_ai',
    formatId: 'precon_wave_1',
    provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    seats: [
      { seatIndex: 0, playerId: 'player_1', kind: 'human', deck: BLUE_DECK },
      { seatIndex: 1, playerId: 'player_2', kind: 'bot', deck: RED_DECK },
    ],
    actionCount: 40,
    terminationOrigin: 'rules_victory',
    outcome: outcomeOf('player_1', 'player_2'),
    ...overrides,
  };
}

function writeMatch(matchId: string, match: LiveMatchEnvelope): void {
  const directory = join(root, matchId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'envelope.json'), JSON.stringify(match), 'utf8');
}

function roots(): ResolvedCatalogRoots {
  return unwrap(
    resolveCatalogRoots({
      catalogRoot: join(root, 'catalog'),
      resultRoots: { default: root },
    }),
  );
}

function reader(): MatchRepresentativesReader {
  return new MatchRepresentativesReader({ roots: roots(), resultRootId: 'default' });
}

const firstPage = { limit: PAGE_SIZE_DEFAULT, cursor: null };

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
    deck: deck('prototype_commander_blue', BLUE_DECK.deckHash),
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
        revision({
          revisionId: 'rev_root_opponent',
          deck: deck('prototype_commander_red', 'bbbb2222'),
        }),
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

describe('MatchRepresentativesReader.readView (M08.26E)', () => {
  it('reports every category null and an empty abnormal list over an empty result root', async () => {
    const view = unwrap(
      await reader().readView({
        filter: NO_PLAYER_META_FILTER,
        adaptiveExperimentId: null,
        page: firstPage,
      }),
    );

    expect(view.representatives.map((entry) => entry.match)).toEqual(
      Array(view.representatives.length).fill(null),
    );
    expect(view.abnormalMatches).toEqual({
      items: [],
      page: { returned: 0, limit: PAGE_SIZE_DEFAULT, nextCursor: null, total: 0 },
    });
  });

  it('selects closest, largest_upset and most_one_sided by the Commander win-rate-skew proxy', async () => {
    // Blue's overall record: 3-1 (75%). Red's overall record: 1-3 (25%). Skew = winner - loser.
    writeMatch('match_a', envelope('match_a', { outcome: outcomeOf('player_1', 'player_2') })); // blue beats red: skew +0.5 (favourite wins)
    writeMatch('match_b', envelope('match_b', { outcome: outcomeOf('player_1', 'player_2') })); // blue beats red again
    writeMatch('match_c', envelope('match_c', { outcome: outcomeOf('player_1', 'player_2') })); // blue beats red again
    writeMatch('match_d', envelope('match_d', { outcome: outcomeOf('player_2', 'player_1') })); // red (underdog) beats blue: upset

    const view = unwrap(
      await reader().readView({
        filter: NO_PLAYER_META_FILTER,
        adaptiveExperimentId: null,
        page: firstPage,
      }),
    );

    const byKind = new Map(view.representatives.map((entry) => [entry.kind, entry.match]));
    expect(byKind.get('largest_upset')?.ref).toEqual({ kind: 'match', matchId: 'match_d' });
    expect(byKind.get('most_one_sided')?.ref?.kind).toBe('match');
    expect(byKind.get('closest')).not.toBeNull();
  });

  it('picks closest by |skew| deterministically, independent of input order, when a favourite-win and the upset share the exact same skew magnitude with opposite sign', () => {
    // Every favourite-win match against a given opponent and the set's one
    // upset between the same two Commanders are mathematically guaranteed to
    // share |skew| (proportionDifference(A, B).point === -proportionDifference(B, A).point),
    // so this tie is not a contrived edge case — it is the normal shape of
    // this fixture (and of `match_a`..`match_d` above). This bypasses the
    // filesystem entirely rather than trying to force a write order:
    // `readLiveMatchEnvelopes` reads via unsorted `readdirSync`, whose order
    // is filesystem-dependent and not something a test may assume — on one
    // Windows/NTFS box observed during development it happened to always
    // return entries alphabetically regardless of write order, which would
    // make a filesystem-level reproduction of this bug silently pass even
    // when broken. Calling `selectClosest` directly with an explicitly
    // reversed array is the only reliable way to prove order-independence.
    const matches = [
      envelope('match_a', { outcome: outcomeOf('player_1', 'player_2') }), // blue (favourite) beats red
      envelope('match_b', { outcome: outcomeOf('player_1', 'player_2') }),
      envelope('match_c', { outcome: outcomeOf('player_1', 'player_2') }),
      envelope('match_d', { outcome: outcomeOf('player_2', 'player_1') }), // red (underdog) beats blue: the upset
    ];
    const decisive = decisiveMatchesOf(matches);
    const records = commanderRecordsOf(decisive);

    const forward = selectClosest(decisive, records);
    const reversed = selectClosest([...decisive].reverse(), records);

    expect(forward?.match.matchId).toBe('match_a');
    expect(reversed?.match.matchId).toBe('match_a');
  });

  it('selects shortest and longest by actionCount among completed matches', async () => {
    writeMatch('match_short', envelope('match_short', { actionCount: 5 }));
    writeMatch('match_long', envelope('match_long', { actionCount: 500 }));
    writeMatch('match_mid', envelope('match_mid', { actionCount: 50 }));

    const view = unwrap(
      await reader().readView({
        filter: NO_PLAYER_META_FILTER,
        adaptiveExperimentId: null,
        page: firstPage,
      }),
    );

    const byKind = new Map(view.representatives.map((entry) => [entry.kind, entry.match]));
    expect(byKind.get('shortest')?.ref).toEqual({ kind: 'match', matchId: 'match_short' });
    expect(byKind.get('longest')?.ref).toEqual({ kind: 'match', matchId: 'match_long' });
  });

  it('deterministically reproduces random_ordinary across repeated calls over the same filtered pool', async () => {
    writeMatch('match_a', envelope('match_a'));
    writeMatch('match_b', envelope('match_b'));
    writeMatch('match_c', envelope('match_c'));

    const first = unwrap(
      await reader().readView({
        filter: NO_PLAYER_META_FILTER,
        adaptiveExperimentId: null,
        page: firstPage,
      }),
    );
    const second = unwrap(
      await reader().readView({
        filter: NO_PLAYER_META_FILTER,
        adaptiveExperimentId: null,
        page: firstPage,
      }),
    );

    const randomOf = (view: typeof first) =>
      view.representatives.find((entry) => entry.kind === 'random_ordinary')?.match;
    expect(randomOf(first)).not.toBeNull();
    expect(randomOf(first)).toEqual(randomOf(second));
  });

  it('excludes abnormal-origin matches from random_ordinary, leaving null when only abnormal matches exist', async () => {
    writeMatch(
      'match_a',
      envelope('match_a', {
        terminationOrigin: 'disconnect_timeout',
        outcome: { ...outcomeOf('player_1', 'player_2'), reason: 'timeout' },
      }),
    );

    const view = unwrap(
      await reader().readView({
        filter: NO_PLAYER_META_FILTER,
        adaptiveExperimentId: null,
        page: firstPage,
      }),
    );

    const randomOrdinary = view.representatives.find((entry) => entry.kind === 'random_ordinary');
    expect(randomOrdinary?.match).toBeNull();
  });

  it('reports pre_adaptation null when no adaptiveExperimentId is named', async () => {
    writeMatch('match_a', envelope('match_a'));

    const view = unwrap(
      await reader().readView({
        filter: NO_PLAYER_META_FILTER,
        adaptiveExperimentId: null,
        page: firstPage,
      }),
    );

    expect(view.adaptiveExperimentId).toBeNull();
    expect(view.representatives.find((entry) => entry.kind === 'pre_adaptation')?.match).toBeNull();
  });

  it('finds the last live match played with a superseded revision as pre_adaptation', async () => {
    const experimentId = adaptiveExperimentIdSchema.parse('goblin_counter');
    const runDirectory = join(root, experimentId);
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(
      join(runDirectory, 'adaptive-result.json'),
      JSON.stringify(
        resultDocument({
          lineages: {
            incumbent: [
              revision({
                revisionId: 'rev_0',
                generation: 0,
                deck: deck('prototype_commander_blue', BLUE_DECK.deckHash),
              }),
              revision({
                revisionId: 'rev_1',
                parentRevisionId: 'rev_0',
                generation: 1,
                block: 1,
                opponentRevisionId: 'rev_root_opponent',
                construction: 'swap',
                swaps: [{ cardOut: 'prototype_drone', cardIn: 'prototype_scout' }],
                deck: deck('prototype_commander_blue', 'zzzz9999'),
              }),
            ],
            opponent: [
              revision({
                revisionId: 'rev_root_opponent',
                deck: deck('prototype_commander_red', RED_DECK.deckHash),
              }),
            ],
          },
        }),
      ),
      'utf8',
    );
    writeMatch('match_old', envelope('match_old'));

    const view = unwrap(
      await reader().readView({
        filter: NO_PLAYER_META_FILTER,
        adaptiveExperimentId: experimentId,
        page: firstPage,
      }),
    );

    expect(view.adaptiveExperimentId).toBe(experimentId);
    const preAdaptation = view.representatives.find(
      (entry) => entry.kind === 'pre_adaptation',
    )?.match;
    expect(preAdaptation?.ref).toEqual({ kind: 'match', matchId: 'match_old' });
  });

  it('reports pre_adaptation null when the named experiment has no superseded revision', async () => {
    const experimentId = adaptiveExperimentIdSchema.parse('goblin_counter');
    const runDirectory = join(root, experimentId);
    mkdirSync(runDirectory, { recursive: true });
    writeFileSync(
      join(runDirectory, 'adaptive-result.json'),
      JSON.stringify(resultDocument()),
      'utf8',
    );
    writeMatch('match_a', envelope('match_a'));

    const view = unwrap(
      await reader().readView({
        filter: NO_PLAYER_META_FILTER,
        adaptiveExperimentId: experimentId,
        page: firstPage,
      }),
    );

    expect(view.representatives.find((entry) => entry.kind === 'pre_adaptation')?.match).toBeNull();
  });

  it('fails the whole request when the named experiment cannot be read', async () => {
    const experimentId = adaptiveExperimentIdSchema.parse('nothing_here');

    const refused = await reader().readView({
      filter: NO_PLAYER_META_FILTER,
      adaptiveExperimentId: experimentId,
      page: firstPage,
    });

    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
  });

  it('lists only abnormal-origin matches, paged, with a reason and cross-navigation ref each', async () => {
    writeMatch('match_ok', envelope('match_ok'));
    writeMatch(
      'match_timeout',
      envelope('match_timeout', {
        terminationOrigin: 'disconnect_timeout',
        outcome: { ...outcomeOf('player_1', 'player_2'), reason: 'timeout' },
      }),
    );
    writeMatch(
      'match_failure',
      envelope('match_failure', {
        terminationOrigin: 'server_failure',
        outcome: {
          ...outcomeOf('player_1', 'player_2'),
          reason: 'engine_error',
          diagnostics: 'boom',
        },
      }),
    );

    const view = unwrap(
      await reader().readView({
        filter: NO_PLAYER_META_FILTER,
        adaptiveExperimentId: null,
        page: firstPage,
      }),
    );

    expect(view.abnormalMatches.items.map((entry) => entry.ref.matchId)).toEqual([
      'match_failure',
      'match_timeout',
    ]);
    expect(view.abnormalMatches.page.total).toBe(2);
    for (const entry of view.abnormalMatches.items) {
      expect(entry.reason.length).toBeGreaterThan(0);
      expect(entry.observedIn.realm).toBe('live_match');
    }
  });

  it('paginates the abnormal list via the shared cursor', async () => {
    for (let index = 0; index < 3; index += 1) {
      writeMatch(
        `match_${String(index)}`,
        envelope(`match_${String(index)}`, {
          terminationOrigin: 'server_failure',
          outcome: {
            ...outcomeOf('player_1', 'player_2'),
            reason: 'engine_error',
            diagnostics: 'boom',
          },
        }),
      );
    }

    const first = unwrap(
      await reader().readView({
        filter: NO_PLAYER_META_FILTER,
        adaptiveExperimentId: null,
        page: { limit: 2, cursor: null },
      }),
    );
    expect(first.abnormalMatches.items).toHaveLength(2);
    expect(first.abnormalMatches.page.nextCursor).not.toBeNull();

    const second = unwrap(
      await reader().readView({
        filter: NO_PLAYER_META_FILTER,
        adaptiveExperimentId: null,
        page: { limit: 2, cursor: first.abnormalMatches.page.nextCursor },
      }),
    );
    expect(second.abnormalMatches.items).toHaveLength(1);
    expect(second.abnormalMatches.page.nextCursor).toBeNull();
  });

  it('bounds a genuinely large abnormal-match set at PAGE_SIZE_MAX rather than the browser ever seeing more', async () => {
    const total = PAGE_SIZE_MAX + 5;
    for (let index = 0; index < total; index += 1) {
      const matchId = `match_${String(index).padStart(4, '0')}`;
      writeMatch(
        matchId,
        envelope(matchId, {
          terminationOrigin: 'server_failure',
          outcome: {
            ...outcomeOf('player_1', 'player_2'),
            reason: 'engine_error',
            diagnostics: 'boom',
          },
        }),
      );
    }

    const first = unwrap(
      await reader().readView({
        filter: NO_PLAYER_META_FILTER,
        adaptiveExperimentId: null,
        page: { limit: PAGE_SIZE_MAX, cursor: null },
      }),
    );
    expect(first.abnormalMatches.items).toHaveLength(PAGE_SIZE_MAX);
    expect(first.abnormalMatches.page.nextCursor).not.toBeNull();
    expect(first.abnormalMatches.page.total).toBe(total);

    const second = unwrap(
      await reader().readView({
        filter: NO_PLAYER_META_FILTER,
        adaptiveExperimentId: null,
        page: { limit: PAGE_SIZE_MAX, cursor: first.abnormalMatches.page.nextCursor },
      }),
    );
    expect(second.abnormalMatches.items).toHaveLength(5);
    expect(second.abnormalMatches.page.nextCursor).toBeNull();

    const seenIds = new Set(
      [...first.abnormalMatches.items, ...second.abnormalMatches.items].map(
        (entry) => entry.ref.matchId,
      ),
    );
    expect(seenIds.size).toBe(total);
  });

  it('refuses a resultRootId that is not configured, rather than guessing another root', async () => {
    const refused = await new MatchRepresentativesReader({
      roots: roots(),
      resultRootId: 'unconfigured',
    }).readView({ filter: NO_PLAYER_META_FILTER, adaptiveExperimentId: null, page: firstPage });

    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/unsafe_result_reference');
  });
});
