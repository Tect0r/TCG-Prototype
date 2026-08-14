import { describe, expect, it } from 'vitest';
import {
  BOT_CONFIG_SCHEMA_VERSION,
  DECK_MODE_SUPPORT,
  DEFAULT_BOT_DIFFICULTY,
  DIFFICULTY_REGISTRY_VERSION,
  IMMEDIATE_BOT_PACING,
  type BotDeckSnapshot,
} from '@tcg/bot-config';
import {
  bundledPrecon,
  loadFormatCardData,
  resolveFormatId,
  type CardDatabase,
} from '@tcg/card-data';
import {
  DECK_SCHEMA_VERSION,
  deckFingerprint,
  deckFormatOf,
  expandDeckCards,
  preconToDeck,
  type DeckFormatConfig,
  type SavedDeck,
} from '@tcg/deck';
import {
  CURRENT_VERSIONS,
  encode,
  type BotSetup,
  type ClientMessageInput,
  type ServerMessage,
} from '@tcg/protocol';
import type { Lobby } from './lobby.js';
import { MatchServer, type ScheduleTimer, type ServerConnection } from './match-server.js';

/**
 * Exact saved-deck mode (M09.6).
 *
 * The four claims the tranche makes, tested against the authoritative server
 * rather than against the resolver in isolation: a saved deck's **contents**
 * travel privately as bot configuration and are validated exactly as a person's
 * submitted deck is; the list is a **snapshot**, so nothing that happens to the
 * host's copy afterwards can reach the seat; the lobby publishes the Commander
 * and a legality verdict and never the list, the name or the fingerprint; and a
 * deleted, edited, stale or illegal deck is refused **by name** with something
 * the host can act on.
 *
 * Everything is driven through encoded messages — the same path a socket takes —
 * so the refusals here are the ones a real host would read.
 */

const shipping = loadFormatCardData(resolveFormatId());
if (!shipping.ok) throw new Error('The shipping format did not resolve to a card pool.');
const { database, format } = shipping.value;
const deckFormat = deckFormatOf(format);

const HOST_PRECON_ID = 'precon_bastion_guardians';
const SOURCE_PRECON_ID = 'precon_goblin_swarm';
const WHITE_PRECON_ID = 'precon_bastion_guardians';

function requirePrecon(preconId: string) {
  const precon = bundledPrecon(preconId);
  if (!precon) throw new Error(`${preconId} is missing from the bundle.`);
  return precon;
}

/**
 * A saved deck of the host's own.
 *
 * Built from a shipped list because that is a list this format is known to
 * accept — the point under test is the *route* a saved deck takes, not whether
 * some hand-written 40-card pile happens to be legal. It arrives as an ordinary
 * `SavedDeck` with the host's own ID and name, which is what the deck builder
 * produces.
 */
function savedDeckFrom(preconId: string, overrides: Partial<SavedDeck> = {}): SavedDeck {
  const precon = requirePrecon(preconId);
  return {
    ...preconToDeck(precon, { id: 'deck_home_brew', now: '2026-08-14T09:00:00.000Z' }),
    schemaVersion: DECK_SCHEMA_VERSION,
    name: 'My secret brew',
    ...overrides,
  };
}

/** Exactly what the host's client freezes and sends. */
function snapshotOf(deck: SavedDeck, overrides: Partial<BotDeckSnapshot> = {}): BotDeckSnapshot {
  if (deck.commanderId === null) throw new Error('A snapshot needs a Commander.');
  return {
    sourceDeckId: deck.id,
    name: deck.name,
    commanderId: deck.commanderId,
    cardIds: expandDeckCards(deck.cards),
    deckHash: deckFingerprint(deck),
    ...overrides,
  };
}

function setupFor(snapshot: BotDeckSnapshot, overrides: Partial<BotSetup> = {}): BotSetup {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    difficulty: DEFAULT_BOT_DIFFICULTY,
    style: 'value',
    deck: { mode: 'exact_saved_deck', deck: snapshot },
    pacing: IMMEDIATE_BOT_PACING,
    displayName: null,
    ...overrides,
  };
}

class FakeConnection implements ServerConnection {
  readonly sent: ServerMessage[] = [];
  closed = false;

  constructor(readonly id: string) {}

  send(message: ServerMessage): void {
    this.sent.push(message);
  }

  close(): void {
    this.closed = true;
  }

  last<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }> | undefined {
    for (let i = this.sent.length - 1; i >= 0; i -= 1) {
      const message = this.sent[i];
      if (message?.type === type) return message as Extract<ServerMessage, { type: T }>;
    }
    return undefined;
  }
}

interface Harness {
  readonly server: MatchServer;
  readonly host: FakeConnection;
  send(connection: FakeConnection, message: ClientMessageInput): void;
  lobby(): Lobby;
}

