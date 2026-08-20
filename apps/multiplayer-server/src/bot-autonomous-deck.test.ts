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
  playableCommanders,
  validateDeck,
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
import {
  commanderSelectionSeedFor,
  generatableCommanders,
  generateAutonomousBotDeck,
  generationSeedFor,
  selectBotCommander,
} from './bot-generated-deck.js';
import { carriedRerollCount, setupOf } from './bot-seats.js';
import { isBotSeat, type BotSeat, type Lobby } from './lobby.js';
import { MatchServer, type ScheduleTimer, type ServerConnection } from './match-server.js';

/**
 * Full AI Commander-and-deck choice (M09.10).
 *
 * The fourth and last deck mode, and the only one where the software decides
 * what it brings. Five claims are under test, and they are the tranche's own.
 *
 * **The choice is deterministic and its own.** It comes from a selection stream
 * derived from the seat's seed and from nothing else, so the same seed names the
 * same Commander from a cold start, and a reroll is one reproducible step.
 *
 * **Every playable Commander is reachable, and nothing else is.** The candidates
 * are `playableCommanders` against a format-scoped database — the same list a
 * host is offered — so a bot cannot pick something a host could not, and no
 * playable Commander is quietly unreachable.
 *
 * **There is no counterpick.** The tests below play the same seed against
 * opponents holding deliberately different decks and require an identical
 * Commander and an identical deck hash, and `selectBotCommander`'s signature has
 * nowhere for an opponent's deck to enter even if somebody wanted it to
 * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §3).
 *
 * **The deck is frozen and self-describing**, through the same generator and the
 * same provenance shape a host-chosen Commander produces.
 *
 * **The Commander is public and the list is not** — until the match is over,
 * when everybody gets it.
 *
 * Most of it is driven through encoded messages, so what is asserted is what a
 * real host and a real guest would receive. The two states no shipped content
 * can reach — a format with no playable Commander, and a pool too small to fill
 * a deck — are driven straight through the resolver.
 */

const shipping = loadFormatCardData(resolveFormatId());
if (!shipping.ok) throw new Error('The shipping format did not resolve to a card pool.');
const { database, format } = shipping.value;
const deckFormat = deckFormatOf(format);

const SEED = 'autonomous-seed-1';

function autonomousSource(
  seed: string = SEED,
): Extract<BotDeckSource, { mode: 'autonomous_generated' }> {
  return { mode: 'autonomous_generated', seed, generated: null };
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
    seedFor: () => 'fixed-autonomous-seed',
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
  if (source.mode !== 'autonomous_generated' || !source.generated) {
    throw new Error('That bot seat has no autonomous provenance.');
  }
  return source.generated;
}

/** The Commander this seed names, computed the way the server computes it. */
function expectedCommanderFor(seed: string, rerollCount = 0): string {
  const chosen = selectBotCommander(
    generatableCommanders(database, deckFormat),
    commanderSelectionSeedFor(seed, rerollCount),
  );
  if (!chosen) throw new Error('The shipping format offers no Commander to choose.');
  return chosen.id;
}

/* ------------------------------------------------------------- the choosing */

describe('the Commander a bot chooses for itself', () => {
  const candidates = generatableCommanders(database, deckFormat);

  it('is drawn from the same list a host is offered, and no wider one', () => {
    // The rule is `playableCommanders`, not "any card of type commander": the
    // bundled universe publishes Commanders this format does not, and a bot must
    // no more reach them than a host can.
    expect(new Set(candidates.map((card) => card.id))).toEqual(
      new Set(playableCommanders(database, deckFormat).map((card) => card.id)),
    );

    const reachable = new Set<string>();
    for (let i = 0; i < 400; i += 1) {
      reachable.add(expectedCommanderFor(`sweep-${i}`));
    }
    // Every candidate is reachable, and nothing outside the candidates ever is.
    expect(reachable).toEqual(new Set(candidates.map((card) => card.id)));
  });

  it('is the same choice from the same seed, and does not depend on the caller`s ordering', () => {
    const first = selectBotCommander(candidates, 'a-seed');
    const second = selectBotCommander([...candidates].reverse(), 'a-seed');
    expect(first?.id).toBe(second?.id);
    // Sorted by ID inside, so the display order a caller happens to hand over —
    // which is locale-sensitive — cannot move the draw.
    expect(selectBotCommander([...candidates].reverse(), 'a-seed')?.id).toBe(first?.id);
  });

  it('has nowhere for an opponent to enter: candidates and a seed, and nothing else', () => {
    // The signature is the guarantee. `selectBotCommander` cannot read a lobby,
    // a seat, a hand or a saved deck because it is never given one, so "no
    // hidden counterpick" is a fact about the type rather than about the body.
    expect(selectBotCommander.length).toBe(2);
    expect(selectBotCommander([], 'anything')).toBeNull();
  });

  it('takes its own stream, one step per reroll', () => {
    expect(commanderSelectionSeedFor('abc', 0)).toBe('abc:commander');
    expect(commanderSelectionSeedFor('abc', 2)).toBe('abc:reroll:2:commander');
    // Distinct from the deck draw's stream, so the choice and the cards are not
    // two reads of one cursor.
    expect(commanderSelectionSeedFor('abc', 0)).not.toBe(generationSeedFor('abc', 0));
  });
});

