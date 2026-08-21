import { describe, expect, it } from 'vitest';

import {
  MAX_FILTER_VALUES,
  NO_CATALOG_FILTER,
  catalogFilterSchema,
  type CatalogFilterInput,
} from './filters.js';
import { SOURCE_CLASSES } from './identity.js';
import { JOB_STATUSES } from './lifecycle.js';

const parse = (input: CatalogFilterInput) => catalogFilterSchema.safeParse(input);

describe('the unfiltered listing', () => {
  it('is what `{}` means, so a client never enumerates what it does not care about', () => {
    expect(catalogFilterSchema.parse({})).toEqual(NO_CATALOG_FILTER);
  });

  it('filters on nothing: every set is empty and every scalar is null', () => {
    for (const value of Object.values(NO_CATALOG_FILTER)) {
      if (Array.isArray(value)) expect(value).toEqual([]);
      else expect(value).toBeNull();
    }
  });

  it('round-trips through JSON unchanged', () => {
    expect(catalogFilterSchema.parse(JSON.parse(JSON.stringify(NO_CATALOG_FILTER)))).toEqual(
      NO_CATALOG_FILTER,
    );
  });
});

describe('filter combinations', () => {
  it('accepts several values for one field', () => {
    const parsed = catalogFilterSchema.parse({ status: ['queued', 'running'] });
    expect(parsed.status).toEqual(['queued', 'running']);
  });

  it('accepts several fields at once', () => {
    const parsed = catalogFilterSchema.parse({
      status: ['completed'],
      purpose: 'validation',
      sourceClasses: ['ai', 'precon'],
      kinds: ['batch'],
      tags: ['precon-smoke'],
      baseline: true,
      fullContentHash: '0123456789abcdef',
      createdAfter: '2026-08-01T00:00:00.000Z',
      createdBefore: '2026-08-31T23:59:59.999Z',
    });
    expect(parsed.baseline).toBe(true);
    expect(parsed.purpose).toBe('validation');
    expect(parsed.fullContentHash).toBe('0123456789abcdef');
  });

  it('accepts every job status and every source class as a filter value', () => {
    expect(parse({ status: [...JOB_STATUSES] }).success).toBe(true);
    expect(parse({ sourceClasses: [...SOURCE_CLASSES] }).success).toBe(true);
  });

  it('lets a query ask for a classification no entry may claim', () => {
    // A filter asks a question; an entry makes a claim. `['mixed', 'ai']` is an
    // illegal classification and a perfectly reasonable query.
    expect(parse({ sourceClasses: ['mixed', 'ai'] }).success).toBe(true);
  });

  it('does not require filter values in canonical order, unlike a classification', () => {
    expect(parse({ sourceClasses: ['precon', 'ai'] }).success).toBe(true);
  });

  it('distinguishes baseline-only, non-baseline-only and both', () => {
    expect(catalogFilterSchema.parse({ baseline: true }).baseline).toBe(true);
    expect(catalogFilterSchema.parse({ baseline: false }).baseline).toBe(false);
    expect(catalogFilterSchema.parse({}).baseline).toBeNull();
  });
});

describe('incompatible and malformed filters', () => {
  it('refuses an inverted date range', () => {
    expect(
      parse({
        createdAfter: '2026-08-31T00:00:00.000Z',
        createdBefore: '2026-08-01T00:00:00.000Z',
      }).success,
    ).toBe(false);
  });

  it('accepts a range that starts and ends at the same instant', () => {
    const instant = '2026-08-21T09:00:00.000Z';
    expect(parse({ createdAfter: instant, createdBefore: instant }).success).toBe(true);
  });

  it('refuses a duplicate value in a set', () => {
    expect(parse({ status: ['queued', 'queued'] }).success).toBe(false);
    expect(parse({ tags: ['a-tag', 'a-tag'] }).success).toBe(false);
  });

  it('refuses more values than the bound allows', () => {
    const many = Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, i) => `tag-${String(i)}`);
    expect(parse({ tags: many }).success).toBe(false);
    expect(parse({ tags: many.slice(0, MAX_FILTER_VALUES) }).success).toBe(true);
  });

  it('refuses a value that is not a member of its enum', () => {
    expect(parse({ status: ['draft'] as never }).success).toBe(false);
    expect(parse({ kinds: ['adaptive'] as never }).success).toBe(false);
    expect(parse({ purpose: 'discovery' as never }).success).toBe(false);
    expect(parse({ sourceClasses: ['bot'] as never }).success).toBe(false);
  });

  it('refuses a malformed timestamp, hash, batch ID and tag', () => {
    expect(parse({ createdAfter: '2026-08-21' }).success).toBe(false);
    expect(parse({ fullContentHash: 'NOTHEX' }).success).toBe(false);
    expect(parse({ batchId: 'job_abcdef' }).success).toBe(false);
    expect(parse({ tags: ['Not A Tag'] }).success).toBe(false);
  });

  it('refuses a scalar where a set belongs, and a set where a scalar belongs', () => {
    expect(parse({ status: 'queued' as never }).success).toBe(false);
    expect(parse({ purpose: ['validation'] as never }).success).toBe(false);
  });

  it('refuses an unknown field, including a filter a later page will want', () => {
    // M08.10 wants Commander and precon; neither is here, because a filter for a
    // field this contract does not model could not be honoured.
    expect(parse({ commander: 'card_x' } as never).success).toBe(false);
    expect(parse({ precon: 'precon_wave_1' } as never).success).toBe(false);
    expect(parse({ contentHash: 'abcdef01' } as never).success).toBe(false);
  });

  it('cannot be used to smuggle a filesystem location', () => {
    expect(parse({ batchId: '../../results' as never }).success).toBe(false);
    expect(parse({ tags: ['/var/results'] }).success).toBe(false);
  });
});

describe('the filter names only what M08.1 defines', () => {
  it('has a field for every classification this package models, and no other', () => {
    expect(Object.keys(NO_CATALOG_FILTER).sort()).toEqual([
      'baseline',
      'batchId',
      'createdAfter',
      'createdBefore',
      'fullContentHash',
      'kinds',
      'purpose',
      'sourceClasses',
      'status',
      'tags',
    ]);
  });
});
