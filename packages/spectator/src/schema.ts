import { z } from 'zod';
import { cardIdSchema } from '@tcg/card-data';
import { pilotIdSchema } from '@tcg/bot-interface';
import { boardSeatTelemetrySchema, boardTelemetrySchema } from '@tcg/board-telemetry';
import {
  actionSchema,
  gameEventSchema,
  matchResultSchema,
  MATCH_SCHEMA_VERSION,
  MAX_PLAYERS,
  MIN_PLAYERS,
  playerIdSchema,
} from '@tcg/rules-engine';

/**
 * The AI-spectator replay format.
 *
 * One versioned document that is enough to (a) play the match back at a
 * readable pace and (b) prove the playback was honest — the same seed, decks,
 * rules version and card-data version reproduce it exactly.
 *
 * It is deliberately a *different* artefact from the simulator's replay bundle,
 * which carries a frozen copy of the whole environment so a six-month-old
 * balance run can be re-derived after cards have been rewritten. That guarantee
 * costs megabytes, and a spectator replay is something a browser holds in
 * memory and a user downloads. This format records the version identifiers
 * instead and **fails loudly** when they no longer match, which is the property
 * the spectator actually needs: an incompatible replay must not silently
 * diverge.
 */

/**
 * Bumped to 2 for M01.2: every replay now states whether its result is valid.
 * A version 1 replay is refused rather than assumed valid — it was recorded
 * before incomplete cards were refused, so its cards may have executed as
 * something other than what they are printed to do.
 *
 * Bumped to 3 for M04.1: the telemetry block is now `@tcg/board-telemetry`'s
 * shared document, which spectator and simulator matches both produce. A version
 * 2 replay is **refused, not migrated**, and the refusal is the honest answer
 * rather than a convenient one. Its telemetry block is missing whole measures
 * (combat resolution cost, per-seat peak-board reduction, the per-round attacker
 * series) and re-deriving them from the log it carries would produce numbers the
 * build that recorded it never asserted, presented under that build's identity.
 * A replay is a claim about what a specific engine did; the version check exists
 * so an incompatible one fails loudly instead of quietly answering differently.
 */
export const SPECTATOR_REPLAY_VERSION = 3;

/**
 * Whether a recorded match is evidence about the game at all.
 *
 * `resultsValid: false` is the developer override (`SpectatorSetup`
 * `developerAllowIncompleteCards`): the match ran with cards whose printed
 * behaviour is not structured yet, so what happened is not what the cards say.
 * It travels with the replay and with the telemetry derived from it, because
 * telemetry is what gets aggregated later, long after the setup screen that
 * produced it is gone.
 */
export const spectatorProvenanceSchema = z.strictObject({
  resultsValid: z.boolean(),
  /** Every card that was not playable, per seat. Empty when results are valid. */
  incompleteCards: z.array(
    z.strictObject({
      playerId: playerIdSchema,
      preconId: z.string().min(1).nullable(),
      cardIds: z.array(cardIdSchema).min(1),
    }),
  ),
});
export type SpectatorProvenance = z.infer<typeof spectatorProvenanceSchema>;

/** A match played entirely on implemented cards. */
export const VALID_PROVENANCE: SpectatorProvenance = Object.freeze({
  resultsValid: true,
  incompleteCards: [],
});

export const spectatorSeatSchema = z.strictObject({
  playerId: playerIdSchema,
  /** Display name, e.g. "Bot 1 — Goblin Swarm". Presentation only. */
  name: z.string().min(1).max(60),
  seatIndex: z.number().int().min(0),
  /** The precon this seat was dealt, when it came from one. */
  preconId: z.string().min(1).nullable(),
  commanderId: cardIdSchema,
  cardIds: z.array(cardIdSchema),
  pilotId: pilotIdSchema,
  pilotVersion: z.string(),
  pilotSeed: z.string(),
});
export type SpectatorSeat = z.infer<typeof spectatorSeatSchema>;

/**
 * Board telemetry as a watched match records it (M04.1).
 *
 * The measurements themselves are `@tcg/board-telemetry`'s and are not restated
 * here: one definition, one schema, and a spectator match and a simulator match
 * that cannot disagree about what `peakUnits` means. What this layer adds is the
 * two things that are true of a *watched* match and of nothing else — a
 * leaderboard, and whether the match is evidence about the game at all.
 */
export const spectatorSeatTelemetrySchema = boardSeatTelemetrySchema.extend({
  /** Final placement: 1 is the winner. Eliminated seats rank by exit order. */
  placement: z.number().int().min(1),
});
export type SpectatorSeatTelemetry = z.infer<typeof spectatorSeatTelemetrySchema>;

