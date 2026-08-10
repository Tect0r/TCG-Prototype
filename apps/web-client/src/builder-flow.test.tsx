import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatDatabase } from '@tcg/card-data';
import {
  DECK_STORAGE_KEY,
  MemoryStore,
  exportDeckToJson,
  createDeck,
  setCommander,
  addCard,
} from '@tcg/deck';
import { App } from './App.js';
import { DEVELOPMENT_DECK_FORMAT } from '@tcg/deck';
import { AppProvider } from './state/AppContext.js';

const database = formatDatabase('development');

function renderApp() {
  const store = new MemoryStore();
  const user = userEvent.setup();
  render(
    <AppProvider database={database} deckFormat={DEVELOPMENT_DECK_FORMAT} store={store}>
      <App />
    </AppProvider>,
  );
  return { store, user };
}

const storedDecks = (store: MemoryStore) =>
  JSON.parse(store.getItem(DECK_STORAGE_KEY) ?? '{"decks":[]}').decks as Array<{ name: string }>;

const deckPanel = () => screen.getByRole('region', { name: 'Current deck' });
const browser = () => within(screen.getByRole('region', { name: 'Card browser' }));

async function newDeckWithCommander(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'New deck' }));
  await user.selectOptions(screen.getByLabelText('Commander'), 'prototype_commander_blue_red');
}

