import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { isErr, unwrap } from '@tcg/shared';

import { ORCHESTRATOR_LOCK_FILE, acquireOrchestratorLock, processIsAlive } from './lock.js';

/**
 * The refusal M08.5 named and could not build: *M08.6 creates the process, and
 * is where a second one would have to be refused.*
 *
 * Every case below is driven through a real file under a real directory, because
 * the thing being promised is that a **second process** reads what a first one
 * wrote. A stubbed store would be answering a different question.
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
    const held = unwrap(await acquireOrchestratorLock(root, { pid: 4242, host: 'lab' }));
    expect(held.tookOverStaleLock).toBe(false);

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

describe('a lock a crash left behind', () => {
  it('is taken over, and the takeover is reported rather than silent', async () => {
    unwrap(await acquireOrchestratorLock(root, { pid: 100, host: 'lab', isAlive: dead }));
    const held = unwrap(
      await acquireOrchestratorLock(root, { pid: 200, host: 'lab', isAlive: dead }),
    );
    expect(held.tookOverStaleLock).toBe(true);

    const record = JSON.parse(await readFile(lockPath(), 'utf8')) as Record<string, unknown>;
    expect(record.pid).toBe(200);
  });

  it('is taken over when it is unreadable, rather than treated as authority', async () => {
    await writeFile(lockPath(), '{ not json', 'utf8');
    const held = unwrap(await acquireOrchestratorLock(root, { pid: 5, host: 'lab' }));
    expect(held.tookOverStaleLock).toBe(false);
    const record = JSON.parse(await readFile(lockPath(), 'utf8')) as Record<string, unknown>;
    expect(record.pid).toBe(5);
  });

  it('is not deleted by the process it replaced', async () => {
    // The one ordering that would undo the lock entirely: a slow shutdown from a
    // process that was already declared stale, arriving after its successor took
    // over. `release` checks that the file still names it.
    const first = unwrap(
      await acquireOrchestratorLock(root, { pid: 100, host: 'lab', isAlive: dead }),
    );
    unwrap(await acquireOrchestratorLock(root, { pid: 200, host: 'lab', isAlive: dead }));
    await first.release();

    const record = JSON.parse(await readFile(lockPath(), 'utf8')) as Record<string, unknown>;
    expect(record.pid).toBe(200);
  });
});

describe('the liveness check', () => {
  it('says this process is alive and an impossible one is not', () => {
    // `process.kill(pid, 0)` sends no signal; it asks whether the process exists.
    expect(processIsAlive(process.pid)).toBe(true);
    expect(processIsAlive(0x7fff_fffe)).toBe(false);
  });
});
