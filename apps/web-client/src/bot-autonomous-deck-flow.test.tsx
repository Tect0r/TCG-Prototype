import { describe, expect, it } from 'vitest';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { loadFormatCardData } from '@tcg/card-data';
import {
  DECK_MODE_SUPPORT,
  DEFAULT_BOT_PACING_BUDGETS,
  type GeneratedDeckProvenance,
} from '@tcg/bot-config';
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
 * Full AI Commander-and-deck choice, from the screen (M09.10).
 *
 * The server's half — the selection stream, the absence of a counterpick, the
 * reroll transition, the refusals and the reveal at completion — is
 * `apps/multiplayer-server/src/bot-autonomous-deck.test.ts`. This file owns what
 * a host can *ask for* and what they are *told*.
 *
 * The mode's shape on screen is deliberately the smallest of the four: there is
 * a seed and there is nothing else, because the Commander is the bot's to pick
 * and a control that pre-empted it would be a control that turned this mode back
 * into the previous one. What replaces the Commander picker is a sentence saying
 * what the bot picks from and what it cannot see while picking, and — once the
 * server answers — the Commander it actually chose.
 */

const database = unwrap(loadFormatCardData(DEFAULT_DECK_FORMAT.formatId), 'format pool').database;

const COMMANDER_COUNT = playableCommanders(database, DEFAULT_DECK_FORMAT).length;
const WARBOSS = 'goblin_warboss';

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

/**
 * A seated bot that chose for itself, exactly as `publicBotSeatOf` projects one.
 *
 * `commanderId` is nullable in this projection, and the `null` case is not
 * hypothetical decoration: it is what an opponent sees for a seat whose bot has
 * genuinely not chosen yet, and the screen has to be honest about it rather than
 * printing a placeholder.
 */
function autonomousBotSeat(
  commanderId: string | null = WARBOSS,
  overrides: Partial<BotLobbySeatView> = {},
): BotLobbySeatView {
  return {
    seatId: 'seat_2',
    displayName: 'Bot 2',
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
      botId: 'bot_1',
      displayName: 'Bot 2',
      difficulty: 'normal',
      style: 'value',
      deck: { mode: 'autonomous_generated', commanderId },
      pacing: { percent: 0, reactionPercent: null },
    },
    ...overrides,
  };
}

