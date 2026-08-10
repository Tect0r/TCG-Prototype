import {
  DECKABLE_CARD_TYPES,
  isColorIdentityLegal,
  type CardDatabase,
  type CardDefinition,
  type CardId,
  type CardType,
  type ColorId,
} from '@tcg/card-data';
import { error, hasErrors, warning, type Issue } from '@tcg/shared';
import { DEFAULT_DECK_FORMAT, type DeckFormatConfig } from './format.js';
import type { SavedDeck } from './schema.js';

export interface DeckStats {
  readonly totalCards: number;
  readonly distinctCards: number;
  /** Union of the colour identities of the Commander and every resolved card. */
  readonly colorIdentity: readonly ColorId[];
  /** Card counts by energy cost. Costless cards are omitted. */
  readonly costCurve: Readonly<Record<number, number>>;
  readonly typeCounts: Readonly<Partial<Record<CardType, number>>>;
  /** Card IDs in the deck that no longer exist in the database. */
  readonly unresolvedCardIds: readonly CardId[];
}

export interface DeckValidationReport {
  /** True when there are no errors. Warnings do not block play. */
  readonly legal: boolean;
  readonly issues: readonly Issue[];
  readonly stats: DeckStats;
}

const COLOR_ORDER: readonly ColorId[] = ['white', 'blue', 'black', 'red', 'green'];
const sortColors = (colors: Iterable<ColorId>): ColorId[] =>
  [...new Set(colors)].sort((a, b) => COLOR_ORDER.indexOf(a) - COLOR_ORDER.indexOf(b));

/** Colours the Commander legally covers; empty when no Commander is chosen. */
export function commanderColorIdentity(
  deck: SavedDeck,
  database: CardDatabase,
): readonly ColorId[] {
  if (deck.commanderId === null) return [];
  return database.get(deck.commanderId)?.colorIdentity ?? [];
}

export function deckStats(deck: SavedDeck, database: CardDatabase): DeckStats {
  const costCurve: Record<number, number> = {};
  const typeCounts: Partial<Record<CardType, number>> = {};
  const colors = new Set<ColorId>();
  const unresolved: CardId[] = [];
  let total = 0;

  const commander = deck.commanderId === null ? undefined : database.get(deck.commanderId);
  for (const color of commander?.colorIdentity ?? []) colors.add(color);

  for (const entry of deck.cards) {
    total += entry.quantity;
    const card = database.get(entry.cardId);
    if (!card) {
      unresolved.push(entry.cardId);
      continue;
    }
    for (const color of card.colorIdentity) colors.add(color);
    typeCounts[card.type] = (typeCounts[card.type] ?? 0) + entry.quantity;
    if (card.cost !== null) {
      costCurve[card.cost] = (costCurve[card.cost] ?? 0) + entry.quantity;
    }
  }

  return {
    totalCards: total,
    distinctCards: deck.cards.length,
    colorIdentity: sortColors(colors),
    costCurve,
    typeCounts,
    unresolvedCardIds: unresolved,
  };
}

function validateCommander(
  deck: SavedDeck,
  database: CardDatabase,
  format: DeckFormatConfig,
  issues: Issue[],
): CardDefinition | undefined {
  if (deck.commanderId === null) {
    issues.push(
      error('deck/commander_missing', 'Choose exactly one Commander for this deck.', {
        path: 'commanderId',
      }),
    );
    return undefined;
  }

  const commander = database.get(deck.commanderId);
  if (!commander) {
    issues.push(
      error(
        'deck/commander_unresolved',
        `Commander "${deck.commanderId}" no longer exists in the card database.`,
        { path: 'commanderId', context: { cardId: deck.commanderId } },
      ),
    );
    return undefined;
  }

  if (commander.type !== 'commander') {
    issues.push(
      error(
        'deck/commander_wrong_type',
        `"${commander.name}" is a ${commander.type} and cannot be used as a Commander.`,
        { path: 'commanderId', context: { cardId: commander.id, type: commander.type } },
      ),
    );
    return commander;
  }

  if (!commander.collectible) {
    issues.push(
      error(
        'deck/commander_not_collectible',
        `"${commander.name}" cannot be chosen in the deck builder.`,
        {
          path: 'commanderId',
          context: { cardId: commander.id },
        },
      ),
    );
  }

  if (commander.colorIdentity.length > format.maxCommanderColors) {
    issues.push(
      error(
        'deck/commander_too_many_colors',
        `"${commander.name}" has ${commander.colorIdentity.length} colours, but this format allows at most ${format.maxCommanderColors}.`,
        {
          path: 'commanderId',
          context: { cardId: commander.id, colors: commander.colorIdentity },
        },
      ),
    );
  }

  return commander;
}

