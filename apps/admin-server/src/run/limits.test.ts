import { availableParallelism } from 'node:os';

import { isErr, isOk, unwrap } from '@tcg/shared';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_RESOURCE_LIMITS,
  MAX_CONCURRENT_JOBS,
  MAX_TOTAL_WORKERS,
  grantWorkers,
  parseResourceLimits,
  resourceLimitsSchema,
} from './limits.js';

/**
 * How much of the machine the lab may take (M08.5).
 *
 * The arithmetic is small and the consequences are not: a grant that is one too
 * many oversubscribes a box that may also be serving live matches, and a grant
 * of zero silently stalls a queue that looks like it is working.
 */

describe('the schema refuses a bound that cannot be honoured', () => {
  it('refuses zero, because a queue that may run nothing is a queue that is stuck', () => {
    expect(
      resourceLimitsSchema.safeParse({ ...DEFAULT_RESOURCE_LIMITS, maxWorkers: 0 }).success,
    ).toBe(false);
    expect(
      resourceLimitsSchema.safeParse({ ...DEFAULT_RESOURCE_LIMITS, maxConcurrentJobs: 0 }).success,
    ).toBe(false);
  });

  it('refuses a per-job ceiling above the whole budget', () => {
    // Not merely odd: a configuration asking for `maxWorkersPerJob` would then be
    // permanently unstartable, and the queue would report an empty machine while
    // never starting anything.
    const parsed = resourceLimitsSchema.safeParse({
      maxConcurrentJobs: 2,
      maxWorkers: 2,
      maxWorkersPerJob: 4,
    });
    expect(parsed.success).toBe(false);
  });

  it('refuses a key nobody declared', () => {
    expect(
      resourceLimitsSchema.safeParse({ ...DEFAULT_RESOURCE_LIMITS, maxThreads: 4 }).success,
    ).toBe(false);
  });

  it('caps a total at the same 64 a single run is capped at', () => {
    // A total budget below one run's own ceiling would make a legal
    // configuration impossible to start; above it would be a second opinion
    // about what the simulator will accept.
    expect(MAX_TOTAL_WORKERS).toBe(64);
    expect(
      resourceLimitsSchema.safeParse({
        maxConcurrentJobs: 1,
        maxWorkers: MAX_TOTAL_WORKERS + 1,
        maxWorkersPerJob: 1,
      }).success,
    ).toBe(false);
  });

  it('keeps the concurrency ceiling inside one page of a listing', () => {
    // `JobQueue` asks for `maxConcurrentJobs + 1` rows so that a page cannot be
    // entirely in-flight jobs. That only works while the ask is a legal page size.
    expect(MAX_CONCURRENT_JOBS + 1).toBeLessThanOrEqual(200);
  });
});

describe('the defaults', () => {
  it('leave one thread of the machine, and run one experiment at a time', () => {
    expect(DEFAULT_RESOURCE_LIMITS.maxConcurrentJobs).toBe(1);
    expect(DEFAULT_RESOURCE_LIMITS.maxWorkers).toBe(
      Math.min(MAX_TOTAL_WORKERS, Math.max(1, availableParallelism() - 1)),
    );
    expect(DEFAULT_RESOURCE_LIMITS.maxWorkersPerJob).toBe(DEFAULT_RESOURCE_LIMITS.maxWorkers);
  });

  it('are what an unspecified field falls back to, field by field', () => {
    const limits = unwrap(parseResourceLimits({ maxConcurrentJobs: 3 }));
    expect(limits.maxConcurrentJobs).toBe(3);
    expect(limits.maxWorkers).toBe(DEFAULT_RESOURCE_LIMITS.maxWorkers);
  });

  it('report a bad value as an admin error naming the field', () => {
    const refused = parseResourceLimits({ maxWorkers: -1 });
    expect(isErr(refused)).toBe(true);
    if (!isErr(refused)) return;
    expect(refused.error[0]?.code).toBe('admin/schema');
    expect(refused.error[0]?.path).toBe('maxWorkers');
  });

  it('accept the empty request, because a caller with no opinion is not an error', () => {
    expect(isOk(parseResourceLimits())).toBe(true);
  });
});

describe('a grant is the smallest of what is asked, allowed and left', () => {
  const limits = unwrap(
    parseResourceLimits({ maxConcurrentJobs: 3, maxWorkers: 6, maxWorkersPerJob: 4 }),
  );

  it('gives a modest configuration exactly what it asked for', () => {
    expect(grantWorkers(limits, 2, { jobs: 0, workers: 0 })).toBe(2);
  });

  it('never widens a run that did not ask to be wide', () => {
    // The configuration's own request is the *most* a job gets, so raising the
    // per-job ceiling cannot turn a one-worker experiment into a four-worker one.
    expect(grantWorkers(limits, 1, { jobs: 0, workers: 0 })).toBe(1);
  });

  it('clamps a greedy configuration to one job’s share', () => {
    expect(grantWorkers(limits, 64, { jobs: 0, workers: 0 })).toBe(4);
  });

  it('clamps again to what the budget has left', () => {
    expect(grantWorkers(limits, 4, { jobs: 1, workers: 4 })).toBe(2);
  });

  it('says "not now" rather than zero when the budget is spent', () => {
    // A different answer from `1`, and the difference is the whole point: a
    // queue that started a job with zero workers would have ignored its bound,
    // and one that started it with a worker it did not have would have rewritten
    // it.
    expect(grantWorkers(limits, 4, { jobs: 1, workers: 6 })).toBeNull();
  });

  it('says "not now" when the concurrency bound is full, however idle the workers', () => {
    expect(grantWorkers(limits, 1, { jobs: 3, workers: 3 })).toBeNull();
  });
});
