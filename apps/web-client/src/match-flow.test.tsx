import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { loadBundledCardData } from '@tcg/card-data';
import { DECK_SCHEMA_VERSION, DECK_STORAGE_KEY, MemoryStore, type SavedDeck } from '@tcg/deck';
import {
  CURRENT_VERSIONS,
  decodeClientMessage,
  encode,
  type ClientMessage,
  type ServerMessage,
} from '@tcg/protocol';
import {
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
 * Match UI tests.
 *
 * The client is driven through a fake transport carrying real protocol frames
 * and real `PlayerView`s produced by the engine, so the UI is exercised against
 * authoritative data without depending on the server app.
 */

const { database } = loadBundledCardData();

function deckFor(commanderId: string, cardId: string): MatchDeck {
  return { commanderId, cards: [{ cardId, quantity: 30 }] };
}

function engineState(): MatchState {
  return unwrap(
    createMatch({
      matchId: 'ui_test',
      seed: 'ui-seed',
      database,
      seats: [
        {
          playerId: 'player_1',
          name: 'You',
          deck: deckFor('prototype_commander_red', 'goblin_scout'),
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

function viewFor(state: MatchState, playerId: string): PlayerView {
  return playerView(state, playerId, database);
}

const savedDeck: SavedDeck = {
  schemaVersion: DECK_SCHEMA_VERSION,
  id: 'deck_ui',
  name: 'UI Test Deck',
  commanderId: 'prototype_commander_red',
  cards: [{ cardId: 'goblin_scout', quantity: 2 }],
  createdAt: '2026-08-07T12:00:00.000Z',
  updatedAt: '2026-08-07T12:00:00.000Z',
};

/** A transport the test drives by hand, standing in for the socket. */
class FakeTransport implements Transport {
  readonly sent: ClientMessage[] = [];
  #handlers: TransportHandlers;

  constructor(handlers: TransportHandlers) {
    this.#handlers = handlers;
    // Open on the next tick, so `connect()` behaves like a real socket.
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

  last<T extends ClientMessage['type']>(type: T): Extract<ClientMessage, { type: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const message = this.sent[i];
      if (message?.type === type) return message as Extract<ClientMessage, { type: T }>;
    }
    return undefined;
  }
}

function renderMatchApp(decks: readonly SavedDeck[] = [savedDeck]) {
  let transport: FakeTransport | undefined;
  const factory: TransportFactory = (handlers) => {
    transport = new FakeTransport(handlers);
    return transport;
  };

  const store = new MemoryStore();
  store.setItem(DECK_STORAGE_KEY, JSON.stringify({ schemaVersion: 1, decks }));

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
    client,
    transport: () => {
      if (!transport) throw new Error('Transport was never created');
      return transport;
    },
  };
}

async function openPlayTab(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'Play' }));
}

describe('lobby screen', () => {
  it('creates a lobby and shows the invite code to share', async () => {
    const harness = renderMatchApp();
    await openPlayTab(harness.user);

    await clickCreateLobby(harness);

    await waitFor(() => expect(harness.transport().last('create_lobby')).toBeDefined());
    expect(harness.transport().last('create_lobby')?.versions).toEqual(CURRENT_VERSIONS);

    harness.transport().deliver({
      type: 'lobby_joined',
      versions: CURRENT_VERSIONS,
      seatId: 'seat_1',
      reconnectToken: 'a'.repeat(32),
      lobby: {
        inviteCode: 'ABC123',
        status: 'waiting',
        seats: [
          {
            seatId: 'seat_1',
            displayName: 'Player',
            connected: true,
            ready: false,
            deckName: null,
            deckLegal: false,
            isHost: true,
          },
        ],
      },
    });

    expect(await screen.findByText('ABC123')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for an opponent/)).toBeInTheDocument();
  });

  it('surfaces a version mismatch as an actionable message', async () => {
    const harness = renderMatchApp();
    await openPlayTab(harness.user);
    await clickCreateLobby(harness);

    harness.transport().deliver({
      type: 'error',
      error: {
        code: 'protocol/version_mismatch',
        message: 'This client is not compatible with the server.',
        details: ['rules 0.1.0 vs server 0.2.0'],
      },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/not compatible/);
    expect(screen.getByRole('alert')).toHaveTextContent(/rules 0.1.0/);
  });

  it('rejects a deck the server refuses, and explains why', async () => {
    const harness = renderMatchApp();
    await openPlayTab(harness.user);
    await clickCreateLobby(harness);

    // The deck panel only exists once the seat is in a lobby.
    harness.transport().deliver({
      type: 'lobby_joined',
      versions: CURRENT_VERSIONS,
      seatId: 'seat_1',
      reconnectToken: 'b'.repeat(32),
      lobby: {
        inviteCode: 'DEF456',
        status: 'waiting',
        seats: [
          {
            seatId: 'seat_1',
            displayName: 'Player',
            connected: true,
            ready: false,
            deckName: 'UI Test Deck',
            deckLegal: false,
            isHost: true,
          },
        ],
      },
    });

    harness.transport().deliver({
      type: 'deck_rejected',
      error: {
        code: 'protocol/deck_illegal',
        message: '"UI Test Deck" is not legal in this format.',
        details: ['Deck has 2 of 30 cards — add 28 more.'],
      },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/not legal/);
  });
});

async function clickCreateLobby(harness: ReturnType<typeof renderMatchApp>): Promise<void> {
  await harness.user.click(await screen.findByRole('button', { name: 'Create a lobby' }));
}

describe('match board', () => {
  async function boardWithState(state: MatchState) {
    const harness = renderMatchApp();
    await openPlayTab(harness.user);
    await clickCreateLobby(harness);

    harness.transport().deliver({
      type: 'match_state',
      view: viewFor(state, 'player_1'),
      events: [],
    });
    return harness;
  }

  it('renders both players, the phase and the local hand only', async () => {
    const state = engineState();
    await boardWithState(state);

    expect(await screen.findByLabelText('Match board')).toBeInTheDocument();
    expect(screen.getByText(/You \(you\)/)).toBeInTheDocument();
    expect(screen.getByText('Rival')).toBeInTheDocument();

    // The viewer's hand is rendered by name; the opponent's is only a count.
    const hand = screen.getByLabelText('Your hand');
    expect(hand.querySelectorAll('button').length).toBe(state.players.player_1?.hand.length);

    const opponentHand = state.players.player_2?.hand ?? [];
    for (const instanceId of opponentHand) {
      expect(screen.queryByText(instanceId)).not.toBeInTheDocument();
    }
    // No opponent card name leaks into the DOM.
    expect(document.body.textContent).not.toContain('Thornback Calf');
  });

  it('sends a mulligan against the exact revision the player saw, then locks input', async () => {
    const state = engineState();
    const harness = await boardWithState(state);

    const keep = await screen.findByRole('button', { name: 'Keep hand' });
    await harness.user.click(keep);

    const submitted = harness.transport().last('submit_action');
    expect(submitted?.action).toEqual({
      type: 'mulligan',
      playerId: 'player_1',
      returnInstanceIds: [],
    });
    expect(submitted?.lastSequence).toBe(state.sequence);
    expect(submitted?.actionId).toBeTruthy();

    // Input is locked until the server answers.
    await waitFor(() => expect(screen.getByText('sending…')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Keep hand' })).toBeDisabled();
  });

  it('re-enables input and shows the reason when the server rejects an action', async () => {
    const state = engineState();
    const harness = await boardWithState(state);

    await harness.user.click(await screen.findByRole('button', { name: 'Keep hand' }));
    const actionId = harness.transport().last('submit_action')?.actionId ?? '';

    harness.transport().deliver({
      type: 'action_rejected',
      actionId,
      error: {
        code: 'protocol/stale_revision',
        message: 'The match moved on before this action arrived.',
      },
    });

    expect(await screen.findByRole('alert')).toHaveTextContent(/moved on/);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Keep hand' })).not.toBeDisabled(),
    );
  });

  it('shows a readable, chronological log built from public events', async () => {
    await boardWithState(engineState());

    const log = await screen.findByLabelText('Game log');
    expect(log.textContent).toContain('Match begins');
  });

  it('warns when the opponent disconnects and clears it when they return', async () => {
    const state = engineState();
    const harness = await boardWithState(state);

    harness.transport().deliver({
      type: 'opponent_connection',
      seatId: 'seat_2',
      connected: false,
      graceSeconds: 90,
    });
    expect(await screen.findByText(/disconnected · 90s/)).toBeInTheDocument();

    harness.transport().deliver({
      type: 'opponent_connection',
      seatId: 'seat_2',
      connected: true,
      graceSeconds: null,
    });
    await waitFor(() => expect(screen.queryByText(/disconnected · 90s/)).not.toBeInTheDocument());
  });
});

describe('deck builder is unaffected', () => {
  it('still opens and keeps working alongside the match screen', async () => {
    const harness = renderMatchApp();
    await openPlayTab(harness.user);
    expect(await screen.findByLabelText('Match lobby')).toBeInTheDocument();

    await harness.user.click(screen.getByRole('button', { name: 'Deck Builder' }));
    expect(await screen.findByLabelText('Card browser')).toBeInTheDocument();
  });
});
