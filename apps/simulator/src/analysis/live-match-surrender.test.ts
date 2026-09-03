import { describe, expect, it } from 'vitest';
import {
  freezeLiveMatchDeckSnapshot,
  type LiveMatchEnvelope,
  type LiveMatchEventWindow,
  type LiveMatchPreActionCapture,
} from '@tcg/match-telemetry';
import type { CombatState, PendingChoice, ReactionWindowState } from '@tcg/rules-engine';
import { aggregateLiveMatchSurrenders } from './live-match-surrender.js';

/**
 * M08.24D — surrender state and exposure windows.
 *
 * Covers: matching a capture to its envelope by `matchId` (and reporting a
 * missing envelope, an origin mismatch or an unseated player as `unmatched`
 * rather than dropping it); Commander/deck/turn/phase/origin tallies;
 * structural state (combat/Reaction window/pending choice — never board,
 * Health or resource numbers); exposure-adjusted recent-event-type and
 * recent-card proximity with event/action/turn/round distances and a
 * Wilson-bounded exposure rate; and source/version partitioning consistent
 * with `live-match-aggregate.ts`'s own partitioning.
 */

const eventCause = { actionType: null, sourceInstanceId: null, resolutionId: null };

const idleCombat: CombatState = {
  attacks: [],
  awaitingDefenders: [],
  submissions: [],
  blocks: [],
  combatantInstanceIds: [],
  damageResolved: false,
};

const activeCombat: CombatState = {
  attacks: [{ attackerInstanceId: 'unit_1', defenderPlayerId: 'player_2' }],
  awaitingDefenders: ['player_2'],
  submissions: [],
  blocks: [],
  combatantInstanceIds: ['unit_1'],
  damageResolved: false,
};

const pendingChoiceFixture: PendingChoice = {
  id: 'choice_1',
  playerId: 'player_1',
  type: 'select_cards',
  reason: 'hand_size_discard',
  zone: null,
  minimum: 0,
  maximum: 2,
  validEntityIds: ['card_1', 'card_2'],
  ordered: false,
  sourceInstanceId: null,
  provenance: {
    origin: 'turn_structure',
    itemId: null,
    effectIndex: null,
    effectType: null,
    sourceControllerId: null,
    chooser: 'none',
    targetRelation: 'none',
    intent: 'neutral',
  },
  continuation: { kind: 'turn_end_discard' },
};

const reactionWindowFixture: ReactionWindowState = {
  id: 'window_1',
  windows: ['when_opponent_plays_spell'],
  triggerSequence: 5,
  priorityOrder: ['player_1', 'player_2'],
  priorityIndex: 0,
  playsByPlayer: { player_1: 0, player_2: 0 },
  passedPlayerIds: [],
  pending: [],
  closed: false,
  resumePhase: 'main_1',
};

function eventWindow(overrides: Partial<LiveMatchEventWindow> = {}): LiveMatchEventWindow {
  return {
    recentEvents: [
      { type: 'turn_started', sequence: 8, cause: eventCause, playerId: 'player_1', turn: 3 },
      {
        type: 'unit_deployed',
        sequence: 9,
        cause: eventCause,
        playerId: 'player_2',
        instanceId: 'unit_9',
        definitionId: 'prototype_scout',
      },
      {
        type: 'phase_changed',
        sequence: 12,
        cause: eventCause,
        from: 'declare_attackers',
        to: 'main_2',
      },
    ],
    eventDistances: [
      { sequence: 8, eventsAgo: 4, actionsAgo: 2, turnsAgo: 2 },
      { sequence: 9, eventsAgo: 3, actionsAgo: 1, turnsAgo: 1 },
      { sequence: 12, eventsAgo: 0, actionsAgo: 0, turnsAgo: 0 },
    ],
    currentTurnWindow: { turn: 3, startSequence: 8, endSequence: 12 },
    previousTurnWindow: { turn: 2, startSequence: 5, endSequence: 7 },
    ...overrides,
  };
}

const blueDeck = () =>
  freezeLiveMatchDeckSnapshot({
    commanderId: 'prototype_commander_blue',
    cards: [{ cardId: 'prototype_drone', quantity: 40 }],
  });
