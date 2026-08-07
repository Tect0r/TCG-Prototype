import { cardIdSchema } from '@tcg/card-data';
import { z } from 'zod';

/**
 * Saved deck schema version. Bump together with a migration in `migrate.ts`
 * whenever the persisted shape changes.
 */
export const DECK_SCHEMA_VERSION = 1;

export const deckEntrySchema = z.strictObject({
  cardId: cardIdSchema,
  quantity: z.number().int().min(1).max(99),
});
export type DeckEntry = z.infer<typeof deckEntrySchema>;

const isoTimestamp = z
  .string()
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Must be an ISO 8601 timestamp.');

/**
 * A saved deck. Cards are referenced by permanent ID only — never by display
 * name — so renaming or localising a card cannot break saved decks.
 */
export const savedDeckSchema = z.strictObject({
  schemaVersion: z.literal(DECK_SCHEMA_VERSION),
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(80),
  /** `null` while the player has not chosen a Commander yet. */
  commanderId: cardIdSchema.nullable(),
  cards: z.array(deckEntrySchema),
  createdAt: isoTimestamp,
  updatedAt: isoTimestamp,
  /** Optional free-text notes; presentation only. */
  notes: z.string().max(2000).optional(),
});

export type SavedDeck = z.infer<typeof savedDeckSchema>;
