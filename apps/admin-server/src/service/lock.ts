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
 * M08.5 recorded this as the gap M08.6 would have to close: *two orchestrators
 * in two processes could both pass the `start` transition, and the worker
 * budget is one process's own.* ADR 0023 §4 describes one administrator and
 * one orchestration process. The damage a second process does is worth being
 * concrete about, because it is not "two writers race on a file" — the store
 * already handles that with atomic renames and per-document locks. It is that
 * **both would run the same job**, each opening the same experiment directory
 * under two independent worker budgets, which is exactly the oversubscription
 * `limits.ts` exists to prevent.
 *
 * ## Why a PID file, and what it honestly gives
 *
 * An advisory lock, and it says so. The file records which process on which
 * host took the catalog, and a second process reads it before doing anything:
 *
 * - **Same host, process alive** → refused (`admin/already_running`).
 *   `process.kill(pid, 0)` sends no signal; it asks whether the process
 *   exists, which is the question.
 * - **Same host, process gone (or the record is unreadable)** → refused with
 *   `admin/stale_lock`, **not** taken over automatically. See "no automatic
 *   takeover" below for why.
 * - **A different host** → refused, and never taken over automatically.
 *   Liveness cannot be checked across a machine boundary, so the only safe
 *   answer is the one that does not guess. A catalog on a network share is
 *   the case, and it is rare enough to be worth an operator's attention.
 *
 * There is no `flock`: Node has no portable advisory locking, the Windows and
 * POSIX semantics differ in exactly the way that matters here, and a lock
 * this layer cannot explain is worse than one it can.
 *
 * ## No automatic takeover (M08.R15)
 *
 * M08.R11–M08.R14 tried to make an *automatic* stale-lock takeover safe under
 * arbitrary contention: detach the stale record with `rename` (so at most one
 * simultaneous claimant sees the source exist), verify the detached content
 * still matched what was read, and only then treat the path as clear for a
 * fresh `link`. That construction is provably correct for exactly two
 * contenders, and M08.R14's own `claimStaleRecord` doc comment recorded,
 * honestly, that it was *not* provably correct for three or more: a third
 * contender's create could win the briefly-empty path in the gap between a
 * second contender's detach and its own restore-on-mismatch, discarding a
 * fresh record its publisher still believed valid. A design that documents a
 * residual race while claiming exclusivity is not a fix — it is a narrower
 * window on the same defect, and an independent review of M08.5 correctly
 * refused to accept "narrower" as "closed."
 *
 * Rather than build a bespoke consensus protocol to close a three-contender
 * window over a single PID file — a lock this layer could not explain, per
 * the module's own long-standing rule — acquisition now refuses a stale lock
 * outright and leaves clearing it to a **separate, explicit, single-operator
 * action**: `clearStaleOrchestratorLock`. That function performs exactly one
 * `rm`, guarded by the same liveness and host checks acquisition itself uses,
 * and ADR 0023 §4 already scopes this whole file to one administrator — a
 * human running one recovery command is not a race, because there is only
 * ever one of them. What acquisition itself does — `tryCreateLock`'s
 * exclusive `link` — is unconditionally exclusive for any number of
 * contenders: `link` either publishes the one complete record or fails with
 * `EEXIST`, with no path that ever removes or replaces an existing lock as
 * part of acquiring a new one. That is the property this file now actually
 * guarantees, for any number of simultaneous contenders, rather than merely
 * claims.
 *
 * ## No version constant
 *
 * Deliberately, and by the test M08.1 set for adding one: *a third artifact
 * with its own lifetime is a reason to add a third constant; a second schema
 * inside the same family is not.* This file has no lifetime at all. It exists
 * only while a process does, it is never read by a later build for its
 * contents, and a version it could not parse is a version it discards. A
 * number in it would be a number nothing ever compares.
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
 * Acquires the one orchestrator lock for `catalogRoot`, or refuses.
 *
 * The only path that ever publishes a lock record is `tryCreateLock`'s
 * exclusive `link`, which either creates the destination or fails with
 * `EEXIST` — never replaces one. So this function never removes, renames or
 * overwrites an existing lock; a stale or malformed one is reported through
 * `admin/stale_lock` for an operator to clear with `clearStaleOrchestratorLock`,
 * not cleared here.
 */
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

  const record: LockRecord = { pid, host, startedAt: clock().toISOString() };
  if (await tryCreateLock(path, record)) {
    return ok(makeHeldLock(path, pid, host));
  }

  const existing = await readLock(path);

  if (existing !== null && existing.host !== host) {
    return err([
      adminError(
        'admin/already_running',
        `This catalog is held by an orchestrator on \`${existing.host}\`, and liveness cannot be checked across machines, so it was not taken over. Stop that process, or clear the lock on that host if you are certain it is gone.`,
        { context: { holder: existing.host, since: existing.startedAt } },
      ),
    ]);
  }

  if (existing !== null && isAlive(existing.pid)) {
    return err([
      adminError(
        'admin/already_running',
        'Another orchestration process on this machine is already running this catalog. ADR 0023 §4 describes one administrator and one orchestration process; two would run the same queued job under two independent worker budgets.',
        { context: { holder: existing.host, since: existing.startedAt } },
      ),
    ]);
  }

  // Either a genuinely dead PID on this host, or a lock this process could
  // not even parse (M08.5's "unreadable is not authority" — but M08.R15
  // stopped treating either case as something acquisition may clear itself).
  return err([
    adminError(
      'admin/stale_lock',
      'This catalog is held by a lock naming a process that is no longer running on this host. It was not taken over automatically — run the orchestrator lock recovery step once you have confirmed that process is really gone, then start again.',
      existing === null ? {} : { context: { holder: existing.host, since: existing.startedAt } },
    ),
  ]);
}

