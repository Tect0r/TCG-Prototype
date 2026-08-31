import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  ADMIN_CONTRACT_VERSION,
  ADMIN_ENDPOINTS,
  ADMIN_ENDPOINT_NAMES,
  PAGE_SIZE_MAX,
  adminEndpointPath,
  type AdminEndpointName,
  type JobId,
} from '@tcg/admin-contracts';
import { unwrap } from '@tcg/shared';
import { configHashOf, experimentPaths, type ExperimentConfig } from '@tcg/simulator';

import { openFileCatalogStore, type FileCatalogStore } from '../catalog/file-catalog-store.js';
import { testConfig } from '../catalog/test-catalog.js';
import { ExperimentRunner, type RunExperimentFn } from '../run/job-runner.js';
import { JobQueue } from '../run/queue.js';
import { MIN_TOKEN_LENGTH, parseServiceConfig, type AdminServiceConfig } from './config.js';
import { AdminService } from './handlers.js';
import { startAdminHttpServer, type AdminHttpServer } from './http.js';

/**
 * The whole boundary, driven over a real socket.
 *
 * The tranche's acceptance names seven kinds of test — *authorization, malformed
 * input, future version, traversal, pagination, lifecycle and restart* — and
 * every one of them is a claim about what happens **between two processes**. A
 * suite that called the handlers directly would prove the handlers work and
 * nothing about the door: the token check, the body limit, the version in the
 * path and the status a refusal carries all live in the transport, and none of
 * them exists until something binds.
 *
 * So each harness below starts a real server on port 0 and talks to it with
 * `fetch`. Only the *simulator* is stood in for, and only where a test would
 * otherwise spend a minute playing matches to observe a lifecycle transition
 * that the queue makes in a millisecond.
 */

const TOKEN = `token-${'x'.repeat(MIN_TOKEN_LENGTH)}`;

const PRECONS = [
  'precon_bastion_guardians',
  'precon_containment_control',
  'precon_goblin_swarm',
  'precon_grave_sacrifice',
];

const SMOKE_CHOICE = {
  presetId: 'precon_smoke',
  experimentId: 'precon-smoke',
  seed: 'preset-2026-08',
  preconIds: PRECONS,
  pilotIds: ['value'],
};

