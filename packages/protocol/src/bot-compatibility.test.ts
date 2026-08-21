import { describe, expect, it } from 'vitest';
import {
  BOT_CONFIG_SCHEMA_VERSION,
  DEFAULT_BOT_PACING_BUDGETS,
  DIFFICULTY_REGISTRY_VERSION,
  IMMEDIATE_BOT_PACING,
  PACING_CONFIG_VERSION,
  isFutureVersion,
} from '@tcg/bot-config';
import { botConfigVersionRefusal } from './bot-compatibility.js';
import { decodeClientMessage, encode } from './codec.js';
import { botSetupSchema, type BotSetup } from './messages.js';

/**
 * The decode-boundary compatibility pass (M09.18).
 *
 * M09.3 and M09.11 each recorded the same finding and deferred it here: a bot
 * artifact written by a **newer build** was refused as a malformed message,
 * because the version bound lives in a Zod schema the codec runs before anybody
 * can read the record and say why. The fix has to be narrow in both directions,
 * so this file tests both:
 *
 * - a genuine future version, on each of the three messages that can carry one,
 *   produces the repository's readable newer-build refusal under
 *   `protocol/bot_config_invalid`; and
 * - everything else that fails — a missing version, a string, a fraction, a
 *   zero, a negative, an out-of-range budget, an unknown member, an unrelated
 *   message — still produces `protocol/malformed_message`.
 *
 * The second half is the load-bearing one. A compatibility refusal that fires on
 * ordinary malformed input would tell a host to update an application that is
 * already current, which is worse than the generic wording it replaced.
 */

/* --------------------------------------------------------------- fixtures */

const BASE_SETUP: BotSetup = {
  schemaVersion: BOT_CONFIG_SCHEMA_VERSION,
  difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION,
  displayName: null,
  difficulty: 'normal',
  style: 'automatic',
  deck: { mode: 'exact_precon', preconId: 'wave_1_aggro' },
  pacing: IMMEDIATE_BOT_PACING,
};

/** A raw setup, so a test can put a value on it the type would not allow. */
function rawSetup(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { ...BASE_SETUP, ...over };
}

function decodeRaw(message: unknown): ReturnType<typeof decodeClientMessage> {
  return decodeClientMessage(JSON.stringify(message));
}

/** Every message shape that carries a versioned bot artifact, by version field. */
const CARRIERS = [
  {
    type: 'add_bot',
    field: 'botConfig',
    label: 'bot configuration schema',
    current: BOT_CONFIG_SCHEMA_VERSION,
    message: (version: unknown) => ({
      type: 'add_bot',
      setup: rawSetup({ schemaVersion: version }),
    }),
  },
  {
    type: 'add_bot',
    field: 'difficultyRegistry',
    label: 'difficulty registry',
    current: DIFFICULTY_REGISTRY_VERSION,
    message: (version: unknown) => ({
      type: 'add_bot',
      setup: rawSetup({ difficultyRegistryVersion: version }),
    }),
  },
  {
    type: 'update_bot',
    field: 'botConfig',
    label: 'bot configuration schema',
    current: BOT_CONFIG_SCHEMA_VERSION,
    message: (version: unknown) => ({
      type: 'update_bot',
      seatId: 'seat_2',
      setup: rawSetup({ schemaVersion: version }),
    }),
  },
  {
    type: 'update_bot',
    field: 'difficultyRegistry',
    label: 'difficulty registry',
    current: DIFFICULTY_REGISTRY_VERSION,
    message: (version: unknown) => ({
      type: 'update_bot',
      seatId: 'seat_2',
      setup: rawSetup({ difficultyRegistryVersion: version }),
    }),
  },
  {
    type: 'set_bot_pacing',
    field: 'pacing',
    label: 'bot pacing configuration',
    current: PACING_CONFIG_VERSION,
    message: (version: unknown) => ({
      type: 'set_bot_pacing',
      budgets: { ...DEFAULT_BOT_PACING_BUDGETS, pacingVersion: version },
    }),
  },
] as const;

/* ------------------------------------------------------- the supported path */

