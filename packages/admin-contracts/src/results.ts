import { z } from 'zod';

import { looksLikeFilesystemPath } from './errors.js';
import { contentHashSchema, experimentKindSchema, jobIdSchema } from './identity.js';
import { pageInfoSchema, PAGE_SIZE_MAX } from './pagination.js';
import { runIdentitySchema } from './catalog.js';

/**
 * How a run's numbers travel, without this package acquiring an opinion about
 * what any of them mean.
 *
 * This is the one module that looks like it breaks the package's own rule —
 * `index.ts` says *nothing here can express "this run's win rate"* — so the
 * distinction it rests on has to be stated rather than assumed.
 *
 * **A reading is transport, not a definition.** Nothing below names a statistic,
 * fixes how one is computed, or decides which rows a table has. A column is a
 * key, a label and a display kind; a row is scalars under those keys; a reading
 * is a labelled scalar with a unit. The projection from `summary.json` into these
 * shapes lives in `apps/admin-server`, where `@tcg/simulator` is a dependency and
 * `aggregateSchema` is the authority — so the meaning of "win rate" still has
 * exactly one owner, and a client renders what it is handed rather than
 * recomputing it. ADR 0023 §3's rule is unchanged and is what forces this shape:
 * *every number a result view shows is read back out of those files*, at the
 * moment it is shown. A schema here that mirrored `aggregateSchema` would be the
 * second copy of evidence ADR 0012 and ADR 0011 exist to prevent, and it would
 * have to move every time the simulator added a field.
 *
 * **Provenance is not transport, and is named exactly.** The milestone's result
 * rules require content, rules, schema, pilot and software provenance, the
 * denominators, and the evidence-claim and calibration standing to be visible
 * *before* a reader may treat a number as evidence. Those are structural
 * promises rather than rendering hints, so they are fields with names —
 * `runIdentitySchema` for the first, `resultDenominatorsSchema` for the second,
 * `evidenceStandingSchema` for the third — and a summary that could not carry
 * them would be a summary a result view is not allowed to show.
 */

/* ------------------------------------------------------------- what a cell is */

/** Longest a single cell or label may be. Long enough to name a card, too short to be a payload. */
export const MAX_CELL_LENGTH = 200;

/**
 * One value in a result table or reading.
 *
 * `null` is a member and means *not measured*, which is a different statement
 * from `0`. The milestone makes that a defect when it is got wrong — *zero
 * observations are not a zero win rate* — so the transport has to be able to say
 * it at all.
 */
export const resultCellSchema = z.union([
  z.string().max(MAX_CELL_LENGTH),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
export type ResultCell = z.infer<typeof resultCellSchema>;

/**
 * How a cell should be read, so a client formats without guessing from the key.
 *
 * A closed list, because a display kind a client does not know is a column it
 * would have to render as raw text — and the failure would be silent. `interval`
 * is here because the statistics contract reports proportions with bounds and
 * the milestone requires the uncertainty to be shown wherever it exists: a
 * column that carried the point estimate alone would make that impossible at the
 * transport layer rather than at the screen.
 */
export const RESULT_CELL_KINDS = [
  'text',
  'identifier',
  'count',
  'proportion',
  'interval',
  'number',
  'milliseconds',
  'flag',
] as const;
export const resultCellKindSchema = z.enum(RESULT_CELL_KINDS);
export type ResultCellKind = z.infer<typeof resultCellKindSchema>;

/**
 * A column key: a plain field name, never a path.
 *
 * The same alphabet `errorPathSchema` uses and for the same reason. A key ends up
 * in a client's DOM and in a CSV a person exports; a separator in one is either a
 * bug or a smuggled location, and neither is worth allowing.
 */
export const resultKeySchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_]+(\.[A-Za-z0-9_]+)*$/, 'A result key names a field, not a file.');

