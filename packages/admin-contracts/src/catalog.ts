import { z } from 'zod';

import { adminErrorSchema } from './errors.js';
import {
  batchIdSchema,
  contentHashSchema,
  entryTimestampsSchema,
  experimentKindSchema,
  experimentPurposeSchema,
  experimentSlugSchema,
  jobIdSchema,
  labelSchema,
  sourceClassesSchema,
  stageIdSchema,
  tagSchema,
  timestampSchema,
  type EntryTimestamps,
} from './identity.js';
import { experimentPresetIdSchema } from './presets.js';
import {
  batchStatusSchema,
  isTerminalJobStatus,
  jobStatusSchema,
  JOB_STATUSES_REQUIRING_START,
  progressSchema,
  type JobStatus,
} from './lifecycle.js';
import { catalogDocumentVersionSchema } from './version.js';

/**
 * The catalog: an **index** of experiment directories, and never a second copy
 * of what is in them.
 *
 * ADR 0023 §3 is the whole of the design and it is worth restating because every
 * schema below is shaped by it. An experiment directory is the deliverable
 * (ADR 0012). A catalog entry records which directory a job produced, the hashes
 * that identify the run inside it, the lifecycle the administrator drove, and
 * the annotations the administrator added. It records **no result**. Every
 * number a result view shows is read back out of `manifest.json`, `summary.json`
 * and `matches.jsonl` at the moment it is shown, because a copy is a thing that
 * can disagree with the original and the original is the evidence.
 *
 * Two consequences are load-bearing rather than incidental, and the suite states
 * both:
 *
 * - **Deleting a catalog entry does not delete an experiment directory.** The
 *   entry holds a reference; a reference is not ownership. Nothing in this
 *   package can express "remove the run".
 * - **A directory with no catalog entry is still valid evidence.** The catalog
 *   is how a person finds a run, not what makes one real.
 */

/* ---------------------------------------------------- the two projections */

/**
 * Where a run's directory lives, as the store knows it: a configured root named
 * by identifier, plus a relative path inside it.
 *
 * This is the **persisted** half of a result reference and it never leaves the
 * server. ADR 0023 §5 says a request names an identifier the server resolves and
 * never a filesystem path, so `rootId` is an identifier that means nothing
 * without the server's configuration — resolving it, checking the real path
 * against its root and refusing a symlink escape are M08.2's and M08.6's, and
 * this schema deliberately cannot do any of them.
 *
 * What it *can* do is refuse a reference that could never be safe. Each segment
 * is a plain name: no `..`, no absolute prefix, no drive letter, no separator
 * other than the `/` between segments, and a bounded depth. A traversal has to
 * be spelled with characters this schema does not admit.
 */
export const RESULT_PATH_MAX_SEGMENTS = 4;

export const resultRootIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[a-z0-9][a-z0-9_-]*$/,
    'A result root is named by identifier, not by path. The server resolves it.',
  );

const pathSegment = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export const experimentDirectorySchema = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !value.startsWith('/') && !value.includes('\\'), 'Use a relative POSIX path.')
  .refine(
    (value) => {
      const segments = value.split('/');
      return (
        segments.length <= RESULT_PATH_MAX_SEGMENTS &&
        segments.every((segment) => pathSegment.test(segment) && segment !== '..')
      );
    },
    `A directory is at most ${String(RESULT_PATH_MAX_SEGMENTS)} plain segments, with no \`..\`.`,
  );

export const resultLocationSchema = z.strictObject({
  rootId: resultRootIdSchema,
  directory: experimentDirectorySchema,
});
export type ResultLocation = z.infer<typeof resultLocationSchema>;

