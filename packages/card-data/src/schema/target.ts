import { z } from 'zod';
import {
  cardIdSchema,
  cardTypeSchema,
  colorIdSchema,
  keywordIdSchema,
  tagSchema,
  zoneIdSchema,
} from './primitives.js';

/**
 * Structured target filters. The authoritative engine computes the legal set
 * from these; the client never decides legality on its own (CLAUDE.md §9).
 */

export const numericRangeSchema = z
  .strictObject({
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  })
  .refine((r) => r.min === undefined || r.max === undefined || r.min <= r.max, {
    message: 'Range min must not exceed max.',
  });
export type NumericRange = z.infer<typeof numericRangeSchema>;

export const CONTROLLERS = ['self', 'opponent', 'any'] as const;
export const controllerSchema = z.enum(CONTROLLERS);
export type Controller = z.infer<typeof controllerSchema>;

/**
 * Which players an effect applies to.
 *
 * `opponent` names exactly one living opponent. With three or four seats that
 * is genuinely ambiguous, so the engine asks the controller to pick rather than
 * guessing — CLAUDE.md §12 requires an explicitly selected living opponent
 * unless the definition says `each_opponent`.
 *
 * `each_opponent` and `all_players` resolve clockwise; `all_players` puts the
 * controller first, then clockwise (open-questions.md Q33).
 */
export const PLAYER_SELECTORS = ['self', 'opponent', 'each_opponent', 'all_players'] as const;
export const playerSelectorSchema = z.enum(PLAYER_SELECTORS);
export type PlayerSelector = z.infer<typeof playerSelectorSchema>;

export const SELECTION_MODES = ['player_choice', 'random', 'automatic'] as const;
export const selectionModeSchema = z.enum(SELECTION_MODES);
export type SelectionMode = z.infer<typeof selectionModeSchema>;

export const DURATIONS = ['permanent', 'end_of_turn', 'while_source_present'] as const;
export const durationSchema = z.enum(DURATIONS);
export type Duration = z.infer<typeof durationSchema>;

/** `"all"` means every matching entity rather than a fixed count. */
export const targetCountSchema = z.union([z.number().int().min(1).max(20), z.literal('all')]);
export type TargetCount = z.infer<typeof targetCountSchema>;

export const cardFilterSchema = z.strictObject({
  cardTypes: z.array(cardTypeSchema).min(1).optional(),
  cardIds: z.array(cardIdSchema).min(1).optional(),
  colors: z.array(colorIdSchema).min(1).optional(),
  tags: z.array(tagSchema).min(1).optional(),
  keywords: z.array(keywordIdSchema).min(1).optional(),
  cost: numericRangeSchema.optional(),
  attack: numericRangeSchema.optional(),
  health: numericRangeSchema.optional(),
  damaged: z.boolean().optional(),
  exhausted: z.boolean().optional(),
  unique: z.boolean().optional(),
});
export type CardFilter = z.infer<typeof cardFilterSchema>;

/** A zone-and-filter query for cards or units. */
export const targetSelectorSchema = z.strictObject({
  zone: zoneIdSchema,
  controller: controllerSchema.default('any'),
  filter: cardFilterSchema.optional(),
  count: targetCountSchema.default(1),
  selection: selectionModeSchema.default('player_choice'),
  /** Who picks, when `selection` is `player_choice`. */
  chooser: playerSelectorSchema.default('self'),
  /** When true the effect resolves harmlessly if no legal target exists. */
  optional: z.boolean().default(false),
  /** Excludes the card that produced the effect from the legal set. */
  excludeSource: z.boolean().default(false),
});
export type TargetSelector = z.infer<typeof targetSelectorSchema>;

/**
 * What an effect points at.
 *
 * A discriminated union rather than one selector with escape-hatch booleans:
 * "the card this is printed on" and "an opposing player" are not zone queries,
 * and forcing them through `TargetSelector` is what produced the `targetsSource`
 * flag in Phase 2 (CLAUDE.md §12, open-questions.md Q23/Q29).
 */
export const targetDefinitionSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('entity'),
    selector: targetSelectorSchema,
  }),
  /** The instance whose text this is. Always exactly one entity, never chosen. */
  z.strictObject({
    kind: z.literal('source'),
  }),
  z.strictObject({
    kind: z.literal('player'),
    relation: z.enum(['self', 'opponent']),
    /**
     * `automatic` only resolves without asking when there is exactly one legal
     * answer; otherwise the engine raises a `select_players` choice regardless,
     * because it may not invent a target.
     */
    selection: z.enum(['automatic', 'player_choice']).default('player_choice'),
  }),
  z.strictObject({
    kind: z.literal('players'),
    relation: z.enum(['each_opponent', 'all_players']),
  }),
]);
export type TargetDefinition = z.infer<typeof targetDefinitionSchema>;
export type TargetDefinitionInput = z.input<typeof targetDefinitionSchema>;

/** Convenience constructor for the common "one zone query" case. */
export function entityTarget(
  selector: z.input<typeof targetSelectorSchema>,
): TargetDefinitionInput {
  return { kind: 'entity', selector };
}

/** True when the definition points at players rather than cards. */
export function targetsPlayers(
  target: TargetDefinition,
): target is Extract<TargetDefinition, { kind: 'player' | 'players' }> {
  return target.kind === 'player' || target.kind === 'players';
}
