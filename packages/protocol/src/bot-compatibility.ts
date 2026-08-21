import { isFutureVersion, refuseFutureVersion, type BotConfigVersionField } from '@tcg/bot-config';
import type { Issue } from '@tcg/shared';
import { botLobbyError, type ProtocolError } from './messages.js';

/**
 * The decode boundary's answer to "this came from a newer build" (M09.18).
 *
 * Three messages carry a versioned bot artifact: `add_bot` and `update_bot`
 * carry a `botSetup` — whose `schemaVersion` and `difficultyRegistryVersion` are
 * bounded by this build's constants — and `set_bot_pacing` carries a budget
 * record whose `pacingVersion` is a literal. Every one of those bounds is
 * enforced by Zod, which means a genuinely newer record has always been refused;
 * what it has *not* had is a reason. `clientMessageSchema` fails, the codec says
 * `protocol/malformed_message`, and a host running last month's client is told
 * their message was gibberish rather than that their build is old.
 *
 * M09.3 and M09.11 each recorded that as a finding rather than fixing it, and
 * named this pass as the owner. This is the fix: before the codec falls back to
 * its generic wording, the raw value is inspected for a version field that names
 * a build newer than this one, and if it holds one the refusal is the same
 * readable `refuseFutureVersion` sentence `readBotSeatConfig` and
 * `readBotPacingBudgets` already produce, delivered under the same
 * `protocol/bot_config_invalid` code the server uses when either of those
 * readers refuses.
 *
 * **The line is drawn narrowly, and that is the point.** `isFutureVersion` is
 * true only of an integer at or above 1 that exceeds what this build reads.
 * A missing version, a string, a fraction, a zero and a negative are all
 * ordinary malformed values and keep `protocol/malformed_message`; so does every
 * other Zod failure in the message, including an unknown member, a bad seat ID
 * or an out-of-range budget. Nothing here widens a refusal — it only replaces
 * the wording on a refusal that already happened, for the one cause that has a
 * better sentence available.
 */

/** One versioned field on a raw, unvalidated message, and where it lives. */
interface VersionedField {
  readonly field: BotConfigVersionField;
  readonly path: string;
  readonly found: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/**
 * Which version fields a raw client message carries, by type.
 *
 * Total over the three message types that carry one, and silent about every
 * other message: a `submit_action` has no bot artifact in it, and looking for
 * one would be how an unrelated failure eventually acquires a bot-shaped
 * explanation.
 */
function versionedFieldsOf(message: Record<string, unknown>): readonly VersionedField[] {
  switch (message.type) {
    case 'add_bot':
    case 'update_bot': {
      const setup = asRecord(message.setup);
      if (!setup) return [];
      return [
        { field: 'botConfig', path: 'setup.schemaVersion', found: setup.schemaVersion },
        {
          field: 'difficultyRegistry',
          path: 'setup.difficultyRegistryVersion',
          found: setup.difficultyRegistryVersion,
        },
      ];
    }
    case 'set_bot_pacing': {
      const budgets = asRecord(message.budgets);
      if (!budgets) return [];
      return [{ field: 'pacing', path: 'budgets.pacingVersion', found: budgets.pacingVersion }];
    }
    default:
      return [];
  }
}

/**
 * The refusal a raw client message earns for naming a newer build, or `null`.
 *
 * `null` for every message that carries no versioned bot artifact, for one whose
 * versions this build can read, and for one whose version field is merely
 * malformed — which is what keeps the caller's own malformed-message wording in
 * place for everything this function is not about.
 */
export function botConfigVersionRefusal(value: unknown): ProtocolError | null {
  const message = asRecord(value);
  if (!message) return null;

  const refusals: Issue[] = [];
  for (const { field, path, found } of versionedFieldsOf(message)) {
    if (!isFutureVersion(field, found)) continue;
    const refusal = refuseFutureVersion(field, found, path);
    if (refusal) refusals.push(refusal);
  }
  if (refusals.length === 0) return null;

  return botLobbyError(
    'config_invalid',
    refusals.map((issue) => issue.message),
  );
}