const redDeck = () =>
  freezeLiveMatchDeckSnapshot({
    commanderId: 'prototype_commander_red',
    cards: [{ cardId: 'prototype_scout', quantity: 40 }],
  });

function envelope(overrides: Partial<LiveMatchEnvelope> = {}): LiveMatchEnvelope {
  return {
    schemaVersion: 3,
    matchId: 'match_1',
    source: 'human_human',
    formatId: 'precon_wave_1',
    provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    seats: [
      { seatIndex: 0, playerId: 'player_1', kind: 'human', deck: blueDeck() },
      { seatIndex: 1, playerId: 'player_2', kind: 'human', deck: redDeck() },
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
    ...overrides,
  };
}

function capture(overrides: Partial<LiveMatchPreActionCapture> = {}): LiveMatchPreActionCapture {
  return {
    schemaVersion: 3,
    matchId: 'match_1',
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
    deck: blueDeck(),
    ...overrides,
  };
}

describe('aggregateLiveMatchSurrenders', () => {
  it('reports an unmatched capture when no envelope shares its matchId', () => {
    const result = aggregateLiveMatchSurrenders([capture({ matchId: 'missing' })], []);

    expect(result.aggregates).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0]?.reason).toMatch(/No live-match record/);
  });

  it('reports an unmatched capture when the origin disagrees with its envelope', () => {
    const result = aggregateLiveMatchSurrenders(
      [capture({ origin: 'concede_leave' })],
      [envelope({ terminationOrigin: 'concede_action' })],
    );

    expect(result.aggregates).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0]?.reason).toMatch(/does not match/);
  });

  it('reports an unmatched capture when the player is not seated in the match', () => {
    const result = aggregateLiveMatchSurrenders([capture({ playerId: 'player_9' })], [envelope()]);

    expect(result.aggregates).toHaveLength(0);
    expect(result.unmatched).toHaveLength(1);
    expect(result.unmatched[0]?.reason).toMatch(/not seated/);
  });

  it('never pools distinct sources or versions into one partition', () => {
    const result = aggregateLiveMatchSurrenders(
      [
        capture({ matchId: 'm_human' }),
        capture({ matchId: 'm_ai', playerId: 'player_1' }),
        capture({
          matchId: 'm_v2',
          provenance: { softwareVersion: '1.0.0', contentVersion: 6, rulesVersion: '1.0.0' },
        }),
      ],
      [
        envelope({ matchId: 'm_human', source: 'human_human' }),
        envelope({ matchId: 'm_ai', source: 'human_ai' }),
        envelope({
          matchId: 'm_v2',
          provenance: { softwareVersion: '1.0.0', contentVersion: 6, rulesVersion: '1.0.0' },
        }),
      ],
    );

    expect(result.unmatched).toHaveLength(0);
    expect(result.aggregates).toHaveLength(3);
    expect(result.aggregates.map((entry) => entry.surrenders)).toEqual([1, 1, 1]);
  });

  it('tallies commander, deck, turn, phase and origin counts', () => {
    const result = aggregateLiveMatchSurrenders(
      [
        capture({ matchId: 'm1', turn: 3, phase: 'main_1', origin: 'concede_action' }),
        capture({ matchId: 'm2', turn: 3, phase: 'main_1', origin: 'concede_action' }),
        capture({ matchId: 'm3', turn: 5, phase: 'main_2', origin: 'concede_leave' }),
      ],
      [
        envelope({ matchId: 'm1', terminationOrigin: 'concede_action' }),
        envelope({ matchId: 'm2', terminationOrigin: 'concede_action' }),
        envelope({ matchId: 'm3', terminationOrigin: 'concede_leave' }),
      ],
    );

    expect(result.aggregates).toHaveLength(1);
    const aggregate = result.aggregates[0];
    expect(aggregate?.surrenders).toBe(3);
    expect(aggregate?.commanders).toEqual([
      { commanderId: 'prototype_commander_blue', surrenders: 3 },
    ]);
    expect(aggregate?.turns).toEqual([
      { turn: 3, surrenders: 2 },
      { turn: 5, surrenders: 1 },
    ]);
    expect(aggregate?.phases).toEqual([
      { phase: 'main_1', surrenders: 2 },
      { phase: 'main_2', surrenders: 1 },
    ]);
    expect(aggregate?.originCounts).toEqual([
      { origin: 'concede_action', surrenders: 2 },
      { origin: 'concede_leave', surrenders: 1 },
    ]);
    expect(aggregate?.decks).toHaveLength(1);
    expect(aggregate?.decks[0]?.surrenders).toBe(3);
  });

  it('summarizes structural state without any board, Health or resource figure', () => {
    const result = aggregateLiveMatchSurrenders(
      [
        capture({ matchId: 'm1', combat: activeCombat }),
        capture({ matchId: 'm2', reactionWindow: reactionWindowFixture }),
        capture({ matchId: 'm3', pendingChoice: pendingChoiceFixture }),
        capture({ matchId: 'm4' }),
      ],
      [
        envelope({ matchId: 'm1' }),
        envelope({ matchId: 'm2' }),
        envelope({ matchId: 'm3' }),
        envelope({ matchId: 'm4' }),
      ],
    );

    const state = result.aggregates[0]?.state;
    expect(state).toEqual({
      total: 4,
      inCombat: 1,
      reactionWindowOpen: 1,
      pendingChoiceOpen: 1,
      pendingChoiceTypes: [{ choiceType: 'select_cards', surrenders: 1 }],
    });
    expect(state).not.toHaveProperty('health');
    expect(state).not.toHaveProperty('board');
  });

  it('computes exposure-adjusted recent-card and recent-event-type proximity with distances', () => {
    const result = aggregateLiveMatchSurrenders(
      [capture({ matchId: 'm1' }), capture({ matchId: 'm2', eventWindow: eventWindow() })],
      [envelope({ matchId: 'm1' }), envelope({ matchId: 'm2' })],
    );

    const exposure = result.aggregates[0]?.exposure;
    const scout = exposure?.recentCards.find((entry) => entry.key === 'prototype_scout');
    expect(scout).toBeDefined();
    expect(scout?.exposures).toBe(2);
    expect(scout?.exposureRate.point).toBe(1);
    expect(scout?.eventsAgo).toEqual({ min: 3, mean: 3, max: 3 });
    expect(scout?.actionsAgo).toEqual({ min: 1, mean: 1, max: 1 });
    expect(scout?.turnsAgo).toEqual({ min: 1, mean: 1, max: 1 });
    expect(scout?.roundsAgo).toEqual({ min: 0, mean: 0, max: 0 });

    const deployed = exposure?.recentEventTypes.find((entry) => entry.key === 'unit_deployed');
    expect(deployed?.exposures).toBe(2);

    const started = exposure?.recentEventTypes.find((entry) => entry.key === 'turn_started');
    expect(started?.exposures).toBe(2);
    expect(started?.turnsAgo).toEqual({ min: 2, mean: 2, max: 2 });
  });

  it('reports a card exposure of less than the total when only some surrenders saw it', () => {
    const result = aggregateLiveMatchSurrenders(
      [
        capture({ matchId: 'm1' }),
        capture({
          matchId: 'm2',
          eventWindow: eventWindow({
            recentEvents: [
              {
                type: 'turn_started',
                sequence: 3,
                cause: eventCause,
                playerId: 'player_1',
                turn: 1,
              },
            ],
            eventDistances: [{ sequence: 3, eventsAgo: 0, actionsAgo: 0, turnsAgo: 0 }],
          }),
        }),
      ],
      [envelope({ matchId: 'm1' }), envelope({ matchId: 'm2' })],
    );

    const exposure = result.aggregates[0]?.exposure;
    const scout = exposure?.recentCards.find((entry) => entry.key === 'prototype_scout');
    expect(scout?.exposures).toBe(1);
    expect(scout?.exposureRate.point).toBe(0.5);
    expect(scout?.exposureRate.total).toBe(2);
  });

  it('returns no aggregates and no unmatched entries for empty input', () => {
    const result = aggregateLiveMatchSurrenders([], []);
    expect(result.aggregates).toEqual([]);
    expect(result.unmatched).toEqual([]);
  });
});
