import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DEFAULT_BOT_PACING_BUDGETS } from '@tcg/bot-config';
import { loadBundledCardData } from '@tcg/card-data';
import { DECK_SCHEMA_VERSION, DECK_STORAGE_KEY, MemoryStore, type SavedDeck } from '@tcg/deck';
import {
  CURRENT_VERSIONS,
  MAX_BOT_SEATS,
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
 * The host's half of a mixed human/bot table (M09.7).
 *
 * The server's half — every legal mixture playing to completion, no duplicated
 * decision, elimination, reconnect, host and order independence — is in
 * `apps/multiplayer-server/src/bot-mixed-table.test.ts`, because that is where
 * the authority lives. This file owns the one thing only the screen can be wrong
 * about: three bots at one table are three unambiguously named forms, the
 * ceiling is stated rather than inferred from a control vanishing, and two
 * mutations are never in flight at once.
 *
 * Frames are real: every lobby view below goes through `encode` on the way in
 * and every message out through `decodeClientMessage`, so a seat this file
 * builds by hand is one the wire would accept.
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

  const user = userEvent.setup();
  render(
    <AppProvider database={database} store={store}>
      <MatchProvider client={new MatchClient({ createTransport: factory })}>
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

/** One bot seat, as `publicBotSeatOf` would project it. */
function botSeat(
  seatId: SeatId,
  preconId: string,
  overrides: Partial<BotLobbySeatView['bot']> = {},
): BotLobbySeatView {
  const number = seatId.replace('seat_', '');
  return {
    seatId,
    displayName: `Bot ${number}`,
    connected: true,
    ready: true,
    deckName: null,
    deckLegal: true,
    isHost: false,
    graceSeconds: null,
    eliminated: false,
    controller: 'bot',
    bot: {
      controller: 'bot',
      botId: `bot_${number}`,
      displayName: `Bot ${number}`,
      difficulty: 'normal',
      styleSetting: 'aggressive',
      style: 'aggressive',
      deck: { mode: 'exact_precon', preconId },
      pacing: { percent: 0, reactionPercent: null },
      ...overrides,
    },
  };
}

function lobby(seats: readonly LobbySeatView[], overrides: Partial<LobbyView> = {}): LobbyView {
  return {
    inviteCode: 'MIX001',
    status: 'waiting' as LobbyStatus,
    maxSeats: 4,
    hostSeatId: 'seat_1',
    canStart: false,
    seats: [...seats],
    // Every table has budgets (M09.11); a fixture without them is not a lobby
    // view the wire would accept.
    botPacing: DEFAULT_BOT_PACING_BUDGETS,
    ...overrides,
  };
}

/** One human host and `count` bots, on a four-seat table. */
function mixedLobby(count: number, overrides: Partial<LobbyView> = {}): LobbyView {
  const precons = ['precon_goblin_swarm', 'precon_bastion_guardians', 'precon_grave_sacrifice'];
  const bots = Array.from({ length: count }, (_unused, index) =>
    botSeat(`seat_${index + 2}` as SeatId, precons[index] as string),
  );
  return lobby([humanSeat(), ...bots], overrides);
}

type Harness = ReturnType<typeof renderApp>;

async function enterLobby(harness: Harness, view: LobbyView): Promise<void> {
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

const panel = (): HTMLElement => screen.getByLabelText('AI opponents');

/* ----------------------------------------------------------- three named forms */

describe('a table holding several bots', () => {
  it('gives every seated bot its own form, named by the seat it belongs to', async () => {
    const harness = renderApp();
    await enterLobby(harness, mixedLobby(3));

    for (const seat of [2, 3, 4]) {
      const form = screen.getByLabelText(`AI opponent in seat ${seat}`);
      expect(within(form).getByLabelText(`Seat ${seat} deck`)).toBeInTheDocument();
      expect(within(form).getByLabelText(`Seat ${seat} difficulty`)).toBeInTheDocument();
      expect(within(form).getByLabelText(`Seat ${seat} style`)).toBeInTheDocument();
      expect(
        within(form).getByRole('button', { name: `Apply seat ${seat} changes` }),
      ).toBeInTheDocument();
      expect(within(form).getByRole('button', { name: `Remove seat ${seat}` })).toBeInTheDocument();
    }
    // The unscoped names belong to the form for the *next* bot and to nothing
    // else, so no seated bot's control is called "Bot deck".
    const adding = screen.getByLabelText('Add an AI opponent');
    expect(within(adding).getByLabelText('AI opponent deck')).toBeInTheDocument();
    for (const seat of [2, 3, 4]) {
      const form = screen.getByLabelText(`AI opponent in seat ${seat}`);
      expect(within(form).queryByLabelText('AI opponent deck')).not.toBeInTheDocument();
      expect(within(form).queryByLabelText('AI opponent style')).not.toBeInTheDocument();
    }
  });

  it('shows each seat the deck it is actually playing, not the first one', async () => {
    const harness = renderApp();
    await enterLobby(harness, mixedLobby(3));

    expect(screen.getByLabelText('Seat 2 deck')).toHaveValue('precon_goblin_swarm');
    expect(screen.getByLabelText('Seat 3 deck')).toHaveValue('precon_bastion_guardians');
    expect(screen.getByLabelText('Seat 4 deck')).toHaveValue('precon_grave_sacrifice');
  });

  it('edits one seat without disturbing another', async () => {
    const harness = renderApp();
    await enterLobby(harness, mixedLobby(3));

    await harness.user.selectOptions(screen.getByLabelText('Seat 3 style'), 'defensive');

    // Only seat 3 has anything to apply; the other two forms are untouched.
    expect(screen.getByRole('button', { name: 'Apply seat 3 changes' })).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply seat 2 changes' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply seat 4 changes' })).toBeDisabled();
    expect(screen.getByLabelText('Seat 2 style')).toHaveValue('aggressive');
    expect(screen.getByLabelText('Seat 4 style')).toHaveValue('aggressive');

    await harness.user.click(screen.getByRole('button', { name: 'Apply seat 3 changes' }));
    expect(harness.transport().all('update_bot')).toHaveLength(1);
    expect(harness.transport().last('update_bot')?.seatId).toBe('seat_3');
    expect(harness.transport().last('update_bot')?.setup.deck).toEqual({
      mode: 'exact_precon',
      preconId: 'precon_bastion_guardians',
    });
  });

  it('removes the bot the host named, and leaves the others seated', async () => {
    const harness = renderApp();
    await enterLobby(harness, mixedLobby(3));

    await harness.user.click(screen.getByRole('button', { name: 'Remove seat 3' }));
    expect(harness.transport().last('remove_bot')).toEqual({
      type: 'remove_bot',
      seatId: 'seat_3',
    });

    harness.transport().deliver({
      type: 'lobby_updated',
      lobby: lobby([
        humanSeat(),
        botSeat('seat_2', 'precon_goblin_swarm'),
        botSeat('seat_4', 'precon_grave_sacrifice'),
      ]),
    });

    expect(await screen.findByLabelText('AI opponent in seat 2')).toBeInTheDocument();
    expect(screen.getByLabelText('AI opponent in seat 4')).toBeInTheDocument();
    expect(screen.queryByLabelText('AI opponent in seat 3')).not.toBeInTheDocument();
    // A seat came free, so there is somewhere to put another bot again.
    expect(screen.getByRole('button', { name: 'Add an AI opponent' })).not.toBeDisabled();
  });
});

