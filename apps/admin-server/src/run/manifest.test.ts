import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { looksLikeFilesystemPath } from '@tcg/admin-contracts';
import { isErr, unwrap } from '@tcg/shared';
import { experimentPaths } from '@tcg/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readRunIdentity } from './manifest.js';

/**
 * Turning a finished run's manifest into the identity a catalog entry references.
 *
 * The two halves pull in opposite directions on purpose: the manifest is read
 * **loosely**, because it is `@tcg/simulator`'s document and it grows, and the
 * identity is recorded **exactly**, because a reference that cannot be checked
 * against the run it names is not a reference.
 */

let root: string;
let directory: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'tcg-admin-manifest-'));
  directory = join(root, 'run');
  await mkdir(directory, { recursive: true });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const HASHES = {
  mechanicsHash: 'f869806562fe8799',
  pilotInputHash: 'bbf22a7a84cc6986',
  presentationHash: '6d47933fa4792e06',
  fullContentHash: '9056aa7d3be98971',
};

const MANIFEST = {
  schemaVersion: 8,
  experimentId: 'precon-smoke',
  kind: 'batch',
  seed: 'wave-1',
  configHash: '4cae6c16f2da5ea4',
  softwareCommit: 'a97c90a0a6e283a30cda3aad641ed739f0b9d1e2',
  environments: [{ id: 'precon_wave_1', label: 'Wave 1', hashes: HASHES, poolSize: 42 }],
};

async function writeManifest(value: unknown): Promise<void> {
  await writeFile(experimentPaths(directory).manifest, JSON.stringify(value), 'utf8');
}

describe('reading a run’s identity', () => {
  it('records exactly the identity fields, and no result', async () => {
    await writeManifest(MANIFEST);
    const identity = unwrap(await readRunIdentity(directory, { jobId: 'job_fixture1' }));
    expect(identity).toEqual({
      experimentId: 'precon-smoke',
      kind: 'batch',
      seed: 'wave-1',
      configHash: '4cae6c16f2da5ea4',
      environments: [{ environmentId: 'precon_wave_1', hashes: HASHES }],
      manifestSchemaVersion: 8,
      softwareCommit: 'a97c90a0a6e283a30cda3aad641ed739f0b9d1e2',
    });
  });

  it('records the manifest version rather than refusing an unfamiliar one', async () => {
    // M08.1's policy: *M08.10 has to tell a reader "this run was written by a
    // build whose manifests were version 8" before refusing or reading it.* The
    // number travels; the tranche that has to act on it decides.
    await writeManifest({ ...MANIFEST, schemaVersion: 99, aFieldFromTheFuture: true });
    const identity = unwrap(await readRunIdentity(directory, {}));
    expect(identity.manifestSchemaVersion).toBe(99);
  });

  it('keeps every environment a comparison run played in, in the manifest’s order', async () => {
    const second = { ...HASHES, fullContentHash: '1111111111111111' };
    await writeManifest({
      ...MANIFEST,
      kind: 'comparison',
      environments: [
        { id: 'baseline', hashes: HASHES },
        { id: 'candidate', hashes: second },
      ],
    });
    const identity = unwrap(await readRunIdentity(directory, {}));
    expect(identity.environments.map((environment) => environment.environmentId)).toEqual([
      'baseline',
      'candidate',
    ]);
  });

  it('accepts a run that could not detect a commit', async () => {
    await writeManifest({ ...MANIFEST, softwareCommit: null });
    expect(unwrap(await readRunIdentity(directory, {})).softwareCommit).toBeNull();
  });
});

describe('a manifest that cannot be indexed', () => {
  it('reports a run that wrote none as a failed run rather than an empty one', async () => {
    const refusal = await readRunIdentity(directory, { jobId: 'job_fixture1' });
    expect(isErr(refusal) && refusal.error[0]?.code).toBe('admin/run_failed');
    expect(isErr(refusal) && refusal.error[0]?.message).toContain('no manifest');
  });

  it('reports unreadable bytes as malformed', async () => {
    await writeFile(experimentPaths(directory).manifest, '{ not json', 'utf8');
    const refusal = await readRunIdentity(directory, {});
    expect(isErr(refusal) && refusal.error[0]?.code).toBe('admin/malformed');
  });

  it('refuses a manifest that carries no identity at all', async () => {
    await writeManifest({ schemaVersion: 8, notes: 'nothing useful here' });
    const refusal = await readRunIdentity(directory, {});
    expect(isErr(refusal) && refusal.error[0]?.code).toBe('admin/schema');
  });

  it('refuses an identity the catalog could not record honestly', async () => {
    // A hash that is not hexadecimal is not a hash this repository produced, and
    // half-recording it would leave a reference nothing can be checked against.
    await writeManifest({
      ...MANIFEST,
      environments: [{ id: 'precon_wave_1', hashes: { ...HASHES, fullContentHash: 'NOT-A-HASH' } }],
    });
    const refusal = await readRunIdentity(directory, {});
    expect(isErr(refusal) && refusal.error[0]?.code).toBe('admin/schema');
  });

  it('refuses a manifest with no environment, because a run played in one', async () => {
    await writeManifest({ ...MANIFEST, environments: [] });
    expect(isErr(await readRunIdentity(directory, {}))).toBe(true);
  });

  it('never names a location in a refusal', async () => {
    // ADR 0023 §5. The identifier an administrator configured is what they can
    // act on; the resolved path is neither useful to them nor safe to send.
    for (const broken of [null, '{ not json', JSON.stringify({ schemaVersion: 8 })]) {
      if (broken === null) await rm(experimentPaths(directory).manifest, { force: true });
      else await writeFile(experimentPaths(directory).manifest, broken, 'utf8');

      const refusal = await readRunIdentity(directory, { jobId: 'job_fixture1' });
      expect(isErr(refusal)).toBe(true);
      if (!isErr(refusal)) continue;
      for (const problem of refusal.error) {
        for (const token of problem.message.split(/\s+/)) {
          expect(`${token}: ${String(looksLikeFilesystemPath(token))}`).toBe(`${token}: false`);
        }
        for (const value of Object.values(problem.context ?? {})) {
          expect(looksLikeFilesystemPath(String(value))).toBe(false);
        }
      }
    }
  });
});
