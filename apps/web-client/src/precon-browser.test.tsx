import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BUNDLED_PRECONS, bundledPrecon, CardDatabase, formatDatabase } from '@tcg/card-data';
import {
  DECK_STORAGE_KEY,
  DEVELOPMENT_DECK_FORMAT,
  MemoryStore,
  PRECON_WAVE_1_DECK_FORMAT,
  type SavedDeck,
} from '@tcg/deck';
import { App } from './App.js';
import { AppProvider } from './state/AppContext.js';

/**
 * The deck-builder precon browser (M03.1).
 *
 * Runs against the real `precon_wave_1` pool rather than a fixture: the point of
 * the panel is that it shows the shipped content, and a stubbed precon would
 * prove nothing about the four decks a player actually gets.
 */

const waveOne = formatDatabase('precon_wave_1');

function renderApp(format = PRECON_WAVE_1_DECK_FORMAT, database = waveOne) {
  const store = new MemoryStore();
  const user = userEvent.setup();
  render(
    <AppProvider database={database} deckFormat={format} store={store}>
      <App />
    </AppProvider>,
  );
  return { store, user };
}

const storedDecks = (store: MemoryStore): SavedDeck[] =>
  JSON.parse(store.getItem(DECK_STORAGE_KEY) ?? '{"decks":[]}').decks as SavedDeck[];

const openBrowser = async (user: ReturnType<typeof userEvent.setup>) => {
  await user.click(screen.getByRole('button', { name: 'Precons' }));
  return within(screen.getByRole('dialog', { name: 'Precon decks' }));
};

/** The list of precons, which shares its names with the copy button below it. */
const index = (panel: ReturnType<typeof within>) =>
  within(panel.getByRole('navigation', { name: 'Available precons' }));

