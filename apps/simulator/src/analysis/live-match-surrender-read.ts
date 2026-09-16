import type { LiveMatchPreActionCapture } from '@tcg/match-telemetry';

import { openLiveMatchSnapshot, type SkippedLiveMatchCapture } from './live-match-snapshot.js';

/**
 * M08.25D — the simulator-side reader for `LiveMatchFileStore`'s optional
 * `pre-action-capture.json`, mirroring `live-match-read.ts`'s tolerant-read
 * idiom exactly (same reasons: lives in `@tcg/simulator` per ADR 0023 §2,
 * synchronous per this package's own convention).
 *
 * A missing capture file is the expected case, not damage:
 * `apps/multiplayer-server/src/live-match-store.ts` writes
 * `pre-action-capture.json` only when a match ended in a voluntary surrender
 * (`LIVE_MATCH_VOLUNTARY_TERMINATION_ORIGINS`) — most matches never have one,
 * so a match directory with no capture is skipped silently rather than
 * reported. Only a *present but unreadable* capture is reported in `skipped`,
 * the same way an unparseable or schema-invalid envelope is.
 *
 * M08.R10 — the scan itself, and the cache it now reads through, live in
 * `./live-match-snapshot.ts`'s `openLiveMatchSnapshot`, which reads
 * `envelope.json` and `pre-action-capture.json` in the same pass
 * `readLiveMatchEnvelopes` reads envelopes in — one `readdirSync` over the
 * root rather than one per reader. This function is a thin,
 * unchanged-signature projection of that cached snapshot.
 */

export { type SkippedLiveMatchCapture };

export interface ReadLiveMatchPreActionCapturesResult {
  readonly captures: readonly LiveMatchPreActionCapture[];
  readonly skipped: readonly SkippedLiveMatchCapture[];
}

/** Reads every readable `LiveMatchPreActionCapture` under `rootDirectory`, skipping matches that never surrendered. */
export function readLiveMatchPreActionCaptures(
  rootDirectory: string,
): ReadLiveMatchPreActionCapturesResult {
  const snapshot = openLiveMatchSnapshot(rootDirectory);
  return { captures: snapshot.captures, skipped: snapshot.skippedCaptures };
}
