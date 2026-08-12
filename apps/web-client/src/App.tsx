import { useMemo, useState } from 'react';
import { isColorIdentityLegal, type CardDefinition, type ColorId } from '@tcg/card-data';
import {
  addCard,
  copyLimitFor,
  countOf,
  deckSize,
  removeCard,
  type DeckFormatConfig,
  type SavedDeck,
} from '@tcg/deck';
import { CardGrid, type CardGridEntry } from './components/CardGrid.js';
import { DeckPanel } from './components/DeckPanel.js';
import { DeckToolbar } from './components/DeckToolbar.js';
import { FilterPanel } from './components/FilterPanel.js';
import { NoticeBar } from './components/NoticeBar.js';
import { MatchScreen } from './components/match/MatchScreen.js';
import { SpectatorScreen } from './components/spectator/SpectatorScreen.js';
import { emptyFilters, toCardQuery, type FilterState } from './state/filters.js';
import {
  useActiveDeck,
  useAppActions,
  useCardDatabase,
  useDeckFormat,
} from './state/AppContext.js';

/** Why the "add" button is unavailable, or `null` when the card can be added. */
function blockedReason(
  card: CardDefinition,
  copies: number,
  deck: SavedDeck,
  commanderColors: readonly ColorId[] | null,
  format: DeckFormatConfig,
): string | null {
  if (commanderColors === null) return 'Choose a Commander first.';
  if (!isColorIdentityLegal(card.colorIdentity, commanderColors)) {
    return "Outside your Commander's colour identity.";
  }
  if (!card.implemented) return `Not playable yet: ${card.unsupportedReason ?? 'unsupported'}`;
  const limit = copyLimitFor(card, format);
  if (copies >= limit) {
    return format.singleton
      ? 'Singleton format: one copy of each card.'
      : `Limit ${limit} cop${limit === 1 ? 'y' : 'ies'} per deck.`;
  }
  if (deckSize(deck) >= format.deckSize) {
    return `Deck is already at ${format.deckSize} cards.`;
  }
  return null;
}

/**
 * Top-level screens. The deck builder is unchanged; matches live beside it, and
 * the AI spectator beside those — it plays its own match locally and never
 * touches a saved deck or a lobby.
 */
type Mode = 'build' | 'play' | 'spectate';

const MODE_TITLES: Readonly<Record<Mode, string>> = {
  build: 'Deck Builder',
  play: 'Match',
  spectate: 'AI Spectator',
};

export function App() {
  const database = useCardDatabase();
  const format = useDeckFormat();
  const deck = useActiveDeck();
  const actions = useAppActions();
  const [filters, setFilters] = useState<FilterState>(emptyFilters);
  const [mode, setMode] = useState<Mode>('build');

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
      return {
        card,
        copies,
        blockedReason: blockedReason(card, copies, deck, commanderColors, format),
      };
    });
  }, [database, pool, filters, commanderColors, deck, format]);

  return (
    <div className="app">
      <header className="app__header">
        <div className="app__title">
          <h1>{MODE_TITLES[mode]}</h1>
          <p className="app__subtitle">Card game prototype · {database.size} cards loaded</p>
        </div>
        <nav className="app__modes" aria-label="Screen">
          <button
            type="button"
            aria-pressed={mode === 'build'}
            className={mode === 'build' ? 'is-active' : ''}
            onClick={() => setMode('build')}
          >
            Deck Builder
          </button>
          <button
            type="button"
            aria-pressed={mode === 'play'}
            className={mode === 'play' ? 'is-active' : ''}
            onClick={() => setMode('play')}
          >
            Play
          </button>
          <button
            type="button"
            aria-pressed={mode === 'spectate'}
            className={mode === 'spectate' ? 'is-active' : ''}
            onClick={() => setMode('spectate')}
          >
            AI Spectator
          </button>
        </nav>
        {mode === 'build' && <DeckToolbar deck={deck} />}
      </header>

      <NoticeBar />

      {mode === 'spectate' ? (
        <main className="app__match">
          <SpectatorScreen />
        </main>
      ) : mode === 'play' ? (
        <main className="app__match">
          <MatchScreen />
        </main>
      ) : deck ? (
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
                actions.updateDeck(addCard(deck, card.id, { limit: copyLimitFor(card, format) }))
              }
              onRemove={(card) => actions.updateDeck(removeCard(deck, card.id))}
            />
          </section>

          <DeckPanel deck={deck} database={database} onChange={actions.updateDeck} />
        </main>
      ) : (
        <main className="app__empty">
          <h2>No decks yet</h2>
          <p>
            Create a deck to start building, copy a built-in precon from “Precons”, or import one
            you exported earlier.
          </p>
        </main>
      )}
    </div>
  );
}
