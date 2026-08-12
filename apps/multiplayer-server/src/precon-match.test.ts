import { describe, expect, it } from 'vitest';
import {
  bundledPrecon,
  loadFormatCardData,
  preconsForFormat,
  resolveFormatId,
  type CardDatabase,
} from '@tcg/card-data';
import {
  deckFormatOf,
  preconToDeck,
  reviewPrecon,
  type DeckFormatConfig,
  type SavedDeck,
} from '@tcg/deck';
import {
  CURRENT_VERSIONS,
  encode,
  type ClientMessageInput,
  type ServerMessage,
} from '@tcg/protocol';
import { MatchServer, type ServerConnection } from './match-server.js';

/**
 * Starting a match from a precon (M03.2).
 *
 * The claim under test is that the server validates *its own* copy of the
 * definition the UI presented. A precon travels as an ID, so there is nothing on
 * the wire to tamper with; a precon a player has edited is an ordinary deck and
 * is judged on its contents, name notwithstanding.
 *
 * The server is wired the way `main.ts` wires it — the shared format-pool API —
 * so "the same pool" is a property of the wiring rather than of this file.
 */

const shipping = loadFormatCardData(resolveFormatId());
if (!shipping.ok) throw new Error('The shipping format did not resolve to a card pool.');
const { database, format } = shipping.value;
const deckFormat = deckFormatOf(format);

const development = loadFormatCardData('development');
if (!development.ok) throw new Error('The development format did not resolve to a card pool.');

const PRECON_ID = 'precon_goblin_swarm';
const OTHER_PRECON_ID = 'precon_bastion_guardians';

function requirePrecon(preconId: string) {
  const precon = bundledPrecon(preconId);
  if (!precon) throw new Error(`${preconId} is missing from the bundle.`);
  return precon;
}

/**
 * A precon copy with one card swapped for a second copy of another — the
 * cheapest possible tamper, and one no singleton format allows.
 */
function tamperedCopy(preconId: string): SavedDeck {
  const precon = requirePrecon(preconId);
  const deck = preconToDeck(precon, {
    id: `deck_${preconId}_tampered`,
    // Kept under the precon's own name on purpose: the name must not buy it
    // anything.
    name: precon.name,
    now: '2026-08-12T12:00:00.000Z',
  });
  const duplicated = deck.cards[0]?.cardId;
  if (!duplicated) throw new Error('The precon copy has no cards to duplicate.');
  return {
    ...deck,
    cards: [...deck.cards.slice(0, -1), { cardId: duplicated, quantity: 1 }],
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
  readonly guest: FakeConnection;
  readonly inviteCode: string;
  send(connection: FakeConnection, message: ClientMessageInput): void;
  /** The deck the server actually holds for a seat, never one sent to it. */
  seatDeck(seatId: 'seat_1' | 'seat_2'): SavedDeck | null;
}

function createHarness(
  pool: CardDatabase = database,
  limits: DeckFormatConfig = deckFormat,
): Harness {
  let counter = 0;
  const server = new MatchServer({
    database: pool,
    deckFormat: limits,
    random: () => {
      counter += 1;
      return ((counter * 2654435761) % 4294967296) / 4294967296;
    },
    seedFor: () => 'fixed-precon-seed',
    now: () => 1_000_000,
  });

  const send = (connection: FakeConnection, message: ClientMessageInput): void => {
    server.receive(connection, encode(message as never));
  };

  const host = new FakeConnection('conn_host');
  server.connect(host);
  send(host, { type: 'create_lobby', versions: CURRENT_VERSIONS, displayName: 'Host' });
  const joined = host.last('lobby_joined');
  if (!joined) throw new Error('Host did not join');

  const guest = new FakeConnection('conn_guest');
  server.connect(guest);
  send(guest, {
    type: 'join_lobby',
    versions: CURRENT_VERSIONS,
    inviteCode: joined.lobby.inviteCode,
    displayName: 'Guest',
  });
  if (!guest.last('lobby_joined')) throw new Error('Guest did not join');

  return {
    server,
    host,
    guest,
    inviteCode: joined.lobby.inviteCode,
    send,
    seatDeck: (seatId) =>
      server.lobbyByCode(joined.lobby.inviteCode)?.seats.get(seatId)?.deck ?? null,
  };
}

describe('a precon enters the normal validation flow', () => {
  it.each(preconsForFormat('precon_wave_1').map((precon) => [precon.id] as const))(
    'accepts %s by ID and seats the shipped list',
    (preconId) => {
      const precon = requirePrecon(preconId);
      const harness = createHarness();
      harness.send(harness.host, { type: 'submit_precon', preconId });

      expect(harness.host.last('deck_rejected')).toBeUndefined();

      const seat = harness.host.last('lobby_updated')?.lobby.seats[0];
      expect(seat?.deckLegal).toBe(true);
      expect(seat?.deckName).toBe(precon.name);

      // The server built the deck itself. Nothing about the list came off the
      // wire, so this is the shipped definition or nothing.
      const deck = harness.seatDeck('seat_1');
      expect(deck?.commanderId).toBe(precon.commanderId);
      expect(deck?.cards.map((entry) => entry.cardId)).toEqual([...precon.cardIds]);
      expect(deck?.cards.every((entry) => entry.quantity === 1)).toBe(true);
    },
  );

  it('gives the same verdict the lobby preview showed', () => {
    // The preview runs `reviewPrecon` over the builder's pool; the server runs
    // it over its own. Wired through the shared format-pool API the two cannot
    // disagree — which is the whole point of sending an ID.
    const precon = requirePrecon(PRECON_ID);
    expect(reviewPrecon(precon, database, deckFormat).legal).toBe(true);

    const harness = createHarness();
    harness.send(harness.host, { type: 'submit_precon', preconId: PRECON_ID });
    expect(harness.host.last('deck_rejected')).toBeUndefined();
  });

  it('starts a match between two precons and deals both openers', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'submit_precon', preconId: PRECON_ID });
    harness.send(harness.guest, { type: 'submit_precon', preconId: OTHER_PRECON_ID });
    harness.send(harness.host, { type: 'set_ready', ready: true });
    harness.send(harness.guest, { type: 'set_ready', ready: true });

    expect(harness.host.last('lobby_updated')?.lobby.status).toBe('in_match');

    const view = harness.host.last('match_state')?.view;
    expect(view?.viewerId).toBe('player_1');
    expect(view?.hand.length).toBeGreaterThan(0);
    expect(harness.guest.last('match_state')?.view.hand.length).toBeGreaterThan(0);

    // Both seats are playing their own Commander from their own list.
    expect(harness.seatDeck('seat_1')?.commanderId).toBe(requirePrecon(PRECON_ID).commanderId);
    expect(harness.seatDeck('seat_2')?.commanderId).toBe(
      requirePrecon(OTHER_PRECON_ID).commanderId,
    );
  });

  it('lets the same precon be played at both seats', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'submit_precon', preconId: PRECON_ID });
    harness.send(harness.guest, { type: 'submit_precon', preconId: PRECON_ID });
    harness.send(harness.host, { type: 'set_ready', ready: true });
    harness.send(harness.guest, { type: 'set_ready', ready: true });

    expect(harness.host.last('lobby_updated')?.lobby.status).toBe('in_match');
  });
});

