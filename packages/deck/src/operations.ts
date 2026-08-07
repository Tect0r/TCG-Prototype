import { generateId, type IdSources } from '@tcg/shared';
import type { CardDefinition, CardId } from '@tcg/card-data';
import { DEFAULT_DECK_FORMAT, type DeckFormatConfig } from './format.js';
import { DECK_SCHEMA_VERSION, type SavedDeck } from './schema.js';

/**
 * Pure deck edits. Every function returns a new deck; nothing mutates in place,
 * which keeps undo, React state and future server-side reuse straightforward.
 */

/** Returns an ISO 8601 timestamp. Injected so tests stay deterministic. */
export type Clock = () => string;

const systemClock: Clock = () => new Date().toISOString();

export interface CreateDeckOptions {
  readonly name: string;
  readonly commanderId?: CardId | null;
  readonly clock?: Clock;
  readonly idSources?: IdSources;
}

export function createDeck(options: CreateDeckOptions): SavedDeck {
  const clock = options.clock ?? systemClock;
  const timestamp = clock();
  return {
    schemaVersion: DECK_SCHEMA_VERSION,
    id: generateId('deck', options.idSources),
    name: options.name,
    commanderId: options.commanderId ?? null,
    cards: [],
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

const touch = (deck: SavedDeck, clock: Clock): SavedDeck => ({ ...deck, updatedAt: clock() });

export function renameDeck(deck: SavedDeck, name: string, clock: Clock = systemClock): SavedDeck {
  return touch({ ...deck, name }, clock);
}

export function setDeckNotes(
  deck: SavedDeck,
  notes: string,
  clock: Clock = systemClock,
): SavedDeck {
  const trimmed = notes.trim();
  const { notes: _dropped, ...rest } = deck;
  return touch(trimmed ? { ...rest, notes: trimmed } : rest, clock);
}

/**
 * Copies a deck under a new identity. Creation time resets: the copy is a new
 * deck, and its original may be edited or deleted independently.
 */
export function duplicateDeck(
  deck: SavedDeck,
  options: { name?: string; clock?: Clock; idSources?: IdSources } = {},
): SavedDeck {
  const clock = options.clock ?? systemClock;
  const timestamp = clock();
  return {
    ...deck,
    id: generateId('deck', options.idSources),
    name: options.name ?? `${deck.name} (copy)`,
    cards: deck.cards.map((entry) => ({ ...entry })),
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function setCommander(
  deck: SavedDeck,
  commanderId: CardId | null,
  clock: Clock = systemClock,
): SavedDeck {
  return touch({ ...deck, commanderId }, clock);
}

export function countOf(deck: SavedDeck, cardId: CardId): number {
  return deck.cards.find((entry) => entry.cardId === cardId)?.quantity ?? 0;
}

/** Copy limit for a card under the given format. */
export function copyLimitFor(
  card: CardDefinition,
  format: DeckFormatConfig = DEFAULT_DECK_FORMAT,
): number {
  return card.unique ? format.uniqueCopyLimit : format.copyLimit;
}

/**
 * Sets an exact quantity, clamped to `[0, limit]`. A quantity of 0 removes the
 * entry entirely so exported deck lists never carry empty rows.
 */
export function setCardQuantity(
  deck: SavedDeck,
  cardId: CardId,
  quantity: number,
  options: { limit?: number; clock?: Clock } = {},
): SavedDeck {
  const clock = options.clock ?? systemClock;
  const clamped = Math.max(
    0,
    Math.min(Math.floor(quantity), options.limit ?? Number.MAX_SAFE_INTEGER),
  );
  const existing = countOf(deck, cardId);
  if (clamped === existing) return deck;

  if (clamped === 0) {
    return touch({ ...deck, cards: deck.cards.filter((entry) => entry.cardId !== cardId) }, clock);
  }
  if (existing === 0) {
    return touch({ ...deck, cards: [...deck.cards, { cardId, quantity: clamped }] }, clock);
  }
  return touch(
    {
      ...deck,
      cards: deck.cards.map((entry) =>
        entry.cardId === cardId ? { ...entry, quantity: clamped } : entry,
      ),
    },
    clock,
  );
}

export function addCard(
  deck: SavedDeck,
  cardId: CardId,
  options: { amount?: number; limit?: number; clock?: Clock } = {},
): SavedDeck {
  const { amount = 1, ...rest } = options;
  return setCardQuantity(deck, cardId, countOf(deck, cardId) + amount, rest);
}

export function removeCard(
  deck: SavedDeck,
  cardId: CardId,
  options: { amount?: number; clock?: Clock } = {},
): SavedDeck {
  const { amount = 1, ...rest } = options;
  return setCardQuantity(deck, cardId, countOf(deck, cardId) - amount, rest);
}

/** Drops every entry whose card is no longer in the database. */
export function removeUnresolvedCards(
  deck: SavedDeck,
  unresolvedIds: readonly CardId[],
  clock: Clock = systemClock,
): SavedDeck {
  if (unresolvedIds.length === 0) return deck;
  const drop = new Set(unresolvedIds);
  return touch({ ...deck, cards: deck.cards.filter((entry) => !drop.has(entry.cardId)) }, clock);
}

/** Total cards in the list, counting copies. */
export function deckSize(deck: SavedDeck): number {
  return deck.cards.reduce((sum, entry) => sum + entry.quantity, 0);
}