describe('deck builder flow', () => {
  it('walks from an empty state to a validated deck list', async () => {
    const { user } = renderApp();

    expect(await screen.findByRole('heading', { name: 'No decks yet' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'New deck' }));

    // Nothing can be added before a Commander is chosen.
    expect(within(deckPanel()).getByText(/Choose exactly one Commander/)).toBeInTheDocument();
    expect(browser().getAllByText('Choose a Commander first.').length).toBeGreaterThan(0);

    await user.selectOptions(screen.getByLabelText('Commander'), 'prototype_commander_blue_red');
    expect(within(deckPanel()).queryByText(/Choose exactly one Commander/)).not.toBeInTheDocument();

    await user.click(browser().getByRole('button', { name: 'Add one Goblin Scout' }));
    await user.click(browser().getByRole('button', { name: 'Add one Goblin Scout' }));

    expect(within(deckPanel()).getByText('2×')).toBeInTheDocument();
    expect(within(deckPanel()).getByTestId('deck-size')).toHaveTextContent('2 / 30 cards');
    expect(within(deckPanel()).getByText(/add 28 more/)).toBeInTheDocument();
  });

  it('stops at the copy limit and explains why', async () => {
    const { user } = renderApp();
    await newDeckWithCommander(user);

    const addScout = () => browser().getByRole('button', { name: 'Add one Goblin Scout' });
    await user.click(addScout());
    await user.click(addScout());

    expect(addScout()).toBeDisabled();
    expect(browser().getByText('Limit 2 copies per deck.')).toBeInTheDocument();
    // The deck-list stepper agrees with the grid.
    expect(
      within(deckPanel()).getByRole('button', { name: 'Increase copies of Goblin Scout' }),
    ).toBeDisabled();
  });

  it('allows only a single copy of a unique card', async () => {
    const { user } = renderApp();
    await newDeckWithCommander(user);

    await user.click(browser().getByRole('button', { name: 'Add one Overload Conduit' }));
    expect(browser().getByRole('button', { name: 'Add one Overload Conduit' })).toBeDisabled();
    expect(browser().getByText('Limit 1 copy per deck.')).toBeInTheDocument();
  });

  it('hides cards outside the Commander colour identity, and can show them blocked', async () => {
    const { user } = renderApp();
    await newDeckWithCommander(user);

    expect(browser().queryByRole('heading', { name: 'Bramble Titan' })).not.toBeInTheDocument();

    await user.click(screen.getByLabelText('Only cards legal for my Commander'));
    expect(browser().getByRole('heading', { name: 'Bramble Titan' })).toBeInTheDocument();
    expect(browser().getByRole('button', { name: 'Add one Bramble Titan' })).toBeDisabled();
    expect(
      browser().getAllByText("Outside your Commander's colour identity.").length,
    ).toBeGreaterThan(0);
  });

  it('filters the browse grid by search text', async () => {
    const { user } = renderApp();
    await newDeckWithCommander(user);

    await user.type(screen.getByLabelText('Search'), 'scorch');
    expect(browser().getByRole('heading', { name: 'Scorch' })).toBeInTheDocument();
    expect(browser().queryByRole('heading', { name: 'Goblin Scout' })).not.toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('1 card');
  });

  it('searches rules text as well as names', async () => {
    const { user } = renderApp();
    await newDeckWithCommander(user);

    await user.type(screen.getByLabelText('Search'), 'draw a card');
    const headings = browser()
      .getAllByRole('heading')
      .map((h) => h.textContent);
    expect(headings).toContain('Tidepool Apprentice');
    expect(headings).not.toContain('Goblin Scout');
  });

  it('renames, duplicates and deletes decks', async () => {
    const { store, user } = renderApp();
    await user.click(screen.getByRole('button', { name: 'New deck' }));

    await user.click(screen.getByRole('button', { name: 'Rename' }));
    await user.clear(screen.getByLabelText('Deck name'));
    await user.type(screen.getByLabelText('Deck name'), 'Burn Test');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(storedDecks(store).map((d) => d.name)).toEqual(['Burn Test']);

    await user.click(screen.getByRole('button', { name: 'Duplicate' }));
    expect(
      storedDecks(store)
        .map((d) => d.name)
        .sort(),
    ).toEqual(['Burn Test', 'Burn Test (copy)']);
  });

  it('reports a bad import without touching saved decks', async () => {
    const { store, user } = renderApp();
    await user.click(screen.getByRole('button', { name: 'New deck' }));
    const before = storedDecks(store);

    await user.upload(
      screen.getByLabelText('Import decks from a JSON file'),
      new File(['{ this is not json'], 'broken.json', { type: 'application/json' }),
    );

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Import failed. Your saved decks were not changed.',
    );
    expect(screen.getByText(/not valid JSON/)).toBeInTheDocument();
    expect(storedDecks(store)).toEqual(before);
  });

  it('refuses a deck from a newer build and says why', async () => {
    const { user } = renderApp();
    await user.upload(
      screen.getByLabelText('Import decks from a JSON file'),
      new File([JSON.stringify({ schemaVersion: 99, id: 'x' })], 'future.json', {
        type: 'application/json',
      }),
    );

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/saved by a newer version of the app/)).toBeInTheDocument();
  });

  it('imports a valid deck and disambiguates a name collision', async () => {
    const existing = addCard(
      setCommander(createDeck({ name: 'Shared Name' }), 'prototype_commander_red'),
      'goblin_scout',
      { amount: 2 },
    );
    const store = new MemoryStore();
    store.setItem(DECK_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, decks: [existing] }));

    const user = userEvent.setup();
    render(
      <AppProvider database={database} deckFormat={DEVELOPMENT_DECK_FORMAT} store={store}>
        <App />
      </AppProvider>,
    );
    await screen.findByRole('region', { name: 'Current deck' });

    // Importing the very same file must not overwrite the deck already saved.
    await user.upload(
      screen.getByLabelText('Import decks from a JSON file'),
      new File([exportDeckToJson(existing)], 'deck.json', { type: 'application/json' }),
    );

    expect(await screen.findByText('Imported 1 deck.')).toBeInTheDocument();
    const names = storedDecks(store).map((d) => d.name);
    expect(names).toHaveLength(2);
    expect(names).toContain('Shared Name');
    expect(names).toContain('Shared Name (imported)');
  });

  it('offers to clear card IDs that no longer exist', async () => {
    const store = new MemoryStore();
    const stale = {
      ...setCommander(createDeck({ name: 'Stale Deck' }), 'prototype_commander_red'),
      cards: [{ cardId: 'deleted_card', quantity: 2 }],
    };
    store.setItem(DECK_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, decks: [stale] }));

    const user = userEvent.setup();
    render(
      <AppProvider database={database} deckFormat={DEVELOPMENT_DECK_FORMAT} store={store}>
        <App />
      </AppProvider>,
    );

    const panel = await screen.findByRole('region', { name: 'Current deck' });
    expect(within(panel).getByTestId('unresolved-summary')).toHaveTextContent(
      '1 card ID in this deck no longer exists.',
    );
    // The unknown ID is listed as-is, and still counts toward deck size.
    expect(within(panel).getAllByText('deleted_card').length).toBeGreaterThan(0);
    expect(within(panel).getByTestId('deck-size')).toHaveTextContent('2 / 30 cards');

    await user.click(screen.getByRole('button', { name: 'Remove unresolved cards' }));
    expect(within(panel).queryByTestId('unresolved-summary')).not.toBeInTheDocument();
    expect(within(panel).getByTestId('deck-size')).toHaveTextContent('0 / 30 cards');
  });
});