/**
 * The explicit, single-operator recovery action M08.R15's design relies on:
 * clears the lock at `catalogRoot`, but only when it can positively confirm
 * there is nothing left to protect — the same host and a dead PID, or a
 * record this process cannot even parse. A live lock, same-host or
 * cross-host, is left untouched and reported as a refusal.
 *
 * Safe to run concurrently with nothing else, because ADR 0023 §4 scopes the
 * whole file to one administrator: there is never a second recovery action
 * racing this one the way two orchestrators could race an automatic takeover.
 */
export async function clearStaleOrchestratorLock(
  catalogRoot: string,
  options: Pick<AcquireLockOptions, 'host' | 'isAlive'> = {},
): Promise<Result<{ readonly cleared: boolean }, readonly AdminError[]>> {
  const path = join(catalogRoot, ORCHESTRATOR_LOCK_FILE);
  const host = options.host ?? hostname();
  const isAlive = options.isAlive ?? processIsAlive;

  const text = await readDocumentText(path);
  if (text === null) return ok({ cleared: false });

  const existing = parseLockText(text);
  if (existing === null) {
    // Never named a live owner in the first place — safe to clear.
    await rm(path, { force: true });
    return ok({ cleared: true });
  }

  if (existing.host !== host) {
    return err([
      adminError(
        'admin/stale_lock',
        `This catalog's lock names a different host (\`${existing.host}\`), and liveness cannot be checked across machines, so it was not cleared. Confirm that orchestrator is really gone, then clear the lock on \`${existing.host}\` itself.`,
        { context: { holder: existing.host, since: existing.startedAt } },
      ),
    ]);
  }

  if (isAlive(existing.pid)) {
    return err([
      adminError(
        'admin/stale_lock',
        'The orchestration process that holds this lock is still running on this host, so nothing was cleared. Stop it first.',
        { context: { holder: existing.host, since: existing.startedAt } },
      ),
    ]);
  }

  await rm(path, { force: true });
  return ok({ cleared: true });
}

function makeHeldLock(path: string, pid: number, host: string): OrchestratorLock {
  return {
    async release(): Promise<void> {
      // Only if it is still ours. A process must never remove a lock some
      // other holder's name is on it.
      const held = await readLock(path);
      if (held === null || held.pid !== pid || held.host !== host) return;
      await rm(path, { force: true });
    },
  };
}

/**
 * Writes the record to a private temporary file, then publishes it with an
 * exclusive `link` so the published file is either absent or complete —
 * never half-written, and never a replacement of whatever previously
 * occupied `path`. `false` means the destination already existed — a fresh
 * win, a live prior owner or a stale one, this function does not tell them
 * apart; the caller reads and classifies `path` afterward.
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
  return text === null ? null : parseLockText(text);
}

function parseLockText(text: string): LockRecord | null {
  try {
    const parsed = lockSchema.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