/* --------------------------------------------------- what the server seats */

describe('a bot that picks its own Commander and deck', () => {
  it('is seated ready, with a legal deck and a full record of how it was built', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(autonomousSource()) });

    const seat = harness.botSeat('seat_2');
    const provenance = provenanceOf(seat);
    expect(provenance.mode).toBe('autonomous_generated');
    expect(provenance.generatorVersion).toBe(DECK_GENERATOR_VERSION);
    expect(provenance.formatId).toBe(deckFormat.formatId);
    expect(provenance.seed).toBe(SEED);
    expect(provenance.rerollCount).toBe(0);
    expect(provenance.commanderId).toBe(expectedCommanderFor(SEED));
    expect(provenance.legalPoolSize).toBeGreaterThan(0);
    expect(provenance.forcedInclusionFloor).toBeGreaterThan(0);

    // Judged by the same authority a person's deck is judged by, against the
    // same pool: a bot gets no allowance the deck builder would not give.
    const deck = generatedDeckOf(seat);
    expect(deck.commanderId).toBe(provenance.commanderId);
    expect(validateDeck(deck, database, deckFormat).legal).toBe(true);
    expect(deck.cards.reduce((sum, entry) => sum + entry.quantity, 0)).toBe(deckFormat.deckSize);
    expect(seat.ready).toBe(true);
    expect(seat.deckLegal).toBe(true);

    const legal = new Set(formatCardPool(deckFormat.formatId).map((card) => card.id));
    for (const entry of deck.cards) expect(legal.has(entry.cardId)).toBe(true);
  });

  it('builds the same deck from the same seed, from two cold starts', () => {
    const first = createHarness();
    first.send(first.host, { type: 'add_bot', setup: setupFor(autonomousSource()) });
    const second = createHarness();
    second.send(second.host, { type: 'add_bot', setup: setupFor(autonomousSource()) });

    expect(provenanceOf(second.botSeat('seat_2'))).toEqual(provenanceOf(first.botSeat('seat_2')));
    expect(generatedDeckOf(second.botSeat('seat_2')).cards).toEqual(
      generatedDeckOf(first.botSeat('seat_2')).cards,
    );
  });

  it('builds the deck a host-chosen Commander would have built from the same seed', () => {
    // The mode records who chose; it does not change what was built. A seed and
    // a Commander name one deck either way, which is what makes a recorded seed
    // worth writing down.
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(autonomousSource()) });
    const chosen = provenanceOf(harness.botSeat('seat_2'));

    const host = createHarness();
    host.send(host.host, {
      type: 'add_bot',
      setup: setupFor({
        mode: 'commander_generated',
        commanderId: chosen.commanderId,
        seed: SEED,
        generated: null,
      }),
    });
    const seat = host.botSeat('seat_2');
    const other = seat.config.deck;
    if (other.mode !== 'commander_generated' || !other.generated) throw new Error('no provenance');
    expect(other.generated.deckHash).toBe(chosen.deckHash);
    expect(other.generated.mode).toBe('commander_generated');
    expect(generatedDeckOf(seat).cards).toEqual(generatedDeckOf(harness.botSeat('seat_2')).cards);
  });

  it('actually plays the deck it built for itself', async () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(autonomousSource()) });
    harness.send(harness.host, { type: 'submit_precon', preconId: 'precon_goblin_swarm' });
    harness.send(harness.host, { type: 'set_ready', ready: true });
    harness.send(harness.host, { type: 'start_match' });
    await harness.server.whenBotsIdle();

    // A bot is the very first seat to act here, at the mulligan, so having acted
    // by the time the runner is idle is what "this mode is playable" means: the
    // seat took the same `applyAction` path a human takes, with the deck the
    // server generated for it, and the board is waiting on the person rather
    // than on it.
    const seat = harness.botSeat('seat_2');
    expect(seat.appliedActions.size).toBeGreaterThan(0);
    expect(harness.lobby().state?.status).toBe('mulligan');
    expect(harness.host.last('match_state')?.view.legalActions.mulligan).not.toBeNull();
  });

  it('is unchanged by the match starting', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(autonomousSource()) });
    const before: SavedDeck = structuredClone(generatedDeckOf(harness.botSeat('seat_2')));

    harness.send(harness.host, { type: 'submit_precon', preconId: 'precon_goblin_swarm' });
    harness.send(harness.host, { type: 'set_ready', ready: true });
    harness.send(harness.host, { type: 'start_match' });

    expect(harness.lobby().status).toBe('in_match');
    expect(generatedDeckOf(harness.botSeat('seat_2'))).toEqual(before);
  });
});