function createHarness(
  pool: CardDatabase = database,
  limits: DeckFormatConfig = deckFormat,
): Harness {
  let counter = 0;
  const schedule: ScheduleTimer = () => () => {};
  const server = new MatchServer({
    database: pool,
    deckFormat: limits,
    random: () => {
      counter += 1;
      return ((counter * 2654435761) % 4294967296) / 4294967296;
    },
    schedule,
    seedFor: () => 'fixed-saved-deck-seed',
    now: () => 1_700_000_000_000,
  });

  const send = (connection: FakeConnection, message: ClientMessageInput): void => {
    server.receive(connection, encode(message as never));
  };

  const host = new FakeConnection('conn_host');
  server.connect(host);
  send(host, {
    type: 'create_lobby',
    versions: CURRENT_VERSIONS,
    displayName: 'Host',
    maxSeats: 2,
  });
  const joined = host.last('lobby_joined');
  if (!joined) throw new Error('Host did not create a lobby');
  const inviteCode = joined.lobby.inviteCode;

  return {
    server,
    host,
    send,
    lobby: () => {
      const found = server.lobbyByCode(inviteCode);
      if (!found) throw new Error('The lobby is gone.');
      return found;
    },
  };
}

function seatViews(connection: FakeConnection) {
  const view = connection.last('lobby_updated')?.lobby ?? connection.last('lobby_joined')?.lobby;
  if (!view) throw new Error('That connection has never seen a lobby.');
  return view;
}

function lastError(connection: FakeConnection) {
  return connection.last('error')?.error;
}

/* -------------------------------------------------------------- the happy path */

describe('the host seats a bot on one of their own decks', () => {
  it('is a supported mode now, and says so in the table the server reads', () => {
    // The refusal M09.3 wrote is gone because the entry that produced it moved,
    // not because a check was deleted.
    expect(DECK_MODE_SUPPORT.exact_saved_deck).toEqual({ supported: true, plannedIn: null });
  });

  it('seats it ready and legal, holding exactly the list that was sent', () => {
    const deck = savedDeckFrom(SOURCE_PRECON_ID);
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(snapshotOf(deck)) });

    expect(lastError(harness.host)).toBeUndefined();
    const seat = seatViews(harness.host).seats[1];
    expect(seat?.controller).toBe('bot');
    expect(seat?.ready).toBe(true);
    expect(seat?.deckLegal).toBe(true);

    const stored = harness.lobby().seats.get('seat_2')?.deck as SavedDeck;
    expect(stored.commanderId).toBe(deck.commanderId);
    expect(stored.cards).toEqual(deck.cards);
    // Provenance, not a live pointer: the server records where the list came
    // from and nothing that could be followed back to the host's browser.
    expect(stored.id).toBe('deck_home_brew');
  });

  it('judges it with the same validator, and the same words, a person’s deck gets', () => {
    const illegal = savedDeckFrom(SOURCE_PRECON_ID, {
      cards: savedDeckFrom(SOURCE_PRECON_ID).cards.slice(0, 20),
    });

    const asBot = createHarness();
    asBot.send(asBot.host, { type: 'add_bot', setup: setupFor(snapshotOf(illegal)) });
    const botDetails = lastError(asBot.host)?.details ?? [];

    const asPerson = createHarness();
    asPerson.send(asPerson.host, { type: 'submit_deck', deck: illegal });
    const personDetails = asPerson.host.last('deck_rejected')?.error.details ?? [];

    // One authority, one wording. A bot deck is not judged by a second opinion.
    expect(botDetails).toEqual(expect.arrayContaining(personDetails));
    expect(personDetails.join(' ')).toContain('20 of 40');
  });

  it('starts the match and plays it', async () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor(snapshotOf(savedDeckFrom(SOURCE_PRECON_ID))),
    });
    harness.send(harness.host, { type: 'submit_precon', preconId: HOST_PRECON_ID });
    harness.send(harness.host, { type: 'set_ready', ready: true });

    expect(seatViews(harness.host).status).toBe('in_match');
    await harness.server.whenBotsIdle();
    // The seat behaves like any other bot seat from M09.4 on: it acts through
    // the same idempotent action-identity map a human's `submit_action` writes.
    expect(harness.lobby().seats.get('seat_2')?.appliedActions.size).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------- privacy */

