import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { loadBundledCardData } from '@tcg/card-data';
import { DECK_SCHEMA_VERSION, DECK_STORAGE_KEY, MemoryStore, type SavedDeck } from '@tcg/deck';
import {
  BOT_CONFIG_SCHEMA_VERSION,
  DEFAULT_BOT_PACING_BUDGETS,
  DIFFICULTY_REGISTRY_VERSION,
  MAX_PACING_PERCENT,
  MIN_PACING_PERCENT,
  pacingPercentSchema,
  PLANNED_DIFFICULTIES,
  difficultyDefinition,
} from '@tcg/bot-config';
import {
  CURRENT_VERSIONS,
  decodeClientMessage,
  encode,
  type BotLobbySeatView,
  type ClientMessage,
  type HumanLobbySeatView,
  type LobbySeatView,
  type LobbyStatus,
  type LobbyView,
  type SeatId,
  type ServerMessage,
} from '@tcg/protocol';
import { createMatch, playerView, type MatchDeck, type MatchState } from '@tcg/rules-engine';
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
 * The first playable human-versus-precon-bot flow (M09.5).
 *
 * Driven through the same fake transport the rest of the match UI tests use,
 * carrying **real** protocol frames: every lobby view below is parsed by
 * `encode`/`decodeServerMessage` on its way in, so a seat view this file builds
 * by hand is one the wire would actually accept. The server app is not
 * involved — M09.3 and M09.4 own its side, and this tranche owns the screen.
 */

const { database } = loadBundledCardData();

