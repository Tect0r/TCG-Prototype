import { z } from 'zod';
import { cardIdSchema } from '@tcg/card-data';
import { botFailureSchema } from '@tcg/bot-interface';
import { seedBundleSchema } from '../seed.js';

/**
 * What one simulated match records (CLAUDE.md §13.6).
 *
 * Raw observations are the primary output. Every derived number in a report has
 * to be recomputable from these records alone, which is why the counters here
 * are deliberately unaggregated and why nothing in this schema is a score, a
 * flag or an opinion.
 *
 * Nothing here is wall-clock derived. Two runs of the same match must produce
 * byte-identical records, so elapsed time lives in the batch manifest instead
 * (CLAUDE.md §13.15 item 4).
 */

export const TELEMETRY_SCHEMA_VERSION = 1;

export const TERMINATION_KINDS = [
  'victory',
  'draw',
  'engine_error',
  'pilot_error',
  'illegal_bot_action',
  'turn_limit',
  'action_limit',
  'no_progress',
] as const;
export const terminationKindSchema = z.enum(TERMINATION_KINDS);
export type TerminationKind = z.infer<typeof terminationKindSchema>;

/** Abnormal terminations always keep a replay and never enter ordinary stats. */
export const ABNORMAL_TERMINATIONS: readonly TerminationKind[] = [
  'engine_error',
  'pilot_error',
  'illegal_bot_action',
  'turn_limit',
  'action_limit',
  'no_progress',
];

export function isAbnormal(kind: TerminationKind): boolean {
  return ABNORMAL_TERMINATIONS.includes(kind);
}

/**
 * Why a copy of a card never got played. Explicit components rather than one
 * vague "dead card" number (CLAUDE.md §13.6).
 */
export const DEAD_HAND_CATEGORIES = [
  /** Stayed in the deck. Never in hand, so never dead *in hand*. */
  'unseen',
  /** Reached hand, but the seat never had enough energy for it after a draw. */
  'never_affordable',
  /** Affordable at some point, but requirements, targets or slots never lined up. */
  'no_legal_window',
  /** The engine offered it at least once and the pilot chose something else. */
  'legal_but_unchosen',
  /** Not dead: it was played, activated, or spent as a cost. */
  'used',
] as const;
export const deadHandCategorySchema = z.enum(DEAD_HAND_CATEGORIES);
export type DeadHandCategory = z.infer<typeof deadHandCategorySchema>;

/** Compact board features either side of a card being played, for swing measures. */
export const playSnapshotSchema = z.strictObject({
  turn: z.number().int().min(0),
  energyBefore: z.number().int().min(0),
  energySpent: z.number().int().min(0),
  handSizeBefore: z.number().int().min(0),
  ownUnitsBefore: z.number().int().min(0),
  ownUnitsAfter: z.number().int().min(0),
  ownStatsBefore: z.number().int(),
  ownStatsAfter: z.number().int(),
  opponentStatsBefore: z.number().int(),
  opponentStatsAfter: z.number().int(),
  ownHealthBefore: z.number().int(),
  lowestOpponentHealthBefore: z.number().int(),
  lowestOpponentHealthAfter: z.number().int(),
});
export type PlaySnapshot = z.infer<typeof playSnapshotSchema>;

/**
 * Everything one seat's copies of one card definition did in one match.
 *
 * Keyed by permanent definition ID: instance IDs are match-local and are only
 * used to trace causality while the match runs (CLAUDE.md §13.6).
 */
export const cardTelemetrySchema = z.strictObject({
  playerId: z.string(),
  definitionId: cardIdSchema,
  /** 0 for tokens and for cards that only ever existed as a created copy. */
  copiesInDeck: z.number().int().min(0),

  copiesInOpeningHand: z.number().int().min(0),
  copiesMulliganedAway: z.number().int().min(0),

  timesDrawn: z.number().int().min(0),
  firstSeenTurn: z.number().int().min(0).nullable(),
  /** Summed over every copy: turns spent sitting in hand. */
  turnsHeldInHand: z.number().int().min(0),
  /** Summed over every copy: turns spent on the battlefield. */
  turnsOnBattlefield: z.number().int().min(0),

  /** Decisions at which the engine listed a copy as playable. */
  playOpportunities: z.number().int().min(0),
  /** Decisions at which a copy was in hand and affordable. */
  affordableOpportunities: z.number().int().min(0),

  timesPlayed: z.number().int().min(0),
  timesActivated: z.number().int().min(0),
  timesDiscarded: z.number().int().min(0),
  timesSacrificed: z.number().int().min(0),
  timesDefeated: z.number().int().min(0),
  timesRemoved: z.number().int().min(0),
  timesReturnedToHand: z.number().int().min(0),

  energySpent: z.number().int().min(0),
  attacksMade: z.number().int().min(0),
  blocksMade: z.number().int().min(0),

  /* --------- attributed through event provenance (cause.sourceInstanceId) --- */
  damageToPlayers: z.number().int().min(0),
  damageToUnits: z.number().int().min(0),
  healingDone: z.number().int().min(0),
  cardsDrawnBy: z.number().int().min(0),
  cardsDiscardedBy: z.number().int().min(0),
  tokensCreated: z.number().int().min(0),
  unitsRemoved: z.number().int().min(0),
  triggersFired: z.number().int().min(0),

  /* ------------------------------------------------ where copies ended up --- */
  endedInHand: z.number().int().min(0),
  endedOnBattlefield: z.number().int().min(0),
  endedInDeck: z.number().int().min(0),
  endedInDiscard: z.number().int().min(0),

  /** One count per category; the four dead categories plus `used`. */
  deadHand: z.record(deadHandCategorySchema, z.number().int().min(0)),

  /** Capped sample of before/after snapshots, so swings stay inspectable. */
  plays: z.array(playSnapshotSchema),
});
export type CardTelemetry = z.infer<typeof cardTelemetrySchema>;