/**
 * The four content addresses one resolved environment carries.
 *
 * Restated from `@tcg/simulator`'s `environmentHashesSchema` for the dependency
 * reason `EXPERIMENT_KINDS` gives — the simulator is an application, and a
 * schema-only package that imported it would drag `node:fs` and a worker pool
 * into the admin client's bundle. What is copied is four field *names*; the
 * hashes themselves are computed there and only ever read here.
 *
 * Four rather than one, and this is the correction M08.1 makes to its own first
 * draft. There is no single "content hash" on a manifest: M01.3 split the
 * address by the question it answers, because a typo fix in flavour text used to
 * invalidate every experiment that had ever used the card. A catalog that
 * flattened them back into one field would re-create exactly that, and would
 * leave M08.27 unable to tell "these runs would replay identically" from "these
 * runs are byte-identical" — which is the difference between a legitimate
 * comparison and a refused one.
 */
export const environmentContentHashesSchema = z.strictObject({
  /** Executable rules only. Two runs agreeing here would replay identically. */
  mechanicsHash: contentHashSchema,
  /** Mechanics plus the authored metadata pilots and deck generation read. */
  pilotInputHash: contentHashSchema,
  /** Names, printed text and curated help. Cannot change a match. */
  presentationHash: contentHashSchema,
  /** The complete resolved content. The artefact's content address. */
  fullContentHash: contentHashSchema,
});
export type EnvironmentContentHashes = z.infer<typeof environmentContentHashesSchema>;

/**
 * One environment a run played in, by name and by content address.
 *
 * An array rather than a single "the run's content hash", because two of the
 * five experiment kinds — `comparison` and `replacement` — exist precisely to
 * play *different* content against itself, and a manifest records one entry per
 * environment with no field marking any of them primary. Privileging the first
 * would be inventing an authority the canonical artefact does not have.
 */
export const MAX_ENVIRONMENTS_PER_RUN = 16;

export const runEnvironmentRefSchema = z.strictObject({
  /** The environment's own `id` from the configuration. Lowercase snake_case. */
  environmentId: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'Environment IDs are lowercase_snake_case.'),
  hashes: environmentContentHashesSchema,
});
export type RunEnvironmentRef = z.infer<typeof runEnvironmentRefSchema>;

/**
 * What names the run itself, independently of where it is stored.
 *
 * Every field is an identity, and identity is the one thing a catalog is allowed
 * to hold: the experiment's own ID and kind, the seed everything else derives
 * from, the configuration hash, the content addresses of the environments it
 * played in, and the manifest version the directory was written with. None of
 * them is a result — none of them says who won anything — and all of them are
 * readable back out of `manifest.json`, which is what makes the copy checkable
 * rather than authoritative.
 *
 * `manifestSchemaVersion` is recorded rather than owned. M08.10 has to tell a
 * reader "this run was written by a build whose manifests were version 8" before
 * refusing or reading it, and it must be able to do that without opening the
 * file. The number moves when `@tcg/simulator` moves it; nothing here moves it,
 * and `CATALOG_DOCUMENT_VERSION` deliberately does not move with it.
 */
export const runIdentitySchema = z.strictObject({
  /** The `id` from the experiment configuration. Lowercase slug, authored. */
  experimentId: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_-]*$/, 'Experiment IDs are lowercase and hyphen/underscore safe.'),
  kind: experimentKindSchema,
  /** The root seed. Everything in the run derives from it. */
  seed: z.string().min(1).max(64),
  /** Hash of the validated configuration the run was started from. */
  configHash: contentHashSchema,
  /** Every environment the run played in, in the manifest's own order. */
  environments: z
    .array(runEnvironmentRefSchema)
    .min(1)
    .max(MAX_ENVIRONMENTS_PER_RUN)
    .refine(
      (environments) =>
        new Set(environments.map((environment) => environment.environmentId)).size ===
        environments.length,
      'An environment appears in a run once.',
    ),
  /** The manifest version the directory carries, read rather than owned. */
  manifestSchemaVersion: z.number().int().min(1),
  /** The commit that produced the run, when the run could detect one. */
  softwareCommit: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/, 'A software commit is a lowercase hex git object name.')
    .nullable(),
});
export type RunIdentity = z.infer<typeof runIdentitySchema>;

/**
 * Every `fullContentHash` a run saw, in canonical order.
 *
 * The one derivation the filter needs, kept here beside the shape it reads so a
 * store and a screen cannot disagree about what "this run's content" means when
 * a run has more than one environment.
 */
