import { loadBundledCardData, type CardDatabase } from '@tcg/card-data';
import type { IdSources } from '@tcg/shared';
import { DEVELOPMENT_DECK_FORMAT } from './format.js';
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
 * A deck that is legal under `DEVELOPMENT_DECK_FORMAT`: exactly 30 cards, all
 * inside Arc Tactician's blue/red identity, respecting copy limits.
 *
 * Deliberately pinned to the development format rather than the active one.
 * These fixtures exist to exercise deck operations, persistence and migration,
 * and `prototype_core` cannot build a legal 40-card singleton deck for this
 * Commander anyway — there are not enough legal blue/red cards in it.
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
  if (total !== DEVELOPMENT_DECK_FORMAT.deckSize) {
    throw new Error(
      `Fixture deck has ${total} cards, expected ${DEVELOPMENT_DECK_FORMAT.deckSize}`,
    );
  }
  return deckWith(entries);
}
