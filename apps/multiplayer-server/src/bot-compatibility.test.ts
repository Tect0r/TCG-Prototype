import { describe, expect, it } from 'vitest';
import {
  BOT_CONFIG_SCHEMA_VERSION,
  DEFAULT_BOT_DIFFICULTY,
  DEFAULT_BOT_PACING_BUDGETS,
  DIFFICULTY_REGISTRY_VERSION,
  IMMEDIATE_BOT_PACING,
  PACING_CONFIG_VERSION,
} from '@tcg/bot-config';
import { MAX_FORMAT_DECK_SIZE, loadFormatCardData, resolveFormatId } from '@tcg/card-data';
import { deckFormatOf } from '@tcg/deck';
import { CURRENT_VERSIONS, encode, type ServerMessage } from '@tcg/protocol';
import { MatchServer, type ServerConnection } from './match-server.js';

/**
 * What a host is actually told when their build and the server's disagree
 * (M09.18).
 *
 * `bot-compatibility.test.ts` in `@tcg/protocol` proves the codec classifies
 * correctly. This proves the classification survives the whole path a real host
 * takes — `receive` → decode → `handle` → an `error` frame on their own socket —
 * because that is the only place the wording is worth anything. A refusal the
 * codec produces and the server swallows would pass the unit test and still
 * leave the host looking at nothing.
 *
 * The three messages that carry a versioned bot artifact are driven separately,
 * each against a future version and against an ordinary malformed value, and the
 * lobby is checked afterwards: a refused message must change nothing.
 */

const shipping = loadFormatCardData(resolveFormatId());
if (!shipping.ok) throw new Error('The shipping format did not resolve to a card pool.');
const { database, format } = shipping.value;
const deckFormat = deckFormatOf(format);

const PRECON_ID = 'precon_goblin_swarm';

