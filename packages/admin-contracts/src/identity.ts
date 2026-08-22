import { z } from 'zod';

/**
 * What a batch, a job, a stage and a run are *called*, and how the admin surface
 * classifies them.
 *
 * Everything here is a name or a label. Nothing in this file knows what a job
 * does, when it may run, or where its output lives — those are `lifecycle.ts`
 * and `catalog.ts`. Keeping identity separate is what lets a filter mention a
 * job ID without importing the lifecycle model, and what makes "an ID is
 * filesystem-safe" a property of one small regular expression rather than of
 * every schema that uses one.
 */

/* --------------------------------------------------------------------- IDs */

/**
 * The body of every admin ID: lowercase letters and digits, nothing else.
 *
 * Not a stylistic choice. M08.2 uses these IDs as file and directory names under
 * the configured catalog root, so the set of characters an ID may contain *is*
 * the set a traversal would have to be built from. There is no `.`, no `/`, no
 * `\`, no `..` and no uppercase — which on a case-insensitive filesystem is a
 * second way for two different IDs to name one file.
 *
 * The lower bound of 6 and the upper bound of 40 bracket `generateId` from
 * `@tcg/shared`, which produces an 18-character body, without demanding exactly
 * its length: a test fixture may name a job `job_fixture1` and a later minting
 * strategy may be longer, and neither is a reason to refuse an otherwise safe
 * name.
 */
const ID_BODY = /^[a-z0-9]{6,40}$/;

function prefixedId(prefix: string, label: string) {
  return z
    .string()
    .min(prefix.length + 7)
    .max(prefix.length + 41)
    .refine(
      (value) => value.startsWith(`${prefix}_`) && ID_BODY.test(value.slice(prefix.length + 1)),
      `A ${label} ID is \`${prefix}_\` followed by 6–40 lowercase letters and digits.`,
    );
}

/** The prefix each kind of admin ID carries, so a stray ID is recognisable on sight. */
export const BATCH_ID_PREFIX = 'batch';
export const JOB_ID_PREFIX = 'job';

/** A test batch: the ordered collection of jobs an administrator chose. */
export const batchIdSchema = prefixedId(BATCH_ID_PREFIX, 'test batch');
export type BatchId = z.infer<typeof batchIdSchema>;

/** An experiment job: one validated execution unit in the queue. */
export const jobIdSchema = prefixedId(JOB_ID_PREFIX, 'experiment job');
export type JobId = z.infer<typeof jobIdSchema>;

/**
 * The alphabet an *authored* name uses: lowercase, starting with a letter, with
 * hyphens and underscores allowed inside.
 *
 * Deliberately looser than `ID_BODY` above and for a different reason. A minted
 * ID is a file name under the catalog root, so its alphabet is the traversal
 * defence; an authored name is typed by a person and read in a report, and it is
 * the shape `experimentConfigSchema.id` has always required.
 */
const AUTHORED_SLUG = /^[a-z][a-z0-9_-]*$/;

/**
 * A stage: a declared part of a composite job, such as a search followed by a
 * finalist round.
 *
 * A slug rather than a minted ID, and the same slug shape
 * `experimentConfigSchema.id` uses in the simulator, because a stage is
 * *authored* — M08.3 expands a preset into named stages — and an authored name
 * is the thing that has to survive being read in a report. Uniqueness is per
 * job, not global: two jobs may both have a `finalists` stage, and they are not
 * the same stage.
 */
export const stageIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(
    AUTHORED_SLUG,
    'Stage IDs are lowercase and hyphen/underscore safe, like an experiment ID.',
  );
export type StageId = z.infer<typeof stageIdSchema>;

/**
 * The name an administrator gives one experiment, in the shape the simulator's
 * `experimentConfigSchema.id` already requires.
 *
 * Restated for the reason above rather than imported, and *checked* rather than
 * trusted: M08.3 expands a preset into real configurations in
 * `apps/admin-server`, which can import both sides, and its test parses a config
 * carrying an ID this schema accepted. So the two shapes are held together by a
 * failing test rather than by two comments agreeing.
 *
 * Distinct from `stageIdSchema` despite the identical alphabet, because a stage
 * is named inside a job and an experiment is named across the catalog; giving
 * them one name would make a later divergence a rename instead of an edit.
 */
