import { describe, expect, it } from 'vitest';

import {
  ADMIN_API_ROOT,
  ADMIN_API_VERSION_SEGMENT,
  ADMIN_ENDPOINTS,
  ADMIN_ENDPOINT_NAMES,
  ADMIN_PATH_PATTERN,
  ADMIN_ROUTES,
  adminEndpointPath,
  batchDetailSchema,
  capabilitiesSchema,
  endpointRequestsAreRegistered,
  jobDetailSchema,
  jobProgressSchema,
  presetCatalogSchema,
} from './service.js';
import { ADMIN_REQUEST_PAYLOAD_SCHEMAS } from './requests.js';
import { ADMIN_CONTRACT_VERSION } from './version.js';
import { PRESET_REGISTRY, AVAILABLE_PRESET_IDS } from './presets.js';
import { NO_ANNOTATIONS } from './catalog.js';

/**
 * The service interface, checked as a closed set rather than as thirteen
 * independent declarations.
 *
 * Every claim below is about the registry as a whole — every endpoint has both
 * schemas, every request shape is one the boundary scan already covers, no two
 * endpoints answer at one address, and the version in a path is the constant
 * rather than a copy of it. Those are the properties a router cannot be relied on
 * to preserve as endpoints are added.
 */

const CAPABILITIES = {
  versions: { contract: ADMIN_CONTRACT_VERSION, catalogDocument: 2, jobEvent: 1, savedChoice: 1 },
  access: { loopback: true, authenticationRequired: false },
  limits: {
    maxRequestBytes: 131_072,
    requestsPerWindow: 240,
    windowMs: 60_000,
    pageSizeDefault: 50,
    pageSizeMax: 200,
    maxFilterValues: 16,
    maxJobsPerBatch: 500,
  },
  orchestrator: { maxConcurrentJobs: 1, maxWorkers: 7, maxWorkersPerJob: 7 },
  resultRootIds: ['default'],
  formatId: 'precon_wave_1',
  startedAt: '2026-08-23T10:00:00.000Z',
};

describe('the endpoint registry', () => {
  it('names twenty-three endpoints, and every one of them has both schemas', () => {
    // Thirteen from M08.6, plus M08.8's four: the builder has to be told what
    // content exists, has to show an exact total *before* anything is enqueued,
    // and has to keep a filled-in form somewhere the browser is not. Plus
    // M08.9's three: an ordering can be changed, a job in a draft can be
    // duplicated, and a draft has to be released before anything runs. Plus
    // M08.10's two: a run's canonical documents can be listed, and one of them
    // can be downloaded unchanged. Plus M08.15's one: a finished Commander
    // Search can be turned into a scheduled finalist championship. Plus
    // M08.19C's two: a directory-keyed Adaptive Counter run's headline reading
    // and one of its result tables can be read without a catalog job.
    expect(ADMIN_ENDPOINT_NAMES).toHaveLength(25);
    for (const name of ADMIN_ENDPOINT_NAMES) {
      const spec = ADMIN_ENDPOINTS[name];
      expect(`${name}: request`).toBe(spec.request === undefined ? 'unset' : `${name}: request`);
      expect(`${name}: response`).toBe(spec.response === undefined ? 'unset' : `${name}: response`);
      expect(typeof spec.mutates).toBe('boolean');
    }
  });

  it('accepts only request shapes the payload registry enumerates', () => {
    // The property that makes `boundary.test.ts`'s "no request payload admits a
    // filesystem location" total. An endpoint with a private input schema would
    // be outside that proof entirely.
    expect(endpointRequestsAreRegistered()).toBe(true);
    const known = new Set<unknown>(Object.values(ADMIN_REQUEST_PAYLOAD_SCHEMAS));
    for (const name of ADMIN_ENDPOINT_NAMES) {
      expect(`${name}: ${String(known.has(ADMIN_ENDPOINTS[name].request))}`).toBe(`${name}: true`);
    }
  });

  it('gives each endpoint its own address', () => {
    expect(ADMIN_ROUTES.size).toBe(ADMIN_ENDPOINT_NAMES.length);
  });

  it('routes with an alphabet that cannot become a traversal', () => {
    for (const name of ADMIN_ENDPOINT_NAMES) {
      expect(`${name}: ${ADMIN_ENDPOINTS[name].route}`).toMatch(/^[a-zA-Z]+: [a-z][a-z-]*$/);
    }
  });

  it('marks exactly the nine endpoints that change durable state', () => {
    const mutating = ADMIN_ENDPOINT_NAMES.filter((name) => ADMIN_ENDPOINTS[name].mutates);
    expect([...mutating].sort()).toEqual([
      'createBatch',
      'duplicateJob',
      'enqueuePreset',
      'jobAction',
      'reorderBatch',
      'saveChoice',
      'scheduleChampionship',
      'setJobAnnotations',
      'startBatch',
    ]);
  });

  it('answers every ordering change with the whole batch detail (M08.9)', () => {
    // Not an acknowledgement, and not the one row that moved. Reordering,
    // duplicating and starting all change the ordering, and a client that
    // patched its own copy of it would be a second author of the order the
    // server holds. Answering with the batch and its members in the batch's own
    // order means the screen after any of the three renders the server's answer
    // rather than its own arithmetic.
    for (const name of ['reorderBatch', 'duplicateJob', 'startBatch'] as const) {
      expect(`${name}: ${String(ADMIN_ENDPOINTS[name].response === batchDetailSchema)}`).toBe(
        `${name}: true`,
      );
    }
  });

  it('leaves the estimate preview non-mutating, because expanding creates nothing', () => {
    // M08.6 declined a separate estimate endpoint partly because it could
    // disagree with what was created. It cannot create anything: expanding a
    // preset builds configurations in memory and writes no batch, no job and no
    // directory, which is what `mutates: false` is here to state where a rate
    // limiter and an audit line can read it.
    expect(ADMIN_ENDPOINTS.estimateChoice.mutates).toBe(false);
    expect(ADMIN_ENDPOINTS.content.mutates).toBe(false);
    expect(ADMIN_ENDPOINTS.listSavedChoices.mutates).toBe(false);
  });

  it('offers no endpoint that accepts an experiment configuration', () => {
    // M08's exclusion: no arbitrary output roots and no unvalidated JSON blobs.
    // A preset choice is the only way a job is created, and that is a fact about
    // the registry rather than about what a handler happens to do.
    const shapes = JSON.stringify(ADMIN_ENDPOINT_NAMES.map((name) => ADMIN_ENDPOINTS[name].route));
    expect(shapes).not.toContain('config');
    expect(shapes).not.toContain('run');
    expect(ADMIN_ENDPOINTS.enqueuePreset.request).toBe(ADMIN_REQUEST_PAYLOAD_SCHEMAS.enqueuePreset);
  });
});

