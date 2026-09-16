import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseLiveMatchEnvelope,
  parseLiveMatchPreActionCapture,
  type LiveMatchEnvelope,
  type LiveMatchPreActionCapture,
} from '@tcg/match-telemetry';

/**
 * M08.R10 — the one bounded, cached pass over a `LiveMatchFileStore` root that
 * every Player Meta and explorer reader now reads through.
 *
 * Before this module, `readLiveMatchEnvelopes` (`./live-match-read.ts`) and
 * `readLiveMatchPreActionCaptures` (`./live-match-surrender-read.ts`) each ran
 * their own independent `readdirSync` over the same root — and every service
 * call (`readPlayerMetaSummary`, `readPlayerMetaTable`, `CardExplorerReader`,
 * `DeckExplorerReader`, `MatchExplorerReader`, `MatchRepresentativesReader`)
 * called them fresh. A single Player Meta dashboard load fires several
 * independent HTTP requests (`handlers.ts`'s `playerMetaRunSummary`,
 * `playerMetaResultTable` once per visible table, `playerMetaCoverageView`,
 * `playerMetaDataHealthView`), so the whole live-match root was enumerated and
 * reparsed once per request rather than once per load — an N+1 that grows
 * with both live-match volume and the number of tables a page shows.
 *
 * `openLiveMatchSnapshot` does one `readdirSync` and, for each match
 * directory, at most two file reads (`envelope.json`, `pre-action-capture.json`)
 * — the exact same files the two prior readers read separately, now in one
 * pass — and caches the result by `rootDirectory`. `readLiveMatchEnvelopes`
 * and `readLiveMatchPreActionCaptures` below keep their original signatures
 * and are now thin projections of one cached snapshot, so every existing call
 * site is unchanged.
 *
 * **Invalidation is directory-change-driven, not a blind timer.** Every write
 * `LiveMatchFileStore.receive` makes for a *new* match creates that match's
 * subdirectory for the first time (`mkdirSync(matchDirectory, {recursive:
 * true})` in `apps/multiplayer-server/src/live-match-store.ts`), which changes
 * `rootDirectory`'s own mtime — so a cached snapshot is dropped the instant a
 * new match lands, never merely after some delay. `LIVE_MATCH_SNAPSHOT_TTL_MS`
 * is a bounded second line of defence for the one case directory mtime cannot
 * see — a retried delivery overwriting an *existing* match's files in place —
 * so a cache entry is never trusted for longer than the TTL regardless of what
 * the filesystem reports. Both together are what "do not introduce a
 * long-lived cache that hides new matches indefinitely" (M08.R10) means here:
 * bounded by real change, and bounded by time.
 *
 * **Bounded, not unbounded, scanning.** Nothing before this module capped how
 * many match directories a single read would enumerate and parse, or how many
 * bytes it would read doing so — an operator-hostile root (or simply a very
 * long-lived deployment) could make one request scan and parse an unbounded
 * amount of disk. `LiveMatchSnapshotLimits` caps both the record count and the
 * cumulative bytes read; a scan that hits either cap stops and reports
 * `truncated: true` rather than reading further. `maxSkippedDetails` bounds
 * the *reported* corrupt/missing-record detail list the same way — the true
 * count is still exact (`skippedMatchCount`/`skippedCaptureCount`), only the
 * per-record detail list a caller might surface to an admin UI is capped, so
 * a root with thousands of corrupt records cannot itself become an unbounded
 * response payload. No reported reason ever carries a filesystem path — every
 * reason is either a fixed sentence or a schema/parse error message, exactly
 * as the two prior readers already produced.
 */

export interface SkippedLiveMatch {
  readonly matchId: string;
  readonly reason: string;
}

export interface SkippedLiveMatchCapture {
  readonly matchId: string;
  readonly reason: string;
}

export interface LiveMatchSnapshotLimits {
  /** Match directories scanned and parsed per snapshot, at most. */
  readonly maxRecords: number;
  /** Cumulative envelope/capture bytes read per snapshot, at most. */
  readonly maxBytes: number;
  /** Corrupt/missing-record detail entries reported per list, at most — the counts stay exact regardless. */
  readonly maxSkippedDetails: number;
}

export const DEFAULT_LIVE_MATCH_SNAPSHOT_LIMITS: LiveMatchSnapshotLimits = Object.freeze({
  maxRecords: 10_000,
  maxBytes: 200 * 1024 * 1024,
  maxSkippedDetails: 200,
});

/** How long a cached snapshot may be reused without a directory-mtime change proving it is still current. */
export const LIVE_MATCH_SNAPSHOT_TTL_MS = 2_000;

export interface LiveMatchSnapshot {
  readonly matches: readonly LiveMatchEnvelope[];
  readonly skippedMatches: readonly SkippedLiveMatch[];
  readonly skippedMatchCount: number;
  readonly captures: readonly LiveMatchPreActionCapture[];
  readonly skippedCaptures: readonly SkippedLiveMatchCapture[];
  readonly skippedCaptureCount: number;
  /** Match directories actually scanned before the read stopped (by exhaustion or by a limit). */
  readonly recordsScanned: number;
  /** Whether `maxRecords` or `maxBytes` stopped this scan before the whole root was read. */
  readonly truncated: boolean;
}

