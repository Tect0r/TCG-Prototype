import { z } from 'zod';
import { cardIdSchema, formatIdSchema } from '@tcg/card-data';
import {
  deckEntrySchema,
  deckFingerprint,
  DECK_FINGERPRINT_LENGTH,
  type DeckEntry,
} from '@tcg/deck';
import { matchResultSchema, type MatchEndReason } from '@tcg/rules-engine';

/**
 * The versioned live-match analytics envelope (M08.21A): a strict, durable
 * record of one completed live match, reusing `@tcg/rules-engine`'s own
 * `matchResultSchema` for outcome and `@tcg/deck`'s own fingerprint for deck
 * identity rather than restating either. Termination-origin detail (M08.21B)
 * is above; participant identity (M08.21D, below) is the seat-derived
 * `liveMatchParticipantIdSchema`, never a display name, invite/reconnect
 * code, IP address, auth secret or chat line — none of those has a field on
 * this schema at all, so `z.strictObject`'s unknown-key refusal is what
 * proves their absence rather than merely documenting it.
 *
 * **Why exactly two seats.** The engine and `@tcg/multiplayer-server` allow
 * 2–4 seat free-for-all matches, but `source` (`human_human` / `human_ai` /
 * `ai_ai`) is only well-defined for two participants. Rather than inventing an
 * unreviewed N-seat classification, this slice scopes the envelope to exactly
 * two seats — the actual shape of every match played so far — and leaves
 * 3–4 seat source classification to a later, explicitly named slice, the same
 * further-scope-narrowing call M08.19A made for `enqueueAdaptive` wiring.
 */

