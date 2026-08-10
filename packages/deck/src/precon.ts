import {
  bundledFormat,
  DECKABLE_CARD_TYPES,
  formatDatabase,
  isColorIdentityLegal,
  type PreconDefinition,
  type CardDatabase,
} from '@tcg/card-data';
import { error, hasErrors, type Issue } from '@tcg/shared';
import { deckFormatOf, type DeckFormatConfig } from './format.js';
import { DECK_SCHEMA_VERSION, type SavedDeck } from './schema.js';

/**
 * Built-in preconstructed decks.
 *
 * Precons are validated *content*, not UI fixtures (ruleset update §3): they
 * live in `content/precons/`, load through this schema, and are addressable by
 * permanent ID from the deck builder, the server and the simulator alike.
 *
 * A precon definition is immutable. Editing one in the builder produces a new
 * user deck through `preconToDeck`; nothing ever writes back to the source.
 */
export interface PreconValidation {
  readonly legal: boolean;
  readonly issues: readonly Issue[];
}

/**
 * Checks a precon against its own declared format.
 *
 * Deliberately separate from `validateDeck`: a precon is a *list of IDs* and the
 * things that can be wrong with it — a missing card, a Token in the list, a
 * Commander that is not a Commander — are best reported against the precon
 * itself, before it is ever turned into a deck.
 */
export function validatePrecon(precon: PreconDefinition, database: CardDatabase): PreconValidation {
  const issues: Issue[] = [];
  const format = bundledFormat(precon.formatId);

  if (!format) {
    return {
      legal: false,
      issues: [
        error(
          'precon/unknown_format',
          `Precon "${precon.id}" declares format "${precon.formatId}", which does not exist.`,
          { context: { preconId: precon.id, formatId: precon.formatId } },
        ),
      ],
    };
  }

  const commander = database.get(precon.commanderId);
  if (!commander) {
    issues.push(
      error(
        'precon/unknown_commander',
        `Precon "${precon.id}" names Commander "${precon.commanderId}", which is not in the "${precon.formatId}" pool.`,
        { context: { preconId: precon.id, cardId: precon.commanderId } },
      ),
    );
  } else if (commander.type !== 'commander') {
    issues.push(
      error(
        'precon/commander_wrong_type',
        `"${commander.name}" is a ${commander.type}, not a Commander.`,
        { context: { preconId: precon.id, cardId: commander.id } },
      ),
    );
  }

  if (precon.cardIds.length !== format.deck.size) {
    issues.push(
      error(
        'precon/size',
        `Precon "${precon.id}" lists ${precon.cardIds.length} cards; "${precon.formatId}" requires exactly ${format.deck.size}.`,
        {
          context: {
            preconId: precon.id,
            found: precon.cardIds.length,
            required: format.deck.size,
          },
        },
      ),
    );
  }

  const seen = new Set<string>();
  for (const cardId of precon.cardIds) {
    if (seen.has(cardId)) {
      issues.push(
        error(
          'precon/duplicate_card',
          `Precon "${precon.id}" lists "${cardId}" more than once. ${precon.formatId} is singleton.`,
          { context: { preconId: precon.id, cardId } },
        ),
      );
      continue;
    }
    seen.add(cardId);

    const card = database.get(cardId);
    if (!card) {
      issues.push(
        error(
          'precon/unknown_card',
          `Precon "${precon.id}" lists "${cardId}", which is not in the "${precon.formatId}" pool.`,
          { context: { preconId: precon.id, cardId } },
        ),
      );
      continue;
    }

    if (!DECKABLE_CARD_TYPES.includes(card.type) || !card.collectible) {
      issues.push(
        error(
          'precon/not_deckable',
          `Precon "${precon.id}" lists "${card.name}", which is a ${card.type} and cannot go in a deck list.`,
          { context: { preconId: precon.id, cardId, type: card.type } },
        ),
      );
      continue;
    }

    if (commander && !isColorIdentityLegal(card.colorIdentity, commander.colorIdentity)) {
      const offending = card.colorIdentity.filter((c) => !commander.colorIdentity.includes(c));
      issues.push(
        error(
          'precon/color_identity',
          `"${card.name}" is ${offending.join('/')}, outside ${commander.name}'s colour identity.`,
          { context: { preconId: precon.id, cardId, colors: offending } },
        ),
      );
    }
  }

  return { legal: !hasErrors(issues), issues };
}

/**
 * Turns a precon into a fresh, editable saved deck.
 *
 * The precon itself is never mutated — this is what "copy it into an editable
 * deck" means (ruleset update §3). The new deck gets its own ID and timestamps
 * so it is an ordinary user deck from that moment on.
 */
export function preconToDeck(
  precon: PreconDefinition,
  options: { readonly id: string; readonly name?: string; readonly now: string },
): SavedDeck {
  return {
    schemaVersion: DECK_SCHEMA_VERSION,
    id: options.id,
    name: options.name ?? precon.name,
    commanderId: precon.commanderId,
    // Singleton, so every entry is quantity 1 — but built from the format rather
    // than assumed, so a future non-singleton precon still round-trips.
    cards: precon.cardIds.map((cardId) => ({ cardId, quantity: 1 })),
    createdAt: options.now,
    updatedAt: options.now,
  };
}

/** The deck-construction rules a precon is built to. */
export function preconFormat(precon: PreconDefinition): DeckFormatConfig {
  const format = bundledFormat(precon.formatId);
  if (!format)
    throw new Error(`Precon "${precon.id}" declares unknown format "${precon.formatId}".`);
  return deckFormatOf(format);
}

/** The card pool a precon draws from. */
export function preconDatabase(precon: PreconDefinition): CardDatabase {
  return formatDatabase(precon.formatId);
}
