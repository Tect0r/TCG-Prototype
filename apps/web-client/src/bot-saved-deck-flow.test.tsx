import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { bundledPrecon, loadBundledCardData } from '@tcg/card-data';
import { DECK_MODE_SUPPORT, BOT_DECK_MODES, type BotDeckSnapshot } from '@tcg/bot-config';
import {
  DECK_STORAGE_KEY,
  MemoryStore,
  deckFingerprint,
  preconToDeck,
  type SavedDeck,
} from '@tcg/deck';
import {
  CURRENT_VERSIONS,
  decodeClientMessage,
  encode,
  type BotLobbySeatView,
  type ClientMessage,
  type HumanLobbySeatView,
  type LobbySeatView,
  type LobbyView,
  type ServerMessage,
} from '@tcg/protocol';
import { isOk } from '@tcg/shared';
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
 * Exact saved-deck mode, from the host's screen (M09.6).
 *
 * The server's half — validation, refusal by name, and the freeze surviving an
 * edit — is `apps/multiplayer-server/src/bot-saved-deck.test.ts`. This file owns
 * what the host sees and sends: that the picker offers the modes this build can
 * honour and no others, that choosing a saved deck sends its **contents** in a
 * frame the real codec accepts, that a deck which cannot be sent says why before
 * a button is pressed, and that editing the deck afterwards changes the deck and
 * not the bot.
 *
 * Every frame below goes through `encode`/`decodeClientMessage`, so a setup this
 * screen builds is one the wire would actually carry.
 */

const { database } = loadBundledCardData();

function requirePrecon(preconId: string) {
  const precon = bundledPrecon(preconId);
  if (!precon) throw new Error(`${preconId} is missing from the bundle.`);
  return precon;
}

/** A legal 40-card deck of the player's own, saved in this browser. */
function savedDeckFrom(preconId: string, id: string, name: string): SavedDeck {
  return {
    ...preconToDeck(requirePrecon(preconId), { id, now: '2026-08-14T09:00:00.000Z' }),
    name,
  };
}

const MY_DECK = savedDeckFrom('precon_goblin_swarm', 'deck_mine', 'My secret brew');
const MY_COMMANDER = MY_DECK.commanderId as string;
const OTHER_DECK = savedDeckFrom('precon_bastion_guardians', 'deck_other', 'Wall of people');
/** Legal in no format: the host has been building it and is not finished. */
const HALF_BUILT: SavedDeck = {
  ...MY_DECK,
  id: 'deck_half',
  name: 'Half built',
  cards: MY_DECK.cards.slice(0, 11),
};
const NO_COMMANDER: SavedDeck = {
  ...MY_DECK,
  id: 'deck_nocmd',
  name: 'No leader',
  commanderId: null,
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

  all<T extends ClientMessage['type']>(type: T): Extract<ClientMessage, { type: T }>[] {
    return this.sent.filter(
      (message): message is Extract<ClientMessage, { type: T }> => message.type === type,
    );
  }

  last<T extends ClientMessage['type']>(type: T): Extract<ClientMessage, { type: T }> | undefined {
    return this.all(type).at(-1);
  }
}

function renderApp(decks: readonly SavedDeck[] = [MY_DECK]) {
  let transport: FakeTransport | undefined;
  const factory: TransportFactory = (handlers) => {
    transport = new FakeTransport(handlers);
    return transport;
  };

  const store = new MemoryStore();
  store.setItem(DECK_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, decks }));

  render(
    <AppProvider database={database} store={store}>
      <MatchProvider client={new MatchClient({ createTransport: factory })}>
        <App />
      </MatchProvider>
    </AppProvider>,
  );

  return {
    user: userEvent.setup(),
    transport: () => {
      if (!transport) throw new Error('Transport was never created');
      return transport;
    },
  };
}

/* ------------------------------------------------------------- lobby fixtures */

function humanSeat(overrides: Partial<HumanLobbySeatView> = {}): HumanLobbySeatView {
  return {
    seatId: 'seat_1',
    displayName: 'Player',
    connected: true,
    ready: false,
    deckName: null,
    deckLegal: false,
    isHost: true,
    graceSeconds: null,
    eliminated: false,
    controller: 'human',
    bot: null,
    ...overrides,
  };
}

/** A seated saved-deck bot, exactly as `publicBotSeatOf` would project one. */
function savedDeckBotSeat(
  commanderId: string,
  overrides: Partial<BotLobbySeatView> = {},
): BotLobbySeatView {
  return {
    seatId: 'seat_2',
    displayName: 'Bot 2',
    connected: true,
    ready: true,
    // The one thing a saved-deck seat never publishes: the deck's name.
    deckName: null,
    deckLegal: true,
    isHost: false,
    graceSeconds: null,
    eliminated: false,
    controller: 'bot',
    bot: {
      controller: 'bot',
      botId: 'bot_1',
      displayName: 'Bot 2',
      difficulty: 'normal',
      style: 'value',
      deck: { mode: 'exact_saved_deck', commanderId },
      pacing: { percent: 0, reactionPercent: null },
    },
    ...overrides,
  };
}

