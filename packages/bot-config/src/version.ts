import { error, type Issue } from '@tcg/shared';
import type { z } from 'zod';

/**
 * The version constants a bot seat's configuration is written against, and the
 * one rule every one of them obeys: a record from a *newer* build is refused
 * with a readable message rather than migrated on a guess.
 *
 * Why these are separate from the play-contract versions
 * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §7): a
 * difficulty can improve, a pacing dial can move and a bot's configuration shape
 * can widen without a card, a rule or a message shape changing. Folding any of
 * them into `PROTOCOL_VERSION`, `MATCH_SCHEMA_VERSION` or `RULES_VERSION` would
 * refuse compatible builds and, worse, would teach that a bot waiting longer is
 * a rules change. `RULES_VERSION` does not move because a bot waited.
 *
 * Each constant below is bumped by the tranche that changes the shape or the
 * classification it names, and the reason is recorded beside it.
 */

/**
 * The shape of one bot seat's configuration — controller identity, difficulty,
 * style, deck source and pacing.
 *
 * - 1 — M09.1, the first contract. Nothing has been on a wire yet.
 */
export const BOT_CONFIG_SCHEMA_VERSION = 1;

/**
 * Which difficulty IDs exist and what each one claims about itself.
 *
 * Bumped when the *registry* changes — an ID appearing, disappearing, or
 * changing status — so a recorded match that cites `hard` can be read against
 * the registry that produced it. A difficulty's own decision procedure carries a
 * separate `behaviorVersion`, because Hard improving is not the vocabulary
 * changing.
 *
 * - 1 — M09.1, the first registry. `normal` is available; `easy` and `hard` are
 *   declared and have no behaviour behind them yet.
 */
export const DIFFICULTY_REGISTRY_VERSION = 1;

/**
 * The pacing budget shape and the percentage-to-delay calculation.
 *
 * Bumped when the *calculation* or the budget shape changes. Changing a budget's
 * value — the 30 seconds, the 5 seconds — is a configuration change and does not
 * move this: that is the whole point of the numbers being configuration.
 *
 * - 1 — M09.1, the first calculation.
 */
export const PACING_CONFIG_VERSION = 1;

/** Every version a bot configuration record is written against, in one object. */
export const CURRENT_BOT_CONFIG_VERSIONS = Object.freeze({
  botConfig: BOT_CONFIG_SCHEMA_VERSION,
  difficultyRegistry: DIFFICULTY_REGISTRY_VERSION,
  pacing: PACING_CONFIG_VERSION,
});

/** Names a version field carries in an issue, so a caller can say which failed. */
export type BotConfigVersionField = 'botConfig' | 'difficultyRegistry' | 'pacing';

const VERSION_LABELS: Readonly<Record<BotConfigVersionField, string>> = Object.freeze({
  botConfig: 'bot configuration schema',
  difficultyRegistry: 'difficulty registry',
  pacing: 'bot pacing configuration',
});

/** Stable, machine-readable, and total over the fields. Never derived. */
const MISSING_VERSION_CODES: Readonly<Record<BotConfigVersionField, string>> = Object.freeze({
  botConfig: 'bot_config/missing_schema_version',
  difficultyRegistry: 'bot_config/missing_difficulty_registry_version',
  pacing: 'bot_config/missing_pacing_version',
});

/**
 * The single refusal, shared by every version field.
 *
 * Returns `null` when the record is readable. A future version is an `Issue`
 * rather than a thrown error because every other external boundary in this
 * repository reports that way, and because a lobby wants to *show* the reason
 * beside the seat rather than lose the connection over it.
 */
export function refuseFutureVersion(
  field: BotConfigVersionField,
  found: unknown,
  path: string,
): Issue | null {
  const supported = CURRENT_BOT_CONFIG_VERSIONS[field];
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
    return error(
      MISSING_VERSION_CODES[field],
      `This record does not declare a readable ${VERSION_LABELS[field]} version, so it cannot be read.`,
      { path },
    );
  }
  if (found > supported) {
    return error(
      'bot_config/unsupported_version',
      `This bot configuration was written by a newer build (${VERSION_LABELS[field]} version ${found}; this build reads up to ${supported}). Update the application.`,
      { path, context: { field, found, supported } },
    );
  }
  return null;
}

/** Zod problems, reported with this package's own code rather than card data's. */
export function botConfigIssues(zodError: z.ZodError): Issue[] {
  return zodError.issues.map((problem) => {
    const path = problem.path.join('.');
    return error('bot_config/schema', problem.message, {
      ...(path ? { path } : {}),
      context: { zodCode: problem.code },
    });
  });
}
