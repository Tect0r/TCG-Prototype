import { hasErrors } from '@tcg/shared';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ADMIN_ERROR_CODES,
  FORBIDDEN_CONTEXT_KEYS,
  MAX_CONTEXT_ENTRIES,
  MAX_CONTEXT_STRING,
  adminError,
  adminErrorCodeSchema,
  adminErrorSchema,
  adminSchemaErrors,
  errorPathSchema,
  isForbiddenContextKey,
  looksLikeFilesystemPath,
  safeContextSchema,
  toIssue,
} from './errors.js';

describe('the error code list', () => {
  it('is closed, so a client can branch on a code rather than on prose', () => {
    expect(ADMIN_ERROR_CODES.length).toBeGreaterThan(0);
    expect(new Set(ADMIN_ERROR_CODES).size).toBe(ADMIN_ERROR_CODES.length);
    for (const code of ADMIN_ERROR_CODES) expect(adminErrorCodeSchema.parse(code)).toBe(code);
  });

  it('namespaces every code, so an admin failure is recognisable on sight', () => {
    for (const code of ADMIN_ERROR_CODES) expect(code.startsWith('admin/')).toBe(true);
  });

  it('refuses a code invented at a call site', () => {
    expect(adminErrorCodeSchema.safeParse('admin/whatever').success).toBe(false);
    expect(adminErrorCodeSchema.safeParse('bot_config/unsupported_version').success).toBe(false);
  });
});

describe('an admin error round-trips', () => {
  it('survives JSON in both directions, with every optional field set', () => {
    const built = adminError('admin/illegal_transition', 'A job in `completed` has finished.', {
      path: 'jobs[2].status',
      context: { from: 'completed', action: 'start', available: [], terminal: true },
    });
    const parsed = adminErrorSchema.parse(JSON.parse(JSON.stringify(built)));
    expect(parsed).toEqual(built);
  });

  it('survives JSON with no path and no context', () => {
    const built = adminError('admin/unknown_job', 'No such job.');
    expect(adminErrorSchema.parse(JSON.parse(JSON.stringify(built)))).toEqual(built);
    expect(built).toEqual({
      severity: 'error',
      code: 'admin/unknown_job',
      message: 'No such job.',
    });
  });

  it('is an `Issue`, so a caller already collecting those can widen it', () => {
    const built = adminError('admin/schema', 'Bad field.', { path: 'filter.limit' });
    const issue = toIssue(built);
    expect(issue.severity).toBe('error');
    expect(issue.code).toBe('admin/schema');
    expect(hasErrors([issue])).toBe(true);
  });

  it('is fixed to `error`, because a request does not half-fail', () => {
    expect(
      adminErrorSchema.safeParse({ severity: 'warning', code: 'admin/schema', message: 'x' })
        .success,
    ).toBe(false);
  });

  it('refuses an unknown field, an empty message and an over-long one', () => {
    const base = { severity: 'error', code: 'admin/schema', message: 'x' };
    expect(adminErrorSchema.safeParse({ ...base, hint: 'try again' }).success).toBe(false);
    expect(adminErrorSchema.safeParse({ ...base, message: '' }).success).toBe(false);
    expect(adminErrorSchema.safeParse({ ...base, message: 'x'.repeat(501) }).success).toBe(false);
  });
});

describe('an error path names a field, not a file', () => {
  it('accepts dotted field names and indexes', () => {
    for (const path of ['limit', 'filter.createdBefore', 'jobIds[2]', 'a.b.c']) {
      expect(errorPathSchema.parse(path)).toBe(path);
    }
  });

  it('refuses anything that could be read as a location', () => {
    for (const path of ['/etc/passwd', 'C:\\results', '../config', 'a/b', '']) {
      expect(errorPathSchema.safeParse(path).success).toBe(false);
    }
  });

  it('drops an unusable path rather than failing to deliver the error', () => {
    const built = adminError('admin/schema', 'x', { path: '../secrets' });
    expect(built.path).toBeUndefined();
    expect(built.message).toBe('x');
  });
});

describe('the filesystem-path heuristic', () => {
  it('recognises every separator, traversal and drive letter', () => {
    for (const value of [
      '/var/results',
      'C:\\Users\\admin',
      'results\\run-1',
      '../up',
      '~/home',
      'a/b',
    ]) {
      expect(looksLikeFilesystemPath(value)).toBe(true);
    }
  });

  it('leaves an identifier alone, which is the safe way to name a location', () => {
    for (const value of ['job_abcdef', 'default-root', 'precon_wave_1', '0123456789abcdef']) {
      expect(looksLikeFilesystemPath(value)).toBe(false);
    }
  });
});

