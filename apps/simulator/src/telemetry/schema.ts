import { z } from 'zod';
import { cardIdSchema } from '@tcg/card-data';
import { botFailureSchema } from '@tcg/bot-interface';
import { resolvedEnvironmentSchema } from '../resolved-environment.js';
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

/**
 * Version 2 (PHASE4_HARDENING §7, §8.1, §8.2):
 *
 * - Records carry their own stream identity — experiment kind, configuration
 *   hash and arm label — so one `matches.jsonl` can hold every match of a
 *   comparison or a search and still be deduplicated and resumed safely.
 * - Per-copy draw/play counters were added, because `timesPlayed / timesDrawn`
 *   cannot express a bounded conversion rate and was being presented as one.
 * - The dead-hand vocabulary distinguishes missing targets and board capacity
 *   from a generic "no legal window", and separates a card still held at the end
 *   from one that was discarded after being playable.
 *
 * Version 1 records cannot be migrated: the new counters were never observed, so
 * a v1 file is rejected with a clear message rather than read under v2 meanings
 * (PHASE4_HARDENING §13).
 */
export const TELEMETRY_SCHEMA_VERSION = 2;

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
  /** Affordable, but every time it was the board or a zone that was full. */
  'no_capacity',
  /** Affordable, but every time it was a required target that did not exist. */
  'no_legal_target',
  /** Affordable, never legal, and not attributable to capacity or targeting. */
  'no_legal_window',
  /** Was offered at least once, was not used, and had left hand by the end. */
  'legal_but_unchosen',
  /** Was offered at least once and was still sitting in hand when the match ended. */
  'held_at_end',
  /** Not dead: it was played, activated, or spent as a cost. */
  'used',
] as const;
export const deadHandCategorySchema = z.enum(DEAD_HAND_CATEGORIES);
export type DeadHandCategory = z.infer<typeof deadHandCategorySchema>;

/**
 * Categories that mean "the card could not be used" — a fact about the card and
 * the board — as opposed to "the pilot did not use it", which is a fact about
 * the pilot. PHASE4_HARDENING §8.2 forbids collapsing the second into the first.
 */
export const MECHANICALLY_UNUSABLE_CATEGORIES: readonly DeadHandCategory[] = [
  'never_affordable',
  'no_capacity',
  'no_legal_target',
  'no_legal_window',
];

/** Categories that mean the pilot had the option and passed on it. */
export const STRATEGICALLY_UNUSED_CATEGORIES: readonly DeadHandCategory[] = [
  'legal_but_unchosen',
  'held_at_end',
];

/** Every category that counts as dead in hand. Excludes `unseen` and `used`. */
export const DEAD_IN_HAND_CATEGORIES: readonly DeadHandCategory[] = [
  ...MECHANICALLY_UNUSABLE_CATEGORIES,
  ...STRATEGICALLY_UNUSED_CATEGORIES,
];

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
  /**
   * Distinct copies that ever reached hand, whether drawn or dealt in the
   * opening hand.
   *
   * `timesDrawn` counts draw *events*, so a copy bounced and redrawn counts
   * twice; this counts the copy once. The two are the denominators of two
   * different questions, and conflating them is what produced a "play rate" that
   * could exceed 100% (PHASE4_HARDENING §8.1).
   */
  drawnCopies: z.number().int().min(0),
  /** Of `drawnCopies`, how many were played or activated at least once. */
  drawnCopiesPlayed: z.number().int().min(0),
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
  /** Which experiment kind produced this record, for a mixed `matches.jsonl`. */
  experimentKind: z.enum(['batch', 'search', 'comparison', 'replacement', 'robustness']),
  /** Hash of the normalized experiment configuration. Resume rejects a mismatch. */
  configHash: z.string(),
  /**
   * Which arm of the experiment this match belongs to.
   *
   * `baseline` / `candidate` for a comparison, `search:<label>:g<n>` for a search
   * generation, `profile:<id>` for a robustness profile, `null` for a plain
   * batch. Part of the deduplication identity, so two arms can share one stream
   * without colliding (PHASE4_HARDENING §7).
   */
  arm: z.string().nullable(),
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
 * The identity a record is deduplicated by when resuming (PHASE4_HARDENING §7).
 *
 * `matchId` is already content-derived and unique within an arm; the arm is
 * included so a comparison's baseline and candidate halves, or two search
 * generations, can share one stream without either overwriting the other.
 */
export function recordIdentity(record: Pick<MatchRecord, 'matchId' | 'arm'>): string {
  return `${record.arm ?? ''}§${record.matchId}`;
}

/**
 * A replay bundle: everything needed to re-derive the match exactly.
 *
 * Written for every abnormal match and for a configurable sample of normal ones
 * (CLAUDE.md §13.5).
 *
 * `environment` is the *frozen* environment, not the config that produced it
 * (readiness §9 G1). A bundle carrying the recipe would re-resolve against
 * whatever card data the checkout holds at replay time, which means an old
 * artefact quietly reproduces a different match while still displaying its
 * original hash. Embedding the resolved definitions is what makes "this bundle
 * reproduces on its own" a true statement rather than a hopeful one.
 */
export const replayBundleSchema = z.strictObject({
  schemaVersion: z.literal(TELEMETRY_SCHEMA_VERSION),
  matchId: z.string(),
  record: matchRecordSchema,
  environment: resolvedEnvironmentSchema,
  decks: z.array(z.unknown()),
  pilots: z.array(z.unknown()),
  actions: z.array(z.unknown()),
  events: z.array(z.unknown()),
  /** Per-decision pilot diagnostics, when the run kept them. */
  decisions: z.array(z.unknown()),
});
export type ReplayBundle = z.infer<typeof replayBundleSchema>;