describe('precon browser', () => {
  it('lists every precon published for the active format', async () => {
    const { user } = renderApp();
    const panel = await openBrowser(user);

    for (const precon of BUNDLED_PRECONS) {
      expect(
        index(panel).getByRole('button', { name: new RegExp(precon.name) }),
      ).toBeInTheDocument();
    }
  });

  it('closes on Escape and returns focus to the button that opened it', async () => {
    const { user } = renderApp();
    await openBrowser(user);

    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog', { name: 'Precon decks' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Precons' })).toHaveFocus();
  });

  it('does not mix development fixtures into Wave 1', async () => {
    // Nothing is published for `development`, so the panel must say so rather
    // than fall back to the Wave 1 precons it cannot legally offer here.
    const { user } = renderApp(DEVELOPMENT_DECK_FORMAT, formatDatabase('development'));
    const panel = await openBrowser(user);

    expect(panel.getByText(/No built-in precons are published/)).toBeInTheDocument();
    expect(panel.queryByText('Goblin Swarm')).not.toBeInTheDocument();
  });

  it('inspects the Commander, the whole 40-card list and the permanent IDs', async () => {
    const goblins = bundledPrecon('precon_goblin_swarm');
    if (!goblins) throw new Error('precon_goblin_swarm is missing');

    const { user } = renderApp();
    const panel = await openBrowser(user);
    await user.click(index(panel).getByRole('button', { name: /Goblin Swarm/ }));

    expect(panel.getByTestId('precon-size')).toHaveTextContent('40 cards');
    expect(panel.getByText(waveOne.getOrThrow(goblins.commanderId).name)).toBeInTheDocument();
    // Addressed by permanent precon ID under its own format, both on screen.
    expect(panel.getByTestId('precon-ids')).toHaveTextContent('precon_goblin_swarm');
    expect(panel.getByTestId('precon-ids')).toHaveTextContent('precon_wave_1');

    const list = within(panel.getByRole('list', { name: 'Goblin Swarm deck list' }));
    expect(list.getAllByRole('listitem')).toHaveLength(40);
    for (const cardId of goblins.cardIds) {
      expect(list.getByText(waveOne.getOrThrow(cardId).name)).toBeInTheDocument();
    }
  });

  it('reports legality for the selected precon', async () => {
    const { user } = renderApp();
    const panel = await openBrowser(user);

    // Since M02.6 every shipped precon is complete, so the panel says so
    // instead of listing problems.
    expect(panel.getByText(/Ready to play/)).toBeInTheDocument();
  });

  it('names the card that stops a precon being playable', async () => {
    // Doctored pool, because since M02.6 no shipped precon has an unfinished
    // card in it — and this refusal has to keep working for the next one.
    const doctored = new CardDatabase(
      waveOne.all().map((card) =>
        card.id === 'goblin_spearman'
          ? {
              ...card,
              implemented: false,
              unsupportedReason: 'its attack trigger is not wired up',
            }
          : card,
      ),
    );

    const { user } = renderApp(PRECON_WAVE_1_DECK_FORMAT, doctored);
    const panel = await openBrowser(user);
    await user.click(index(panel).getByRole('button', { name: /Goblin Swarm/ }));

    expect(panel.queryByText(/Ready to play/)).not.toBeInTheDocument();
    expect(panel.getByText(/attack trigger is not wired up/)).toBeInTheDocument();
    expect(panel.getByText('deck/card_not_implemented')).toBeInTheDocument();
  });

  it('copies a precon into an editable saved deck without touching the built-in', async () => {
    const before = structuredClone(BUNDLED_PRECONS);
    const goblins = bundledPrecon('precon_goblin_swarm');
    if (!goblins) throw new Error('precon_goblin_swarm is missing');

    const { store, user } = renderApp();
    const panel = await openBrowser(user);
    await user.click(index(panel).getByRole('button', { name: /Goblin Swarm/ }));
    await user.click(panel.getByRole('button', { name: /Copy .*Goblin Swarm.* to a new deck/ }));

    // The panel closes onto the builder with the copy already selected.
    expect(screen.queryByRole('dialog', { name: 'Precon decks' })).not.toBeInTheDocument();
    expect(await screen.findByText(/The built-in precon is unchanged/)).toBeInTheDocument();

    const saved = storedDecks(store);
    expect(saved).toHaveLength(1);
    expect(saved[0]?.name).toBe('Goblin Swarm');
    expect(saved[0]?.commanderId).toBe(goblins.commanderId);
    expect(saved[0]?.cards.map((entry) => entry.cardId).sort()).toEqual(
      [...goblins.cardIds].sort(),
    );
    expect(saved[0]?.cards.every((entry) => entry.quantity === 1)).toBe(true);

    const deckPanel = within(screen.getByRole('region', { name: 'Current deck' }));
    expect(deckPanel.getByTestId('deck-size')).toHaveTextContent('40 / 40 cards');
    expect(deckPanel.getByText('This deck is legal and ready to play.')).toBeInTheDocument();

    expect(BUNDLED_PRECONS).toEqual(before);
  });

  it('gives a second copy its own identity and edits only that one', async () => {
    const { store, user } = renderApp();

    for (const _pass of [1, 2]) {
      const panel = await openBrowser(user);
      await user.click(index(panel).getByRole('button', { name: /Goblin Swarm/ }));
      await user.click(panel.getByRole('button', { name: /Copy .*Goblin Swarm.* to a new deck/ }));
    }

    const saved = storedDecks(store);
    expect(saved.map((deck) => deck.name).sort()).toEqual(['Goblin Swarm', 'Goblin Swarm (copy)']);
    expect(new Set(saved.map((deck) => deck.id)).size).toBe(2);

    // Editing the active copy leaves the first one at 40 cards.
    const deckPanel = within(screen.getByRole('region', { name: 'Current deck' }));
    const [firstRow] = deckPanel.getAllByRole('button', { name: /^Decrease copies of / });
    if (!firstRow) throw new Error('no deck rows rendered');
    await user.click(firstRow);

    const sizes = storedDecks(store).map((deck) =>
      deck.cards.reduce((sum, entry) => sum + entry.quantity, 0),
    );
    expect(sizes.sort()).toEqual([39, 40]);
  });
});
