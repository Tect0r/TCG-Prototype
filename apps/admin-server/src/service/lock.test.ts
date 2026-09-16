import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isErr, unwrap } from '@tcg/shared';

import {
  ORCHESTRATOR_LOCK_FILE,
  acquireOrchestratorLock,
  clearStaleOrchestratorLock,
  processIsAlive,
} from './lock.js';

/**
 * The refusal M08.5 named and could not build: *M08.6 creates the process, and
 * is where a second one would have to be refused.*
 *
 * M08.R15 replaced the lock's old automatic stale-takeover with an outright
 * refusal plus a separate, explicit `clearStaleOrchestratorLock` recovery
 * step, because the takeover could not be proven safe against three or more
 * simultaneous contenders. The single-process tests below (driven through
 * injectable `pid`/`host`/`isAlive`) cover that new classification directly.
 * The exclusivity guarantee itself — that `tryCreateLock`'s `link` can never
 * have two winners, under any number of contenders — is instead proven under
 * `describe('real multi-process contention', …)` by spawning actual separate
 * `node` processes through `lock-process-harness.ts`: the property being
 * promised is that a **second OS process** reads what a first one wrote, and
 * only a real child process has its own real, live PID for `processIsAlive`
 * to observe. `Promise.all` inside one process answers a different question.
 */

