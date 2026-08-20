import { describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { loadFormatCardData } from '@tcg/card-data';
import { DECK_MODE_SUPPORT, type GeneratedDeckProvenance } from '@tcg/bot-config';
import {
  DECK_STORAGE_KEY,
  DEFAULT_DECK_FORMAT,
  MemoryStore,
  playableCommanders,
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
  type RevealedBotDeck,
  type ServerMessage,
} from '@tcg/protocol';
import { createMatch, playerView, type MatchDeck } from '@tcg/rules-engine';
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
 * Host-selected Commander generation, from the screen (M09.9).
 *
 * The server's half — the pool the generator is given, the four refusals, the
 * seed transition a reroll records, and the reveal at completion — is
 * `apps/multiplayer-server/src/bot-generated-deck.test.ts`. This file owns what
 * the host can *choose* and what they are *told*: that the Commander picker
 * offers this format's playable Commanders and nothing else, that a complete
 * instruction goes out in a frame the wire accepts, that the seed is an
 * instruction the host can write down and ask back for, that a reroll travels
 * without one, that the provenance and its forced-inclusion warning are shown
 * to the host and to nobody before the server sends them, and that a bot's list
 * appears — and can be exported — only once the match is over.
 *
 * The database below is **format-scoped**, exactly as `main.tsx` builds it. That
 * is not incidental to the test: the bundled universe publishes eight more
 * Commanders that `precon_wave_1` does not, and offering one of those would be
 * an option the authoritative server refuses by name (`CLAUDE.md`, "Any playable
 * pool must be obtained through a format-scoped database").
 */

const database = unwrap(loadFormatCardData(DEFAULT_DECK_FORMAT.formatId), 'format pool').database;

/** The four Wave 1 Commanders, in the order the picker sorts them into. */
const COMMANDER_NAMES = [...playableCommanders(database, DEFAULT_DECK_FORMAT)]
  .map((commander) => commander.name)
  .sort((left, right) => left.localeCompare(right));

const WARBOSS = 'goblin_warboss';
const MATRIARCH = 'grave_matriarch';

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

function renderApp(decks: readonly SavedDeck[] = []) {
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

type Harness = ReturnType<typeof renderApp>;

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

/** A seated generated bot, exactly as `publicBotSeatOf` projects one. */
function generatedBotSeat(
  commanderId: string = WARBOSS,
  overrides: Partial<BotLobbySeatView> = {},
): BotLobbySeatView {
  return {
    seatId: 'seat_2',
    displayName: 'Bot 2',
    connected: true,
    ready: true,
    // Never published: the deck the server built has no name a player chose.
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
      deck: { mode: 'commander_generated', commanderId },
      pacing: { percent: 0, reactionPercent: null },
    },
    ...overrides,
  };
}

function preconBotSeat(): BotLobbySeatView {
  return {
    ...generatedBotSeat(),
    bot: {
      ...generatedBotSeat().bot,
      deck: { mode: 'exact_precon', preconId: 'precon_goblin_swarm' },
    },
  };
}

function lobby(seats: readonly LobbySeatView[], overrides: Partial<LobbyView> = {}): LobbyView {
  return {
    inviteCode: 'GEN001',
    status: 'waiting',
    maxSeats: 2,
    hostSeatId: 'seat_1',
    canStart: false,
    seats: [...seats],
    ...overrides,
  };
}

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

/** Puts the picker on the generated mode and chooses a Commander and a seed. */
async function chooseCommander(
  harness: Harness,
  commanderId: string,
  seed?: string,
): Promise<void> {
  await harness.user.selectOptions(screen.getByLabelText('Bot deck source'), 'commander_generated');
  await harness.user.selectOptions(screen.getByLabelText('Bot Commander'), commanderId);
  if (seed !== undefined) {
    await harness.user.clear(screen.getByLabelText('Bot deck seed'));
    await harness.user.type(screen.getByLabelText('Bot deck seed'), seed);
  }
}

const PROVENANCE: GeneratedDeckProvenance = {
  generatorVersion: '1',
  mode: 'commander_generated',
  formatId: DEFAULT_DECK_FORMAT.formatId,
  seed: 'seed-alpha',
  rerollCount: 0,
  commanderId: WARBOSS,
  deckHash: 'deadbeefcafef00d',
  legalPoolSize: 41,
  forcedInclusionFloor: 39,
};

/* -------------------------------------------------------- choosing a Commander */

describe('the Commander picker', () => {
  it('appears only once the generated mode is chosen', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    // The mode has a resolver, so it is offered rather than absent.
    expect(DECK_MODE_SUPPORT.commander_generated.supported).toBe(true);
    expect(screen.queryByLabelText('Bot Commander')).not.toBeInTheDocument();

    await chooseCommander(harness, WARBOSS);
    expect(screen.getByLabelText('Bot Commander')).toBeInTheDocument();
    // One question, one control: the built-in picker belongs to another mode.
    expect(screen.queryByLabelText('Bot deck')).not.toBeInTheDocument();
  });

  it('offers this format’s playable Commanders and nothing else', async () => {
    const harness = renderApp();
    await enterLobby(harness);
    await chooseCommander(harness, WARBOSS);

    const picker = screen.getByLabelText('Bot Commander');
    expect(
      within(picker)
        .getAllByRole('option')
        .map((node) => node.textContent),
    ).toEqual(COMMANDER_NAMES);

    // Derived from the same function the server refuses by, so a Commander that
    // becomes playable appears here without this list being rewritten.
    expect(COMMANDER_NAMES).toHaveLength(4);
    // A Commander the bundle publishes but this format does not is not offered.
    expect(
      within(picker).queryByRole('option', { name: 'Emberline Captain' }),
    ).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------- what is sent */

describe('asking the server to build a deck', () => {
  it('sends the Commander and the seed, and never a deck it made up', async () => {
    const harness = renderApp();
    await enterLobby(harness);
    await chooseCommander(harness, MATRIARCH, 'seed-alpha');
    await harness.user.click(screen.getByRole('button', { name: 'Add a bot' }));

    expect(harness.transport().last('add_bot')?.setup.deck).toEqual({
      mode: 'commander_generated',
      commanderId: MATRIARCH,
      seed: 'seed-alpha',
      // A result, not an instruction: the server records what it built.
      generated: null,
    });
  });

  it('sends the same instruction for the same Commander and seed, twice over', async () => {
    /** One host, from a cold start, asking for the deck they wrote down. */
    async function askFor(seed: string): Promise<unknown> {
      const harness = renderApp();
      await enterLobby(harness);
      await chooseCommander(harness, WARBOSS, seed);
      await harness.user.click(screen.getByRole('button', { name: 'Add a bot' }));
      const sent = harness.transport().last('add_bot')?.setup.deck;
      cleanup();
      return sent;
    }

    // Two separate browsers' worth of state: nothing is carried over, so what
    // makes the two instructions identical is the seed and the Commander alone.
    expect(await askFor('repeatable')).toEqual(await askFor('repeatable'));
    expect(await askFor('repeatable')).not.toEqual(await askFor('different'));
  });

  it('starts a different stream by default, so two bots are not one deck twice', async () => {
    const harness = renderApp();
    await enterLobby(harness);
    await chooseCommander(harness, WARBOSS);
    const first = (screen.getByLabelText('Bot deck seed') as HTMLInputElement).value;
    expect(first).not.toBe('');

    await harness.user.selectOptions(screen.getByLabelText('Bot deck source'), 'exact_precon');
    await chooseCommander(harness, WARBOSS);
    expect((screen.getByLabelText('Bot deck seed') as HTMLInputElement).value).not.toBe(first);
  });
});

/* ------------------------------------------------- what the host is told back */

describe('the provenance of a deck the server built', () => {
  async function seatedHost(): Promise<Harness> {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), generatedBotSeat()]));
    return harness;
  }

  it('says nothing until the server sends it', async () => {
    await seatedHost();

    expect(within(panel()).queryByText(/seed/i)).not.toBeInTheDocument();
    expect(
      within(panel()).getByText(/this browser has not been told which one/i),
    ).toBeInTheDocument();
  });

  it('shows the seed, the generator version and the deck hash once it arrives', async () => {
    const harness = await seatedHost();
    harness.transport().deliver({
      type: 'bot_seat_provenance',
      seats: [{ seatId: 'seat_2', generated: PROVENANCE }],
    });

    const seat = await screen.findByLabelText('Bot in seat 2');
    expect(within(seat).getByText('seed-alpha')).toBeInTheDocument();
    expect(within(seat).getByText('deadbeefcafef00d')).toBeInTheDocument();
    expect(within(seat).getByText(/generator v1/)).toBeInTheDocument();
    expect(within(seat).getByText(/Goblin Warboss/)).toBeInTheDocument();
    expect(
      within(seat).getByText(/Opponents see the Commander and not the list/),
    ).toBeInTheDocument();
  });

  it('warns how little of the deck the format leaves free', async () => {
    const harness = await seatedHost();
    harness.transport().deliver({
      type: 'bot_seat_provenance',
      seats: [{ seatId: 'seat_2', generated: PROVENANCE }],
    });

    // Arithmetic from the pool report rather than a sentence written in the
    // screen: 41 legal cards for a 40-card deck leaves 2 cards of choice.
    const seat = await screen.findByLabelText('Bot in seat 2');
    expect(within(seat).getByText(/41 cards legal under that Commander/)).toBeInTheDocument();
    expect(within(seat).getByText(/at least 39 of them/)).toBeInTheDocument();
    expect(within(seat).getByText(/changes at most 2 cards/)).toBeInTheDocument();
  });

  it('is dropped when the seat stops being a generated bot', async () => {
    const harness = await seatedHost();
    harness.transport().deliver({
      type: 'bot_seat_provenance',
      seats: [{ seatId: 'seat_2', generated: PROVENANCE }],
    });
    await screen.findByText('seed-alpha');

    harness.transport().deliver({ type: 'lobby_updated', lobby: lobby([humanSeat()]) });
    await waitFor(() => expect(screen.queryByText('seed-alpha')).not.toBeInTheDocument());
  });
});

/* --------------------------------------------------------------- rerolling */

describe('rerolling before the match starts', () => {
  it('asks for the next deck without sending a seed', async () => {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), generatedBotSeat()]));

    await harness.user.click(screen.getByRole('button', { name: 'Reroll seat 2 deck' }));

    const sent = harness.transport().last('reroll_bot');
    // The seat and nothing else: the step along the stream is the server's, and
    // a client able to state it could invent a transition that never happened.
    expect(sent).toEqual({ type: 'reroll_bot', seatId: 'seat_2' });
  });

  it('is not offered for a bot playing an exact list', async () => {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), preconBotSeat()]));

    expect(screen.queryByRole('button', { name: 'Reroll seat 2 deck' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove seat 2' })).toBeInTheDocument();
  });
});