/* ------------------------------------------------------- no counterpicking */

describe('the choice cannot be influenced by what the server knows about the table', () => {
  /**
   * The same seed, against two deliberately different opponents.
   *
   * The server holds each guest's complete deck by the time the bot is seated —
   * it validated it — so if the choice were counterpicked at all, this is where
   * it would show. It is asserted at the deck hash rather than only at the
   * Commander, because a counterpick could as easily be a different draw under
   * the same Commander.
   */
  function seatBotAgainst(preconId: string): { commanderId: string; deckHash: string } {
    const harness = createHarness(3);
    const guest = harness.join('Guest');
    harness.send(guest, { type: 'submit_precon', preconId });
    harness.send(guest, { type: 'set_ready', ready: true });
    harness.send(harness.host, { type: 'submit_precon', preconId: 'precon_goblin_swarm' });
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(autonomousSource()) });
    const provenance = provenanceOf(harness.botSeat('seat_3'));
    return { commanderId: provenance.commanderId, deckHash: provenance.deckHash };
  }

  it('picks the same Commander and builds the same deck whoever it is sitting across from', () => {
    const againstBastion = seatBotAgainst('precon_bastion_guardians');
    const againstScholars = seatBotAgainst('precon_containment_scholars');
    expect(againstScholars).toEqual(againstBastion);
    expect(againstBastion.commanderId).toBe(expectedCommanderFor(SEED));
  });

  it('picks the same Commander whether it is seated before or after its opponent', () => {
    const before = createHarness(3);
    before.send(before.host, { type: 'add_bot', setup: setupFor(autonomousSource()) });
    const guest = before.join('Guest');
    before.send(guest, { type: 'submit_precon', preconId: 'precon_bastion_guardians' });

    const after = createHarness(3);
    const other = after.join('Guest');
    after.send(other, { type: 'submit_precon', preconId: 'precon_bastion_guardians' });
    after.send(after.host, { type: 'add_bot', setup: setupFor(autonomousSource()) });

    expect(provenanceOf(after.botSeat('seat_3')).deckHash).toBe(
      provenanceOf(before.botSeat('seat_2')).deckHash,
    );
  });
});

/* ------------------------------------------------------- several at a table */

describe('several bots choosing at one table', () => {
  it('gives each seat the Commander its own seed names, independently of the others', () => {
    const harness = createHarness(4);
    const seeds = ['stream-a', 'stream-b', 'stream-c'];
    for (const seed of seeds) {
      harness.send(harness.host, { type: 'add_bot', setup: setupFor(autonomousSource(seed)) });
    }

    const seatIds = ['seat_2', 'seat_3', 'seat_4'];
    seatIds.forEach((seatId, index) => {
      const seed = seeds[index] as string;
      const provenance = provenanceOf(harness.botSeat(seatId));
      // Its own seed decides it — not its seat, not the order it was added, and
      // not what the seats beside it chose.
      expect(provenance.seed).toBe(seed);
      expect(provenance.commanderId).toBe(expectedCommanderFor(seed));
    });
  });

  it('gives one seed one answer wherever it is seated', () => {
    const first = createHarness(4);
    first.send(first.host, { type: 'add_bot', setup: setupFor(autonomousSource('shared')) });

    const second = createHarness(4);
    second.send(second.host, { type: 'add_bot', setup: setupFor(autonomousSource('other')) });
    second.send(second.host, { type: 'add_bot', setup: setupFor(autonomousSource('shared')) });

    // Seat 2 in one lobby and seat 3 in another, same seed, same deck: the
    // stream is named by the seed the host wrote, so a host can reproduce a deck
    // without reproducing a seating (M09.9's rule, kept).
    expect(provenanceOf(second.botSeat('seat_3')).deckHash).toBe(
      provenanceOf(first.botSeat('seat_2')).deckHash,
    );
  });
});