const savedDeck: SavedDeck = {
  schemaVersion: DECK_SCHEMA_VERSION,
  id: 'deck_ui',
  name: 'UI Test Deck',
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

  all<T extends ClientMessage['type']>(type: T): Extract<ClientMessage, { type: T }>[] {
    return this.sent.filter(
      (message): message is Extract<ClientMessage, { type: T }> => message.type === type,
    );
  }

  last<T extends ClientMessage['type']>(type: T): Extract<ClientMessage, { type: T }> | undefined {
    return this.all(type).at(-1);
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

/** A seated bot exactly as `publicBotSeatOf` would project one. */
function botSeat(overrides: Partial<BotLobbySeatView> = {}): BotLobbySeatView {
  return {
    seatId: 'seat_2',
    displayName: 'Bot 2',
    connected: true,
    ready: true,
    deckName: 'Goblin Swarm',
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
      style: 'aggressive',
      deck: { mode: 'exact_precon', preconId: 'precon_goblin_swarm' },
      pacing: { percent: 0, reactionPercent: null },
    },
    ...overrides,
  };
}

function lobby(seats: readonly LobbySeatView[], overrides: Partial<LobbyView> = {}): LobbyView {
  return {
    inviteCode: 'BOT001',
    status: 'waiting' as LobbyStatus,
    maxSeats: 2,
    hostSeatId: 'seat_1',
    canStart: false,
    seats: [...seats],
    // Every table has budgets (M09.11); a fixture without them is not a lobby
    // view the wire would accept.
    botPacing: DEFAULT_BOT_PACING_BUDGETS,
    ...overrides,
  };
}

type Harness = ReturnType<typeof renderApp>;

/** Creates the lobby and lands the seat in it, which is where the panel exists. */
async function enterLobby(
  harness: Harness,
  view: LobbyView = lobby([humanSeat()]),
  seatId: SeatId = 'seat_1',
): Promise<void> {
  await harness.user.click(screen.getByRole('button', { name: 'Play' }));
  await harness.user.click(await screen.findByRole('button', { name: 'Create a lobby' }));
  harness.transport().deliver({
    type: 'lobby_joined',
    versions: CURRENT_VERSIONS,
    seatId,
    reconnectToken: 'f'.repeat(32),
    lobby: view,
  });
  await screen.findByText(view.inviteCode);
}

const panel = (): HTMLElement => screen.getByLabelText('Bot opponents');

/* ------------------------------------------------------- adding and configuring */

describe('bot seat controls', () => {
  it('sends the whole configuration the host chose, and nothing the server owns', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    await harness.user.selectOptions(screen.getByLabelText('Bot deck'), 'precon_goblin_swarm');
    await harness.user.selectOptions(screen.getByLabelText('Bot style'), 'defensive');
    await harness.user.click(screen.getByRole('button', { name: 'Add a bot' }));

    // The whole message. No seat ID and no bot ID: the server allocates both,
    // and a client that could choose either could collide with a real seat.
    expect(harness.transport().last('add_bot')).toEqual({
      type: 'add_bot',
      setup: {
        schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
        difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
        displayName: null,
        difficulty: 'normal',
        style: 'defensive',
        deck: { mode: 'exact_precon', preconId: 'precon_goblin_swarm' },
        pacing: { percent: 0, reactionPercent: null },
      },
    });
  });

  it('offers no option this build would refuse', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    // Difficulty: the registry's available IDs and no others. Easy and Hard are
    // absent rather than present-and-disabled, because the server refuses them
    // by name and a control whose only outcome is an error is decoration.
    const difficulty = screen.getByLabelText('Bot difficulty');
    expect(
      within(difficulty)
        .getAllByRole('option')
        .map((node) => node.textContent),
    ).toEqual(['Normal']);
    for (const planned of PLANNED_DIFFICULTIES) {
      expect(
        within(difficulty).queryByRole('option', { name: difficultyDefinition(planned).label }),
      ).not.toBeInTheDocument();
    }

    // Deck: the shipped precons for the active format, and no other deck mode.
    const deck = screen.getByLabelText('Bot deck');
    expect(
      within(deck)
        .getAllByRole('option')
        .map((node) => node.textContent),
    ).toEqual(['Bastion Guardians', 'Containment Control', 'Goblin Swarm', 'Grave Sacrifice']);

    // Timing does have a control since M09.11, and every percentage it offers
    // is one the server accepts — the range is `@tcg/bot-config`'s, not this
    // screen's.
    const timing = screen.getByLabelText('Bot timing');
    const offered = within(timing)
      .getAllByRole('option')
      .map((node) => Number(node.getAttribute('value')));
    expect(offered[0]).toBe(MIN_PACING_PERCENT);
    expect(offered.at(-1)).toBe(MAX_PACING_PERCENT);
    expect(offered.every((percent) => pacingPercentSchema.safeParse(percent).success)).toBe(true);
    // And no reroll: rerolling builds a new deck, which only a generated mode
    // does, and the server refuses every reroll in this build by name.
    expect(within(panel()).queryByRole('button', { name: /reroll/i })).not.toBeInTheDocument();
  });

  it('cannot seat two bots from one double press', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    const add = screen.getByRole('button', { name: 'Add a bot' });
    await harness.user.click(add);
    // The second press lands before the server has answered the first.
    await harness.user.click(screen.getByRole('button', { name: 'Adding…' }));

    expect(harness.transport().all('add_bot')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Adding…' })).toBeDisabled();
  });

  it('is reachable and operable from the keyboard alone', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    screen.getByLabelText('Bot deck').focus();
    await harness.user.tab();
    expect(screen.getByLabelText('Bot difficulty')).toHaveFocus();
    await harness.user.tab();
    expect(screen.getByLabelText('Bot style')).toHaveFocus();
    // Timing and its override sit between the style and the button (M09.11).
    await harness.user.tab();
    expect(screen.getByLabelText('Bot timing')).toHaveFocus();
    await harness.user.tab();
    expect(screen.getByLabelText('Bot Reaction override')).toHaveFocus();
    await harness.user.tab();
    expect(screen.getByRole('button', { name: 'Add a bot' })).toHaveFocus();

    await harness.user.keyboard('{Enter}');
    expect(harness.transport().last('add_bot')).toBeDefined();
  });
});

/* --------------------------------------------------------------- the seat itself */

