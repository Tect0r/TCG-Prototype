import { describe, expect, it } from 'vitest';
import { deckFingerprint } from '@tcg/deck';
import type { MatchEndReason, MatchResult } from '@tcg/rules-engine';
import {
  LIVE_MATCH_ENVELOPE_SCHEMA_VERSION,
  LIVE_MATCH_TERMINATION_ORIGINS,
  describeLiveMatchEnvelopeVersionProblem,
  freezeLiveMatchDeckSnapshot,
  liveMatchEnvelopeSchema,
  liveMatchParticipantIdSchema,
  liveMatchSourceOf,
  liveMatchTerminationOriginsForReason,
  parseLiveMatchEnvelope,
  type LiveMatchEnvelope,
} from './schema.js';

/**
 * The versioned live-match envelope (M08.21A/M08.21B). This slice's
 * acceptance line asks for exactly three properties: schema round trip,
 * unknown-field refusal and future-version refusal. The cross-field checks
 * (source classification, deck-hash agreement, outcome/seat consistency,
 * termination-origin agreement) are covered too, since they are what makes
 * those claims checked rather than asserted.
 */

const winnerDeck = () =>
  freezeLiveMatchDeckSnapshot({
    commanderId: 'cmd_alpha',
    cards: [{ cardId: 'card_a', quantity: 40 }],
  });
const loserDeck = () =>
  freezeLiveMatchDeckSnapshot({
    commanderId: 'cmd_beta',
    cards: [{ cardId: 'card_b', quantity: 40 }],
  });

const winOutcome: MatchResult = {
  outcome: 'win',
  winnerId: 'player_1',
  loserIds: ['player_2'],
  reason: 'health_depleted',
  finalTurn: 12,
  finalSequence: 240,
  diagnostics: null,
};

function validEnvelope(): LiveMatchEnvelope {
  return {
    schemaVersion: LIVE_MATCH_ENVELOPE_SCHEMA_VERSION,
    matchId: 'match_001',
    source: 'human_human',
    formatId: 'precon_wave_1',
    provenance: { softwareVersion: '1.0.0', contentVersion: 5, rulesVersion: '1.0.0' },
    seats: [
      { seatIndex: 0, playerId: 'player_1', kind: 'human', deck: winnerDeck() },
      { seatIndex: 1, playerId: 'player_2', kind: 'human', deck: loserDeck() },
    ],
    actionCount: 87,
    terminationOrigin: 'rules_victory',
    outcome: winOutcome,
  };
}

describe('liveMatchEnvelopeSchema', () => {
  it('round trips a valid envelope', () => {
    const envelope = validEnvelope();
    const parsed = liveMatchEnvelopeSchema.parse(envelope);
    expect(parsed).toEqual(envelope);
  });

  it('refuses an unknown field', () => {
    const withExtra = { ...validEnvelope(), unexpected: true };
    expect(() => liveMatchEnvelopeSchema.parse(withExtra)).toThrow();
  });

  it('classifies source from seat kinds', () => {
    expect(liveMatchSourceOf(['human', 'human'])).toBe('human_human');
    expect(liveMatchSourceOf(['bot', 'bot'])).toBe('ai_ai');
    expect(liveMatchSourceOf(['human', 'bot'])).toBe('human_ai');
    expect(liveMatchSourceOf(['bot', 'human'])).toBe('human_ai');
  });

  it("refuses a declared source that disagrees with the seats' kinds", () => {
    const envelope = validEnvelope();
    envelope.source = 'human_ai';
    expect(() => liveMatchEnvelopeSchema.parse(envelope)).toThrow();
  });

  it('refuses a deck snapshot whose hash does not match its contents', () => {
    const envelope = validEnvelope();
    envelope.seats[0].deck.deckHash = deckFingerprint({ commanderId: 'cmd_other', cards: [] });
    expect(() => liveMatchEnvelopeSchema.parse(envelope)).toThrow();
  });

  it('freezes a matching deck hash', () => {
    const snapshot = winnerDeck();
    expect(snapshot.deckHash).toBe(
      deckFingerprint({ commanderId: 'cmd_alpha', cards: snapshot.cards }),
    );
  });

  it('refuses two seats naming the same player', () => {
    const envelope = validEnvelope();
    envelope.seats[1].playerId = envelope.seats[0].playerId;
    expect(() => liveMatchEnvelopeSchema.parse(envelope)).toThrow();
  });

  it('refuses a win outcome that does not name exactly the other seat as loser', () => {
    const envelope = validEnvelope();
    envelope.outcome = { ...winOutcome, loserIds: [] };
    expect(() => liveMatchEnvelopeSchema.parse(envelope)).toThrow();
  });

  it('accepts a draw naming no winner and both seats as losers', () => {
    const envelope = validEnvelope();
    envelope.outcome = {
      outcome: 'draw',
      winnerId: null,
      loserIds: ['player_1', 'player_2'],
      reason: 'simultaneous_loss',
      finalTurn: 20,
      finalSequence: 400,
      diagnostics: null,
    };
    expect(() => liveMatchEnvelopeSchema.parse(envelope)).not.toThrow();
  });

  it('refuses an outcome naming a player who is not one of the two seats', () => {
    const envelope = validEnvelope();
    envelope.outcome = { ...winOutcome, winnerId: 'player_9' };
    expect(() => liveMatchEnvelopeSchema.parse(envelope)).toThrow();
  });
});

