import { describe, expect, it } from 'vitest';
import type { z } from 'zod';

import { NO_ANNOTATIONS } from './catalog.js';
import { NO_CATALOG_FILTER } from './filters.js';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from './pagination.js';
import {
  ADMIN_REQUEST_PAYLOAD_NAMES,
  ADMIN_REQUEST_PAYLOAD_SCHEMAS,
  adminRequest,
  adminResponse,
  batchRefSchema,
  jobActionRequestSchema,
  jobPageSchema,
  jobRefSchema,
  listBatchesRequestSchema,
  listJobsRequestSchema,
  setJobAnnotationsRequestSchema,
} from './requests.js';
import { ADMIN_CONTRACT_VERSION, refuseFutureVersion } from './version.js';

const envelope = adminRequest(listJobsRequestSchema);

describe('the request envelope owns the contract version', () => {
  it('round-trips a current request through JSON', () => {
    const request = {
      contractVersion: ADMIN_CONTRACT_VERSION,
      payload: listJobsRequestSchema.parse({}),
    };
    expect(envelope.parse(JSON.parse(JSON.stringify(request)))).toEqual(request);
  });

  it('refuses a version from a newer build at the schema', () => {
    expect(
      envelope.safeParse({
        contractVersion: ADMIN_CONTRACT_VERSION + 1,
        payload: listJobsRequestSchema.parse({}),
      }).success,
    ).toBe(false);
  });

  it('turns that refusal into the readable sentence, not a parse failure', () => {
    // The schema says no; `refuseFutureVersion` says why, in the wording the
    // rest of the repository already refuses with.
    const refusal = refuseFutureVersion('contract', ADMIN_CONTRACT_VERSION + 1, 'contractVersion');
    expect(refusal?.code).toBe('admin/unsupported_version');
    expect(refusal?.message).toContain('written by a newer build');
  });

  it('requires the version to be present at all', () => {
    expect(envelope.safeParse({ payload: listJobsRequestSchema.parse({}) }).success).toBe(false);
  });

  it('refuses an unknown field beside the payload', () => {
    expect(
      envelope.safeParse({
        contractVersion: ADMIN_CONTRACT_VERSION,
        payload: listJobsRequestSchema.parse({}),
        token: 'sk-live',
      }).success,
    ).toBe(false);
  });
});

describe('the response envelope', () => {
  const response = adminResponse(jobPageSchema);

  it('round-trips a successful answer', () => {
    const ok = {
      ok: true as const,
      contractVersion: ADMIN_CONTRACT_VERSION,
      payload: { items: [], page: { returned: 0, limit: 50, nextCursor: null, total: 0 } },
    };
    expect(response.parse(JSON.parse(JSON.stringify(ok)))).toEqual(ok);
  });

  it('round-trips a failure carrying several structured errors', () => {
    const failed = {
      ok: false as const,
      contractVersion: ADMIN_CONTRACT_VERSION,
      errors: [
        {
          severity: 'error' as const,
          code: 'admin/schema' as const,
          message: 'Bad limit.',
          path: 'page.limit',
        },
        {
          severity: 'error' as const,
          code: 'admin/invalid_cursor' as const,
          message: 'Stale cursor.',
        },
      ],
    };
    expect(response.parse(JSON.parse(JSON.stringify(failed)))).toEqual(failed);
  });

  it('cannot hold both a payload and errors, nor neither', () => {
    expect(
      response.safeParse({
        ok: true,
        contractVersion: ADMIN_CONTRACT_VERSION,
        payload: { items: [], page: { returned: 0, limit: 50, nextCursor: null, total: 0 } },
        errors: [],
      }).success,
    ).toBe(false);
    expect(response.safeParse({ ok: false, contractVersion: ADMIN_CONTRACT_VERSION }).success).toBe(
      false,
    );
  });

  it('refuses a failure with an empty error list', () => {
    expect(
      response.safeParse({ ok: false, contractVersion: ADMIN_CONTRACT_VERSION, errors: [] })
        .success,
    ).toBe(false);
  });

  it('stamps the contract version on the way back as well as the way out', () => {
    expect(
      response.safeParse({
        ok: false,
        contractVersion: ADMIN_CONTRACT_VERSION + 1,
        errors: [{ severity: 'error', code: 'admin/schema', message: 'x' }],
      }).success,
    ).toBe(false);
  });
});

describe('listing requests', () => {
  it('treats `{}` as the unfiltered first page', () => {
    const parsed = listJobsRequestSchema.parse({});
    expect(parsed.filter).toEqual(NO_CATALOG_FILTER);
    expect(parsed.page).toEqual({ limit: PAGE_SIZE_DEFAULT, cursor: null });
    expect(listBatchesRequestSchema.parse({}).page.limit).toBe(PAGE_SIZE_DEFAULT);
  });

  it('carries a filter and a page together', () => {
    const parsed = listJobsRequestSchema.parse({
      filter: { status: ['running'] },
      page: { limit: 10 },
    });
    expect(parsed.filter.status).toEqual(['running']);
    expect(parsed.page.limit).toBe(10);
  });

  it('is still bounded when a caller asks for everything', () => {
    expect(listJobsRequestSchema.safeParse({ page: { limit: PAGE_SIZE_MAX + 1 } }).success).toBe(
      false,
    );
  });

  it('offers no sort, because the cursor encodes a position in a fixed ordering', () => {
    expect(listJobsRequestSchema.safeParse({ sort: 'createdAt' } as never).success).toBe(false);
    expect(listJobsRequestSchema.safeParse({ order: 'desc' } as never).success).toBe(false);
  });

  it('refuses an unknown field', () => {
    expect(listJobsRequestSchema.safeParse({ includeResults: true } as never).success).toBe(false);
  });
});