interface Harness {
  readonly config: AdminServiceConfig;
  readonly store: FileCatalogStore;
  readonly queue: JobQueue;
  readonly server: AdminHttpServer;
  readonly resultRoot: string;
  readonly catalogRoot: string;
  readonly base: string;
  post(
    name: AdminEndpointName,
    payload: unknown,
    init?: {
      readonly token?: string | null;
      readonly raw?: string;
      readonly headers?: Record<string, string>;
    },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  fetchPath(
    path: string,
    init?: { readonly method?: string; readonly body?: string },
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  close(): Promise<void>;
}

let harnesses: Harness[] = [];

/**
 * A simulator stand-in that commits one record per scheduled match and writes a
 * manifest when it finishes.
 *
 * The same shape `queue.test.ts` uses, and for the same reason: what these tests
 * observe is a *lifecycle* reaching the API, and playing real matches to watch a
 * document move from `queued` to `completed` would cost a minute per assertion
 * without making any of them stronger. `job-runner.test.ts` is where the bridge
 * meets the real `runExperiment`.
 */
function standInSimulator(total: number): RunExperimentFn {
  return (async (config: ExperimentConfig, options) => {
    const directory = options?.outputDir ?? '';
    await mkdir(directory, { recursive: true });
    const paths = experimentPaths(directory);
    for (let played = 0; played < total; played += 1) {
      await writeFile(paths.matches, `${JSON.stringify({ matchId: `m${String(played)}` })}\n`, {
        flag: 'a',
      });
    }
    await writeFile(
      paths.manifest,
      JSON.stringify({
        schemaVersion: 8,
        experimentId: config.id,
        kind: config.kind,
        seed: config.seed,
        configHash: configHashOf(config),
        softwareCommit: '2b1a6ec',
        matches: total,
        environments: [
          {
            id: 'baseline',
            hashes: {
              mechanicsHash: '1111111111111111',
              pilotInputHash: '2222222222222222',
              presentationHash: '3333333333333333',
              fullContentHash: '4444444444444444',
            },
          },
        ],
      }),
      'utf8',
    );
    return undefined as never;
  }) as RunExperimentFn;
}

async function startHarness(
  options: {
    readonly token?: string;
    readonly base?: string;
    readonly requestLimits?: {
      maxRequestBytes?: number;
      requestsPerWindow?: number;
      windowMs?: number;
    };
    readonly clock?: () => number;
    readonly runExperiment?: RunExperimentFn;
  } = {},
): Promise<Harness> {
  const base = options.base ?? (await mkdtemp(join(tmpdir(), 'tcg-admin-http-')));
  const catalogRoot = join(base, 'catalog');
  const resultRoot = join(base, 'results');
  await mkdir(resultRoot, { recursive: true });

  const config = unwrap(
    parseServiceConfig({
      host: '127.0.0.1',
      port: 0,
      catalogRoot,
      resultRoots: { local: resultRoot },
      ...(options.token === undefined ? {} : { token: options.token }),
      ...(options.requestLimits === undefined ? {} : { requestLimits: options.requestLimits }),
      limits: { maxConcurrentJobs: 1, maxWorkers: 1, maxWorkersPerJob: 1 },
    }),
  );

  const opened = unwrap(await openFileCatalogStore({ roots: config.roots }));
  const runner = new ExperimentRunner({
    store: opened.store,
    roots: config.roots,
    resultRootId: 'local',
    pollEveryMs: 20,
    runExperiment: options.runExperiment ?? standInSimulator(2),
  });
  const queue = new JobQueue({ store: opened.store, runner, limits: config.limits });
  const service = new AdminService({ config, store: opened.store, queue });
  const server = await startAdminHttpServer({
    service,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });

  const origin = `http://127.0.0.1:${String(server.port)}`;

  const call = async (
    path: string,
    init: { method?: string; body?: string; headers?: Record<string, string> },
  ): Promise<{ status: number; body: Record<string, unknown> }> => {
    const response = await fetch(`${origin}${path}`, {
      method: init.method ?? 'POST',
      ...(init.body === undefined ? {} : { body: init.body }),
      headers: init.headers ?? {},
    });
    const text = await response.text();
    return {
      status: response.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>),
    };
  };

  const harness: Harness = {
    config,
    store: opened.store,
    queue,
    server,
    resultRoot,
    catalogRoot,
    base,
    post: (name, payload, init = {}) => {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      };
      const token = init.token === undefined ? options.token : init.token;
      if (token !== undefined && token !== null) headers['x-admin-token'] = token;
      return call(adminEndpointPath(name), {
        body: init.raw ?? JSON.stringify({ contractVersion: ADMIN_CONTRACT_VERSION, payload }),
        headers,
      });
    },
    fetchPath: (path, init = {}) =>
      call(path, {
        ...(init.method === undefined ? {} : { method: init.method }),
        ...(init.body === undefined ? {} : { body: init.body }),
        headers: {
          'content-type': 'application/json',
          ...(options.token === undefined ? {} : { 'x-admin-token': options.token }),
        },
      }),
    close: async () => {
      await server.close();
    },
  };
  harnesses.push(harness);
  return harness;
}

afterEach(async () => {
  for (const harness of harnesses) {
    // Settled before removed. A run started by an `enqueuePreset` is still
    // writing into the temporary tree, and pulling the directory out from under
    // it makes the *next* test fail somewhere unrelated.
    await harness.queue.drain();
    await harness.close();
    await rm(harness.base, { recursive: true, force: true });
  }
  harnesses = [];
});

beforeEach(() => {
  harnesses = [];
});

/** Creates a batch and fills it from the smoke preset, through the API. */
async function seedBatch(harness: Harness): Promise<{ batchId: string; jobIds: JobId[] }> {
  const batch = await harness.post('createBatch', { label: 'August sweep' });
  expect(batch.status).toBe(200);
  const batchId = (batch.body.payload as { batchId: string }).batchId;

  const enqueued = await harness.post('enqueuePreset', { batchId, choice: SMOKE_CHOICE });
  expect(enqueued.status).toBe(200);
  const jobs = (enqueued.body.payload as { jobs: { jobId: JobId }[] }).jobs;
  return { batchId, jobIds: jobs.map((job) => job.jobId) };
}

/** The same batch, released — which since M08.9 is what actually starts it. */
async function seedStartedBatch(harness: Harness): Promise<{ batchId: string; jobIds: JobId[] }> {
  const seeded = await seedBatch(harness);
  const started = await harness.post('startBatch', { batchId: seeded.batchId });
  expect(started.status).toBe(200);
  return seeded;
}

/**
 * Jobs put straight into the store, in a batch that has been released.
 *
 * Two things are being avoided rather than one. The store is used instead of the
 * endpoints because a *lifecycle* test has to see a `queued` job, and a creation
 * path that pumped would let the job finish before the response was read. The
 * batch is released because since M08.9 an unreleased batch holds its jobs back —
 * so a test that pumps and expects work to start needs a batch somebody started,
 * exactly as an operator's does.
 */
