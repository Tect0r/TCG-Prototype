import { describe, expect, it } from 'vitest';
import {
  BOT_CONFIG_SCHEMA_VERSION,
  DEFAULT_BOT_DIFFICULTY,
  DIFFICULTY_REGISTRY_VERSION,
  IMMEDIATE_BOT_PACING,
  publicBotSeatOf,
  type BotDeckSource,
} from '@tcg/bot-config';
import {
  CardDatabase,
  formatCardPool,
  formatDatabase,
  loadFormatCardData,
  resolveFormatId,
  type CardDefinition,
} from '@tcg/card-data';
import {
  PRECON_WAVE_1_DECK_FORMAT,
  deckFormatOf,
  validateDeck,
  type DeckFormatConfig,
  type SavedDeck,
} from '@tcg/deck';
import { DECK_GENERATOR_VERSION } from '@tcg/deck-generator';
import {
  CURRENT_VERSIONS,
  encode,
  type BotSetup,
  type ClientMessageInput,
  type ServerMessage,
} from '@tcg/protocol';
import { generatableCommanders, generateBotDeck, generationSeedFor } from './bot-generated-deck.js';
import { carriedRerollCount, setupOf } from './bot-seats.js';
import { isBotSeat, type BotSeat, type Lobby } from './lobby.js';
import { MatchServer, type ScheduleTimer, type ServerConnection } from './match-server.js';

/**
 * Host-selected Commander generation (M09.9).
 *
 * The five claims under test are the tranche's own. Only Commanders this format
 * leaves playable are offered, and every other choice is refused **by name**
 * rather than substituted. A deck is generated from a seed, frozen, and
 * identified by seed, generator version, construction mode, Commander and hash.
 * A reroll before the match is one deterministic step along the seat's own
 * stream, and the transition is recorded. The list is private through the lobby
 * and the match and is revealed to everybody once it is over. The
 * forced-inclusion floor the format leaves is reported rather than implied.
 *
 * Most of it is driven through encoded messages, so what is asserted is what a
 * real host and a real guest would receive. The two states no shipped content
 * can reach — an unimplemented Commander, and a pool too small to fill a deck —
 * are driven straight through `generateBotDeck`, because the point of testing
 * them is that a later content or format change cannot introduce them quietly.
 */

const shipping = loadFormatCardData(resolveFormatId());
if (!shipping.ok) throw new Error('The shipping format did not resolve to a card pool.');
const { database, format } = shipping.value;
const deckFormat = deckFormatOf(format);

const COMMANDER_ID = 'goblin_warboss';
const OTHER_COMMANDER_ID = 'bastion_commander';
const SEED = 'host-seed-1';

function generatedSource(
  commanderId: string = COMMANDER_ID,
  seed: string = SEED,
): Extract<BotDeckSource, { mode: 'commander_generated' }> {
  return { mode: 'commander_generated', commanderId, seed, generated: null };
}

function setupFor(deck: BotDeckSource, overrides: Partial<BotSetup> = {}): BotSetup {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    difficulty: DEFAULT_BOT_DIFFICULTY,
    style: 'value',
    deck,
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

  all<T extends ServerMessage['type']>(type: T): Extract<ServerMessage, { type: T }>[] {
    return this.sent.filter(
      (message): message is Extract<ServerMessage, { type: T }> => message.type === type,
    );
  }

  /** The revision this seat is looking at, which is what an action is judged against. */
  sequence(): number {
    return this.last('match_state')?.view.sequence ?? 0;
  }
}

interface Harness {
  readonly server: MatchServer;
  readonly host: FakeConnection;
  readonly inviteCode: string;
  send(connection: FakeConnection, message: ClientMessageInput): void;
  join(name: string): FakeConnection;
  lobby(): Lobby;
  botSeat(seatId: string): BotSeat;
}

