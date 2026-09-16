import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { link, mkdir, open, rm } from 'node:fs/promises';

import { adminError, type AdminError } from '@tcg/admin-contracts';
import { err, ok, type Result } from '@tcg/shared';
import { z } from 'zod';

import { readDocumentText } from '../catalog/files.js';

/**
 * One orchestration process per catalog, enforced rather than assumed.
 *
 * M08.5 recorded this as the gap M08.6 would have to close, and named the reason
 * it could not be closed earlier: *two orchestrators in two processes could both
 * pass the `start` transition, and the worker budget is one process's own.
 * ADR 0023 §4 describes one administrator and one orchestration process, and this
 * workspace still has no entry point at all — so there is nothing yet for a lock
 * to protect. M08.6 creates the process, and is where a second one would have to
 * be refused.*
 *
 * The damage a second process does is worth being concrete about, because it is
 * not "two writers race on a file" — the store already handles that with atomic
 * renames and per-document locks. It is that **both would run the same job**. A
 * `queued` job is started by whichever orchestrator reaches it, and two of them
 * would each take the `start` transition on different reads of the same
 * document, each open the same experiment directory, and each append to the same
 * `matches.jsonl`. The stream's identity dedupe would prevent duplicated
 * *records*, but both would be playing the same matches on the same machine
 * under two independent worker budgets, which is exactly the oversubscription
 * `limits.ts` exists to prevent.
 *
 * ## Why a PID file, and what it honestly gives
 *
 * An advisory lock, and it says so. The file records which process on which host
 * took the catalog, and a second process reads it before doing anything:
 *
 * - **Same host, process alive** → refused. `process.kill(pid, 0)` sends no
 *   signal; it asks whether the process exists, which is the question.
 * - **Same host, process gone** → taken over, and the takeover is *reported*
 *   rather than silent. A crash is exactly how this file is normally left
 *   behind, and a lab that refused to start after one would be a lab that needs
 *   a manual step after every crash — which is the step people automate away
 *   with `rm`, and then it protects nothing.
 * - **A different host** → refused, and not taken over. Liveness cannot be
 *   checked across a machine boundary, so the only safe answer is the one that
 *   does not guess. A catalog on a network share is the case, and it is rare
 *   enough to be worth an operator's attention.
 * - **Unreadable** → taken over. A truncated or hand-edited lock names nobody,
 *   and refusing to start because of a file this process would rewrite anyway
 *   would be treating corruption as authority.
 *
 * There is no `flock`: Node has no portable advisory locking, the Windows and
 * POSIX semantics differ in exactly the way that matters here, and a lock this
 * layer cannot explain is worse than one it can. What this does not defend
 * against is a PID that has been reused by an unrelated process, which would
 * cause a spurious refusal rather than a spurious start — the direction an
 * operator can see and act on.
 *
 * ## No version constant
 *
 * Deliberately, and by the test M08.1 set for adding one: *a third artifact with
 * its own lifetime is a reason to add a third constant; a second schema inside
 * the same family is not.* This file has no lifetime at all. It exists only
 * while a process does, it is never read by a later build for its contents, and
 * a version it could not parse is a version it discards. A number in it would be
 * a number nothing ever compares.
 */

/** The lock's name under the catalog root. */
export const ORCHESTRATOR_LOCK_FILE = 'orchestrator.lock';

const lockSchema = z.object({
  pid: z.number().int().min(1),
  host: z.string().min(1).max(255),
  startedAt: z.string().min(1).max(64),
});
type LockRecord = z.infer<typeof lockSchema>;

/** What a held lock lets its holder do: give it back. */
export interface OrchestratorLock {
  /** True when a previous process left this behind and this one took it over. */
  readonly tookOverStaleLock: boolean;
  /** Releases the lock, but only if it still names this process. */
  release(): Promise<void>;
}

export interface AcquireLockOptions {
  readonly pid?: number;
  readonly host?: string;
  readonly clock?: () => Date;
  /** Injectable so a test can drive "the other process is alive" without one. */
  readonly isAlive?: (pid: number) => boolean;
}

