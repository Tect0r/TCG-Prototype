import { describe, expect, it } from 'vitest';
import { deckFingerprint } from '@tcg/deck';
import type { CombatState, PendingChoice, ReactionWindowState } from '@tcg/rules-engine';
import type { LiveMatchEventWindow } from './event-window.js';
import {
  LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION,
  describeLiveMatchPreActionCaptureVersionProblem,
  liveMatchPreActionCaptureSchema,
  parseLiveMatchPreActionCapture,
  type LiveMatchPreActionCapture,
} from './pre-action-capture.js';
import { freezeLiveMatchDeckSnapshot, type LiveMatchProvenance } from './schema.js';

/**
 * The pre-action capture contract (M08.23A, widened M08.23B): schema round
 * trip, unknown-field and unreadable-version refusal, that the engine's own
 * pending choice, combat and Reaction window shapes carry through unchanged,
 * and the event-window/provenance/deck cross-field invariants M08.23B added.
 * No builder or server wiring here — that lives in `apps/multiplayer-server`.
 */

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

const combatFixture: CombatState = {
  attacks: [{ attackerInstanceId: 'unit_1', defenderPlayerId: 'player_2' }],
  awaitingDefenders: ['player_2'],
  submissions: [],
  blocks: [],
  combatantInstanceIds: ['unit_1'],
  damageResolved: false,
};

const reactionWindowFixture: ReactionWindowState = {
  id: 'window_1',
  windows: ['when_opponent_plays_spell'],
  triggerSequence: 5,
  priorityOrder: ['player_1', 'player_2'],
  priorityIndex: 0,
  playsByPlayer: { player_1: 0, player_2: 0 },
  passedPlayerIds: [],
  pending: [
    {
      instanceId: 'spell_1',
      definitionId: 'spell_card',
      controllerId: 'player_2',
      countered: false,
      counteredByInstanceId: null,
      isSubject: true,
    },
  ],
  closed: false,
  resumePhase: 'main_1',
};

const eventCause = { actionType: null, sourceInstanceId: null, resolutionId: null };

const eventWindowFixture: LiveMatchEventWindow = {
  recentEvents: [
    { type: 'turn_started', sequence: 8, cause: eventCause, playerId: 'player_1', turn: 3 },
    { type: 'phase_changed', sequence: 9, cause: eventCause, from: 'main_1', to: 'declare_attackers' },
    { type: 'phase_changed', sequence: 12, cause: eventCause, from: 'declare_attackers', to: 'main_2' },
  ],
  eventDistances: [
    { sequence: 8, eventsAgo: 4, actionsAgo: 2, turnsAgo: 0 },
    { sequence: 9, eventsAgo: 3, actionsAgo: 1, turnsAgo: 0 },
    { sequence: 12, eventsAgo: 0, actionsAgo: 0, turnsAgo: 0 },
  ],
  currentTurnWindow: { turn: 3, startSequence: 8, endSequence: 12 },
  previousTurnWindow: { turn: 2, startSequence: 5, endSequence: 7 },
};

const provenanceFixture: LiveMatchProvenance = {
  softwareVersion: 'test-build',
  contentVersion: 1,
  rulesVersion: 'rules-1',
};

const deckFixture = freezeLiveMatchDeckSnapshot({
  commanderId: 'cmd_alpha',
  cards: [{ cardId: 'card_a', quantity: 40 }],
});

function validCapture(): LiveMatchPreActionCapture {
  return {
    schemaVersion: LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION,
    matchId: 'match_001',
    playerId: 'player_1',
    turn: 3,
    phase: 'main_1',
    activePlayerId: 'player_1',
    sequence: 12,
    pendingChoice: pendingChoiceFixture,
    combat: combatFixture,
    reactionWindow: reactionWindowFixture,
    eventWindow: eventWindowFixture,
    provenance: provenanceFixture,
    deck: deckFixture,
  };
}

describe('liveMatchPreActionCaptureSchema', () => {
  it('round trips a valid capture with pending choice, combat and reaction window all present', () => {
    const capture = validCapture();
    expect(liveMatchPreActionCaptureSchema.parse(capture)).toEqual(capture);
  });

  it('round trips a valid capture with no pending choice or reaction window and idle combat', () => {
    const capture: LiveMatchPreActionCapture = {
      ...validCapture(),
      pendingChoice: null,
      reactionWindow: null,
      combat: {
        attacks: [],
        awaitingDefenders: [],
        submissions: [],
        blocks: [],
        combatantInstanceIds: [],
        damageResolved: false,
      },
    };
    expect(liveMatchPreActionCaptureSchema.parse(capture)).toEqual(capture);
  });

  it('refuses an unknown field', () => {
    const withExtra = { ...validCapture(), unexpected: true };
    expect(() => liveMatchPreActionCaptureSchema.parse(withExtra)).toThrow();
  });

  it('refuses a playerId that is not a seat-derived participant id', () => {
    const withBadPlayer = { ...validCapture(), playerId: 'display-name-here' };
    expect(() => liveMatchPreActionCaptureSchema.parse(withBadPlayer)).toThrow();
  });

  it('refuses a missing or non-numeric schema version', () => {
    expect(describeLiveMatchPreActionCaptureVersionProblem(undefined)).toMatch(/does not declare/);
    expect(describeLiveMatchPreActionCaptureVersionProblem('1')).toMatch(/does not declare/);
  });

  it('refuses a newer schema version with a readable message', () => {
    const problem = describeLiveMatchPreActionCaptureVersionProblem(
      LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION + 1,
    );
    expect(problem).toMatch(/newer build/);
  });

  it('accepts the current schema version', () => {
    expect(
      describeLiveMatchPreActionCaptureVersionProblem(LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION),
    ).toBeNull();
  });
});