function lobby(seats: readonly LobbySeatView[], overrides: Partial<LobbyView> = {}): LobbyView {
  return {
    inviteCode: 'SAV001',
    status: 'waiting',
    maxSeats: 2,
    hostSeatId: 'seat_1',
    canStart: false,
    seats: [...seats],
    ...overrides,
  };
}

type Harness = ReturnType<typeof renderApp>;

async function enterLobby(harness: Harness, view: LobbyView = lobby([humanSeat()])): Promise<void> {
  await harness.user.click(screen.getByRole('button', { name: 'Play' }));
  await harness.user.click(await screen.findByRole('button', { name: 'Create a lobby' }));
  harness.transport().deliver({
    type: 'lobby_joined',
    versions: CURRENT_VERSIONS,
    seatId: 'seat_1',
    reconnectToken: 'f'.repeat(32),
    lobby: view,
  });
  await screen.findByText(view.inviteCode);
}

const panel = (): HTMLElement => screen.getByLabelText('Bot opponents');

/** Puts the deck picker on "one of your saved decks" and chooses one. */
async function chooseSavedDeck(harness: Harness, deckId: string): Promise<void> {
  await harness.user.selectOptions(screen.getByLabelText('Bot deck source'), 'exact_saved_deck');
  await harness.user.selectOptions(screen.getByLabelText('Your deck'), deckId);
}

/* ---------------------------------------------------------------- the picker */

describe('the deck source picker', () => {
  it('offers exactly the modes this build can honour', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    const source = screen.getByLabelText('Bot deck source');
    expect(
      within(source)
        .getAllByRole('option')
        .map((node) => node.textContent),
    ).toEqual(['A built-in deck', 'One of your saved decks']);

    // Driven from the support table rather than from a list written here, so a
    // mode turning on without a control is a failure rather than a silence.
    const unsupported = BOT_DECK_MODES.filter((mode) => !DECK_MODE_SUPPORT[mode].supported);
    expect(unsupported).toEqual(['commander_generated', 'autonomous_generated']);
    for (const mode of unsupported) {
      expect(within(source).queryByRole('option', { name: new RegExp(mode) })).toBeNull();
    }
  });

  it('lists the player’s own decks once that mode is chosen', async () => {
    const harness = renderApp([MY_DECK, OTHER_DECK]);
    await enterLobby(harness);
    await harness.user.selectOptions(screen.getByLabelText('Bot deck source'), 'exact_saved_deck');

    expect(
      within(screen.getByLabelText('Your deck'))
        .getAllByRole('option')
        .map((node) => node.textContent),
    ).toEqual(['My secret brew', 'Wall of people']);
    // The built-in picker is gone rather than disabled: it belongs to the other
    // mode, and two deck pickers on screen would be two answers to one question.
    expect(screen.queryByLabelText('Bot deck')).not.toBeInTheDocument();
  });
});

/* --------------------------------------------------------------- what is sent */