const EMPTY_SNAPSHOT: LiveMatchSnapshot = Object.freeze({
  matches: [],
  skippedMatches: [],
  skippedMatchCount: 0,
  captures: [],
  skippedCaptures: [],
  skippedCaptureCount: 0,
  recordsScanned: 0,
  truncated: false,
});

interface CachedSnapshot {
  readonly snapshot: LiveMatchSnapshot;
  readonly directoryMtimeMs: number;
  readonly builtAtMs: number;
}

const snapshotCache = new Map<string, CachedSnapshot>();

function directoryMtimeMsOf(rootDirectory: string): number | null {
  try {
    return statSync(rootDirectory).mtimeMs;
  } catch {
    return null;
  }
}

function isFresh(cached: CachedSnapshot, rootDirectory: string, now: number): boolean {
  if (now - cached.builtAtMs > LIVE_MATCH_SNAPSHOT_TTL_MS) return false;
  const mtimeMs = directoryMtimeMsOf(rootDirectory);
  return mtimeMs !== null && mtimeMs === cached.directoryMtimeMs;
}

/**
 * The cached, bounded read every Player Meta and explorer service now shares.
 * Returns the same cached `LiveMatchSnapshot` object (`===`) for repeated
 * calls against the same `rootDirectory` until either the directory changes
 * or `LIVE_MATCH_SNAPSHOT_TTL_MS` elapses — see the file doc comment.
 */
export function openLiveMatchSnapshot(
  rootDirectory: string,
  limits: Partial<LiveMatchSnapshotLimits> = {},
): LiveMatchSnapshot {
  const resolvedLimits: LiveMatchSnapshotLimits = { ...DEFAULT_LIVE_MATCH_SNAPSHOT_LIMITS, ...limits };
  const now = Date.now();

  const cached = snapshotCache.get(rootDirectory);
  if (cached !== undefined && isFresh(cached, rootDirectory, now)) return cached.snapshot;

  const snapshot = buildLiveMatchSnapshot(rootDirectory, resolvedLimits);
  const directoryMtimeMs = directoryMtimeMsOf(rootDirectory) ?? now;
  snapshotCache.set(rootDirectory, { snapshot, directoryMtimeMs, builtAtMs: now });
  return snapshot;
}

/** Test-only escape hatch: drops every cached snapshot so a test can force the next read to rescan. */
export function resetLiveMatchSnapshotCacheForTests(): void {
  snapshotCache.clear();
}

function buildLiveMatchSnapshot(
  rootDirectory: string,
  limits: LiveMatchSnapshotLimits,
): LiveMatchSnapshot {
  if (!existsSync(rootDirectory)) return EMPTY_SNAPSHOT;

  const matches: LiveMatchEnvelope[] = [];
  const skippedMatches: SkippedLiveMatch[] = [];
  const captures: LiveMatchPreActionCapture[] = [];
  const skippedCaptures: SkippedLiveMatchCapture[] = [];
  let skippedMatchCount = 0;
  let skippedCaptureCount = 0;
  let recordsScanned = 0;
  let bytesRead = 0;
  let truncated = false;

  const recordSkippedMatch = (matchId: string, reason: string): void => {
    skippedMatchCount += 1;
    if (skippedMatches.length < limits.maxSkippedDetails) skippedMatches.push({ matchId, reason });
  };
  const recordSkippedCapture = (matchId: string, reason: string): void => {
    skippedCaptureCount += 1;
    if (skippedCaptures.length < limits.maxSkippedDetails) {
      skippedCaptures.push({ matchId, reason });
    }
  };

  for (const matchId of readdirSync(rootDirectory).sort()) {
    if (recordsScanned >= limits.maxRecords || bytesRead >= limits.maxBytes) {
      truncated = true;
      break;
    }

    const directory = join(rootDirectory, matchId);
    if (!statSync(directory).isDirectory()) continue;
    recordsScanned += 1;

    const envelopePath = join(directory, 'envelope.json');
    if (!existsSync(envelopePath)) {
      recordSkippedMatch(matchId, 'no envelope.json in this match directory');
    } else {
      const raw = readFileSync(envelopePath, 'utf8');
      bytesRead += Buffer.byteLength(raw, 'utf8');

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        recordSkippedMatch(matchId, 'unparseable JSON (likely a truncated write)');
        parsed = undefined;
      }

      if (parsed !== undefined) {
        try {
          matches.push(parseLiveMatchEnvelope(parsed));
        } catch (cause) {
          recordSkippedMatch(
            matchId,
            cause instanceof Error ? cause.message : 'invalid live-match envelope',
          );
        }
      }
    }

    const capturePath = join(directory, 'pre-action-capture.json');
    if (existsSync(capturePath)) {
      const raw = readFileSync(capturePath, 'utf8');
      bytesRead += Buffer.byteLength(raw, 'utf8');

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        recordSkippedCapture(matchId, 'unparseable JSON (likely a truncated write)');
        parsed = undefined;
      }

      if (parsed !== undefined) {
        try {
          captures.push(parseLiveMatchPreActionCapture(parsed));
        } catch (cause) {
          recordSkippedCapture(
            matchId,
            cause instanceof Error ? cause.message : 'invalid pre-action capture',
          );
        }
      }
    }
  }

  return {
    matches,
    skippedMatches,
    skippedMatchCount,
    captures,
    skippedCaptures,
    skippedCaptureCount,
    recordsScanned,
    truncated,
  };
}