describe('safe context', () => {
  it('accepts the scalar shapes an `Issue` already allows', () => {
    const context = { count: 3, ok: true, name: 'precon-smoke', ids: ['a', 'b'] };
    expect(safeContextSchema.parse(context)).toEqual(context);
  });

  it('refuses every forbidden key, in any casing and as a substring', () => {
    for (const forbidden of FORBIDDEN_CONTEXT_KEYS) {
      expect(isForbiddenContextKey(forbidden)).toBe(true);
      expect(isForbiddenContextKey(forbidden.toUpperCase())).toBe(true);
      expect(safeContextSchema.safeParse({ [forbidden]: 'x' }).success).toBe(false);
    }
  });

  it('refuses a key nobody listed but everybody would have formed', () => {
    // Substring matching is the point: the failure guarded against is a later
    // tranche adding `adminToken` or `bearerSecret`.
    for (const key of ['adminToken', 'tokenHeader', 'bearerSecret', 'sessionId', 'deckList']) {
      expect(isForbiddenContextKey(key)).toBe(true);
      expect(safeContextSchema.safeParse({ [key]: 'x' }).success).toBe(false);
    }
  });

  it('refuses a value shaped like a path, in a string and inside an array', () => {
    expect(safeContextSchema.safeParse({ where: '/var/results/run-1' }).success).toBe(false);
    expect(safeContextSchema.safeParse({ roots: ['ok', '../escape'] }).success).toBe(false);
  });

  it('bounds the number of entries and the length of a value', () => {
    const wide = Object.fromEntries(
      Array.from({ length: MAX_CONTEXT_ENTRIES + 1 }, (_, i) => [`k${String(i)}`, i]),
    );
    expect(safeContextSchema.safeParse(wide).success).toBe(false);
    expect(safeContextSchema.safeParse({ note: 'x'.repeat(MAX_CONTEXT_STRING) }).success).toBe(
      true,
    );
    expect(safeContextSchema.safeParse({ note: 'x'.repeat(MAX_CONTEXT_STRING + 1) }).success).toBe(
      false,
    );
  });

  it('refuses a nested object, which is where a payload would hide', () => {
    expect(safeContextSchema.safeParse({ config: { seed: 's' } }).success).toBe(false);
  });

  it('refuses an empty key and a non-finite number', () => {
    expect(safeContextSchema.safeParse({ '': 1 }).success).toBe(false);
    expect(safeContextSchema.safeParse({ n: Number.POSITIVE_INFINITY }).success).toBe(false);
  });
});

describe('building an error refuses unsafe context rather than redacting it', () => {
  it('replaces the whole context with a visible marker', () => {
    // A redacted field looks exactly like a field that was never set, and the
    // tranche that added it would never find out.
    const built = adminError('admin/schema', 'Something failed.', {
      context: { adminToken: 'sk-live-1', field: 'limit' },
    });
    expect(built.context).toEqual({ unsafeContextRefused: true });
    expect(built.code).toBe('admin/schema');
    expect(built.message).toBe('Something failed.');
  });

  it('keeps a wholly safe context untouched', () => {
    const built = adminError('admin/invalid_cursor', 'Stale cursor.', {
      context: { limit: 50 },
    });
    expect(built.context).toEqual({ limit: 50 });
  });

  it('carries no credential or path anywhere in the built error', () => {
    const built = adminError('admin/unsafe_result_reference', 'Outside its configured root.', {
      context: { rootId: 'default', secret: 'hunter2' },
    });
    expect(JSON.stringify(built)).not.toContain('hunter2');
  });
});

describe('zod problems become this package\u2019s own errors', () => {
  it('reports every issue as `admin/schema` with the failing field', () => {
    const schema = z.strictObject({ limit: z.number().int().min(1) });
    const result = schema.safeParse({ limit: 0, extra: true });
    expect(result.success).toBe(false);
    if (result.success) return;

    const errors = adminSchemaErrors(result.error);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    for (const problem of errors) {
      expect(problem.code).toBe('admin/schema');
      expect(adminErrorSchema.parse(problem)).toEqual(problem);
      expect(problem.context?.zodCode).toBeDefined();
    }
    expect(errors.map((problem) => problem.path)).toContain('limit');
  });

  it('reports a root-level failure without inventing a path', () => {
    const result = z.strictObject({ a: z.string() }).safeParse('not an object');
    expect(result.success).toBe(false);
    if (result.success) return;
    for (const problem of adminSchemaErrors(result.error)) {
      expect(problem.path).toBeUndefined();
    }
  });
});
