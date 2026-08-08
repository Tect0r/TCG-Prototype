import { z } from 'zod';
import {
  cardFilterSchema,
  cardIdSchema,
  durationSchema,
  effectDefinitionSchema,
  keywordIdSchema,
  zoneIdSchema,
} from '@tcg/card-data';
import { rngStateSchema } from '../rng.js';
import {
  MATCH_SCHEMA_VERSION,
  MAX_PLAYERS,
  MIN_PLAYERS,
  instanceIdSchema,
  lossReasonSchema,
  matchModeSchema,
  matchPhaseSchema,
  matchStatusSchema,
  playerIdSchema,
} from './primitives.js';
import { pendingChoiceSchema } from './choice.js';
import { gameEventSchema } from './event.js';
import { loggedActionSchema } from './action.js';

/**
 * A temporary or permanent change to a unit's printed statline. Modifiers are
 * stored rather than folded into the base stats so an `end_of_turn` bonus can be
 * removed exactly, and so removing a Health bonus can defeat an already-damaged
 * unit during the following state-based check (CLAUDE.md §4).
 */
export const statModifierSchema = z.strictObject({
  attack: z.number().int(),
  health: z.number().int(),
  duration: durationSchema,
  sourceInstanceId: instanceIdSchema.nullable(),
  /** Turn number the modifier was applied on, for expiry bookkeeping. */
  appliedOnTurn: z.number().int().min(0),
});
export type StatModifier = z.infer<typeof statModifierSchema>;

export const keywordModifierSchema = z.strictObject({
  keyword: keywordIdSchema,
  duration: durationSchema,
  sourceInstanceId: instanceIdSchema.nullable(),
  appliedOnTurn: z.number().int().min(0),
});
export type KeywordModifier = z.infer<typeof keywordModifierSchema>;

/** Remaining damage prevention sitting on a unit or player. */
export const damageShieldSchema = z.strictObject({
  amount: z.number().int().min(0),
  duration: durationSchema,
  appliedOnTurn: z.number().int().min(0),
});
export type DamageShield = z.infer<typeof damageShieldSchema>;

/**
 * The continuous-effect contribution reaching one instance right now, derived
 * from every active `staticAbility` on the board.
 */
export const continuousLayerSchema = z.strictObject({
  attack: z.number().int(),
  health: z.number().int(),
  grantedKeywords: z.array(keywordIdSchema),
  removedKeywords: z.array(keywordIdSchema),
});
export type ContinuousLayer = z.infer<typeof continuousLayerSchema>;

export const EMPTY_CONTINUOUS: ContinuousLayer = Object.freeze({
  attack: 0,
  health: 0,
  grantedKeywords: [],
  removedKeywords: [],
});

export const cardInstanceSchema = z.strictObject({
  instanceId: instanceIdSchema,
  /** Permanent card identity. Never changes. */
  definitionId: cardIdSchema,
  /**
   * Creation order within the match. Used as a deterministic tiebreak when
   * several triggers fire at once (CLAUDE.md §4).
   */
  ordinal: z.number().int().min(0),
  owner: playerIdSchema,
  controller: playerIdSchema,
  zone: zoneIdSchema,
  /** Battlefield unit slot index, or `null` in every other zone. */
  slot: z.number().int().min(0).nullable(),
  markedDamage: z.number().int().min(0),
  exhausted: z.boolean(),
  /** Turn the instance entered its current zone: drives summoning sickness. */
  enteredZoneOnTurn: z.number().int().min(0),
  statModifiers: z.array(statModifierSchema),
  grantedKeywords: z.array(keywordModifierSchema),
  removedKeywords: z.array(keywordModifierSchema),
  damageShields: z.array(damageShieldSchema),
  counters: z.record(z.string(), z.number().int()),
  /** Tokens cease to exist when they leave the battlefield. */
  isToken: z.boolean(),
  /**
   * Derived, never authored. The whole object is *replaced* whenever the board
   * changes; nothing here is ever accumulated, which is what makes a lord's
   * bonus reach units that arrive later and vanish the moment the lord leaves
   * (CLAUDE.md §17 Q2). Stored rather than recomputed per read so it survives
   * serialisation and so `currentAttack` stays a pure two-argument function.
   */
  continuous: continuousLayerSchema,
});
export type CardInstance = z.infer<typeof cardInstanceSchema>;

export const MULLIGAN_STATUSES = ['pending', 'submitted', 'resolved'] as const;
export const mulliganStatusSchema = z.enum(MULLIGAN_STATUSES);

/**
 * Opening-hand redraw. Both players submit before either result is revealed, so
 * `submitted` is a distinct state from `resolved` (CLAUDE.md §4).
 */
