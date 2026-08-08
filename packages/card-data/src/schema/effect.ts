import { z } from 'zod';
import { cardIdSchema, keywordIdSchema, zoneIdSchema } from './primitives.js';
import {
  cardFilterSchema,
  controllerSchema,
  durationSchema,
  playerSelectorSchema,
  selectionModeSchema,
  targetDefinitionSchema,
  targetSelectorSchema,
} from './target.js';

/**
 * Structured effects. Card behaviour is data, never parsed prose (CLAUDE.md §8).
 *
 * A discriminated union keeps each effect's required fields its own business.
 */

const amount = z.number().int().min(0).max(99);

/**
 * Effects that can only ever apply to a card or unit. Restricting the union at
 * the schema boundary means "destroy target opponent" is rejected when the data
 * loads rather than fizzling silently at resolution time.
 */
const entityTargetSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('entity'), selector: targetSelectorSchema }),
  z.strictObject({ kind: z.literal('source') }),
]);
export type EntityTarget = z.infer<typeof entityTargetSchema>;

export const effectDefinitionSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('draw'),
    player: playerSelectorSchema.default('self'),
    amount,
  }),
  z.strictObject({
    type: z.literal('discard'),
    player: playerSelectorSchema.default('self'),
    amount,
    selection: selectionModeSchema.default('player_choice'),
  }),
  z.strictObject({
    type: z.literal('deal_damage'),
    /** Units, the source itself, or a player (CLAUDE.md §12). */
    target: targetDefinitionSchema,
    amount,
  }),
  z.strictObject({
    type: z.literal('heal'),
    target: targetDefinitionSchema,
    amount,
  }),
  z.strictObject({
    type: z.literal('modify_stats'),
    target: entityTargetSchema,
    attack: z.number().int().min(-99).max(99).default(0),
    health: z.number().int().min(-99).max(99).default(0),
    duration: durationSchema.default('permanent'),
  }),
  z.strictObject({
    type: z.literal('grant_keyword'),
    target: entityTargetSchema,
    keyword: keywordIdSchema,
    duration: durationSchema.default('permanent'),
  }),
  z.strictObject({
    type: z.literal('remove_keyword'),
    target: entityTargetSchema,
    keyword: keywordIdSchema,
    duration: durationSchema.default('permanent'),
  }),
  z.strictObject({
    type: z.literal('create_token'),
    tokenCardId: cardIdSchema,
    amount: z.number().int().min(1).max(20),
    controller: playerSelectorSchema.default('self'),
  }),
  z.strictObject({
    type: z.literal('destroy'),
    target: entityTargetSchema,
  }),
  z.strictObject({
    type: z.literal('sacrifice'),
    target: entityTargetSchema,
  }),
  z.strictObject({
    type: z.literal('return_to_hand'),
    target: entityTargetSchema,
  }),
  z.strictObject({
    type: z.literal('search_zone'),
    player: playerSelectorSchema.default('self'),
    zone: zoneIdSchema,
    filter: cardFilterSchema.optional(),
    amount: z.number().int().min(1).max(10).default(1),
    destination: zoneIdSchema.default('hand'),
    reveal: z.boolean().default(false),
    /**
     * Searching a *public* zone is mandatory when a legal result exists unless
     * the effect opts out here; a hidden zone may always legally find nothing
     * (CLAUDE.md §17 Q25).
     */
    upTo: z.boolean().default(false),
  }),
  z.strictObject({
    type: z.literal('reorder_zone'),
    player: playerSelectorSchema.default('self'),
    zone: zoneIdSchema,
    amount: z.number().int().min(1).max(10),
  }),
  z.strictObject({
    type: z.literal('modify_cost'),
    player: playerSelectorSchema.default('self'),
    filter: cardFilterSchema.optional(),
    delta: z.number().int().min(-10).max(10),
    duration: durationSchema.default('end_of_turn'),
  }),
  z.strictObject({
    type: z.literal('prevent_damage'),
    target: targetDefinitionSchema,
    amount,
    duration: durationSchema.default('end_of_turn'),
  }),
  z.strictObject({
    type: z.literal('exhaust'),
    target: entityTargetSchema,
  }),
  z.strictObject({
    type: z.literal('ready'),
    target: entityTargetSchema,
  }),
  z.strictObject({
    type: z.literal('move_card'),
    target: entityTargetSchema,
    toZone: zoneIdSchema,
  }),
]);

export type EffectDefinition = z.infer<typeof effectDefinitionSchema>;
export type EffectType = EffectDefinition['type'];

export const EFFECT_TYPES = effectDefinitionSchema.options.map(
  (option) => option.shape.type.value,
) as readonly EffectType[];