export const experimentSlugSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(
    AUTHORED_SLUG,
    'Experiment IDs are lowercase and start with a letter, like `precon-standard`.',
  );
export type ExperimentSlug = z.infer<typeof experimentSlugSchema>;

/**
 * Where a stage sits, in full.
 *
 * The ordinal travels with the ID because "which stage is running" and "how far
 * through the job is that" are different questions, and a name alone answers
 * only the first. `ordinal` is zero-based and `total` may be `null`: an adaptive
 * job discovers how many evaluation blocks it needs, and reporting a total it
 * does not have would be the second-formula mistake ADR 0023 §2 exists to
 * prevent.
 */
export const stageRefSchema = z
  .strictObject({
    stageId: stageIdSchema,
    ordinal: z.number().int().min(0).max(9999),
    total: z.number().int().min(1).max(10_000).nullable(),
  })
  .refine(
    (stage) => stage.total === null || stage.ordinal < stage.total,
    'A stage ordinal must fall inside the declared stage count.',
  );
export type StageRef = z.infer<typeof stageRefSchema>;

/* -------------------------------------------------------------- timestamps */

/**
 * An instant, as UTC ISO 8601 with milliseconds — exactly what
 * `new Date().toISOString()` produces.
 *
 * Stricter than the `isoTimestamp` a saved deck uses, deliberately. A saved deck
 * displays its timestamp; a catalog **orders** by one, and the store ADR 0023 §3
 * chose is a directory of JSON files with no index to sort for it. Fixing the
 * offset to `Z` and the precision to milliseconds makes lexicographic order and
 * chronological order the same order, which is what lets a continuation token
 * mean anything at all. A local-offset timestamp would sort wrongly against a
 * UTC one for exactly the six hours that matter.
 */
export const timestampSchema = z
  .string()
  .regex(
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    'Timestamps are UTC ISO 8601 with milliseconds, e.g. 2026-08-21T09:30:00.000Z.',
  )
  .refine((value) => !Number.isNaN(Date.parse(value)), 'Must be a real calendar instant.');
export type Timestamp = z.infer<typeof timestampSchema>;

/**
 * The four instants an admin entry records.
 *
 * `startedAt` and `completedAt` are nullable because an entry that has not
 * started has no honest value for them, and the milestone's phrasing — "started
 * and completed timestamps **where valid**" — is the requirement rather than a
 * hedge. Which of them a given status *requires* is `lifecycle.ts`'s answer, not
 * this schema's: a shape cannot know that a cancelled job never started, and
 * splitting the rule across both files would give it two homes.
 */
export const entryTimestampsSchema = z
  .strictObject({
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
    startedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
  })
  .refine((t) => t.updatedAt >= t.createdAt, 'An entry cannot be updated before it was created.')
  .refine(
    (t) => t.startedAt === null || t.startedAt >= t.createdAt,
    'An entry cannot start before it was created.',
  )
  .refine(
    (t) => t.completedAt === null || t.completedAt >= t.createdAt,
    'An entry cannot complete before it was created.',
  )
  .refine(
    (t) => t.startedAt === null || t.completedAt === null || t.completedAt >= t.startedAt,
    'An entry cannot complete before it started.',
  );
export type EntryTimestamps = z.infer<typeof entryTimestampsSchema>;

/* ---------------------------------------------------------- classification */

/**
 * Why a run was made.
 *
 * The milestone's locked interpretation keeps discovery and validation apart:
 * decks found on search games are frozen and re-evaluated on fresh seed families
 * before a validation claim is shown. Recording the intent on the entry is what
 * makes "this number came from the games that chose the deck" a machine-readable
 * fact rather than something a reader has to reconstruct from the configuration.
 */
export const EXPERIMENT_PURPOSES = ['exploration', 'validation'] as const;
export const experimentPurposeSchema = z.enum(EXPERIMENT_PURPOSES);
export type ExperimentPurpose = z.infer<typeof experimentPurposeSchema>;

/**
 * What kind of evidence a run holds, using exactly the six words the milestone
 * uses.
 *
 * The M08 locked interpretation says raw AI, human, mixed, precon, search and
 * adaptive results stay distinguishable and are never pooled into one
 * unexplained win rate. It does **not** say how those six decompose, and M08.1
 * has no authority to decide that they are two axes: a precon benchmark flown by
 * pilots is both `ai` and `precon`, so one enum could not hold it, while
 * inventing an axis would mean inventing a seventh word for the deck a person
 * built themselves. So an entry carries a *set*, and the set is the whole
 * classification.
 */
