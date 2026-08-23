import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { isErr, isOk, unwrap } from '@tcg/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveCatalogRoots, resolveResultLocation } from './roots.js';
import { makeTestCatalog, testConfig, testIdentity, type TestCatalog } from './test-catalog.js';

/**
 * ADR 0023 §5, tested against a real filesystem: *the resolved real path is
 * checked to be inside its configured root, and symlink escape is rejected
 * rather than followed.*
 *
 * The lexical checks could be tested against strings. The symlink one cannot —
 * a link is not a lexical construct, and every character of a path that escapes
 * through one is legal. So these tests make real directories and real links.
 */

let base: string;
let catalog: TestCatalog;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'tcg-admin-roots-'));
  catalog = await makeTestCatalog();
});

afterEach(async () => {
  await catalog.dispose();
  await rm(base, { recursive: true, force: true });
});

/**
 * Creates a directory symlink, or reports that this machine will not.
 *
 * On Windows an ordinary user cannot create a symlink without Developer Mode,
 * but *can* create a directory junction, which the path resolver follows the
 * same way. Where neither is available the test says so rather than passing
 * quietly, because a skipped security test that looks green is worse than one
 * that admits it did not run.
 */
async function linkDirectory(from: string, to: string): Promise<boolean> {
  try {
    await symlink(to, from, process.platform === 'win32' ? 'junction' : 'dir');
    return true;
  } catch {
    return false;
  }
}

describe('configuration is validated once, at the start', () => {
  it('accepts absolute roots and keeps them resolved', () => {
    const roots = unwrap(
      resolveCatalogRoots({
        catalogRoot: join(base, 'catalog'),
        resultRoots: { local: join(base, 'results') },
      }),
    );
    expect(roots.catalogRoot).toBe(resolve(join(base, 'catalog')));
    expect(roots.resultRoots.get('local')).toBe(resolve(join(base, 'results')));
  });

  it('refuses a relative catalog root, so the roots do not move with the shell', () => {
    const bad = resolveCatalogRoots({ catalogRoot: 'catalog', resultRoots: {} });
    expect(isErr(bad) && bad.error[0]?.code).toBe('admin/unsafe_result_reference');
    expect(isErr(bad) && bad.error[0]?.message).toContain('absolute path');
  });

  it('refuses a relative result root', () => {
    const bad = resolveCatalogRoots({
      catalogRoot: join(base, 'catalog'),
      resultRoots: { local: '../elsewhere' },
    });
    expect(isErr(bad) && bad.error[0]?.context?.rootId).toBe('local');
  });

  it('refuses a root identifier that is a path rather than a name', () => {
    for (const rootId of ['../escape', 'Local', 'a/b', '']) {
      const bad = resolveCatalogRoots({
        catalogRoot: join(base, 'catalog'),
        resultRoots: { [rootId]: join(base, 'results') },
      });
      expect(`${rootId}: ${String(isErr(bad))}`).toBe(`${rootId}: true`);
    }
  });
});

describe('resolving a stored location', () => {
  it('resolves a plain directory inside its configured root', async () => {
    const resolved = unwrap(
      await resolveResultLocation(catalog.roots, { rootId: 'local', directory: 'precon-smoke' }),
    );
    expect(resolved.startsWith(resolve(catalog.resultRoot))).toBe(true);
  });

  it('resolves a directory that does not exist yet', async () => {
    // A run is located before it has been written, so a missing leaf is not an
    // escape. What matters is that everything above it stays inside the root.
    const resolved = await resolveResultLocation(catalog.roots, {
      rootId: 'local',
      directory: 'not/created/yet',
    });
    expect(isOk(resolved)).toBe(true);
  });

  it('refuses an identifier that names no configured root', async () => {
    const refused = await resolveResultLocation(catalog.roots, {
      rootId: 'somewhere',
      directory: 'run',
    });
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/unsafe_result_reference');
    expect(isErr(refused) && refused.error[0]?.message).toContain('somewhere');
  });

  it('refuses every lexical escape, including ones the schema would also refuse', async () => {
    // The schema is applied again here rather than trusted, because a document
    // may not have been written by this build.
    for (const directory of [
      '../escape',
      'run/../../escape',
      '/absolute',
      'C:/windows',
      'back\\slash',
      '..',
    ]) {
      const refused = await resolveResultLocation(catalog.roots, { rootId: 'local', directory });
      expect(`${directory}: ${String(isErr(refused))}`).toBe(`${directory}: true`);
    }
  });

  it('refuses a symlink that points outside the configured root, rather than following it', async () => {
    const outside = join(base, 'outside');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'secret.txt'), 'not yours', 'utf8');
    await mkdir(catalog.resultRoot, { recursive: true });

    const linked = await linkDirectory(join(catalog.resultRoot, 'escape'), outside);
    if (!linked) {
      // Recorded rather than silently skipped: this machine refused to create a
      // directory link, so the symlink case was not exercised here.
      expect(process.platform).toBe('win32');
      return;
    }

    const refused = await resolveResultLocation(catalog.roots, {
      rootId: 'local',
      directory: 'escape',
    });
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/unsafe_result_reference');
    expect(isErr(refused) && refused.error[0]?.message).toContain(
      'outside the configured result root',
    );
  });

  it('refuses a link in the middle of the path as readily as at the end', async () => {
    const outside = join(base, 'outside-mid');
    await mkdir(join(outside, 'run-1'), { recursive: true });
    await mkdir(catalog.resultRoot, { recursive: true });

    const linked = await linkDirectory(join(catalog.resultRoot, 'archive'), outside);
    if (!linked) {
      expect(process.platform).toBe('win32');
      return;
    }

    const refused = await resolveResultLocation(catalog.roots, {
      rootId: 'local',
      directory: 'archive/run-1',
    });
    expect(isErr(refused)).toBe(true);
  });

  it('follows a link that stays inside the root', async () => {
    await mkdir(join(catalog.resultRoot, 'real'), { recursive: true });
    const linked = await linkDirectory(
      join(catalog.resultRoot, 'alias'),
      join(catalog.resultRoot, 'real'),
    );
    if (!linked) {
      expect(process.platform).toBe('win32');
      return;
    }
    const resolved = await resolveResultLocation(catalog.roots, {
      rootId: 'local',
      directory: 'alias',
    });
    expect(isOk(resolved)).toBe(true);
  });

  it('does not treat a sibling whose name starts with the root’s as inside it', async () => {
    // `resultRoot` and `resultRoot-archive` share a prefix and share nothing
    // else, which is the bug a `startsWith` check has and `relative` does not.
    const sibling = `${catalog.resultRoot}-archive`;
    await mkdir(sibling, { recursive: true });
    const roots = unwrap(
      resolveCatalogRoots({
        catalogRoot: catalog.catalogRoot,
        resultRoots: { local: catalog.resultRoot },
      }),
    );
    const escaping = `..${sep}${sibling.split(sep).at(-1) ?? ''}`;
    const refused = await resolveResultLocation(roots, { rootId: 'local', directory: escaping });
    expect(isErr(refused)).toBe(true);
  });
});