function createHarness(maxSeats = 2): Harness {
  let counter = 0;
  const schedule: ScheduleTimer = () => () => {};
  const server = new MatchServer({
    database,
    deckFormat,
    random: () => {
      counter += 1;
      return ((counter * 2654435761) % 4294967296) / 4294967296;
    },
    schedule,
    seedFor: () => 'fixed-generated-deck-seed',
    now: () => 1_000_000,
  });

  const send = (connection: FakeConnection, message: ClientMessageInput): void => {
    server.receive(connection, encode(message as never));
  };

  const host = new FakeConnection('conn_host');
  server.connect(host);
  send(host, { type: 'create_lobby', versions: CURRENT_VERSIONS, displayName: 'Host', maxSeats });
  const joined = host.last('lobby_joined');
  if (!joined) throw new Error('Host did not create a lobby');
  const inviteCode = joined.lobby.inviteCode;

  let guests = 0;
  const join = (name: string): FakeConnection => {
    guests += 1;
    const guest = new FakeConnection(`conn_guest_${guests}`);
    server.connect(guest);
    send(guest, { type: 'join_lobby', versions: CURRENT_VERSIONS, inviteCode, displayName: name });
    return guest;
  };

  const lobby = (): Lobby => {
    const found = server.lobbyByCode(inviteCode);
    if (!found) throw new Error('The lobby is gone.');
    return found;
  };

  const botSeat = (seatId: string): BotSeat => {
    const seat = lobby().seats.get(seatId as never);
    if (!seat || !isBotSeat(seat)) throw new Error(`${seatId} does not hold a bot.`);
    return seat;
  };

  return { server, host, inviteCode, send, join, lobby, botSeat };
}

function seatViews(connection: FakeConnection) {
  const view = connection.last('lobby_updated')?.lobby ?? connection.last('lobby_joined')?.lobby;
  if (!view) throw new Error('That connection has never seen a lobby.');
  return view;
}

function lastError(connection: FakeConnection) {
  return connection.last('error')?.error;
}

function generatedDeckOf(seat: BotSeat): SavedDeck {
  if (!seat.deck) throw new Error('That bot seat holds no deck.');
  return seat.deck;
}

function provenanceOf(seat: BotSeat) {
  const source = seat.config.deck;
  if (source.mode !== 'commander_generated' || !source.generated) {
    throw new Error('That bot seat has no generated provenance.');
  }
  return source.generated;
}

/* ------------------------------------------------ which Commanders are offered */