export const mulliganStateSchema = z.strictObject({
  status: mulliganStatusSchema,
  returnedInstanceIds: z.array(instanceIdSchema),
  redrawsUsed: z.number().int().min(0),
});
export type MulliganState = z.infer<typeof mulliganStateSchema>;

/** A pending energy-cost adjustment, e.g. "your units cost 1 less this turn". */
export const costModifierSchema = z.strictObject({
  delta: z.number().int(),
  filter: cardFilterSchema.nullable(),
  duration: durationSchema,
  appliedOnTurn: z.number().int().min(0),
  sourceInstanceId: instanceIdSchema.nullable(),
});
export type CostModifier = z.infer<typeof costModifierSchema>;

export const playerStateSchema = z.strictObject({
  playerId: playerIdSchema,
  /** Temporary display name. Presentation only; never used for identity. */
  name: z.string().min(1).max(40),
  health: z.number().int(),
  energy: z.number().int().min(0),
  maxEnergy: z.number().int().min(0),

  /** Ordered, index 0 is the top of the deck. */
  deck: z.array(instanceIdSchema),
  hand: z.array(instanceIdSchema),
  discard: z.array(instanceIdSchema),
  /** Terminal. Cards land here on elimination and never leave (CLAUDE.md §12). */
  removed: z.array(instanceIdSchema),
  /** Fixed-length battlefield slots; `null` is an empty slot. */
  units: z.array(instanceIdSchema.nullable()),
  /** Relics occupy their own zone and never consume unit slots. */
  relics: z.array(instanceIdSchema),
  commanderInstanceId: instanceIdSchema,

  mulligan: mulliganStateSchema,
  costModifiers: z.array(costModifierSchema),
  damageShields: z.array(damageShieldSchema),

  /** Set for the starting player so they skip their first normal draw. */
  skipNextDraw: z.boolean(),
  lost: z.boolean(),
  lossReason: lossReasonSchema.nullable(),
  /**
   * Turn the elimination cleanup ran on, or `null` while the player is alive.
   * Distinct from `lost`: a player is marked lost the instant they hit zero, but
   * their board is cleared once, later, by the next state-based check
   * (CLAUDE.md §12 step 8).
   */
  eliminatedOnTurn: z.number().int().min(0).nullable(),
});
export type PlayerState = z.infer<typeof playerStateSchema>;

export const RESOLUTION_KINDS = ['card_effects', 'triggered_ability'] as const;
export const resolutionKindSchema = z.enum(RESOLUTION_KINDS);

/**
 * One item in the deterministic FIFO resolution queue. There is no stack and no
 * priority: instructions belonging to one effect resolve in authored array
 * order, and newly created triggers are appended, never interleaved
 * (CLAUDE.md §4).
 */
export const resolutionItemSchema = z.strictObject({
  id: z.string().min(1),
  kind: resolutionKindSchema,
  /** The instance whose ability or card text this is. `null` for engine effects. */
  sourceInstanceId: instanceIdSchema.nullable(),
  sourceDefinitionId: cardIdSchema.nullable(),
  /** Player who makes the decisions this item requires. */
  controllerId: playerIdSchema,
  abilityId: z.string().nullable(),
  effects: z.array(effectDefinitionSchema),
  /** Index of the next instruction to execute. */
  effectIndex: z.number().int().min(0),
  /**
   * Choices already made for this item, keyed by effect index. Present so a
   * paused item resumes exactly where it stopped after a JSON round trip.
   */
  selections: z.record(z.string(), z.array(z.string())),
  /** Sequence number of the event that created this item, for causal logs. */
  causeSequence: z.number().int().min(0).nullable(),
  /**
   * A spell moves to discard only once its instructions have all resolved, so
   * it is not a legal target of its own effects while resolving.
   */
  completesSpell: z.boolean(),
});
export type ResolutionItem = z.infer<typeof resolutionItemSchema>;

export const blockAssignmentSchema = z.strictObject({
  attackerInstanceId: instanceIdSchema,
  blockerInstanceId: instanceIdSchema,
});
export type BlockAssignment = z.infer<typeof blockAssignmentSchema>;

/**
 * One declared attack. Each attacking unit independently names one living
 * opponent, so a player may split attackers across several opponents in the
 * same combat (CLAUDE.md §12).
 */
export const attackDeclarationSchema = z.strictObject({
  attackerInstanceId: instanceIdSchema,
  defenderPlayerId: playerIdSchema,
});
export type AttackDeclaration = z.infer<typeof attackDeclarationSchema>;

/**
 * One defender's blocker assignment, held privately until every attacked
 * player has answered.
 *
 * Submissions are collected independently and are hidden from the attacker and
 * from the other defenders until all of them are in, so nobody can react to a
 * block that has already been committed (CLAUDE.md §12).
 */
