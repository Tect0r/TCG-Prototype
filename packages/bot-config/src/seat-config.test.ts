import { describe, expect, it } from 'vitest';
import {
  DEFAULT_BOT_DIFFICULTY,
  FIELDS_A_BOT_CONTROLLER_NEVER_HAS,
  SEAT_CONTROLLERS,
  botControllerSchema,
  botIdSchema,
  botSeatConfigSchema,
  botSeatPublicSchema,
  publicBotSeatOf,
  readBotSeatConfig,
  seatControllerSchema,
  type BotSeatConfig,
} from './seat-config.js';
import { BOT_CONFIG_SCHEMA_VERSION, DIFFICULTY_REGISTRY_VERSION } from './version.js';
import type { BotDeckSource } from './deck-source.js';

/**
 * A bot seat's complete configuration (M09.1).
 *
 * Two claims are checked here that the rest of M09 will lean on: a bot
 * controller has no connection identity, and the public projection of a bot seat
 * is the only thing an opponent is ever handed.
 */

const SAVED_DECK: BotDeckSource = {
  mode: 'exact_saved_deck',
  deck: {
    sourceDeckId: 'saved_7',
    name: 'Sacrifice, rebuilt',
    commanderId: 'commander_grave',
    cardIds: ['card_one', 'card_two', 'card_three'],
    deckHash: '0f1e2d3c4b5a6978',
  },
};

const CONFIG: BotSeatConfig = {
  schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
  difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
  controller: { botId: 'bot_seat_2', displayName: 'Opponent 2' },
  difficulty: 'normal',
  styleSetting: 'value',
  style: 'value',
  deck: SAVED_DECK,
  pacing: { percent: 50, reactionPercent: null },
};

describe('the seat controller', () => {
  it('is explicit, and has exactly two values', () => {
    expect(SEAT_CONTROLLERS).toEqual(['human', 'bot']);
    // A `null` connection ID meaning "bot" by accident is the ambiguity the
    // stored controller exists to prevent, so there is no third "unknown".
    expect(seatControllerSchema.safeParse('spectator').success).toBe(false);
    expect(seatControllerSchema.safeParse(null).success).toBe(false);
  });

  it('gives a bot controller no connection identity', () => {
    for (const field of FIELDS_A_BOT_CONTROLLER_NEVER_HAS) {
      const widened = { botId: 'bot_seat_2', displayName: 'Opponent 2', [field]: 'anything' };
      expect(botControllerSchema.safeParse(widened).success).toBe(false);
    }
  });

  it('names the four fields that describe something which can go away', () => {
    expect(FIELDS_A_BOT_CONTROLLER_NEVER_HAS).toEqual([
      'connectionId',
      'reconnectToken',
      'disconnectDeadline',
      'graceSeconds',
    ]);
  });

  it('keeps identity separable from configuration', () => {
    // M09.16 copies one bot's settings to another seat without copying its
    // identity, which is only expressible because the two are apart.
    expect(Object.keys(botControllerSchema.parse(CONFIG.controller)).sort()).toEqual([
      'botId',
      'displayName',
    ]);
  });

  it('constrains the bot ID rather than accepting any string', () => {
    expect(botIdSchema.safeParse('bot_seat_2').success).toBe(true);
    expect(botIdSchema.safeParse('Bot Seat 2').success).toBe(false);
    expect(botIdSchema.safeParse('').success).toBe(false);
  });
});

describe('the seat configuration', () => {
  it('parses a complete configuration', () => {
    expect(botSeatConfigSchema.safeParse(CONFIG).success).toBe(true);
  });

  it('is a strict object', () => {
    expect(botSeatConfigSchema.safeParse({ ...CONFIG, seatId: 'seat_2' }).success).toBe(false);
    expect(botSeatConfigSchema.safeParse({ ...CONFIG, connectionId: 'c1' }).success).toBe(false);
  });

  it('requires every axis to be configured', () => {
    for (const key of ['controller', 'difficulty', 'style', 'deck', 'pacing'] as const) {
      const partial: Record<string, unknown> = { ...CONFIG };
      delete partial[key];
      expect(botSeatConfigSchema.safeParse(partial).success).toBe(false);
    }
  });

  it('starts at Normal', () => {
    expect(DEFAULT_BOT_DIFFICULTY).toBe('normal');
  });

  it('round-trips through JSON unchanged', () => {
    const read = readBotSeatConfig(JSON.parse(JSON.stringify(CONFIG)));
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value).toEqual(CONFIG);
  });

  it('reads a record that declares an older difficulty registry', () => {
    // Older is readable; only newer is refused. A registry that gains an ID does
    // not invalidate a configuration written before it existed.
    const read = readBotSeatConfig({ ...CONFIG, difficultyRegistryVersion: 1 });
    expect(read.ok).toBe(true);
  });
});