/* ----------------------------------------------------- private, then revealed */

describe('the list is private until the match is over', () => {
  const REVEALED: RevealedBotDeck = {
    seatId: 'seat_2',
    botId: 'bot_1',
    displayName: 'Bot 2',
    commanderId: WARBOSS,
    cardIds: ['goblin_spearman', 'goblin_spearman', 'goblin_sneak'],
    generated: PROVENANCE,
  };

  async function board(): Promise<Harness> {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), generatedBotSeat()]));

    const deck: MatchDeck = {
      commanderId: WARBOSS,
      cards: [{ cardId: 'goblin_spearman', quantity: 30 }],
    };
    const state = unwrap(
      createMatch({
        matchId: 'reveal_test',
        seed: 'reveal-seed',
        database,
        seats: [
          { playerId: 'player_1', name: 'Player', deck },
          { playerId: 'player_2', name: 'Bot 2', deck },
        ],
      }),
      'match setup',
    ).state;

    harness
      .transport()
      .deliver({ type: 'match_state', view: playerView(state, 'player_1', database), events: [] });
    await screen.findByLabelText('Match board');
    return harness;
  }

  it('shows no bot list while the match is being played', async () => {
    await board();
    expect(screen.queryByLabelText('Bot decks')).not.toBeInTheDocument();
  });

  it('shows every card the bot played once the server reveals it', async () => {
    const harness = await board();
    harness.transport().deliver({ type: 'bot_decks_revealed', decks: [REVEALED] });

    const reveal = await screen.findByLabelText('Bot decks');
    expect(within(reveal).getByText('2× Goblin Spearman')).toBeInTheDocument();
    expect(within(reveal).getByText('Goblin Sneak')).toBeInTheDocument();
    expect(within(reveal).getByText(/played 3 cards under Goblin Warboss/)).toBeInTheDocument();
    expect(within(reveal).getByText(/from seed seed-alpha/)).toBeInTheDocument();
  });

  it('offers the revealed list as a file, exactly as it arrived', async () => {
    const harness = await board();
    harness.transport().deliver({ type: 'bot_decks_revealed', decks: [REVEALED] });

    // The click path is not driven here — jsdom has no download — but the
    // control the milestone asks for is present and names one deck.
    const reveal = await screen.findByLabelText('Bot decks');
    expect(within(reveal).getByRole('button', { name: 'Export this deck' })).toBeEnabled();
  });
});
