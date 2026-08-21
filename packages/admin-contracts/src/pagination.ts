import { z } from 'zod';

import { looksLikeFilesystemPath } from './errors.js';

/**
 * Bounded pagination, and a continuation token that is opaque by construction.
 *
 * Every list the admin surface offers is bounded. M08.26 states the rule the
 * other way round — "never load unlimited raw rows into the browser" — and the
 * cheapest way to keep it is for the contract to make an unbounded request
 * unspellable rather than for each endpoint to remember a limit.
 */

/** A page holds at least one row. A request for zero rows is a mistake, not a query. */
export const PAGE_SIZE_MIN = 1;

/**
 * The most rows one page may hold.
 *
 * 200 rather than a round 100 or 1000 because the number has a job: it is the
 * largest table a person can be handed at once without the client having to
 * virtualize, and it is small enough that a file-backed store (ADR 0023 §3) can
 * answer from a directory read. A caller that wants more asks twice.
 */
export const PAGE_SIZE_MAX = 200;

/** What a caller gets for not choosing. */
export const PAGE_SIZE_DEFAULT = 50;

export const pageSizeSchema = z
  .number()
  .int()
  .min(PAGE_SIZE_MIN)
  .max(PAGE_SIZE_MAX)
  .default(PAGE_SIZE_DEFAULT);

/**
 * A continuation token: opaque to the client, and unable to carry a path.
 *
 * The contract guarantees two things and deliberately no more. It is **opaque**
 * — the client stores it and hands it back unchanged, and what it encodes is the
 * store's business, so M08.2 can change how it continues a listing without a
 * contract version moving. And it is **path-free**: the alphabet is base64url,
 * which has no `/`, no `\`, no `.` and no `:`, so a cursor cannot become a way to
 * smuggle a filesystem location back into a request that ADR 0023 §5 says must
 * only carry identifiers.
 *
 * Stability is the store's promise rather than the schema's: a cursor names a
 * position in an ordering, and the ordering is by `createdAt` then ID, which
 * `timestampSchema` makes lexicographically sortable on purpose.
 */
export const CURSOR_MAX_LENGTH = 512;

export const cursorSchema = z
  .string()
  .min(1)
  .max(CURSOR_MAX_LENGTH)
  .regex(/^[A-Za-z0-9_-]+$/, 'A continuation token is opaque base64url text.')
  .refine((value) => !looksLikeFilesystemPath(value), 'A continuation token is not a path.');
export type Cursor = z.infer<typeof cursorSchema>;

/**
 * What a caller asks for.
 *
 * `limit` defaults and `cursor` defaults to `null`, so `{}` is a valid first
 * page and the client does not have to know the default to get it. Both are
 * still refused when present and wrong, which is the point of a default that is
 * not a fallback.
 */
export const pageRequestSchema = z.strictObject({
  limit: pageSizeSchema,
  cursor: cursorSchema.nullable().default(null),
});
export type PageRequest = z.infer<typeof pageRequestSchema>;
export type PageRequestInput = z.input<typeof pageRequestSchema>;

/**
 * What came back.
 *
 * `total` is nullable rather than a number, because a file-backed catalog can
 * answer "here are fifty" far more cheaply than "there are 8,412", and reporting
 * a total it had to guess at would be worse than reporting none. `nextCursor` is
 * `null` exactly when the listing is exhausted — a caller loops until it is null
 * rather than comparing counts, which is the only rule that stays correct while
 * entries are being added underneath.
 */
export const pageInfoSchema = z
  .strictObject({
    /** How many rows this page actually carries. */
    returned: z.number().int().min(0).max(PAGE_SIZE_MAX),
    /** The limit that produced it, echoed so a client can tell a short page from a last one. */
    limit: z.number().int().min(PAGE_SIZE_MIN).max(PAGE_SIZE_MAX),
    /** `null` when there is nothing after this page. */
    nextCursor: cursorSchema.nullable(),
    /** Total matching rows, when the store can say so cheaply. */
    total: z.number().int().min(0).nullable(),
  })
  .refine((page) => page.returned <= page.limit, 'A page cannot carry more rows than its limit.')
  .refine(
    (page) => page.total === null || page.returned <= page.total,
    'A page cannot carry more rows than the total it reports.',
  );
export type PageInfo = z.infer<typeof pageInfoSchema>;

/**
 * One page of anything.
 *
 * A function over the row schema rather than a repeated pair of fields, so every
 * list response in the admin contract has the same shape and a client can write
 * one paging helper.
 */
export function pageOf<T extends z.ZodType>(item: T) {
  return z
    .strictObject({
      items: z.array(item).max(PAGE_SIZE_MAX),
      page: pageInfoSchema,
    })
    .refine(
      (value) => value.items.length === value.page.returned,
      'A page must report the number of rows it carries.',
    );
}