describe('liveMatchPreActionCaptureSchema event window cross-checks (M08.23B)', () => {
  it('refuses a current turn window whose turn does not match the capture', () => {
    const capture = {
      ...validCapture(),
      eventWindow: {
        ...eventWindowFixture,
        currentTurnWindow: { ...eventWindowFixture.currentTurnWindow, turn: 4 },
      },
    };
    expect(() => liveMatchPreActionCaptureSchema.parse(capture)).toThrow();
  });

  it('refuses a current turn window that does not end at the capture sequence', () => {
    const capture = {
      ...validCapture(),
      eventWindow: {
        ...eventWindowFixture,
        currentTurnWindow: { ...eventWindowFixture.currentTurnWindow, endSequence: 99 },
      },
    };
    expect(() => liveMatchPreActionCaptureSchema.parse(capture)).toThrow();
  });

  it('refuses a previous turn window on turn 1', () => {
    const capture = {
      ...validCapture(),
      turn: 1,
      eventWindow: {
        ...eventWindowFixture,
        currentTurnWindow: { turn: 1, startSequence: 8, endSequence: 12 },
      },
    };
    expect(() => liveMatchPreActionCaptureSchema.parse(capture)).toThrow();
  });

  it('refuses a missing previous turn window past turn 1', () => {
    const capture = { ...validCapture(), eventWindow: { ...eventWindowFixture, previousTurnWindow: null } };
    expect(() => liveMatchPreActionCaptureSchema.parse(capture)).toThrow();
  });

  it('refuses a previous turn window that does not end immediately before the current one starts', () => {
    const capture = {
      ...validCapture(),
      eventWindow: {
        ...eventWindowFixture,
        previousTurnWindow: { ...eventWindowFixture.previousTurnWindow!, endSequence: 6 },
      },
    };
    expect(() => liveMatchPreActionCaptureSchema.parse(capture)).toThrow();
  });

  it('refuses a mismatched count of recent events and event distances', () => {
    const capture = {
      ...validCapture(),
      eventWindow: { ...eventWindowFixture, eventDistances: eventWindowFixture.eventDistances.slice(1) },
    };
    expect(() => liveMatchPreActionCaptureSchema.parse(capture)).toThrow();
  });

  it("refuses an eventsAgo that does not equal the capture's sequence minus the event's own", () => {
    const capture = {
      ...validCapture(),
      eventWindow: {
        ...eventWindowFixture,
        eventDistances: eventWindowFixture.eventDistances.map((distance, index) =>
          index === 0 ? { ...distance, eventsAgo: distance.eventsAgo + 1 } : distance,
        ),
      },
    };
    expect(() => liveMatchPreActionCaptureSchema.parse(capture)).toThrow();
  });

  it('refuses when the most recent retained event is not at the capture sequence', () => {
    const capture = {
      ...validCapture(),
      eventWindow: {
        ...eventWindowFixture,
        recentEvents: eventWindowFixture.recentEvents.slice(0, -1),
        eventDistances: eventWindowFixture.eventDistances.slice(0, -1),
      },
    };
    expect(() => liveMatchPreActionCaptureSchema.parse(capture)).toThrow();
  });

  it("refuses a deck snapshot whose hash does not match its own contents", () => {
    const capture = { ...validCapture(), deck: { ...deckFixture, deckHash: deckFingerprint({ commanderId: 'cmd_other', cards: [] }) } };
    expect(() => liveMatchPreActionCaptureSchema.parse(capture)).toThrow();
  });

  it('round trips the widened capture with its event window, provenance and deck intact', () => {
    const capture = validCapture();
    expect(parseLiveMatchPreActionCapture(capture)).toEqual(capture);
  });
});

describe('parseLiveMatchPreActionCapture', () => {
  it('throws the readable refusal before the strict schema runs', () => {
    const capture = { ...validCapture(), schemaVersion: LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION + 1 };
    expect(() => parseLiveMatchPreActionCapture(capture)).toThrow(/newer build/);
  });

  it('parses a valid capture', () => {
    expect(parseLiveMatchPreActionCapture(validCapture())).toEqual(validCapture());
  });
});
