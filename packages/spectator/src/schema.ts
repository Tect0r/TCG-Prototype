import { z } from 'zod';
import { cardIdSchema } from '@tcg/card-data';
import { pilotIdSchema } from '@tcg/bot-interface';
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

export const SPECTATOR_REPLAY_VERSION = 1;

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
 * Board-size and Commander telemetry (rule adjustment, "Match telemetry").
 *
 * Recorded per seat and derived entirely from the authoritative event stream,
 * so it cannot disagree with the replay it accompanies. Playback timing is
 * deliberately absent: a delay a user chose must never reach a number that
 * describes the match.
 */
export const spectatorSeatTelemetrySchema = z.strictObject({
  playerId: playerIdSchema,
  /** Unit count at the end of each round, index 0 being round 1. */
  unitsByRound: z.array(z.number().int().min(0)),
  peakUnits: z.number().int().min(0),
  peakNonTokenUnits: z.number().int().min(0),
  peakTokens: z.number().int().min(0),
  /**
   * The largest group of identical Tokens this seat ever controlled — what a
   * client would render as one visual stack.
   *
   * Measured from definition identity rather than from anything the UI does,
   * because the number has to mean the same thing whether or not grouping is
   * switched on.
   */
  peakTokenStack: z.number().int().min(0),
  peakTokensByDefinition: z.record(cardIdSchema, z.number().int().min(0)),
  commanderDefeats: z.number().int().min(0),
  maxCommanderDeploymentCost: z.number().int().min(0),
  reactionsPlayed: z.number().int().min(0),
  /** Final placement: 1 is the winner. Eliminated seats rank by exit order. */
  placement: z.number().int().min(1),
});
export type SpectatorSeatTelemetry = z.infer<typeof spectatorSeatTelemetrySchema>;

export const spectatorTelemetrySchema = z.strictObject({
  seats: z.array(spectatorSeatTelemetrySchema),
  turns: z.number().int().min(0),
  /** Complete cycles of the seat order, for the per-round unit counts. */
  rounds: z.number().int().min(0),
  actions: z.number().int().min(0),
  events: z.number().int().min(0),
  /** Turn number with the most accepted actions, and how many. */
  longestTurn: z.strictObject({
    turn: z.number().int().min(0),
    actions: z.number().int().min(0),
  }),
  /** The combat with the most declared attackers, and what happened in it. */
  largestCombat: z.strictObject({
    turn: z.number().int().min(0),
    attackers: z.number().int().min(0),
    blockers: z.number().int().min(0),
  }),
  /** The turn with the most triggers and pending choices, and how many. */
  busiestTurn: z.strictObject({
    turn: z.number().int().min(0),
    triggers: z.number().int().min(0),
    choices: z.number().int().min(0),
  }),
  reactionWindows: z.number().int().min(0),
  reactionsPlayed: z.number().int().min(0),
  cardsCountered: z.number().int().min(0),
  /**
   * Consecutive rounds in which nobody declared an attacker.
   *
   * The board-stall signal §17 asks for. Reported rather than acted on: a wide
   * board is not automatically a failure, and the unit cap does not come back
   * because this number is large.
   */
  longestStallRounds: z.number().int().min(0),
  boardStalled: z.boolean(),
  /**
   * How the largest board a seat ever held was reduced, if it was — the number
   * of units it lost afterwards, and to what.
   */
  largestBoardAnswer: z
    .strictObject({
      playerId: playerIdSchema,
      peakUnits: z.number().int().min(0),
      unitsLostAfterPeak: z.number().int().min(0),
      /** Defeat reasons, most common first. */
      reasons: z.array(z.string()),
    })
    .nullable(),
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