describe('a seated bot', () => {
  it('is labelled with its controller, deck, Commander, settings and readiness', async () => {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), botSeat()]));

    const seat = within(screen.getByLabelText('Seats')).getByText('Bot 2').closest('li');
    expect(seat).not.toBeNull();
    const tags = within(seat as HTMLElement)
      .getAllByText(/.+/)
      .map((node) => node.textContent);
    expect(tags).toContain('bot');
    expect(tags).toContain('Goblin Swarm');
    expect(tags).toContain('Goblin Warboss');
    expect(tags).toContain('Normal');
    expect(tags).toContain('Aggressive');
    expect(tags).toContain('ready');
    // A bot has no connection to report, so the lobby does not claim one.
    expect(tags).not.toContain('connected');
    expect(tags).not.toContain('disconnected');
  });

  it('never puts the bot’s card list on screen', async () => {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), botSeat()]));

    // The Commander is public and the precon's name is shipped content; the
    // list behind it is not something the lobby view even carries.
    expect(document.body.textContent).toContain('Goblin Warboss');
    for (const cardId of ['goblin_spearman', 'goblin_sneak', 'goblin_torchrunner']) {
      const name = database.get(cardId)?.name;
      expect(name).toBeDefined();
      expect(document.body.textContent).not.toContain(name);
    }
  });

  it('reconfigures the same seat, and only when something changed', async () => {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), botSeat()]));

    // The form shows what the seat is actually set to, so "apply" has nothing
    // to do until the host changes one of them.
    expect(screen.getByLabelText('Seat 2 style')).toHaveValue('aggressive');
    expect(screen.getByRole('button', { name: 'Apply seat 2 changes' })).toBeDisabled();
    // The seated bot's controls are seat-scoped, and the form for the *next* one
    // keeps the unscoped names — so three bots at a table are three
    // unambiguously named forms rather than three copies of "Bot style" (M09.7).
    expect(screen.getByLabelText('Bot style')).toBeInTheDocument();
    // This table has two seats and both are taken, so there is nowhere to put
    // another bot: the control says so rather than disappearing.
    expect(screen.getByRole('button', { name: 'Add a bot' })).toBeDisabled();

    await harness.user.selectOptions(screen.getByLabelText('Seat 2 style'), 'value');
    await harness.user.click(screen.getByRole('button', { name: 'Apply seat 2 changes' }));

    const sent = harness.transport().last('update_bot');
    expect(sent?.seatId).toBe('seat_2');
    expect(sent?.setup.style).toBe('value');
    // The seat keeps its deck: an update is a whole configuration, not a patch.
    expect(sent?.setup.deck).toEqual({ mode: 'exact_precon', preconId: 'precon_goblin_swarm' });
  });

  it('frees the seat on request, and offers to add another afterwards', async () => {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), botSeat()]));

    await harness.user.click(screen.getByRole('button', { name: 'Remove seat 2' }));
    expect(harness.transport().last('remove_bot')).toEqual({
      type: 'remove_bot',
      seatId: 'seat_2',
    });

    harness.transport().deliver({ type: 'lobby_updated', lobby: lobby([humanSeat()]) });

    expect(await screen.findByRole('button', { name: 'Add a bot' })).toBeInTheDocument();
    expect(screen.queryByText('Bot 2')).not.toBeInTheDocument();
    expect(screen.getByText(/Waiting for a player/)).toBeInTheDocument();
  });

  it('shows a guest the bot and none of its controls', async () => {
    const harness = renderApp();
    await enterLobby(
      harness,
      lobby(
        [
          humanSeat({ isHost: true }),
          botSeat(),
          humanSeat({ seatId: 'seat_3', displayName: 'Guest', isHost: false }),
        ],
        {
          maxSeats: 3,
        },
      ),
      'seat_3',
    );

    expect(screen.getByText('Bot 2')).toBeInTheDocument();
    expect(screen.queryByLabelText('Bot opponent')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a bot' })).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------- designed states */

describe('bot panel states', () => {
  it('prints a bot refusal beside the form rather than in the screen banner', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    harness.transport().deliver({
      type: 'error',
      error: {
        code: 'protocol/bot_mode_unsupported',
        message: 'This build cannot configure that kind of bot deck.',
        details: ['Deck mode "commander_generated" is planned for M09.9.'],
      },
    });

    const alert = await within(panel()).findByRole('alert');
    expect(alert).toHaveTextContent(/cannot configure/);
    expect(alert).toHaveTextContent(/M09.9/);
    // Exactly one alert on the screen: the banner does not repeat it.
    expect(screen.getAllByRole('alert')).toHaveLength(1);
  });

  it('leaves a lobby-wide refusal in the screen banner', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    // `lobby_full` is reused deliberately: it says the same thing about the
    // lobby whether a bot or a person was refused, so it is not the bot form's.
    harness.transport().deliver({
      type: 'error',
      error: { code: 'protocol/lobby_full', message: 'Every seat at this table is taken.' },
    });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/Every seat/);
    expect(within(panel()).queryByRole('alert')).not.toBeInTheDocument();
  });

  it('locks the configuration once the match has started', async () => {
    const harness = renderApp();
    await enterLobby(
      harness,
      lobby([humanSeat({ ready: true, deckLegal: true }), botSeat()], {
        status: 'in_match',
        canStart: false,
      }),
    );

    expect(within(panel()).getByText(/locked for the rest of it/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Bot deck')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Seat 2 deck')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remove seat 2' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a bot' })).not.toBeInTheDocument();
  });

  it('says so when every seat is taken instead of offering to add a bot', async () => {
    const harness = renderApp();
    await enterLobby(
      harness,
      lobby([humanSeat(), humanSeat({ seatId: 'seat_2', displayName: 'Rival', isHost: false })]),
    );

    expect(screen.getByRole('button', { name: 'Add a bot' })).toBeDisabled();
    expect(within(panel()).getByText(/Every seat at this table is taken/)).toBeInTheDocument();
  });

  it('offers an explicit start when the host readied before seating the bot', async () => {
    const harness = renderApp();
    await enterLobby(
      harness,
      lobby([humanSeat({ ready: true, deckLegal: true, deckName: 'UI Test Deck' }), botSeat()], {
        status: 'ready',
        canStart: true,
      }),
    );

    // A two-seat table starts itself when the human readies up — which already
    // happened here, before the bot existed. The button is the way out.
    const start = screen.getByRole('button', { name: /Start match/ });
    expect(start).not.toBeDisabled();
    await harness.user.click(start);
    expect(harness.transport().last('start_match')).toEqual({ type: 'start_match' });
  });
});