export const LIVE_MATCH_ENVELOPE_SCHEMA_VERSION = 3;

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
 * The six ways a live match actually ends (M08.21B), per this milestone's own
 * intro: explicit concede action, leave-message concession, disconnect
 * timeout, rules victory, server failure, and an abandoned or otherwise
 * unrecordable match. `@tcg/rules-engine`'s own `MatchEndReason` cannot carry
 * this distinction — `concede` is the same engine action whether a player
 * clicked "concede" or simply left (`apps/multiplayer-server/src/match-server.ts`'s
 * `leave()`: "Leaving a live match is a concession, not a disconnect"), and a
 * match that stalls with nobody able to act and nothing conceding
 * (`apps/multiplayer-server/src/bot-runner.ts`'s "recorded as a stall,
 * honestly") never produces a `MatchResult` at all. So this field is analytics
 * provenance the record's writer supplies from what it actually observed,
 * never a value read off the engine — the same split this milestone's own
 * description draws between the two concessions.
 */
export const LIVE_MATCH_TERMINATION_ORIGINS = [
  'concede_action',
  'concede_leave',
  'disconnect_timeout',
  'rules_victory',
  'server_failure',
  'abandoned_unrecordable',
] as const;
export const liveMatchTerminationOriginSchema = z.enum(LIVE_MATCH_TERMINATION_ORIGINS);
export type LiveMatchTerminationOrigin = z.infer<typeof liveMatchTerminationOriginSchema>;

/**
 * Which termination origins are consistent with a given engine
 * `MatchEndReason`, when a `MatchResult` exists at all. `concede` is the only
 * reason with more than one valid origin — that ambiguity is exactly what this
 * field exists to resolve. `abandoned_unrecordable` names a match with no
 * `MatchResult` (below), so it is never a valid origin for a reason that came
 * from one.
 */
export function liveMatchTerminationOriginsForReason(
  reason: MatchEndReason,
): readonly LiveMatchTerminationOrigin[] {
  switch (reason) {
    case 'concede':
      return ['concede_action', 'concede_leave'];
    case 'timeout':
      return ['disconnect_timeout'];
    case 'health_depleted':
    case 'empty_deck':
    case 'simultaneous_loss':
      return ['rules_victory'];
    case 'engine_error':
      return ['server_failure'];
  }
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

/**
 * A match-local pseudonymous participant id (M08.21D): the seat-derived label
 * every part of this engine actually produces — `PLAYER_ID_BY_SEAT` in
 * `apps/multiplayer-server/src/lobby.ts` for live matches, and the same
 * `player_1`/`player_2` convention every simulator match uses — never a
 * display name, email or persistent account id. It is fixed per seat number,
 * not per real person: the same value (`player_1`) is the seat-1 occupant in
 * every match ever played, so it identifies "whoever sat in this seat this
 * match," not a person across matches. `@tcg/rules-engine`'s own
 * `playerIdSchema` is a generic `z.string().min(1).max(64)` with no shape
 * constraint, so reusing it verbatim (as M08.21A originally did) would leave
 * "match-local pseudonymous id" a caller's claim rather than a checked
 * property — restated here (ADR 0001) narrower than the engine's own type,
 * matching this package's own two-seat narrowing precedent (M08.21A's doc
 * comment above). Four seats, matching `MIN_SEATS`/`MAX_SEATS` in
 * `@tcg/protocol` (not imported — this package depends on no app-facing
 * package per M08.21A's dependency list), covers every seat count the engine
 * allows even though this envelope itself only ever names two of them.
 */
export const LIVE_MATCH_PARTICIPANT_ID_PATTERN = /^player_[1-4]$/;
export const liveMatchParticipantIdSchema = z
  .string()
  .regex(
    LIVE_MATCH_PARTICIPANT_ID_PATTERN,
    'Must be a seat-derived participant id (player_1..player_4), never a display name, email or account id.',
  );
export type LiveMatchParticipantId = z.infer<typeof liveMatchParticipantIdSchema>;

export const liveMatchSeatSchema = z.strictObject({
  seatIndex: z.union([z.literal(0), z.literal(1)]),
  playerId: liveMatchParticipantIdSchema,
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
    /** One of the six ways this match actually ended (M08.21B). See `liveMatchTerminationOriginSchema` above. */
    terminationOrigin: liveMatchTerminationOriginSchema,
    /**
     * Reused wholesale from `@tcg/rules-engine`: outcome, reason, `finalTurn`,
     * `finalSequence`. `null` exactly when `terminationOrigin` is
     * `'abandoned_unrecordable'` — a match the engine never reached a
     * `MatchResult` for at all, not merely one this package chooses not to
     * report.
     */
    outcome: matchResultSchema.nullable(),
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
      const expectedHash = deckFingerprint({
        commanderId: seat.deck.commanderId,
        cards: seat.deck.cards,
      });
      if (seat.deck.deckHash !== expectedHash) {
        ctx.addIssue({
          code: 'custom',
          path: ['seats', index, 'deck', 'deckHash'],
          message: "This deck snapshot's hash does not match its own contents.",
        });
      }
    }

    const seatPlayerIds = new Set([seatA.playerId, seatB.playerId]);
    const { outcome, terminationOrigin } = envelope;

    if (outcome === null) {
      if (terminationOrigin !== 'abandoned_unrecordable') {
        ctx.addIssue({
          code: 'custom',
          path: ['terminationOrigin'],
          message:
            'A null outcome means the engine never reached a result, so terminationOrigin must be "abandoned_unrecordable".',
        });
      }
    } else {
      if (terminationOrigin === 'abandoned_unrecordable') {
        ctx.addIssue({
          code: 'custom',
          path: ['terminationOrigin'],
          message: '"abandoned_unrecordable" names a match with no outcome; this envelope has one.',
        });
      } else if (
        !liveMatchTerminationOriginsForReason(outcome.reason).includes(terminationOrigin)
      ) {
        ctx.addIssue({
          code: 'custom',
          path: ['terminationOrigin'],
          message: `terminationOrigin "${terminationOrigin}" is not consistent with outcome.reason "${outcome.reason}".`,
        });
      }

      if (outcome.winnerId !== null && !seatPlayerIds.has(outcome.winnerId)) {
        ctx.addIssue({
          code: 'custom',
          path: ['outcome', 'winnerId'],
          message: "The outcome names a winner who is not one of this match's two seats.",
        });
      }
      for (const [index, loserId] of outcome.loserIds.entries()) {
        if (!seatPlayerIds.has(loserId)) {
          ctx.addIssue({
            code: 'custom',
            path: ['outcome', 'loserIds', index],
            message: "The outcome names a loser who is not one of this match's two seats.",
          });
        }
      }
      if (outcome.outcome === 'win') {
        if (
          outcome.winnerId === null ||
          outcome.loserIds.length !== 1 ||
          outcome.loserIds[0] === outcome.winnerId
        ) {
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