describe('the Commanders a host may choose', () => {
  it('offers this format`s playable Commanders and nothing else', () => {
    const offered = generatableCommanders(database, deckFormat);
    // Sorted by name, so a picker built from it is stable between builds.
    expect(offered.map((card) => card.name)).toEqual(
      [...offered.map((card) => card.name)].sort((left, right) => left.localeCompare(right)),
    );
    expect(new Set(offered.map((card) => card.id))).toEqual(
      new Set([
        'grave_matriarch',
        'chief_containment_scholar',
        'goblin_warboss',
        'bastion_commander',
      ]),
    );
    // Every offered Commander is one the server will actually generate under,
    // which is the property that makes the list worth offering at all.
    for (const commanderId of offered.map((card) => card.id)) {
      const built = generateBotDeck({
        commanderId,
        baseSeed: SEED,
        rerollCount: 0,
        database,
        deckFormat,
        now: () => 0,
      });
      expect(built.ok).toBe(true);
    }
  });

  it('leaves out a Commander whose behaviour is not structured yet', () => {
    // No shipped card is unimplemented, so the state is built rather than found:
    // the point is that content which stops being playable stops being offered
    // and starts being refused, without anybody remembering to update a list.
    const pool = formatCardPool(deckFormat.formatId);
    const real = pool.find((card) => card.id === COMMANDER_ID) as CardDefinition;
    const broken: CardDefinition = {
      ...real,
      implemented: false,
      unsupportedReason: 'its ability has no structured effect yet',
    };
    const crippled = new CardDatabase([...pool.filter((card) => card.id !== COMMANDER_ID), broken]);

    expect(generatableCommanders(crippled, deckFormat).map((card) => card.id)).not.toContain(
      COMMANDER_ID,
    );

    const built = generateBotDeck({
      commanderId: COMMANDER_ID,
      baseSeed: SEED,
      rerollCount: 0,
      database: crippled,
      deckFormat,
      now: () => 0,
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('protocol/bot_config_invalid');
    expect(built.error.details?.join(' ')).toContain('not playable yet');
  });
});

/* --------------------------------------------------------------- refusals */

describe('a Commander this build cannot generate under is refused by name', () => {
  it('says an ID that names nothing is unknown here', () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor(generatedSource('no_such_commander')),
    });

    const error = lastError(harness.host);
    expect(error?.code).toBe('protocol/bot_config_invalid');
    expect(error?.details?.[0]).toContain('No card in precon_wave_1 has the ID');
    expect(harness.lobby().seats.size).toBe(1);
  });

  it('says a Commander from another format is off-format rather than unknown', () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor(generatedSource('prototype_commander_red')),
    });

    const error = lastError(harness.host);
    expect(error?.code).toBe('protocol/bot_config_invalid');
    expect(error?.details?.[0]).toContain('is not published for precon_wave_1');
    // And it still names what the host may choose instead.
    expect(error?.details?.[1]).toContain(COMMANDER_ID);
  });

  it('refuses a card that is in the format but is not a Commander', () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor(generatedSource('throwing_knife')),
    });

    const error = lastError(harness.host);
    expect(error?.code).toBe('protocol/bot_config_invalid');
    expect(error?.details?.join(' ')).toContain('cannot be used as a Commander');
  });

  it('refuses an impossible generation with the generator`s own problem code', () => {
    // A pool that cannot fill the format's deck: the development set judged by
    // the 40-card singleton rules. Refused, never padded from outside the pool.
    const tiny = formatDatabase('development');
    const built = generateBotDeck({
      commanderId: 'prototype_commander_red',
      baseSeed: SEED,
      rerollCount: 0,
      database: tiny,
      deckFormat: PRECON_WAVE_1_DECK_FORMAT,
      now: () => 0,
    });
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('protocol/bot_deck_illegal');
    expect(built.error.details?.join(' ')).toContain('sim/pool_too_small');
  });

  it('refuses a setup that describes a deck the server did not build', () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor({
        ...generatedSource(),
        generated: {
          generatorVersion: DECK_GENERATOR_VERSION,
          mode: 'commander_generated',
          formatId: deckFormat.formatId,
          seed: SEED,
          rerollCount: 0,
          commanderId: COMMANDER_ID,
          deckHash: 'deadbeefdeadbeef',
          legalPoolSize: 41,
          forcedInclusionFloor: 39,
        },
      }),
    });

    const error = lastError(harness.host);
    expect(error?.code).toBe('protocol/bot_config_invalid');
    expect(error?.details?.join(' ')).toContain('may not describe one');
    expect(harness.lobby().seats.size).toBe(1);
  });
});

/* --------------------------------------------------------- what gets seated */