export const SOURCE_CLASSES = ['ai', 'human', 'mixed', 'precon', 'search', 'adaptive'] as const;
export const sourceClassSchema = z.enum(SOURCE_CLASSES);
export type SourceClass = z.infer<typeof sourceClassSchema>;

/** The three that answer "who decided the plays", named so the rule below is readable. */
const DECIDED_BY: readonly SourceClass[] = ['ai', 'human', 'mixed'];

/**
 * The classification of one entry: non-empty, duplicate-free, canonically
 * ordered.
 *
 * Canonical order — `SOURCE_CLASSES` order rather than the order somebody typed
 * — because two entries with the same classification must serialize to the same
 * bytes, or the content-addressed comparison M08.27 needs would report a
 * difference that is only a difference of typing.
 *
 * One combination is refused: `mixed` beside `ai` or `human`. `mixed` is defined
 * as the combination of the other two, so an entry claiming both would be making
 * two different claims about one question. Every other combination is legal,
 * including the empty-looking ones — a human match on a deck its player built is
 * simply `['human']`, and needs no word this milestone has not written down.
 */
export const sourceClassesSchema = z
  .array(sourceClassSchema)
  .min(1)
  .max(SOURCE_CLASSES.length)
  .refine((classes) => new Set(classes).size === classes.length, 'Source classes must be distinct.')
  .refine(
    (classes) => classes.every((value, index) => value === canonicalSourceClasses(classes)[index]),
    'Source classes are recorded in the order `SOURCE_CLASSES` declares them.',
  )
  .refine(
    (classes) =>
      !classes.includes('mixed') ||
      !classes.some((value) => value !== 'mixed' && DECIDED_BY.includes(value)),
    '`mixed` already means both AI and human decisions, so it cannot be recorded beside either.',
  );

/** Sorts and de-duplicates a classification into the canonical order above. */
export function canonicalSourceClasses(classes: readonly SourceClass[]): SourceClass[] {
  return SOURCE_CLASSES.filter((value) => classes.includes(value));
}

/**
 * The five experiment kinds `experimentConfigSchema` discriminates on.
 *
 * Restated here rather than imported, and the reason is the dependency direction
 * ADR 0001 fixed: `@tcg/simulator` is an application, every `packages/*`
 * workspace depends only on other packages, and a schema-only contract that
 * imported the simulator would drag `node:fs`, a worker pool and a CLI into the
 * admin client's bundle. The reference boundary is therefore the *word*, and the
 * word is all the catalog needs — it filters and labels by kind, and never
 * expands one into a configuration.
 *
 * The seam that needs both sides — "every kind here is a kind the simulator
 * really has" — belongs to M08.4, the tranche that translates a job into a
 * config and is the first layer able to import both. That is where
 * `@tcg/bot-interface` keeps the matching "every style names a real pilot" check
 * for `@tcg/bot-config`, for the same reason.
 */
export const EXPERIMENT_KINDS = [
  'batch',
  'search',
  'comparison',
  'replacement',
  'robustness',
] as const;
export const experimentKindSchema = z.enum(EXPERIMENT_KINDS);
export type ExperimentKind = z.infer<typeof experimentKindSchema>;

/**
 * A content address produced by the simulator's `digest`: lowercase hex,
 * truncated to a documented length.
 *
 * The range is 8–64 rather than the 16 `digest` defaults to, because the length
 * is an argument there and a catalog written today has to stay readable when a
 * later tranche asks for a longer one. What is *not* negotiable is the alphabet:
 * a hash that is not hex is not a hash this repository produced.
 */
export const contentHashSchema = z
  .string()
  .min(8)
  .max(64)
  .regex(/^[0-9a-f]+$/, 'A content hash is lowercase hexadecimal.');
export type ContentHash = z.infer<typeof contentHashSchema>;

/** A human label. Optional in effect — an empty string falls back to the ID it names. */
export const labelSchema = z.string().max(120);

/**
 * An administrator's tag. Same alphabet as an ID body plus separators, because a
 * tag is typed by a person and `precon-smoke` reads better than `preconsmoke`.
 */
export const tagSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, 'Tags are lowercase letters, digits, underscores and dashes.');
export type Tag = z.infer<typeof tagSchema>;