/** Triggers that a card ability may listen to (CLAUDE.md §8). */
export const TRIGGER_IDS = [
  'on_attack',
  'on_block',
  'on_survive_combat',
  'on_defeated',
  'on_turn_start',
  'on_turn_end',
  'on_sacrifice',
] as const;
export const triggerIdSchema = z.enum(TRIGGER_IDS);
export type TriggerId = z.infer<typeof triggerIdSchema>;

const abilityIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, 'Ability IDs must be lowercase_snake_case.');

/**
 * A triggered ability.
 *
 * `on_deploy` is deliberately *not* in the trigger vocabulary: deploy behaviour
 * has exactly one authoring form, a card's top-level `effects` (CLAUDE.md §17
 * Q1). The v1 → v2 migration folds old `on_deploy` abilities into `effects`.
 */
export const abilityDefinitionSchema = z.strictObject({
  id: abilityIdSchema,
  trigger: triggerIdSchema,
  effects: z.array(effectDefinitionSchema).min(1),
});
export type AbilityDefinition = z.infer<typeof abilityDefinitionSchema>;

/**
 * How often an activated ability may be used. CLAUDE.md §4 requires either
 * `once_per_match` or a documented reusable restriction, so the restriction is
 * an explicit enum rather than an open-ended field.
 */
export const ABILITY_USAGE_LIMITS = ['once_per_match', 'once_per_turn', 'unlimited'] as const;
export const abilityUsageLimitSchema = z.enum(ABILITY_USAGE_LIMITS);
export type AbilityUsageLimit = z.infer<typeof abilityUsageLimitSchema>;

/**
 * What activating an ability costs.
 *
 * A structured, extensible array rather than a lone `energyCost` field: costs
 * are validated and paid atomically before the ability is queued, and sacrifice
 * is legal as a cost as well as an effect (CLAUDE.md §17 Q3/Q27).
 */
export const abilityCostSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('energy'), amount: z.number().int().min(0).max(20) }),
  z.strictObject({ type: z.literal('exhaust_source') }),
  z.strictObject({
    type: z.literal('discard'),
    amount: z.number().int().min(1).max(10),
    selection: selectionModeSchema.default('player_choice'),
  }),
  z.strictObject({
    type: z.literal('sacrifice'),
    amount: z.number().int().min(1).max(10),
    /** Restricts which friendly permanents may pay. Defaults to any unit. */
    filter: cardFilterSchema.optional(),
  }),
]);
export type AbilityCost = z.infer<typeof abilityCostSchema>;

/**
 * An ability the controller chooses to use. Phase 2/3 have no reactions, so the
 * only legal timing is the controller's own Main Phase with an empty effect
 * queue and no pending choice (CLAUDE.md §4).
 */
export const activatedAbilityDefinitionSchema = z.strictObject({
  id: abilityIdSchema,
  name: z.string().min(1).max(80),
  costs: z.array(abilityCostSchema).default([]),
  usageLimit: abilityUsageLimitSchema,
  timing: z.literal('main_phase').default('main_phase'),
  effects: z.array(effectDefinitionSchema).min(1),
});
export type ActivatedAbilityDefinition = z.infer<typeof activatedAbilityDefinitionSchema>;

/**
 * The set a continuous effect applies to. Deliberately not a `TargetSelector`:
 * a static ability has no count, no chooser and no moment of selection — it
 * describes a set that is recomputed whenever the board changes.
 */
export const continuousScopeSchema = z.strictObject({
  zone: zoneIdSchema.default('battlefield'),
  controller: controllerSchema.default('self'),
  filter: cardFilterSchema.optional(),
  /** Excludes the card the ability is printed on (a lord that does not buff itself). */
  excludeSource: z.boolean().default(false),
});
export type ContinuousScope = z.infer<typeof continuousScopeSchema>;

/**
 * A continuous effect.
 *
 * Static abilities are *derived*, never applied: nothing is stamped onto the
 * recipients, and the whole layer is recomputed after any relevant state change.
 * That is what makes "your units get +1/+0" cover units that arrive later, and
 * makes the bonus vanish the instant the source leaves play (CLAUDE.md §17 Q2).
 */
export const staticAbilityDefinitionSchema = z.strictObject({
  id: abilityIdSchema,
  /** Zone the source must be in for the ability to be active. */
  activeZone: zoneIdSchema.default('battlefield'),
  affects: continuousScopeSchema,
  effect: z.discriminatedUnion('type', [
    z.strictObject({
      type: z.literal('modify_stats'),
      attack: z.number().int().min(-99).max(99).default(0),
      health: z.number().int().min(-99).max(99).default(0),
    }),
    z.strictObject({ type: z.literal('grant_keyword'), keyword: keywordIdSchema }),
  ]),
});
export type StaticAbilityDefinition = z.infer<typeof staticAbilityDefinitionSchema>;