export const resultColumnSchema = z.strictObject({
  key: resultKeySchema,
  label: z.string().min(1).max(80),
  kind: resultCellKindSchema,
  /**
   * The lower and upper bound columns, when this one is an interval.
   *
   * Named rather than derived by convention (`key + 'Low'`), because a naming
   * convention is a rule a projection can break silently and a reader cannot
   * check.
   */
  bounds: z.strictObject({ low: resultKeySchema, high: resultKeySchema }).nullable(),
});
export type ResultColumn = z.infer<typeof resultColumnSchema>;

/** Most columns one result table may carry. */
export const MAX_RESULT_COLUMNS = 48;

export const resultRowSchema = z.record(resultKeySchema, resultCellSchema);
export type ResultRow = z.infer<typeof resultRowSchema>;

/* ------------------------------------------------------------- the tables */

/**
 * The tables this build can serve out of a run directory.
 *
 * Words rather than schemas, which is the allowance `index.ts` already makes:
 * *where this package names something one of them owns, it names the word*. The
 * rows of each are `@tcg/simulator`'s `aggregateSchema`, and the admin server is
 * the only thing that reads them.
 *
 * Seven rather than three, and the extra four are the milestone's result rules
 * rather than a wish list. *Seat orientation, and the pilot and source split* is
 * a rule, so `seats`, `pilots` and `agent_classes` exist — and the last two are
 * separate tables rather than one, because M05.4 reports an agent class *beside*
 * a pilot and never averaged with it, and one table with a mixed row set is
 * exactly the pooled skill distribution that forbids. *Completed, abnormal,
 * failed, surrendered, timed-out and excluded counts* is a rule too, so
 * `terminations` exists rather than one opaque number for "abnormal".
 */
export const RESULT_TABLE_NAMES = [
  'decks',
  'matchups',
  'cards',
  'seats',
  'pilots',
  'agent_classes',
  'terminations',
] as const;
export const resultTableNameSchema = z.enum(RESULT_TABLE_NAMES);
export type ResultTableName = z.infer<typeof resultTableNameSchema>;

/**
 * Which canonical artefact a reading came out of, and which schema version it
 * declared.
 *
 * A file *name* and never a location: the directory is resolved from
 * configuration and stays inside the process (ADR 0023 §5). The version is
 * `@tcg/simulator`'s and is recorded rather than owned, exactly as
 * `jobSpecSchema.configSchemaVersion` is — M08.10 has to be able to tell a reader
 * which build wrote the numbers before deciding whether to show them.
 */
export const RESULT_DOCUMENTS = ['summary.json', 'manifest.json'] as const;
export const resultSourceSchema = z.strictObject({
  document: z.enum(RESULT_DOCUMENTS),
  schemaVersion: z.number().int().min(1),
});
export type ResultSource = z.infer<typeof resultSourceSchema>;

/**
 * One page of one result table.
 *
 * Bounded twice over: `pageInfoSchema` bounds the rows, and `MAX_RESULT_COLUMNS`
 * bounds the width. M08.26 states the rule this exists to keep — *never load
 * unlimited raw rows into the browser* — and a card table over a Wave 1 pool is
 * already 160 rows before anybody asks for a second run.
 */
export const resultTableSchema = z
  .strictObject({
    jobId: jobIdSchema,
    table: resultTableNameSchema,
    source: resultSourceSchema,
    columns: z.array(resultColumnSchema).min(1).max(MAX_RESULT_COLUMNS),
    rows: z.array(resultRowSchema).max(PAGE_SIZE_MAX),
    page: pageInfoSchema,
  })
  .refine(
    (value) => value.rows.length === value.page.returned,
    'A result table must report the number of rows it carries.',
  )
  .refine(
    (value) => value.rows.every((row) => Object.keys(row).every((key) => hasColumn(value, key))),
    'Every cell in a result table belongs to a declared column.',
  );
export type ResultTable = z.infer<typeof resultTableSchema>;

function hasColumn(table: { readonly columns: readonly ResultColumn[] }, key: string): boolean {
  return table.columns.some(
    (column) => column.key === key || column.bounds?.low === key || column.bounds?.high === key,
  );
}

/* ----------------------------------------------------------- the summary */