/**
 * Privacy and participant identity (M08.21D): forbidden personal/secret
 * fields are structurally absent (no field exists to hold them, so
 * `z.strictObject`'s unknown-key refusal is what proves it), participant ids
 * are checked to be the seat-derived shape rather than trusted to be, and
 * the schema draws no link between the same id appearing in two matches.
 */
describe('privacy and participant identity', () => {
  it.each([
    { displayName: 'Alice' },
    { inviteCode: 'ABCD-1234' },
    { reconnectCode: 'zzz999' },
    { ipAddress: '203.0.113.7' },
    { authToken: 'secret-token' },
    { chatLog: ['gg'] },
  ])('refuses an envelope carrying %o', (extra) => {
    const withExtra = { ...validEnvelope(), ...extra };
    expect(() => liveMatchEnvelopeSchema.parse(withExtra)).toThrow();
  });

  it.each([{ displayName: 'Alice' }, { ipAddress: '203.0.113.7' }])(
    'refuses a seat carrying %o',
    (extra) => {
      const envelope = validEnvelope();
      envelope.seats[0] = { ...envelope.seats[0], ...extra } as LiveMatchEnvelope['seats'][0];
      expect(() => liveMatchEnvelopeSchema.parse(envelope)).toThrow();
    },
  );

  it('accepts every seat-derived participant id from player_1 to player_4', () => {
    for (const id of ['player_1', 'player_2', 'player_3', 'player_4']) {
      expect(liveMatchParticipantIdSchema.safeParse(id).success).toBe(true);
    }
  });

  it.each(['player_0', 'player_5', 'Alice', 'alice@example.com', 'player_1 ', ''])(
    'refuses %j as a participant id',
    (id) => {
      expect(liveMatchParticipantIdSchema.safeParse(id).success).toBe(false);
    },
  );

  it('refuses a seat whose playerId is a display name rather than a seat-derived id', () => {
    const envelope = validEnvelope();
    envelope.seats[0].playerId = 'Alice';
    expect(() => liveMatchEnvelopeSchema.parse(envelope)).toThrow();
  });

  it('draws no link between the same participant id in two unrelated matches', () => {
    const first = validEnvelope();
    first.matchId = 'match_alice_vs_bob';
    const second = validEnvelope();
    second.matchId = 'match_carol_vs_dave';
    // Same seat-1/seat-2 ids in both matches; nothing on the schema ties them
    // to the same real person, so both parse independently and identically.
    expect(() => liveMatchEnvelopeSchema.parse(first)).not.toThrow();
    expect(() => liveMatchEnvelopeSchema.parse(second)).not.toThrow();
  });
});

/**
 * The six termination origins (M08.21B): explicit concede action, leave
 * concession, disconnect timeout, rules victory, server failure, and an
 * abandoned/unrecordable match with no `MatchResult` at all.
 */
