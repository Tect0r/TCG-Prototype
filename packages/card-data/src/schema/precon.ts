import { z } from 'zod';
import { cardIdSchema } from './primitives.js';
import { formatIdSchema } from './format.js';

/**
 * Built-in preconstructed decks.
 *
 * Precons are validated *content*, not UI fixtures (ruleset update §3): they
 * live in `content/precons/`, are compiled into the shipped bundle, and are
 * addressable by permanent ID from the deck builder, the server and the
 * simulator alike.
 *
 * A precon definition is immutable. Editing one in the builder produces a new
 * user deck; nothing ever writes back to the source.
 */
export const PRECON_SCHEMA_VERSION = 1;

/**
 * A precon's permanent ID.
 *
 * Exported so that anything *addressing* a precon — a spectator seat, a
 * `submit_precon` message, a simulator deck source — validates the ID the same
 * way the definition itself does, rather than accepting a shape no precon could
 * ever have.
 */
export const preconIdSchema = z
  .string()
  .min(1)
  .max(60)
  .regex(/^[a-z][a-z0-9_]*$/, 'Precon IDs must be lowercase_snake_case.');

export const preconDefinitionSchema = z.strictObject({
  schemaVersion: z.number().int().min(1).max(PRECON_SCHEMA_VERSION),
  id: preconIdSchema,
  name: z.string().min(1).max(80),
  /** The format whose construction rules this precon is built to. */
  formatId: formatIdSchema,
  /** One line on what the deck is trying to do. Presentation only. */
  strategy: z.string().min(1).max(400),
  commanderId: cardIdSchema,
  /** Exactly `format.deck.size` distinct card IDs. Order is not meaningful. */
  cardIds: z.array(cardIdSchema),
});
export type PreconDefinition = z.infer<typeof preconDefinitionSchema>;