function lobby(seats: readonly LobbySeatView[], overrides: Partial<LobbyView> = {}): LobbyView {
  return {
    inviteCode: 'AUT001',
    status: 'waiting',
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

/** Puts the picker on the mode where the bot chooses, and optionally sets a seed. */
async function chooseAutonomous(harness: Harness, seed?: string): Promise<void> {
  await harness.user.selectOptions(
    screen.getByLabelText('Bot deck source'),
    'autonomous_generated',
  );
  if (seed !== undefined) {
    await harness.user.clear(screen.getByLabelText('Bot deck seed'));
    await harness.user.type(screen.getByLabelText('Bot deck seed'), seed);
  }
}

const PROVENANCE: GeneratedDeckProvenance = {
  generatorVersion: '1',
  mode: 'autonomous_generated',
  formatId: DEFAULT_DECK_FORMAT.formatId,
  seed: 'seed-omega',
  rerollCount: 0,
  commanderId: WARBOSS,
  deckHash: 'f00dfacef00dface',
  legalPoolSize: 41,
  forcedInclusionFloor: 39,
};

/* ------------------------------------------------------------- the controls */

describe('the mode where the bot chooses', () => {
  it('is offered, because the build has a resolver for it', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    expect(DECK_MODE_SUPPORT.autonomous_generated.supported).toBe(true);
    expect(
      within(screen.getByLabelText('Bot deck source')).getByRole('option', {
        name: 'A Commander and deck the bot picks',
      }),
    ).toBeInTheDocument();
  });

  it('asks for a seed and nothing else', async () => {
    const harness = renderApp();
    await enterLobby(harness);
    await chooseAutonomous(harness);

    // No Commander control: choosing one here would be the previous mode wearing
    // this one's label.
    expect(screen.queryByLabelText('Bot Commander')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Bot deck')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Bot deck seed')).toBeInTheDocument();
  });

  it('says what the bot picks from, and what it cannot see while picking', async () => {
    const harness = renderApp();
    await enterLobby(harness);
    await chooseAutonomous(harness);

    // The count is read from the same format-scoped list the server chooses out
    // of, so the sentence cannot drift away from the pool it describes.
    expect(
      within(panel()).getByText(
        new RegExp(`picks one of this format’s ${COMMANDER_COUNT} playable Commanders`),
      ),
    ).toBeInTheDocument();
    expect(
      within(panel()).getByText(/cannot see anyone’s hand, deck or saved decks/),
    ).toBeInTheDocument();
  });

  it('sends the seed, and never a Commander or a deck it made up', async () => {
    const harness = renderApp();
    await enterLobby(harness);
    await chooseAutonomous(harness, 'seed-omega');
    await harness.user.click(screen.getByRole('button', { name: 'Add a bot' }));

    expect(harness.transport().last('add_bot')?.setup.deck).toEqual({
      mode: 'autonomous_generated',
      seed: 'seed-omega',
      // A result, not an instruction: the server records what it built, and the
      // Commander it chose comes back in the projection rather than going out.
      generated: null,
    });
  });

  it('sends the same instruction for the same seed, from two cold starts', async () => {
    async function askFor(seed: string): Promise<unknown> {
      const harness = renderApp();
      await enterLobby(harness);
      await chooseAutonomous(harness, seed);
      await harness.user.click(screen.getByRole('button', { name: 'Add a bot' }));
      const sent = harness.transport().last('add_bot')?.setup.deck;
      cleanup();
      return sent;
    }

    expect(await askFor('repeatable')).toEqual(await askFor('repeatable'));
    expect(await askFor('repeatable')).not.toEqual(await askFor('different'));
  });

  it('starts a fresh stream on switching in, so two bots are not one deck twice', async () => {
    const harness = renderApp();
    await enterLobby(harness);
    await chooseAutonomous(harness);
    const first = (screen.getByLabelText('Bot deck seed') as HTMLInputElement).value;
    expect(first).not.toBe('');

    await harness.user.selectOptions(screen.getByLabelText('Bot deck source'), 'exact_precon');
    await chooseAutonomous(harness);
    expect((screen.getByLabelText('Bot deck seed') as HTMLInputElement).value).not.toBe(first);
  });
});

/* ------------------------------------------------------ what the table sees */

describe('a seated bot that chose for itself', () => {
  it('publishes the Commander it chose to the whole table', async () => {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), autonomousBotSeat()]));

    const seats = within(screen.getByLabelText('Seats')).getAllByRole('listitem');
    const botSeat = seats[1] as HTMLElement;
    expect(within(botSeat).getByText('Goblin Warboss')).toBeInTheDocument();
    // The list is not published in any mode that generates one, so the seat says
    // the deck is hidden rather than naming it.
    expect(within(botSeat).getByText('deck hidden')).toBeInTheDocument();
  });

  it('says nothing about a Commander a bot has not chosen yet', async () => {
    // The projection's `null` is the honest answer for a seat mid-choice, and
    // the screen prints no tag rather than inventing a placeholder.
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), autonomousBotSeat(null)]));

    const seats = within(screen.getByLabelText('Seats')).getAllByRole('listitem');
    const botSeat = seats[1] as HTMLElement;
    expect(within(botSeat).getByText('deck hidden')).toBeInTheDocument();
    expect(within(botSeat).queryByText('Goblin Warboss')).not.toBeInTheDocument();
  });
});

/* ------------------------------------------------- what the host is told back */

