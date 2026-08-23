import { hostname } from 'node:os';
import { join } from 'node:path';
import { rm } from 'node:fs/promises';

import { adminError, type AdminError } from '@tcg/admin-contracts';
import { err, ok, type Result } from '@tcg/shared';
import { z } from 'zod';

import { readDocumentText, writeJsonAtomically } from '../catalog/files.js';

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

export async function acquireOrchestratorLock(
  catalogRoot: string,
  options: AcquireLockOptions = {},
): Promise<Result<OrchestratorLock, readonly AdminError[]>> {
  const path = join(catalogRoot, ORCHESTRATOR_LOCK_FILE);
  const pid = options.pid ?? process.pid;
  const host = options.host ?? hostname();
  const isAlive = options.isAlive ?? processIsAlive;
  const now = (options.clock ?? (() => new Date()))().toISOString();

  const existing = await readLock(path);
  let tookOverStaleLock = false;

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
    tookOverStaleLock = existing.pid !== pid;
  }

  const record: LockRecord = { pid, host, startedAt: now };
  await writeJsonAtomically(path, record);

  return ok({
    tookOverStaleLock,
    async release(): Promise<void> {
      // Only if it is still ours. A process that was declared stale and taken
      // over must not delete the successor's lock on its way out.
      const held = await readLock(path);
      if (held === null || held.pid !== pid || held.host !== host) return;
      await rm(path, { force: true });
    },
  });
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
