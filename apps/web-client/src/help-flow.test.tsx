import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { loadBundledCardData } from '@tcg/card-data';
import { DECK_SCHEMA_VERSION, DECK_STORAGE_KEY, MemoryStore, type SavedDeck } from '@tcg/deck';
import { DEFAULT_RULES_CONFIG } from '@tcg/rules-engine';
import {
  CURRENT_VERSIONS,
  decodeClientMessage,
  encode,
  type ClientMessage,
  type ServerMessage,
} from '@tcg/protocol';
import {
  applyAction,
  createMatch,
  playerView,
  type MatchDeck,
  type MatchState,
  type PlayerView,
} from '@tcg/rules-engine';
import { isOk, unwrap } from '@tcg/shared';
import { App } from './App.js';
import { AppProvider } from './state/AppContext.js';
import { MatchProvider } from './state/MatchContext.js';
import {
  MatchClient,
  type Transport,
  type TransportFactory,
  type TransportHandlers,
} from './net/match-client.js';

/**
 * Player help: the lobby rulebook and in-match card inspection.
 *
 * Driven through the same fake transport as the match tests, against real
 * `PlayerView`s from the engine — so the hidden-information assertions are
 * about what the server actually sends, not about a hand-built fixture.
 */

const { database } = loadBundledCardData();

function deckFor(commanderId: string, cardId: string): MatchDeck {
  return { commanderId, cards: [{ cardId, quantity: 30 }] };
}

/**
 * A match the local seat opens. The seed is chosen so `player_1` takes the
 * first turn, and their deck is a neutral one-cost spell with printed text and
 * no target requirement — so it is genuinely playable on turn one and there is
 * real card text for the inspector to show beside its generated explanation.
 */
function engineState(): MatchState {
  return unwrap(
    createMatch({
      matchId: 'help_ui',
      seed: 'help-b',
      database,
      seats: [
        {
          playerId: 'player_1',
          name: 'You',
          deck: deckFor('prototype_commander_red', 'field_survey'),
        },
        {
          playerId: 'player_2',
          name: 'Rival',
          deck: deckFor('prototype_commander_green', 'thornback_calf'),
        },
      ],
    }),
    'match setup',
  ).state;
}

/** Both seats keep their opening hand, so the board reaches a normal turn. */
function playingState(): MatchState {
  let state = engineState();
  for (const playerId of ['player_1', 'player_2']) {
    state = unwrap(
      applyAction(state, { type: 'mulligan', playerId, returnInstanceIds: [] }, { database }),
      'mulligan',
    ).state;
  }
  return state;
}

const savedDeck: SavedDeck = {
  schemaVersion: DECK_SCHEMA_VERSION,
  id: 'deck_help_ui',
  name: 'Help UI Deck',
  commanderId: 'prototype_commander_red',
  cards: [{ cardId: 'goblin_scout', quantity: 2 }],
  createdAt: '2026-08-07T12:00:00.000Z',
  updatedAt: '2026-08-07T12:00:00.000Z',
};

class FakeTransport implements Transport {
  readonly sent: ClientMessage[] = [];
  #handlers: TransportHandlers;

  constructor(handlers: TransportHandlers) {
    this.#handlers = handlers;
    queueMicrotask(() => this.#handlers.onOpen());
  }

  send(raw: string): void {
    const decoded = decodeClientMessage(raw);
    if (isOk(decoded)) this.sent.push(decoded.value);
  }

  close(): void {
    this.#handlers.onClose();
  }

  deliver(message: ServerMessage): void {
    this.#handlers.onMessage(encode(message));
  }
}

function renderApp() {
  let transport: FakeTransport | undefined;
  const factory: TransportFactory = (handlers) => {
    transport = new FakeTransport(handlers);
    return transport;
  };

  const store = new MemoryStore();
  store.setItem(DECK_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, decks: [savedDeck] }));

  const client = new MatchClient({ createTransport: factory });
  const user = userEvent.setup();

  render(
    <AppProvider database={database} store={store}>
      <MatchProvider client={client}>
        <App />
      </MatchProvider>
    </AppProvider>,
  );

  return {
    user,
    transport: () => {
      if (!transport) throw new Error('Transport was never created');
      return transport;
    },
  };
}