describe('a generated bot seat', () => {
  it('is seated ready, with a legal deck the server built and validated', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(generatedSource()) });

    expect(lastError(harness.host)).toBeUndefined();
    const seat = harness.botSeat('seat_2');
    expect(seat.ready).toBe(true);
    expect(seat.deckLegal).toBe(true);

    const deck = generatedDeckOf(seat);
    expect(deck.commanderId).toBe(COMMANDER_ID);
    // Judged by the same call a person's `submit_deck` gets, against the same
    // pool: a bot gets no allowance a player would not get.
    const report = validateDeck(deck, database, deckFormat);
    expect(report.legal).toBe(true);
    expect(report.stats.totalCards).toBe(deckFormat.deckSize);
  });

  it('records seed, generator version, mode, Commander, hash and the pool report', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(generatedSource()) });

    const provenance = provenanceOf(harness.botSeat('seat_2'));
    expect(provenance).toEqual({
      generatorVersion: DECK_GENERATOR_VERSION,
      mode: 'commander_generated',
      formatId: 'precon_wave_1',
      seed: SEED,
      rerollCount: 0,
      commanderId: COMMANDER_ID,
      deckHash: provenance.deckHash,
      legalPoolSize: 41,
      forcedInclusionFloor: 39,
    });
    expect(provenance.deckHash).toMatch(/^[0-9a-f]{8,}$/);
    // 41 legal cards for a 40-card singleton deck is a floor of 39: the claim
    // the UI makes about generated decks being minimally different, as a number.
    expect(provenance.legalPoolSize - provenance.forcedInclusionFloor).toBe(2);
  });

  it('builds the same deck from the same seed, and a different one from another', () => {
    const first = createHarness();
    first.send(first.host, { type: 'add_bot', setup: setupFor(generatedSource()) });
    const second = createHarness();
    second.send(second.host, { type: 'add_bot', setup: setupFor(generatedSource()) });
    const third = createHarness();
    third.send(third.host, {
      type: 'add_bot',
      setup: setupFor(generatedSource(COMMANDER_ID, 'a-different-seed')),
    });

    expect(provenanceOf(second.botSeat('seat_2')).deckHash).toBe(
      provenanceOf(first.botSeat('seat_2')).deckHash,
    );
    expect(provenanceOf(third.botSeat('seat_2')).deckHash).not.toBe(
      provenanceOf(first.botSeat('seat_2')).deckHash,
    );
  });

  it('publishes the Commander and never the list', () => {
    const harness = createHarness(3);
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(generatedSource()) });
    const guest = harness.join('Guest');

    const seat = seatViews(guest).seats.find((entry) => entry.seatId === 'seat_2');
    expect(seat?.controller).toBe('bot');
    if (seat?.controller !== 'bot') return;
    expect(seat.bot.deck).toEqual({ mode: 'commander_generated', commanderId: COMMANDER_ID });
    // The published projection has no seed, hash or card list to strip.
    expect(seat.deckName).toBeNull();
    expect(JSON.stringify(seat.bot)).not.toContain(SEED);

    // And the projection is the only route: what the seat actually holds is a
    // whole deck, and none of it appears in what a guest was sent.
    const deck = generatedDeckOf(harness.botSeat('seat_2'));
    const guestTraffic = JSON.stringify(guest.sent);
    for (const entry of deck.cards) expect(guestTraffic).not.toContain(entry.cardId);
  });
});

/* ------------------------------------------------- the host's own provenance */

describe('the provenance the host is sent', () => {
  it('reaches the host and nobody else', () => {
    const harness = createHarness(3);
    const guest = harness.join('Guest');
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(generatedSource()) });

    const sent = harness.host.last('bot_seat_provenance');
    expect(sent?.seats).toEqual([
      { seatId: 'seat_3', generated: provenanceOf(harness.botSeat('seat_3')) },
    ]);
    expect(guest.all('bot_seat_provenance')).toEqual([]);
  });

  it('is not sent at all when no bot seat was generated', () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor({ mode: 'exact_precon', preconId: 'precon_goblin_swarm' }),
    });
    expect(harness.host.all('bot_seat_provenance')).toEqual([]);
  });

  it('is restated after every lobby change, so a removal cannot leave it stale', () => {
    const harness = createHarness(3);
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(generatedSource()) });
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor(generatedSource(OTHER_COMMANDER_ID, 'second-seed')),
    });
    expect(harness.host.last('bot_seat_provenance')?.seats.map((entry) => entry.seatId)).toEqual([
      'seat_2',
      'seat_3',
    ]);

    harness.send(harness.host, { type: 'remove_bot', seatId: 'seat_2' });
    expect(harness.host.last('bot_seat_provenance')?.seats.map((entry) => entry.seatId)).toEqual([
      'seat_3',
    ]);
  });
});

/* ------------------------------------------------------------------ reroll */

