import { describe, expect, it } from 'vitest';
import type { CombatState, PendingChoice, ReactionWindowState } from '@tcg/rules-engine';
import {
  LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION,
  describeLiveMatchPreActionCaptureVersionProblem,
  liveMatchPreActionCaptureSchema,
  parseLiveMatchPreActionCapture,
  type LiveMatchPreActionCapture,
} from './pre-action-capture.js';

/**
 * The pre-action capture contract (M08.23A): schema round trip, unknown-field
 * and unreadable-version refusal, and that the engine's own pending choice,
 * combat and Reaction window shapes carry through unchanged. No builder or
 * server wiring here — that lives in `apps/multiplayer-server`.
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

describe('parseLiveMatchPreActionCapture', () => {
  it('throws the readable refusal before the strict schema runs', () => {
    const capture = { ...validCapture(), schemaVersion: LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION + 1 };
    expect(() => parseLiveMatchPreActionCapture(capture)).toThrow(/newer build/);
  });

  it('parses a valid capture', () => {
    expect(parseLiveMatchPreActionCapture(validCapture())).toEqual(validCapture());
  });
});