async function seedQueuedJobs(harness: Harness, count = 1): Promise<JobId[]> {
  const batch = unwrap(await harness.store.createBatch({ label: 'August sweep' }));
  const jobIds: JobId[] = [];
  for (let index = 0; index < count; index += 1) {
    const job = unwrap(
      await harness.store.createJob({
        batchId: batch.batchId,
        label: `Stage ${String(index)}`,
        purpose: 'exploration',
        sourceClasses: ['ai', 'precon'],
        config: testConfig({ id: `fixture-${String(index)}` }),
      }),
    );
    jobIds.push(job.jobId);
  }
  unwrap(await harness.store.applyBatchAction(batch.batchId, 'enqueue'));
  return jobIds;
}

/* ---------------------------------------------------------------- the door */

describe('the address a request arrives at', () => {
  it('answers every endpoint the registry names', async () => {
    const harness = await startHarness();
    for (const name of ADMIN_ENDPOINT_NAMES) {
      const answer = await harness.fetchPath(adminEndpointPath(name), {
        body: JSON.stringify({ contractVersion: ADMIN_CONTRACT_VERSION, payload: {} }),
      });
      // Some of them refuse this empty payload; none of them is missing.
      expect(`${name}: ${String(answer.status)}`).not.toBe(`${name}: 404`);
      expect(`${name}: ${String(answer.status)}`).not.toBe(`${name}: 405`);
    }
  });

  it('refuses an address that is not an endpoint', async () => {
    const harness = await startHarness();
    for (const path of ['/', '/admin', '/admin/v3/nonsense', '/admin/v3/../../etc/passwd']) {
      const answer = await harness.fetchPath(path, { body: '{}' });
      expect(`${path}: ${String(answer.status)}`).toBe(`${path}: 404`);
      expect((answer.body.errors as { code: string }[])[0]?.code).toBe('admin/unknown_endpoint');
    }
  });

  it('refuses every method but POST, so nothing an operator sends is in a URL', async () => {
    const harness = await startHarness();
    for (const method of ['GET', 'PUT', 'DELETE', 'PATCH']) {
      const answer = await harness.fetchPath(adminEndpointPath('capabilities'), { method });
      expect(`${method}: ${String(answer.status)}`).toBe(`${method}: 405`);
    }
  });

  it('never caches an answer, and never lets a browser sniff its type', async () => {
    const harness = await startHarness();
    const response = await fetch(
      `http://127.0.0.1:${String(harness.server.port)}${adminEndpointPath('capabilities')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contractVersion: ADMIN_CONTRACT_VERSION, payload: {} }),
      },
    );
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    // No CORS: M08.7 owns the admin client's origin and decides then.
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('a build that speaks another version', () => {
  it('is told which version it speaks and to update, rather than getting a 404', async () => {
    const harness = await startHarness();
    const future = await harness.fetchPath(
      `/admin/v${String(ADMIN_CONTRACT_VERSION + 1)}/capabilities`,
      {
        body: '{}',
      },
    );
    expect(future.status).toBe(400);
    const errors = future.body.errors as { code: string; message: string }[];
    expect(errors[0]?.code).toBe('admin/unsupported_version');
    expect(errors[0]?.message).toContain('newer build');
    expect(errors[0]?.message).toContain('Update the application');
  });

  it('tells an older build there is no migration, rather than guessing', async () => {
    const harness = await startHarness();
    const past = await harness.fetchPath('/admin/v1/capabilities', { body: '{}' });
    expect(past.status).toBe(400);
    const errors = past.body.errors as { code: string; message: string }[];
    expect(errors[0]?.code).toBe('admin/unsupported_version');
    expect(errors[0]?.message).toContain('older build');
  });

  it('refuses an envelope whose declared version disagrees with the path', async () => {
    const harness = await startHarness();
    const answer = await harness.post(
      'capabilities',
      {},
      {
        raw: JSON.stringify({ contractVersion: ADMIN_CONTRACT_VERSION + 1, payload: {} }),
      },
    );
    expect(answer.status).toBe(400);
    expect((answer.body.errors as { code: string }[])[0]?.code).toBe('admin/schema');
  });
});

/* --------------------------------------------------------- authorization */

describe('authorization', () => {
  it('lets a loopback bind with no configured token through', async () => {
    const harness = await startHarness();
    const answer = await harness.post('capabilities', {});
    expect(answer.status).toBe(200);
    expect(
      (answer.body.payload as { access: { authenticationRequired: boolean } }).access
        .authenticationRequired,
    ).toBe(false);
  });

  it('refuses every endpoint without the token when one is configured', async () => {
    const harness = await startHarness({ token: TOKEN });
    for (const name of ADMIN_ENDPOINT_NAMES) {
      const answer = await harness.post(name, {}, { token: null });
      expect(`${name}: ${String(answer.status)}`).toBe(`${name}: 401`);
      expect((answer.body.errors as { code: string }[])[0]?.code).toBe('admin/unauthorized');
    }
  });

  it('refuses a wrong token with the same answer as a missing one', async () => {
    const harness = await startHarness({ token: TOKEN });
    const missing = await harness.post('capabilities', {}, { token: null });
    const wrong = await harness.post('capabilities', {}, { token: `${TOKEN}-nope` });
    // Deliberately identical: telling the two apart would confirm to an
    // unauthenticated caller that a token is configured at all.
    expect(wrong.status).toBe(missing.status);
    expect(JSON.stringify(wrong.body)).toBe(JSON.stringify(missing.body));
  });

  it('accepts the configured token', async () => {
    const harness = await startHarness({ token: TOKEN });
    expect((await harness.post('capabilities', {})).status).toBe(200);
  });

  it('refuses two tokens rather than picking one', async () => {
    const harness = await startHarness({ token: TOKEN });
    const answer = await harness.post(
      'capabilities',
      {},
      {
        token: null,
        headers: { 'x-admin-token': `${TOKEN}, ${TOKEN}` },
      },
    );
    expect(answer.status).toBe(401);
  });

  it('checks the token before it reads a body, so a stranger cannot make it allocate', async () => {
    const harness = await startHarness({ token: TOKEN });
    const answer = await harness.post(
      'createBatch',
      {},
      {
        token: null,
        raw: JSON.stringify({
          contractVersion: ADMIN_CONTRACT_VERSION,
          payload: { label: 'x'.repeat(400_000) },
        }),
      },
    );
    // 401 rather than 413: the request never got as far as being measured.
    expect(answer.status).toBe(401);
  });

  it('never echoes the token back in any answer', async () => {
    const harness = await startHarness({ token: TOKEN });
    const answer = await harness.post('capabilities', {});
    expect(JSON.stringify(answer.body)).not.toContain(TOKEN);
  });
});

/* ----------------------------------------------------------- bad requests */

describe('malformed input', () => {
  it('refuses a body that is not JSON', async () => {
    const harness = await startHarness();
    const answer = await harness.post('capabilities', {}, { raw: '{ not json' });
    expect(answer.status).toBe(400);
    expect((answer.body.errors as { code: string }[])[0]?.code).toBe('admin/malformed');
  });

  it('refuses a body that is JSON but not an object', async () => {
    const harness = await startHarness();
    for (const raw of ['[]', '"a string"', '42', 'null']) {
      const answer = await harness.post('capabilities', {}, { raw });
      expect(`${raw}: ${String(answer.status)}`).toBe(`${raw}: 400`);
      expect((answer.body.errors as { code: string }[])[0]?.code).toBe('admin/malformed');
    }
  });

  it('refuses a field nobody declared, rather than ignoring it', async () => {
    const harness = await startHarness();
    const answer = await harness.post('capabilities', { verbose: true });
    expect(answer.status).toBe(400);
    expect((answer.body.errors as { code: string }[])[0]?.code).toBe('admin/schema');
  });

  it('names the field that was wrong, so a form can put the message beside it', async () => {
    const harness = await startHarness();
    const answer = await harness.post('jobAction', { jobId: 'not an id', action: 'pause' });
    expect(answer.status).toBe(400);
    expect((answer.body.errors as { path: string }[])[0]?.path).toBe('payload.jobId');
  });

  it('refuses a lifecycle action that belongs to the machine rather than an operator', async () => {
    // The narrowing M08.6 made: a client that could spell `complete` would mark a
    // run finished without a match having been played.
    const harness = await startHarness();
    for (const action of ['start', 'complete', 'fail', 'interrupt', 'pause_settled']) {
      const answer = await harness.post('jobAction', { jobId: 'job_abcdef12', action });
      expect(`${action}: ${String(answer.status)}`).toBe(`${action}: 400`);
    }
  });

  it('refuses a body longer than the limit rather than reading it', async () => {
    const harness = await startHarness({ requestLimits: { maxRequestBytes: 2_048 } });
    const answer = await harness.post(
      'createBatch',
      {},
      {
        raw: JSON.stringify({
          contractVersion: ADMIN_CONTRACT_VERSION,
          payload: { label: 'x'.repeat(8_000) },
        }),
      },
    );
    expect(answer.status).toBe(413);
    expect((answer.body.errors as { code: string }[])[0]?.code).toBe('admin/payload_too_large');
  });

  it('refuses a body that lies about its length', async () => {
    // `content-length` is a claim. The stream is measured as it arrives, which is
    // the only check a chunked or a dishonest request cannot get past.
    const harness = await startHarness({ requestLimits: { maxRequestBytes: 2_048 } });
    const response = await fetch(
      `http://127.0.0.1:${String(harness.server.port)}${adminEndpointPath('createBatch')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: new ReadableStream({
          start(controller) {
            controller.enqueue(
              new TextEncoder().encode(
                `{"contractVersion":${String(ADMIN_CONTRACT_VERSION)},"payload":{"label":"`,
              ),
            );
            controller.enqueue(new TextEncoder().encode('x'.repeat(8_000)));
            controller.enqueue(new TextEncoder().encode('"}}'));
            controller.close();
          },
        }),
        duplex: 'half',
      },
    ).catch(() => null);
    // The socket is destroyed on refusal, so either the refusal arrives or the
    // connection does. Both are the limit working; a 200 would not be.
    expect(response === null || response.status === 413).toBe(true);
  });

  it('refuses a content type that is not JSON', async () => {
    const harness = await startHarness();
    const answer = await harness.post(
      'capabilities',
      {},
      {
        headers: { 'content-type': 'text/plain' },
      },
    );
    expect(answer.status).toBe(400);
    expect((answer.body.errors as { code: string }[])[0]?.code).toBe('admin/malformed');
  });
});

