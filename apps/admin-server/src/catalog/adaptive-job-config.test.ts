import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { isErr, unwrap } from '@tcg/shared';
import { ADAPTIVE_CONFIG_SCHEMA_VERSION, adaptiveConfigHashOf, parseAdaptiveConfig } from '@tcg/simulator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { prepareAdaptiveJobConfig } from './adaptive-job-config.js';
import {
  makeTestCatalog,
  testAdaptiveConfig,
  testAdaptiveWorkloadEstimate,
  type TestCatalog,
} from './test-catalog.js';

/**
 * The Adaptive Counter counterpart to `job-config.test.ts` (M08.R3): a
 * configuration written down, read back, and proven to be the same run both
 * times, plus the four distinguishable ways a stored file can be refused.
 */

let catalog: TestCatalog;

beforeEach(async () => {
  catalog = await makeTestCatalog();
});

afterEach(async () => {
  await catalog.dispose();
});

const configPath = (jobId: string): string => join(catalog.catalogRoot, 'configs', `${jobId}.json`);

async function seedAdaptiveJob(): Promise<string> {
  const batch = unwrap(await catalog.store.createBatch({ label: 'Adaptive wave' }));
  const config = testAdaptiveConfig();
  const job = unwrap(
    await catalog.store.createAdaptiveJob({
      batchId: batch.batchId,
      label: 'Adaptive smoke',
      purpose: 'exploration',
      sourceClasses: ['ai', 'adaptive'],
      config,
      workloadEstimate: testAdaptiveWorkloadEstimate(config),
    }),
  );
  return job.jobId;
}

describe('the form a configuration is stored in', () => {
  it('round-trips to the same run, which is checked rather than hoped for', () => {
    const config = testAdaptiveConfig();
    const prepared = unwrap(prepareAdaptiveJobConfig(config, testAdaptiveWorkloadEstimate(config)));
    const reread = parseAdaptiveConfig(JSON.parse(JSON.stringify(prepared.stored)) as unknown);
    expect(adaptiveConfigHashOf(reread)).toBe(adaptiveConfigHashOf(config));
    expect(prepared.spec.configHash).toBe(adaptiveConfigHashOf(config));
  });

  it('records the simulator’s own configuration version rather than one of its own', () => {
    const config = testAdaptiveConfig();
    expect(
      unwrap(prepareAdaptiveJobConfig(config, testAdaptiveWorkloadEstimate(config))).spec
        .configSchemaVersion,
    ).toBe(ADAPTIVE_CONFIG_SCHEMA_VERSION);
  });

  it('carries the workload estimate it was priced at onto the spec', () => {
    const config = testAdaptiveConfig();
    const estimate = testAdaptiveWorkloadEstimate(config);
    const prepared = unwrap(prepareAdaptiveJobConfig(config, estimate));
    expect(prepared.spec.workloadEstimate).toEqual(estimate);
  });
});

describe('what the store writes and reads back', () => {
  it('writes one configuration file per job, named by the job', async () => {
    const jobId = await seedAdaptiveJob();
    const stored = JSON.parse(await readFile(configPath(jobId), 'utf8')) as Record<string, unknown>;
    expect(stored.id).toBe('fixture-adaptive');
    expect(stored.schemaVersion).toBe(ADAPTIVE_CONFIG_SCHEMA_VERSION);
  });

  it('hands back a configuration that hashes to the address on the job', async () => {
    const jobId = await seedAdaptiveJob();
    const job = unwrap(await catalog.store.readJob(jobId));
    const config = unwrap(await catalog.store.readAdaptiveJobConfig(jobId));
    if (job.spec.kind !== 'adaptive_counter') throw new Error('expected an adaptive job spec');
    expect(adaptiveConfigHashOf(config)).toBe(job.spec.configHash);
    expect(config.id).toBe(job.spec.experimentId);
    expect(config.seed).toBe(job.spec.seed);
  });

  it('reports a job with no stored configuration rather than inventing one', async () => {
    const read = await catalog.store.readAdaptiveJobConfig('job_absent00001');
    expect(isErr(read) && read.error[0]?.code).toBe('admin/unknown_job');
  });

  it('reports unreadable bytes as malformed rather than as a schema failure', async () => {
    const jobId = await seedAdaptiveJob();
    await writeFile(configPath(jobId), 'not json at all', 'utf8');
    const read = await catalog.store.readAdaptiveJobConfig(jobId);
    expect(isErr(read) && read.error[0]?.code).toBe('admin/malformed');
  });

  it('refuses a configuration from a newer build with the readable sentence', async () => {
    const jobId = await seedAdaptiveJob();
    const stored = JSON.parse(await readFile(configPath(jobId), 'utf8')) as Record<string, unknown>;
    await writeFile(
      configPath(jobId),
      JSON.stringify({ ...stored, schemaVersion: ADAPTIVE_CONFIG_SCHEMA_VERSION + 1 }),
      'utf8',
    );

    const read = await catalog.store.readAdaptiveJobConfig(jobId);
    expect(isErr(read) && read.error[0]?.code).toBe('admin/unsupported_version');
    expect(isErr(read) && read.error[0]?.message).toContain('written by a newer build');
    expect(isErr(read) && read.error[0]?.message).toContain('Update the application.');
  });

  it('reports a file that declares no readable version at all as missing one', async () => {
    const jobId = await seedAdaptiveJob();
    const stored = JSON.parse(await readFile(configPath(jobId), 'utf8')) as Record<string, unknown>;
    for (const version of [0.5, 'one', null]) {
      await writeFile(
        configPath(jobId),
        JSON.stringify({ ...stored, schemaVersion: version }),
        'utf8',
      );
      const read = await catalog.store.readAdaptiveJobConfig(jobId);
      expect(isErr(read) && read.error[0]?.code).toBe('admin/missing_version');
    }
  });

  it('reports a configuration the simulator refuses, in the simulator’s own words', async () => {
    const jobId = await seedAdaptiveJob();
    const stored = JSON.parse(await readFile(configPath(jobId), 'utf8')) as Record<string, unknown>;
    await writeFile(
      configPath(jobId),
      JSON.stringify({ ...stored, totalLearningBudget: -1 }),
      'utf8',
    );

    const read = await catalog.store.readAdaptiveJobConfig(jobId);
    expect(isErr(read) && read.error[0]?.code).toBe('admin/schema');
  });
});