export function fullContentHashesOf(identity: RunIdentity): string[] {
  return [...new Set(identity.environments.map((e) => e.hashes.fullContentHash))].sort();
}

/**
 * The persisted reference: identity plus location.
 *
 * Written to the catalog document, read by the server, and never serialized to a
 * client.
 */
export const storedResultReferenceSchema = z.strictObject({
  identity: runIdentitySchema,
  location: resultLocationSchema,
});
export type StoredResultReference = z.infer<typeof storedResultReferenceSchema>;

/**
 * The client-visible reference: identity, and nothing that could be resolved
 * into a file.
 *
 * A separate schema rather than a documented habit, for the reason
 * `@tcg/bot-config` gives for `BotSeatPublic`: privacy that is a type cannot be
 * forgotten, and the failure being guarded against is a field being *added*
 * later. There is no `location` here to strip, so a future tranche that wants
 * one has to widen this schema deliberately and explain itself in review.
 */
export const resultReferenceSchema = z.strictObject({
  identity: runIdentitySchema,
});
export type ResultReference = z.infer<typeof resultReferenceSchema>;

/**
 * The only route from the stored reference to the client-visible one.
 *
 * A function rather than a spread at each call site, because the one thing that
 * must never happen — a configured root or a real directory reaching a browser —
 * is exactly what hand-building would eventually do.
 */
export function resultReferenceOf(stored: StoredResultReference): ResultReference {
  return { identity: stored.identity };
}

/* ------------------------------------------------ what a job will run */

/**
 * What a job runs, recorded before it runs it.
 *
 * M08.2 shipped a job document with no configuration reference at all and wrote
 * down what that cost: *a queued job has no kind to filter on*, because the only
 * place a kind appeared was inside a result, and a job acquires a result when it
 * has already finished. M08.4 is the tranche identity.ts named for closing that
 * — *the seam that needs both sides belongs to M08.4, the tranche that
 * translates a job into a config* — and this is the shape it closes it with.
 *
 * **Identity, and not the configuration itself.** The configuration is
 * `experimentConfigSchema`'s, which is `@tcg/simulator`'s, and a schema-only
 * package cannot import an application (ADR 0001, and the reason
 * `EXPERIMENT_KINDS` is restated rather than imported). Restating it here would
 * be the second copy of the experiment schema this milestone forbids, and it
 * would be a copy that drifts the first time the simulator adds a field. So the
 * catalog holds the **address** of the run — what it is called, what kind it is,
 * what seed everything derives from, and the hash of the normalized
 * configuration — and `apps/admin-server` keeps the configuration itself beside
 * the job, in the simulator's own schema, where the simulator can validate it.
 *
 * `configHash` is the load-bearing field. It is `configHashOf`'s answer, the
 * same value the run stamps into `manifest.json` and into `matches.header.json`,
 * so "is this partial stream the one this job was resuming" is a comparison
 * rather than a hope — and it deliberately excludes `output` and `workers`,
 * which is what lets a job resume into its own directory with a different worker
 * count.
 */
export const jobSpecSchema = z.strictObject({
  /** The `id` from the experiment configuration. */
  experimentId: experimentSlugSchema,
  kind: experimentKindSchema,
  /** The root seed. Everything in the run derives from it. */
  seed: z.string().min(1).max(64),
  /** Hash of the normalized configuration, excluding where and how fast it runs. */
  configHash: contentHashSchema,
  /**
   * The configuration schema version the stored configuration declares.
   *
   * Recorded rather than owned, exactly as `manifestSchemaVersion` is: the
   * number is `@tcg/simulator`'s `CONFIG_SCHEMA_VERSION`, and writing it down
   * lets a reader say which build's schema the stored configuration was written
   * against without opening it.
   */
  configSchemaVersion: z.number().int().min(1),
});
export type JobSpec = z.infer<typeof jobSpecSchema>;

/* ------------------------------------------------------ how a job ran */

