import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseLiveMatchRawEventArtifact,
  parseLiveMatchReplayArtifact,
  type LiveMatchRawEventArtifact,
  type LiveMatchReplayArtifact,
} from '@tcg/match-telemetry';

/**
 * M08.26D — targeted single-match reads for `LiveMatchFileStore`'s optional
 * `raw-event.json`/`replay.json` (`apps/multiplayer-server/src/live-match-store.ts`),
 * one match at a time rather than `live-match-read.ts`'s whole-directory scan:
 * a match view needs at most one match's artifacts, so scanning every match
 * directory under a possibly large result root to answer it would be wasted
 * work the existing readers were never asked to avoid.
 *
 * **Path safety (ADR 0023 §5): never trust a client-supplied `matchId` into a
 * filesystem path unchecked.** The caller in `apps/admin-server` is required
 * to resolve `matchId` against `readLiveMatchEnvelopes`'s own scan first —
 * whose `matchId` values are always real, pre-existing `readdirSync` entries —
 * and only pass through a value already proven equal to a real directory
 * name. `isSafeLiveMatchId` below is the second, defensive layer inside this
 * module itself: it rejects any path separator or `..` segment outright, so
 * even a caller that skipped the resolve step cannot walk this reader outside
 * `rootDirectory`.
 *
 * **A present-but-corrupted artifact reads as absent.** Mirrors
 * `live-match-read.ts`/`live-match-surrender-read.ts`'s own tolerant-read
 * idiom for a damaged tail: an unparseable or schema-invalid `raw-event.json`
 * or `replay.json` is treated identically to a file that was never written,
 * rather than failing the whole match view over one unreadable artifact tier.
 */

const LIVE_MATCH_ID_PATTERN = /^[^/\\]+$/;

/** Whether `matchId` is safe to join onto a filesystem path: no separator, no `..` segment. */
export function isSafeLiveMatchId(matchId: string): boolean {
  return matchId.length > 0 && matchId !== '..' && LIVE_MATCH_ID_PATTERN.test(matchId);
}

function readArtifact<T>(
  rootDirectory: string,
  matchId: string,
  fileName: string,
  parse: (input: unknown) => T,
): T | null {
  if (!isSafeLiveMatchId(matchId)) return null;

  const path = join(rootDirectory, matchId, fileName);
  if (!existsSync(path)) return null;

  try {
    return parse(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return null;
  }
}

/** Reads one match's `raw-event.json`, or `null` when absent, corrupted, or `matchId` is unsafe. */
export function readLiveMatchRawEvent(
  rootDirectory: string,
  matchId: string,
): LiveMatchRawEventArtifact | null {
  return readArtifact(rootDirectory, matchId, 'raw-event.json', parseLiveMatchRawEventArtifact);
}

/** Reads one match's `replay.json`, or `null` when absent, corrupted, or `matchId` is unsafe. */
export function readLiveMatchReplay(
  rootDirectory: string,
  matchId: string,
): LiveMatchReplayArtifact | null {
  return readArtifact(rootDirectory, matchId, 'replay.json', parseLiveMatchReplayArtifact);
}
