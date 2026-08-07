import { z } from 'zod';

/**
 * Card schema version. Bump when the card schema changes in a way that older
 * data files cannot satisfy, and add a loader migration at the same time.
 */
export const CARD_SCHEMA_VERSION = 1;

/**
 * Permanent card identity: lowercase ASCII letters, digits and underscores.
 * Must never change after release (see CLAUDE.md §6).
 */
export const CARD_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export const cardIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    CARD_ID_PATTERN,
    'Card IDs must be lowercase_english_snake_case (a-z, 0-9, _) and start with a letter.',
  );

export type CardId = z.infer<typeof cardIdSchema>;

/**
 * Provisional colour set. Placeholder identities only — no lore attached.
 * See docs/rules/open-decisions.md before renaming.
 */
export const COLOR_IDS = ['white', 'blue', 'black', 'red', 'green'] as const;
export const colorIdSchema = z.enum(COLOR_IDS);
export type ColorId = z.infer<typeof colorIdSchema>;

/** An empty colour identity means neutral/colourless: legal under any Commander. */
export const colorIdentitySchema = z
  .array(colorIdSchema)
  .max(COLOR_IDS.length)
  .refine((colors) => new Set(colors).size === colors.length, {
    message: 'Colour identity must not repeat a colour.',
  });

export const CARD_TYPES = ['unit', 'spell', 'relic', 'commander', 'token'] as const;
export const cardTypeSchema = z.enum(CARD_TYPES);
export type CardType = z.infer<typeof cardTypeSchema>;

export const ROLES = [
  'token',
  'attacker',
  'blocker',
  'support',
  'enabler',
  'payoff',
  'removal',
  'finisher',
  'build_around',
] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/**
 * Intended mechanical impact, not player progression and not a card level.
 */
export const POWER_CLASSES = ['minor', 'standard', 'major', 'centerpiece'] as const;
export const powerClassSchema = z.enum(POWER_CLASSES);
export type PowerClass = z.infer<typeof powerClassSchema>;

/**
 * Provisional keyword vocabulary. Phase 1 only needs these to exist so cards
 * can be authored and filtered; execution arrives with the rules engine.
 */
export const KEYWORD_IDS = [
  'swift',
  'guardian',
  'evasive',
  'armored',
  'siphon',
  'venom',
  'quick_strike',
  'resilient',
] as const;
export const keywordIdSchema = z.enum(KEYWORD_IDS);
export type KeywordId = z.infer<typeof keywordIdSchema>;

/** Free-form authoring tags (creature types, strategies). Lowercase snake_case. */
export const tagSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, 'Tags must be lowercase_snake_case.');
export type Tag = z.infer<typeof tagSchema>;

export const ZONE_IDS = [
  'deck',
  'hand',
  'battlefield',
  'discard',
  'commander_zone',
  'recovery',
] as const;
export const zoneIdSchema = z.enum(ZONE_IDS);
export type ZoneId = z.infer<typeof zoneIdSchema>;

/** Card types that can be put into a deck list (Commanders are chosen separately). */
export const DECKABLE_CARD_TYPES: readonly CardType[] = ['unit', 'spell', 'relic'];