/**
 * How the run was executed.
 *
 * One member, and the enum exists so the answer is a recorded fact rather than
 * an assumption a later reader has to make. ADR 0023 §2 allows a second: *where
 * a child process is genuinely required, it is spawned with a fixed executable
 * and a fixed argument vector*. M08.4 does not require one — the simulator is a
 * library and is called as one — and the day a tranche does, an existing job's
 * record still says which of the two produced it.
 */
export const JOB_EXECUTION_MODES = [
  /**
   * `runExperiment` called in the orchestration process, with the simulator's
   * own worker threads underneath it.
   *
   * There is no argument vector anywhere on this path, which is the strongest
   * available form of "no admin input is ever concatenated into a command
   * string": the pool starts a fixed bootstrap module and hands it a
   * schema-validated setup object over the worker channel.
   */
  'in_process_workers',
] as const;
export const jobExecutionModeSchema = z.enum(JOB_EXECUTION_MODES);
export type JobExecutionMode = z.infer<typeof jobExecutionModeSchema>;

/** Attempts are bounded because a retry is a person pressing a button. */
export const MAX_JOB_ATTEMPTS = 1000;

const executionCore = {
  mode: jobExecutionModeSchema,
  /** How many simulator workers the latest attempt was given. Non-semantic. */
  workers: z.number().int().min(1).max(64),
  /** How many times this job has been started, including the current attempt. */
  attempts: z.number().int().min(1).max(MAX_JOB_ATTEMPTS),
  /** When the latest attempt started. Distinct from `timestamps.startedAt`, which is the first. */
  lastStartedAt: timestampSchema,
  /**
   * Matches the latest attempt found already committed to the canonical stream.
   *
   * Read from the run's own `matches.jsonl` rather than remembered, which is
   * what makes it a statement about the evidence on disk and not about what this
   * process believes it did.
   */
  resumedMatches: z.number().int().min(0),
};

/**
 * The persisted half: everything above, plus the directory the job owns.
 *
 * **One job, one canonical experiment directory, and the mapping is a name
 * rather than a promise.** The directory is the job's own minted ID, whose
 * alphabet `identity.ts` restricts to lowercase letters and digits precisely
 * because M08.2 uses these IDs as file names. Two jobs therefore cannot share a
 * directory and one job cannot have two, and neither fact depends on anybody
 * remembering it.
 *
 * The location is written once, at the first start, and reused by every later
 * attempt. That is what "resume identity preserved on failure" means in a
 * document: a retry continues the stream it already has rather than starting a
 * second one somewhere else because configuration moved underneath it.
 */
export const jobExecutionSchema = z.strictObject({
  location: resultLocationSchema,
  ...executionCore,
});
export type JobExecution = z.infer<typeof jobExecutionSchema>;

/**
 * The client-visible half: the same record with no location.
 *
 * A separate schema for the reason `resultReferenceSchema` gives — there is
 * nothing here to strip, so a future tranche that wants a location on a screen
 * has to widen this deliberately.
 */
export const jobExecutionViewSchema = z.strictObject({ ...executionCore });
export type JobExecutionView = z.infer<typeof jobExecutionViewSchema>;

/** The only route from the persisted execution record to the client-visible one. */
export function jobExecutionViewOf(execution: JobExecution): JobExecutionView {
  const { location: _location, ...rest } = execution;
  return rest;
}

/* -------------------------------------------------------------- annotations */

/**
 * What an administrator may add beside a run.
 *
 * ADR 0023 §3 allows exactly this much: tags, and a baseline mark. The note is
 * the third because M08.10 requires notes, and M08.27 requires an annotation to
 * be able to say *why* a candidate change was tested — additively, and without
 * rewriting historical raw output. Nothing here reaches the experiment
 * directory: annotations are stored beside the run, which is what
 * "mark as baseline never mutates canonical experiment output" means in a
 * schema.
 */
export const MAX_TAGS = 32;
export const MAX_NOTE_LENGTH = 4000;

export const annotationsSchema = z
  .strictObject({
    tags: z.array(tagSchema).max(MAX_TAGS),
    note: z.string().max(MAX_NOTE_LENGTH),
    /** A run deliberately pinned for later comparison (M08.27). */
    baseline: z.boolean(),
  })
  .refine((a) => new Set(a.tags).size === a.tags.length, 'Tags must be distinct.');
