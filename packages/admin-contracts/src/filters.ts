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
import { contentIdSchema } from './content.js';
import { jobStatusSchema } from './lifecycle.js';

/**
 * How a catalog listing is narrowed.
 *
 * Every field here filters on something the contract itself defines, and that is
 * the whole selection rule.
 *
 * **M08.1 wrote that a Commander and a precon filter would wait**, on the
 * grounds that *a filter for a field the contract does not model could not be
 * honoured, and a page that does not exist cannot say what it needs*. The first
 * half was the load-bearing one and M08.10 answers it rather than overruling it:
 * a precon **is** modelled — `contentPreconSchema` publishes a `preconId` and the
 * `commanderId` it plays, and a precon deck source names those IDs in the
 * configuration a job stores. So the two filters below are asked of the run's own
 * **configuration**, which every job has from the moment it is created, rather
 * than of a deck table that only a finished run has. What still waits for the
 * Deck and Card explorers is filtering by a deck a *search* produced, because
 * that is a result rather than a selection, and `deckSearchFilter` is not a shape
 * this package can express yet.
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

/**
 * Exported so a second filter contract (`player-meta.ts`'s `playerMetaFilterSchema`,
 * M08.25A) builds its own value-set fields against the same bound and the same
 * distinctness rule, rather than a second, possibly-drifting copy of this helper.
 */
export const valueSet = <T extends z.ZodType>(item: T) =>
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
    /**
     * Runs whose configuration names one of these precons.
     *
     * Asked of the configuration rather than of the results, so a queued job
     * answers it as well as a finished one — an operator narrowing to *the runs
     * that play Goblin Swarm* means the ones configured to, and half of them may
     * not have started. A run whose decks are generated or loaded from files
     * names no precon and matches nothing here, which is truthful: it plays no
     * precon.
     */
    preconIds: valueSet(contentIdSchema),
    /**
     * Runs one of whose configured decks is led by one of these Commanders.
     *
     * The same reading, one step further: a precon resolves to a Commander
     * through the content catalog, and an inline deck states one directly. It is
     * a separate field rather than a translation of `preconIds`, because two
     * precons can share a Commander and *which Commander was under test* is the
     * question M08.13 aggregates by.
     */
    commanderIds: valueSet(contentIdSchema),
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
