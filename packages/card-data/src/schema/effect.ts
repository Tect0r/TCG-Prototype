import { z } from 'zod';
import { cardIdSchema, keywordIdSchema, zoneIdSchema } from './primitives.js';
import {
  cardFilterSchema,
  durationSchema,
  playerSelectorSchema,
  selectionModeSchema,
  targetSelectorSchema,
} from './target.js';

/**
 * Structured effects. Card behaviour is data, never parsed prose (CLAUDE.md §8).
 *
 * These schemas exist in Phase 1 so card data does not have to be rewritten
 * later; execution is deliberately out of scope until the rules engine lands.
 * A discriminated union keeps each effect's required fields its own business.
 */

const amount = z.number().int().min(0).max(99);

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
    target: targetSelectorSchema,
    amount,
  }),
  z.strictObject({
    type: z.literal('heal'),
    target: targetSelectorSchema,
    amount,
  }),
  z.strictObject({
    type: z.literal('modify_stats'),
    target: targetSelectorSchema,
    attack: z.number().int().min(-99).max(99).default(0),
    health: z.number().int().min(-99).max(99).default(0),
    duration: durationSchema.default('permanent'),
  }),
  z.strictObject({
    type: z.literal('grant_keyword'),
    target: targetSelectorSchema,
    keyword: keywordIdSchema,
    duration: durationSchema.default('permanent'),
  }),
  z.strictObject({
    type: z.literal('remove_keyword'),
    target: targetSelectorSchema,
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
    target: targetSelectorSchema,
  }),
  z.strictObject({
    type: z.literal('sacrifice'),
    target: targetSelectorSchema,
  }),
  z.strictObject({
    type: z.literal('return_to_hand'),
    target: targetSelectorSchema,
  }),
  z.strictObject({
    type: z.literal('search_zone'),
    player: playerSelectorSchema.default('self'),
    zone: zoneIdSchema,
    filter: cardFilterSchema.optional(),
    amount: z.number().int().min(1).max(10).default(1),
    destination: zoneIdSchema.default('hand'),
    reveal: z.boolean().default(false),
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
    target: targetSelectorSchema,
    amount,
    duration: durationSchema.default('end_of_turn'),
  }),
  z.strictObject({
    type: z.literal('exhaust'),
    target: targetSelectorSchema,
  }),
  z.strictObject({
    type: z.literal('ready'),
    target: targetSelectorSchema,
  }),
  z.strictObject({
    type: z.literal('move_card'),
    target: targetSelectorSchema,
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
  'on_deploy',
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
 * An ability the controller chooses to use. Phase 2 has no reactions, so the
 * only legal timing is the controller's own Main Phase with an empty effect
 * queue and no pending choice (CLAUDE.md §4).
 */
export const activatedAbilityDefinitionSchema = z.strictObject({
  id: abilityIdSchema,
  name: z.string().min(1).max(80),
  /** Energy paid before the ability enters the resolution queue. */
  energyCost: z.number().int().min(0).max(20),
  /** Whether using the ability exhausts its source. */
  exhaustsSource: z.boolean().default(false),
  usageLimit: abilityUsageLimitSchema,
  timing: z.literal('main_phase').default('main_phase'),
  effects: z.array(effectDefinitionSchema).min(1),
});
export type ActivatedAbilityDefinition = z.infer<typeof activatedAbilityDefinitionSchema>;