describe('refusing a record from a newer build', () => {
  it('refuses a future configuration schema by name', () => {
    const read = readBotSeatConfig({
      ...CONFIG,
      schemaVersion: BOT_CONFIG_SCHEMA_VERSION + 1,
      somethingNewer: true,
    });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      // The version check runs before the parse, so the record is told it is
      // from a newer build rather than handed complaints about fields this
      // build has simply not learned about yet.
      expect(read.error).toHaveLength(1);
      expect(read.error[0]?.code).toBe('bot_config/unsupported_version');
      expect(read.error[0]?.path).toBe('schemaVersion');
      expect(read.error[0]?.context).toMatchObject({ field: 'botConfig' });
    }
  });

  it('refuses a future difficulty registry by name', () => {
    const read = readBotSeatConfig({
      ...CONFIG,
      difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION + 1,
    });
    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.error[0]?.code).toBe('bot_config/unsupported_version');
      expect(read.error[0]?.path).toBe('difficultyRegistryVersion');
    }
  });

  it('reports both refusals at once', () => {
    const read = readBotSeatConfig({
      ...CONFIG,
      schemaVersion: BOT_CONFIG_SCHEMA_VERSION + 1,
      difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION + 1,
    });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error).toHaveLength(2);
  });

  it('refuses a record with no version at all', () => {
    const withoutVersion: Record<string, unknown> = { ...CONFIG };
    delete withoutVersion.schemaVersion;
    const read = readBotSeatConfig(withoutVersion);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error[0]?.code).toBe('bot_config/missing_schema_version');
  });

  it('refuses something that is not an object', () => {
    for (const raw of [null, 'a bot', 42, [CONFIG]]) {
      const read = readBotSeatConfig(raw);
      expect(read.ok).toBe(false);
      if (!read.ok) expect(read.error[0]?.code).toBe('bot_config/malformed');
    }
  });

  it("reports a shape problem with this package's own code", () => {
    const read = readBotSeatConfig({ ...CONFIG, difficulty: 'nightmare' });
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.error[0]?.code).toBe('bot_config/schema');
  });
});

describe('the public projection of a bot seat', () => {
  const published = publicBotSeatOf(CONFIG);

  it('validates against the public schema', () => {
    expect(botSeatPublicSchema.safeParse(published).success).toBe(true);
    expect(published.controller).toBe('bot');
  });

  it('publishes how the bot behaves, because a player can time it anyway', () => {
    expect(published.difficulty).toBe('normal');
    expect(published.style).toBe('value');
    expect(published.pacing).toEqual(CONFIG.pacing);
    expect(published.displayName).toBe('Opponent 2');
  });

  it('publishes the Commander and nothing else about the deck', () => {
    expect(published.deck).toEqual({
      mode: 'exact_saved_deck',
      commanderId: 'commander_grave',
    });
  });

  it('leaks no card list, no deck name, no hash and no saved-deck ID', () => {
    const text = JSON.stringify(published);
    for (const secret of [
      'saved_7',
      'Sacrifice, rebuilt',
      '0f1e2d3c4b5a6978',
      'card_one',
      'card_two',
      'card_three',
    ]) {
      expect(text).not.toContain(secret);
    }
  });

  it('refuses to validate the private configuration as a public view', () => {
    // Handing the configuration over whole is the mistake the projection exists
    // to make impossible, and the strict public schema is what catches it.
    expect(botSeatPublicSchema.safeParse(CONFIG).success).toBe(false);
  });

  it('is strict, so nothing can be appended to it in transit', () => {
    expect(botSeatPublicSchema.safeParse({ ...published, deckList: ['card_one'] }).success).toBe(
      false,
    );
  });
});