/* -------------------------------------------------------------- rerolling */

describe('rerolling a bot that chooses for itself', () => {
  it('takes one step along the seat`s own stream, and records it', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(autonomousSource()) });
    const before = provenanceOf(harness.botSeat('seat_2'));

    harness.send(harness.host, { type: 'reroll_bot', seatId: 'seat_2' });
    const after = provenanceOf(harness.botSeat('seat_2'));

    expect(after.rerollCount).toBe(1);
    expect(after.seed).toBe(generationSeedFor(SEED, 1));
    expect(after.commanderId).toBe(expectedCommanderFor(SEED, 1));
    expect(after.deckHash).not.toBe(before.deckHash);

    // Reproducible from the two values the provenance carries, by a caller with
    // no lobby at all: the transition is the server's, and it is not a secret.
    const replay = generateAutonomousBotDeck({
      baseSeed: SEED,
      rerollCount: 1,
      database,
      deckFormat,
      now: () => 0,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) return;
    expect(replay.value.provenance.deckHash).toBe(after.deckHash);
    expect(replay.value.provenance.commanderId).toBe(after.commanderId);
  });

  it('can land on a different Commander, because the choice is rerolled too', () => {
    // Found rather than asserted of one seed: with four candidates a reroll
    // keeps the Commander a quarter of the time, and a test that demanded a
    // change from a fixed seed would be asserting luck.
    const moved = ['s-0', 's-1', 's-2', 's-3', 's-4', 's-5', 's-6', 's-7'].filter(
      (seed) => expectedCommanderFor(seed, 1) !== expectedCommanderFor(seed, 0),
    );
    expect(moved.length).toBeGreaterThan(0);

    const seed = moved[0] as string;
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(autonomousSource(seed)) });
    const before = provenanceOf(harness.botSeat('seat_2')).commanderId;
    harness.send(harness.host, { type: 'reroll_bot', seatId: 'seat_2' });

    const seat = harness.botSeat('seat_2');
    expect(provenanceOf(seat).commanderId).not.toBe(before);
    // The public projection moves with it: an opponent is never left looking at
    // the Commander of a deck that is no longer being played.
    expect(publicBotSeatOf(seat.config).deck).toEqual({
      mode: 'autonomous_generated',
      commanderId: provenanceOf(seat).commanderId,
    });
    expect(generatedDeckOf(seat).commanderId).toBe(provenanceOf(seat).commanderId);
  });

  it('keeps its place in the stream when the host changes something else', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(autonomousSource()) });
    harness.send(harness.host, { type: 'reroll_bot', seatId: 'seat_2' });
    harness.send(harness.host, { type: 'reroll_bot', seatId: 'seat_2' });
    const rerolled = provenanceOf(harness.botSeat('seat_2'));

    harness.send(harness.host, {
      type: 'update_bot',
      seatId: 'seat_2',
      setup: setupFor(autonomousSource(), { style: 'aggressive' }),
    });

    // Renaming, restyling or re-difficulting a bot must not silently undo two
    // rerolls, so the deck it is on survives a configuration change.
    expect(provenanceOf(harness.botSeat('seat_2'))).toEqual(rerolled);
    expect(harness.botSeat('seat_2').config.style).toBe('aggressive');
  });

  it('restarts the stream when the seed changes, or when the mode does', () => {
    const seatConfig = (seed: string, rerollCount: number) => ({
      schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
      difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
      controller: { botId: 'bot_1', displayName: 'Bot 2' },
      difficulty: DEFAULT_BOT_DIFFICULTY,
      style: 'value' as const,
      pacing: IMMEDIATE_BOT_PACING,
      deck: {
        ...autonomousSource(seed),
        generated: {
          generatorVersion: DECK_GENERATOR_VERSION,
          mode: 'autonomous_generated' as const,
          formatId: 'precon_wave_1',
          seed: generationSeedFor(seed, rerollCount),
          rerollCount,
          commanderId: expectedCommanderFor(seed, rerollCount),
          deckHash: 'abcdef0123456789',
          legalPoolSize: 41,
          forcedInclusionFloor: 39,
        },
      },
    });

    const config = seatConfig(SEED, 3);
    expect(carriedRerollCount(config, autonomousSource())).toBe(3);
    expect(carriedRerollCount(config, autonomousSource('elsewhere'))).toBe(0);
    // Who chooses the Commander is what the mode says, so the same seed under
    // the other generated mode is a different stream by definition.
    expect(
      carriedRerollCount(config, {
        mode: 'commander_generated',
        commanderId: expectedCommanderFor(SEED),
        seed: SEED,
        generated: null,
      }),
    ).toBe(0);
    expect(
      carriedRerollCount(config, { mode: 'exact_precon', preconId: 'precon_goblin_swarm' }),
    ).toBe(0);

    // `setupOf` strips the result and keeps the instruction, which is what makes
    // it safe to feed straight back through `resolveBotSeat` on a reroll.
    expect(setupOf(config).deck).toEqual(autonomousSource());
  });

  it('is refused once the match has started', () => {
    const harness = createHarness();
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(autonomousSource()) });
    harness.send(harness.host, { type: 'submit_precon', preconId: 'precon_goblin_swarm' });
    harness.send(harness.host, { type: 'set_ready', ready: true });
    harness.send(harness.host, { type: 'start_match' });
    const locked = provenanceOf(harness.botSeat('seat_2'));

    harness.send(harness.host, { type: 'reroll_bot', seatId: 'seat_2' });

    expect(lastError(harness.host)?.code).toBe('protocol/already_started');
    expect(provenanceOf(harness.botSeat('seat_2'))).toEqual(locked);
  });
});

