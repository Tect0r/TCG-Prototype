import {
  bundledFormat,
  CARD_SCHEMA_VERSION,
  formatDatabase,
  type CardDatabase,
} from '@tcg/card-data';
import type { LiveMatchEnvelope } from '@tcg/match-telemetry';

/**
 * Resolves the one `CardDatabase` a batch of live matches can honestly be
 * clustered and evaluated against: today's bundled database, keyed by
 * today's `CARD_SCHEMA_VERSION` — never a historical one.
 *
 * `provenance.contentVersion` on a `LiveMatchEnvelope` is a recorded fact
 * about the build that played the match, not a version this build can
 * reconstruct an arbitrary earlier card pool from. CLAUDE.md's format-scoped
 * database invariant ("Any playable pool must be obtained through a
 * format-scoped database, never the entire bundled card universe") leaves
 * exactly one honest resolution available live: `formatDatabase(formatId)`
 * against the format the matches actually declare, keyed by the constant
 * that names *this build's* content, not theirs.
 *
 * Returns an empty map — never a guess — whenever the input spans more than
 * one `formatId`, or names a format this build does not have bundled, so a
 * caller never resolves cards against the wrong pool.
 * `aggregateLiveMatches`/`aggregateLiveCardEvidence` already treat a missing
 * map entry as `clustersUnavailableReason`/`unavailableReason` rather than a
 * crash, so this degrades honestly instead of fabricating a merged database.
 * Matches from any other content version legitimately degrade the same way.
 */
export function currentLiveMatchCardDatabases(
  matches: readonly LiveMatchEnvelope[],
): ReadonlyMap<number, CardDatabase> {
  const formatIds = new Set(matches.map((match) => match.formatId));
  if (formatIds.size !== 1) return new Map();

  const [formatId] = formatIds;
  if (formatId === undefined || bundledFormat(formatId) === undefined) return new Map();

  return new Map([[CARD_SCHEMA_VERSION, formatDatabase(formatId)]]);
}
