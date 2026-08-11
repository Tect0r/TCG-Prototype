import { z } from 'zod';
import {
  cardFilterSchema,
  cardIdSchema,
  durationSchema,
  effectDefinitionSchema,
  keywordIdSchema,
  reactionWindowSchema,
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
  /**
   * The instance whose effect granted it, or `null` for an engine-created
   * shield.
   *
   * Carried for the same reason the stat, keyword and cost modifiers carry it:
   * a `while_source_present` shield has to end when its source leaves play, and
   * without this the shield would have no way to know what it was waiting on.
   */
  sourceInstanceId: instanceIdSchema.nullable(),
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
  markedDamage: z.number().int().min(0),
  exhausted: z.boolean(),
  /** Turn the instance entered its current zone. */
  enteredZoneOnTurn: z.number().int().min(0),
  /**
   * `Newly Deployed`: set when the instance arrives on the battlefield, cleared
   * at its controller's next Ready Step.
   *
   * Deliberately a stored flag rather than `enteredZoneOnTurn === turn`. Under
   * ADR 0016 Q-B the state survives opponents' turns and ends at the
   * controller's own Ready Step, which a comparison against the current turn
   * number cannot express — and several cards query the state directly, so it
   * has to be a fact about the unit rather than a derived coincidence.
   */
  newlyDeployed: z.boolean().default(false),
  /**
   * Whether this unit blocked and lived through it **since its controller's
   * previous turn** (ruleset update §15).
   *
   * Cleared at the end of the controller's own turn rather than at their Ready
   * Step, which is what makes it readable by the `on_turn_start` cards that ask
   * about it — clearing first would leave them nothing to see. Nothing can be
   * added during the controller's own turn either way: blocking only happens on
   * the turn of whoever declared the attack, which is never yours.
   *
   * A separate fact from `turnEvents.survivedAsBlocker`, which answers the
   * narrower "…that turn". Both are written from the same `combat_survived`
   * event, so they cannot disagree about what happened — only about the window
   * they describe.
   */
  survivedAsBlocker: z.boolean().default(false),
  statModifiers: z.array(statModifierSchema),
  grantedKeywords: z.array(keywordModifierSchema),
  removedKeywords: z.array(keywordModifierSchema),
  damageShields: z.array(damageShieldSchema),
  /**
   * Whether this instance's Barrier has already absorbed a hit.
   *
   * Barrier is printed or granted as a keyword, but it is consumed *once* — so
   * "does this unit have Barrier" and "is its Barrier still available" are two
   * different questions and need two pieces of state. Re-granting Barrier
   * clears this, which is what lets a card hand the same unit a fresh Barrier
   * on a later turn (ruleset update §9).
   */
  barrierSpent: z.boolean().default(false),
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
  /**
   * Every unit this player controls, in the order they arrived.
   *
   * A dense list, not a fixed set of slots: the battlefield has no limit
   * (ruleset update §7). Position carries no rules meaning — it exists only so
   * the order is deterministic for targeting, trigger tiebreaks and rendering.
   */
  units: z.array(instanceIdSchema),
  /** Relics occupy their own zone and are never units. */
  relics: z.array(instanceIdSchema),
  commanderInstanceId: instanceIdSchema,
  /**
   * How many times this player's Commander has been defeated (rule adjustment
   * §2). Each defeat adds `commanderCostPerDefeat` to its deployment cost, up
   * to `commanderCostCap`.
   *
   * Stored on the seat rather than on the Commander instance because the
   * instance is the thing that keeps dying: the count has to be a fact about
   * the player, and it persists for the rest of the match. Only a *defeat*
   * increments it — a Commander moved between zones for any other reason does
   * not get more expensive.
   */
  commanderDefeats: z.number().int().min(0),
  /**
   * Whether this player has already used their once-per-turn-cycle Reaction
   * discount (rule adjustment §6).
   *
   * Reset at the beginning of this player's own turn and *not* at the start of
   * each opponent's, which is exactly what makes the discount survive the
   * opponents' turns in between — the turns a Reaction is normally played on.
   * Only a Reaction actually played consumes it.
   */
  reactionDiscountSpent: z.boolean(),

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

/**
 * One thing that happened to a card during the current turn.
 *
 * Keeps the definition ID and controller rather than a reference, because the
 * card is usually gone by the time anything asks: "two friendly Units were
 * defeated this turn" cannot be answered from the battlefield. Instance-
 * dependent filters (damaged, exhausted) simply do not apply to a card that has
 * left play, which is the right answer rather than a missing one.
 */
export const turnEventEntrySchema = z.strictObject({
  instanceId: instanceIdSchema,
  definitionId: cardIdSchema,
  /** Who controlled it when the event happened, not who owns it now. */
  controller: playerIdSchema,
});
export type TurnEventEntry = z.infer<typeof turnEventEntrySchema>;

/**
 * What has happened so far this turn, for the "… this turn" family of
 * conditions and counts (ruleset update §15).
 *
 * Reset at the start of every turn, and derived entirely from the authoritative
 * event stream rather than written by hand at each call site — so it cannot
 * disagree with the log a replay would produce.
 */
export const turnEventsSchema = z.strictObject({
  /** Every defeat, whatever the reason. */
  defeated: z.array(turnEventEntrySchema),
  /** Sacrifices only. Always a subset of `defeated` (CLAUDE.md §17 Q24). */
  sacrificed: z.array(turnEventEntrySchema),
  /** Units that arrived on a battlefield, tokens included. */
  deployed: z.array(turnEventEntrySchema),
  /** Tokens created. Always a subset of `deployed`. */
  tokensCreated: z.array(turnEventEntrySchema),
  /**
   * Units that blocked and survived combat **this turn**.
   *
   * The narrow window, as opposed to the instance's `survivedAsBlocker` flag.
   * A card asking "did a friendly Unit survive as a blocker *that* turn" cannot
   * use the flag: after two opponents' turns the flag is still set from the
   * first, and the answer for the second is no.
   */
  survivedAsBlocker: z.array(turnEventEntrySchema),
});
export type TurnEvents = z.infer<typeof turnEventsSchema>;

export const EMPTY_TURN_EVENTS: TurnEvents = Object.freeze({
  defeated: [],
  sacrificed: [],
  deployed: [],
  tokensCreated: [],
  survivedAsBlocker: [],
});

/**
 * A fresh, mutable, empty turn history.
 *
 * `EMPTY_TURN_EVENTS` is frozen and shares its arrays, so it can be read but
 * never installed. Match setup and every turn start need their own — and they
 * were each building the literal by hand, which meant adding a list to the
 * shape broke both of them separately.
 */
export function freshTurnEvents(): TurnEvents {
  return { defeated: [], sacrificed: [], deployed: [], tokensCreated: [], survivedAsBlocker: [] };
}

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
  /**
   * The card the trigger was *about*, for a `trigger_subject` target.
   *
   * Null for anything that is not a triggered ability, and for turn-phase
   * triggers, which are about a phase rather than a card. Carried on the queued
   * item rather than looked up later because the subject is routinely gone by
   * the time the ability resolves — a defeat trigger's subject is, by
   * definition, in a discard pile.
   */
  triggerSubjectInstanceId: instanceIdSchema.nullable().default(null),
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
  /**
   * Whether the instruction before `effectIndex` actually changed the match.
   *
   * The whole of "**If you do**, …". Measured by whether that step emitted an
   * event, not by whether the engine reached it: a declined "you may
   * sacrifice", a sacrifice with nothing to sacrifice, and a `ready` on a unit
   * that was already ready all leave the board untouched, and a player reads
   * every one of them as "you did not".
   *
   * On the item rather than derived from the log because the log is append-only
   * and shared — asking it "did step 3 of this item do anything" after later
   * items have written to it would mean scanning backwards for a boundary that
   * is not recorded.
   */
  previousStepActed: z.boolean().default(false),
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

/**
 * One card waiting in a Reaction window's pending queue.
 *
 * The queue is resolved **last in, first out** when the window closes (rule
 * adjustment §5.6), which is the one place in this engine where anything is not
 * FIFO — and it is not a stack in the MTG sense: nothing gains priority from
 * being on it, and the only thing that can interact with it is a Reaction that
 * explicitly counters a Spell.
 */
export const pendingReactionSchema = z.strictObject({
  instanceId: instanceIdSchema,
  definitionId: cardIdSchema,
  controllerId: playerIdSchema,
  /**
   * Set by a resolving counter. A countered card has no effect and moves to its
   * owner's discard; a countered permanent never enters the battlefield.
   */
  countered: z.boolean(),
  /** The Reaction that countered it, for the log and for replay attribution. */
  counteredByInstanceId: instanceIdSchema.nullable(),
  /**
   * True for the card the window was opened *about* — the Spell an opponent
   * played — as opposed to a Reaction played into the window. It sits at the
   * bottom of the queue and therefore resolves last, which is what makes
   * "counter it" work.
   */
  isSubject: z.boolean(),
});
export type PendingReaction = z.infer<typeof pendingReactionSchema>;

/**
 * An open Reaction window.
 *
 * A window is opened only when at least one eligible player actually holds a
 * playable Reaction for it. That is not an optimisation: it is what keeps a
 * match with no Reaction cards in it running the exact phase machine it ran
 * before Reactions existed, and it stays deterministic because "who could act"
 * is a pure function of the state everyone can already see.
 */
export const reactionWindowStateSchema = z.strictObject({
  id: z.string().min(1),
  /** Which window this is. A single opening may admit more than one label. */
  windows: z.array(reactionWindowSchema).min(1),
  /** Sequence number of the event that opened it, for causal logs. */
  triggerSequence: z.number().int().min(0),
  /**
   * Priority order: the active player first, then clockwise (rule adjustment
   * §5.3). This deliberately supersedes the earlier provisional policy that
   * started from the non-active player.
   */
  priorityOrder: z.array(playerIdSchema),
  /** Index into `priorityOrder` of the player currently holding priority. */
  priorityIndex: z.number().int().min(0),
  /**
   * How many Reactions each player has played in *this* window. The
   * one-per-player limit is validated per window, so a player who has acted may
   * not act again even when priority comes back round to them.
   */
  playsByPlayer: z.record(playerIdSchema, z.number().int().min(0)),
  /** Players who have passed since the last Reaction was played. */
  passedPlayerIds: z.array(playerIdSchema),
  /** LIFO. The subject, if any, is at index 0 and resolves last. */
  pending: z.array(pendingReactionSchema),
  /**
   * Priority is finished and the pending queue is draining.
   *
   * The window outlives its own priority round because a counter has to be able
   * to name what is still waiting below it. Clearing the window at the moment
   * the last player passed would delete the queue the counter is about to act
   * on — which is why closing and resolving are two states, not one step.
   */
  closed: z.boolean(),
  /** The phase the match returns to once the window closes and resolves. */
  resumePhase: matchPhaseSchema,
});
export type ReactionWindowState = z.infer<typeof reactionWindowStateSchema>;

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
  /** The open Reaction window, or `null` when none is (rule adjustment §5). */
  reactionWindow: reactionWindowStateSchema.nullable(),
  nextReactionWindowOrdinal: z.number().int().min(0),
  /** Cleared at the start of every turn; see `turnEventsSchema`. */
  turnEvents: turnEventsSchema,
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
