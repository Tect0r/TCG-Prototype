import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { loadFormatCardData, resolveFormatId } from '@tcg/card-data';
import {
  DECK_STORAGE_KEY,
  MemoryStore,
  addCard,
  createDeck,
  deckFormatOf,
  setCommander,
} from '@tcg/deck';
import { App } from './App.js';
import { AppProvider } from './state/AppContext.js';

/**
 * The deck builder runs one format's pool (M01.1).
 *
 * Everything here is wired exactly as `main.tsx` wires it — the shared
 * format-pool API and the deck-construction rules derived from the same format
 * — so a card the match server would refuse cannot be offered, chosen, or
 * silently kept in a saved deck without being flagged.
 */

const shipping = loadFormatCardData(resolveFormatId());
if (!shipping.ok) throw new Error('The shipping format did not resolve to a card pool.');
const { database, format } = shipping.value;
const deckFormat = deckFormatOf(format);

/** Identifiers that exist only in the development fixture set. */
const FIXTURE_CARD_ID = 'goblin_scout';
const FIXTURE_CARD_NAME = 'Goblin Scout';
const FIXTURE_COMMANDER_ID = 'prototype_commander_red';

/** The app exactly as the browser entry point builds it. */
function renderShippingApp(store = new MemoryStore()) {
  const user = userEvent.setup();
  render(
    <AppProvider database={database} deckFormat={deckFormat} store={store}>
      <App />
    </AppProvider>,
  );
  return { store, user };
}

const deckPanel = () => screen.getByRole('region', { name: 'Current deck' });
const browser = () => within(screen.getByRole('region', { name: 'Card browser' }));

describe('deck builder format pool', () => {
  it('loads the Wave 1 pool rather than the bundled universe', async () => {
    renderShippingApp();
    expect(
      await screen.findByText(`Card game prototype · ${database.size} cards loaded`),
    ).toBeInTheDocument();
    expect(database.has(FIXTURE_CARD_ID)).toBe(false);
  });

  it('offers no development Commander in the picker', async () => {
    const { user } = renderShippingApp();
    await user.click(await screen.findByRole('button', { name: 'New deck' }));

    const picker = screen.getByLabelText('Commander') as HTMLSelectElement;
    const values = [...picker.options].map((option) => option.value);
    expect(values).toContain('bastion_commander');
    expect(values).not.toContain(FIXTURE_COMMANDER_ID);
    expect(values.some((value) => value.startsWith('prototype_'))).toBe(false);
  });

  it('never lists a development fixture card in the browser', async () => {
    const { user } = renderShippingApp();
    await user.click(await screen.findByRole('button', { name: 'New deck' }));
    await user.selectOptions(screen.getByLabelText('Commander'), 'goblin_warboss');

    // The Warboss is red, so a red fixture card is the one most likely to slip
    // through a colour-identity filter if the pool were the whole universe.
    // The Wave 1 red card beside it is the positive control: the browser is
    // populated, it just cannot reach the fixture set.
    expect(browser().getByText('Goblin Spearman')).toBeInTheDocument();
    expect(browser().queryByText(FIXTURE_CARD_NAME)).not.toBeInTheDocument();
  });

  it('flags a saved deck that still holds a development fixture', async () => {
    const store = new MemoryStore();
    const deck = addCard(
      setCommander(createDeck({ name: 'Fixture Deck' }), 'bastion_commander'),
      FIXTURE_CARD_ID,
    );
    store.setItem(DECK_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, decks: [deck] }));
    renderShippingApp(store);

    expect(
      await within(await screen.findByRole('region', { name: 'Current deck' })).findByText(
        new RegExp(`"${FIXTURE_CARD_ID}" no longer exists`),
      ),
    ).toBeInTheDocument();
  });

  it('shows the Wave 1 construction rules, not the fixture format', async () => {
    const { user } = renderShippingApp();
    await user.click(await screen.findByRole('button', { name: 'New deck' }));
    await user.selectOptions(screen.getByLabelText('Commander'), 'bastion_commander');

    expect(within(deckPanel()).getByTestId('deck-size')).toHaveTextContent('0 / 40 cards');
  });
});