/* ------------------------------------------------------------------ the ceiling */

describe('at most three bots, and never a table without a person', () => {
  it('keeps offering another bot while a seat is free', async () => {
    const harness = renderApp();
    await enterLobby(harness, mixedLobby(1));

    const add = screen.getByRole('button', { name: 'Add an AI opponent' });
    expect(add).not.toBeDisabled();
    // The form for the next bot keeps the unscoped names: it belongs to no seat
    // yet, because the server is what decides which one it lands in.
    expect(screen.getByLabelText('AI opponent deck')).toBeInTheDocument();

    await harness.user.selectOptions(
      screen.getByLabelText('AI opponent deck'),
      'precon_grave_sacrifice',
    );
    await harness.user.click(add);

    const sent = harness.transport().last('add_bot');
    expect(sent?.setup.deck).toEqual({
      mode: 'exact_precon',
      preconId: 'precon_grave_sacrifice',
    });
    // No seat named: the server allocates, so the screen cannot race a joining
    // human for one.
    expect(Object.keys(sent ?? {})).not.toContain('seatId');
  });

  it('states the ceiling instead of letting the control quietly disappear', async () => {
    const harness = renderApp();
    await enterLobby(harness, mixedLobby(MAX_BOT_SEATS));

    // Said rather than silently withdrawn, which is the same answer M09.5 gave a
    // full table: a control that vanishes leaves the host guessing why.
    expect(within(panel()).getByText(/at most 3 bots/)).toBeInTheDocument();
    expect(within(panel()).getByText(/at least one seat always belongs to a person/)).toBeVisible();
    expect(screen.getByRole('button', { name: 'Add an AI opponent' })).toBeDisabled();
  });

  it('distinguishes a full table from the bot ceiling, because the host fixes them differently', async () => {
    const harness = renderApp();
    // Three seats, two of them people: a seat could be freed or the table grown,
    // and the bot ceiling is nowhere near.
    await enterLobby(
      harness,
      lobby(
        [
          humanSeat(),
          humanSeat({ seatId: 'seat_2', displayName: 'Rival', isHost: false }),
          botSeat('seat_3', 'precon_goblin_swarm'),
        ],
        { maxSeats: 3 },
      ),
    );

    expect(within(panel()).getByText(/Every seat at this table is taken/)).toBeInTheDocument();
    expect(within(panel()).queryByText(/at most 3 bots/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add an AI opponent' })).toBeDisabled();
  });

  it('says how much of the table is AI opponents, and that the rest is people', async () => {
    const harness = renderApp();
    await enterLobby(harness, mixedLobby(2));

    expect(
      within(panel()).getByText(/2 of this table’s 4 seats hold AI opponents/),
    ).toBeInTheDocument();
    expect(within(panel()).getByText(/the rest of the table is people/)).toBeInTheDocument();
  });
});

/* ------------------------------------------------------- one mutation at a time */

describe('two mutations are never in flight at once', () => {
  it('disables every other seat’s controls while one request is outstanding', async () => {
    const harness = renderApp();
    await enterLobby(harness, mixedLobby(3));

    await harness.user.selectOptions(screen.getByLabelText('Seat 2 style'), 'value');
    await harness.user.click(screen.getByRole('button', { name: 'Apply seat 2 changes' }));

    // The seat that sent it says what it is doing; every other control is
    // disabled, because `MatchClient` binds one outstanding request to a seat by
    // reading the next lobby view and two would be indistinguishable to it.
    expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove seat 3' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove seat 4' })).toBeDisabled();
    expect(screen.getByLabelText('Seat 3 style')).toBeDisabled();
    expect(screen.getByLabelText('Seat 4 style')).toBeDisabled();

    await harness.user.click(screen.getByRole('button', { name: 'Remove seat 3' }));
    expect(harness.transport().all('remove_bot')).toHaveLength(0);
  });

  it('lets the host act again as soon as the server answers', async () => {
    const harness = renderApp();
    await enterLobby(harness, mixedLobby(2));

    await harness.user.click(screen.getByRole('button', { name: 'Remove seat 2' }));
    expect(screen.getByRole('button', { name: 'Removing…' })).toBeDisabled();

    harness.transport().deliver({
      type: 'lobby_updated',
      lobby: lobby([humanSeat(), botSeat('seat_3', 'precon_bastion_guardians')]),
    });

    const remove = await screen.findByRole('button', { name: 'Remove seat 3' });
    expect(remove).not.toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add an AI opponent' })).not.toBeDisabled();
  });

  it('frees the controls again when the server refuses instead of applying', async () => {
    const harness = renderApp();
    await enterLobby(harness, mixedLobby(2));

    await harness.user.selectOptions(screen.getByLabelText('Seat 2 style'), 'value');
    await harness.user.click(screen.getByRole('button', { name: 'Apply seat 2 changes' }));
    expect(screen.getByRole('button', { name: 'Applying…' })).toBeDisabled();

    harness.transport().deliver({
      type: 'error',
      error: {
        code: 'protocol/unknown_bot_seat',
        message: 'That seat does not hold a bot.',
      },
    });

    const alert = await within(panel()).findByRole('alert');
    expect(alert).toHaveTextContent(/does not hold a bot/);
    expect(screen.getByRole('button', { name: 'Remove seat 3' })).not.toBeDisabled();
  });
});

/* ---------------------------------------------------------------- locked, mixed */

describe('a started mixed table', () => {
  it('locks every bot’s settings and says how many there were', async () => {
    const harness = renderApp();
    await enterLobby(
      harness,
      mixedLobby(3, { status: 'in_match', canStart: false, seats: mixedLobby(3).seats }),
    );

    expect(
      within(panel()).getByText(/these bots are locked for the rest of it/),
    ).toBeInTheDocument();
    for (const seat of [2, 3, 4]) {
      expect(screen.queryByLabelText(`AI opponent in seat ${seat}`)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: `Remove seat ${seat}` })).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Add an AI opponent' })).not.toBeInTheDocument();
  });

  it('says the singular thing about a single bot', async () => {
    const harness = renderApp();
    await enterLobby(harness, mixedLobby(1, { status: 'in_match' }));

    expect(within(panel()).getByText(/this bot are locked/)).toBeInTheDocument();
  });
});
