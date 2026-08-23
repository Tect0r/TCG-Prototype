import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isErr, unwrap } from '@tcg/shared';
import { CONFIG_SCHEMA_VERSION, configHashOf, parseExperimentConfig } from '@tcg/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareJobConfig, storableForm } from './job-config.js';

/**
 * A pilot spec's override map, named structurally.
 *
 * `PilotSpec` is `@tcg/bot-interface`'s and the simulator does not re-export it,
 * which is the dependency boundary working: this workspace has no business
 * importing the pilot registry, and what it needs to look at here is one field.
 */
type WeightsOf = { readonly weights: Readonly<Record<string, number>> };
import { makeTestCatalog, testConfig, type TestCatalog } from './test-catalog.js';

/**
 * The configuration a job holds: written down, read back, and proven to be the
 * same run both times.
 *
 * The suite is longer than the module because the module exists to survive a
 * measured defect rather than to do something complicated, and the measurement
 * is the part worth keeping: `parseExperimentConfig` is **not idempotent**, so a
 * bridge that persisted a parsed configuration and re-parsed it would quietly
 * change how the run's pilots fly.
 */

let catalog: TestCatalog;

beforeEach(async () => {
  catalog = await makeTestCatalog();
});

afterEach(async () => {
  await catalog.dispose();
});

const configPath = (jobId: string): string => join(catalog.catalogRoot, 'configs', `${jobId}.json`);

async function seedJob(): Promise<string> {
  const batch = unwrap(await catalog.store.createBatch({ label: 'Wave 1' }));
  const job = unwrap(
    await catalog.store.createJob({
      batchId: batch.batchId,
      label: 'Precon smoke',
      purpose: 'exploration',
      sourceClasses: ['ai', 'precon'],
      config: testConfig(),
    }),
  );
  return job.jobId;
}

describe('the defect this module is built around, measured rather than assumed', () => {
  it('shows that a parsed configuration is not what re-parsing it produces', async () => {
    const config = testConfig();
    const naive = parseExperimentConfig(JSON.parse(JSON.stringify(config)) as unknown);
    expect(configHashOf(naive)).not.toBe(configHashOf(config));
  });

  it('shows the consequence is how the pilot flies, not merely a hash', () => {
    // `weights` absent short-circuits to the literal `{}`; `weights: {}`
    // *present* is run through `.partial()`, whose per-field defaults all apply.
    // `createAggressivePilot` merges its argument over `AGGRESSIVE_WEIGHTS`, so
    // a complete generic vector there replaces every published entry — the
    // aggressive pilot stops being aggressive.
    const once = testConfig();
    const twice = parseExperimentConfig(JSON.parse(JSON.stringify(once)) as unknown);
    expect(Object.keys((once.pilots[0] as WeightsOf).weights)).toEqual([]);
    expect(Object.keys((twice.pilots[0] as WeightsOf).weights).length).toBeGreaterThan(10);
  });
});

describe('the form a configuration is stored in', () => {
  it('is the shape a hand-authored file states, with no empty override blocks', () => {
    const stored = storableForm(testConfig()) as { readonly pilots: readonly unknown[] };
    expect(stored.pilots).toEqual([{ id: 'aggressive' }]);
    expect(JSON.stringify(stored)).not.toContain('"weights":{}');
    expect(JSON.stringify(stored)).not.toContain('"randomConfig":{}');
  });

  it('leaves everything that is not an empty object exactly where it was', () => {
    expect(
      storableForm({
        kept: 0,
        also: '',
        andThis: false,
        arrays: [{}, { a: 1 }],
        nested: { dropped: {}, kept: { a: 1 } },
        nulls: null,
      }),
    ).toEqual({
      kept: 0,
      also: '',
      andThis: false,
      arrays: [{}, { a: 1 }],
      nested: { kept: { a: 1 } },
      nulls: null,
    });
  });

  it('round-trips to the same run, which is checked rather than hoped for', () => {
    const config = testConfig();
    const prepared = unwrap(prepareJobConfig(config));
    const reread = parseExperimentConfig(JSON.parse(JSON.stringify(prepared.stored)) as unknown);
    expect(configHashOf(reread)).toBe(configHashOf(config));
    expect(prepared.spec.configHash).toBe(configHashOf(config));
  });

  it('records the simulator’s own configuration version rather than one of its own', () => {
    expect(unwrap(prepareJobConfig(testConfig())).spec.configSchemaVersion).toBe(
      CONFIG_SCHEMA_VERSION,
    );
  });
});