export const spectatorTelemetrySchema = boardTelemetrySchema.extend({
  seats: z.array(spectatorSeatTelemetrySchema),
  /**
   * False when the match was run under the developer override (M01.2). Repeated
   * here rather than only on the replay so a telemetry row that has been lifted
   * out of its replay still says it must not be counted.
   */
  resultsValid: z.boolean(),
  /**
   * Whether `longestStallRounds` reached the summary screen's threshold.
   *
   * A presentation flag over the shared raw streak, and the *only* derived
   * verdict anywhere in this document. It stays on the spectator side because it
   * is not evidence: the eligibility rule and threshold that would make it one
   * are Q43, and M04.2 replaces it with raw attack-opportunity evidence. Nothing
   * downstream may act on it, and the Unit cap does not come back because it is
   * true.
   */
  boardStalled: z.boolean(),
});
export type SpectatorTelemetry = z.infer<typeof spectatorTelemetrySchema>;

/** One recorded bot decision, kept for Analysis Mode. */
export const spectatorDecisionSchema = z.strictObject({
  index: z.number().int().min(0),
  playerId: playerIdSchema,
  turn: z.number().int().min(0),
  phase: z.string(),
  /** Sequence number of the last event this decision produced. */
  sequenceAfter: z.number().int().min(0),
  /** Stable key of the chosen candidate, and how many were weighed. */
  chosenKey: z.string().nullable(),
  candidateCount: z.number().int().min(0),
  /** Every candidate and its score, in evaluation order. */
  scores: z.array(z.strictObject({ key: z.string(), score: z.number() })),
  notes: z.array(z.string()),
  /** The pilot failed and the deterministic fallback answered instead. */
  usedFallback: z.boolean(),
});
export type SpectatorDecision = z.infer<typeof spectatorDecisionSchema>;

export const spectatorReplaySchema = z.strictObject({
  schemaVersion: z.literal(SPECTATOR_REPLAY_VERSION),
  /**
   * Version identifiers. A replay whose versions do not match the running build
   * is refused rather than played back approximately.
   */
  matchSchemaVersion: z.literal(MATCH_SCHEMA_VERSION),
  rulesVersion: z.string().min(1),
  /** Digest of the card pool the match was played with. */
  cardDataHash: z.string().min(1),
  /** Whether this match is evidence about the game. See the schema above. */
  provenance: spectatorProvenanceSchema,

  matchId: z.string().min(1),
  seed: z.string().min(1),
  seats: z.array(spectatorSeatSchema).min(MIN_PLAYERS).max(MAX_PLAYERS),
  /** Turn order as the engine settled it: the seat circle rotated to first. */
  playerOrder: z.array(playerIdSchema),
  seatOrder: z.array(playerIdSchema),

  /** Every accepted action, in order. Re-applying these reproduces the match. */
  actions: z.array(actionSchema),
  /** The full authoritative event log. */
  events: z.array(gameEventSchema),
  decisions: z.array(spectatorDecisionSchema),

  result: matchResultSchema.nullable(),
  /** Why the run stopped, when it was not a normal finish. */
  termination: z.enum([
    'victory',
    'draw',
    'turn_limit',
    'action_limit',
    'engine_error',
    'pilot_error',
  ]),
  diagnostics: z.array(z.string()),
  telemetry: spectatorTelemetrySchema,
});
export type SpectatorReplay = z.infer<typeof spectatorReplaySchema>;

/**
 * The format version of something that claims to be a replay, before parsing.
 *
 * A replay from an older build fails `spectatorReplaySchema` on its version
 * literal, which is correct but reads as "this is not a replay" — and it is one,
 * recorded by a build that measured different things. Reading the version out
 * first lets the refusal say which it is, without ever accepting the document.
 * Returns `null` when the value is missing or is not a number, i.e. when the
 * file really is something else.
 */
export function replayFormatVersion(parsed: unknown): number | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const version = (parsed as { schemaVersion?: unknown }).schemaVersion;
  return typeof version === 'number' ? version : null;
}

/** Why a replay cannot be played back on this build. */
export interface ReplayIncompatibility {
  readonly field: string;
  readonly expected: string;
  readonly found: string;
}

/**
 * Checks a replay against the running build.
 *
 * Returns the mismatches rather than throwing, so a UI can say exactly which
 * version moved. An empty array means the replay is safe to play back — and a
 * non-empty one means it must not be, because a replay is a claim about what
 * the engine did, and an engine that has changed would answer differently.
 */
export function checkReplayCompatibility(
  replay: SpectatorReplay,
  build: { readonly rulesVersion: string; readonly cardDataHash: string },
): ReplayIncompatibility[] {
  const problems: ReplayIncompatibility[] = [];
  if (replay.rulesVersion !== build.rulesVersion) {
    problems.push({
      field: 'rulesVersion',
      expected: build.rulesVersion,
      found: replay.rulesVersion,
    });
  }
  if (replay.cardDataHash !== build.cardDataHash) {
    problems.push({
      field: 'cardDataHash',
      expected: build.cardDataHash,
      found: replay.cardDataHash,
    });
  }
  return problems;
}