describe('terminationOrigin', () => {
  it('names all six origins', () => {
    expect(LIVE_MATCH_TERMINATION_ORIGINS).toEqual([
      'concede_action',
      'concede_leave',
      'disconnect_timeout',
      'rules_victory',
      'server_failure',
      'abandoned_unrecordable',
    ]);
  });

  it('accepts either concede origin for a concede reason', () => {
    const concedeOutcome: MatchResult = { ...winOutcome, reason: 'concede' };
    for (const origin of ['concede_action', 'concede_leave'] as const) {
      const envelope = validEnvelope();
      envelope.outcome = concedeOutcome;
      envelope.terminationOrigin = origin;
      expect(() => liveMatchEnvelopeSchema.parse(envelope)).not.toThrow();
    }
  });

  it('refuses a concede reason recorded as disconnect_timeout', () => {
    const envelope = validEnvelope();
    envelope.outcome = { ...winOutcome, reason: 'concede' };
    envelope.terminationOrigin = 'disconnect_timeout';
    expect(() => liveMatchEnvelopeSchema.parse(envelope)).toThrow();
  });

  it('accepts disconnect_timeout for a timeout reason and refuses rules_victory for it', () => {
    const timeoutOutcome: MatchResult = { ...winOutcome, reason: 'timeout' };
    const accepted = validEnvelope();
    accepted.outcome = timeoutOutcome;
    accepted.terminationOrigin = 'disconnect_timeout';
    expect(() => liveMatchEnvelopeSchema.parse(accepted)).not.toThrow();

    const refused = validEnvelope();
    refused.outcome = timeoutOutcome;
    refused.terminationOrigin = 'rules_victory';
    expect(() => liveMatchEnvelopeSchema.parse(refused)).toThrow();
  });

  it.each(['health_depleted', 'empty_deck', 'simultaneous_loss'] satisfies MatchEndReason[])(
    'accepts rules_victory for a %s reason',
    (reason) => {
      const envelope = validEnvelope();
      envelope.outcome = { ...winOutcome, reason };
      envelope.terminationOrigin = 'rules_victory';
      expect(() => liveMatchEnvelopeSchema.parse(envelope)).not.toThrow();
    },
  );

  it('accepts server_failure for an engine_error reason and refuses rules_victory for it', () => {
    const errorOutcome: MatchResult = {
      ...winOutcome,
      reason: 'engine_error',
      diagnostics: 'boom',
    };
    const accepted = validEnvelope();
    accepted.outcome = errorOutcome;
    accepted.terminationOrigin = 'server_failure';
    expect(() => liveMatchEnvelopeSchema.parse(accepted)).not.toThrow();

    const refused = validEnvelope();
    refused.outcome = errorOutcome;
    refused.terminationOrigin = 'rules_victory';
    expect(() => liveMatchEnvelopeSchema.parse(refused)).toThrow();
  });

  it('accepts a null outcome exactly when terminationOrigin is abandoned_unrecordable', () => {
    const accepted = validEnvelope();
    accepted.outcome = null;
    accepted.terminationOrigin = 'abandoned_unrecordable';
    expect(() => liveMatchEnvelopeSchema.parse(accepted)).not.toThrow();
  });

  it('refuses a null outcome recorded under any other origin', () => {
    for (const origin of LIVE_MATCH_TERMINATION_ORIGINS) {
      if (origin === 'abandoned_unrecordable') continue;
      const envelope = validEnvelope();
      envelope.outcome = null;
      envelope.terminationOrigin = origin;
      expect(() => liveMatchEnvelopeSchema.parse(envelope)).toThrow();
    }
  });

  it('refuses abandoned_unrecordable when a real outcome is present', () => {
    const envelope = validEnvelope();
    envelope.terminationOrigin = 'abandoned_unrecordable';
    expect(() => liveMatchEnvelopeSchema.parse(envelope)).toThrow();
  });

  it('round trips a null-outcome, abandoned match', () => {
    const envelope = validEnvelope();
    envelope.outcome = null;
    envelope.terminationOrigin = 'abandoned_unrecordable';
    expect(liveMatchEnvelopeSchema.parse(envelope)).toEqual(envelope);
  });
});

describe('liveMatchTerminationOriginsForReason', () => {
  it('reports both concede origins, and exactly one origin for every other reason', () => {
    expect(liveMatchTerminationOriginsForReason('concede')).toEqual([
      'concede_action',
      'concede_leave',
    ]);
    expect(liveMatchTerminationOriginsForReason('timeout')).toEqual(['disconnect_timeout']);
    expect(liveMatchTerminationOriginsForReason('health_depleted')).toEqual(['rules_victory']);
    expect(liveMatchTerminationOriginsForReason('empty_deck')).toEqual(['rules_victory']);
    expect(liveMatchTerminationOriginsForReason('simultaneous_loss')).toEqual(['rules_victory']);
    expect(liveMatchTerminationOriginsForReason('engine_error')).toEqual(['server_failure']);
  });
});

describe('describeLiveMatchEnvelopeVersionProblem', () => {
  it('accepts the current version', () => {
    expect(describeLiveMatchEnvelopeVersionProblem(LIVE_MATCH_ENVELOPE_SCHEMA_VERSION)).toBeNull();
  });

  it('refuses a newer version with a readable message', () => {
    const problem = describeLiveMatchEnvelopeVersionProblem(LIVE_MATCH_ENVELOPE_SCHEMA_VERSION + 1);
    expect(problem).toMatch(/newer build/);
  });

  it('refuses a missing or non-numeric version', () => {
    expect(describeLiveMatchEnvelopeVersionProblem(undefined)).toMatch(/does not declare/);
    expect(describeLiveMatchEnvelopeVersionProblem('1')).toMatch(/does not declare/);
  });

  it('refuses an older version with a readable message', () => {
    // Versions 1 (M08.21A) and 2 (M08.21B) are real, previously-current
    // versions this build once wrote, not merely hypothetical.
    expect(describeLiveMatchEnvelopeVersionProblem(1)).toMatch(/older build/);
    expect(describeLiveMatchEnvelopeVersionProblem(2)).toMatch(/older build/);
  });
});

describe('parseLiveMatchEnvelope', () => {
  it('throws the readable refusal before the strict schema runs', () => {
    const envelope = { ...validEnvelope(), schemaVersion: LIVE_MATCH_ENVELOPE_SCHEMA_VERSION + 1 };
    expect(() => parseLiveMatchEnvelope(envelope)).toThrow(/newer build/);
  });

  it('parses a valid envelope', () => {
    expect(parseLiveMatchEnvelope(validEnvelope())).toEqual(validEnvelope());
  });
});