describe('what the store writes and reads back', () => {
  it('writes one configuration file per job, named by the job', async () => {
    const jobId = await seedJob();
    const stored = JSON.parse(await readFile(configPath(jobId), 'utf8')) as Record<string, unknown>;
    expect(stored.id).toBe('fixture-batch');
    expect(stored.schemaVersion).toBe(CONFIG_SCHEMA_VERSION);
  });

  it('hands back a configuration that hashes to the address on the job', async () => {
    const jobId = await seedJob();
    const job = unwrap(await catalog.store.readJob(jobId));
    const config = unwrap(await catalog.store.readJobConfig(jobId));
    expect(configHashOf(config)).toBe(job.spec.configHash);
    expect(config.id).toBe(job.spec.experimentId);
    expect(config.kind).toBe(job.spec.kind);
    expect(config.seed).toBe(job.spec.seed);
  });

  it('reports a job with no stored configuration rather than inventing one', async () => {
    const read = await catalog.store.readJobConfig('job_absent00001');
    expect(isErr(read) && read.error[0]?.code).toBe('admin/unknown_job');
  });

  it('refuses an identifier that is not one, without touching the filesystem', async () => {
    const read = await catalog.store.readJobConfig('job_UPPER');
    expect(isErr(read) && read.error[0]?.code).toBe('admin/unknown_job');
  });

  it('reports unreadable bytes as malformed rather than as a schema failure', async () => {
    const jobId = await seedJob();
    await writeFile(configPath(jobId), 'not json at all', 'utf8');
    const read = await catalog.store.readJobConfig(jobId);
    expect(isErr(read) && read.error[0]?.code).toBe('admin/malformed');
  });

  it('refuses a configuration from a newer build with the readable sentence', async () => {
    const jobId = await seedJob();
    const stored = JSON.parse(await readFile(configPath(jobId), 'utf8')) as Record<string, unknown>;
    await writeFile(
      configPath(jobId),
      JSON.stringify({ ...stored, schemaVersion: CONFIG_SCHEMA_VERSION + 1 }),
      'utf8',
    );

    const read = await catalog.store.readJobConfig(jobId);
    expect(isErr(read) && read.error[0]?.code).toBe('admin/unsupported_version');
    expect(isErr(read) && read.error[0]?.message).toContain('written by a newer build');
    expect(isErr(read) && read.error[0]?.message).toContain('experiment configuration');
  });

  it('reports a file that declares no readable version at all as missing one', async () => {
    // There is no *older* configuration version to test against, because
    // `CONFIG_SCHEMA_VERSION` has only ever been 1. What can happen today is a
    // file with no readable version, and that is a different refusal from either
    // of the build ones.
    const jobId = await seedJob();
    const stored = JSON.parse(await readFile(configPath(jobId), 'utf8')) as Record<string, unknown>;
    for (const version of [0.5, 'one', null]) {
      await writeFile(
        configPath(jobId),
        JSON.stringify({ ...stored, schemaVersion: version }),
        'utf8',
      );
      const read = await catalog.store.readJobConfig(jobId);
      expect(isErr(read) && read.error[0]?.code).toBe('admin/missing_version');
    }
  });

  it('reports a configuration the simulator refuses, in the simulator’s own words', async () => {
    const jobId = await seedJob();
    const stored = JSON.parse(await readFile(configPath(jobId), 'utf8')) as Record<string, unknown>;
    await writeFile(
      configPath(jobId),
      JSON.stringify({ ...stored, pilots: [{ id: 'not_a_pilot' }] }),
      'utf8',
    );

    const read = await catalog.store.readJobConfig(jobId);
    expect(isErr(read) && read.error[0]?.code).toBe('admin/schema');
  });
});
