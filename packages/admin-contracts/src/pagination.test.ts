import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  CURSOR_MAX_LENGTH,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PAGE_SIZE_MIN,
  cursorSchema,
  pageInfoSchema,
  pageOf,
  pageRequestSchema,
  pageSizeSchema,
} from './pagination.js';

const CURSOR = 'eyJhZnRlciI6ImpvYl9hYmNkZWYifQ';

describe('page size', () => {
  it('accepts the minimum, the maximum and the default', () => {
    for (const size of [PAGE_SIZE_MIN, PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX]) {
      expect(pageSizeSchema.parse(size)).toBe(size);
    }
  });

  it('has a default that lies inside its own bounds', () => {
    expect(PAGE_SIZE_MIN).toBeLessThanOrEqual(PAGE_SIZE_DEFAULT);
    expect(PAGE_SIZE_DEFAULT).toBeLessThanOrEqual(PAGE_SIZE_MAX);
  });

  it('refuses one below the minimum and one above the maximum', () => {
    // Derived from the constants, so moving a bound moves the test with it.
    expect(pageSizeSchema.safeParse(PAGE_SIZE_MIN - 1).success).toBe(false);
    expect(pageSizeSchema.safeParse(PAGE_SIZE_MAX + 1).success).toBe(false);
  });

  it('refuses a fractional, negative or non-numeric size', () => {
    for (const wrong of [1.5, -10, '50', null, Number.NaN]) {
      expect(pageSizeSchema.safeParse(wrong).success).toBe(false);
    }
  });

  it('makes an unbounded request unspellable', () => {
    expect(pageSizeSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
    expect(pageSizeSchema.safeParse(1_000_000).success).toBe(false);
  });
});

describe('a continuation token', () => {
  it('accepts opaque base64url text', () => {
    expect(cursorSchema.parse(CURSOR)).toBe(CURSOR);
    expect(cursorSchema.parse('a-_0')).toBe('a-_0');
  });

  it('refuses an alphabet that could carry a path', () => {
    for (const wrong of ['a/b', 'a\\b', 'a.b', 'a:b', '../x', 'a=b', 'a b', '']) {
      expect(cursorSchema.safeParse(wrong).success).toBe(false);
    }
  });

  it('is bounded, at the constant and one past it', () => {
    expect(cursorSchema.parse('a'.repeat(CURSOR_MAX_LENGTH))).toHaveLength(CURSOR_MAX_LENGTH);
    expect(cursorSchema.safeParse('a'.repeat(CURSOR_MAX_LENGTH + 1)).success).toBe(false);
  });
});

describe('a page request', () => {
  it('treats `{}` as a valid first page at the default size', () => {
    expect(pageRequestSchema.parse({})).toEqual({ limit: PAGE_SIZE_DEFAULT, cursor: null });
  });

  it('round-trips an explicit limit and cursor', () => {
    const request = { limit: 25, cursor: CURSOR };
    expect(pageRequestSchema.parse(request)).toEqual(request);
  });

  it('still refuses a bad value that is present, so a default is not a fallback', () => {
    expect(pageRequestSchema.safeParse({ limit: PAGE_SIZE_MAX + 1 }).success).toBe(false);
    expect(pageRequestSchema.safeParse({ cursor: '../escape' }).success).toBe(false);
  });

  it('refuses an unknown field', () => {
    expect(pageRequestSchema.safeParse({ limit: 10, offset: 20 }).success).toBe(false);
    expect(pageRequestSchema.safeParse({ sort: 'createdAt' }).success).toBe(false);
  });
});

describe('page info', () => {
  it('round-trips a full page that has a next one', () => {
    const page = { returned: 50, limit: 50, nextCursor: CURSOR, total: 412 };
    expect(pageInfoSchema.parse(page)).toEqual(page);
  });

  it('round-trips a last page, which is the one with a null cursor', () => {
    const page = { returned: 3, limit: 50, nextCursor: null, total: 3 };
    expect(pageInfoSchema.parse(page)).toEqual(page);
  });

  it('lets a store decline to count, rather than reporting a guess', () => {
    const page = { returned: 50, limit: 50, nextCursor: CURSOR, total: null };
    expect(pageInfoSchema.parse(page)).toEqual(page);
  });

  it('accepts an empty page', () => {
    const page = { returned: 0, limit: 50, nextCursor: null, total: 0 };
    expect(pageInfoSchema.parse(page)).toEqual(page);
  });

  it('refuses a page carrying more rows than its limit or its total', () => {
    expect(
      pageInfoSchema.safeParse({ returned: 51, limit: 50, nextCursor: null, total: null }).success,
    ).toBe(false);
    expect(
      pageInfoSchema.safeParse({ returned: 10, limit: 50, nextCursor: null, total: 5 }).success,
    ).toBe(false);
  });

  it('refuses a returned count past the maximum page size', () => {
    expect(
      pageInfoSchema.safeParse({
        returned: PAGE_SIZE_MAX + 1,
        limit: PAGE_SIZE_MAX,
        nextCursor: null,
        total: null,
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown field', () => {
    expect(
      pageInfoSchema.safeParse({
        returned: 1,
        limit: 50,
        nextCursor: null,
        total: 1,
        hasMore: false,
      }).success,
    ).toBe(false);
  });
});

describe('a page of rows', () => {
  const rowPage = pageOf(z.strictObject({ id: z.string() }));

  it('round-trips items beside the count that describes them', () => {
    const page = {
      items: [{ id: 'a' }, { id: 'b' }],
      page: { returned: 2, limit: 50, nextCursor: null, total: 2 },
    };
    expect(rowPage.parse(page)).toEqual(page);
  });

  it('refuses a page whose reported count disagrees with its rows', () => {
    expect(
      rowPage.safeParse({
        items: [{ id: 'a' }],
        page: { returned: 2, limit: 50, nextCursor: null, total: 2 },
      }).success,
    ).toBe(false);
  });

  it('refuses a row that is not the shape it was built over', () => {
    expect(
      rowPage.safeParse({
        items: [{ id: 'a', extra: true }],
        page: { returned: 1, limit: 50, nextCursor: null, total: 1 },
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown field on the envelope', () => {
    expect(
      rowPage.safeParse({
        items: [],
        page: { returned: 0, limit: 50, nextCursor: null, total: 0 },
        warnings: [],
      }).success,
    ).toBe(false);
  });

  it('never carries more rows than the maximum page size', () => {
    const tooMany = Array.from({ length: PAGE_SIZE_MAX + 1 }, (_, i) => ({ id: String(i) }));
    expect(
      rowPage.safeParse({
        items: tooMany,
        page: { returned: PAGE_SIZE_MAX, limit: PAGE_SIZE_MAX, nextCursor: null, total: null },
      }).success,
    ).toBe(false);
  });
});