/* ------------------------------------------------- the board this does not touch */

describe('the match itself', () => {
  function humanVersusBot(): MatchState {
    const deck = (commanderId: string, cardId: string): MatchDeck => ({
      commanderId,
      cards: [{ cardId, quantity: 30 }],
    });
    return unwrap(
      createMatch({
        matchId: 'bot_ui_test',
        seed: 'bot-ui-seed',
        database,
        preserveSeatOrder: true,
        seats: [
          {
            playerId: 'player_1',
            name: 'Player',
            deck: deck('prototype_commander_red', 'goblin_scout'),
          },
          {
            playerId: 'player_2',
            name: 'Bot 2',
            deck: deck('prototype_commander_green', 'thornback_calf'),
          },
        ],
      }),
      'bot match setup',
    ).state;
  }

  it('renders through the existing board, which knows nothing about bots', async () => {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), botSeat()]));

    const state = humanVersusBot();
    harness.transport().deliver({
      type: 'match_state',
      view: playerView(state, 'player_1', database),
      events: [],
    });

    expect(await screen.findByLabelText('Match board')).toBeInTheDocument();
    // The bot is an ordinary opponent: a seat and a name, with no controller
    // label, difficulty, style or bot control anywhere on the board.
    expect(screen.getByText(/seat \d+: Bot 2/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Bot opponent')).not.toBeInTheDocument();
    expect(screen.queryByText('Aggressive')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Keep hand' })).toBeInTheDocument(),
    );
  });
});