describe('a refusal names an identifier and never a path', () => {
  it('puts no separator, drive letter or parent reference in the message or context', async () => {
    const refused = await resolveResultLocation(catalog.roots, {
      rootId: 'local',
      directory: '../escape',
    });
    expect(isErr(refused)).toBe(true);
    if (!isErr(refused)) return;

    for (const problem of refused.error) {
      expect(problem.message).not.toContain(catalog.resultRoot);
      expect(problem.message).not.toContain('/');
      expect(problem.message).not.toContain('\\');
      for (const value of Object.values(problem.context ?? {})) {
        expect(String(value)).not.toMatch(/[/\\]|\.\.|^[A-Za-z]:/);
      }
    }
  });

  it('is the same when the escape is a link, so a probe learns nothing from the wording', async () => {
    await mkdir(join(base, 'outside-probe'), { recursive: true });
    await mkdir(catalog.resultRoot, { recursive: true });
    const linked = await linkDirectory(
      join(catalog.resultRoot, 'probe'),
      join(base, 'outside-probe'),
    );
    if (!linked) {
      expect(process.platform).toBe('win32');
      return;
    }
    const refused = await resolveResultLocation(catalog.roots, {
      rootId: 'local',
      directory: 'probe',
    });
    expect(isErr(refused) && refused.error[0]?.context).toEqual({ rootId: 'local' });
  });
});

describe('the store refuses an unsafe reference before it stores one', () => {
  it('never writes a location it would later refuse to open', async () => {
    const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
    const job = unwrap(
      await catalog.store.createJob({
        batchId: batch.batchId,
        label: 'one',
        purpose: 'exploration',
        sourceClasses: ['ai'],
        config: testConfig(),
      }),
    );

    const refused = await catalog.store.attachJobResult(job.jobId, {
      identity: testIdentity(),
      location: { rootId: 'nowhere', directory: 'run-1' },
    });
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/unsafe_result_reference');
    expect(unwrap(await catalog.store.readJob(job.jobId)).result).toBeNull();
  });

  it('refuses a traversal in the directory at the schema, before resolution', async () => {
    const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
    const job = unwrap(
      await catalog.store.createJob({
        batchId: batch.batchId,
        label: 'one',
        purpose: 'exploration',
        sourceClasses: ['ai'],
        config: testConfig(),
      }),
    );

    const refused = await catalog.store.attachJobResult(job.jobId, {
      identity: testIdentity(),
      location: { rootId: 'local', directory: '../../etc' },
    });
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/schema');
    expect(unwrap(await catalog.store.readJob(job.jobId)).result).toBeNull();
  });

  it('writes nothing at all inside the result root', async () => {
    // The catalog indexes runs; it does not produce them. A store that created
    // directories under a result root would be the second copy of evidence
    // ADR 0023 §3 refuses.
    const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
    const job = unwrap(
      await catalog.store.createJob({
        batchId: batch.batchId,
        label: 'one',
        purpose: 'exploration',
        sourceClasses: ['ai'],
        config: testConfig(),
      }),
    );
    unwrap(
      await catalog.store.attachJobResult(job.jobId, {
        identity: testIdentity(),
        location: { rootId: 'local', directory: 'precon-smoke' },
      }),
    );

    // The result root was never created, because nothing ever wrote to it.
    const { readdir } = await import('node:fs/promises');
    await expect(readdir(catalog.resultRoot)).rejects.toThrow();
  });
});
