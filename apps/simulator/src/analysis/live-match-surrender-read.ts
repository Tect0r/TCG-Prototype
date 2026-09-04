import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseLiveMatchPreActionCapture,
  type LiveMatchPreActionCapture,
} from '@tcg/match-telemetry';

/**
 * M08.25D — the simulator-side reader for `LiveMatchFileStore`'s optional
 * `pre-action-capture.json`, mirroring `live-match-read.ts`'s tolerant-read
 * idiom exactly (same reasons: lives in `@tcg/simulator` per ADR 0023 §2,
 * synchronous per this package's own convention).
 *
 * The one difference from `readLiveMatchEnvelopes`: a missing capture file is
 * the expected case, not damage. `apps/multiplayer-server/src/live-match-store.ts`
 * writes `pre-action-capture.json` only when a match ended in a voluntary
 * surrender (`LIVE_MATCH_VOLUNTARY_TERMINATION_ORIGINS`) — most matches never
 * have one, so a match directory with no capture is skipped silently rather
 * than reported. Only a *present but unreadable* capture is reported in
 * `skipped`, the same way an unparseable or schema-invalid envelope is.
 */

export interface SkippedLiveMatchCapture {
  readonly matchId: string;
  readonly reason: string;
}

export interface ReadLiveMatchPreActionCapturesResult {
  readonly captures: readonly LiveMatchPreActionCapture[];
  readonly skipped: readonly SkippedLiveMatchCapture[];
}

/** Reads every readable `LiveMatchPreActionCapture` under `rootDirectory`, skipping matches that never surrendered. */
export function readLiveMatchPreActionCaptures(
  rootDirectory: string,
): ReadLiveMatchPreActionCapturesResult {
  if (!existsSync(rootDirectory)) return { captures: [], skipped: [] };

  const captures: LiveMatchPreActionCapture[] = [];
  const skipped: SkippedLiveMatchCapture[] = [];

  for (const matchId of readdirSync(rootDirectory)) {
    const directory = join(rootDirectory, matchId);
    if (!statSync(directory).isDirectory()) continue;

    const path = join(directory, 'pre-action-capture.json');
    if (!existsSync(path)) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8'));
    } catch {
      skipped.push({ matchId, reason: 'unparseable JSON (likely a truncated write)' });
      continue;
    }

    try {
      captures.push(parseLiveMatchPreActionCapture(parsed));
    } catch (cause) {
      skipped.push({
        matchId,
        reason: cause instanceof Error ? cause.message : 'invalid pre-action capture',
      });
    }
  }

  return { captures, skipped };
}
