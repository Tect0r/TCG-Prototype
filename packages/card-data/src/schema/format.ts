import { z } from 'zod';
import { cardIdSchema } from './primitives.js';
import { setIdSchema } from './card.js';

/**
 * Play-format schema version. Bump alongside a migration when the shape below
 * changes in a way older `content/formats/*.json` files cannot satisfy.
 */
export const FORMAT_SCHEMA_VERSION = 1;

export const formatIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, 'Format IDs must be lowercase_snake_case.');

/**
 * Deck-construction rules.
 *
 * Every value is a playtest dial, not a confirmed rule, and lives here rather
 * than inlined anywhere so a format change is one edit. `singleton` is its own
 * flag rather than "copyLimit 1" because the two mean different things to a
 * player and to the validator's error messages: a singleton format rejects a
 * second copy by identity, and it must do so even when an importer splits the
 * same card ID across several entries (ruleset update §2).
 */
export const deckConstructionSchema = z.strictObject({
  /** Exact number of cards a legal deck must contain. */
  size: z.number().int().min(1).max(250),
  /** No card ID may appear more than once, however the entries are written. */
  singleton: z.boolean().default(false),
  /** Maximum copies of a regular card. Ignored when `singleton` is set. */
  copyLimit: z.number().int().min(1).max(20).default(1),
  /** Maximum copies of a card flagged `unique`. Ignored when `singleton` is set. */
  uniqueCopyLimit: z.number().int().min(1).max(20).default(1),
  /** Maximum colours in a Commander's colour identity. */
  maxCommanderColors: z.number().int().min(1).max(5),
  /** The Commander is chosen separately and is never part of the deck list. */
  commanderOutsideDeck: z.boolean().default(true),
});
export type DeckConstruction = z.infer<typeof deckConstructionSchema>;

/**
 * A play format: which sets are legal, plus how decks are built from them.
 *
 * Selecting content deliberately is the point (readiness spec B4). A format
 * names its sets rather than defaulting to "everything loaded", so the
 * development fixture set cannot leak into a playtest pool by accident.
 */
export const playFormatSchema = z.strictObject({
  schemaVersion: z.number().int().min(1).max(FORMAT_SCHEMA_VERSION),
  formatId: formatIdSchema,
  name: z.string().min(1).max(80),
  description: z.string().min(1).max(400).optional(),
  /** Sets whose cards are legal in this format, in stable declared order. */
  setIds: z.array(setIdSchema).min(1),
  /** Cards excluded despite belonging to an included set. */
  bannedCardIds: z.array(cardIdSchema).default([]),
  deck: deckConstructionSchema,
});
export type PlayFormat = z.infer<typeof playFormatSchema>;
export type PlayFormatInput = z.input<typeof playFormatSchema>;
