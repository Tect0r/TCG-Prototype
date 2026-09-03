import { z } from 'zod';
import { cardIdSchema, formatIdSchema } from '@tcg/card-data';
import { deckEntrySchema, deckFingerprint, DECK_FINGERPRINT_LENGTH, type DeckEntry } from '@tcg/deck';
import { matchResultSchema, playerIdSchema } from '@tcg/rules-engine';

/**
 * The versioned live-match analytics envelope (M08.21A): a strict, durable
 * record of one completed live match, reusing `@tcg/rules-engine`'s own
 * `matchResultSchema` for outcome and `@tcg/deck`'s own fingerprint for deck
 * identity rather than restating either. Termination-origin detail (the six
 * ways a match actually ends, per CLAUDE.md's product rules) is M08.21B's
 * field, not this one; privacy and pseudonymous participant identity are
 * M08.21D's. This slice only proves the envelope round-trips, refuses an
 * unknown field, and refuses a schema version it cannot read.
 *
 * **Why exactly two seats.** The engine and `@tcg/multiplayer-server` allow
 * 2–4 seat free-for-all matches, but `source` (`human_human` / `human_ai` /
 * `ai_ai`) is only well-defined for two participants. Rather than inventing an
 * unreviewed N-seat classification, this slice scopes the envelope to exactly
 * two seats — the actual shape of every match played so far — and leaves
 * 3–4 seat source classification to a later, explicitly named slice, the same
 * further-scope-narrowing call M08.19A made for `enqueueAdaptive` wiring.
 */

export const LIVE_MATCH_ENVELOPE_SCHEMA_VERSION = 1;

/** Whether `found` is a readable schema version this build is simply too new or old to read. */
export function isReadableLiveMatchEnvelopeVersion(found: unknown): found is number {
  return (
    typeof found === 'number' &&
    Number.isInteger(found) &&
    found === LIVE_MATCH_ENVELOPE_SCHEMA_VERSION
  );
}

/**
 * The readable refusal for a live-match envelope's declared `schemaVersion`,
 * meant to be checked before the strict schema is even reached. `null` when
 * the version is one this build can read.
 *
 * A live-match record is written once by the server that ran the match
 * (M08.22) and can be read much later by a build that reports on it — the
 * same gap `describeAdaptiveVersionProblem` exists for in the simulator — so
 * it gets the same readable treatment rather than a bare `z.literal` mismatch.
 */
export function describeLiveMatchEnvelopeVersionProblem(found: unknown): string | null {
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
    return 'This live-match record does not declare a readable schema version, so it cannot be read.';
  }
  if (found > LIVE_MATCH_ENVELOPE_SCHEMA_VERSION) {
    return (
      `This live-match record was written by a newer build (schema version ${String(found)}; ` +
      `this build reads up to ${String(LIVE_MATCH_ENVELOPE_SCHEMA_VERSION)}). Update the application.`
    );
  }
  if (found < LIVE_MATCH_ENVELOPE_SCHEMA_VERSION) {
    return (
      `This live-match record was written by an older build (schema version ${String(found)}; ` +
      `this build reads version ${String(LIVE_MATCH_ENVELOPE_SCHEMA_VERSION)}) and there is no ` +
      'migration for it, so it was left where it is rather than guessed at.'
    );
  }
  return null;
}

/** Throws the readable refusal above when `found` is not a version this build reads. */
export function assertReadableLiveMatchEnvelopeVersion(found: unknown): void {
  const problem = describeLiveMatchEnvelopeVersionProblem(found);
  if (problem !== null) throw new Error(problem);
}

/** Which side of the match a seat's controller actually is. Drives `source` classification below. */
export const LIVE_MATCH_PARTICIPANT_KINDS = ['human', 'bot'] as const;
export const liveMatchParticipantKindSchema = z.enum(LIVE_MATCH_PARTICIPANT_KINDS);
export type LiveMatchParticipantKind = z.infer<typeof liveMatchParticipantKindSchema>;

/** The three two-seat compositions this milestone classifies. */
export const LIVE_MATCH_SOURCES = ['human_human', 'human_ai', 'ai_ai'] as const;
export const liveMatchSourceSchema = z.enum(LIVE_MATCH_SOURCES);
export type LiveMatchSource = z.infer<typeof liveMatchSourceSchema>;

/** The `source` a pair of seat kinds actually describes, independent of what a caller claims. */
export function liveMatchSourceOf(
  seatKinds: readonly [LiveMatchParticipantKind, LiveMatchParticipantKind],
): LiveMatchSource {
  const [first, second] = seatKinds;
  if (first === 'human' && second === 'human') return 'human_human';
  if (first === 'bot' && second === 'bot') return 'ai_ai';
  return 'human_ai';
}

/**
 * A deck exactly as it stood when the match started: the flat entry list plus
 * the fingerprint `@tcg/deck`'s `deckFingerprint` takes over it. The hash is
 * re-verified below rather than trusted, so "exact immutable deck snapshot" is
 * a checked schema property and not merely a caller's claim about itself.
 */
export const liveMatchDeckSnapshotSchema = z.strictObject({
  commanderId: cardIdSchema,
  cards: z.array(deckEntrySchema).min(1),
  deckHash: z.string().length(DECK_FINGERPRINT_LENGTH),
});
export type LiveMatchDeckSnapshot = z.infer<typeof liveMatchDeckSnapshotSchema>;

