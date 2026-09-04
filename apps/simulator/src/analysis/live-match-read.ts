import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { parseLiveMatchEnvelope, type LiveMatchEnvelope } from '@tcg/match-telemetry';

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
 * Synchronous, matching this package's own `reporting/sinks.ts` idiom
 * (`readJsonl`) rather than `apps/admin-server/src/catalog/files.ts`'s async
 * one — a different package's convention, not this one's.
 *
 * Tolerates a damaged tail the same way `readJsonl` does: a match directory
 * with no `envelope.json`, unparseable JSON, an unreadable schema version or
 * bytes this build's schema refuses is skipped and reported rather than
 * aborting the whole read — a run that failed mid-write must not make every
 * other match unreadable.
 */

export interface SkippedLiveMatch {
  readonly matchId: string;
  readonly reason: string;
}

export interface ReadLiveMatchEnvelopesResult {
  readonly matches: readonly LiveMatchEnvelope[];
  readonly skipped: readonly SkippedLiveMatch[];
}

/** Reads every readable `LiveMatchEnvelope` under `rootDirectory`. */
export function readLiveMatchEnvelopes(rootDirectory: string): ReadLiveMatchEnvelopesResult {
  if (!existsSync(rootDirectory)) return { matches: [], skipped: [] };

  const matches: LiveMatchEnvelope[] = [];
  const skipped: SkippedLiveMatch[] = [];

  for (const matchId of readdirSync(rootDirectory)) {
    const directory = join(rootDirectory, matchId);
    if (!statSync(directory).isDirectory()) continue;

    const path = join(directory, 'envelope.json');
    if (!existsSync(path)) {
      skipped.push({ matchId, reason: 'no envelope.json in this match directory' });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      skipped.push({ matchId, reason: 'unparseable JSON (likely a truncated write)' });
      continue;
    }

    try {
      matches.push(parseLiveMatchEnvelope(parsed));
    } catch (cause) {
      skipped.push({
        matchId,
        reason: cause instanceof Error ? cause.message : 'invalid live-match envelope',
      });
    }
  }

  return { matches, skipped };
}