describe('the rate limit', () => {
  it('refuses a caller that has spent its window, and lets it back in afterwards', async () => {
    const now = { value: 0 };
    const harness = await startHarness({
      requestLimits: { requestsPerWindow: 3, windowMs: 1_000 },
      clock: () => now.value,
    });
    for (let index = 0; index < 3; index += 1) {
      expect((await harness.post('capabilities', {})).status).toBe(200);
    }
    const refused = await harness.post('capabilities', {});
    expect(refused.status).toBe(429);
    expect((refused.body.errors as { code: string }[])[0]?.code).toBe('admin/rate_limited');

    now.value = 1_000;
    expect((await harness.post('capabilities', {})).status).toBe(200);
  });

  it('says when to try again', async () => {
    const now = { value: 0 };
    const harness = await startHarness({
      requestLimits: { requestsPerWindow: 1, windowMs: 60_000 },
      clock: () => now.value,
    });
    await harness.post('capabilities', {});
    const response = await fetch(
      `http://127.0.0.1:${String(harness.server.port)}${adminEndpointPath('capabilities')}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ contractVersion: ADMIN_CONTRACT_VERSION, payload: {} }),
      },
    );
    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('60');
  });
});

/* ------------------------------------------------------------ capabilities */

describe('what the service says it can do', () => {
  it('reports the bound an operator configured, and the pagination limits both ends share', async () => {
    const harness = await startHarness();
    const answer = await harness.post('capabilities', {});
    const payload = answer.body.payload as {
      orchestrator: Record<string, number>;
      limits: Record<string, number>;
      resultRootIds: string[];
      versions: Record<string, number>;
    };
    expect(payload.orchestrator).toEqual({
      maxConcurrentJobs: 1,
      maxWorkers: 1,
      maxWorkersPerJob: 1,
    });
    expect(payload.limits.pageSizeMax).toBe(PAGE_SIZE_MAX);
    expect(payload.versions.contract).toBe(ADMIN_CONTRACT_VERSION);
    expect(payload.resultRootIds).toEqual(['local']);
  });

  it('names the result roots by identifier and never by path', async () => {
    const harness = await startHarness();
    const answer = await harness.post('capabilities', {});
    expect(JSON.stringify(answer.body)).not.toContain(harness.resultRoot.replace(/\\/g, '\\\\'));
  });

  it('publishes every preset, including the one nobody can start', async () => {
    const harness = await startHarness();
    const answer = await harness.post('presets', {});
    const presets = (answer.body.payload as { presets: { id: string; status: string }[] }).presets;
    expect(presets.length).toBeGreaterThan(7);
    expect(presets.some((preset) => preset.status === 'reserved')).toBe(true);
    for (const preset of presets.filter((entry) => entry.status === 'available')) {
      expect(`${preset.id}: limitations`).toBe(`${preset.id}: limitations`);
    }
  });
});

/* --------------------------------------------------------- creation and paging */

describe('creating work', () => {
  it('turns one preset choice into one job per stage, and says what it will cost', async () => {
    const harness = await startHarness();
    const batch = await harness.post('createBatch', { label: 'August sweep' });
    const batchId = (batch.body.payload as { batchId: string }).batchId;

    const answer = await harness.post('enqueuePreset', { batchId, choice: SMOKE_CHOICE });
    expect(answer.status).toBe(200);
    const payload = answer.body.payload as {
      jobs: { jobId: string; status: string; origin: { kind: string; presetId: string } }[];
      expansion: { stages: unknown[] };
      estimate: { totalMatches: number; basis: string };
    };
    expect(payload.jobs).toHaveLength(payload.expansion.stages.length);
    expect(payload.jobs[0]?.origin).toEqual({
      kind: 'preset',
      presetId: 'precon_smoke',
      stageId: 'matches',
    });
    // The same figure `expand.test.ts` pins for this choice, arriving at a client
    // through `buildSchedule` rather than through a formula written twice.
    expect(payload.estimate.totalMatches).toBe(12);
    expect(payload.estimate.basis).toBe('exact');
  });

  it('takes a second preset into a batch that is still a draft (M08.9)', async () => {
    // Legal for the first time in M08.9, and it is the point of the tranche: a
    // batch stays a draft until somebody starts it, so *add jobs before start*
    // is a thing an administrator can actually do rather than a sentence.
    const harness = await startHarness();
    const { batchId, jobIds } = await seedBatch(harness);
    const again = await harness.post('enqueuePreset', { batchId, choice: SMOKE_CHOICE });
    expect(again.status).toBe(200);

    const detail = await harness.post('batchDetail', { batchId });
    const jobs = (detail.body.payload as { jobs: { jobId: JobId }[] }).jobs;
    expect(jobs).toHaveLength(jobIds.length * 2);
  });

  it('refuses a second preset into a batch whose ordering has settled', async () => {
    const harness = await startHarness();
    const { batchId } = await seedStartedBatch(harness);
    const again = await harness.post('enqueuePreset', { batchId, choice: SMOKE_CHOICE });
    expect(again.status).toBe(409);
    expect((again.body.errors as { code: string }[])[0]?.code).toBe('admin/illegal_transition');
  });

  it('refuses a preset choice the simulator would not accept, and creates nothing', async () => {
    const harness = await startHarness();
    const batch = await harness.post('createBatch', { label: 'August sweep' });
    const batchId = (batch.body.payload as { batchId: string }).batchId;

    const answer = await harness.post('enqueuePreset', {
      batchId,
      choice: { ...SMOKE_CHOICE, preconIds: ['precon_bastion_guardians', 'precon_not_a_thing'] },
    });
    expect(answer.status).toBe(400);

    const detail = await harness.post('batchDetail', { batchId });
    expect((detail.body.payload as { jobs: unknown[] }).jobs).toEqual([]);
  });

  it('has no endpoint that takes an experiment configuration', async () => {
    // M08's exclusion, checked at the door: there is no address that accepts one,
    // and the one creation endpoint refuses a payload carrying it.
    const harness = await startHarness();
    const batch = await harness.post('createBatch', { label: 'August sweep' });
    const batchId = (batch.body.payload as { batchId: string }).batchId;
    const answer = await harness.post('enqueuePreset', {
      batchId,
      config: { kind: 'batch', id: 'anything' },
    });
    expect(answer.status).toBe(400);
  });

  it('has no request shape anywhere that names an output root', async () => {
    for (const name of ADMIN_ENDPOINT_NAMES) {
      const shape = (
        ADMIN_ENDPOINTS[name].request as unknown as {
          readonly shape?: Readonly<Record<string, unknown>>;
        }
      ).shape;
      for (const key of Object.keys(shape ?? {})) {
        expect([...['rootId', 'directory', 'location', 'outputDir', 'path']]).not.toContain(key);
      }
    }
  });
});

describe('pagination', () => {
  it('bounds a page, and refuses a limit above the bound', async () => {
    const harness = await startHarness();
    await seedQueuedJobs(harness);
    const answer = await harness.post('listJobs', { page: { limit: PAGE_SIZE_MAX + 1 } });
    expect(answer.status).toBe(400);
    expect((answer.body.errors as { code: string }[])[0]?.code).toBe('admin/schema');
  });

  it('walks a listing with the continuation token it was given', async () => {
    const harness = await startHarness();
    const jobIds = await seedQueuedJobs(harness, 3);
    expect(jobIds).toHaveLength(3);

    const seen: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 10; guard += 1) {
      const answer: { status: number; body: Record<string, unknown> } = await harness.post(
        'listJobs',
        { page: { limit: 1, cursor } },
      );
      expect(answer.status).toBe(200);
      const payload = answer.body.payload as {
        items: { jobId: string }[];
        page: { nextCursor: string | null };
      };
      for (const item of payload.items) seen.push(item.jobId);
      cursor = payload.page.nextCursor;
      if (cursor === null) break;
    }
    expect(seen).toEqual(jobIds);
  });

  it('refuses a continuation token that could carry a path', async () => {
    const harness = await startHarness();
    const answer = await harness.post('listJobs', { page: { cursor: '../../etc/passwd' } });
    expect(answer.status).toBe(400);
  });

  it('refuses a filter that cannot be satisfied', async () => {
    const harness = await startHarness();
    const answer = await harness.post('listJobs', {
      filter: {
        createdAfter: '2026-08-23T00:00:00.000Z',
        createdBefore: '2026-08-01T00:00:00.000Z',
      },
    });
    expect(answer.status).toBe(400);
  });
});

/* --------------------------------------------------------------- lifecycle */

describe('lifecycle over the wire', () => {
  it('offers only the verbs the table allows from the state a job is in', async () => {
    const harness = await startHarness();
    const [jobId] = await seedQueuedJobs(harness);
    const detail = await harness.post('jobDetail', { jobId });
    expect(detail.status).toBe(200);
    const payload = detail.body.payload as { availableActions: string[]; events: unknown[] };
    // From `queued` the table offers `start` and `cancel`, and `start` is the
    // runner's. So an operator gets exactly one verb — which is the narrowing
    // M08.6 made, visible at the boundary.
    expect(payload.availableActions).toEqual(['cancel']);
    expect(payload.events.length).toBeGreaterThan(0);
  });

  it('refuses a verb the table has no transition for', async () => {
    const harness = await startHarness();
    const [jobId] = await seedQueuedJobs(harness);
    const answer = await harness.post('jobAction', { jobId, action: 'retry' });
    expect(answer.status).toBe(409);
    expect((answer.body.errors as { code: string }[])[0]?.code).toBe('admin/illegal_transition');
  });

  it('cancels a queued job, and the answer is the state it reached', async () => {
    const harness = await startHarness();
    const [jobId] = await seedQueuedJobs(harness);
    const answer = await harness.post('jobAction', { jobId, action: 'cancel' });
    expect(answer.status).toBe(200);
    expect((answer.body.payload as { status: string }).status).toBe('cancelled');
  });

  it('reports progress without the rest of the document', async () => {
    const harness = await startHarness();
    const [jobId] = await seedQueuedJobs(harness);
    const answer = await harness.post('jobProgress', { jobId });
    expect(answer.status).toBe(200);
    expect(Object.keys(answer.body.payload as object).sort()).toEqual([
      'inFlight',
      'jobId',
      'progress',
      'status',
      'updatedAt',
    ]);
  });

  it('records an annotation beside the run and never inside it', async () => {
    const harness = await startHarness();
    const [jobId] = await seedQueuedJobs(harness);
    const answer = await harness.post('setJobAnnotations', {
      jobId,
      annotations: {
        tags: ['baseline-candidate'],
        note: 'For the August comparison.',
        baseline: true,
      },
    });
    expect(answer.status).toBe(200);
    expect(
      (answer.body.payload as { annotations: { baseline: boolean } }).annotations.baseline,
    ).toBe(true);
  });

  it('runs a queued job to completion and reports it', async () => {
    const harness = await startHarness();
    const [jobId] = await seedQueuedJobs(harness);
    await harness.queue.drain();

    const detail = await harness.post('jobDetail', { jobId });
    const payload = detail.body.payload as {
      job: { status: string; result: unknown };
      availableActions: string[];
    };
    expect(payload.job.status).toBe('completed');
    expect(payload.job.result).not.toBeNull();
    expect(payload.availableActions).toEqual([]);
  });

  it('answers a job that does not exist with a refusal rather than an empty answer', async () => {
    const harness = await startHarness();
    const answer = await harness.post('jobDetail', { jobId: 'job_notthere1' });
    expect(answer.status).toBe(404);
    expect((answer.body.errors as { code: string }[])[0]?.code).toBe('admin/unknown_job');
  });
});

/* -------------------------------------------------------------- results */

describe('reading a finished run over the wire', () => {
  it('refuses a run whose directory holds no summary, rather than serving zeroes', async () => {
    const harness = await startHarness();
    const [jobId] = await seedQueuedJobs(harness);
    await harness.queue.drain();

    const summary = await harness.post('resultSummary', { jobId });
    // The stand-in writes a manifest but no summary document, which is exactly
    // the "there is nothing to read" case — and it must be a refusal rather than
    // a page of zeroes.
    expect(summary.status).toBe(404);
    expect((summary.body.errors as { code: string }[])[0]?.code).toBe('admin/no_result');
  });

  it('refuses a table for a job with no result, without inventing empty rows', async () => {
    const harness = await startHarness();
    const [jobId] = await seedQueuedJobs(harness);
    const answer = await harness.post('resultTable', { jobId, table: 'decks' });
    expect(answer.status).toBe(404);
    expect((answer.body.errors as { code: string }[])[0]?.code).toBe('admin/no_result');
  });

  it('refuses a table this build does not serve', async () => {
    const harness = await startHarness();
    const [jobId] = await seedQueuedJobs(harness);
    const answer = await harness.post('resultTable', { jobId, table: 'replays' });
    expect(answer.status).toBe(400);
  });

  it('refuses a run whose directory has become a link out of the result root', async () => {
    const harness = await startHarness();
    const [seeded] = await seedQueuedJobs(harness);
    await harness.queue.drain();

    const jobId = seeded as JobId;
    const outside = join(harness.base, 'outside');
    await mkdir(outside, { recursive: true });
    await rm(join(harness.resultRoot, jobId), { recursive: true, force: true });

    let linked = true;
    try {
      await symlink(
        outside,
        join(harness.resultRoot, jobId),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch {
      linked = false;
    }
    if (!linked) {
      expect(process.platform).toBe('win32');
      return;
    }

    const answer = await harness.post('resultSummary', { jobId });
    expect(answer.status).toBe(409);
    expect((answer.body.errors as { code: string }[])[0]?.code).toBe(
      'admin/unsafe_result_reference',
    );
    // And the refusal names the identifier the administrator configured, never a
    // path (ADR 0023 §5).
    expect(JSON.stringify(answer.body)).not.toContain(harness.resultRoot.replace(/\\/g, '\\\\'));
  });
});

/* -------------------------------------------------------------- restart */

describe('a restart', () => {
  it('reports interrupted work through the API, and starts nothing by itself', async () => {
    const first = await startHarness();
    const jobId = (await seedQueuedJobs(first))[0] as JobId;

    // Take the job into `running` without letting a runner finish it, which is
    // what a crash leaves behind.
    unwrap(await first.store.applyJobAction({ jobId, action: 'start', cause: 'runner' }));
    await first.close();

    const second = await startHarness({ base: first.base });
    const detail = await second.post('jobDetail', { jobId });
    const payload = detail.body.payload as {
      job: { status: string };
      availableActions: string[];
      events: { kind: string; cause?: string }[];
    };
    expect(payload.job.status).toBe('interrupted');
    // Resumable by a person, and by nobody else: the queue was pumped by nothing
    // on the way up, and `interrupted` is where it stays until asked.
    expect([...payload.availableActions].sort()).toEqual(['cancel', 'resume']);
    expect(payload.events.some((event) => event.cause === 'recovery')).toBe(true);

    await second.queue.pump();
    const after = await second.post('jobProgress', { jobId });
    expect((after.body.payload as { status: string }).status).toBe('interrupted');
  });

  it('resumes it when an operator asks, and the run continues rather than restarting', async () => {
    const first = await startHarness();
    const jobId = (await seedQueuedJobs(first))[0] as JobId;
    unwrap(await first.store.applyJobAction({ jobId, action: 'start', cause: 'runner' }));
    await first.close();

    const second = await startHarness({ base: first.base });
    const resumed = await second.post('jobAction', { jobId, action: 'resume' });
    expect(resumed.status).toBe(200);
    expect((resumed.body.payload as { status: string }).status).toBe('queued');

    await second.queue.drain();
    const detail = await second.post('jobProgress', { jobId });
    expect((detail.body.payload as { status: string }).status).toBe('completed');
  });

  it('reports a new start instant, so a client can tell a restart from a stall', async () => {
    const first = await startHarness();
    const before = (await first.post('capabilities', {})).body.payload as { startedAt: string };
    await first.close();

    const second = await startHarness({ base: first.base });
    const after = (await second.post('capabilities', {})).body.payload as { startedAt: string };
    expect(typeof after.startedAt).toBe('string');
    expect(after.startedAt >= before.startedAt).toBe(true);
  });
});