/** Freezes a deck into the snapshot shape above, computing its hash rather than accepting one. */
export function freezeLiveMatchDeckSnapshot(deck: {
  commanderId: LiveMatchDeckSnapshot['commanderId'];
  cards: readonly DeckEntry[];
}): LiveMatchDeckSnapshot {
  const cards = [...deck.cards];
  return {
    commanderId: deck.commanderId,
    cards,
    deckHash: deckFingerprint({ commanderId: deck.commanderId, cards }),
  };
}

export const liveMatchSeatSchema = z.strictObject({
  seatIndex: z.union([z.literal(0), z.literal(1)]),
  playerId: playerIdSchema,
  kind: liveMatchParticipantKindSchema,
  deck: liveMatchDeckSnapshotSchema,
});
export type LiveMatchSeat = z.infer<typeof liveMatchSeatSchema>;

export const liveMatchProvenanceSchema = z.strictObject({
  /**
   * A string this package does not own or compute: the build that recorded
   * the match stamps its own version here, the same way `generatorVersion`
   * on `@tcg/bot-config`'s `generatedDeckProvenanceSchema` is a value the
   * generator stamps rather than a constant this schema restates.
   */
  softwareVersion: z.string().min(1).max(64),
  /** `CARD_SCHEMA_VERSION` as it stood at match time — a recorded fact, not a current-build constraint. */
  contentVersion: z.number().int().min(1),
  /** `MatchState.rulesVersion` as it stood at match time. */
  rulesVersion: z.string().min(1),
});
export type LiveMatchProvenance = z.infer<typeof liveMatchProvenanceSchema>;

export const liveMatchEnvelopeSchema = z
  .strictObject({
    schemaVersion: z.literal(LIVE_MATCH_ENVELOPE_SCHEMA_VERSION),
    /** An opaque identifier for the match this record describes. This package does not assign it. */
    matchId: z.string().min(1).max(128),
    source: liveMatchSourceSchema,
    formatId: formatIdSchema,
    provenance: liveMatchProvenanceSchema,
    seats: z.tuple([liveMatchSeatSchema, liveMatchSeatSchema]),
    /** The accepted-action count, from `MatchState.actionLog.length`. Turn and event counts live on `outcome`. */
    actionCount: z.number().int().min(0),
    /** Reused wholesale from `@tcg/rules-engine`: outcome, reason, `finalTurn`, `finalSequence`. */
    outcome: matchResultSchema,
  })
  .superRefine((envelope, ctx) => {
    const [seatA, seatB] = envelope.seats;

    if (seatA.seatIndex !== 0 || seatB.seatIndex !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['seats'],
        message: 'Seats must be recorded in order: seatIndex 0 then seatIndex 1.',
      });
    }

    if (seatA.playerId === seatB.playerId) {
      ctx.addIssue({
        code: 'custom',
        path: ['seats'],
        message: 'A match has two distinct seats; both seats named the same playerId.',
      });
    }

    const expectedSource = liveMatchSourceOf([seatA.kind, seatB.kind]);
    if (envelope.source !== expectedSource) {
      ctx.addIssue({
        code: 'custom',
        path: ['source'],
        message: `Declared source "${envelope.source}" does not match the seats' kinds, which describe "${expectedSource}".`,
      });
    }

    for (const [index, seat] of envelope.seats.entries()) {
      const expectedHash = deckFingerprint({ commanderId: seat.deck.commanderId, cards: seat.deck.cards });
      if (seat.deck.deckHash !== expectedHash) {
        ctx.addIssue({
          code: 'custom',
          path: ['seats', index, 'deck', 'deckHash'],
          message: 'This deck snapshot\'s hash does not match its own contents.',
        });
      }
    }

    const seatPlayerIds = new Set([seatA.playerId, seatB.playerId]);
    const { outcome } = envelope;
    if (outcome.winnerId !== null && !seatPlayerIds.has(outcome.winnerId)) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome', 'winnerId'],
        message: 'The outcome names a winner who is not one of this match\'s two seats.',
      });
    }
    for (const [index, loserId] of outcome.loserIds.entries()) {
      if (!seatPlayerIds.has(loserId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['outcome', 'loserIds', index],
          message: 'The outcome names a loser who is not one of this match\'s two seats.',
        });
      }
    }
    if (outcome.outcome === 'win') {
      if (outcome.winnerId === null || outcome.loserIds.length !== 1 || outcome.loserIds[0] === outcome.winnerId) {
        ctx.addIssue({
          code: 'custom',
          path: ['outcome'],
          message: 'A two-seat win must name a winner and exactly the other seat as loser.',
        });
      }
    } else if (outcome.winnerId !== null || new Set(outcome.loserIds).size !== 2) {
      ctx.addIssue({
        code: 'custom',
        path: ['outcome'],
        message: 'A two-seat draw must name no winner and both seats as losers.',
      });
    }
  });
export type LiveMatchEnvelope = z.infer<typeof liveMatchEnvelopeSchema>;

/** Parses a live-match envelope, refusing an unreadable schema version before the strict shape check runs. */
export function parseLiveMatchEnvelope(input: unknown): LiveMatchEnvelope {
  if (input !== null && typeof input === 'object') {
    assertReadableLiveMatchEnvelopeVersion((input as { schemaVersion?: unknown }).schemaVersion);
  }
  return liveMatchEnvelopeSchema.parse(input);
}