describe('a bot artifact this build can read', () => {
  it('decodes on all three messages, at the current versions', () => {
    for (const message of [
      { type: 'add_bot', setup: BASE_SETUP },
      { type: 'update_bot', seatId: 'seat_2', setup: BASE_SETUP },
      { type: 'set_bot_pacing', budgets: DEFAULT_BOT_PACING_BUDGETS },
    ]) {
      const decoded = decodeClientMessage(encode(message as never));
      expect(decoded.ok, `${message.type} failed to decode`).toBe(true);
      if (decoded.ok) expect(decoded.value).toEqual(message);
    }
  });

  it('still decodes a record written by an older build', () => {
    // The refusal is one-directional on purpose: this build reads *up to* its
    // own version, so v1 configuration keeps working. Only `botConfig` and
    // `difficultyRegistry` have an older version to test — `pacingVersion` is a
    // literal and has only ever had one value.
    for (const older of [
      { type: 'add_bot', setup: rawSetup({ schemaVersion: 1 }) },
      { type: 'add_bot', setup: rawSetup({ difficultyRegistryVersion: 1 }) },
    ]) {
      expect(decodeRaw(older).ok, JSON.stringify(older)).toBe(true);
    }
  });

  it('is not refused merely for being at the boundary', () => {
    // The exact current version is supported; one past it is not. Asserted
    // against the constants so a bump moves the boundary rather than this test.
    for (const carrier of CARRIERS) {
      expect(isFutureVersion(carrier.field, carrier.current)).toBe(false);
      expect(isFutureVersion(carrier.field, carrier.current + 1)).toBe(true);
      expect(decodeRaw(carrier.message(carrier.current)).ok).toBe(true);
    }
  });
});

/* --------------------------------------------------------- the refusal path */

describe('a bot artifact written by a newer build', () => {
  it.each(CARRIERS.map((carrier) => [`${carrier.type} / ${carrier.field}`, carrier] as const))(
    'is refused readably on %s',
    (_name, carrier) => {
      const decoded = decodeRaw(carrier.message(carrier.current + 1));
      expect(decoded.ok).toBe(false);
      if (decoded.ok) return;

      // The established bot refusal, not the generic protocol one.
      expect(decoded.error.code).toBe('protocol/bot_config_invalid');
      expect(decoded.error.message).toBe('That bot configuration cannot be read.');

      // And the established `refuseFutureVersion` wording, naming which artifact
      // is too new, what it declared, and what this build reads.
      const detail = (decoded.error.details ?? []).join(' ');
      expect(detail).toContain('written by a newer build');
      expect(detail).toContain(`${carrier.label} version ${carrier.current + 1}`);
      expect(detail).toContain(`this build reads up to ${carrier.current}`);
      expect(detail).toContain('Update the application.');
    },
  );

  it('is refused however far in the future it is', () => {
    for (const carrier of CARRIERS) {
      for (const ahead of [1, 2, 99]) {
        const decoded = decodeRaw(carrier.message(carrier.current + ahead));
        expect(decoded.ok).toBe(false);
        if (!decoded.ok) expect(decoded.error.code).toBe('protocol/bot_config_invalid');
      }
    }
  });

  it('names the newer build even when the message is also otherwise unreadable', () => {
    // The version check has priority for the reason `readBotSeatConfig` runs its
    // own before parsing: a record from a newer build should be told it is from
    // a newer build, not handed complaints about fields this build has simply
    // not learned about yet.
    const decoded = decodeRaw({
      type: 'update_bot',
      seatId: 'not-a-seat-id',
      setup: rawSetup({ schemaVersion: BOT_CONFIG_SCHEMA_VERSION + 1, aFieldFromTheFuture: true }),
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error.code).toBe('protocol/bot_config_invalid');
      expect((decoded.error.details ?? []).join(' ')).toContain('written by a newer build');
    }
  });

  it('reports both version fields when both are from the future', () => {
    const decoded = decodeRaw({
      type: 'add_bot',
      setup: rawSetup({
        schemaVersion: BOT_CONFIG_SCHEMA_VERSION + 1,
        difficultyRegistryVersion: DIFFICULTY_REGISTRY_VERSION + 1,
      }),
    });
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error.details).toHaveLength(2);
      expect((decoded.error.details ?? []).join(' ')).toContain('bot configuration schema version');
      expect((decoded.error.details ?? []).join(' ')).toContain('difficulty registry version');
    }
  });
});

/* ------------------------------------------------- the merely-malformed path */

