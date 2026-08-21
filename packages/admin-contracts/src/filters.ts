import { z } from 'zod';

import {
  contentHashSchema,
  batchIdSchema,
  experimentKindSchema,
  experimentPurposeSchema,
  sourceClassSchema,
  tagSchema,
  timestampSchema,
} from './identity.js';
import { jobStatusSchema } from './lifecycle.js';

/**
 * How a catalog listing is narrowed.
 *
 * Every field here filters on something **M08.1 itself defines**, and that is the
 * whole selection rule. M08.10 will also want to filter by Commander and by
 * precon; neither is in this schema, because a filter for a field the contract
 * does not model could not be honoured, and a page that does not exist cannot
 * say what it needs. The tranche that adds the Deck and Card explorers adds those
 * filters beside the schemas that give them meaning.
 *
 * ## Semantics
 *
 * **OR within a field, AND across fields.** `status: ['queued', 'running']`
 * matches either; adding `purpose: 'validation'` narrows both. Stated rather than
 * implied, because the alternative reading — AND within a field — would make
 * every multi-value filter match nothing, and a filter that silently matches
 * nothing is the hardest kind of bug to see.
 *
 * **An absent field does not filter.** Every member has a default that means "all
 * of them", so `{}` is the unfiltered listing and a client never has to enumerate
 * what it does not care about.
 *
 * **The `mixed` rule does not apply here.** `sourceClasses: ['mixed', 'ai']` is a
 * legal *query* — show me runs classified either way — even though it is an
 * illegal *classification*. A filter asks a question; an entry makes a claim.
 */

/** A filter names at most this many values for one field. Bounded like everything else. */
export const MAX_FILTER_VALUES = 16;

const valueSet = <T extends z.ZodType>(item: T) =>
  z
    .array(item)
    .max(MAX_FILTER_VALUES)
    .default([])
    .refine((values) => new Set(values).size === values.length, 'Filter values must be distinct.');

export const catalogFilterSchema = z
  .strictObject({
    /** Lifecycle states to include. Empty means every state. */
    status: valueSet(jobStatusSchema),
    /** Exploration, validation, or `null` for both. */
    purpose: experimentPurposeSchema.nullable().default(null),
    /** Any of these evidence classes. An entry matches when it carries one of them. */
    sourceClasses: valueSet(sourceClassSchema),
    /** Any of these experiment kinds. */
    kinds: valueSet(experimentKindSchema),
    /** Only jobs in this batch. */
    batchId: batchIdSchema.nullable().default(null),
    /** Any of these administrator tags. */
    tags: valueSet(tagSchema),
    /** `true` for baselines only, `false` for non-baselines only, `null` for both. */
    baseline: z.boolean().nullable().default(null),
    /**
     * Runs one of whose environments resolved to exactly this content.
     *
     * Named for the specific address it matches rather than "content hash",
     * because a run carries four of those per environment and they answer
     * different questions. `fullContentHash` is the byte-for-byte one, which is
     * what M08.27 needs before it can refuse an accidental comparison of
     * incompatible runs.
     *
     * Matching **any** environment rather than all of them, because a
     * `comparison` run deliberately holds two, and a reader asking "which runs
     * saw this content" wants that run in the answer.
     */
    fullContentHash: contentHashSchema.nullable().default(null),
    /** Inclusive lower bound on `timestamps.createdAt`. */
    createdAfter: timestampSchema.nullable().default(null),
    /** Inclusive upper bound on `timestamps.createdAt`. */
    createdBefore: timestampSchema.nullable().default(null),
  })
  .refine(
    (filter) =>
      filter.createdAfter === null ||
      filter.createdBefore === null ||
      filter.createdAfter <= filter.createdBefore,
    'A date range must start before it ends.',
  );

export type CatalogFilter = z.infer<typeof catalogFilterSchema>;
export type CatalogFilterInput = z.input<typeof catalogFilterSchema>;

/** The filter that excludes nothing, for a caller that would rather not spell `{}`. */
export const NO_CATALOG_FILTER: CatalogFilter = catalogFilterSchema.parse({});