describe('a tampered precon is refused', () => {
  it('rejects an edited copy submitted under the precon name', () => {
    const tampered = tamperedCopy(PRECON_ID);
    expect(tampered.name).toBe(requirePrecon(PRECON_ID).name);

    const harness = createHarness();
    harness.send(harness.host, { type: 'submit_deck', deck: tampered });

    const rejected = harness.host.last('deck_rejected');
    expect(rejected?.error.code).toBe('protocol/deck_illegal');
    expect(rejected?.error.details?.join(' ')).toMatch(/singleton|more than once|copies/i);
    expect(harness.host.last('lobby_updated')?.lobby.seats[0]?.deckLegal).toBe(false);
  });

  it('will not let a tampered copy ready up or start a match', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'submit_deck', deck: tamperedCopy(PRECON_ID) });
    harness.send(harness.host, { type: 'set_ready', ready: true });

    expect(harness.host.last('error')?.error.code).toBe('protocol/deck_required');
    expect(harness.host.last('match_state')).toBeUndefined();
  });

  it('replaces a tampered submission when the untouched precon is chosen', () => {
    const precon = requirePrecon(PRECON_ID);
    const harness = createHarness();
    harness.send(harness.host, { type: 'submit_deck', deck: tamperedCopy(PRECON_ID) });
    harness.send(harness.host, { type: 'submit_precon', preconId: PRECON_ID });

    expect(harness.seatDeck('seat_1')?.cards.map((entry) => entry.cardId)).toEqual([
      ...precon.cardIds,
    ]);
    expect(harness.host.last('lobby_updated')?.lobby.seats[0]?.deckLegal).toBe(true);
  });

  it('names an ID that no precon has, and leaves the seat alone', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'submit_precon', preconId: PRECON_ID });
    harness.send(harness.host, { type: 'submit_precon', preconId: 'precon_not_a_deck' });

    const rejected = harness.host.last('deck_rejected');
    expect(rejected?.error.code).toBe('protocol/unknown_precon');
    expect(rejected?.error.details?.join(' ')).toContain(PRECON_ID);
    // The seat keeps the legal precon it already had: a bad ID is not a
    // submission.
    expect(harness.seatDeck('seat_1')?.commanderId).toBe(requirePrecon(PRECON_ID).commanderId);
  });

  it('refuses a precon built for another format, and says which', () => {
    // No precon is published for `development`, so a server running that format
    // must resolve the Wave 1 ID and then refuse it rather than play it.
    const harness = createHarness(
      development.value.database,
      deckFormatOf(development.value.format),
    );
    expect(preconsForFormat('development')).toHaveLength(0);

    harness.send(harness.host, { type: 'submit_precon', preconId: PRECON_ID });

    const rejected = harness.host.last('deck_rejected');
    expect(rejected?.error.code).toBe('protocol/deck_illegal');
    expect(rejected?.error.details?.join(' ')).toContain('precon_wave_1');
    expect(harness.host.last('lobby_updated')?.lobby.seats[0]?.deckLegal).toBe(false);
  });
});
