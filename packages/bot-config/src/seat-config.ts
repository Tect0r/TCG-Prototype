import { z } from 'zod';
import { err, error, ok, type Issue, type Result } from '@tcg/shared';
import { botDifficultySchema, type BotDifficulty } from './difficulty.js';
import { botStyleSchema } from './style.js';
import {
  botDeckSourceSchema,
  botDeckSourcePublicSchema,
  publicDeckSourceOf,
} from './deck-source.js';
import { botPacingSchema } from './pacing.js';
import {
  botConfigIssues,
  BOT_CONFIG_SCHEMA_VERSION,
  DIFFICULTY_REGISTRY_VERSION,
  refuseFutureVersion,
} from './version.js';

/**
 * A bot seat's complete configuration (M09.1), and the projection of it that
 * other players may see.
 *
 * Two things are decided here and nowhere else.
 *
 * **A seat has an explicit controller.** `human` or `bot`, stored rather than
 * inferred. The alternative the lobby would otherwise drift into — a `null`
 * connection ID meaning "bot" by accident — is exactly the ambiguity
 * [ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §1 refuses.
 *
 * **A bot controller has no connection identity.** It is created, configured and
 * destroyed by the authoritative server; it has no `connectionId`, is issued no
 * `reconnectToken`, and never starts a disconnect timer, because there is
 * nothing for it to disconnect from. The schema below is strict and carries none
 * of those fields, so adding one is a parse failure rather than a review note —
 * see `FIELDS_A_BOT_CONTROLLER_NEVER_HAS`.
 *
 * Nothing in this file crosses a wire. M09.2 owns the messages; this is the
 * contract those messages will carry.
 */

/** What occupies a seat. Explicit, because a bot is not a human without a socket. */
export const SEAT_CONTROLLERS = ['human', 'bot'] as const;
export const seatControllerSchema = z.enum(SEAT_CONTROLLERS);
export type SeatController = z.infer<typeof seatControllerSchema>;

/** Server-generated and stable for the life of the bot seat. */
export const botIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Bot IDs are lowercase letters, digits, underscores and dashes.');

/** Shown beside the seat. Same limits a human display name has. */
export const botDisplayNameSchema = z.string().trim().min(1).max(24);

/**
 * The identity half of a bot controller — and deliberately nothing else.
 *
 * Difficulty, style, deck and pacing are configuration and live beside this
 * rather than inside it, so that "who is in the seat" and "how it is set up"
 * stay separable: M09.16 copies one bot's configuration to another seat without
 * copying its identity, and that is only expressible if the two are apart.
 */
export const botControllerSchema = z.strictObject({
  botId: botIdSchema,
  displayName: botDisplayNameSchema,
});
export type BotController = z.infer<typeof botControllerSchema>;

/**
 * The four human-seat fields a bot controller must never acquire, named so the
 * ADR's claim is a test rather than a sentence. Every one of them describes a
 * network participant that can go away.
 */
export const FIELDS_A_BOT_CONTROLLER_NEVER_HAS = [
  'connectionId',
  'reconnectToken',
  'disconnectDeadline',
  'graceSeconds',
] as const;

/** M09.5 starts here, and every later tranche describes itself as a difference. */
export const DEFAULT_BOT_DIFFICULTY: BotDifficulty = 'normal';

/**
 * The private configuration, held by the host and the authoritative server.
 *
 * It carries two version fields rather than one: the shape it was written in,
 * and the difficulty registry it was written against. They move for different
 * reasons — a difficulty can be added without the configuration's shape
 * changing, and the shape can widen without re-judging any difficulty — so
 * folding them together would make one of the two moves lie.
 */
export const botSeatConfigSchema = z.strictObject({
  schemaVersion: z.number().int().min(1).max(BOT_CONFIG_SCHEMA_VERSION),
  difficultyRegistryVersion: z.number().int().min(1).max(DIFFICULTY_REGISTRY_VERSION),
  controller: botControllerSchema,
  difficulty: botDifficultySchema,
  style: botStyleSchema,
  deck: botDeckSourceSchema,
  pacing: botPacingSchema,
});
export type BotSeatConfig = z.infer<typeof botSeatConfigSchema>;

/**
 * What every other seat sees.
 *
 * Everything a bot's configuration says about *how it behaves* is public:
 * difficulty, style and pacing are all observable from the other side of the
 * table anyway, and hiding them would only make the software coy about
 * something a player can time with a stopwatch. What is not public is the deck
 * beyond its Commander, which is why `deck` is the projected union and not the
 * configured one.
 */
export const botSeatPublicSchema = z.strictObject({
  controller: z.literal('bot'),
  botId: botIdSchema,
  displayName: botDisplayNameSchema,
  difficulty: botDifficultySchema,
  style: botStyleSchema,
  deck: botDeckSourcePublicSchema,
  pacing: botPacingSchema,
});
export type BotSeatPublic = z.infer<typeof botSeatPublicSchema>;

/**
 * The only way from private configuration to public view.
 *
 * A function rather than a convention: nothing else in the codebase should be
 * building a `BotSeatPublic` by hand, because the one thing that must never
 * happen — a card list or a generator seed reaching an opponent — is exactly
 * what hand-building would eventually do.
 */
export function publicBotSeatOf(config: BotSeatConfig): BotSeatPublic {
  return {
    controller: 'bot',
    botId: config.controller.botId,
    displayName: config.controller.displayName,
    difficulty: config.difficulty,
    style: config.style,
    deck: publicDeckSourceOf(config.deck),
    pacing: config.pacing,
  };
}

/**
 * Reads a bot configuration from outside this build.
 *
 * A future version is refused with a readable message rather than migrated
 * speculatively — the treatment `CARD_SCHEMA_VERSION` and `DECK_SCHEMA_VERSION`
 * already get. The version checks run *before* the schema parse so that a record
 * from a newer build is told it is from a newer build, rather than being handed
 * a list of unknown-field complaints about fields this build has simply not
 * learned about yet.
 */
export function readBotSeatConfig(raw: unknown): Result<BotSeatConfig, Issue[]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err([error('bot_config/malformed', 'A bot configuration must be a JSON object.')]);
  }
  const record = raw as Record<string, unknown>;

  const versionIssues = [
    refuseFutureVersion('botConfig', record.schemaVersion, 'schemaVersion'),
    refuseFutureVersion(
      'difficultyRegistry',
      record.difficultyRegistryVersion,
      'difficultyRegistryVersion',
    ),
  ].filter((issue): issue is Issue => issue !== null);
  if (versionIssues.length > 0) return err(versionIssues);

  const parsed = botSeatConfigSchema.safeParse(raw);
  if (!parsed.success) return err(botConfigIssues(parsed.error));
  return ok(parsed.data);
}
