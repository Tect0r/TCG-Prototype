import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { loadBundledCardData } from '@tcg/card-data';
import {
  AUTOMATIC_STYLE,
  AUTOMATIC_STYLE_FALLBACK,
  AVAILABLE_DIFFICULTIES,
  BOT_STYLE_SETTINGS,
  DEFAULT_BOT_PACING_BUDGETS,
  PLANNED_DIFFICULTIES,
  botStyleDefinition,
  difficultyDefinition,
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
 * Complete per-bot setup, and automatic style, on screen (M09.16).
 *
 * The four claims are the tranche's checklist, and each is a section below.
 *
 * - **Progressive disclosure.** Every approved option is present for every bot,
 *   and the ones a host does not have to think about are behind a native
 *   disclosure rather than absent or scattered.
 * - **Automatic style.** It is offered, it is the default, it is sent as a
 *   setting rather than a resolved style, and the screen says which style it
 *   lands on and why — including when it cannot know yet.
 * - **Copy without seeds.** One bot's setup can be put on another seat, and a
 *   generated deck is pasted onto a *new* stream so two seats never share one.
 * - **States said.** Locked, private, unavailable and pool-limited are each
 *   stated rather than left to be inferred from a control that is missing.
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

/** A bot on the Goblin Swarm precon, whose plan is `token_swarm`. */
function botSeat(overrides: Partial<BotLobbySeatView> = {}): BotLobbySeatView {
  return {
    seatId: 'seat_2',
    displayName: 'AI 2',
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
      displayName: 'AI 2',
      difficulty: 'normal',
      styleSetting: AUTOMATIC_STYLE,
      style: 'aggressive',
      deck: { mode: 'exact_precon', preconId: 'precon_goblin_swarm' },
      pacing: { percent: 0, reactionPercent: null },
    },
    ...overrides,
  };
}

function lobby(seats: readonly LobbySeatView[], overrides: Partial<LobbyView> = {}): LobbyView {
  return {
    inviteCode: 'SET001',
    status: 'waiting',
    maxSeats: 4,
    hostSeatId: 'seat_1',
    canStart: false,
    seats: [...seats],
    botPacing: DEFAULT_BOT_PACING_BUDGETS,
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

const panel = (): HTMLElement => screen.getByLabelText('AI opponents');
const addForm = (): HTMLElement => screen.getByLabelText('Add an AI opponent');

/* ------------------------------------------------------ progressive disclosure */

describe('one bot’s complete setup', () => {
  it('offers every approved option, with the refinements behind a disclosure', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    // The decisions a host has to make are on the surface.
    for (const label of [
      'AI opponent deck source',
      'AI opponent deck',
      'AI opponent difficulty',
      'AI opponent style',
    ]) {
      expect(within(addForm()).getByLabelText(label)).toBeInTheDocument();
    }

    // The refinements are present — not absent, and not disabled — and inside a
    // group that starts closed.
    const disclosure = within(addForm()).getByText('Timing and deck seed');
    const details = disclosure.closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    for (const label of ['AI opponent timing', 'AI opponent Reaction override']) {
      expect(within(details as HTMLElement).getByLabelText(label)).toBeInTheDocument();
    }
    expect(within(details as HTMLElement).getByLabelText('AI opponent timing')).toBeEnabled();
  });

  it('puts the deck seed under the same disclosure, for the modes that have one', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    // An exact list has no seed at all: there is nothing to reproduce.
    expect(within(addForm()).queryByLabelText('AI opponent deck seed')).not.toBeInTheDocument();

    await harness.user.selectOptions(
      within(addForm()).getByLabelText('AI opponent deck source'),
      'autonomous_generated',
    );
    const seed = within(addForm()).getByLabelText('AI opponent deck seed');
    expect(seed.closest('details')).toBe(
      within(addForm()).getByText('Timing and deck seed').closest('details'),
    );
  });

  it('scopes every seated bot’s controls to its own seat', async () => {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), botSeat()]));

    // Seat-scoped names, so a table with three bots is readable to somebody
    // listening to the page rather than looking at it (M09.7), including the
    // disclosure this tranche added.
    const seat = screen.getByLabelText('AI opponent in seat 2');
    for (const label of ['Seat 2 difficulty', 'Seat 2 style']) {
      expect(within(seat).getByLabelText(label)).toBeInTheDocument();
    }
    expect(within(seat).getByText('Seat 2 timing and deck seed')).toBeInTheDocument();
  });
});

