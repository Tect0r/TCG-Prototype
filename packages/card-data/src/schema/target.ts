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

export const PLAYER_SELECTORS = ['self', 'opponent', 'each_opponent', 'all', 'target_player'] as const;
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