function validateEntries(
  deck: SavedDeck,
  database: CardDatabase,
  format: DeckFormatConfig,
  commander: CardDefinition | undefined,
  issues: Issue[],
): void {
  const seen = new Set<CardId>();
  const commanderColors = commander?.colorIdentity ?? [];

  deck.cards.forEach((entry, index) => {
    const path = `cards[${index}]`;

    if (seen.has(entry.cardId)) {
      issues.push(
        error(
          'deck/duplicate_entry',
          `"${entry.cardId}" appears more than once in the deck list. Combine the entries into a single quantity.`,
          { path, context: { cardId: entry.cardId } },
        ),
      );
      return;
    }
    seen.add(entry.cardId);

    const card = database.get(entry.cardId);
    if (!card) {
      issues.push(
        error(
          'deck/unknown_card',
          `Card "${entry.cardId}" no longer exists in the card database. Remove it or restore the card data.`,
          { path, context: { cardId: entry.cardId } },
        ),
      );
      return;
    }

    if (!card.collectible || !DECKABLE_CARD_TYPES.includes(card.type)) {
      issues.push(
        error(
          'deck/card_not_deckable',
          `"${card.name}" is a ${card.type} and cannot be placed in a deck list.`,
          { path, context: { cardId: card.id, type: card.type } },
        ),
      );
      return;
    }

    // A card whose printed behaviour is not yet expressed in structured data
    // cannot be played faithfully, so a deck containing one is not legal. The
    // card is deliberately still in the database and still shows its real
    // identity — see `implemented` in the card schema, ruleset update §1.
    if (!card.implemented) {
      issues.push(
        error(
          'deck/card_not_implemented',
          `"${card.name}" is not playable yet: ${card.unsupportedReason}`,
          { path, context: { cardId: card.id } },
        ),
      );
    }

    if (commander && !isColorIdentityLegal(card.colorIdentity, commanderColors)) {
      const offending = card.colorIdentity.filter((c) => !commanderColors.includes(c));
      issues.push(
        error(
          'deck/color_identity',
          `"${card.name}" is ${offending.join('/')}, which is outside ${commander.name}'s colour identity.`,
          { path, context: { cardId: card.id, colors: offending } },
        ),
      );
    }

    if (format.singleton) {
      if (entry.quantity > 1) {
        issues.push(
          error(
            'deck/singleton',
            `"${card.name}" appears ${entry.quantity} times. This is a singleton format: one copy of each card.`,
            { path, context: { cardId: card.id, quantity: entry.quantity } },
          ),
        );
      }
      return;
    }

    const limit = card.unique ? format.uniqueCopyLimit : format.copyLimit;
    if (entry.quantity > limit) {
      issues.push(
        error(
          'deck/copy_limit',
          `"${card.name}" appears ${entry.quantity} times, but ${card.unique ? 'unique cards are' : 'regular cards are'} limited to ${limit} ${limit === 1 ? 'copy' : 'copies'}.`,
          { path, context: { cardId: card.id, quantity: entry.quantity, limit } },
        ),
      );
    }
  });
}

function addWarnings(
  deck: SavedDeck,
  database: CardDatabase,
  stats: DeckStats,
  commander: CardDefinition | undefined,
  issues: Issue[],
): void {
  const resolved = deck.cards
    .map((entry) => ({ entry, card: database.get(entry.cardId) }))
    .filter(
      (pair): pair is { entry: (typeof deck.cards)[number]; card: CardDefinition } =>
        pair.card !== undefined,
    );

  if (stats.totalCards > 0 && (stats.typeCounts.unit ?? 0) === 0) {
    issues.push(
      warning(
        'deck/no_units',
        'This deck has no units, so it cannot attack or block. That is legal, but probably unintended.',
      ),
    );
  }

  const expensive = resolved
    .filter(({ card }) => card.cost !== null && card.cost >= 6)
    .reduce((sum, { entry }) => sum + entry.quantity, 0);
  if (stats.totalCards > 0 && expensive > stats.totalCards / 4) {
    issues.push(
      warning(
        'deck/top_heavy',
        `${expensive} of ${stats.totalCards} cards cost 6 or more energy. The deck may be slow to get going.`,
        { context: { expensive, totalCards: stats.totalCards } },
      ),
    );
  }

  if (commander) {
    const used = new Set(resolved.flatMap(({ card }) => card.colorIdentity));
    const unused = commander.colorIdentity.filter((color) => !used.has(color));
    if (stats.totalCards > 0 && unused.length > 0) {
      issues.push(
        warning(
          'deck/unused_commander_color',
          `No card in this deck uses ${unused.join('/')}, one of ${commander.name}'s colours.`,
          { context: { colors: unused } },
        ),
      );
    }
  }
}

/**
 * Full deck legality check. Returns structured errors and warnings suitable for
 * live display in the builder, and later for server-side validation.
 */
export function validateDeck(
  deck: SavedDeck,
  database: CardDatabase,
  format: DeckFormatConfig = DEFAULT_DECK_FORMAT,
): DeckValidationReport {
  const issues: Issue[] = [];
  const commander = validateCommander(deck, database, format, issues);
  validateEntries(deck, database, format, commander, issues);

  const stats = deckStats(deck, database);

  if (stats.totalCards !== format.deckSize) {
    const delta = format.deckSize - stats.totalCards;
    issues.push(
      error(
        'deck/size',
        delta > 0
          ? `Deck has ${stats.totalCards} of ${format.deckSize} cards — add ${delta} more.`
          : `Deck has ${stats.totalCards} cards, ${-delta} over the ${format.deckSize}-card limit.`,
        { path: 'cards', context: { totalCards: stats.totalCards, required: format.deckSize } },
      ),
    );
  }

  addWarnings(deck, database, stats, commander, issues);

  return { legal: !hasErrors(issues), issues, stats };
}