describe('rerolling before the match starts', () => {
  it('takes one deterministic step along the seat`s own stream', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(generatedSource()) });
    const before = provenanceOf(harness.botSeat('seat_2'));

    harness.send(harness.host, { type: 'reroll_bot', seatId: 'seat_2' });
    const after = provenanceOf(harness.botSeat('seat_2'));

    expect(lastError(harness.host)).toBeUndefined();
    expect(after.rerollCount).toBe(1);
    expect(after.seed).toBe(generationSeedFor(SEED, 1));
    expect(before.seed).toBe(SEED);
    expect(after.deckHash).not.toBe(before.deckHash);
    expect(after.commanderId).toBe(COMMANDER_ID);
    expect(
      validateDeck(generatedDeckOf(harness.botSeat('seat_2')), database, deckFormat).legal,
    ).toBe(true);
  });

  it('records a transition another build can reproduce from the two values it keeps', () => {
    const first = createHarness();
    first.send(first.host, { type: 'add_bot', setup: setupFor(generatedSource()) });
    first.send(first.host, { type: 'reroll_bot', seatId: 'seat_2' });
    first.send(first.host, { type: 'reroll_bot', seatId: 'seat_2' });
    const rolled = provenanceOf(first.botSeat('seat_2'));

    // Nothing but the base seed and the count is needed to rebuild it: a second
    // server told the derived seed directly produces the identical deck.
    const rebuilt = generateBotDeck({
      commanderId: COMMANDER_ID,
      baseSeed: SEED,
      rerollCount: 2,
      database,
      deckFormat,
      now: () => 0,
    });
    expect(rolled.rerollCount).toBe(2);
    expect(rebuilt.ok && rebuilt.value.provenance.deckHash).toBe(rolled.deckHash);
    expect(rolled.seed).toBe(`${SEED}:reroll:2`);
  });

  it('is refused on a seat playing an exact list, and changes nothing', () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor({ mode: 'exact_precon', preconId: 'precon_goblin_swarm' }),
    });
    const before = generatedDeckOf(harness.botSeat('seat_2'));

    harness.send(harness.host, { type: 'reroll_bot', seatId: 'seat_2' });

    expect(lastError(harness.host)?.code).toBe('protocol/bot_mode_unsupported');
    expect(generatedDeckOf(harness.botSeat('seat_2'))).toEqual(before);
  });

  it('keeps its place when the host changes something that does not name the stream', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(generatedSource()) });
    harness.send(harness.host, { type: 'reroll_bot', seatId: 'seat_2' });
    const rolled = provenanceOf(harness.botSeat('seat_2'));

    harness.send(harness.host, {
      type: 'update_bot',
      seatId: 'seat_2',
      setup: setupFor(generatedSource(), { style: 'aggressive' }),
    });

    const after = provenanceOf(harness.botSeat('seat_2'));
    expect(harness.botSeat('seat_2').config.style).toBe('aggressive');
    expect(after.rerollCount).toBe(1);
    expect(after.deckHash).toBe(rolled.deckHash);
  });

  it('restarts when the host changes the Commander or the seed', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(generatedSource()) });
    harness.send(harness.host, { type: 'reroll_bot', seatId: 'seat_2' });

    harness.send(harness.host, {
      type: 'update_bot',
      seatId: 'seat_2',
      setup: setupFor(generatedSource(OTHER_COMMANDER_ID)),
    });

    const after = provenanceOf(harness.botSeat('seat_2'));
    expect(after.commanderId).toBe(OTHER_COMMANDER_ID);
    expect(after.rerollCount).toBe(0);
    expect(after.seed).toBe(SEED);
  });

  it('is refused once the match has started', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(generatedSource()) });
    harness.send(harness.host, { type: 'submit_precon', preconId: 'precon_goblin_swarm' });
    harness.send(harness.host, { type: 'set_ready', ready: true });
    harness.send(harness.host, { type: 'start_match' });
    const locked = provenanceOf(harness.botSeat('seat_2'));

    harness.send(harness.host, { type: 'reroll_bot', seatId: 'seat_2' });

    expect(lastError(harness.host)?.code).toBe('protocol/already_started');
    expect(provenanceOf(harness.botSeat('seat_2'))).toEqual(locked);
  });
});

/* ---------------------------------------------------------- the two helpers */

