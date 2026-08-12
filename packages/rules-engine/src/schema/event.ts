import { z } from 'zod';
import {
  cardIdSchema,
  durationSchema,
  keywordIdSchema,
  reactionWindowSchema,
  zoneIdSchema,
} from '@tcg/card-data';
import {
  instanceIdSchema,
  lossReasonSchema,
  matchPhaseSchema,
  playerIdSchema,
} from './primitives.js';
import { choiceReasonSchema, choiceTypeSchema } from './choice.js';

/**
 * Causal provenance for an event: which action, which resolution item and which
 * card instance produced it. Required by CLAUDE.md §10 so a log can be replayed
 * and a rules bug traced back to its source without guesswork.
 */
export const eventCauseSchema = z.strictObject({
  actionType: z.string().nullable(),
  sourceInstanceId: instanceIdSchema.nullable(),
  resolutionId: z.string().nullable(),
});
export type EventCause = z.infer<typeof eventCauseSchema>;

const base = {
  sequence: z.number().int().min(0),
  cause: eventCauseSchema,
};

const event = <T extends string, S extends z.ZodRawShape>(type: T, shape: S) =>
  z.strictObject({ ...base, type: z.literal(type), ...shape });

const damageTarget = {
  targetInstanceId: instanceIdSchema.nullable(),
  targetPlayerId: playerIdSchema.nullable(),
};

/**
 * Every observable state change. The union is deliberately explicit rather than
 * a generic `{ type, payload }` bag: a redaction rule or a UI renderer that
 * forgets a case then fails to compile.
 */