let root = '';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tcg-admin-lock-'));
  await mkdir(root, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const lockPath = (): string => join(root, ORCHESTRATOR_LOCK_FILE);
const alive = (): boolean => true;
const dead = (): boolean => false;

describe('taking the catalog', () => {
  it('writes a lock naming this process', async () => {
    unwrap(await acquireOrchestratorLock(root, { pid: 4242, host: 'lab' }));

    const record = JSON.parse(await readFile(lockPath(), 'utf8')) as Record<string, unknown>;
    expect(record.pid).toBe(4242);
    expect(record.host).toBe('lab');
    expect(typeof record.startedAt).toBe('string');
  });

  it('carries no version number, and that is the decision rather than an omission', async () => {
    // M08.1's test for adding a version constant: *a third artifact with its own
    // lifetime is a reason to add a third constant.* This file has no lifetime —
    // it exists only while a process does, and one it cannot parse it discards —
    // so a number in it would be a number nothing ever compares.
    await acquireOrchestratorLock(root, { pid: 1, host: 'lab' });
    const record = JSON.parse(await readFile(lockPath(), 'utf8')) as Record<string, unknown>;
    expect(Object.keys(record).sort()).toEqual(['host', 'pid', 'startedAt']);
  });

  it('releases by removing the file', async () => {
    const held = unwrap(await acquireOrchestratorLock(root, { pid: 7, host: 'lab' }));
    await held.release();
    await expect(readFile(lockPath(), 'utf8')).rejects.toThrow();
  });

  it('lets a valid owner release and another process then acquire', async () => {
    const first = unwrap(
      await acquireOrchestratorLock(root, { pid: 100, host: 'lab', isAlive: alive }),
    );
    await first.release();

    unwrap(await acquireOrchestratorLock(root, { pid: 200, host: 'lab', isAlive: alive }));
    const record = JSON.parse(await readFile(lockPath(), 'utf8')) as Record<string, unknown>;
    expect(record.pid).toBe(200);
  });
});

describe('a second orchestrator', () => {
  it('is refused while the first is alive', async () => {
    unwrap(await acquireOrchestratorLock(root, { pid: 100, host: 'lab', isAlive: alive }));
    const refused = await acquireOrchestratorLock(root, {
      pid: 200,
      host: 'lab',
      isAlive: alive,
    });
    expect(isErr(refused)).toBe(true);
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/already_running');
    expect(isErr(refused) && refused.error[0]?.message).toContain('two independent worker budgets');
  });

  it('leaves the first process’s lock exactly as it was', async () => {
    unwrap(await acquireOrchestratorLock(root, { pid: 100, host: 'lab', isAlive: alive }));
    const before = await readFile(lockPath(), 'utf8');
    await acquireOrchestratorLock(root, { pid: 200, host: 'lab', isAlive: alive });
    expect(await readFile(lockPath(), 'utf8')).toBe(before);
  });

  it('names no filesystem path in the refusal', async () => {
    // ADR 0023 §5, and `safeContextSchema` would refuse a path-shaped value
    // anyway. The message names the host and the instant, which is what an
    // operator acts on.
    unwrap(await acquireOrchestratorLock(root, { pid: 100, host: 'lab', isAlive: alive }));
    const refused = await acquireOrchestratorLock(root, { pid: 200, host: 'lab', isAlive: alive });
    const rendered = JSON.stringify(isErr(refused) ? refused.error : []);
    expect(rendered).not.toContain(root.replace(/\\/g, '\\\\'));
    expect(rendered).not.toContain('/tmp');
  });

  it('is refused when the lock was taken on another machine, without guessing', async () => {
    unwrap(await acquireOrchestratorLock(root, { pid: 100, host: 'other-machine' }));
    const refused = await acquireOrchestratorLock(root, {
      pid: 100,
      host: 'this-machine',
      // Would say "dead" if asked — and it must not be asked, because liveness
      // cannot be checked across a machine boundary.
      isAlive: dead,
    });
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/already_running');
    expect(isErr(refused) && refused.error[0]?.message).toContain('cannot be checked across');
  });
});

describe('a lock a crash left behind (M08.R15: refused, never taken over automatically)', () => {
  it('is refused with admin/stale_lock, and left on disk for an operator to inspect', async () => {
    unwrap(await acquireOrchestratorLock(root, { pid: 100, host: 'lab', isAlive: dead }));
    const refused = await acquireOrchestratorLock(root, { pid: 200, host: 'lab', isAlive: dead });

    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/stale_lock');
    const record = JSON.parse(await readFile(lockPath(), 'utf8')) as Record<string, unknown>;
    expect(record.pid).toBe(100);
  });

  it('is refused, not treated as authority, when the lock is unreadable', async () => {
    await writeFile(lockPath(), '{ not json', 'utf8');
    const refused = await acquireOrchestratorLock(root, { pid: 5, host: 'lab' });
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/stale_lock');
    await expect(readFile(lockPath(), 'utf8')).resolves.toBe('{ not json');
  });

  it('never lets a displaced former owner’s release remove a successor’s lock', async () => {
    // Under M08.R15's design a live owner is never displaced by contention —
    // that is the property the multi-process suite below proves — so this
    // exact sequence (a second acquire believing itself a legitimate
    // successor to a first) cannot arise from real, honest contention any
    // more. `release()`'s pid/host guard is still asserted directly here as
    // defense in depth: nothing about that guard depends on how the second
    // record came to exist, and a direct call is the more precise tool for
    // checking one function's own invariant than reconstructing a scenario
    // the rest of this file now proves is unreachable.
    const first = unwrap(
      await acquireOrchestratorLock(root, { pid: 100, host: 'lab', isAlive: alive }),
    );
    await first.release();
    // A second record now occupies the same path, under a different pid.
    unwrap(await acquireOrchestratorLock(root, { pid: 200, host: 'lab', isAlive: alive }));

    // The first holder's own release handle still only recognises pid 100.
    await first.release();
    const record = JSON.parse(await readFile(lockPath(), 'utf8')) as Record<string, unknown>;
    expect(record.pid).toBe(200);
  });
});

describe('the explicit recovery action (clearStaleOrchestratorLock)', () => {
  it('clears a lock naming a dead process on this host', async () => {
    unwrap(await acquireOrchestratorLock(root, { pid: 100, host: 'lab', isAlive: dead }));
    const recovered = unwrap(
      await clearStaleOrchestratorLock(root, { host: 'lab', isAlive: dead }),
    );
    expect(recovered.cleared).toBe(true);
    await expect(readFile(lockPath(), 'utf8')).rejects.toThrow();
  });

  it('clears an unreadable lock outright, since it never named a live owner', async () => {
    await writeFile(lockPath(), '{ not json', 'utf8');
    const recovered = unwrap(await clearStaleOrchestratorLock(root, { host: 'lab' }));
    expect(recovered.cleared).toBe(true);
    await expect(readFile(lockPath(), 'utf8')).rejects.toThrow();
  });

  it('refuses to clear a lock whose process is still alive', async () => {
    unwrap(await acquireOrchestratorLock(root, { pid: 100, host: 'lab', isAlive: alive }));
    const refused = await clearStaleOrchestratorLock(root, { host: 'lab', isAlive: alive });
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/stale_lock');
    expect(isErr(refused) && refused.error[0]?.message).toContain('still running');
    await expect(readFile(lockPath(), 'utf8')).resolves.toBeTruthy();
  });

  it('refuses to clear a lock from another host, without guessing', async () => {
    unwrap(await acquireOrchestratorLock(root, { pid: 100, host: 'other-machine' }));
    const refused = await clearStaleOrchestratorLock(root, { host: 'this-machine', isAlive: dead });
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/stale_lock');
    expect(isErr(refused) && refused.error[0]?.message).toContain('cannot be checked across');
    await expect(readFile(lockPath(), 'utf8')).resolves.toBeTruthy();
  });

  it('reports nothing to clear when no lock is present', async () => {
    const recovered = unwrap(await clearStaleOrchestratorLock(root, { host: 'lab' }));
    expect(recovered.cleared).toBe(false);
  });
});

describe('the liveness check', () => {
  it('says this process is alive and an impossible one is not', () => {
    // `process.kill(pid, 0)` sends no signal; it asks whether the process exists.
    expect(processIsAlive(process.pid)).toBe(true);
    expect(processIsAlive(0x7fff_fffe)).toBe(false);
  });
});

describe('boundary and malformed data', () => {
  it('refuses a lock naming an impossible pid, rather than parsing it as valid (schema boundary)', async () => {
    await writeFile(lockPath(), JSON.stringify({ pid: 0, host: 'lab', startedAt: 'x' }), 'utf8');
    const refused = await acquireOrchestratorLock(root, { pid: 5, host: 'lab' });
    // Schema-invalid is indistinguishable from unreadable: refused, and left
    // for an operator, exactly like any other stale record.
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/stale_lock');
    const record = JSON.parse(await readFile(lockPath(), 'utf8')) as Record<string, unknown>;
    expect(record.pid).toBe(0);
  });

  it('records whatever instant an injected clock reports, at the edges of the representable range', async () => {
    const epoch = unwrap(
      await acquireOrchestratorLock(root, { pid: 1, host: 'lab', clock: () => new Date(0) }),
    );
    const record = JSON.parse(await readFile(lockPath(), 'utf8')) as Record<string, unknown>;
    expect(record.startedAt).toBe(new Date(0).toISOString());

    await epoch.release();

    unwrap(
      await acquireOrchestratorLock(root, {
        pid: 2,
        host: 'lab',
        clock: () => new Date('2099-01-01T00:00:00.000Z'),
      }),
    );
    const laterRecord = JSON.parse(await readFile(lockPath(), 'utf8')) as Record<string, unknown>;
    expect(laterRecord.startedAt).toBe('2099-01-01T00:00:00.000Z');
  });
});

/*
 * ---------------------------------------------------------------------------
 * Real multi-process contention (M08.R15)
 * ---------------------------------------------------------------------------
 *
 * `lock-process-harness.ts` runs as a genuinely separate `node` process,
 * spawned by filesystem path through `vite-node` the same way
 * `npm run start --workspace @tcg/admin-server` runs `main.ts`. Every test
 * below exercises `tryCreateLock`'s exclusive `link()` across real OS
 * processes, which is the only way to prove what a PID-file lock is actually
 * for: that two different `node` processes can never both believe they hold
 * it.
 *
 * CI (`.github/workflows/verify.yml`) runs ubuntu only, so this suite's only
 * Windows coverage is local — which is exactly where M08.R15's own harness
 * work found a real, Windows-specific defect (`SIGTERM` is not delivered to
 * a Node process's handler at all on this platform), so local Windows runs
 * of this file are treated as load-bearing rather than incidental.
 */

const SERVICE_ROOT = import.meta.dirname;
const REPO_ROOT = join(SERVICE_ROOT, '..', '..', '..', '..');
const HARNESS_SCRIPT = join(SERVICE_ROOT, 'lock-process-harness.ts');
const VITE_NODE_CLI = join(REPO_ROOT, 'node_modules', 'vite-node', 'vite-node.mjs');

interface HarnessResult {
  readonly ok: boolean;
  readonly code?: string;
  readonly pid?: number;
  readonly cleared?: boolean;
}

interface HarnessProcess {
  readonly result: Promise<HarnessResult>;
  waitForReady(): Promise<void>;
  waitForExit(): Promise<number | null>;
  release(): void;
  kill(): void;
}

function spawnHarness(mode: 'acquire' | 'hold' | 'recover', catalogRoot: string): HarnessProcess {
  const child = spawn(process.execPath, [VITE_NODE_CLI, HARNESS_SCRIPT], {
    cwd: REPO_ROOT,
    env: { ...process.env, LOCK_HARNESS_ROOT: catalogRoot, LOCK_HARNESS_MODE: mode },
  });

  let readyResolve = (): void => undefined;
  const ready = new Promise<void>((resolve) => {
    readyResolve = resolve;
  });
  let resultResolve = (_value: HarnessResult): void => undefined;
  const result = new Promise<HarnessResult>((resolve) => {
    resultResolve = resolve;
  });

  createInterface({ input: child.stdout }).on('line', (line) => {
    if (line === 'READY') readyResolve();
    else if (line.startsWith('RESULT:'))
      resultResolve(JSON.parse(line.slice('RESULT:'.length)) as HarnessResult);
  });

  const exit = new Promise<number | null>((resolve) => {
    child.once('exit', (code) => resolve(code));
  });

  return {
    result,
    waitForReady: async () => ready,
    waitForExit: async () => exit,
    // A stdin line, not a signal: Windows never delivers a catchable
    // `SIGTERM`/`SIGINT` to a Node process's own handler, only real
    // unconditional termination — see the harness's own module doc comment.
    release: () => {
      child.stdin.write('release\n');
    },
    // Real termination, which — unlike a handler-based graceful release —
    // does work cross-platform through Node's own `ChildProcess.kill`, and
    // is exactly what simulates a crash: no release ever runs.
    kill: () => {
      child.kill('SIGKILL');
    },
  };
}

async function runOnce(mode: 'acquire' | 'recover', catalogRoot: string): Promise<HarnessResult> {
  const proc = spawnHarness(mode, catalogRoot);
  const [result] = await Promise.all([proc.result, proc.waitForExit()]);
  return result;
}

describe('real multi-process contention', () => {
  it('yields exactly one winner between two real processes racing an empty catalog', async () => {
    const [a, b] = [spawnHarness('acquire', root), spawnHarness('acquire', root)];
    const results = await Promise.all([
      Promise.all([a.result, a.waitForExit()]).then(([r]) => r),
      Promise.all([b.result, b.waitForExit()]).then(([r]) => r),
    ]);

    expect(results.filter((result) => result.ok)).toHaveLength(1);
    const loser = results.find((result) => !result.ok);
    expect(loser).toBeDefined();
    // Whichever failed second: the winner may have already exited by the
    // time the loser reads the record, so the loser can honestly observe
    // either "already running" (winner still alive) or "stale" (winner
    // already gone) — the property under test is the single winner, not
    // which refusal reason a real race happens to land on.
    expect(['admin/already_running', 'admin/stale_lock']).toContain(loser!.code);

    const record = JSON.parse(await readFile(lockPath(), 'utf8')) as Record<string, unknown>;
    const winnerPid = results.find((result) => result.ok)!.pid;
    expect(record.pid).toBe(winnerPid);
  }, 30_000);

  it('refuses every contender racing a stale record, rather than letting one silently take it over', async () => {
    const stale = await runOnce('acquire', root);
    expect(stale.ok).toBe(true);
    // `stale`'s process has already exited (awaited above), so its pid is
    // genuinely dead for every contender below — no timing dependency.

    const contenders = [
      spawnHarness('acquire', root),
      spawnHarness('acquire', root),
      spawnHarness('acquire', root),
    ];
    const results = await Promise.all(
      contenders.map((proc) => Promise.all([proc.result, proc.waitForExit()]).then(([r]) => r)),
    );

    expect(results.every((result) => !result.ok)).toBe(true);
    expect(results.every((result) => result.code === 'admin/stale_lock')).toBe(true);

    const record = JSON.parse(await readFile(lockPath(), 'utf8')) as Record<string, unknown>;
    expect(record.pid).toBe(stale.pid);
  }, 30_000);

  it('lets exactly one of at least three real concurrent contenders hold the lock, refuses the rest, and never displaces the live owner', async () => {
    const contenders = [
      spawnHarness('hold', root),
      spawnHarness('hold', root),
      spawnHarness('hold', root),
    ];
    const results = await Promise.all(
      contenders.map(async (proc, index) => {
        const result = await proc.result;
        if (!result.ok) await proc.waitForExit();
        return { index, result };
      }),
    );

    const winners = results.filter((entry) => entry.result.ok);
    const losers = results.filter((entry) => !entry.result.ok);
    expect(winners).toHaveLength(1);
    expect(losers).toHaveLength(2);
    for (const loser of losers) expect(loser.result.code).toBe('admin/already_running');

    const winner = contenders[winners[0]!.index]!;
    await winner.waitForReady();

    // A later, fourth contender is refused too: the live owner is never
    // displaced, no matter how many processes ask.
    const fourth = await runOnce('acquire', root);
    expect(fourth.ok).toBe(false);
    expect(fourth.code).toBe('admin/already_running');

    winner.release();
    const exitCode = await winner.waitForExit();
    expect(exitCode).toBe(0);
    await expect(readFile(lockPath(), 'utf8')).rejects.toThrow();
  }, 30_000);

  it('refuses a lock left behind by a killed process, and recovery clears it for a fresh acquire', async () => {
    const holder = spawnHarness('hold', root);
    const acquired = await holder.result;
    expect(acquired.ok).toBe(true);
    await holder.waitForReady();

    holder.kill(); // simulated crash: no release ever runs
    await holder.waitForExit();

    const blocked = await runOnce('acquire', root);
    expect(blocked.ok).toBe(false);
    expect(blocked.code).toBe('admin/stale_lock');
    // Left on disk, untouched, for the recovery step to act on.
    const record = JSON.parse(await readFile(lockPath(), 'utf8')) as Record<string, unknown>;
    expect(record.pid).toBe(acquired.pid);

    const recovered = await runOnce('recover', root);
    expect(recovered.ok).toBe(true);
    expect(recovered.cleared).toBe(true);

    const fresh = await runOnce('acquire', root);
    expect(fresh.ok).toBe(true);
    const freshRecord = JSON.parse(await readFile(lockPath(), 'utf8')) as Record<string, unknown>;
    expect(freshRecord.pid).toBe(fresh.pid);
  }, 30_000);

  it('refuses to recover a lock while its real process is still alive', async () => {
    const holder = spawnHarness('hold', root);
    const acquired = await holder.result;
    expect(acquired.ok).toBe(true);
    await holder.waitForReady();

    const recovered = await runOnce('recover', root);
    expect(recovered.ok).toBe(false);
    expect(recovered.code).toBe('admin/stale_lock');

    // The still-live lock was left untouched by the refused recovery.
    const record = JSON.parse(await readFile(lockPath(), 'utf8')) as Record<string, unknown>;
    expect(record.pid).toBe(acquired.pid);

    holder.release();
    const exitCode = await holder.waitForExit();
    expect(exitCode).toBe(0);
  }, 30_000);
});