describe('the provenance of a deck the bot chose', () => {
  async function seatedHost(): Promise<Harness> {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), autonomousBotSeat()]));
    return harness;
  }

  it('says nothing until the server sends it', async () => {
    await seatedHost();

    expect(within(panel()).queryByText(/seed-omega/)).not.toBeInTheDocument();
    expect(
      within(panel()).getByText(/this browser has not been told which one/i),
    ).toBeInTheDocument();
  });

  it('says the bot chose, and shows the seed, version and deck hash', async () => {
    const harness = await seatedHost();
    harness.transport().deliver({
      type: 'bot_seat_provenance',
      seats: [{ seatId: 'seat_2', generated: PROVENANCE }],
    });

    const seat = await screen.findByLabelText('Bot in seat 2');
    // Who chose is read off the provenance, so the sentence cannot disagree with
    // the record it is describing.
    expect(within(seat).getByText(/The bot chose/)).toBeInTheDocument();
    expect(within(seat).getByText(/Goblin Warboss/)).toBeInTheDocument();
    expect(within(seat).getByText('seed-omega')).toBeInTheDocument();
    expect(within(seat).getByText('f00dfacef00dface')).toBeInTheDocument();
    expect(within(seat).getByText(/generator v1/)).toBeInTheDocument();
  });

  it('warns that a reroll moves the Commander as well as the cards', async () => {
    const harness = await seatedHost();
    harness.transport().deliver({
      type: 'bot_seat_provenance',
      seats: [{ seatId: 'seat_2', generated: PROVENANCE }],
    });

    // Still arithmetic from the pool report — 41 legal cards for a 40-card deck
    // leaves 2 of choice — but the promise a reroll makes is a bigger one here,
    // because the Commander is rerolled too.
    const seat = await screen.findByLabelText('Bot in seat 2');
    expect(within(seat).getByText(/41 cards legal under that Commander/)).toBeInTheDocument();
    expect(within(seat).getByText(/at least 39 of them/)).toBeInTheDocument();
    expect(within(seat).getByText(/only 2 cards are left to chance/)).toBeInTheDocument();
    expect(
      within(seat).getByText(/picks the Commander again as well, so it can change more/),
    ).toBeInTheDocument();
  });

  it('is dropped when the seat stops being a generated bot', async () => {
    const harness = await seatedHost();
    harness.transport().deliver({
      type: 'bot_seat_provenance',
      seats: [{ seatId: 'seat_2', generated: PROVENANCE }],
    });
    await screen.findByText('seed-omega');

    harness.transport().deliver({ type: 'lobby_updated', lobby: lobby([humanSeat()]) });
    await waitFor(() => expect(screen.queryByText('seed-omega')).not.toBeInTheDocument());
  });
});

/* --------------------------------------------------------------- rerolling */

describe('rerolling a bot that chooses for itself', () => {
  it('is offered, and asks for the next deck without sending a seed', async () => {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), autonomousBotSeat()]));

    await harness.user.click(screen.getByRole('button', { name: 'Reroll seat 2 deck' }));

    expect(harness.transport().last('reroll_bot')).toEqual({
      type: 'reroll_bot',
      seatId: 'seat_2',
    });
  });
});

/* ----------------------------------------------------- private, then revealed */

describe('the reveal names who chose the Commander', () => {
  const REVEALED: RevealedBotDeck = {
    seatId: 'seat_2',
    botId: 'bot_1',
    displayName: 'Bot 2',
    commanderId: WARBOSS,
    cardIds: ['goblin_spearman', 'goblin_spearman', 'goblin_sneak'],
    generated: PROVENANCE,
  };

  /** A board to reveal onto: the panel is a lobby control, the reveal is not. */
  async function board(): Promise<Harness> {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), autonomousBotSeat()]));

    const deck: MatchDeck = {
      commanderId: WARBOSS,
      cards: [{ cardId: 'goblin_spearman', quantity: 30 }],
    };
    const state = unwrap(
      createMatch({
        matchId: 'autonomous_reveal',
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

  it('shows the list and the generator record once the server reveals it', async () => {
    const harness = await board();
    harness.transport().deliver({ type: 'bot_decks_revealed', decks: [REVEALED] });

    const reveal = await screen.findByLabelText('Bot decks');
    expect(within(reveal).getByText('2× Goblin Spearman')).toBeInTheDocument();
    expect(within(reveal).getByText(/played 3 cards under Goblin Warboss/)).toBeInTheDocument();
    expect(within(reveal).getByText(/from seed seed-omega/)).toBeInTheDocument();
    expect(within(reveal).getByRole('button', { name: 'Export this deck' })).toBeEnabled();
  });
});