export const seatTelemetrySchema = z.strictObject({
  playerId: z.string(),
  seatIndex: z.number().int().min(0),
  deckId: z.string(),
  deckHash: z.string(),
  commanderId: cardIdSchema,
  colors: z.array(z.string()),
  pilotId: z.string(),
  pilotVersion: z.string(),
  /** Hash of the pilot's serialized configuration, including its weights. */
  pilotConfigHash: z.string(),
  pilotSeed: z.string(),

  won: z.boolean(),
  lost: z.boolean(),
  lossReason: z.string().nullable(),
  eliminatedOnTurn: z.number().int().min(0).nullable(),

  startingHealth: z.number().int(),
  endingHealth: z.number().int(),
  damageDealtToPlayers: z.number().int().min(0),
  damageTaken: z.number().int().min(0),
  healingReceived: z.number().int().min(0),

  cardsDrawn: z.number().int().min(0),
  cardsPlayed: z.number().int().min(0),
  cardsDiscarded: z.number().int().min(0),
  energySpent: z.number().int().min(0),
  energyUnspentAtTurnEnd: z.number().int().min(0),
  unitsDeployed: z.number().int().min(0),
  relicsDeployed: z.number().int().min(0),
  tokensCreated: z.number().int().min(0),
  unitsLost: z.number().int().min(0),
  attacksDeclared: z.number().int().min(0),
  blocksAssigned: z.number().int().min(0),
  abilitiesActivated: z.number().int().min(0),
  choicesResolved: z.number().int().min(0),
  decisions: z.number().int().min(0),
});
export type SeatTelemetry = z.infer<typeof seatTelemetrySchema>;

export const matchRecordSchema = z.strictObject({
  schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
  /** Content-derived and stable: the same match always has the same ID. */
  matchId: z.string(),
  /** Lexicographic sort key giving a deterministic aggregation order. */
  orderKey: z.string(),

  experimentId: z.string(),
  environmentId: z.string(),
  environmentHash: z.string(),
  cardPoolHash: z.string(),
  deckPairId: z.string(),
  /** Identity of the pilot tuple: what varied besides the decks. */
  variantKey: z.string(),
  gameIndex: z.number().int().min(0),
  /** Which mirrored orientation this game used, for seat-bias analysis. */
  orientation: z.number().int().min(0),

  rulesVersion: z.string(),
  seeds: seedBundleSchema,
  softwareCommit: z.string().nullable(),

  playerCount: z.number().int().min(2).max(4),
  seats: z.array(seatTelemetrySchema),
  startingPlayerId: z.string(),

  termination: terminationKindSchema,
  outcome: z.enum(['win', 'draw', 'none']),
  winnerId: z.string().nullable(),
  endReason: z.string().nullable(),

  turns: z.number().int().min(0),
  actions: z.number().int().min(0),
  decisions: z.number().int().min(0),
  events: z.number().int().min(0),
  resolutionSteps: z.number().int().min(0),

  cards: z.array(cardTelemetrySchema),
  botFailures: z.array(botFailureSchema),
  /** Structured notes: safeguard trips, engine faults, fallbacks. */
  diagnostics: z.array(z.string()),
  /** Set when a replay bundle was written for this match. */
  replayPath: z.string().nullable(),
});
export type MatchRecord = z.infer<typeof matchRecordSchema>;

/**
 * A replay bundle: everything needed to re-derive the match exactly.
 *
 * Written for every abnormal match and for a configurable sample of normal ones
 * (CLAUDE.md §13.5).
 */
export const replayBundleSchema = z.strictObject({
  schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
  matchId: z.string(),
  record: matchRecordSchema,
  environment: z.unknown(),
  decks: z.array(z.unknown()),
  pilots: z.array(z.unknown()),
  actions: z.array(z.unknown()),
  events: z.array(z.unknown()),
  /** Per-decision pilot diagnostics, when the run kept them. */
  decisions: z.array(z.unknown()),
});
export type ReplayBundle = z.infer<typeof replayBundleSchema>;