/* --------------------------------------------------------------- automatic style */

describe('automatic style', () => {
  it('is offered beside the three styles, and is what a host gets by default', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    const control = within(addForm()).getByLabelText('AI opponent style') as HTMLSelectElement;
    expect([...control.options].map((option) => option.value)).toEqual([...BOT_STYLE_SETTINGS]);
    expect(control).toHaveValue(AUTOMATIC_STYLE);
  });

  it('says which style it lands on, and which deck plan decided it', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    await harness.user.selectOptions(
      within(addForm()).getByLabelText('AI opponent deck'),
      'precon_goblin_swarm',
    );
    // Goblin Swarm's authored plan is `token_swarm`, which the mapping prices as
    // Aggressive. The screen names the Commander, the archetype and the style,
    // so a host can see the reasoning rather than a verdict.
    const note = within(addForm()).getByText(/^Automatic:/);
    expect(note).toHaveTextContent('Goblin Warboss');
    expect(note).toHaveTextContent('token swarm');
    expect(note).toHaveTextContent(botStyleDefinition('aggressive').label);
  });

  it('changes its answer when the deck changes, because it reads the deck', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    await harness.user.selectOptions(
      within(addForm()).getByLabelText('AI opponent deck'),
      'precon_bastion_guardians',
    );
    // A defensive-attrition plan, which is a different style from Goblin
    // Swarm's — so the note is derived rather than decorative.
    expect(within(addForm()).getByText(/^Automatic:/)).toHaveTextContent(
      botStyleDefinition('defensive').label,
    );
  });

  it('does not pretend to know a Commander the bot has not picked yet', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    await harness.user.selectOptions(
      within(addForm()).getByLabelText('AI opponent deck source'),
      'autonomous_generated',
    );
    const note = within(addForm()).getByText(/^Automatic reads/);
    expect(note).toHaveTextContent('has not picked one yet');
    // And it names the fallback rather than implying there is always an answer.
    expect(note).toHaveTextContent(botStyleDefinition(AUTOMATIC_STYLE_FALLBACK).label);
  });

  it('sends the setting, and lets the server decide what it means', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    await harness.user.click(within(addForm()).getByRole('button', { name: 'Add an AI opponent' }));
    const setup = harness.transport().last('add_bot')?.setup;
    expect(setup?.style).toBe(AUTOMATIC_STYLE);
    // A client that could state the resolved style could state one the server
    // never derived (ADR 0024 §3).
    expect(setup && Object.keys(setup)).not.toContain('styleSetting');
  });

  it('names an automatic seat as automatic, everywhere a seat is summarised', async () => {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), botSeat()]));

    const seat = within(screen.getByLabelText('Seats')).getByText('AI 2').closest('li');
    const tags = within(seat as HTMLElement)
      .getAllByText(/.+/)
      .map((node) => node.textContent);
    // "Aggressive (automatic)" is a different fact about the table from
    // "Aggressive", and the seat view carries both members so that the lobby
    // need not flatten them.
    expect(tags).toContain('Aggressive (automatic)');
    expect(tags).not.toContain('Aggressive');
  });
});

/* ------------------------------------------------------------------ copying */