export type Annotations = z.infer<typeof annotationsSchema>;

export const NO_ANNOTATIONS: Annotations = Object.freeze({
  tags: [],
  note: '',
  baseline: false,
});

/* --------------------------------------------- status/timestamp agreement */

/**
 * Which instants a status requires, in one place.
 *
 * Two rules, and both are structural rather than stylistic:
 *
 * - **A terminal status has a completion instant, and a non-terminal one has
 *   none.** This is what makes `retry` honest: `failed → queued` is only a legal
 *   *document* if the completion instant is cleared, so a retried job cannot sit
 *   in the queue still claiming it finished at half past two.
 * - **A status that is unreachable without starting has a start instant.**
 *   Derived from the transition table by `JOB_STATUSES_REQUIRING_START`, so a
 *   job cancelled straight out of the queue is allowed to have never started and
 *   a completed one is not.
 *
 * Exported because M08.2 validates documents on read as well as on write and
 * must apply the same rule; a second copy inside the store would be the split
 * authority this package exists to prevent.
 */
export function statusTimestampProblems(status: JobStatus, timestamps: EntryTimestamps): string[] {
  const problems: string[] = [];
  const terminal = isTerminalJobStatus(status);
  if (terminal && timestamps.completedAt === null) {
    problems.push(`A job in \`${status}\` has finished, so it must record \`completedAt\`.`);
  }
  if (!terminal && timestamps.completedAt !== null) {
    problems.push(`A job in \`${status}\` has not finished, so \`completedAt\` must be null.`);
  }
  if (JOB_STATUSES_REQUIRING_START.includes(status) && timestamps.startedAt === null) {
    problems.push(
      `A job cannot reach \`${status}\` without starting, so \`startedAt\` is required.`,
    );
  }
  return problems;
}

/* ------------------------------------------------------ where a job came from */

/**
 * What asked for this job, recorded on the job rather than remembered elsewhere.
 *
 * M08.6 needed this to keep a promise the milestone makes about **results**, not
 * about queues: *evidence-claim and calibration standing* and a preset's
 * *limitations* must be visible before a reader may treat a number as evidence,
 * and `PRESET_REGISTRY` states each preset's limitations exactly so they are not
 * authored at the point of display. Binding them to a finished run needs the run
 * to know which preset produced it, and nothing before this field could say.
 *
 * The alternative was a tag. It was rejected: an administrator's tags are theirs
 * to add and remove, so a limitation reachable through one is a limitation that
 * disappears the moment somebody tidies up — which is the exact failure mode
 * `presets.ts` gives as the reason limitations live in the registry at all.
 *
 * `direct` is a real member rather than a placeholder. `CatalogStore.createJob`
 * takes a validated `ExperimentConfig`, so a job can be created from a
 * configuration that came from nowhere in particular — every M08.4 and M08.5
 * test does — and a shape that could only say "preset" would have to lie about
 * those. It carries no limitations, and that is truthful: a hand-assembled
 * configuration has made no claim about what it may not be cited for.
 */
export const jobOriginSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('preset'),
    presetId: experimentPresetIdSchema,
    /** Which stage of the preset's plan this job is. */
    stageId: stageIdSchema,
  }),
  z.strictObject({ kind: z.literal('direct') }),
]);
export type JobOrigin = z.infer<typeof jobOriginSchema>;

/** What a job records when nothing named a preset. */
export const DIRECT_JOB_ORIGIN: JobOrigin = Object.freeze({ kind: 'direct' });

/* ------------------------------------------------------ the job documents */

