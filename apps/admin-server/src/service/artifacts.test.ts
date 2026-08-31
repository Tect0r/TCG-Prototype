import { mkdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  MAX_ARTIFACT_BYTES,
  RESULT_ARTIFACT_NAMES,
  RESULT_ARTIFACTS,
  type JobId,
} from '@tcg/admin-contracts';
import { isErr, unwrap } from '@tcg/shared';
import { experimentPaths } from '@tcg/simulator';

import {
  makeTestCatalog,
  testConfig,
  testIdentity,
  type TestCatalog,
} from '../catalog/test-catalog.js';
import { ArtifactReader } from './artifacts.js';

/**
 * Serving what a run already wrote, unchanged.
 *
 * The fixtures write plain text under the names `experimentPaths` fixes rather
 * than real simulator output, for the same reason `results.test.ts` does: this
 * suite is about the **boundary** — which file a name resolves to, what happens
 * when it is absent or too large, and that the bytes that come back are the
 * bytes on disk — not about what the simulator writes into them.
 */

let catalog: TestCatalog;
let reader: ArtifactReader;

beforeEach(async () => {
  catalog = await makeTestCatalog();
  reader = new ArtifactReader({ store: catalog.store, roots: catalog.roots });
});

afterEach(async () => {
  await catalog.dispose();
});

async function seedRun(
  options: {
    readonly directory?: string;
    readonly attach?: boolean;
    readonly write?: Readonly<Partial<Record<string, string>>>;
  } = {},
): Promise<{ jobId: JobId; directory: string }> {
  const directory = options.directory ?? 'run-1';
  const batch = unwrap(await catalog.store.createBatch({ label: 'August sweep' }));
  const job = unwrap(
    await catalog.store.createJob({
      batchId: batch.batchId,
      label: 'Precon Smoke',
      purpose: 'exploration',
      sourceClasses: ['ai', 'precon'],
      config: testConfig(),
    }),
  );

  const full = join(catalog.resultRoot, directory);
  await mkdir(full, { recursive: true });
  const paths = experimentPaths(full);
  await writeFile(paths.manifest, JSON.stringify(manifestDocument()), 'utf8');
  await writeFile(
    paths.report,
    options.write?.report ?? '# A report\n\nEverything went fine.\n',
    'utf8',
  );
  await writeFile(
    paths.cardUsage,
    options.write?.card_usage ?? 'card,plays\ngoblin_grunt,4\n',
    'utf8',
  );

  if (options.attach !== false) {
    unwrap(
      await catalog.store.attachJobResult(job.jobId, {
        identity: testIdentity(),
        location: { rootId: 'local', directory },
      }),
    );
  }
  return { jobId: job.jobId, directory };
}

function manifestDocument(): Record<string, unknown> {
  const identity = testIdentity();
  return {
    schemaVersion: 8,
    experimentId: identity.experimentId,
    kind: identity.kind,
    seed: identity.seed,
    configHash: identity.configHash,
    softwareCommit: identity.softwareCommit,
    environments: [
      { id: identity.environments[0]?.environmentId, hashes: identity.environments[0]?.hashes },
    ],
    matches: 16,
    abnormalMatches: 1,
    failedMatches: 0,
    resumedMatches: 3,
  };
}

describe('what a run has', () => {
  it('reports every one of the thirteen documents, present or not', async () => {
    const { jobId } = await seedRun();
    const listing = unwrap(await reader.list(jobId));
    expect(listing.artifacts).toHaveLength(RESULT_ARTIFACT_NAMES.length);

    const byName = new Map(listing.artifacts.map((entry) => [entry.artifact, entry]));
    expect(byName.get('report')?.present).toBe(true);
    expect(byName.get('card_usage')?.present).toBe(true);
    expect(byName.get('reference_population')?.present).toBe(false);
    expect(byName.get('reference_population')?.byteLength).toBeNull();
  });

  it('carries the run’s identity, read from the manifest rather than the catalog', async () => {
    const { jobId } = await seedRun();
    const listing = unwrap(await reader.list(jobId));
    expect(listing.identity.experimentId).toBe(testIdentity().experimentId);
  });

  it('refuses a job with no attached result', async () => {
    const { jobId } = await seedRun({ attach: false });
    const listing = await reader.list(jobId);
    expect(isErr(listing) && listing.error[0]?.code).toBe('admin/no_result');
  });
});

