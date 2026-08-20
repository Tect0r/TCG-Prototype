import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { loadBundledCardData } from '@tcg/card-data';
import {
  DEFAULT_BOT_PACING_BUDGETS,
  IMMEDIATE_BOT_PACING,
  MAX_BUDGET_SECONDS,
  PACING_CONFIG_VERSION,
  PACING_SAFETY_MARGIN_MS,
  type BotPacing,
  type BotPacingBudgets,
} from '@tcg/bot-config';
import { DECK_SCHEMA_VERSION, DECK_STORAGE_KEY, MemoryStore, type SavedDeck } from '@tcg/deck';
import {
  CURRENT_VERSIONS,
  decodeClientMessage,
  encode,
  type BotLobbySeatView,
  type ClientMessage,
  type HumanLobbySeatView,
  type LobbySeatView,
  type LobbyView,
  type SeatId,
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
 * Bot pacing configuration and its screens (M09.11).
 *
 * The claims are the milestone's own: the host can set the table's two budgets
 * and each bot's percentage, every percentage prints the seconds it implies,
 * 0/50/100% and the Reaction override are all reachable, the safety margin is
 * stated rather than left as a surprise, the whole thing is locked and shown as
 * provenance once the match starts, and the screen is honest that this build
 * records the timings without waiting for them.
 *
 * Driven through the same fake transport the other bot flows use, carrying real
 * protocol frames: every view below is encoded and decoded on its way in, so a
 * fixture this file builds by hand is one the wire would actually accept.
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

function botSeat(pacing: BotPacing, overrides: Partial<BotLobbySeatView> = {}): BotLobbySeatView {
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
      pacing,
    },
    ...overrides,
  };
}

function lobby(
  seats: readonly LobbySeatView[],
  overrides: Partial<LobbyView> = {},
  budgets: BotPacingBudgets = DEFAULT_BOT_PACING_BUDGETS,
): LobbyView {
  return {
    inviteCode: 'PAC001',
    status: 'waiting',
    maxSeats: 2,
    hostSeatId: 'seat_1',
    canStart: false,
    seats: [...seats],
    botPacing: budgets,
    ...overrides,
  };
}

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
const budgetForm = (): HTMLElement => screen.getByLabelText('Bot pacing budgets');

/* ------------------------------------------------------------ table budgets */

describe('the table’s pacing budgets', () => {
  it('shows the two the server sent, and says they are not human timers', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    expect(screen.getByLabelText('Bot decision budget (seconds)')).toHaveValue(30);
    expect(screen.getByLabelText('Bot Reaction budget (seconds)')).toHaveValue(5);
    expect(within(budgetForm()).getByText(/pace bots only/i)).toBeInTheDocument();
    expect(within(budgetForm()).getByText(/times you out of a phase/i)).toBeInTheDocument();
  });

  it('states the safety margin rather than leaving 100% to surprise anybody', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    // The number comes from `@tcg/bot-config`, so the sentence cannot drift
    // away from the arithmetic the scheduler will use.
    const margin = `${PACING_SAFETY_MARGIN_MS / 1000} s`;
    expect(within(budgetForm()).getByText(new RegExp(margin.replace('.', '\\.')))).toBeVisible();
  });

  it('sends a whole budget record when the host changes one of them', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    const ordinary = screen.getByLabelText('Bot decision budget (seconds)');
    await harness.user.clear(ordinary);
    await harness.user.type(ordinary, '45');

    // A whole record, so "what this table is set to" has one representation on
    // the wire and the untouched budget travels with the changed one.
    expect(harness.transport().last('set_bot_pacing')).toEqual({
      type: 'set_bot_pacing',
      budgets: { pacingVersion: PACING_CONFIG_VERSION, ordinarySeconds: 45, reactionSeconds: 5 },
    });
  });

  it('sends nothing the server would refuse', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    const reaction = screen.getByLabelText('Bot Reaction budget (seconds)');
    await harness.user.clear(reaction);
    // Empty is not a budget, and neither is one past the supported ceiling.
    expect(harness.transport().all('set_bot_pacing')).toHaveLength(0);

    await harness.user.type(reaction, String(MAX_BUDGET_SECONDS + 1));
    const sent = harness.transport().all('set_bot_pacing');
    for (const message of sent) {
      expect(message.budgets.reactionSeconds).toBeLessThanOrEqual(MAX_BUDGET_SECONDS);
    }
  });

  it('recomputes the seconds beside a percentage when the budget changes', async () => {
    const harness = renderApp();
    await enterLobby(
      harness,
      lobby([humanSeat(), botSeat({ percent: 50, reactionPercent: null })]),
    );

    expect(within(panel()).getByText(/50% of 30 s — 15 s before a decision/)).toBeInTheDocument();

    harness.transport().deliver({
      type: 'lobby_updated',
      lobby: lobby(
        [humanSeat(), botSeat({ percent: 50, reactionPercent: null })],
        {},
        {
          pacingVersion: PACING_CONFIG_VERSION,
          ordinarySeconds: 10,
          reactionSeconds: 2,
        },
      ),
    });

    expect(
      await within(panel()).findByText(/50% of 10 s — 5 s before a decision/),
    ).toBeInTheDocument();
  });
});