describe('an ordinary malformed value', () => {
  /**
   * Every non-integer, sub-1 or absent version. None of these names a build at
   * all, so none of them may claim the host's application is out of date.
   */
  const NOT_A_VERSION = [0, -1, 1.5, '2', null, true, [], {}] as const;

  it.each(CARRIERS.map((carrier) => [`${carrier.type} / ${carrier.field}`, carrier] as const))(
    'stays a malformed message on %s',
    (_name, carrier) => {
      for (const value of NOT_A_VERSION) {
        expect(isFutureVersion(carrier.field, value)).toBe(false);
        const decoded = decodeRaw(carrier.message(value));
        expect(decoded.ok, JSON.stringify(value)).toBe(false);
        if (!decoded.ok) {
          expect(decoded.error.code, JSON.stringify(value)).toBe('protocol/malformed_message');
        }
      }
    },
  );

  it('stays a malformed message when the version field is absent', () => {
    for (const message of [
      { type: 'add_bot', setup: rawSetup({ schemaVersion: undefined }) },
      { type: 'set_bot_pacing', budgets: { ordinarySeconds: 30, reactionSeconds: 5 } },
    ]) {
      const decoded = decodeRaw(message);
      expect(decoded.ok).toBe(false);
      if (!decoded.ok) expect(decoded.error.code).toBe('protocol/malformed_message');
    }
  });

  it('stays a malformed message for every failure that is not a version', () => {
    for (const message of [
      // A budget outside the range — the exact case M09.11 recorded, and it
      // deliberately does *not* become a compatibility refusal.
      { type: 'set_bot_pacing', budgets: { ...DEFAULT_BOT_PACING_BUDGETS, ordinarySeconds: 0 } },
      { type: 'set_bot_pacing', budgets: { ...DEFAULT_BOT_PACING_BUDGETS, reactionSeconds: 2.5 } },
      { type: 'set_bot_pacing', budgets: { ...DEFAULT_BOT_PACING_BUDGETS, ordinaryMinutes: 1 } },
      { type: 'set_bot_pacing', budgets: 'not an object' },
      // A setup this build understands the shape of and refuses the content of.
      { type: 'add_bot', setup: rawSetup({ difficulty: 'nightmare' }) },
      { type: 'add_bot', setup: rawSetup({ pacing: { percent: 101, reactionPercent: null } }) },
      { type: 'add_bot', setup: rawSetup({ aFieldFromTheFuture: true }) },
      { type: 'add_bot', setup: null },
      { type: 'update_bot', seatId: 'not-a-seat-id', setup: BASE_SETUP },
      { type: 'update_bot', setup: BASE_SETUP },
      // And messages that have nothing to do with a bot at all.
      { type: 'submit_action', actionId: 'a' },
      { type: 'reroll_bot', seatId: 'seat_2', seed: 'chosen' },
      { type: 'no_such_message' },
    ]) {
      const decoded = decodeRaw(message);
      expect(decoded.ok, JSON.stringify(message)).toBe(false);
      if (!decoded.ok) {
        expect(decoded.error.code, JSON.stringify(message)).toBe('protocol/malformed_message');
      }
    }
  });

  it('leaves invalid JSON exactly where it was', () => {
    const decoded = decodeClientMessage('{not json');
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error.code).toBe('protocol/malformed_message');
      expect(decoded.error.message).toBe('Message is not valid JSON.');
    }
  });
});

/* ------------------------------------------------------------- the helper */

describe('botConfigVersionRefusal', () => {
  it('is silent about anything that is not one of the three carriers', () => {
    for (const value of [
      null,
      undefined,
      42,
      'add_bot',
      [],
      { type: 'submit_action' },
      { type: 'reroll_bot', seatId: 'seat_2' },
      { type: 'remove_bot', seatId: 'seat_2' },
      // A version field in the wrong place is not a version field.
      { type: 'submit_deck', schemaVersion: 99 },
      { type: 'add_bot', setup: 'not an object' },
    ]) {
      expect(botConfigVersionRefusal(value), JSON.stringify(value ?? null)).toBeNull();
    }
  });

  it('never fires on a message this build accepts', () => {
    // The guarantee that makes wiring it into the codec safe: it is consulted
    // only after a parse failure, and it has nothing to say about a message that
    // parses anyway.
    for (const message of [
      { type: 'add_bot', setup: BASE_SETUP },
      { type: 'update_bot', seatId: 'seat_2', setup: BASE_SETUP },
      { type: 'set_bot_pacing', budgets: DEFAULT_BOT_PACING_BUDGETS },
    ]) {
      expect(
        botSetupSchema.safeParse((message as { setup?: unknown }).setup ?? BASE_SETUP).success,
      ).toBe(true);
      expect(botConfigVersionRefusal(message)).toBeNull();
    }
  });
});