describe('what a saved-deck bot publishes', () => {
  it('publishes the Commander, the readiness and the verdict — and no more', () => {
    const deck = savedDeckFrom(SOURCE_PRECON_ID);
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(snapshotOf(deck)) });

    const seat = seatViews(harness.host).seats[1];
    expect(seat?.controller === 'bot' ? seat.bot.deck : null).toEqual({
      mode: 'exact_saved_deck',
      commanderId: deck.commanderId,
    });
    // No name: a precon's name reveals nothing because every client already has
    // the list, and a saved deck's name is the only handle onto a list nobody
    // else may see (ADR 0024 §3). The legality verdict is still published,
    // because a seat that cannot start has to be visibly the reason.
    expect(seat?.deckName).toBeNull();
    expect(seat?.deckLegal).toBe(true);
  });

  it('puts no card, no name and no fingerprint in the lobby view at all', () => {
    const deck = savedDeckFrom(SOURCE_PRECON_ID);
    const snapshot = snapshotOf(deck);
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(snapshot) });

    const serialised = JSON.stringify(seatViews(harness.host));
    // The values really are private ones — asserted here so the search below
    // cannot pass by looking for nothing.
    expect(snapshot.cardIds.length).toBe(40);
    expect(snapshot.deckHash).toMatch(/^[0-9a-f]{16}$/);

    expect(serialised).not.toContain(snapshot.name);
    expect(serialised).not.toContain(snapshot.deckHash);
    expect(serialised).not.toContain(snapshot.sourceDeckId);
    for (const cardId of new Set(snapshot.cardIds)) {
      expect(serialised).not.toContain(cardId);
    }
    // The Commander is the one thing that is meant to be there.
    expect(serialised).toContain(deck.commanderId as string);
  });
});

/* ------------------------------------------------------------------ freezing */

describe('the snapshot is frozen', () => {
  it('is contents rather than a reference, so a later edit cannot reach the seat', () => {
    const deck = savedDeckFrom(SOURCE_PRECON_ID);
    const snapshot = snapshotOf(deck);
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(snapshot) });

    const before = harness.lobby().seats.get('seat_2')?.deck as SavedDeck;
    const originalCards = before.cards.map((entry) => entry.cardId);

    // The host goes on editing: the saved deck loses half its cards and gains a
    // new name, and the snapshot object they sent is mutated too.
    deck.cards.splice(0, 20);
    deck.name = 'Renamed after seating';
    snapshot.cardIds.length = 3;
    snapshot.name = 'Renamed after seating';

    const after = harness.lobby().seats.get('seat_2')?.deck as SavedDeck;
    expect(after.cards.map((entry) => entry.cardId)).toEqual(originalCards);
    expect(after.name).toBe('My secret brew');
    expect(after.cards).toHaveLength(40);
  });

  it('moves onto the new list only when the host applies it', () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor(snapshotOf(savedDeckFrom(SOURCE_PRECON_ID))),
    });

    const edited = savedDeckFrom(WHITE_PRECON_ID, { name: 'Second attempt' });
    harness.send(harness.host, {
      type: 'update_bot',
      seatId: 'seat_2',
      setup: setupFor(snapshotOf(edited)),
    });

    expect(lastError(harness.host)).toBeUndefined();
    const stored = harness.lobby().seats.get('seat_2')?.deck as SavedDeck;
    expect(stored.commanderId).toBe(edited.commanderId);
    expect(stored.name).toBe('Second attempt');
  });

  it('locks once the match has started', () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor(snapshotOf(savedDeckFrom(SOURCE_PRECON_ID))),
    });
    harness.send(harness.host, { type: 'submit_precon', preconId: HOST_PRECON_ID });
    harness.send(harness.host, { type: 'set_ready', ready: true });

    harness.send(harness.host, {
      type: 'update_bot',
      seatId: 'seat_2',
      setup: setupFor(snapshotOf(savedDeckFrom(WHITE_PRECON_ID))),
    });
    expect(lastError(harness.host)?.code).toBe('protocol/already_started');
  });
});

/* ------------------------------------------------------------- what is refused */

