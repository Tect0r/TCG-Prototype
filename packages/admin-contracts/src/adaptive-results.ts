import { z } from 'zod';

import { looksLikeFilesystemPath } from './errors.js';
import { contentHashSchema } from './identity.js';
import { pageInfoSchema, PAGE_SIZE_MAX } from './pagination.js';
import { adaptiveInformationPolicySchema } from './presets.js';
import {
  MAX_RESULT_COLUMNS,
  MAX_RESULT_READINGS,
  resultColumnSchema,
  resultReadingSchema,
  resultRowSchema,
  type ResultColumn,
} from './results.js';

/**
 * How an Adaptive Counter run's evidence travels, directory-keyed rather than
 * job-keyed (M08.19B).
 *
 * `./results.ts` is the pattern this restates: a reading is transport, not a
 * definition, and every number a table or summary carries is read back out of
 * the run's own canonical documents at the moment it is shown — never
 * recomputed here, and never a second copy of `@tcg/simulator`'s
 * `AdaptiveResultPayload` (`apps/simulator/src/adaptive/report.ts`), which
 * stays the one owner of what a series score or a screening candidate means.
 *
 * It is directory-keyed rather than job-keyed because `EXPERIMENT_KINDS`
 * (`./identity.ts`) has no `'adaptive'` member yet: an Adaptive Counter run
 * cannot be enqueued as a `CatalogStore` job today, so there is no `JobId` to
 * key a reader by. Wiring a directory to a job address — `enqueueAdaptive`, a
 * widened `jobSpec` union, a `JobOrigin` for an adaptive run — is a deferred,
 * unscoped future slice; this contract only has to carry what a reader can
 * already produce from a resolved run directory, and says nothing about how a
 * caller obtains that directory. `apps/admin-server`'s reader is the only
 * thing that resolves one, and it does so exactly as cautiously as
 * `resolveResultLocation` does for every other result (ADR 0023 §5): inside
 * the process, against a configured root, on every request.
 *
 * The five evidence streams `AdaptiveResultPayload` keeps apart — series wins,
 * revision lineage, candidate screening, reference-field standing and frozen
 * validation — stay apart here too, as separate bounded tables rather than one
 * table with a mixed row set. `cycles` is named descriptively for the same
 * reason it is in `report.ts`: CLAUDE.md is explicit that an automated signal
 * like a repeated deck-hash pair is evidence for review, never a "healthy",
 * "stuck" or "converged" verdict, and nothing in this file gives it anywhere
 * to become one.
 */

/* ------------------------------------------------------------------ identity */

/**
 * The same authored-slug bound `@tcg/simulator`'s `adaptive/config.ts` declares
 * for `adaptiveExperimentIdSchema` (40, lowercase, hyphen/underscore safe),
 * restated rather than imported for the dependency reason `./identity.ts`
 * already gives for `EXPERIMENT_KINDS`: a simulator-owned shape is a word this
 * package names, never an import that would put `@tcg/simulator` on
 * `@tcg/admin-contracts`'s dependency graph (ADR 0001). Restating the regex
 * too, not just the bound, is what "publish exactly" requires here — a schema
 * that only capped the length would wave a malformed ID through the outgoing
 * validation this file exists to enforce.
 */
export const MAX_ADAPTIVE_EXPERIMENT_ID = 40;

export const adaptiveExperimentIdSchema = z
  .string()
  .min(1)
  .max(MAX_ADAPTIVE_EXPERIMENT_ID)
  .regex(/^[a-z][a-z0-9_-]*$/, 'An Adaptive Counter experiment ID is lowercase and hyphen/underscore safe.');
export type AdaptiveExperimentId = z.infer<typeof adaptiveExperimentIdSchema>;

/* --------------------------------------------------------------- the tables */

/**
 * The tables this build can serve out of a run's canonical result document.
 *
 * Seven, one per evidence stream `AdaptiveResultPayload` keeps separate:
 * `series` is the decided-block record, `revisions` is both lineages' full
 * history (a `side` column distinguishes them, so incumbent and opponent stay
 * one table rather than two identically-shaped ones), `screening_candidates`
 * is one row per candidate per screened generation, `deck_diff` is the net
 * card change each lineage's active revision carries against its root,
 * `cycles` is `detectAdaptiveCycles`'s flat observation list, and
 * `reference_field`/`validation` are each at most one row — present only when
 * that evidence exists for this run, absent (not a null-filled row) otherwise.
 */
export const ADAPTIVE_RESULT_TABLE_NAMES = [
  'series',
  'revisions',
  'screening_candidates',
  'deck_diff',
  'cycles',
  'reference_field',
  'validation',
] as const;
export const adaptiveResultTableNameSchema = z.enum(ADAPTIVE_RESULT_TABLE_NAMES);
export type AdaptiveResultTableName = z.infer<typeof adaptiveResultTableNameSchema>;

