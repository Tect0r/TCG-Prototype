import { describe, expect, it } from 'vitest';
import { bundledPrecon, CardDatabase, loadFormatCardData, resolveFormatId } from '@tcg/card-data';
import {
  DECK_SCHEMA_VERSION,
  deckFormatOf,
  preconToDeck,
  validateDeck,
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
 * Format scoping across both sides of the wire (M01.1).
 *
 * The server here is wired exactly as `main.ts` wires it — the shared
 * format-pool API, no hand-picked database — and the "client" side is the same
 * pool and the same `validateDeck` the deck builder runs. That is the whole
 * claim under test: what the builder offers and what the server accepts are one
 * pool, and a development fixture is outside it.
 */

const shipping = loadFormatCardData(resolveFormatId());
if (!shipping.ok) throw new Error('The shipping format did not resolve to a card pool.');
const { database, format } = shipping.value;
const deckFormat = deckFormatOf(format);

/** A card that exists only in the development fixture set. */
const FIXTURE_CARD_ID = 'goblin_scout';

/**
 * A legal Wave 1 deck: a Commander whose behaviour is implemented, and forty
 * implemented cards inside its colour identity.
 *
 * Built from the pool rather than copied from a precon, because since M01.2 no
 * shipped precon is legal — each still contains cards M02 has not implemented,
 * and one of them has an unimplemented Commander. The deck this produces is
 * exactly what the builder would let a player save today.
 */
function wave1Deck(name: string): SavedDeck {
  const commander = database
    .commanders()
    .find(
      (card) =>
        card.implemented &&
        database
          .deckable()
          .filter(
            (other) =>
              other.implemented &&
              other.colorIdentity.every((color) => card.colorIdentity.includes(color)),
          ).length >= deckFormat.deckSize,
    );
  if (!commander) throw new Error('No Wave 1 Commander can lead a fully implemented deck.');

  const cards = database
    .deckable()
    .filter(
      (card) =>
        card.implemented &&
        card.colorIdentity.every((color) => commander.colorIdentity.includes(color)),
    )
    .slice(0, deckFormat.deckSize)
    .map((card) => ({ cardId: card.id, quantity: 1 }));

  return {
    schemaVersion: DECK_SCHEMA_VERSION,
    id: `deck_${name}`,
    name,
    commanderId: commander.id,
    cards,
    createdAt: '2026-08-11T12:00:00.000Z',
    updatedAt: '2026-08-11T12:00:00.000Z',
  };
}

/** A Wave 1 precon, which is not playable while it holds unfinished cards. */
function preconDeck(preconId: string, name: string): SavedDeck {
  const precon = bundledPrecon(preconId);
  if (!precon) throw new Error(`${preconId} is missing from the bundle.`);
  return preconToDeck(precon, { id: `deck_${name}`, name, now: '2026-08-11T12:00:00.000Z' });
}

/** The same deck with one legal card swapped for a development fixture. */
function deckWithFixtureCard(name: string): SavedDeck {
  const deck = wave1Deck(name);
  return {
    ...deck,
    cards: [{ cardId: FIXTURE_CARD_ID, quantity: 1 }, ...deck.cards.slice(1)],
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
  send(connection: FakeConnection, message: ClientMessageInput): void;
}

/** A two-seat lobby on a server wired the way `main.ts` wires it. */
function createHarness(pool: CardDatabase = database): Harness {
  let counter = 0;
  const server = new MatchServer({
    database: pool,
    deckFormat,
    random: () => {
      counter += 1;
      return ((counter * 2654435761) % 4294967296) / 4294967296;
    },
    seedFor: () => 'fixed-format-seed',
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

  return { server, host, guest, send };
}

describe('format-scoped server pool', () => {
  it('runs the shipping format, not the bundled universe', () => {
    expect(shipping.value.formatId).toBe('precon_wave_1');
    expect(database.has(FIXTURE_CARD_ID)).toBe(false);
    expect(deckFormat.deckSize).toBe(40);
    expect(deckFormat.singleton).toBe(true);
  });

  it('rejects a deck holding a development fixture and names the card', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'submit_deck', deck: deckWithFixtureCard('Fixture Deck') });

    const rejected = harness.host.last('deck_rejected');
    expect(rejected).toBeDefined();
    expect(rejected?.error.code).toBe('protocol/deck_illegal');
    expect(rejected?.error.details?.join(' ')).toContain(FIXTURE_CARD_ID);

    const lobby = harness.host.last('lobby_updated')?.lobby;
    expect(lobby?.seats.find((seat) => seat.seatId === 'seat_1')?.deckLegal).toBe(false);
  });

  it('refuses to ready up with a deck the format does not allow', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'submit_deck', deck: deckWithFixtureCard('Fixture Deck') });
    harness.send(harness.host, { type: 'set_ready', ready: true });

    expect(harness.host.last('error')?.error.code).toBe('protocol/deck_required');
  });

  it('accepts a Wave 1 deck and starts the match from the scoped pool', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'submit_deck', deck: wave1Deck('Host Deck') });
    harness.send(harness.guest, { type: 'submit_deck', deck: wave1Deck('Guest Deck') });

    expect(harness.host.last('deck_rejected')).toBeUndefined();
    expect(harness.guest.last('deck_rejected')).toBeUndefined();

    harness.send(harness.host, { type: 'set_ready', ready: true });
    harness.send(harness.guest, { type: 'set_ready', ready: true });

    // A two-seat table starts itself, which also proves the scoped pool carries
    // everything the engine needs to build the match (tokens included).
    expect(harness.host.last('match_state')).toBeDefined();
    expect(harness.host.last('lobby_updated')?.lobby.status).toBe('in_match');
  });
});

