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
import { validateDeck } from './validate.js';

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

/**
 * Everything standing between a precon and a match, in one report.
 *
 * `validatePrecon` answers "is this list well-formed", which is not the same
 * question as "can it be played here": a precon can be a perfectly good list of
 * IDs and still be unusable because it belongs to another format, or because
 * one of its cards is not finished yet (`deck/card_not_implemented`). Both
 * answers come from the layers that already own them — the format check here,
 * the definition check in `validatePrecon`, the playability check in
 * `validateDeck` against the copy — so a precon can never be presented as
 * playable by a rule the deck builder and the match server do not share.
 *
 * The checks are ordered and stop at the first failing layer. A precon built to
 * another format would otherwise report forty cards missing from the pool,
 * which is true and useless.
 */
export function reviewPrecon(
  precon: PreconDefinition,
  database: CardDatabase,
  format: DeckFormatConfig,
): PreconValidation {
  if (precon.formatId !== format.formatId) {
    return {
      legal: false,
      issues: [
        error(
          'precon/format_mismatch',
          `Precon "${precon.name}" is built for "${precon.formatId}" and cannot be used in "${format.formatId}".`,
          { context: { preconId: precon.id, formatId: precon.formatId, active: format.formatId } },
        ),
      ],
    };
  }

  const definition = validatePrecon(precon, database);
  if (!definition.legal) return definition;

  // Timestamps are irrelevant to validation; the copy exists only to be checked.
  const deck = preconToDeck(precon, { id: precon.id, now: '1970-01-01T00:00:00.000Z' });
  const report = validateDeck(deck, database, format);
  return {
    legal: report.legal,
    issues: [...definition.issues, ...report.issues],
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