/* ------------------------------------------------------------- the per-bot dial */

describe('one bot’s timing', () => {
  it('sends the percentage the host picked, and prints the seconds beside it', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    await harness.user.selectOptions(screen.getByLabelText('Bot timing'), '50');
    expect(within(panel()).getByText(/50% of 30 s — 15 s before a decision/)).toBeInTheDocument();

    await harness.user.click(screen.getByRole('button', { name: 'Add a bot' }));
    expect(harness.transport().last('add_bot')?.setup.pacing).toEqual({
      percent: 50,
      reactionPercent: null,
    });
  });

  it('offers 0 and 100, and stops one safety margin short at 100', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    // 0% is exactly nothing: an immediate bot must not acquire a delay by
    // rounding.
    expect(within(panel()).getByText(/0% of 30 s — 0 s before a decision/)).toBeInTheDocument();

    await harness.user.selectOptions(screen.getByLabelText('Bot timing'), '100');
    expect(within(panel()).getByText(/100% of 30 s — 29\.75 s/)).toBeInTheDocument();

    await harness.user.click(screen.getByRole('button', { name: 'Add a bot' }));
    expect(harness.transport().last('add_bot')?.setup.pacing.percent).toBe(100);
  });

  it('inherits the Reaction percentage until the host overrides it', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    await harness.user.selectOptions(screen.getByLabelText('Bot timing'), '40');
    // Inheriting says so, because "40%" beside a Reaction budget means two
    // different configurations and only one of them follows the dial above.
    expect(
      within(panel()).getByText(/40% \(inherited\) of 5 s — 2 s in a Reaction window/),
    ).toBeInTheDocument();
    expect(screen.queryByLabelText('Bot Reaction timing')).not.toBeInTheDocument();

    await harness.user.click(screen.getByLabelText('Bot Reaction override'));
    // Turning the override on changes nothing until the host moves it.
    expect(screen.getByLabelText('Bot Reaction timing')).toHaveValue('40');

    await harness.user.selectOptions(screen.getByLabelText('Bot Reaction timing'), '0');
    expect(within(panel()).getByText(/0% of 5 s — 0 s in a Reaction window/)).toBeInTheDocument();

    await harness.user.click(screen.getByRole('button', { name: 'Add a bot' }));
    // An override of 0 is not "inherit", and the wire distinguishes them.
    expect(harness.transport().last('add_bot')?.setup.pacing).toEqual({
      percent: 40,
      reactionPercent: 0,
    });
  });

  it('turning the override off goes back to inheriting rather than to zero', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    await harness.user.selectOptions(screen.getByLabelText('Bot timing'), '40');
    await harness.user.click(screen.getByLabelText('Bot Reaction override'));
    await harness.user.selectOptions(screen.getByLabelText('Bot Reaction timing'), '0');
    await harness.user.click(screen.getByLabelText('Bot Reaction override'));

    await harness.user.click(screen.getByRole('button', { name: 'Add a bot' }));
    expect(harness.transport().last('add_bot')?.setup.pacing).toEqual({
      percent: 40,
      reactionPercent: null,
    });
  });

  it('shows a seated bot the timing it is actually set to', async () => {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), botSeat({ percent: 70, reactionPercent: 20 })]));

    expect(screen.getByLabelText('Seat 2 timing')).toHaveValue('70');
    expect(screen.getByLabelText('Seat 2 Reaction timing')).toHaveValue('20');
    // Nothing to apply: the form shows the seat rather than a default.
    expect(screen.getByRole('button', { name: 'Apply seat 2 changes' })).toBeDisabled();

    await harness.user.selectOptions(screen.getByLabelText('Seat 2 timing'), '10');
    await harness.user.click(screen.getByRole('button', { name: 'Apply seat 2 changes' }));
    expect(harness.transport().last('update_bot')?.setup.pacing).toEqual({
      percent: 10,
      reactionPercent: 20,
    });
  });

  it('says the numbers are a real wait, and what 0% means', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    // M09.11 shipped this line as a warning that the control did nothing.
    // M09.12 spends it, so the panel states the behaviour — and still says what
    // the default does, because 0% is what a new bot is seated at.
    expect(within(panel()).getByText(/Bots wait for the seconds shown/)).toBeInTheDocument();
    expect(within(panel()).getByText(/a seat left at 0% answers immediately/)).toBeInTheDocument();
    expect(within(panel()).queryByText(/still answer immediately in this build/)).toBeNull();
  });
});