describe('unfinished cards never reach a match (M01.2)', () => {
  it.each([
    'precon_bastion_guardians',
    'precon_containment_control',
    'precon_goblin_swarm',
    'precon_grave_sacrifice',
  ])('accepts %s now that every Wave 1 card is implemented (M02.5)', (preconId) => {
    // The Guardian precon was forty implemented cards behind an unimplemented
    // Commander — the hole M01.2 closed — and the other three each held cards
    // finished across M02.3–M02.5. All four are now legal end to end, so the
    // server has to take every one of them. The refusal path is covered below,
    // against a pool doctored to hold an unfinished card, because no shipped
    // deck can exercise it any more.
    const deck = preconDeck(preconId, `${preconId} Deck`);
    const report = validateDeck(deck, database, deckFormat);
    expect(report.issues.filter((issue) => issue.severity === 'error')).toEqual([]);
    expect(report.legal).toBe(true);

    const harness = createHarness();
    harness.send(harness.host, { type: 'submit_deck', deck });

    expect(harness.host.last('deck_rejected')).toBeUndefined();
  });

  it('refuses a deck holding unfinished cards, and names each one', () => {
    const unfinishedIds = ['equal_price', 'mass_offering'];
    const doctored = new CardDatabase(
      database
        .all()
        .map((card) =>
          unfinishedIds.includes(card.id)
            ? { ...card, implemented: false, unsupportedReason: 'left unfinished for this test' }
            : card,
        ),
    );

    const deck = preconDeck('precon_grave_sacrifice', 'Sacrifice Deck');
    const unfinished = deck.cards
      .map((entry) => doctored.get(entry.cardId))
      .filter((card) => card?.implemented === false);
    expect(unfinished.length).toBeGreaterThan(1);

    const harness = createHarness(doctored);
    harness.send(harness.host, { type: 'submit_deck', deck });

    const details = harness.host.last('deck_rejected')?.error.details?.join(' ') ?? '';
    for (const card of unfinished) expect(details).toContain(card?.name);
  });
});

describe('client and server agree on the legal pool', () => {
  // The builder validates with `validateDeck` over the pool it was handed; the
  // server does the same over its own. Wired through the shared format-pool
  // API, the two verdicts cannot disagree.
  it('gives the same verdict on a legal Wave 1 deck', () => {
    const deck = wave1Deck('Agreed Deck');
    expect(validateDeck(deck, database, deckFormat).legal).toBe(true);

    const harness = createHarness();
    harness.send(harness.host, { type: 'submit_deck', deck });
    expect(harness.host.last('deck_rejected')).toBeUndefined();
  });

  it('gives the same verdict on a deck holding a development fixture', () => {
    const deck = deckWithFixtureCard('Fixture Deck');
    const report = validateDeck(deck, database, deckFormat);
    expect(report.legal).toBe(false);
    expect(report.issues.some((issue) => issue.code === 'deck/unknown_card')).toBe(true);

    const harness = createHarness();
    harness.send(harness.host, { type: 'submit_deck', deck });
    expect(harness.host.last('deck_rejected')).toBeDefined();
  });

  it('would accept the fixture deck only in the development format', () => {
    // The fixture path stays available on purpose: the same card is legal
    // content, just not in Wave 1.
    const development = loadFormatCardData('development');
    expect(development.ok).toBe(true);
    if (!development.ok) return;
    expect(development.value.database.has(FIXTURE_CARD_ID)).toBe(true);
  });
});