function rawSetup(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
    difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
    difficulty: DEFAULT_BOT_DIFFICULTY,
    style: 'value',
    deck: { mode: 'exact_precon', preconId: PRECON_ID },
    pacing: IMMEDIATE_BOT_PACING,
    displayName: null,
    ...over,
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

function createHarness() {
  const server = new MatchServer({
    database,
    deckFormat,
    random: () => 0.5,
    seedFor: () => 'fixed-compatibility-seed',
    now: () => 1_000_000,
  });

  const host = new FakeConnection('conn_host');
  server.connect(host);
  /** Raw, so a test can send a message no `ClientMessage` type would allow. */
  const sendRaw = (message: unknown): void => {
    server.receive(host, JSON.stringify(message));
  };

  server.receive(
    host,
    encode({
      type: 'create_lobby',
      versions: CURRENT_VERSIONS,
      displayName: 'Host',
      maxSeats: 2,
    }),
  );
  const joined = host.last('lobby_joined');
  if (!joined) throw new Error('The host did not create a lobby.');

  const lobby = () => {
    const found = server.lobbyByCode(joined.lobby.inviteCode);
    if (!found) throw new Error('The lobby is gone.');
    return found;
  };

  return { server, host, sendRaw, lobby, error: () => host.last('error')?.error };
}

/** Seats one bot, so `update_bot` has a seat to name. */
function withSeatedBot() {
  const harness = createHarness();
  harness.sendRaw({ type: 'add_bot', setup: rawSetup() });
  const seated = [...harness.lobby().seats.values()].find((seat) => seat.controller === 'bot');
  if (!seated) throw new Error('The bot was not seated.');
  return { ...harness, seatId: seated.seatId };
}

/* ------------------------------------------------------------ the three messages */

describe('a host running a newer build than the server', () => {
  it('is told so by name when they add a bot', () => {
    const harness = createHarness();
    harness.sendRaw({
      type: 'add_bot',
      setup: rawSetup({ schemaVersion: BOT_CONFIG_SCHEMA_VERSION + 1 }),
    });

    const error = harness.error();
    expect(error?.code).toBe('protocol/bot_config_invalid');
    expect(error?.details?.join(' ')).toContain(
      `bot configuration schema version ${BOT_CONFIG_SCHEMA_VERSION + 1}`,
    );
    expect(error?.details?.join(' ')).toContain('Update the application.');
    // Nothing was seated: a refusal that half-applied would be worse than one
    // with poor wording.
    expect(harness.lobby().seats.size).toBe(1);
  });

  it('is told so by name when they reconfigure a bot', () => {
    const harness = withSeatedBot();
    harness.sendRaw({
      type: 'update_bot',
      seatId: harness.seatId,
      setup: rawSetup({
        difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION + 1,
        difficulty: 'easy',
      }),
    });

    const error = harness.error();
    expect(error?.code).toBe('protocol/bot_config_invalid');
    expect(error?.details?.join(' ')).toContain(
      `difficulty registry version ${DIFFICULTY_REGISTRY_VERSION + 1}`,
    );
    // The previous configuration is untouched, which is what M09.3 promised a
    // refused `update_bot` would leave behind.
    const seat = harness.lobby().seats.get(harness.seatId);
    expect(seat?.controller === 'bot' ? seat.config.difficulty : null).toBe(DEFAULT_BOT_DIFFICULTY);
  });

  it('is told so by name when they set the table pacing', () => {
    const harness = createHarness();
    harness.sendRaw({
      type: 'set_bot_pacing',
      budgets: { ...DEFAULT_BOT_PACING_BUDGETS, pacingVersion: PACING_CONFIG_VERSION + 1 },
    });

    const error = harness.error();
    expect(error?.code).toBe('protocol/bot_config_invalid');
    expect(error?.details?.join(' ')).toContain(
      `bot pacing configuration version ${PACING_CONFIG_VERSION + 1}`,
    );
    // And the table kept the budgets it had.
    expect(harness.lobby().pacing).toEqual(DEFAULT_BOT_PACING_BUDGETS);
  });
});

/* -------------------------------------------------------- and everything else */

describe('an ordinary bad message from a current build', () => {
  it('is still a malformed message, on all three', () => {
    const harness = withSeatedBot();
    for (const message of [
      { type: 'add_bot', setup: rawSetup({ schemaVersion: 0 }) },
      { type: 'add_bot', setup: rawSetup({ difficulty: 'nightmare' }) },
      { type: 'update_bot', seatId: harness.seatId, setup: rawSetup({ schemaVersion: '2' }) },
      {
        type: 'set_bot_pacing',
        budgets: { ...DEFAULT_BOT_PACING_BUDGETS, ordinarySeconds: 0 },
      },
      {
        type: 'set_bot_pacing',
        budgets: { ...DEFAULT_BOT_PACING_BUDGETS, pacingVersion: 0 },
      },
    ]) {
      harness.sendRaw(message);
      const error = harness.error();
      expect(error?.code, JSON.stringify(message)).toBe('protocol/malformed_message');
    }
  });

  it('refuses a deck list longer than any format could require', () => {
    const harness = createHarness();
    harness.sendRaw({
      type: 'add_bot',
      setup: rawSetup({
        deck: {
          mode: 'exact_saved_deck',
          deck: {
            sourceDeckId: 'saved_1',
            name: 'Far too many cards',
            commanderId: 'goblin_chieftain',
            cardIds: Array.from({ length: MAX_FORMAT_DECK_SIZE + 1 }, () => 'goblin_scout'),
            deckHash: 'abcdef0123456789',
          },
        },
      }),
    });

    const error = harness.error();
    // A list this long is a malformed record, not a record from a newer build:
    // the ceiling is what every readable format already implies (M09.18).
    expect(error?.code).toBe('protocol/malformed_message');
    expect(error?.details?.join(' ')).toContain(
      `A deck list may hold at most ${MAX_FORMAT_DECK_SIZE} cards`,
    );
    expect(harness.lobby().seats.size).toBe(1);
  });
});

/* ---------------------------------------------------------- the supported path */

describe('a host running the same build', () => {
  it('seats, reconfigures and paces a bot with nothing refused', () => {
    const harness = withSeatedBot();
    expect(harness.error()).toBeUndefined();

    harness.sendRaw({
      type: 'update_bot',
      seatId: harness.seatId,
      setup: rawSetup({ difficulty: 'easy' }),
    });
    harness.sendRaw({
      type: 'set_bot_pacing',
      budgets: { pacingVersion: PACING_CONFIG_VERSION, ordinarySeconds: 12, reactionSeconds: 3 },
    });

    expect(harness.error()).toBeUndefined();
    const seat = harness.lobby().seats.get(harness.seatId);
    expect(seat?.controller === 'bot' ? seat.config.difficulty : null).toBe('easy');
    expect(harness.lobby().pacing.ordinarySeconds).toBe(12);
  });
});