describe('the address a client builds', () => {
  it('carries the contract version, derived rather than copied', () => {
    expect(ADMIN_API_VERSION_SEGMENT).toBe(`v${String(ADMIN_CONTRACT_VERSION)}`);
    expect(adminEndpointPath('capabilities')).toBe(
      `${ADMIN_API_ROOT}/v${String(ADMIN_CONTRACT_VERSION)}/capabilities`,
    );
  });

  it('is matched by the router pattern, and yields the version and the route', () => {
    for (const name of ADMIN_ENDPOINT_NAMES) {
      const match = ADMIN_PATH_PATTERN.exec(adminEndpointPath(name));
      expect(`${name}: ${String(match !== null)}`).toBe(`${name}: true`);
      expect(match?.[1]).toBe(String(ADMIN_CONTRACT_VERSION));
      expect(ADMIN_ROUTES.get(match?.[2] ?? '')).toBe(name);
    }
  });

  it('recognises another build’s version so the refusal can be a sentence', () => {
    // The whole reason the pattern captures a number rather than requiring this
    // build's: a client one version behind must be told *which* version it speaks
    // and that it should update, not handed a bare 404 that looks like a typo.
    const match = ADMIN_PATH_PATTERN.exec('/admin/v1/capabilities');
    expect(match?.[1]).toBe('1');
    expect(ADMIN_ROUTES.get(match?.[2] ?? '')).toBe('capabilities');
  });

  it('refuses an address that is not an admin endpoint shape at all', () => {
    for (const path of [
      '/admin/capabilities',
      '/admin/v1/../../etc/passwd',
      '/admin/v1/Capabilities',
      '/admin/v1/capabilities/extra',
      '/admin/vx/capabilities',
      '/other/v1/capabilities',
      '/admin/v1/',
    ]) {
      expect(`${path}: ${String(ADMIN_PATH_PATTERN.test(path))}`).toBe(`${path}: false`);
    }
  });
});