/** Whether a process with this ID exists on this machine. Sends no signal. */
export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    // `EPERM` means it exists and belongs to somebody else, which is still a
    // reason not to start: the answer to "is the lab already running" is yes.
    return (cause as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/**
 * Concurrent contenders that all find the same stale lock each retry through
 * this many rounds before giving up. Each round resolves at most one
 * contender permanently (the atomic create below either wins outright or
 * tells its loser the winner's identity), so this is generous headroom for
 * contention, not a tuning knob for expected latency.
 */
const MAX_ACQUIRE_ATTEMPTS = 16;

export async function acquireOrchestratorLock(
  catalogRoot: string,
  options: AcquireLockOptions = {},
): Promise<Result<OrchestratorLock, readonly AdminError[]>> {
  const path = join(catalogRoot, ORCHESTRATOR_LOCK_FILE);
  const pid = options.pid ?? process.pid;
  const host = options.host ?? hostname();
  const isAlive = options.isAlive ?? processIsAlive;
  const clock = options.clock ?? (() => new Date());

  await mkdir(dirname(path), { recursive: true });

  let tookOverStaleLock = false;

  for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt += 1) {
    const record: LockRecord = { pid, host, startedAt: clock().toISOString() };

    // The one atomic step: the record is written out fully and synced to a
    // private temporary file first, then published with `link`, which fails
    // rather than replacing when the destination already exists. Unlike
    // `open(path, 'wx')` — which makes the destination visible to a reader
    // before its content is written — the destination here never exists
    // until it already names the complete record, so a concurrent reader can
    // never observe a half-written lock and mistake it for a malformed one.
    // When several processes race here — whether the lock was empty or was
    // just cleared below — exactly one `link` call succeeds; every other one
    // observes `EEXIST` and goes on to read what the winner published.
    if (await tryCreateLock(path, record)) {
      return ok(makeHeldLock(path, pid, host, tookOverStaleLock));
    }

    const existing = await readLock(path);

    if (existing !== null) {
      if (existing.host !== host) {
        return err([
          adminError(
            'admin/already_running',
            `This catalog is held by an orchestrator on \`${existing.host}\`, and liveness cannot be checked across machines, so it was not taken over. Stop that process, or remove the lock file in the catalog root if you are certain it is gone.`,
            { context: { holder: existing.host, since: existing.startedAt } },
          ),
        ]);
      }
      if (existing.pid !== pid && isAlive(existing.pid)) {
        return err([
          adminError(
            'admin/already_running',
            'Another orchestration process on this machine is already running this catalog. ADR 0023 §4 describes one administrator and one orchestration process; two would run the same queued job under two independent worker budgets.',
            { context: { holder: existing.host, since: existing.startedAt } },
          ),
        ]);
      }
      // Same host, and either this process's own prior record or a dead pid:
      // stale. Recorded now because the removal below is not itself what
      // decides the winner — the next loop's create is — and a losing
      // contender must not report a takeover it did not perform.
      if (existing.pid !== pid) tookOverStaleLock = true;
    }

    // `existing === null` covers both a malformed record (M08.5's "unreadable
    // is taken over, not treated as authority") and a file another contender
    // already cleared out from under us. Either way there is nothing here to
    // preserve, so clear it — `force` makes this safe even if it is already
    // gone — and let the next iteration's atomic create be the actual
    // arbitration. Two contenders can both reach this line for the same
    // stale file; at most one of the creates that follow can win.
    await rm(path, { force: true });
  }

  return err([
    adminError(
      'admin/already_running',
      'Could not acquire the orchestrator lock: another process kept winning it under contention. Retry, or check whether an orchestrator is legitimately starting up.',
      { context: { host } },
    ),
  ]);
}

function makeHeldLock(
  path: string,
  pid: number,
  host: string,
  tookOverStaleLock: boolean,
): OrchestratorLock {
  return {
    tookOverStaleLock,
    async release(): Promise<void> {
      // Only if it is still ours. A process that was declared stale and taken
      // over must not delete the successor's lock on its way out.
      const held = await readLock(path);
      if (held === null || held.pid !== pid || held.host !== host) return;
      await rm(path, { force: true });
    },
  };
}

/**
 * Writes the record to a private temporary file, then publishes it with an
 * exclusive `link` so the published file is either absent or complete —
 * never half-written. `false` means another contender's `link` won instead.
 */
async function tryCreateLock(path: string, record: LockRecord): Promise<boolean> {
  const temp = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  const handle = await open(temp, 'wx');
  try {
    await handle.writeFile(`${JSON.stringify(record, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await link(temp, path);
    return true;
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw cause;
  } finally {
    await rm(temp, { force: true });
  }
}

async function readLock(path: string): Promise<LockRecord | null> {
  const text = await readDocumentText(path);
  if (text === null) return null;
  try {
    const parsed = lockSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
