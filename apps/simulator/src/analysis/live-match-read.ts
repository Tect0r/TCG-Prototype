import type { LiveMatchEnvelope } from '@tcg/match-telemetry';

import { openLiveMatchSnapshot, type SkippedLiveMatch } from './live-match-snapshot.js';

/**
 * M08.25B — the simulator-side reader for `LiveMatchFileStore`'s canonical
 * layout (`apps/multiplayer-server/src/live-match-store.ts`):
 * `<rootDirectory>/<matchId>/envelope.json`, one subdirectory per match.
 *
 * Lives in `@tcg/simulator` rather than `apps/admin-server`, per ADR 0023 §2:
 * the admin server depends on `@tcg/simulator` only, and `@tcg/simulator`
 * already depends on `@tcg/match-telemetry` (`live-match-aggregate.ts`,
 * `live-card-evidence.ts`) — `apps/admin-server` does not and must not.
 *
 * M08.R10 — the scan itself, and the cache it now reads through, live in
 * `./live-match-snapshot.ts`'s `openLiveMatchSnapshot`; this function is a
 * thin, unchanged-signature projection of one cached snapshot so every
 * existing caller keeps working exactly as before.
 */

export { type SkippedLiveMatch };

export interface ReadLiveMatchEnvelopesResult {
  readonly matches: readonly LiveMatchEnvelope[];
  readonly skipped: readonly SkippedLiveMatch[];
}

/** Reads every readable `LiveMatchEnvelope` under `rootDirectory`. */
export function readLiveMatchEnvelopes(rootDirectory: string): ReadLiveMatchEnvelopesResult {
  const snapshot = openLiveMatchSnapshot(rootDirectory);
  return { matches: snapshot.matches, skipped: snapshot.skippedMatches };
}
