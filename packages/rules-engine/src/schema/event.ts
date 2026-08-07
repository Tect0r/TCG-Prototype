import { z } from 'zod';
import { cardIdSchema, durationSchema, keywordIdSchema, zoneIdSchema } from '@tcg/card-data';
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
    playerIds: z.array(playerIdSchema),
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
    instanceId: instanceIdSchema,
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
  event('unit_deployed', {
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
    slot: z.number().int().min(0),
  }),
  event('relic_deployed', {
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
  }),
  event('spell_resolved', {
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
  }),
  event('token_created', {
    playerId: playerIdSchema,
    instanceId: instanceIdSchema,
    definitionId: cardIdSchema,
    slot: z.number().int().min(0),
  }),
  event('token_creation_failed', {
    playerId: playerIdSchema,
    definitionId: cardIdSchema,
    reason: z.enum(['no_free_slot']),
  }),

  event('attackers_declared', {
    playerId: playerIdSchema,
    instanceIds: z.array(instanceIdSchema),
  }),
  event('blockers_assigned', {
    playerId: playerIdSchema,
    blocks: z.array(
      z.strictObject({
        attackerInstanceId: instanceIdSchema,
        blockerInstanceId: instanceIdSchema,
      }),
    ),
  }),
  event('combat_damage_step', { step: z.enum(['quick_strike', 'regular']) }),
  event('combat_survived', { instanceId: instanceIdSchema, definitionId: cardIdSchema }),

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
  event('effect_resolved', {
    resolutionId: z.string(),
    effectType: z.string(),
    effectIndex: z.number().int().min(0),
  }),
  event('effect_fizzled', {
    resolutionId: z.string(),
    effectType: z.string(),
    effectIndex: z.number().int().min(0),
    reason: z.enum(['no_legal_target', 'unsupported']),
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