describe('the capabilities answer', () => {
  it('round-trips what an operator’s machine resolved to', () => {
    const parsed = capabilitiesSchema.parse(CAPABILITIES);
    expect(parsed.orchestrator.maxWorkers).toBe(7);
    expect(parsed.access.loopback).toBe(true);
  });

  it('refuses a pagination limit that is not this build’s', () => {
    // Reported as a literal rather than a number, because a client that trusted a
    // wrong `pageSizeMax` would build a request the server refuses. The value is
    // the contract's; the endpoint only says it.
    expect(
      capabilitiesSchema.safeParse({
        ...CAPABILITIES,
        limits: { ...CAPABILITIES.limits, pageSizeMax: 500 },
      }).success,
    ).toBe(false);
  });

  it('has nowhere to put a root directory or a token', () => {
    expect(
      capabilitiesSchema.safeParse({ ...CAPABILITIES, catalogRoot: 'D:/catalog' }).success,
    ).toBe(false);
    expect(capabilitiesSchema.safeParse({ ...CAPABILITIES, adminToken: 'secret' }).success).toBe(
      false,
    );
    expect(
      capabilitiesSchema.safeParse({ ...CAPABILITIES, resultRootIds: ['D:/results'] }).success,
    ).toBe(false);
  });

  it('requires at least one configured result root, because a lab with none can run nothing', () => {
    expect(capabilitiesSchema.safeParse({ ...CAPABILITIES, resultRootIds: [] }).success).toBe(
      false,
    );
  });
});

describe('the preset catalog answer', () => {
  it('carries the registry as it stands', () => {
    const parsed = presetCatalogSchema.parse({ presets: Object.values(PRESET_REGISTRY) });
    expect(parsed.presets).toHaveLength(Object.keys(PRESET_REGISTRY).length);
    expect(parsed.presets.filter((preset) => preset.status === 'available')).toHaveLength(
      AVAILABLE_PRESET_IDS.length,
    );
  });

  it('refuses an available preset that names no limitation', () => {
    expect(
      presetCatalogSchema.safeParse({
        presets: [{ ...PRESET_REGISTRY.precon_smoke, limitations: [] }],
      }).success,
    ).toBe(false);
  });
});

describe('a job detail', () => {
  const JOB = {
    jobId: 'job_abc123',
    batchId: 'batch_abc123',
    label: 'Precon Standard',
    status: 'queued' as const,
    purpose: 'exploration' as const,
    sourceClasses: ['ai' as const, 'precon' as const],
    timestamps: {
      createdAt: '2026-08-23T10:00:00.000Z',
      updatedAt: '2026-08-23T10:00:00.000Z',
      startedAt: null,
      completedAt: null,
    },
    annotations: NO_ANNOTATIONS,
    progress: {
      completedMatches: 0,
      scheduledMatches: null,
      scheduledIsBound: false,
      stage: null,
      elapsedMs: null,
    },
    spec: {
      experimentId: 'precon-standard',
      kind: 'batch' as const,
      seed: 'seed-1',
      configHash: 'abcdef12',
      configSchemaVersion: 1,
    },
    origin: { kind: 'preset' as const, presetId: 'precon_standard' as const, stageId: 'matches' },
    failure: null,
    execution: null,
    result: null,
  };

  it('carries the actions the server would allow, so a stale bundle cannot invent one', () => {
    const parsed = jobDetailSchema.parse({
      job: JOB,
      batchId: JOB.batchId,
      events: [],
      eventsTruncated: false,
      availableActions: ['cancel'],
    });
    expect(parsed.availableActions).toEqual(['cancel']);
  });

  it('refuses an action a request could never carry', () => {
    expect(
      jobDetailSchema.safeParse({
        job: JOB,
        batchId: JOB.batchId,
        events: [],
        eventsTruncated: false,
        availableActions: ['complete'],
      }).success,
    ).toBe(false);
  });

  it('says when it left history out rather than pretending it is all there', () => {
    const parsed = jobDetailSchema.parse({
      job: JOB,
      batchId: JOB.batchId,
      events: [],
      eventsTruncated: true,
      availableActions: [],
    });
    expect(parsed.eventsTruncated).toBe(true);
  });

  it('reports progress without the rest of the document', () => {
    const parsed = jobProgressSchema.parse({
      jobId: JOB.jobId,
      status: 'running',
      progress: {
        ...JOB.progress,
        completedMatches: 4,
        scheduledMatches: 16,
        scheduledIsBound: false,
      },
      inFlight: true,
      updatedAt: '2026-08-23T10:01:00.000Z',
    });
    expect(parsed.progress.completedMatches).toBe(4);
    expect(Object.keys(parsed)).toEqual(['jobId', 'status', 'progress', 'inFlight', 'updatedAt']);
  });

  it('requires a batch detail to list its jobs in the batch’s own order', () => {
    const batch = {
      batchId: 'batch_abc123',
      label: 'August sweep',
      status: 'draft' as const,
      timestamps: JOB.timestamps,
      annotations: NO_ANNOTATIONS,
      jobIds: ['job_abc123', 'job_def456'],
    };
    const second = { ...JOB, jobId: 'job_def456' };
    expect(batchDetailSchema.safeParse({ batch, jobs: [JOB, second] }).success).toBe(true);
    expect(batchDetailSchema.safeParse({ batch, jobs: [second, JOB] }).success).toBe(false);
    expect(batchDetailSchema.safeParse({ batch, jobs: [JOB] }).success).toBe(false);
  });
});
