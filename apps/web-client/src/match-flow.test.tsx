import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
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
            controller: 'human',
            bot: null,
          },
        ],
      },
    });

    expect(await screen.findByText('ABC123')).toBeInTheDocument();
    expect(screen.getByText(/Waiting for a player/)).toBeInTheDocument();
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
        maxSeats: 2,
        hostSeatId: 'seat_1',
        canStart: false,
        seats: [
          {
            seatId: 'seat_1',
            displayName: 'Player',
            connected: true,
            ready: false,
            deckName: 'UI Test Deck',
            deckLegal: false,
            isHost: true,
            graceSeconds: null,
            eliminated: false,
            controller: 'human',
            bot: null,
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

  /** Puts the seat in a lobby, which is where the deck panel exists. */
  async function enterLobby(harness: ReturnType<typeof renderMatchApp>): Promise<void> {
    await openPlayTab(harness.user);
    await clickCreateLobby(harness);
    harness.transport().deliver({
      type: 'lobby_joined',
      versions: CURRENT_VERSIONS,
      seatId: 'seat_1',
      reconnectToken: 'c'.repeat(32),
      lobby: {
        inviteCode: 'PRE001',
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
            controller: 'human',
            bot: null,
          },
        ],
      },
    });
    await screen.findByText('PRE001');
  }

  it('offers the built-in precons for the active format beside saved decks', async () => {
    const harness = renderMatchApp();
    await enterLobby(harness);

    const picker = screen.getByLabelText('Deck');
    for (const name of [
      'Bastion Guardians',
      'Containment Control',
      'Goblin Swarm',
      'Grave Sacrifice',
    ])
      expect(within(picker).getByRole('option', { name })).toBeInTheDocument();
    expect(within(picker).getByRole('option', { name: 'UI Test Deck' })).toBeInTheDocument();
  });

  it('submits a precon as an ID, sending no card list at all', async () => {
    const harness = renderMatchApp();
    await enterLobby(harness);

    await harness.user.selectOptions(screen.getByLabelText('Deck'), 'precon:precon_goblin_swarm');
    await harness.user.click(screen.getByRole('button', { name: 'Submit deck' }));

    const submitted = harness.transport().last('submit_precon');
    // The whole message: the server resolves the list from its own content, so
    // there is nothing here for a client to tamper with (M03.2).
    expect(submitted).toEqual({ type: 'submit_precon', preconId: 'precon_goblin_swarm' });
    expect(harness.transport().last('submit_deck')).toBeUndefined();
  });

  it('still submits an edited deck by its contents', async () => {
    const harness = renderMatchApp();
    await enterLobby(harness);

    await harness.user.selectOptions(screen.getByLabelText('Deck'), `deck:${savedDeck.id}`);
    await harness.user.click(screen.getByRole('button', { name: 'Submit deck' }));

    expect(harness.transport().last('submit_deck')?.deck).toEqual(savedDeck);
    expect(harness.transport().last('submit_precon')).toBeUndefined();
  });

  it('previews a precon with the same review the server will run', async () => {
    // `reviewPrecon` is shared, so the preview cannot promise a legality the
    // server withholds. A shipped precon is legal, so nothing is flagged.
    const harness = renderMatchApp();
    await enterLobby(harness);

    await harness.user.selectOptions(screen.getByLabelText('Deck'), 'precon:precon_goblin_swarm');

    expect(screen.getByText(/Playing the built-in/)).toBeInTheDocument();
    expect(screen.queryByText(/not legal yet/)).not.toBeInTheDocument();
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
    expect(screen.getByText(/seat \d+: Rival/)).toBeInTheDocument();

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
      type: 'seat_connection',
      seatId: 'seat_2',
      connected: false,
      graceSeconds: 90,
    });
    expect(await screen.findByText(/disconnected · 90s/)).toBeInTheDocument();

    harness.transport().deliver({
      type: 'seat_connection',
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

/* ------------------------------------------------ Phase 3: the four-seat table */

/** A four-player table with a known seat order, so assertions can name seats. */
function ffaState(): MatchState {
  return unwrap(
    createMatch({
      matchId: 'ui_ffa',
      seed: 'ui-ffa-seed',
      database,
      preserveSeatOrder: true,
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
        {
          playerId: 'player_3',
          name: 'Third',
          deck: deckFor('prototype_commander_red', 'goblin_scout'),
        },
        {
          playerId: 'player_4',
          name: 'Fourth',
          deck: deckFor('prototype_commander_green', 'thornback_calf'),
        },
      ],
    }),
    'ffa setup',
  ).state;
}

describe('free-for-all match board', () => {
  /** Renders the board against an arbitrary authoritative view. */
  async function boardWithView(view: PlayerView) {
    const harness = renderMatchApp();
    await openPlayTab(harness.user);
    await clickCreateLobby(harness);
    harness.transport().deliver({ type: 'match_state', view, events: [] });
    await screen.findByLabelText('Match board');
    return harness;
  }

  it('shows all four seats, with the local player marked and the rest in seat order', async () => {
    const view = viewFor(ffaState(), 'player_1');
    await boardWithView(view);

    expect(screen.getByText(/You \(you\)/)).toBeInTheDocument();
    for (const name of ['Rival', 'Third', 'Fourth']) {
      expect(screen.getByText(new RegExp(`seat \\d+: ${name}`))).toBeInTheDocument();
    }

    // Opponents are laid out clockwise starting after the viewer, not in
    // whatever order the players array happens to hold. Each seat's battlefield
    // is one labelled region, so DOM order is the rendered table order.
    const battlefields = screen
      .getAllByLabelText(/ battlefield$/)
      .map((node) => node.getAttribute('aria-label'));
    expect(battlefields).toEqual([
      'Rival battlefield',
      'Third battlefield',
      'Fourth battlefield',
      'Your battlefield',
    ]);
  });

  it('never leaks another seat’s hand at a four-player table', async () => {
    const state = ffaState();
    await boardWithView(viewFor(state, 'player_1'));

    for (const playerId of ['player_2', 'player_3', 'player_4'] as const) {
      for (const instanceId of state.players[playerId]?.hand ?? []) {
        expect(screen.queryByText(instanceId)).not.toBeInTheDocument();
      }
    }
    expect(document.body.textContent).not.toContain('Thornback Calf');
  });

  it('switches an eliminated player to spectator mode automatically', async () => {
    const state = ffaState();
    const eliminated = unwrap(
      applyAction(state, { type: 'concede', playerId: 'player_1' }, { database }),
      'concede',
    ).state;
    // Three players remain, so the match is still running around the spectator.
    expect(eliminated.status).not.toBe('complete');

    await boardWithView(viewFor(eliminated, 'player_1'));

    expect(screen.getByText('Spectating')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(/out of the match/i);
    // The concede control becomes a plain exit: there is nothing left to concede.
    expect(screen.getByRole('button', { name: 'Leave' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Concede and leave' })).not.toBeInTheDocument();
    // And no gameplay control is offered.
    expect(screen.queryByRole('button', { name: 'Keep hand' })).not.toBeInTheDocument();
  });

  it('names the defenders it is still waiting on without showing their blocks', async () => {
    const base = viewFor(ffaState(), 'player_1');
    const view: PlayerView = {
      ...base,
      legalActions: { ...base.legalActions, awaitingDefenders: ['player_2', 'player_4'] },
    };
    await boardWithView(view);

    const waiting = screen.getByText(/waiting for blockers:/);
    expect(waiting).toHaveTextContent('Rival');
    expect(waiting).toHaveTextContent('Fourth');
    // The seat that already answered is not listed as outstanding.
    expect(waiting).not.toHaveTextContent('Third');
    // Nothing about what anyone tentatively assigned is on screen.
    expect(view.combat.submissions).toEqual([]);
  });

  it('makes each attacker’s target explicit and editable before confirming', async () => {
    const base = viewFor(ffaState(), 'player_1');
    const attacker = 'inst_attacker';
    const view: PlayerView = {
      ...base,
      status: 'playing',
      phase: 'declare_attackers',
      legalActions: {
        ...base.legalActions,
        mulligan: null,
        canPassPhase: false,
        attacking: {
          legalAttackers: [attacker],
          legalDefenders: ['player_2', 'player_3', 'player_4'],
        },
      },
      players: base.players.map((player) =>
        player.playerId === 'player_1' ? { ...player, units: [attacker] } : player,
      ),
      instances: {
        ...base.instances,
        [attacker]: {
          instanceId: attacker,
          definitionId: 'goblin_scout',
          owner: 'player_1',
          controller: 'player_1',
          zone: 'battlefield',
          attack: 2,
          health: 1,
          markedDamage: 0,
          exhausted: false,
          summoningSick: false,
          keywords: [],
          isToken: false,
          willNotReady: false,
          barrierSpent: false,
          // A unit on the battlefield has nothing to pay to play.
          energyCost: null,
        },
      },
    };

    const harness = await boardWithView(view);
    // Scoped to the battlefield: the viewer's hand holds Goblin Scouts too.
    const unit = (): HTMLElement =>
      within(screen.getByLabelText('Your battlefield')).getByRole('button', {
        name: /Goblin Scout/,
      });

    // Every living opponent is offered as a target, not just one.
    await harness.user.click(unit());
    for (const name of ['Rival', 'Third', 'Fourth']) {
      expect(screen.getByRole('button', { name: `Attack ${name}` })).toBeInTheDocument();
    }

    // Aiming at a seat shows the pairing on the attacker itself.
    await harness.user.click(screen.getByRole('button', { name: 'Attack Third' }));
    expect(unit()).toHaveTextContent('→ Third');

    // The declaration stays editable: clicking clears it, and it can be re-aimed.
    await harness.user.click(unit());
    expect(unit()).not.toHaveTextContent('→ Third');
    await harness.user.click(unit());
    await harness.user.click(screen.getByRole('button', { name: 'Attack Fourth' }));
    expect(unit()).toHaveTextContent('→ Fourth');

    await harness.user.click(screen.getByRole('button', { name: 'Confirm 1 attacker(s)' }));
    expect(harness.transport().last('submit_action')?.action).toEqual({
      type: 'declare_attackers',
      playerId: 'player_1',
      attacks: [{ attackerInstanceId: attacker, defenderPlayerId: 'player_4' }],
    });
  });

  /* ------------------------------------------- M06.1: Token stacks on screen */

  /** A crowd of Tokens on the viewer's own battlefield, one of them damaged. */
  function tokenBoard(): PlayerView {
    const base = viewFor(ffaState(), 'player_1');
    const tokens = Array.from({ length: 12 }, (_, index) => ({
      instanceId: `tok_${index + 1}`,
      definitionId: 'prototype_soldier_token',
      owner: 'player_1',
      controller: 'player_1',
      zone: 'battlefield' as const,
      attack: 1,
      health: 1,
      // The last one has taken a hit, so it is a different game object to
      // anyone deciding what to block with, and must not hide inside the tile.
      markedDamage: index === 11 ? 1 : 0,
      exhausted: false,
      summoningSick: false,
      keywords: [],
      isToken: true,
      willNotReady: false,
      barrierSpent: false,
      energyCost: null,
    }));
    return {
      ...base,
      status: 'playing',
      players: base.players.map((player) =>
        player.playerId === 'player_1'
          ? { ...player, units: tokens.map((token) => token.instanceId) }
          : player,
      ),
      instances: {
        ...base.instances,
        ...Object.fromEntries(tokens.map((token) => [token.instanceId, token])),
      },
    };
  }

  const ownBoard = (): HTMLElement => screen.getByLabelText('Your battlefield');
  /**
   * The stack tile, found by its accessible name (M06.2). It says "stack of
   * 11" in words rather than "×11", which is also what keeps it distinct from
   * the eleven members named "Soldier 1 of 11" underneath it.
   */
  const stackTile = (): HTMLElement =>
    within(ownBoard()).getByRole('button', { name: /Soldier stack of 11/ });

  it('draws identical Tokens as one counted tile, and the odd one out on its own', async () => {
    await boardWithView(tokenBoard());

    // Eleven identical Tokens become one tile; the damaged twelfth is its own
    // card, because it is not interchangeable with them.
    expect(stackTile()).toHaveAttribute('aria-expanded', 'false');
    expect(stackTile()).toHaveTextContent('Show all 11');
    expect(within(ownBoard()).getAllByRole('button')).toHaveLength(2);
  });

  it('expands a tile into its individual Tokens and folds it back', async () => {
    const harness = await boardWithView(tokenBoard());

    await harness.user.click(stackTile());
    expect(stackTile()).toHaveAttribute('aria-expanded', 'true');
    // The tile plus eleven addressable members plus the damaged single.
    expect(within(ownBoard()).getAllByRole('button')).toHaveLength(13);

    await harness.user.click(stackTile());
    expect(within(ownBoard()).getAllByRole('button')).toHaveLength(2);
  });

  it('shows every Token individually when stacking is turned off', async () => {
    const harness = await boardWithView(tokenBoard());
    await harness.user.click(screen.getByRole('button', { name: 'Stack tokens' }));

    // Twelve Tokens, twelve cards, no tile, and nothing sent to the server:
    // grouping is presentation and the toggle proves it.
    expect(within(ownBoard()).getAllByRole('button')).toHaveLength(12);
    expect(
      within(ownBoard()).queryByRole('button', { name: /Soldier stack of 11/ }),
    ).not.toBeInTheDocument();
    expect(harness.transport().sent.some((message) => message.type === 'submit_action')).toBe(
      false,
    );
  });

  /* ------------------------------------ M06.2: picking one Token out of a stack */

  /** The same crowd, with every Token a legal attacker. */
  function attackReadyTokenBoard(): PlayerView {
    const base = tokenBoard();
    const units = base.players.find((player) => player.playerId === 'player_1')?.units ?? [];
    return {
      ...base,
      phase: 'declare_attackers',
      legalActions: {
        ...base.legalActions,
        mulligan: null,
        canPassPhase: false,
        attacking: {
          legalAttackers: [...units],
          legalDefenders: ['player_2', 'player_3', 'player_4'],
        },
      },
    };
  }

  it('aims exact Tokens out of a stack, and gathers the aimed ones into their own tile', async () => {
    const harness = await boardWithView(attackReadyTokenBoard());
    const member = (name: string): HTMLElement => within(ownBoard()).getByRole('button', { name });

    await harness.user.click(stackTile());
    // Eleven identical Tokens are eleven individually named buttons, so a
    // person and a screen reader can both say which one is attacking.
    await harness.user.click(member('Soldier 1 of 11'));
    await harness.user.click(screen.getByRole('button', { name: 'Attack Rival' }));

    // The aimed Token has left the tile it was drawn in.
    expect(within(ownBoard()).getByRole('button', { name: /Soldier stack of 10/ })).toBeVisible();

    await harness.user.click(member('Soldier 1 of 10'));
    await harness.user.click(screen.getByRole('button', { name: 'Attack Rival' }));

    // And the two aimed the same way are one tile of their own — which is
    // exactly where the engine's `attacking` puts them once this is confirmed,
    // so confirming does not rearrange the board under the player.
    expect(
      within(ownBoard()).getByRole('button', { name: /Soldier stack of 2 —.*→ Rival/ }),
    ).toBeVisible();
    expect(within(ownBoard()).getByRole('button', { name: /Soldier stack of 9/ })).toBeVisible();

    await harness.user.click(screen.getByRole('button', { name: 'Confirm 2 attacker(s)' }));
    // Exact instances, not a stack: the engine is told which two Tokens.
    expect(harness.transport().last('submit_action')?.action).toEqual({
      type: 'declare_attackers',
      playerId: 'player_1',
      attacks: [
        { attackerInstanceId: 'tok_1', defenderPlayerId: 'player_2' },
        { attackerInstanceId: 'tok_2', defenderPlayerId: 'player_2' },
      ],
    });
  });

  /** The same crowd, with the game asking which one to sacrifice. */
  function sacrificeChoiceBoard(): PlayerView {
    const base = tokenBoard();
    const units = base.players.find((player) => player.playerId === 'player_1')?.units ?? [];
    return {
      ...base,
      awaitingChoiceFrom: 'player_1',
      pendingChoice: {
        id: 'choice_sac',
        playerId: 'player_1',
        type: 'select_units',
        reason: 'sacrifice_cost',
        zone: 'battlefield',
        minimum: 1,
        maximum: 1,
        validEntityIds: [...units],
        ordered: false,
        sourceInstanceId: null,
        provenance: {
          origin: 'cost',
          itemId: null,
          effectIndex: null,
          effectType: null,
          sourceControllerId: 'player_1',
          chooser: 'source_controller',
          targetRelation: 'self',
          intent: 'detriment',
        },
        continuation: {
          kind: 'cost_selection',
          intent: { kind: 'play_card', instanceId: 'tok_1' },
          paid: {},
          costIndex: 0,
        },
      },
    };
  }

  it('answers a choice with one exact Token out of a stack', async () => {
    const harness = await boardWithView(sacrificeChoiceBoard());
    // Scoped to the question: the same Tokens are on the battlefield above it.
    const panel = (): HTMLElement => screen.getByLabelText('Pending choice');

    await harness.user.click(within(panel()).getByRole('button', { name: /Soldier stack of 11/ }));
    await harness.user.click(within(panel()).getByRole('button', { name: 'Soldier 3 of 11' }));

    // The ticked option leaves the tile, so what has been answered is legible
    // without expanding anything.
    expect(within(panel()).getByRole('button', { name: /Soldier stack of 10/ })).toBeVisible();

    await harness.user.click(within(panel()).getByRole('button', { name: 'Confirm' }));
    expect(harness.transport().last('submit_action')?.action).toEqual({
      type: 'submit_choice',
      playerId: 'player_1',
      choiceId: 'choice_sac',
      selectedIds: ['tok_3'],
    });
  });

  /** The same crowd, with two of them offering the same activated ability. */
  function abilityTokenBoard(): PlayerView {
    const base = tokenBoard();
    return {
      ...base,
      legalActions: {
        ...base.legalActions,
        mulligan: null,
        activatableAbilities: [
          { sourceInstanceId: 'tok_1', abilityId: 'scrap_charge', energyCost: 1 },
          { sourceInstanceId: 'tok_2', abilityId: 'scrap_charge', energyCost: 1 },
        ],
      },
    };
  }

  it('activates the exact source, even when two identical Tokens offer the ability', async () => {
    const harness = await boardWithView(abilityTokenBoard());

    // One row per ability rather than one per source, and it says which cards
    // are offering it: two bare "Ability: scrap charge" buttons named nothing.
    await harness.user.click(
      screen.getByRole('button', { name: /Ability: scrap charge \(1⚡\) stack of 2/ }),
    );
    await harness.user.click(
      screen.getByRole('button', { name: 'Ability: scrap charge (1⚡) — Soldier 2 of 2' }),
    );

    expect(harness.transport().last('submit_action')?.action).toEqual({
      type: 'activate_ability',
      playerId: 'player_1',
      sourceInstanceId: 'tok_2',
      abilityId: 'scrap_charge',
    });
  });

  it('opens, names and closes a stack from the keyboard alone', async () => {
    const harness = await boardWithView(attackReadyTokenBoard());

    stackTile().focus();
    await harness.user.keyboard('{Enter}');
    expect(stackTile()).toHaveAttribute('aria-expanded', 'true');

    // The members are a labelled region carrying the count, and every member
    // has a name of its own.
    const members = within(ownBoard()).getByRole('group', { name: 'Soldier, 11 selectable' });
    expect(within(members).getAllByRole('button')).toHaveLength(11);
    expect(stackTile()).toHaveAttribute('aria-controls', members.id);

    within(members).getByRole('button', { name: 'Soldier 7 of 11' }).focus();
    await harness.user.keyboard('{Escape}');

    // Escape closes the stack and hands focus back to it, rather than leaving
    // the player to tab out past a hundred Tokens.
    expect(stackTile()).toHaveAttribute('aria-expanded', 'false');
    expect(stackTile()).toHaveFocus();
  });
});
