import { StrictMode } from 'react';
import { describe, expect, it } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { loadBundledCardData } from '@tcg/card-data';
import { DECK_STORAGE_KEY, MemoryStore, createDeck, addCard, setCommander } from '@tcg/deck';
import { AppProvider, useAppState } from './AppContext.js';
import { App } from '../App.js';

const { database } = loadBundledCardData();

const storedDecks = (store: MemoryStore) =>
  JSON.parse(store.getItem(DECK_STORAGE_KEY) ?? '{"decks":[]}').decks as unknown[];

function DeckCount() {
  const { decks, hydrated } = useAppState();
  return (
    <p data-testid="deck-count">
      {hydrated ? 'ready' : 'loading'}:{decks.length}
    </p>
  );
}

const seededStore = () => {
  const store = new MemoryStore();
  const deck = addCard(
    setCommander(createDeck({ name: 'Saved Deck' }), 'prototype_commander_blue_red'),
    'goblin_scout',
    { amount: 2 },
  );
  store.setItem(DECK_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, decks: [deck] }));
  return store;
};

describe('deck persistence', () => {
  it('loads saved decks on mount', async () => {
    const store = seededStore();
    render(
      <AppProvider database={database} store={store}>
        <DeckCount />
      </AppProvider>,
    );
    expect(await screen.findByText('ready:1')).toBeInTheDocument();
  });

  // Regression: hydration used to be tracked in a ref, which flipped inside the
  // load effect. The persist effect then ran in the same commit with the empty
  // initial state and erased every saved deck on the next reload.
  it('never writes the empty initial state over saved decks', async () => {
    const store = seededStore();
    const before = storedDecks(store);

    render(
      <StrictMode>
        <AppProvider database={database} store={store}>
          <DeckCount />
        </AppProvider>
      </StrictMode>,
    );
    await screen.findByText('ready:1');

    expect(storedDecks(store)).toEqual(before);
  });

  it('survives a full unmount and remount, the way a browser refresh does', async () => {
    const store = new MemoryStore();
    const first = render(
      <StrictMode>
        <AppProvider database={database} store={store}>
          <App />
        </AppProvider>
      </StrictMode>,
    );

    await act(async () => {
      await userEvent.click(screen.getByRole('button', { name: 'New deck' }));
    });
    expect(storedDecks(store)).toHaveLength(1);

    first.unmount();

    render(
      <StrictMode>
        <AppProvider database={database} store={store}>
          <DeckCount />
        </AppProvider>
      </StrictMode>,
    );
    expect(await screen.findByText('ready:1')).toBeInTheDocument();
    expect(storedDecks(store)).toHaveLength(1);
  });

  it('surfaces storage problems without dropping readable decks', async () => {
    const store = new MemoryStore();
    store.setItem(DECK_STORAGE_KEY, 'not json');

    render(
      <AppProvider database={database} store={store}>
        <App />
      </AppProvider>,
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Some saved decks could not be read',
    );
    // The unreadable payload is parked, not overwritten.
    expect(store.getItem(`${DECK_STORAGE_KEY}:unreadable`)).toBe('not json');
  });
});