async function openLobby() {
  const harness = renderApp();
  await harness.user.click(screen.getByRole('button', { name: 'Play' }));
  await harness.user.click(await screen.findByRole('button', { name: 'Create a lobby' }));
  return harness;
}

async function openBoard(state: MatchState = playingState()) {
  const harness = await openLobby();
  harness.transport().deliver({
    type: 'match_state',
    view: playerView(state, 'player_1', database) as PlayerView,
    events: [],
  });
  await screen.findByLabelText('Match board');
  return harness;
}

/* --------------------------------------------------------------- rulebook */

describe('lobby rulebook', () => {
  it('opens from the lobby without leaving it', async () => {
    const harness = await openLobby();
    expect(await screen.findByLabelText('Match lobby')).toBeInTheDocument();

    await harness.user.click(screen.getByRole('button', { name: 'Rulebook' }));
    expect(await screen.findByRole('dialog', { name: 'How to Play' })).toBeInTheDocument();
    // The lobby is still mounted underneath.
    expect(screen.getByLabelText('Match lobby')).toBeInTheDocument();
  });

  it('renders every required section from content', async () => {
    const harness = await openLobby();
    await harness.user.click(screen.getByRole('button', { name: 'Rulebook' }));
    const dialog = await screen.findByRole('dialog', { name: 'How to Play' });

    for (const heading of [
      'Objective and winning',
      'Setting up a match',
      'Building a deck',
      'Reading a card',
      'Card types',
      'Energy and paying costs',
      'The turn',
      'Playing cards and using abilities',
      'Attacking and blocking',
      'Damage, defeat and elimination',
      'Your Commander',
      'Three and four player games',
      'Targets, choices and how effects resolve',
      'Keywords',
      'Glossary',
      'An example first turn',
      'Common edge cases',
    ]) {
      expect(within(dialog).getByRole('heading', { name: heading, level: 3 })).toBeInTheDocument();
    }
  });

  it('shows configuration values from the shared rules config', async () => {
    const harness = await openLobby();
    await harness.user.click(screen.getByRole('button', { name: 'Rulebook' }));
    const dialog = await screen.findByRole('dialog', { name: 'How to Play' });

    const startingHealth = within(dialog).getByText('Starting health');
    expect(startingHealth.parentElement?.textContent).toContain(
      String(DEFAULT_RULES_CONFIG.startingHealth),
    );
    // No placeholder ever reaches the page.
    expect(dialog.textContent ?? '').not.toMatch(/\{matchConfig|\{deckRules/);
  });

  it('lists keyword and glossary entries from the shared registries', async () => {
    const harness = await openLobby();
    await harness.user.click(screen.getByRole('button', { name: 'Rulebook' }));
    const dialog = await screen.findByRole('dialog', { name: 'How to Play' });

    expect(within(dialog).getByText('Venom')).toBeInTheDocument();
    expect(within(dialog).getByText('Summoning sickness')).toBeInTheDocument();
    // Keywords the engine ignores are labelled, not described as if they worked.
    const guardian = within(dialog).getByText('Guardian').parentElement;
    expect(guardian?.textContent).toContain('no effect yet');
  });

  it('filters the table of contents by search', async () => {
    const harness = await openLobby();
    await harness.user.click(screen.getByRole('button', { name: 'Rulebook' }));
    const dialog = await screen.findByRole('dialog', { name: 'How to Play' });

    await harness.user.type(within(dialog).getByRole('searchbox'), 'blocking');
    await waitFor(() => expect(within(dialog).getByText(/section(s?) match/)).toBeInTheDocument());
    const nav = within(dialog).getByRole('navigation', { name: 'Rulebook contents' });
    expect(within(nav).getByRole('button', { name: 'Attacking and blocking' })).toBeInTheDocument();
    expect(within(nav).queryByRole('button', { name: 'Building a deck' })).not.toBeInTheDocument();
  });

  it('reports honestly when a search matches nothing', async () => {
    const harness = await openLobby();
    await harness.user.click(screen.getByRole('button', { name: 'Rulebook' }));
    const dialog = await screen.findByRole('dialog', { name: 'How to Play' });

    await harness.user.type(within(dialog).getByRole('searchbox'), 'planeswalker');
    expect(await within(dialog).findByText('Nothing matches that.')).toBeInTheDocument();
  });

  it('closes with Escape and gives focus back to the button that opened it', async () => {
    const harness = await openLobby();
    const opener = screen.getByRole('button', { name: 'Rulebook' });
    await harness.user.click(opener);

    const dialog = await screen.findByRole('dialog', { name: 'How to Play' });
    expect(dialog).toHaveFocus();

    await harness.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(opener).toHaveFocus();
  });

  it('closes with the close button', async () => {
    const harness = await openLobby();
    await harness.user.click(screen.getByRole('button', { name: 'Rulebook' }));
    await harness.user.click(await screen.findByRole('button', { name: 'Close the rulebook' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });

  it('keeps the lobby usable after the rulebook is closed', async () => {
    const harness = await openLobby();
    harness.transport().deliver({
      type: 'lobby_joined',
      versions: CURRENT_VERSIONS,
      seatId: 'seat_1',
      reconnectToken: 'c'.repeat(32),
      lobby: {
        inviteCode: 'HLP123',
        status: 'waiting',
        maxSeats: 2,
        hostSeatId: 'seat_1',
        canStart: false,
        seats: [
          {
            seatId: 'seat_1',
            displayName: 'Player',
            connected: true,
            ready: false,
            deckName: null,
            deckLegal: false,
            isHost: true,
            graceSeconds: null,
            eliminated: false,
          },
        ],
      },
    });
    expect(await screen.findByText('HLP123')).toBeInTheDocument();

    await harness.user.click(screen.getByRole('button', { name: 'Rulebook' }));
    await harness.user.keyboard('{Escape}');

    // The lobby, its invite code and its deck picker survived untouched.
    expect(screen.getByText('HLP123')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Submit deck' })).toBeInTheDocument();
  });
});

/* ------------------------------------------------------- card inspection */

describe('in-match card inspection', () => {
  it('is off by default and leaves card clicks alone', async () => {
    const state = playingState();
    const harness = await openBoard(state);

    const hand = screen.getByLabelText('Your hand');
    const cards = within(hand).getAllByRole('button');
    const enabled = cards.find((card) => !card.hasAttribute('disabled'));
    expect(enabled, 'the active seat should have a playable card').toBeDefined();

    await harness.user.click(enabled!);
    // Normal behaviour: a real action went to the server.
    const submitted = harness
      .transport()
      .sent.filter((message) => message.type === 'submit_action');
    expect(submitted.length).toBe(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('never dispatches a gameplay action while Help mode is on', async () => {
    const harness = await openBoard();
    await harness.user.click(screen.getByRole('button', { name: '? Help' }));

    const hand = screen.getByLabelText('Your hand');
    for (const card of within(hand).getAllByRole('button')) {
      await harness.user.click(card);
    }

    expect(harness.transport().sent.filter((message) => message.type === 'submit_action')).toEqual(
      [],
    );
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('explains a card from structured data, alongside its printed text', async () => {
    const harness = await openBoard();
    await harness.user.click(screen.getByRole('button', { name: '? Help' }));

    const hand = screen.getByLabelText('Your hand');
    await harness.user.click(within(hand).getAllByRole('button')[0]!);

    const dialog = await screen.findByRole('dialog', { name: /Card details: Field Survey/ });
    expect(within(dialog).getByText('Card text, exactly as printed')).toBeInTheDocument();
    expect(within(dialog).getByText(/explanation, generated from card data/)).toBeInTheDocument();
    // The printed text and the generated explanation are both present, and
    // clearly distinguished from one another.
    expect(dialog.textContent ?? '').toContain(
      'Look at the top 3 cards of your deck and put them back in any order.',
    );
    expect(dialog.textContent ?? '').toMatch(/put the top three cards of your deck back/i);
    expect(dialog.textContent ?? '').not.toMatch(/\{matchConfig/);
  });

  it('uses authoritative legality for its contextual status', async () => {
    const state = playingState();
    const harness = await openBoard(state);
    const view = playerView(state, 'player_1', database);
    const playable = view.legalActions.playableCards[0];
    expect(playable).toBeDefined();

    await harness.user.click(screen.getByRole('button', { name: '? Help' }));
    const hand = screen.getByLabelText('Your hand');
    await harness.user.click(within(hand).getAllByRole('button')[0]!);

    const dialog = await screen.findByRole('dialog');
    const status = within(dialog).getByLabelText('Right now');
    expect(status.textContent).toContain(`${playable!.energyCost} energy`);
  });

  it('can inspect an opponent’s Commander, which is public', async () => {
    const harness = await openBoard();
    await harness.user.click(screen.getByRole('button', { name: '? Help' }));

    await harness.user.click(screen.getByRole('button', { name: "Inspect Rival's Commander" }));
    const dialog = await screen.findByRole('dialog', { name: /Card details/ });
    expect(within(dialog).getByText("Rival's Commander")).toBeInTheDocument();
    expect(dialog.textContent ?? '').toMatch(/never paid for/);
    expect(dialog.textContent ?? '').toMatch(/stays in the Commander zone/);
  });

  it('cannot reach the opponent’s hand or deck at all', async () => {
    const state = playingState();
    const harness = await openBoard(state);
    await harness.user.click(screen.getByRole('button', { name: '? Help' }));

    // Every card the panel can step to is a card the engine put in the view.
    const view = playerView(state, 'player_1', database);
    const hidden = [
      ...(state.players.player_2?.hand ?? []),
      ...(state.players.player_1?.deck ?? []),
      ...(state.players.player_2?.deck ?? []),
    ];
    for (const instanceId of hidden) {
      expect(view.instances[instanceId]).toBeUndefined();
    }
    // And no hidden card name is anywhere in the document.
    expect(document.body.textContent).not.toContain('Thornback Calf');
  });

  it('closes with Escape without touching match state', async () => {
    const harness = await openBoard();
    await harness.user.click(screen.getByRole('button', { name: '? Help' }));

    const hand = screen.getByLabelText('Your hand');
    await harness.user.click(within(hand).getAllByRole('button')[0]!);
    await screen.findByRole('dialog');

    await harness.user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(harness.transport().sent.filter((message) => message.type === 'submit_action')).toEqual(
      [],
    );
  });

  it('survives a match state update while a card is open', async () => {
    const state = playingState();
    const harness = await openBoard(state);
    await harness.user.click(screen.getByRole('button', { name: '? Help' }));

    const hand = screen.getByLabelText('Your hand');
    await harness.user.click(within(hand).getAllByRole('button')[0]!);
    await screen.findByRole('dialog');

    // A fresh authoritative view arrives, exactly as it would after any action
    // or a reconnect.
    harness.transport().deliver({
      type: 'match_state',
      view: playerView(state, 'player_1', database) as PlayerView,
      events: [],
    });

    expect(await screen.findByRole('dialog', { name: /Card details/ })).toBeInTheDocument();
  });

  it('turns Help mode off again and restores normal clicks', async () => {
    const harness = await openBoard();
    const toggle = screen.getByRole('button', { name: '? Help' });

    await harness.user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'true');

    await harness.user.click(toggle);
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    const hand = screen.getByLabelText('Your hand');
    const enabled = within(hand)
      .getAllByRole('button')
      .find((card) => !card.hasAttribute('disabled'));
    await harness.user.click(enabled!);
    expect(
      harness.transport().sent.filter((message) => message.type === 'submit_action').length,
    ).toBe(1);
  });
});