describe('mutation requests name an identifier and nothing else', () => {
  it('round-trips a job and a batch reference', () => {
    expect(jobRefSchema.parse({ jobId: 'job_fixture1' })).toEqual({ jobId: 'job_fixture1' });
    expect(batchRefSchema.parse({ batchId: 'batch_fixture1' })).toEqual({
      batchId: 'batch_fixture1',
    });
  });

  it('refuses a result root or an output directory alongside the ID', () => {
    // ADR 0023 §5: a request never names a filesystem path; it names an
    // identifier the server resolves.
    expect(jobRefSchema.safeParse({ jobId: 'job_fixture1', rootId: 'default' }).success).toBe(
      false,
    );
    expect(jobRefSchema.safeParse({ jobId: 'job_fixture1', output: 'results/run-1' }).success).toBe(
      false,
    );
    expect(jobRefSchema.safeParse({ jobId: 'job_fixture1', directory: '../escape' }).success).toBe(
      false,
    );
  });

  it('round-trips an annotation update, which is the whole block', () => {
    const request = {
      jobId: 'job_fixture1',
      annotations: { tags: ['wave-1'], note: 'Pinned.', baseline: true },
    };
    expect(setJobAnnotationsRequestSchema.parse(JSON.parse(JSON.stringify(request)))).toEqual(
      request,
    );
  });

  it('lets annotations be cleared, which a patch could not express unambiguously', () => {
    const cleared = { jobId: 'job_fixture1', annotations: NO_ANNOTATIONS };
    expect(setJobAnnotationsRequestSchema.parse(cleared)).toEqual(cleared);
  });

  it('cannot reach into the experiment directory it annotates', () => {
    expect(
      setJobAnnotationsRequestSchema.safeParse({
        jobId: 'job_fixture1',
        annotations: NO_ANNOTATIONS,
        location: { rootId: 'default', directory: 'results/run-1' },
      }).success,
    ).toBe(false);
  });

  it('carries the action rather than the state a transition should reach', () => {
    // A client that sent `status: 'cancelled'` would be deciding the outcome of
    // a transition the lifecycle model owns.
    expect(jobActionRequestSchema.parse({ jobId: 'job_fixture1', action: 'cancel' })).toEqual({
      jobId: 'job_fixture1',
      action: 'cancel',
    });
    expect(
      jobActionRequestSchema.safeParse({ jobId: 'job_fixture1', status: 'cancelled' }).success,
    ).toBe(false);
    expect(
      jobActionRequestSchema.safeParse({ jobId: 'job_fixture1', action: 'cancelled' }).success,
    ).toBe(false);
  });

  it('refuses a batch action on a job, and a malformed ID', () => {
    expect(
      jobActionRequestSchema.safeParse({ jobId: 'job_fixture1', action: 'enqueue' }).success,
    ).toBe(false);
    expect(jobActionRequestSchema.safeParse({ jobId: '../escape', action: 'cancel' }).success).toBe(
      false,
    );
  });
});

describe('no request payload admits a filesystem location', () => {
  it('is checked over the closed set of payloads rather than a few of them', () => {
    expect(ADMIN_REQUEST_PAYLOAD_NAMES.length).toBe(
      Object.keys(ADMIN_REQUEST_PAYLOAD_SCHEMAS).length,
    );
    expect(ADMIN_REQUEST_PAYLOAD_NAMES.length).toBeGreaterThan(0);
  });

  it('refuses a root, a directory, an output or an absolute path in every one', () => {
    const smuggled = [
      { rootId: 'default' },
      { directory: 'results/run-1' },
      { output: '/var/results' },
      { path: '../../etc/passwd' },
      { catalogRoot: 'C:\\catalog' },
    ];
    for (const name of ADMIN_REQUEST_PAYLOAD_NAMES) {
      const schema = ADMIN_REQUEST_PAYLOAD_SCHEMAS[name] as z.ZodType;
      for (const extra of smuggled) {
        // Every payload is a strict object, so an added key is a parse error
        // whatever else the payload holds.
        expect(schema.safeParse({ ...extra }).success).toBe(false);
      }
    }
  });

  it('holds no schema that mentions a stored result location', () => {
    for (const name of ADMIN_REQUEST_PAYLOAD_NAMES) {
      const schema = ADMIN_REQUEST_PAYLOAD_SCHEMAS[name] as z.ZodType;
      const shape = (schema as unknown as { readonly shape?: Readonly<Record<string, unknown>> })
        .shape;
      for (const key of Object.keys(shape ?? {})) {
        expect(['rootId', 'directory', 'location', 'output', 'path']).not.toContain(key);
      }
    }
  });
});