const jobCore = {
  jobId: jobIdSchema,
  /** The batch this job belongs to. Every job belongs to exactly one. */
  batchId: batchIdSchema,
  label: labelSchema,
  /** What this job runs. Present from creation, so a queued job has a kind. */
  spec: jobSpecSchema,
  /** What asked for it. Present from creation, for the reason `jobOriginSchema` gives. */
  origin: jobOriginSchema,
  purpose: experimentPurposeSchema,
  sourceClasses: sourceClassesSchema,
  status: jobStatusSchema,
  progress: progressSchema,
  timestamps: entryTimestampsSchema,
  annotations: annotationsSchema,
  /** Why it failed, when it did. Structured, and its context is checked to be safe. */
  failure: adminErrorSchema.nullable(),
};

/** The shared status/timestamp check, applied to both job shapes from one function. */
const statusTimestampCheck = (
  entry: { readonly status: JobStatus; readonly timestamps: EntryTimestamps },
  ctx: z.RefinementCtx,
): void => {
  for (const problem of statusTimestampProblems(entry.status, entry.timestamps)) {
    ctx.addIssue({ code: 'custom', message: problem, path: ['timestamps'] });
  }
};

/**
 * One job as it is persisted under the catalog root.
 *
 * The document is the version-stamped one: a file outlives the process that
 * wrote it, so it declares what it was written in and is refused rather than
 * guessed at when that number is from the future. It also holds the `location`,
 * which the view below does not.
 */
export const catalogJobDocumentSchema = z
  .strictObject({
    documentVersion: catalogDocumentVersionSchema,
    ...jobCore,
    /** Null until the job has been started once. Never cleared afterwards. */
    execution: jobExecutionSchema.nullable(),
    result: storedResultReferenceSchema.nullable(),
  })
  .superRefine(statusTimestampCheck);
export type CatalogJobDocument = z.infer<typeof catalogJobDocumentSchema>;

/**
 * One job as the admin client sees it.
 *
 * No `documentVersion` — the client negotiated `ADMIN_CONTRACT_VERSION` on the
 * request and has no business knowing how the server files things — and no
 * `location`, because there is no client-side use for a server path that is not
 * also a way to leak one.
 */
export const catalogJobViewSchema = z
  .strictObject({
    ...jobCore,
    execution: jobExecutionViewSchema.nullable(),
    result: resultReferenceSchema.nullable(),
  })
  .superRefine(statusTimestampCheck);
export type CatalogJobView = z.infer<typeof catalogJobViewSchema>;

/** The only route from the persisted job document to the client-visible view. */
export function catalogJobViewOf(document: CatalogJobDocument): CatalogJobView {
  const { documentVersion: _documentVersion, execution, result, ...rest } = document;
  return {
    ...rest,
    execution: execution === null ? null : jobExecutionViewOf(execution),
    result: result === null ? null : resultReferenceOf(result),
  };
}

/* ---------------------------------------------------- the batch documents */

/** A batch holds at most this many jobs. Bounded because a queue a person built has a size. */
export const MAX_JOBS_PER_BATCH = 500;

const batchCore = {
  batchId: batchIdSchema,
  label: labelSchema,
  status: batchStatusSchema,
  timestamps: entryTimestampsSchema,
  annotations: annotationsSchema,
  /**
   * Ordered membership, by reference.
   *
   * IDs rather than embedded documents, because M08.2 requires ordered
   * membership *and* independent jobs: a job that lived inside its batch's file
   * could not be written while a sibling was being written, and its lifecycle
   * would be the batch's by construction. The order is the administrator's, so
   * it is the array's order and not a sort.
   */
  jobIds: z
    .array(jobIdSchema)
    .max(MAX_JOBS_PER_BATCH)
    .refine((ids) => new Set(ids).size === ids.length, 'A job appears in its batch exactly once.'),
};

export const catalogBatchDocumentSchema = z.strictObject({
  documentVersion: catalogDocumentVersionSchema,
  ...batchCore,
});
export type CatalogBatchDocument = z.infer<typeof catalogBatchDocumentSchema>;

export const catalogBatchViewSchema = z.strictObject({ ...batchCore });
export type CatalogBatchView = z.infer<typeof catalogBatchViewSchema>;

export function catalogBatchViewOf(document: CatalogBatchDocument): CatalogBatchView {
  const { documentVersion: _documentVersion, ...rest } = document;
  return rest;
}