export const gameEventSchema = z.discriminatedUnion('type', [
  event('match_started', {
    /** Turn order: the seat circle rotated to the starting player. */
    playerIds: z.array(playerIdSchema),
    /** The stable seat circle itself, which never changes (CLAUDE.md §12). */
    seatOrder: z.array(playerIdSchema),
    startingPlayerId: playerIdSchema,
    rulesVersion: z.string(),
  }),
  event('deck_shuffled', { playerId: playerIdSchema, deckSize: z.number().int().min(0) }),
  event('mulligan_submitted', {
    playerId: playerIdSchema,
    returnedCount: z.number().int().min(0),
  }),
  event('mulligan_resolved', {
    playerId: playerIdSchema,
    returnedCount: z.number().int().min(0),
  }),
  event('turn_started', { playerId: playerIdSchema, turn: z.number().int().min(1) }),
  event('phase_changed', { from: matchPhaseSchema, to: matchPhaseSchema }),
  event('energy_updated', {
    playerId: playerIdSchema,
    energy: z.number().int().min(0),
    maxEnergy: z.number().int().min(0),
  }),
  event('draw_skipped', { playerId: playerIdSchema }),

  // `definitionId` is redacted to null for players who may not see the card.
  event('card_drawn', {
    playerId: playerIdSchema,
    /**
     * Null for other viewers. A drawn card was never public, so even its opaque
     * instance ID is hidden information: leaving it in would let a viewer track
     * which physical cards a rival kept through a mulligan (CLAUDE.md §12).
     */
    instanceId: instanceIdSchema.nullable(),
    definitionId: cardIdSchema.nullable(),
    deckRemaining: z.number().int().min(0),
  }),
  event('card_discarded', {
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
  }),
  event('card_played', {
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
    energySpent: z.number().int().min(0),
  }),
  /**
   * A card was **played** onto the battlefield by paying its deployment cost —
   * from hand, or from the Command Zone (rule adjustment §7).
   *
   * Deliberately narrower than `unit_entered_battlefield`, which fires for any
   * arrival at all. Keeping the two apart is the whole point: the update
   * forbids reinterpreting existing "When deployed" cards as "when this enters
   * the battlefield", so the engine has to be able to tell a deployment from a
   * revival rather than treating every arrival alike.
   */
  event('unit_deployed', {
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
  }),
  /**
   * A card arrived on a battlefield by any route: deployment, token creation,
   * revival, or an effect that simply put it there.
   *
   * A normal deployment emits `unit_deployed` **then** this, in that order, so a
   * log reads "played, and therefore arrived" rather than the reverse.
   */
  event('unit_entered_battlefield', {
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
    /** How it got there. `deployed` is the only one that also emits the above. */
    method: z.enum(['deployed', 'token_created', 'returned', 'effect']),
  }),
  /** A Commander was deployed from its Command Zone (rule adjustment §2). */
  event('commander_deployed', {
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
    energySpent: z.number().int().min(0),
    /** Defeats already suffered, i.e. the surcharge included in `energySpent`. */
    defeatCount: z.number().int().min(0),
  }),
  /**
   * A defeated Commander went back to its Command Zone instead of the discard
   * pile, and its future deployment cost went up (rule adjustment §2).
   *
   * Its own event rather than a `card_moved`, because the cost change is the
   * part a player and a replay both need to see, and reconstructing it from a
   * move plus a defeat would mean re-deriving a rule from two unrelated records.
   */
  event('commander_returned', {
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
    defeatCount: z.number().int().min(0),
    /** The new total deployment cost, after the cap has been applied. */
    deploymentCost: z.number().int().min(0),
  }),
  event('relic_deployed', {
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
  }),
  /**
   * The previous active relic left because a new one was played.
   *
   * Its own event rather than a `card_moved` or a `unit_defeated`: replacement
   * is a **rules action**, not destruction and not a sacrifice, so it fires
   * neither `on_defeated` nor `on_sacrifice` (ruleset update §12, ADR 0016 §3).
   * A future card that cares about relics being replaced can key off this
   * without having to reinterpret discard events.
   */
  event('relic_replaced', {
    playerId: playerIdSchema,
    /** The relic that left play. */
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
    /** The relic being played, which is not yet on the battlefield. */
    replacedByInstanceId: instanceIdSchema,
    replacedByDefinitionId: cardIdSchema,
  }),
  event('spell_resolved', {
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
  }),
  /**
   * There is deliberately no companion `token_creation_failed`. With no unit
   * limit a requested token is always created (ruleset update §7); the old
   * "battlefield is full, so nothing happens" outcome no longer exists and must
   * not be reintroduced.
   */
  event('token_created', {
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
  }),
  /**
   * Every token one instruction created for one player, as a batch.
   *
   * Emitted once after the last of them arrives, alongside the per-token
   * `token_created` events. "Whenever you create one or more Tokens" keys off
   * this rather than counting the singular events, so it fires once for a
   * five-token instruction and sees the finished board (ruleset update §13).
   */
  event('tokens_created', {
    playerId: playerIdSchema,
    definitionId: cardIdSchema,
    instanceIds: z.array(instanceIdSchema),
    count: z.number().int().min(1),
  }),

  event('attackers_declared', {
    playerId: playerIdSchema,
    instanceIds: z.array(instanceIdSchema),
    /** Which opponent each attacker chose, in the same order (CLAUDE.md §12). */
    attacks: z.array(
      z.strictObject({
        attackerInstanceId: instanceIdSchema,
        defenderPlayerId: playerIdSchema,
      }),
    ),
  }),
  /**
   * One defender has answered. Deliberately carries no assignments: the choices
   * stay hidden until every attacked player has submitted (CLAUDE.md §12).
   */
  event('blockers_submitted', {
    playerId: playerIdSchema,
    blockCount: z.number().int().min(0),
    awaitingPlayerIds: z.array(playerIdSchema),
  }),
  /** Every defender has answered; the merged assignment is now public. */
  event('blockers_assigned', {
    playerId: playerIdSchema.nullable(),
    blocks: z.array(
      z.strictObject({
        attackerInstanceId: instanceIdSchema,
        blockerInstanceId: instanceIdSchema,
      }),
    ),
  }),
  /* ------------------------------------------------------- reaction windows */
  event('reaction_window_opened', {
    windowId: z.string(),
    windows: z.array(reactionWindowSchema),
    /** Priority order: active player first, then clockwise (rule adjustment §5.3). */
    priorityOrder: z.array(playerIdSchema),
    /** The Spell the window is about, when it is about one. */
    subjectInstanceId: instanceIdSchema.nullable(),
  }),
  /**
   * A player declined with priority.
   *
   * Emitted individually rather than as a batch so replay data records every
   * pass, as required — the spectator log collapses runs of them by default,
   * which is a presentation decision and must not cost the record.
   */
  event('reaction_passed', { windowId: z.string(), playerId: playerIdSchema }),
  event('reaction_played', {
    windowId: z.string(),
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
    energySpent: z.number().int().min(0),
    /** Set when the per-turn Reaction discount paid for part of it. */
    discountApplied: z.number().int().min(0),
  }),
  /** Everyone has passed consecutively; the pending queue now resolves LIFO. */
  event('reaction_window_closed', {
    windowId: z.string(),
    /** Instance IDs in the order they will resolve. */
    resolutionOrder: z.array(instanceIdSchema),
  }),
  /**
   * A card was countered: it has no effect and moves to its owner's discard. A
   * countered permanent never enters the battlefield.
   */
  event('card_countered', {
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
    playerId: playerIdSchema,
    counteredByInstanceId: instanceIdSchema.nullable(),
  }),

  event('combat_damage_step', { step: z.enum(['quick_strike', 'regular']) }),
  event('combat_survived', {
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
    /**
     * Whether it survived while *blocking*, as opposed to while attacking.
     *
     * Carried on the event rather than reconstructed later: by the time a
     * trigger asks, combat has been cleared, and "survived as a blocker" is a
     * fact about the combat that just happened (ruleset update §15).
     */
    asBlocker: z.boolean(),
  }),

  event('damage_dealt', {
    ...damageTarget,
    amount: z.number().int().min(0),
    prevented: z.number().int().min(0),
    lethal: z.boolean(),
    combat: z.boolean(),
  }),
  event('damage_prevented', { ...damageTarget, amount: z.number().int().min(0) }),
  event('healed', { ...damageTarget, amount: z.number().int().min(0) }),
  event('damage_shield_added', { ...damageTarget, amount: z.number().int().min(0) }),
  /** A unit's Barrier absorbed a hit and is now spent (ruleset update §9). */
  event('barrier_consumed', { instanceId: instanceIdSchema }),

  event('stats_modified', {
    instanceId: instanceIdSchema,
    attack: z.number().int(),
    health: z.number().int(),
    duration: durationSchema,
  }),
  event('keyword_granted', {
    instanceId: instanceIdSchema,
    keyword: keywordIdSchema,
    duration: durationSchema,
  }),
  event('keyword_removed', {
    instanceId: instanceIdSchema,
    keyword: keywordIdSchema,
    duration: durationSchema,
  }),
  event('modifiers_expired', { instanceId: instanceIdSchema, count: z.number().int().min(0) }),

  event('unit_exhausted', { instanceId: instanceIdSchema }),
  event('unit_readied', { instanceId: instanceIdSchema }),

  /**
   * A replacement rewrote a card's arrival on the battlefield (M02.4).
   *
   * Emitted *before* `unit_deployed` / `unit_entered_battlefield`, because the
   * rewrite is part of the arrival rather than something that happened to the
   * card afterwards: by the time the arrival is announced, the card is already
   * in the state this event describes. Attribution is the point — a player
   * whose unit arrives Exhausted has to be able to see which permanent did it,
   * and a replay has to be able to tell two Relics apart.
   */
  event('arrival_replaced', {
    /** The arriving card and its controller. */
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
    /** The permanent whose static ability rewrote the arrival. */
    sourceInstanceId: instanceIdSchema,
    sourceDefinitionId: cardIdSchema,
    abilityId: z.string(),
    exhausted: z.boolean(),
    keyword: keywordIdSchema.nullable(),
  }),
  /**
   * A permanent that would have become Ready at its controller's Ready Step did
   * not (M02.4).
   *
   * One event for both halves of the layer — a stored `skip_next_ready` and a
   * standing `replace_ready` — because what a player needs to know is identical
   * and the distinction is already carried by `abilityId` being null for the
   * stored one. `sourceInstanceId` is nullable because the card that applied a
   * stored prevention is routinely gone by the time it acts.
   */
  event('ready_prevented', {
    /** The permanent that stayed Exhausted, and who controls it. */
    instanceId: instanceIdSchema,
    playerId: playerIdSchema,
    sourceInstanceId: instanceIdSchema.nullable(),
    sourceDefinitionId: cardIdSchema.nullable(),
    abilityId: z.string().nullable(),
    /** Energy the replacement's controller paid for it, if any. */
    energySpent: z.number().int().min(0),
  }),
  /** A `skip_next_ready` instruction armed a permanent (M02.4). */
  event('ready_skip_applied', {
    instanceId: instanceIdSchema,
    playerId: playerIdSchema,
    sourceInstanceId: instanceIdSchema.nullable(),
  }),
  event('unit_defeated', {
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
    controllerId: playerIdSchema,
    reason: z.enum(['lethal_damage', 'destroyed', 'sacrificed', 'zero_health']),
  }),
  event('card_moved', {
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema.nullable(),
    playerId: playerIdSchema,
    fromZone: zoneIdSchema,
    toZone: zoneIdSchema,
  }),
  event('zone_reordered', {
    playerId: playerIdSchema,
    zone: zoneIdSchema,
    count: z.number().int().min(0),
  }),
  event('cards_revealed', {
    playerId: playerIdSchema,
    instanceIds: z.array(instanceIdSchema),
    definitionIds: z.array(cardIdSchema).nullable(),
  }),
  event('cost_modified', {
    playerId: playerIdSchema,
    delta: z.number().int(),
    duration: durationSchema,
  }),

  event('trigger_queued', {
    sourceInstanceId: instanceIdSchema,
    definitionId: cardIdSchema,
    controllerId: playerIdSchema,
    abilityId: z.string().nullable(),
    triggerId: z.string(),
    resolutionId: z.string(),
  }),
  /**
   * A delayed effect has been set up and is now waiting (M02.1).
   *
   * Public: both halves of what created it — a Spell resolving, a trigger
   * firing — were already in the log, and a delayed clause that nobody could see
   * would make the board unreadable when it fires three decisions later.
   */
  event('delayed_effect_scheduled', {
    delayedId: z.string(),
    sourceInstanceId: instanceIdSchema.nullable(),
    definitionId: cardIdSchema,
    controllerId: playerIdSchema,
    abilityId: z.string(),
    subjectInstanceId: instanceIdSchema.nullable(),
    boundary: z.string(),
    /** The event it is waiting for, or `null` if it fires at the boundary. */
    triggerId: z.string().nullable(),
  }),
  /** A delayed effect's moment arrived and its instructions were queued. */
  event('delayed_effect_fired', {
    delayedId: z.string(),
    definitionId: cardIdSchema,
    controllerId: playerIdSchema,
    abilityId: z.string(),
    subjectInstanceId: instanceIdSchema.nullable(),
    resolutionId: z.string(),
  }),
  /**
   * A delayed effect ended without resolving.
   *
   * `boundary_passed` is a watch whose event never happened; `subject_moved` is
   * the subject leaving the zone it was named in; `controller_eliminated` is
   * §12 step 3. Distinguished rather than collapsed because the three say very
   * different things about a card in a balance review.
   */
  event('delayed_effect_expired', {
    delayedId: z.string(),
    definitionId: cardIdSchema,
    controllerId: playerIdSchema,
    abilityId: z.string(),
    reason: z.enum(['boundary_passed', 'subject_moved', 'controller_eliminated']),
  }),
  event('effect_resolved', {
    resolutionId: z.string(),
    effectType: z.string(),
    effectIndex: z.number().int().min(0),
  }),
  event('effect_fizzled', {
    resolutionId: z.string(),
    effectType: z.string(),
    effectIndex: z.number().int().min(0),
    /**
     * `declined` is an optional instruction its controller said no to. A
     * separate reason from `condition_unmet` because the two are different
     * facts about the match — one is a board state, the other is a decision a
     * player made — and a log that conflated them could not tell a reviewer
     * whether a card was bad or a pilot was wrong.
     */
    reason: z.enum(['no_legal_target', 'unsupported', 'condition_unmet', 'declined']),
  }),

  event('choice_requested', {
    choiceId: z.string(),
    playerId: playerIdSchema,
    choiceType: choiceTypeSchema,
    reason: choiceReasonSchema,
    minimum: z.number().int().min(0),
    maximum: z.number().int().min(0),
    /** Redacted to null for players who cannot see the option set. */
    validEntityIds: z.array(z.string()).nullable(),
  }),
  event('choice_resolved', {
    choiceId: z.string(),
    playerId: playerIdSchema,
    /** Redacted to null when the selection is private (e.g. a hand discard). */
    selectedIds: z.array(z.string()).nullable(),
  }),

  event('player_damaged', {
    playerId: playerIdSchema,
    amount: z.number().int().min(0),
    health: z.number().int(),
  }),
  event('player_healed', {
    playerId: playerIdSchema,
    amount: z.number().int().min(0),
    health: z.number().int(),
  }),
  event('player_lost', { playerId: playerIdSchema, reason: lossReasonSchema }),
  /** The elimination cleanup has run for this seat (CLAUDE.md §12). */
  event('player_eliminated', { playerId: playerIdSchema, turn: z.number().int().min(0) }),
  event('effects_cancelled', { playerId: playerIdSchema, count: z.number().int().min(0) }),
  event('choice_cancelled', { choiceId: z.string(), playerId: playerIdSchema }),
  /** A card an eliminated player controlled has gone back to its owner. */
  event('control_returned', { instanceId: instanceIdSchema, playerId: playerIdSchema }),
  event('match_ended', {
    outcome: z.enum(['win', 'draw']),
    winnerId: playerIdSchema.nullable(),
    reason: z.string(),
  }),
  event('engine_fault', { code: z.string(), message: z.string() }),
]);

export type GameEvent = z.infer<typeof gameEventSchema>;
export type GameEventType = GameEvent['type'];

/** An event before the engine stamps it with a sequence number. */
export type EventDraft = DistributiveOmit<GameEvent, 'sequence' | 'cause'> & {
  cause?: Partial<EventCause>;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