/**
 * Which canonical document a reading came out of, and which of the four
 * adaptive schema-version domains (`apps/simulator/src/adaptive/version.ts`)
 * it declared.
 *
 * A document *name* and never a location, for the same reason
 * `resultSourceSchema` in `./results.ts` is: the directory it lives in is
 * resolved from configuration and stays inside the process.
 */
export const ADAPTIVE_RESULT_DOCUMENTS = ['adaptive-checkpoint.json', 'adaptive-result.json'] as const;
export const adaptiveResultSourceSchema = z.strictObject({
  document: z.enum(ADAPTIVE_RESULT_DOCUMENTS),
  schemaVersion: z.number().int().min(1),
});
export type AdaptiveResultSource = z.infer<typeof adaptiveResultSourceSchema>;

/**
 * One page of one adaptive result table.
 *
 * Bounded exactly as `resultTableSchema` is: `pageInfoSchema` bounds the rows,
 * `MAX_RESULT_COLUMNS` bounds the width, and the same two invariants — a page
 * reports the rows it actually carries, and every cell belongs to a declared
 * column — are re-checked here rather than assumed from the sibling schema.
 */
export const adaptiveResultTableSchema = z
  .strictObject({
    experimentId: adaptiveExperimentIdSchema,
    table: adaptiveResultTableNameSchema,
    source: adaptiveResultSourceSchema,
    columns: z.array(resultColumnSchema).min(1).max(MAX_RESULT_COLUMNS),
    rows: z.array(resultRowSchema).max(PAGE_SIZE_MAX),
    page: pageInfoSchema,
  })
  .refine(
    (value) => value.rows.length === value.page.returned,
    'An adaptive result table must report the number of rows it carries.',
  )
  .refine(
    (value) => value.rows.every((row) => Object.keys(row).every((key) => hasAdaptiveColumn(value, key))),
    'Every cell in an adaptive result table belongs to a declared column.',
  );
export type AdaptiveResultTable = z.infer<typeof adaptiveResultTableSchema>;

function hasAdaptiveColumn(
  table: { readonly columns: readonly ResultColumn[] },
  key: string,
): boolean {
  return table.columns.some(
    (column) => column.key === key || column.bounds?.low === key || column.bounds?.high === key,
  );
}

/* ----------------------------------------------------------- the summary */

/**
 * A run's headline reading, assembled from its canonical result document at
 * the moment it is asked for.
 *
 * Deliberately thinner than `resultSummarySchema`: there is no `jobId`
 * (nothing to key one by yet), no `kind` (`EXPERIMENT_KINDS` has no
 * `'adaptive'` member), and no `identity`/`denominators`/`evidenceStanding` —
 * an Adaptive Counter run writes no manifest and no calibration standing, so a
 * field for either would have nowhere honest to read from. What travels is
 * exactly what a resolved run directory can answer today: which document and
 * schema version produced the reading, the labelled scalars a dashboard needs
 * before it fetches any table, which tables have rows to fetch and how many,
 * and the fixed limitations this evidence may never be cited past.
 */
export const adaptiveRunSummarySchema = z.strictObject({
  experimentId: adaptiveExperimentIdSchema,
  configHash: contentHashSchema,
  source: adaptiveResultSourceSchema,
  /**
   * The run's `AdaptiveConfig.informationPolicy` (M08.19D), carried through
   * unchanged from `AdaptiveResultPayload.informationPolicy` so a dashboard
   * can label `public_observation` versus `analysis_full_deck` evidence
   * unmistakably without re-deriving it from `configHash`.
   */
  informationPolicy: adaptiveInformationPolicySchema,
  readings: z.array(resultReadingSchema).max(MAX_RESULT_READINGS),
  /** Which tables have rows to fetch, and how many. Saves a client seven empty requests. */
  tables: z
    .array(z.strictObject({ table: adaptiveResultTableNameSchema, rows: z.number().int().min(0) }))
    .max(ADAPTIVE_RESULT_TABLE_NAMES.length),
  /**
   * What this run's evidence may never be cited past, shown beside its
   * numbers. Fixed for now rather than sourced from a registry — there is no
   * `JobOrigin` for an adaptive run yet (`./catalog.ts`'s `limitationsOf`
   * equivalent is a job-execution-wiring concern) — and checked to be free of
   * anything path-shaped for the same reason `resultSummarySchema.limitations`
   * is.
   */
  limitations: z
    .array(
      z
        .string()
        .min(1)
        .max(600)
        .refine(
          (value) => !value.split(/\s+/).some(looksLikeFilesystemPath),
          'A limitation names a claim, not a file.',
        ),
    )
    .max(32),
});
export type AdaptiveRunSummary = z.infer<typeof adaptiveRunSummarySchema>;
