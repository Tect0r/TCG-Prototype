import { useMemo, useState } from 'react';
import { isColorIdentityLegal, type CardDefinition, type ColorId } from '@tcg/card-data';
import {
  addCard,
  copyLimitFor,
  countOf,
  DEFAULT_DECK_FORMAT,
  deckSize,
  removeCard,
  type SavedDeck,
} from '@tcg/deck';
import { CardGrid, type CardGridEntry } from './components/CardGrid.js';
import { DeckPanel } from './components/DeckPanel.js';
import { DeckToolbar } from './components/DeckToolbar.js';
import { FilterPanel } from './components/FilterPanel.js';
import { NoticeBar } from './components/NoticeBar.js';
import { emptyFilters, toCardQuery, type FilterState } from './state/filters.js';
import { useActiveDeck, useAppActions, useCardDatabase } from './state/AppContext.js';

/** Why the "add" button is unavailable, or `null` when the card can be added. */
function blockedReason(
  card: CardDefinition,
  copies: number,
  deck: SavedDeck,
  commanderColors: readonly ColorId[] | null,
): string | null {
  if (commanderColors === null) return 'Choose a Commander first.';
  if (!isColorIdentityLegal(card.colorIdentity, commanderColors)) {
    return "Outside your Commander's colour identity.";
  }
  const limit = copyLimitFor(card);
  if (copies >= limit) return `Limit ${limit} cop${limit === 1 ? 'y' : 'ies'} per deck.`;
  if (deckSize(deck) >= DEFAULT_DECK_FORMAT.deckSize) {
    return `Deck is already at ${DEFAULT_DECK_FORMAT.deckSize} cards.`;
  }
  return null;
}

export function App() {
  const database = useCardDatabase();
  const deck = useActiveDeck();
  const actions = useAppActions();
  const [filters, setFilters] = useState<FilterState>(emptyFilters);

  const commanderColors = useMemo<readonly ColorId[] | null>(() => {
    if (!deck || deck.commanderId === null) return null;
    return database.get(deck.commanderId)?.colorIdentity ?? null;
  }, [deck, database]);

  const pool = useMemo(() => database.deckable(), [database]);
  const availableTags = useMemo(() => database.allTags(), [database]);

  const entries = useMemo<CardGridEntry[]>(() => {
    if (!deck) return [];
    const query = toCardQuery(filters, commanderColors);
    return database.search(query, pool).map((card) => {
      const copies = countOf(deck, card.id);
      return { card, copies, blockedReason: blockedReason(card, copies, deck, commanderColors) };
    });
  }, [database, pool, filters, commanderColors, deck]);

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__title">
          <h1>Deck Builder</h1>
          <p className="app__subtitle">Card game prototype · {database.size} cards loaded</p>
        </div>
        <DeckToolbar deck={deck} />
      </header>

      <NoticeBar />

      {deck ? (
        <main className="app__body">
          <FilterPanel
            filters={filters}
            onChange={setFilters}
            availableTags={availableTags}
            maxCost={database.maxCost()}
            hasCommander={commanderColors !== null}
            resultCount={entries.length}
          />

          <section className="app__grid" aria-label="Card browser">
            <CardGrid
              entries={entries}
              emptyMessage="No cards match these filters."
              onAdd={(card) =>
                actions.updateDeck(addCard(deck, card.id, { limit: copyLimitFor(card) }))
              }
              onRemove={(card) => actions.updateDeck(removeCard(deck, card.id))}
            />
          </section>

          <DeckPanel deck={deck} database={database} onChange={actions.updateDeck} />
        </main>
      ) : (
        <main className="app__empty">
          <h2>No decks yet</h2>
          <p>Create a deck to start building, or import one you exported earlier.</p>
        </main>
      )}
    </div>
  );
}