describe('sending a saved deck', () => {
  it('sends the contents, frozen, in a frame the wire accepts', async () => {
    const harness = renderApp();
    await enterLobby(harness);
    await chooseSavedDeck(harness, 'deck_mine');
    await harness.user.click(screen.getByRole('button', { name: 'Add a bot' }));

    const sent = harness.transport().last('add_bot');
    expect(sent?.setup.deck).toEqual({
      mode: 'exact_saved_deck',
      deck: {
        sourceDeckId: 'deck_mine',
        name: 'My secret brew',
        commanderId: MY_COMMANDER,
        cardIds: MY_DECK.cards.map((entry) => entry.cardId),
        deckHash: deckFingerprint(MY_DECK),
      } satisfies BotDeckSnapshot,
    });
    // Everything else about the bot is unchanged by the deck mode: the four
    // axes are independent.
    expect(sent?.setup.difficulty).toBe('normal');
    expect(sent?.setup.pacing).toEqual({ percent: 0, reactionPercent: null });
  });

  it('warns that the copy is what travels', async () => {
    const harness = renderApp();
    await enterLobby(harness);
    await chooseSavedDeck(harness, 'deck_mine');

    expect(
      within(panel()).getByText(/copy of this deck is sent as it is now/i),
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------------- decks that cannot go */

describe('a saved deck the host cannot send', () => {
  it('names the rule an illegal deck breaks, and will not send it', async () => {
    const harness = renderApp([HALF_BUILT]);
    await enterLobby(harness);
    await chooseSavedDeck(harness, 'deck_half');

    expect(within(panel()).getByText(/11 of 40/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a bot' })).toBeDisabled();
    expect(harness.transport().all('add_bot')).toHaveLength(0);
  });

  it('says a deck with no Commander is not finished yet', async () => {
    const harness = renderApp([NO_COMMANDER]);
    await enterLobby(harness);
    await chooseSavedDeck(harness, 'deck_nocmd');

    expect(within(panel()).getByText(/has no Commander yet/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add a bot' })).toBeDisabled();
  });

  it('prints the server’s own refusal beside the form', async () => {
    const harness = renderApp();
    await enterLobby(harness);
    await chooseSavedDeck(harness, 'deck_mine');
    await harness.user.click(screen.getByRole('button', { name: 'Add a bot' }));

    harness.transport().deliver({
      type: 'error',
      error: {
        code: 'protocol/bot_config_invalid',
        message: 'That bot configuration cannot be read.',
        details: ['The deck was probably edited after it was chosen.'],
      },
    });

    const alert = await within(panel()).findByRole('alert');
    expect(alert).toHaveTextContent(/edited after it was chosen/);
    // The refused request applied nothing, so the button is offered again.
    expect(screen.getByRole('button', { name: 'Add a bot' })).toBeEnabled();
  });
});

/* --------------------------------------------------------------- the freeze */

describe('a seated saved-deck bot', () => {
  async function seatOne(harness: Harness): Promise<void> {
    await enterLobby(harness);
    await chooseSavedDeck(harness, 'deck_mine');
    await harness.user.click(screen.getByRole('button', { name: 'Add a bot' }));
    harness.transport().deliver({
      type: 'lobby_updated',
      lobby: lobby([humanSeat(), savedDeckBotSeat(MY_COMMANDER)]),
    });
    await within(await screen.findByLabelText('Seats')).findByText('Bot 2');
  }

  it('tells the host which deck was frozen, and its fingerprint', async () => {
    const harness = renderApp();
    await seatOne(harness);

    const hint = within(panel()).getByText(/Frozen from your deck/);
    expect(hint).toHaveTextContent('My secret brew');
    expect(hint).toHaveTextContent(deckFingerprint(MY_DECK));
    expect(hint).toHaveTextContent('40 cards');
  });

  it('shows other players the Commander and a verdict, and never the name', async () => {
    const harness = renderApp();
    await seatOne(harness);

    const seat = within(screen.getByLabelText('Seats')).getByText('Bot 2').closest('li');
    const tags = within(seat as HTMLElement)
      .getAllByText(/.+/)
      .map((node) => node.textContent);
    expect(tags).toContain('bot');
    expect(tags).toContain('deck hidden');
    expect(tags).toContain('Goblin Warboss');
    expect(tags).toContain('legal');
    expect(tags).not.toContain('My secret brew');
  });

  it('keeps playing the frozen list when the deck is edited afterwards', async () => {
    const harness = renderApp();
    await seatOne(harness);
    const before = harness.transport().sent.length;

    // The host goes back to the Deck Builder and takes a card out — which is
    // the whole reason the snapshot exists, and the reason the panel cannot
    // hold this memory itself: this unmounts it.
    await harness.user.click(screen.getByRole('button', { name: 'Deck Builder' }));
    const removed = database.get(MY_DECK.cards[0]?.cardId as string)?.name as string;
    await harness.user.click(screen.getByRole('button', { name: `Decrease copies of ${removed}` }));
    await harness.user.click(screen.getByRole('button', { name: 'Play' }));

    // Nothing was sent: an edit in the builder is not a reconfiguration.
    expect(harness.transport().sent).toHaveLength(before);
    expect(within(panel()).getByText(/has changed since you seated this bot/)).toBeInTheDocument();
    // And the host is still told what the bot is actually playing.
    expect(within(panel()).getByText(/Frozen from your deck/)).toHaveTextContent(
      deckFingerprint(MY_DECK),
    );
  });

  it('sends the new list only when the host applies it', async () => {
    const harness = renderApp();
    await seatOne(harness);

    await harness.user.click(screen.getByRole('button', { name: 'Deck Builder' }));
    const removed = database.get(MY_DECK.cards[0]?.cardId as string)?.name as string;
    await harness.user.click(screen.getByRole('button', { name: `Decrease copies of ${removed}` }));
    await harness.user.click(screen.getByRole('button', { name: 'Play' }));

    // A shorter deck is now illegal, so the panel refuses it before the wire
    // does — which is the same answer the server would give, said sooner.
    expect(within(panel()).getByText(/39 of 40/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply seat 2 changes' })).toBeDisabled();
    expect(harness.transport().all('update_bot')).toHaveLength(0);
  });
});
