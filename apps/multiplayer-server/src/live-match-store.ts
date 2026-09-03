import { randomBytes } from 'node:crypto';
import { closeSync, fsyncSync, mkdirSync, openSync, renameSync, rmSync, writeSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { LiveMatchRecord, LiveMatchSink } from './live-match-sink.js';

/**
 * M08.22B's canonical idempotent persistence: one durable record per match, on
 * disk, addressed by `matchId` alone. `<rootDirectory>/<matchId>/` holds
 * `envelope.json` (always) plus `raw-event.json`, `replay.json` and
 * `pre-action-capture.json` (exactly when `LiveMatchRecord` carries them — a
 * retention decision M08.21/M08.23D already made, not one this store
 * second-guesses). No index file and no minted id anywhere in this module:
 * the directory name *is* the record's identity, so "does this match already
 * have a record" is answerable by the filesystem itself rather than a second
 * source of truth that could drift from it.
 *
 * `pre-action-capture.json` is the most sensitive of the three: a full,
 * unredacted engine-state snapshot including whatever either player's hidden
 * zones held. It is written to the same match directory as the other
 * artifacts — this store has no separate admin-only storage area — so
 * "admin-only" is enforced entirely upstream, by which callers are ever wired
 * to read this root directory at all, and by `packages/protocol/src/boundary.test.ts`
 * proving the wire protocol sent to clients can never carry it.
 *
 * `receive` is synchronous, matching `LiveMatchSink`'s contract (M08.22A):
 * `MatchServer.ingestLiveMatch` calls it inside a plain `try`/`catch`, so
 * every write below is synchronous too — an async write could still be
 * in flight when that `catch` had already decided nothing went wrong.
 *
 * **Idempotent duplicate/retry.** Because each file's path is a pure function
 * of `matchId`, calling `receive` again for the same match — a retried
 * completion, a duplicate delivery — overwrites the same files atomically
 * instead of creating another record or another directory. "Idempotent" here
 * means safe and side-effect-free to repeat, not "refuses the second call":
 * M08.22C's lifecycle wiring is what decides when a duplicate can occur, and
 * this store's job is only to make repeating it harmless.
 *
 * **Atomic writes.** Every file is written to a sibling temp path, `fsync`ed,
 * then renamed into place — the same discipline
 * `apps/admin-server/src/catalog/files.ts`'s `writeJsonAtomically` uses for
 * its own documents, reimplemented synchronously here rather than imported:
 * `boundary.test.ts` forbids this workspace from depending on
 * `@tcg/admin-server` at all, and that store's own writes are asynchronous
 * throughout, which this interface cannot be.
 *
 * **Precondition: `matchId` must be unique across the retention window.**
 * This store is canonical only for a `matchId` it can trust as a durable
 * identity — it has no way to tell "the same match, retried" from "a
 * different match that reused the name" apart, and treats both the same way
 * on purpose (see "Idempotent duplicate/retry" above). No caller wires this
 * store from a live `matchId` today (only tests construct one), so nothing
 * currently depends on that trust being justified. The open question for
 * whichever future slice does wire it up: `MatchServer` currently derives
 * `matchId` from a lobby invite code, and invite codes are recycled once
 * their lobby closes, so a live `matchId` is not guaranteed unique across the
 * retention window as-is. That slice must either mint a retention-scoped
 * unique id or otherwise close this gap before depending on this store.
 */

const MATCH_ID_PATH_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

/** Refuses a `matchId` that is not safe to use verbatim as a filesystem path segment. */
function assertPathSafeMatchId(matchId: string): void {
  if (!MATCH_ID_PATH_PATTERN.test(matchId)) {
    throw new Error(
      `matchId "${matchId}" is not safe to use as a filesystem path segment ` +
        `(must match ${MATCH_ID_PATH_PATTERN.source}).`,
    );
  }
}

/** Error codes a rename reports when the destination is momentarily held open by somebody else. */
const RENAME_CONTENTION_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RENAME_ATTEMPTS = 12;

/**
 * Blocks the current thread for `ms` without spinning the CPU, using
 * `Atomics.wait` on a throwaway buffer nothing else touches. `receive`'s
 * contract is already synchronous, so this costs nothing that call did not
 * already cost — it is only how a synchronous caller waits at all.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Renames, retrying briefly while a reader is holding the destination (Windows only; see files.ts). */
function renameOverBusyReader(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      renameSync(from, to);
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code ?? '';
      if (attempt >= RENAME_ATTEMPTS - 1 || !RENAME_CONTENTION_CODES.has(code)) throw cause;
      sleepSync(Math.min(2 ** attempt, 25));
    }
  }
}

/** Writes a JSON document so a reader never observes a half-written file. */
function writeJsonAtomicallySync(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temporary, 'wx');
    writeSync(fd, Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8'));
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    renameOverBusyReader(temporary, path);
  } catch (cause) {
    if (fd !== undefined) closeSync(fd);
    rmSync(temporary, { force: true });
    throw cause;
  }
}

export interface LiveMatchFileStoreOptions {
  /** Directory holding one subdirectory per match. Created on first write if absent. */
  readonly rootDirectory: string;
}

export class LiveMatchFileStore implements LiveMatchSink {
  readonly sinkId = 'live_match_file_store';
  readonly #root: string;

  constructor(options: LiveMatchFileStoreOptions) {
    this.#root = options.rootDirectory;
  }

  receive(record: LiveMatchRecord): void {
    const { matchId } = record.envelope;
    assertPathSafeMatchId(matchId);
    const matchDirectory = join(this.#root, matchId);

    writeJsonAtomicallySync(join(matchDirectory, 'envelope.json'), record.envelope);
    if (record.rawEvent !== null) {
      writeJsonAtomicallySync(join(matchDirectory, 'raw-event.json'), record.rawEvent);
    }
    if (record.replay !== null) {
      writeJsonAtomicallySync(join(matchDirectory, 'replay.json'), record.replay);
    }
    if (record.preActionCapture !== null) {
      writeJsonAtomicallySync(
        join(matchDirectory, 'pre-action-capture.json'),
        record.preActionCapture,
      );
    }
  }
}