describe('a saved deck this server will not seat', () => {
  it('refuses a snapshot whose hash does not describe its own list', () => {
    const deck = savedDeckFrom(SOURCE_PRECON_ID);
    const stale = snapshotOf(deck);
    const harness = createHarness();

    // Exactly what an edit that raced the send looks like on the wire: the list
    // moved on and the fingerprint beside it did not.
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor({ ...stale, cardIds: stale.cardIds.slice(0, 39) }),
    });

    const error = lastError(harness.host);
    expect(error?.code).toBe('protocol/bot_config_invalid');
    expect(error?.details?.join(' ')).toContain(stale.deckHash);
    expect(error?.details?.join(' ')).toContain('edited after it was chosen');
    expect(harness.lobby().seats.has('seat_2')).toBe(false);
  });

  it('refuses a deck of the wrong size, by name', () => {
    const deck = savedDeckFrom(SOURCE_PRECON_ID);
    const short: SavedDeck = { ...deck, cards: deck.cards.slice(0, 39) };
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(snapshotOf(short)) });

    const error = lastError(harness.host);
    expect(error?.code).toBe('protocol/bot_deck_illegal');
    expect(error?.details?.join(' ')).toContain('39 of 40');
    expect(harness.lobby().seats.has('seat_2')).toBe(false);
  });

  it('refuses a card outside the Commander’s colour identity', () => {
    const red = savedDeckFrom(SOURCE_PRECON_ID);
    const whitePrecon = requirePrecon(WHITE_PRECON_ID);
    const offColour = whitePrecon.cardIds.find((cardId) =>
      database.get(cardId)?.colorIdentity.includes('white'),
    );
    expect(offColour).toBeDefined();

    const mixed: SavedDeck = {
      ...red,
      cards: [...red.cards.slice(0, 39), { cardId: offColour as string, quantity: 1 }],
    };
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(snapshotOf(mixed)) });

    const error = lastError(harness.host);
    expect(error?.code).toBe('protocol/bot_deck_illegal');
    expect(error?.details?.join(' ')).toContain('colour identity');
  });

  it('refuses a card this build has never heard of', () => {
    const deck = savedDeckFrom(SOURCE_PRECON_ID);
    const unknown: SavedDeck = {
      ...deck,
      cards: [...deck.cards.slice(0, 39), { cardId: 'card_from_a_later_set', quantity: 1 }],
    };
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(snapshotOf(unknown)) });

    const error = lastError(harness.host);
    expect(error?.code).toBe('protocol/bot_deck_illegal');
    expect(error?.details?.join(' ')).toContain('card_from_a_later_set');
  });

  it('refuses a repeated card in a singleton format, counted from the flat list', () => {
    // The snapshot lists every copy separately, so a duplicate arrives as the
    // same ID twice and has to be counted back into a quantity before the
    // singleton rule can see it at all.
    const deck = savedDeckFrom(SOURCE_PRECON_ID);
    const first = deck.cards[0]?.cardId as string;
    const doubled = snapshotOf(deck);
    const cardIds = [...doubled.cardIds.slice(0, 39), first];
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor({
        ...doubled,
        cardIds,
        deckHash: deckFingerprint({
          commanderId: doubled.commanderId,
          cards: [{ cardId: first, quantity: 2 }, ...deck.cards.slice(1, 39)],
        }),
      }),
    });

    const error = lastError(harness.host);
    expect(error?.code).toBe('protocol/bot_deck_illegal');
    expect(error?.details?.join(' ')).toContain('singleton');
  });

  it('refuses a Commander that is not a Commander card', () => {
    const deck = savedDeckFrom(SOURCE_PRECON_ID);
    const notACommander = deck.cards[0]?.cardId as string;
    const wrong: SavedDeck = {
      ...deck,
      commanderId: notACommander,
      cards: deck.cards.slice(1),
    };
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(snapshotOf(wrong)) });

    expect(lastError(harness.host)?.code).toBe('protocol/bot_deck_illegal');
  });

  it('refuses an incomplete snapshot at the codec, before the lobby sees it', () => {
    // A deck with no Commander cannot be expressed: `botDeckSnapshotSchema`
    // requires one, so an incomplete deck is a malformed message rather than a
    // configuration the lobby has to have an opinion about.
    const deck = savedDeckFrom(SOURCE_PRECON_ID);
    const { commanderId: _omitted, ...withoutCommander } = snapshotOf(deck);
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor(withoutCommander as BotDeckSnapshot),
    });

    expect(lastError(harness.host)?.code).toBe('protocol/malformed_message');
    expect(harness.lobby().seats.has('seat_2')).toBe(false);
  });

  it('leaves the seated configuration alone when an update is refused', () => {
    const good = savedDeckFrom(SOURCE_PRECON_ID);
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(snapshotOf(good)) });

    const short = savedDeckFrom(SOURCE_PRECON_ID, {
      cards: savedDeckFrom(SOURCE_PRECON_ID).cards.slice(0, 10),
    });
    harness.send(harness.host, {
      type: 'update_bot',
      seatId: 'seat_2',
      setup: setupFor(snapshotOf(short), { style: 'aggressive' }),
    });

    expect(lastError(harness.host)?.code).toBe('protocol/bot_deck_illegal');
    const seat = harness.lobby().seats.get('seat_2');
    expect((seat?.deck as SavedDeck).cards).toHaveLength(40);
    expect(seat?.controller === 'bot' ? seat.config.style : null).toBe('value');
    expect(seat?.ready).toBe(true);
  });

  it('still refuses a reroll: a saved deck is handed over, never built', () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor(snapshotOf(savedDeckFrom(SOURCE_PRECON_ID))),
    });
    harness.send(harness.host, { type: 'reroll_bot', seatId: 'seat_2' });

    const error = lastError(harness.host);
    expect(error?.code).toBe('protocol/bot_mode_unsupported');
    expect(error?.details?.join(' ')).toContain('exact_saved_deck');
  });
});