describe('the two rules the seat keeps to itself', () => {
  it('derives reroll 0 as the host`s own seed, and every later one as a suffix', () => {
    expect(generationSeedFor('abc', 0)).toBe('abc');
    expect(generationSeedFor('abc', 1)).toBe('abc:reroll:1');
    expect(generationSeedFor('abc', 7)).toBe('abc:reroll:7');
  });

  it('carries a reroll count only while the stream keeps its name', () => {
    const config = {
      schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
      difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
      controller: { botId: 'bot_1', displayName: 'Bot 2' },
      difficulty: DEFAULT_BOT_DIFFICULTY,
      styleSetting: 'value' as const,
      style: 'value' as const,
      pacing: IMMEDIATE_BOT_PACING,
      deck: {
        ...generatedSource(),
        generated: {
          generatorVersion: DECK_GENERATOR_VERSION,
          mode: 'commander_generated' as const,
          formatId: 'precon_wave_1',
          seed: generationSeedFor(SEED, 3),
          rerollCount: 3,
          commanderId: COMMANDER_ID,
          deckHash: 'abcdef0123456789',
          legalPoolSize: 41,
          forcedInclusionFloor: 39,
        },
      },
    };

    expect(carriedRerollCount(config, generatedSource())).toBe(3);
    expect(carriedRerollCount(config, generatedSource(OTHER_COMMANDER_ID))).toBe(0);
    expect(carriedRerollCount(config, generatedSource(COMMANDER_ID, 'other'))).toBe(0);
    expect(
      carriedRerollCount(config, { mode: 'exact_precon', preconId: 'precon_goblin_swarm' }),
    ).toBe(0);
    expect(carriedRerollCount(null, generatedSource())).toBe(0);

    // `setupOf` strips the result and keeps the instruction, which is what makes
    // it safe to feed straight back through `resolveBotSeat`.
    const setup = setupOf(config);
    expect(setup.deck).toEqual(generatedSource());
    expect(setup.displayName).toBe('Bot 2');
    expect('controller' in setup).toBe(false);
    // The public projection of that same configuration still leaks nothing.
    expect(JSON.stringify(publicBotSeatOf(config))).not.toContain('abcdef0123456789');
  });
});

/* -------------------------------------------------------- the post-match reveal */