/** A labelled scalar, with enough on it to be printed honestly. */
export const resultReadingSchema = z.strictObject({
  key: resultKeySchema,
  label: z.string().min(1).max(80),
  value: resultCellSchema,
  kind: resultCellKindSchema,
});
export type ResultReading = z.infer<typeof resultReadingSchema>;

/** Most readings one summary carries. Bounded like everything else. */
export const MAX_RESULT_READINGS = 64;

/**
 * The counts a reader needs before they are allowed to treat a rate as evidence.
 *
 * Every one of these is on the milestone's result-rule list, and they are a
 * named object rather than four more readings because a client must not have to
 * search a list for the denominator. `usable` is the denominator of every rate in
 * the tables; `matches` is everything that was played. They differ exactly by the
 * abnormal records, which is the separation `aggregate` already enforces and this
 * makes visible.
 */
export const resultDenominatorsSchema = z
  .strictObject({
    matches: z.number().int().min(0),
    usableMatches: z.number().int().min(0),
    abnormalMatches: z.number().int().min(0),
    failedMatches: z.number().int().min(0),
    resumedMatches: z.number().int().min(0),
    /** Abnormal records by termination kind, so "excluded" is never one opaque number. */
    abnormalByKind: z.record(z.string().min(1).max(64), z.number().int().min(0)),
  })
  .refine(
    (value) => value.usableMatches + value.abnormalMatches === value.matches,
    'Usable and abnormal records must account for every record played.',
  );
export type ResultDenominators = z.infer<typeof resultDenominatorsSchema>;

/**
 * Where the run stands as evidence, carried rather than inferred.
 *
 * The M08 locked interpretation says AI results *remain calibration evidence*
 * and the panel *must not promote them to final balance conclusions*. The
 * simulator already derives that standing and writes it into `summary.json`; the
 * only thing that could go wrong at this boundary is a response shape with
 * nowhere to put it, so there is somewhere to put it and it is not optional.
 *
 * `standing` is a bare string rather than an enum because the taxonomy is
 * `@tcg/simulator`'s `EVIDENCE_STANDINGS` and a copy of it here would be a second
 * list that can disagree. What is fixed here is that the field exists, that the
 * reasons travel with it, and that `promotionRequires` — the sentence saying what
 * would have to change — is never empty.
 */
export const evidenceStandingSchema = z.strictObject({
  standing: z.string().min(1).max(40),
  reasons: z.array(z.string().min(1).max(400)).max(16),
  promotionRequires: z.string().min(1).max(600),
  /** The analysis version the standing was decided under. Recorded, never owned. */
  analysisVersion: z.number().int().min(1),
});
export type EvidenceStanding = z.infer<typeof evidenceStandingSchema>;

/**
 * A run's headline reading, assembled from the canonical directory at the moment
 * it is asked for.
 *
 * The catalog is not consulted for any number here beyond the identifiers it
 * minted. That is ADR 0023 §3 as a call graph rather than as a paragraph: the
 * entry says which run this is, and the run says what happened.
 */
export const resultSummarySchema = z.strictObject({
  jobId: jobIdSchema,
  kind: experimentKindSchema,
  configHash: contentHashSchema,
  identity: runIdentitySchema,
  source: resultSourceSchema,
  denominators: resultDenominatorsSchema,
  evidence: evidenceStandingSchema,
  readings: z.array(resultReadingSchema).max(MAX_RESULT_READINGS),
  /** Which tables have rows to fetch, and how many. Saves a client four empty requests. */
  tables: z
    .array(z.strictObject({ table: resultTableNameSchema, rows: z.number().int().min(0) }))
    .max(RESULT_TABLE_NAMES.length),
  /**
   * What this run may never be cited past, shown beside its numbers.
   *
   * Free text, and checked to be free of anything path-shaped: the sentences come
   * from a preset registry and from the simulator's own analysis, both of which
   * are inside the process, and a limitation that smuggled a directory out would
   * be the one place ADR 0023 §5 is easiest to forget.
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
export type ResultSummary = z.infer<typeof resultSummarySchema>;
