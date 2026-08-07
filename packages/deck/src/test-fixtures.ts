import { loadBundledCardData, type CardDatabase } from '@tcg/card-data';
import type { IdSources } from '@tcg/shared';
import { DEFAULT_DECK_FORMAT } from './format.js';
import { addCard, createDeck } from './operations.js';
import type { SavedDeck } from './schema.js';

export const database: CardDatabase = loadBundledCardData().database;

export const fixedClock = () => '2026-08-07T12:00:00.000Z';

let counter = 0;
export const fixedIdSources: IdSources = {
  now: () => 1_770_000_000_000,
  random: () => {
    counter = (counter + 1) % 1000;
    return counter / 1000;
  },
};

export function deckWith(
  entries: ReadonlyArray<readonly [string, number]>,
  commanderId: string | null = 'prototype_commander_blue_red',
): SavedDeck {
  let deck = createDeck({
    name: 'Test Deck',
    commanderId,
    clock: fixedClock,
    idSources: fixedIdSources,
  });
  for (const [cardId, quantity] of entries) {
    deck = addCard(deck, cardId, { amount: quantity, clock: fixedClock });
  }
  return deck;
}

/**
 * A deck that is legal under `DEFAULT_DECK_FORMAT`: exactly 30 cards, all
 * inside Arc Tactician's blue/red identity, respecting copy limits.
 */
export function legalDeck(): SavedDeck {
  const entries: Array<readonly [string, number]> = [
    ['goblin_scout', 2],
    ['scorch', 2],
    ['prototype_scout', 2],
    ['prototype_guard', 2],
    ['powder_keg_runner', 2],
    ['desperate_insight', 2],
    ['warband_horn', 2],
    ['tidepool_apprentice', 2],
    ['mistveil_stalker', 2],
    ['stormforge_adept', 2],
    ['arcane_recall', 2],
    ['trench_guard', 2],
    ['unstable_construct', 2],
    ['tide_binder', 2],
    ['pyre_champion', 2],
  ];
  const total = entries.reduce((sum, [, quantity]) => sum + quantity, 0);
  if (total !== DEFAULT_DECK_FORMAT.deckSize) {
    throw new Error(`Fixture deck has ${total} cards, expected ${DEFAULT_DECK_FORMAT.deckSize}`);
  }
  return deckWith(entries);
}