describe('the list is private until the match is over', () => {
  /**
   * A three-seat table: the host, one other person, and a bot with a generated
   * deck. Both people concede, so the bot is the last living player and the
   * match completes with two connected humans still watching — which is what
   * makes "revealed to everybody" a claim worth asserting rather than a claim
   * about the host, who chose the deck and knew it all along.
   */
  async function mixedTable(): Promise<{ harness: Harness; guest: FakeConnection }> {
    const harness = createHarness(3);
    const guest = harness.join('Guest');
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(generatedSource()) });
    harness.send(harness.host, { type: 'submit_precon', preconId: 'precon_goblin_swarm' });
    harness.send(harness.host, { type: 'set_ready', ready: true });
    harness.send(guest, { type: 'submit_precon', preconId: 'precon_bastion_guardians' });
    harness.send(guest, { type: 'set_ready', ready: true });
    harness.send(harness.host, { type: 'start_match' });
    await harness.server.whenBotsIdle();
    return { harness, guest };
  }

  function concede(
    harness: Harness,
    connection: FakeConnection,
    playerId: 'player_1' | 'player_2',
  ): void {
    harness.send(connection, {
      type: 'submit_action',
      actionId: `act_${playerId}_concede`,
      lastSequence: connection.sequence(),
      action: { type: 'concede', playerId },
    });
  }

  it('reveals the bot`s list to everybody at the table, once, at completion', async () => {
    const { harness, guest } = await mixedTable();
    const deck = generatedDeckOf(harness.botSeat('seat_3'));

    // Nothing is revealed while the match is live, and no card of the bot's
    // deck has reached the other seat by any route at all.
    expect(guest.all('bot_decks_revealed')).toEqual([]);
    const liveTraffic = JSON.stringify(guest.sent);
    expect(deck.cards.every((entry) => !liveTraffic.includes(entry.cardId))).toBe(true);

    concede(harness, guest, 'player_2');
    await harness.server.whenBotsIdle();
    concede(harness, harness.host, 'player_1');
    await harness.server.whenBotsIdle();

    expect(harness.lobby().status).toBe('finished');
    const revealed = guest.all('bot_decks_revealed');
    expect(revealed).toHaveLength(1);
    expect(revealed[0]?.decks).toHaveLength(1);
    const entry = revealed[0]?.decks[0];
    expect(entry?.seatId).toBe('seat_3');
    expect(entry?.botId).toBe(harness.botSeat('seat_3').config.controller.botId);
    expect(entry?.commanderId).toBe(COMMANDER_ID);
    expect(entry?.cardIds).toHaveLength(deckFormat.deckSize);
    expect([...(entry?.cardIds ?? [])].sort()).toEqual(
      deck.cards.flatMap((card) => Array.from({ length: card.quantity }, () => card.cardId)).sort(),
    );
    expect(entry?.generated).toEqual(provenanceOf(harness.botSeat('seat_3')));
    // The host is told the same thing, at the same time.
    expect(harness.host.all('bot_decks_revealed')).toEqual(revealed);
  });

  it('is not sent by a match that had no bot in it', () => {
    const harness = createHarness();
    const guest = harness.join('Guest');
    harness.send(harness.host, { type: 'submit_precon', preconId: 'precon_goblin_swarm' });
    harness.send(harness.host, { type: 'set_ready', ready: true });
    harness.send(guest, { type: 'submit_precon', preconId: 'precon_bastion_guardians' });
    harness.send(guest, { type: 'set_ready', ready: true });
    harness.send(harness.host, { type: 'start_match' });
    harness.send(guest, {
      type: 'submit_action',
      actionId: 'act_concede',
      lastSequence: guest.sequence(),
      action: { type: 'concede', playerId: 'player_2' },
    });

    expect(harness.lobby().status).toBe('finished');
    expect(guest.all('bot_decks_revealed')).toEqual([]);
    expect(harness.host.all('bot_decks_revealed')).toEqual([]);
  });
});

/* ------------------------------------------------- the deck a bot actually plays */

describe('the generated deck the match is played with', () => {
  it('is the frozen list the lobby validated, unchanged by the match starting', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(generatedSource()) });
    const before: SavedDeck = structuredClone(generatedDeckOf(harness.botSeat('seat_2')));

    harness.send(harness.host, { type: 'submit_precon', preconId: 'precon_goblin_swarm' });
    harness.send(harness.host, { type: 'set_ready', ready: true });
    harness.send(harness.host, { type: 'start_match' });

    expect(harness.lobby().status).toBe('in_match');
    expect(generatedDeckOf(harness.botSeat('seat_2'))).toEqual(before);
  });
});

/* --------------------------------------------------------------- the format */

describe('the pool the generator is given', () => {
  it('is the server`s own format-scoped one, so both verdicts come from one pool', () => {
    const built = generateBotDeck({
      commanderId: COMMANDER_ID,
      baseSeed: SEED,
      rerollCount: 0,
      database,
      deckFormat,
      now: () => 0,
    });
    expect(built.ok).toBe(true);
    if (!built.ok) return;

    const legal = new Set(formatCardPool(deckFormat.formatId).map((card) => card.id));
    for (const entry of built.value.deck.cards) expect(legal.has(entry.cardId)).toBe(true);
    expect(built.value.provenance.formatId).toBe(deckFormat.formatId);
  });

  it('never generates from a format this build does not publish', () => {
    const unknown: DeckFormatConfig = { ...deckFormat, formatId: 'no_such_format' };
    const built = generateBotDeck({
      commanderId: COMMANDER_ID,
      baseSeed: SEED,
      rerollCount: 0,
      // The database is the authority on the pool, so an unknown format ID does
      // not silently widen it: the deck is still drawn from the pool it was
      // given, and the refusal path is the same one every other caller gets.
      database: new CardDatabase([]),
      deckFormat: unknown,
      now: () => 0,
    });
    expect(built.ok).toBe(false);
  });
});
