import { describe, expect, it } from 'vitest';
import { deckFingerprint } from '@tcg/deck';
import type { MatchResult } from '@tcg/rules-engine';
import {
  LIVE_MATCH_ENVELOPE_SCHEMA_VERSION,
  describeLiveMatchEnvelopeVersionProblem,
  freezeLiveMatchDeckSnapshot,
  liveMatchEnvelopeSchema,
  liveMatchSourceOf,
  parseLiveMatchEnvelope,
  type LiveMatchEnvelope,
} from './schema.js';

/**
 * The versioned live-match envelope (M08.21A). This slice's acceptance line
 * asks for exactly three properties: schema round trip, unknown-field
 * refusal and future-version refusal. The cross-field checks (source
 * classification, deck-hash agreement, outcome/seat consistency) are covered
 * too, since they are what makes those claims checked rather than asserted.
 */

const winnerDeck = () =>
  freezeLiveMatchDeckSnapshot({ commanderId: 'cmd_alpha', cards: [{ cardId: 'card_a', quantity: 40 }] });
const loserDeck = () =>
  freezeLiveMatchDeckSnapshot({ commanderId: 'cmd_beta', cards: [{ cardId: 'card_b', quantity: 40 }] });

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

  it('refuses a declared source that disagrees with the seats\' kinds', () => {
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
    expect(snapshot.deckHash).toBe(deckFingerprint({ commanderId: 'cmd_alpha', cards: snapshot.cards }));
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