/* --------------------------------------------------------------- refusals */

describe('a bot that cannot choose is refused rather than given something', () => {
  it('says so when the format leaves no Commander to choose from', () => {
    // Built rather than found: no shipped format is in this state, and the point
    // is that one becoming so is refused by name instead of crashing a lobby.
    const withoutCommanders = new CardDatabase(
      formatCardPool(deckFormat.formatId).filter((card) => card.type !== 'commander'),
    );
    const built = generateAutonomousBotDeck({
      baseSeed: SEED,
      rerollCount: 0,
      database: withoutCommanders,
      deckFormat,
      now: () => 0,
    });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('protocol/bot_deck_illegal');
    expect(built.error.details?.join(' ')).toContain('can lead a generated deck');
  });

  it('refuses an impossible generation with the generator`s own problem code', () => {
    // A pool that cannot fill the format's deck: the development set judged by
    // the 40-card singleton rules. The Commander it picked is refused rather
    // than swapped for the next candidate, because retrying down the list would
    // be a repair policy invisible in the provenance.
    const built = generateAutonomousBotDeck({
      baseSeed: SEED,
      rerollCount: 0,
      database: formatDatabase('development'),
      deckFormat: PRECON_WAVE_1_DECK_FORMAT,
      now: () => 0,
    });

    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.error.code).toBe('protocol/bot_deck_illegal');
    expect(built.error.details?.join(' ')).toContain('sim/pool_too_small');
  });

  it('never picks a Commander whose behaviour is not structured yet', () => {
    const pool = formatCardPool(deckFormat.formatId);
    const target = generatableCommanders(database, deckFormat)[0] as CardDefinition;
    const broken: CardDefinition = {
      ...target,
      implemented: false,
      unsupportedReason: 'its ability has no structured effect yet',
    };
    const crippled = new CardDatabase([...pool.filter((card) => card.id !== target.id), broken]);

    for (let i = 0; i < 200; i += 1) {
      const chosen = selectBotCommander(
        generatableCommanders(crippled, deckFormat),
        commanderSelectionSeedFor(`sweep-${i}`, 0),
      );
      expect(chosen?.id).not.toBe(target.id);
    }
  });

  it('refuses a setup that describes a deck the server did not build', () => {
    const harness = createHarness();
    harness.send(harness.host, {
      type: 'add_bot',
      setup: setupFor({
        ...autonomousSource(),
        generated: {
          generatorVersion: DECK_GENERATOR_VERSION,
          mode: 'autonomous_generated',
          formatId: deckFormat.formatId,
          seed: SEED,
          rerollCount: 0,
          commanderId: expectedCommanderFor(SEED),
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

/* --------------------------------------------------------------- privacy */

describe('the Commander is public and the list is not', () => {
  it('publishes the chosen Commander to every seat and the seed to none of them', () => {
    const harness = createHarness(3);
    const guest = harness.join('Guest');
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(autonomousSource()) });

    const seat = seatViews(guest).seats.find((entry) => entry.seatId === 'seat_3');
    expect(seat?.controller).toBe('bot');
    expect(seat?.bot?.deck).toEqual({
      mode: 'autonomous_generated',
      commanderId: expectedCommanderFor(SEED),
    });
    // No list, no name, no seed, no hash: the public projection has no field for
    // any of them, so there is nothing to remember to strip.
    expect(seat?.deckName).toBeNull();

    const provenance = provenanceOf(harness.botSeat('seat_3'));
    const guestTraffic = JSON.stringify(guest.sent);
    expect(guestTraffic).not.toContain(provenance.seed);
    expect(guestTraffic).not.toContain(provenance.deckHash);
    expect(guest.all('bot_seat_provenance')).toEqual([]);
    for (const entry of generatedDeckOf(harness.botSeat('seat_3')).cards) {
      expect(guestTraffic).not.toContain(entry.cardId);
    }
  });

  it('sends the host the record of what its bot built, and restates it', () => {
    const harness = createHarness(3);
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(autonomousSource()) });

    const message = harness.host.last('bot_seat_provenance');
    expect(message?.seats).toEqual([
      { seatId: 'seat_2', generated: provenanceOf(harness.botSeat('seat_2')) },
    ]);

    // Restated beside the next lobby update rather than sent once, so a host's
    // picture cannot drift out of step with the seats it describes.
    harness.join('Guest');
    expect(harness.host.last('bot_seat_provenance')?.seats).toEqual(message?.seats);
  });

  it('reveals the list to everybody once the match is over', async () => {
    const harness = createHarness(3);
    const guest = harness.join('Guest');
    harness.send(harness.host, { type: 'add_bot', setup: setupFor(autonomousSource()) });
    harness.send(harness.host, { type: 'submit_precon', preconId: 'precon_goblin_swarm' });
    harness.send(harness.host, { type: 'set_ready', ready: true });
    harness.send(guest, { type: 'submit_precon', preconId: 'precon_bastion_guardians' });
    harness.send(guest, { type: 'set_ready', ready: true });
    harness.send(harness.host, { type: 'start_match' });
    await harness.server.whenBotsIdle();

    // Nothing is revealed while the match is live, and no card of the bot's deck
    // has reached the other seat by any route at all.
    const deck = generatedDeckOf(harness.botSeat('seat_3'));
    expect(guest.all('bot_decks_revealed')).toEqual([]);
    const liveTraffic = JSON.stringify(guest.sent);
    expect(deck.cards.every((entry) => !liveTraffic.includes(entry.cardId))).toBe(true);

    for (const [connection, playerId] of [
      [guest, 'player_2'],
      [harness.host, 'player_1'],
    ] as const) {
      harness.send(connection, {
        type: 'submit_action',
        actionId: `act_${playerId}_concede`,
        lastSequence: connection.sequence(),
        action: { type: 'concede', playerId },
      });
      await harness.server.whenBotsIdle();
    }

    expect(harness.lobby().status).toBe('finished');
    const revealed = guest.all('bot_decks_revealed');
    expect(revealed).toHaveLength(1);
    const entry = revealed[0]?.decks[0];
    expect(entry?.seatId).toBe('seat_3');
    expect(entry?.commanderId).toBe(expectedCommanderFor(SEED));
    expect(entry?.cardIds).toHaveLength(deckFormat.deckSize);
    expect([...(entry?.cardIds ?? [])].sort()).toEqual(
      deck.cards.flatMap((card) => Array.from({ length: card.quantity }, () => card.cardId)).sort(),
    );
    // The provenance rides along, so a reader can say the bot chose its own
    // Commander rather than guessing from the absence of a deck name.
    expect(entry?.generated).toEqual(provenanceOf(harness.botSeat('seat_3')));
    expect(entry?.generated?.mode).toBe('autonomous_generated');
    expect(harness.host.all('bot_decks_revealed')).toEqual(revealed);
  });
});
