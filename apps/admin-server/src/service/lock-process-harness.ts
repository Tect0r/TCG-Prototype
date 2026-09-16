/* eslint-disable no-console */
import { isErr } from '@tcg/shared';

import { acquireOrchestratorLock, clearStaleOrchestratorLock } from './lock.js';

/**
 * A real, separate OS process for `lock.test.ts`'s multi-process suites.
 *
 * M08.R15's review asked for the exclusivity guarantee to be demonstrated
 * under **actual independent processes**, not `Promise.all` inside one — the
 * thing a PID-file lock is actually meant to survive is two different
 * `node` processes, and only a real child process has its own real, live PID
 * for `processIsAlive` to observe. This file is that second process. It is
 * not shipped: `boundary.test.ts`'s `sourceFiles()` excludes it by name, the
 * same way it already excludes `catalog/test-catalog.ts`.
 *
 * Protocol, over stdout, one line at a time:
 * - `RESULT:<json>` — the outcome of the one action this run performs.
 * - `READY` — mode `hold` only, printed after a successful acquire, once it
 *   is safe for the parent to spawn the next contender.
 *
 * Mode is read from `LOCK_HARNESS_MODE` and the catalog root from
 * `LOCK_HARNESS_ROOT` — environment variables are how a *parent test*, not
 * this workspace's own configuration, hands a child process its instructions,
 * which is a different thing from `main.ts` reading `TCG_ADMIN_*` for its own
 * configuration and is why `boundary.test.ts` excludes this file by name
 * rather than granting it a second `process.env` exception.
 *
 * - `acquire` — attempts one `acquireOrchestratorLock`, prints the result,
 *   exits immediately. Used both for ordinary contenders and, by never
 *   releasing before exit, to leave behind exactly the lock a crash would:
 *   a record naming a real PID that is provably dead the instant this
 *   process exits.
 * - `hold` — acquires, prints `READY`, then stays alive until a `release\n`
 *   line arrives on stdin, which releases the lock and exits 0 — or the
 *   parent kills the process outright (a real crash while holding a valid
 *   lock, which is also how a test drives the "stale" scenarios: it never
 *   asks a `hold` process to release, it just kills it and leaves the lock
 *   behind naming a PID that is provably dead the instant the process is
 *   gone).
 *
 *   Control arrives over stdin rather than a signal because Windows has no
 *   real POSIX signal delivery: `SIGTERM` sent to a Node process on Windows
 *   terminates it unconditionally rather than invoking a registered handler,
 *   so a handler-based release is untestable on this repository's own
 *   development platform and the CI matrix is not the only place these
 *   tests have to actually pass. A `release\n` line on stdin is delivered
 *   identically by `child_process.spawn`'s stdio pipe on every platform.
 * - `recover` — calls `clearStaleOrchestratorLock` once, prints the result,
 *   exits immediately.
 */

async function main(): Promise<number> {
  const root = process.env.LOCK_HARNESS_ROOT;
  const mode = process.env.LOCK_HARNESS_MODE;
  if (root === undefined || root === '') {
    console.error('LOCK_HARNESS_ROOT is required.');
    return 1;
  }

  if (mode === 'recover') {
    const recovered = await clearStaleOrchestratorLock(root);
    const payload = isErr(recovered)
      ? { ok: false, code: recovered.error[0]?.code ?? null }
      : { ok: true, ...recovered.value };
    console.log(`RESULT:${JSON.stringify(payload)}`);
    return 0;
  }

  if (mode !== 'acquire' && mode !== 'hold') {
    console.error(`Unknown LOCK_HARNESS_MODE: ${String(mode)}`);
    return 1;
  }

  const acquired = await acquireOrchestratorLock(root);
  if (isErr(acquired)) {
    console.log(`RESULT:${JSON.stringify({ ok: false, code: acquired.error[0]?.code ?? null })}`);
    return 1;
  }

  console.log(`RESULT:${JSON.stringify({ ok: true, pid: process.pid })}`);

  if (mode === 'acquire') return 0;

  // mode === 'hold': stay alive, holding a valid lock, until told to stop.
  const keepAlive = setInterval(() => {}, 1000);
  let releasing = false;
  const releaseAndExit = (): void => {
    if (releasing) return;
    releasing = true;
    clearInterval(keepAlive);
    process.stdin.pause();
    void acquired.value.release().then(() => {
      process.exit(0);
    });
  };
  // A `release` line on stdin, not a signal — see the module doc comment for
  // why: Windows delivers no catchable `SIGTERM` to a Node process at all.
  let buffered = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk: string) => {
    buffered += chunk;
    if (buffered.includes('release')) releaseAndExit();
  });
  process.stdin.resume();
  console.log('READY');
  return 0;
}

const code = await main();
if (code !== 0) process.exitCode = code;