describe('copying one bot’s setup onto another seat', () => {
  it('copies the settings and mints a new seed rather than sharing one', async () => {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat()]));

    // Configure the first bot on a generated deck and seat it, so this browser
    // holds the private half of its configuration.
    await harness.user.selectOptions(
      within(addForm()).getByLabelText('AI opponent deck source'),
      'autonomous_generated',
    );
    await harness.user.selectOptions(
      within(addForm()).getByLabelText('AI opponent difficulty'),
      'easy',
    );
    await harness.user.click(within(addForm()).getByRole('button', { name: 'Add an AI opponent' }));

    const first = harness.transport().last('add_bot')?.setup;
    if (first?.deck.mode !== 'autonomous_generated') throw new Error('Wrong mode.');

    harness.transport().deliver({
      type: 'lobby_updated',
      lobby: lobby([
        humanSeat(),
        botSeat({
          bot: {
            ...botSeat().bot,
            difficulty: 'easy',
            deck: { mode: 'autonomous_generated', commanderId: null },
          },
        }),
      ]),
    });

    // Copy it, and paste it into the form for the next bot.
    await harness.user.click(await screen.findByRole('button', { name: 'Copy seat 2 setup' }));
    await harness.user.click(
      within(addForm()).getByRole('button', {
        name: /Paste seat 2 setup into the next AI opponent/,
      }),
    );

    // The screen says what pasting a generated deck does, before it is sent.
    expect(within(addForm()).getByText(/starts a new seed/)).toBeInTheDocument();

    await harness.user.click(within(addForm()).getByRole('button', { name: 'Add an AI opponent' }));
    const second = harness.transport().last('add_bot')?.setup;
    if (second?.deck.mode !== 'autonomous_generated') throw new Error('Wrong mode.');

    // Everything a host chose came across…
    expect(second.difficulty).toBe('easy');
    expect(second.style).toBe(first.style);
    expect(second.pacing).toEqual(first.pacing);
    // …and the one thing that is an identity rather than a preference did not.
    expect(second.deck.seed).not.toBe(first.deck.seed);
    expect(second.deck.seed).not.toBe('');
  });

  it('refuses to copy a seat whose configuration this browser never sent', async () => {
    const harness = renderApp();
    await enterLobby(
      harness,
      lobby([
        humanSeat(),
        botSeat({
          deckName: null,
          bot: {
            ...botSeat().bot,
            deck: { mode: 'exact_saved_deck', commanderId: 'goblin_warboss' },
          },
        }),
      ]),
    );

    // The private half of a saved-deck configuration never comes back down the
    // wire, so the form is showing defaults rather than that seat's setup.
    const seat = screen.getByLabelText('AI opponent in seat 2');
    expect(
      within(seat).queryByRole('button', { name: 'Copy seat 2 setup' }),
    ).not.toBeInTheDocument();
    expect(within(seat).getByText(/did not send this seat’s configuration/)).toBeInTheDocument();
  });

  it('does not offer to paste a setup onto the seat it came from', async () => {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), botSeat()]));

    const seat = screen.getByLabelText('AI opponent in seat 2');
    await harness.user.click(within(seat).getByRole('button', { name: 'Copy seat 2 setup' }));
    expect(within(seat).queryByRole('button', { name: /^Paste/ })).not.toBeInTheDocument();
    expect(within(addForm()).getByRole('button', { name: /^Paste/ })).toBeInTheDocument();
  });
});

/* -------------------------------------------------------------- what is stated */

describe('what the panel says about what it cannot offer', () => {
  it('has emptied its planned-difficulty sentence, because the registry did', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    // M09.16 wrote this sentence and said it would empty itself when Hard was
    // published; M09.20 published Hard, and it did — without a change to the
    // panel, because the sentence is built from `PLANNED_DIFFICULTIES` rather
    // than written out. Both halves are asserted: nothing is planned, and no
    // "is planned for" line is on the screen.
    expect(PLANNED_DIFFICULTIES).toEqual([]);
    expect(within(addForm()).queryByText(/is planned for/)).not.toBeInTheDocument();

    // And the control offers every difficulty the registry ships, Hard included.
    const control = within(addForm()).getByLabelText('AI opponent difficulty') as HTMLSelectElement;
    expect([...control.options].map((option) => option.value)).toEqual([...AVAILABLE_DIFFICULTIES]);
    expect(difficultyDefinition('hard').status).toBe('available');
  });

  it('says what the difficulty on offer actually is', async () => {
    const harness = renderApp();
    await enterLobby(harness);

    expect(within(addForm()).getByText(difficultyDefinition('normal').summary)).toBeInTheDocument();
    await harness.user.selectOptions(
      within(addForm()).getByLabelText('AI opponent difficulty'),
      'easy',
    );
    expect(within(addForm()).getByText(difficultyDefinition('easy').summary)).toBeInTheDocument();
  });

  it('says the settings are locked once the match has started', async () => {
    const harness = renderApp();
    await enterLobby(harness, lobby([humanSeat(), botSeat()], { status: 'in_match' }));

    expect(within(panel()).getByText(/locked for the rest of it/)).toBeInTheDocument();
    expect(within(panel()).queryByLabelText('Seat 2 style')).not.toBeInTheDocument();
  });
});