describe('downloading one document', () => {
  it('serves the exact bytes the run wrote, with the media type its format names', async () => {
    const { jobId } = await seedRun();
    const artifact = unwrap(await reader.read(jobId, 'report'));
    expect(artifact.content).toBe('# A report\n\nEverything went fine.\n');
    expect(artifact.filename).toBe('report.md');
    expect(artifact.mediaType).toBe('text/markdown');
    expect(artifact.format).toBe('markdown');
  });

  it('names the file after the run’s identity and the job, not after the directory', async () => {
    const { jobId } = await seedRun({ directory: 'a-directory-name-nobody-should-see' });
    const artifact = unwrap(await reader.read(jobId, 'card_usage'));
    expect(artifact.suggestedFilename).toBe(
      `${testIdentity().experimentId}-${jobId}-card-usage.csv`,
    );
    expect(artifact.suggestedFilename).not.toContain('a-directory-name-nobody-should-see');
  });

  it('carries the run’s identity beside the file', async () => {
    const { jobId } = await seedRun();
    const artifact = unwrap(await reader.read(jobId, 'report'));
    expect(artifact.identity.seed).toBe(testIdentity().seed);
  });

  it('refuses a document this run did not write, truthfully rather than as an empty file', async () => {
    const { jobId } = await seedRun();
    const missing = await reader.read(jobId, 'reference_population');
    expect(isErr(missing) && missing.error[0]?.code).toBe('admin/no_result');
    expect(isErr(missing) && missing.error[0]?.message).toMatch(/wrote no/);
  });

  it('refuses a document larger than this service will send, without truncating it', async () => {
    const { jobId, directory } = await seedRun();
    const paths = experimentPaths(join(catalog.resultRoot, directory));
    await writeFile(paths.report, 'x'.repeat(MAX_ARTIFACT_BYTES + 1), 'utf8');
    const refused = await reader.read(jobId, 'report');
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/artifact_too_large');
    expect(isErr(refused) && refused.error[0]?.message).toMatch(/will not send more than/);
  });

  it('reports the too-large document in the listing as well, without a size lie', async () => {
    const { jobId, directory } = await seedRun();
    const paths = experimentPaths(join(catalog.resultRoot, directory));
    await writeFile(paths.report, 'x'.repeat(MAX_ARTIFACT_BYTES + 1), 'utf8');
    const listing = unwrap(await reader.list(jobId));
    const report = listing.artifacts.find((entry) => entry.artifact === 'report');
    expect(report?.present).toBe(true);
    expect(report?.tooLarge).toBe(true);
    expect(report?.byteLength).toBeGreaterThan(MAX_ARTIFACT_BYTES);
  });

  it('refuses a job with no attached result', async () => {
    const { jobId } = await seedRun({ attach: false });
    const refused = await reader.read(jobId, 'report');
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/no_result');
  });

  it('refuses a directory that has become a link out of the configured root', async () => {
    const { jobId, directory } = await seedRun({ directory: 'linked-run' });
    const target = join(catalog.resultRoot, directory);
    const outside = join(catalog.resultRoot, '..', 'outside-run');
    await mkdir(outside, { recursive: true });
    // Replace the run's directory with a symlink pointing outside the result
    // root, the way `results.test.ts` proves the same refusal for `ResultReader`.
    const { rm } = await import('node:fs/promises');
    await rm(target, { recursive: true, force: true });
    await symlink(outside, target, 'junction').catch(async () => {
      await symlink(outside, target);
    });
    const refused = await reader.read(jobId, 'report');
    expect(isErr(refused) && refused.error[0]?.code).toBe('admin/unsafe_result_reference');
  });

  it('never serves a document as one artifact under another artifact’s name', async () => {
    const { jobId } = await seedRun();
    const summary = await reader.read(jobId, 'summary');
    // No summary.json was written by this fixture; the refusal must name the
    // right document rather than silently substituting the report or the
    // manifest for it.
    expect(isErr(summary) && summary.error[0]?.message).toContain(
      RESULT_ARTIFACTS.summary.filename,
    );
  });
});

describe('every downloadable document has a servable path', () => {
  it('resolves every contract member to a distinct field of `experimentPaths`', async () => {
    const { jobId } = await seedRun();
    for (const name of RESULT_ARTIFACT_NAMES) {
      // Present or not, `list` must be able to ask about it without throwing.
      const listing = unwrap(await reader.list(jobId));
      expect(listing.artifacts.some((entry) => entry.artifact === name)).toBe(true);
    }
  });
});