export const blockerSubmissionSchema = z.strictObject({
  defenderPlayerId: playerIdSchema,
  blocks: z.array(blockAssignmentSchema),
});
export type BlockerSubmission = z.infer<typeof blockerSubmissionSchema>;

/**
 * Combat is modelled as (attacker, defender) declarations plus (attacker,
 * blocker) pairs rather than one blocker field per attacker, so raising
 * `blockersPerAttacker` above 1 later is a config change, not a rewrite.
 */
export const combatStateSchema = z.strictObject({
  attacks: z.array(attackDeclarationSchema),
  /**
   * Defenders still owed a submission. Emptied as they answer; combat damage
   * waits for the list to drain.
   */
  awaitingDefenders: z.array(playerIdSchema),
  /** Private per-defender submissions, merged into `blocks` on the last one. */
  submissions: z.array(blockerSubmissionSchema),
  /** Public, and only populated once every defender has answered. */
  blocks: z.array(blockAssignmentSchema),
  /** Instances that were attackers or blockers when damage resolved. */
  combatantInstanceIds: z.array(instanceIdSchema),
  damageResolved: z.boolean(),
});
export type CombatState = z.infer<typeof combatStateSchema>;

export const EMPTY_COMBAT: CombatState = Object.freeze({
  attacks: [],
  awaitingDefenders: [],
  submissions: [],
  blocks: [],
  combatantInstanceIds: [],
  damageResolved: false,
});

export const MATCH_END_REASONS = [
  'health_depleted',
  'empty_deck',
  'concede',
  'timeout',
  'simultaneous_loss',
  'engine_error',
] as const;
export const matchEndReasonSchema = z.enum(MATCH_END_REASONS);
export type MatchEndReason = z.infer<typeof matchEndReasonSchema>;

export const matchResultSchema = z.strictObject({
  /** The last living player wins; everyone dying at once is a draw. */
  outcome: z.enum(['win', 'draw']),
  winnerId: playerIdSchema.nullable(),
  loserIds: z.array(playerIdSchema),
  reason: matchEndReasonSchema,
  finalTurn: z.number().int().min(0),
  finalSequence: z.number().int().min(0),
  /** Populated only when `reason` is `engine_error`. */
  diagnostics: z.string().nullable(),
});
export type MatchResult = z.infer<typeof matchResultSchema>;

export const matchStateSchema = z.strictObject({
  schemaVersion: z.literal(MATCH_SCHEMA_VERSION),
  /** The `RulesConfig.version` this match was created under. */
  rulesVersion: z.string().min(1),
  matchId: z.string().min(1).max(64),
  mode: matchModeSchema,

  seed: z.string().min(1).max(128),
  rng: rngStateSchema,

  status: matchStatusSchema,
  /**
   * The stable circular seat order established at match creation and never
   * reordered — not even when a player is eliminated (CLAUDE.md §12). "Clockwise
   * from X" means walking this array.
   */
  seatOrder: z.array(playerIdSchema).min(MIN_PLAYERS).max(MAX_PLAYERS),
  /**
   * Turn order: `seatOrder` rotated so the starting player is first. A rotation
   * of a circle is the same circle, so this preserves seat adjacency while
   * keeping "index 0 acts first" true.
   */
  playerOrder: z.array(playerIdSchema).min(MIN_PLAYERS).max(MAX_PLAYERS),
  players: z.record(playerIdSchema, playerStateSchema),
  instances: z.record(instanceIdSchema, cardInstanceSchema),
  nextInstanceOrdinal: z.number().int().min(0),

  turn: z.number().int().min(0),
  activePlayerId: playerIdSchema,
  phase: matchPhaseSchema,

  queue: z.array(resolutionItemSchema),
  nextResolutionOrdinal: z.number().int().min(0),
  pendingChoice: pendingChoiceSchema.nullable(),
  nextChoiceOrdinal: z.number().int().min(0),

  combat: combatStateSchema,
  result: matchResultSchema.nullable(),

  /** Sequence number of the most recently emitted event. */
  sequence: z.number().int().min(0),
  /** Full authoritative event log; the basis for replay and redacted views. */
  log: z.array(gameEventSchema),
  /** Every accepted action, in order, so a match can be re-derived from the seed. */
  actionLog: z.array(loggedActionSchema),

  /** Safeguard counters (CLAUDE.md §4: loops must terminate, not hang). */
  resolutionSteps: z.number().int().min(0),
  stepsSinceInput: z.number().int().min(0),
  recentFingerprints: z.array(z.string()),
});
export type MatchState = z.infer<typeof matchStateSchema>;

export { MATCH_SCHEMA_VERSION };