/* ------------------------------------------------------------ what a guest sees */

describe('every seat can read a bot’s timing', () => {
  it('tags the seat with the percentage and the seconds, for a guest too', async () => {
    const harness = renderApp();
    await enterLobby(
      harness,
      lobby(
        [
          humanSeat(),
          botSeat({ percent: 50, reactionPercent: null }),
          humanSeat({ seatId: 'seat_3', displayName: 'Guest', isHost: false }),
        ],
        { maxSeats: 3 },
      ),
      'seat_3',
    );

    const seat = within(screen.getByLabelText('Seats')).getByText('Bot 2').closest('li');
    expect(seat).not.toBeNull();
    expect(within(seat as HTMLElement).getByText('50% · 15 s')).toBeInTheDocument();
    // And still none of the host's controls.
    expect(screen.queryByLabelText('Bot pacing budgets')).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------------------------- the lock */

describe('once the match has started', () => {
  const started = (pacing: BotPacing, budgets: BotPacingBudgets) =>
    lobby(
      [humanSeat({ ready: true, deckLegal: true }), botSeat(pacing)],
      { status: 'in_match', canStart: false },
      budgets,
    );

  it('replaces the controls with what the match locked', async () => {
    const harness = renderApp();
    await enterLobby(
      harness,
      started(
        { percent: 50, reactionPercent: 10 },
        {
          pacingVersion: PACING_CONFIG_VERSION,
          ordinarySeconds: 20,
          reactionSeconds: 4,
        },
      ),
    );

    expect(screen.queryByLabelText('Bot pacing budgets')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Seat 2 timing')).not.toBeInTheDocument();
    expect(within(panel()).getByText(/Locked bot pacing: 20 s for a decision/)).toBeInTheDocument();
    expect(within(panel()).getByText(/50% of 20 s — 10 s before a decision/)).toBeInTheDocument();
    expect(
      within(panel()).getByText(/10% of 4 s — 0\.4 s in a Reaction window/),
    ).toBeInTheDocument();
  });
});

/* --------------------------------------------------------- the result summary */

describe('the pacing summary beside the result', () => {
  async function board(
    complete: boolean,
    seatPacing: BotPacing = { percent: 50, reactionPercent: null },
  ): Promise<Harness> {
    const harness = renderApp();
    await enterLobby(
      harness,
      lobby([humanSeat({ ready: true, deckLegal: true }), botSeat(seatPacing)], {
        status: 'in_match',
        canStart: false,
      }),
    );

    const deck: MatchDeck = {
      commanderId: 'prototype_commander_red',
      cards: [{ cardId: 'goblin_scout', quantity: 30 }],
    };
    const state = unwrap(
      createMatch({
        matchId: 'pacing_test',
        seed: 'pacing-seed',
        database,
        seats: [
          { playerId: 'player_1', name: 'Player', deck },
          { playerId: 'player_2', name: 'Bot 2', deck },
        ],
      }),
      'match setup',
    ).state;

    const view = playerView(state, 'player_1', database);
    harness.transport().deliver({
      type: 'match_state',
      // The completion is the server's to declare; the summary renders what it
      // is told rather than deciding for itself that the match is over.
      view: complete ? { ...view, status: 'complete' } : view,
      events: [],
    });
    await screen.findByLabelText('Match board');
    return harness;
  }

  it('says nothing while the match is still being played', async () => {
    await board(false);
    expect(screen.queryByLabelText('Bot pacing')).not.toBeInTheDocument();
  });

  it('quotes the locked budgets and every bot’s timing once it is over', async () => {
    await board(true);

    const summary = await screen.findByLabelText('Bot pacing');
    expect(within(summary).getByText(/Budgets locked at start: 30 s/)).toBeInTheDocument();
    expect(within(summary).getByText(/pace bots only/i)).toBeInTheDocument();
    expect(within(summary).getByText(/Bot 2: 50% of 30 s — 15 s/)).toBeInTheDocument();
    // And the honest sentence. Until M09.12 it said the timings were recorded
    // and not waited; a 50% seat now really did wait for them.
    expect(within(summary).getByText(/waited for the times above/)).toBeInTheDocument();
  });

  it('says a table of instant bots waited for nothing', async () => {
    await board(true, IMMEDIATE_BOT_PACING);

    const summary = await screen.findByLabelText('Bot pacing');
    // 0% is still the default a bot is seated at, so this is the sentence most
    // first matches will carry, and it must not claim a wait that never was.
    expect(within(summary).getByText(/waited for nothing/)).toBeInTheDocument();
  });
});
