import { z } from 'zod';

import { adaptiveExperimentIdSchema, adaptiveResultTableNameSchema } from './adaptive-results.js';
import { resultArtifactNameSchema } from './artifacts.js';
import { adminErrorSchema } from './errors.js';
import { catalogFilterSchema } from './filters.js';
import {
  annotationsSchema,
  catalogBatchViewSchema,
  catalogJobViewSchema,
  MAX_JOBS_PER_BATCH,
} from './catalog.js';
import { contentIdSchema } from './content.js';
import { batchIdSchema, jobIdSchema, labelSchema } from './identity.js';
import { legalJobActions, type JobAction, type JobStatus } from './lifecycle.js';
import { pageOf, pageRequestSchema } from './pagination.js';
import { liveMatchDeckHashSchema, playerMetaFilterSchema } from './player-meta.js';
import { playerMetaResultTableNameSchema } from './player-meta-results.js';
import { presetChoiceSchema } from './presets.js';
import { savedChoiceLabelSchema } from './saved.js';
import { resultTableNameSchema } from './results.js';
import { contractVersionSchema } from './version.js';

/**
 * What an admin client asks for, and what it gets back.
 *
 * This module exists for two reasons that are easy to mistake for one.
 *
 * The first is that `ADMIN_CONTRACT_VERSION` needs an owner. ADR 0023 §7 asks
 * for a version an admin client and an admin server negotiate, and a constant
 * that no schema stamps is a number nobody can disagree over. The envelope below
 * is where it is stamped, which is what makes "current versions round-trip" and
 * "a future version is refused" statements about a real payload rather than
 * about an integer.
 *
 * The second is [ADR 0023](../../../docs/architecture/0023-admin-lab-boundary.md)
 * §5: *a request never names a filesystem path; it names an identifier that the
 * server resolves*. That is a property of the **input** types, and it is only
 * structural if there is nowhere in an input to put a path. There is not. The
 * one schema that can hold a `rootId` and a directory — `resultLocationSchema` —
 * is reachable from `catalogJobDocumentSchema` and from nothing here, and the
 * boundary test in `boundary.test.ts` reads these sources to keep it that way.
 *
 * Endpoints, methods, URLs, transport, authentication and the two limits that
 * are properties of a socket rather than of a payload live in `service.ts`,
 * added by M08.6 — the tranche that actually opened the port. M08.1 declined to
 * guess at them, and the split it left behind is the one that survived: what a
 * client *asks* is here, and what the service *is* is there.
 */

/* -------------------------------------------------------------- the envelope */

/**
 * Every request carries the contract version it was written in.
 *
 * On the request rather than only on the response, because both directions can
 * be the older build: a client that has not been reloaded since a deploy sends
 * an old request to a new server, and a client updated ahead of its server sends
 * a new one to an old server. One field, checked at both ends, covers both — and
 * `refuseFutureVersion` is what turns the second case into a readable sentence
 * instead of an unknown-field parse error.
 */
export function adminRequest<T extends z.ZodType>(payload: T) {
  return z.strictObject({
    contractVersion: contractVersionSchema,
    payload,
  });
}

/**
 * Every response says whether it worked, in a shape a client can switch on.
 *
 * A discriminated union rather than an optional `error` beside an optional
 * `data`, because the shape that can hold both can also hold neither, and a
 * client would have to check two fields to find out which happened.
 *
 * `errors` is an array rather than one error: a schema failure is naturally
 * several, `adminSchemaErrors` already returns a list, and a form that can only
 * show the first field a person got wrong makes them submit five times.
 */
export function adminResponse<T extends z.ZodType>(payload: T) {
  return z.discriminatedUnion('ok', [
    z.strictObject({
      ok: z.literal(true),
      contractVersion: contractVersionSchema,
      payload,
    }),
    z.strictObject({
      ok: z.literal(false),
      contractVersion: contractVersionSchema,
      errors: z.array(adminErrorSchema).min(1).max(64),
    }),
  ]);
}

/* ------------------------------------------------------------ list requests */

/**
 * How the catalog is browsed: a filter, a page, and nothing that resolves to a
 * file.
 *
 * `sort` is absent on purpose. The ordering is `createdAt` then ID, fixed rather
 * than chosen, because that is the ordering a continuation token encodes a
 * position in (`pagination.ts`) and a caller that could re-sort mid-listing
 * would be handing back a cursor into a sequence that no longer exists. A second
 * ordering is a thing M08.10 can ask for, with a cursor that survives it.
 */
export const listJobsRequestSchema = z.strictObject({
  filter: catalogFilterSchema.prefault({}),
  page: pageRequestSchema.prefault({}),
});
export type ListJobsRequest = z.infer<typeof listJobsRequestSchema>;
export type ListJobsRequestInput = z.input<typeof listJobsRequestSchema>;

export const listBatchesRequestSchema = z.strictObject({
  page: pageRequestSchema.prefault({}),
});
export type ListBatchesRequest = z.infer<typeof listBatchesRequestSchema>;

/** One page of jobs, as a client sees them — views, so never a stored location. */
export const jobPageSchema = pageOf(catalogJobViewSchema);
export type JobPage = z.infer<typeof jobPageSchema>;

export const batchPageSchema = pageOf(catalogBatchViewSchema);
export type BatchPage = z.infer<typeof batchPageSchema>;

/* -------------------------------------------------------- mutation requests */

/**
 * Naming one job, and naming it the only way a request may.
 *
 * A `jobId` is minted by the store and means nothing outside it; resolving it to
 * a directory is the server's move, made against configuration a client cannot
 * see. That is the whole of ADR 0023 §5 expressed as a type: there is no field
 * here for an output root, and adding one would be a visible widening rather
 * than a habit somebody let slip.
 */
export const jobRefSchema = z.strictObject({ jobId: jobIdSchema });
export type JobRef = z.infer<typeof jobRefSchema>;

export const batchRefSchema = z.strictObject({ batchId: batchIdSchema });
export type BatchRef = z.infer<typeof batchRefSchema>;

/**
 * Replacing a job's annotations.
 *
 * The whole annotation block rather than a patch, because the three fields are
 * small, a patch needs a way to say "leave this one" that is distinguishable
 * from "clear it", and `null`-means-untouched is the ambiguity this repository's
 * schemas keep refusing. A client sends what it wants the annotations to be.
 *
 * This is also the clearest statement of the authority boundary in the package:
 * an administrator may write *these three fields*, they are stored beside the
 * run, and there is no request shape anywhere that reaches into the experiment
 * directory. Marking a baseline cannot mutate canonical output because no
 * request can express mutating it.
 */
export const setJobAnnotationsRequestSchema = z.strictObject({
  jobId: jobIdSchema,
  annotations: annotationsSchema,
});
export type SetJobAnnotationsRequest = z.infer<typeof setJobAnnotationsRequestSchema>;

/**
 * The four verbs an operator has, out of the ten the lifecycle table names.
 *
 * A narrowing M08.6 made deliberately, and the reason it is a *schema* rather
 * than a check inside a handler: `start`, `complete`, `fail`, `interrupt`,
 * `pause_settled` and `cancel_settled` all belong to something that is not a
 * person. A runner reports what its attempt did and a restart records what it
 * found; both reach the store with a `cause` that says which. A request that
 * could spell `complete` would let a client mark a run finished without a single
 * match having been played, and no amount of transition checking would catch it,
 * because `running -> completed` is a perfectly legal move.
 *
 * `satisfies readonly JobAction[]` rather than a filter over `JOB_ACTIONS`,
 * because the two directions fail differently and both matter: the constraint
 * makes a verb that is *not* a lifecycle action a compile error, and
 * `requests.test.ts` asserts the complement — that every action left out is one
 * only a runner or a restart produces — so an action added later cannot be
 * quietly excluded from an operator's reach either.
 */
export const OPERATOR_JOB_ACTIONS = [
  'pause',
  'resume',
  'cancel',
  'retry',
] as const satisfies readonly JobAction[];

export const operatorJobActionSchema = z.enum(OPERATOR_JOB_ACTIONS);
export type OperatorJobAction = z.infer<typeof operatorJobActionSchema>;

/**
 * The verbs the lifecycle table allows from a state, narrowed to an operator's.
 *
 * Both halves matter. `legalJobActions` is the authority on what the table
 * permits, so this cannot offer a move the store would refuse;
 * `OPERATOR_JOB_ACTIONS` is the authority on what a request may carry, so this
 * cannot offer a move no client could send.
 *
 * It lives in the **contract** rather than in either application, and M08.9 moved
 * it here from `apps/admin-server`. M08.6 put it there with a reason —
 * *computing it in a screen rather than on the server is what keeps a stale
 * bundle from showing a button the server does not have* — and that reason
 * argues for one implementation, not for one location: a queue screen shows tens
 * of jobs at once and cannot ask `jobDetail` for each of them, so the choice was
 * between the client deriving it with a **second** copy of this expression or
 * with **this** one. The server's refusal is still the authoritative answer, and
 * `admin/illegal_transition` names what was available instead.
 */
export function operatorActionsFor(status: JobStatus): OperatorJobAction[] {
  const allowed = new Set<string>(legalJobActions(status));
  return OPERATOR_JOB_ACTIONS.filter((action) => allowed.has(action));
}

/**
 * Asking a job to change state.
 *
 * The *action* travels, never the target state. A client that sent
 * `status: 'cancelled'` would be deciding the outcome of a transition the
 * lifecycle model owns, and two clients could then disagree about what `cancel`
 * means from `running` — which is exactly the split authority `lifecycle.ts`
 * exists to prevent. The server applies `applyJobTransition` and answers with
 * the state it reached, or with `admin/illegal_transition` and the actions that
 * were available instead.
 */
export const jobActionRequestSchema = z.strictObject({
  jobId: jobIdSchema,
  action: operatorJobActionSchema,
});
export type JobActionRequest = z.infer<typeof jobActionRequestSchema>;

/* --------------------------------------------------- creation requests (M08.6) */

/**
 * A request that carries nothing.
 *
 * `z.strictObject({})` rather than an absent field, so the envelope has one shape
 * for every endpoint and a client's paging, error handling and version check are
 * written once. It is strict, so `{ nonsense: 1 }` sent to the capabilities
 * endpoint is refused rather than ignored — which is the difference between a
 * service that has a contract and one that merely has handlers.
 */
export const emptyRequestSchema = z.strictObject({});
export type EmptyRequest = z.infer<typeof emptyRequestSchema>;

/** Opening a test batch: a name, and optionally what to say about it. */
export const createBatchRequestSchema = z.strictObject({
  label: labelSchema,
  annotations: annotationsSchema.prefault({ tags: [], note: '', baseline: false }),
});
export type CreateBatchRequest = z.infer<typeof createBatchRequestSchema>;
export type CreateBatchRequestInput = z.input<typeof createBatchRequestSchema>;

/**
 * Filling a batch from a preset, which is the only way this build creates a job.
 *
 * **There is no endpoint that accepts an experiment configuration.** M08's
 * exclusions forbid *unvalidated JSON blobs*; a request carrying a whole
 * `experimentConfigSchema` document would be validated, but it would also be this
 * package expressing a shape it cannot import, and it would let a client name
 * pilots, seeds, environments and card bans no preset offers. A preset choice is
 * a bounded selection over a registry both ends already have; the server expands
 * it, and every value that reaches the simulator is assembled inside the process
 * from the format's own numbers.
 *
 * One choice becomes **one job per stage**, in the preset's own order, because a
 * preset is a plan and a stage is the unit the queue runs.
 */
export const enqueuePresetRequestSchema = z.strictObject({
  batchId: batchIdSchema,
  choice: presetChoiceSchema,
});
export type EnqueuePresetRequest = z.infer<typeof enqueuePresetRequestSchema>;
export type EnqueuePresetRequestInput = z.input<typeof enqueuePresetRequestSchema>;

/**
 * Turning a Commander Search's deferred finalist round into a scheduled one
 * (M08.15).
 *
 * `commander_search`'s own `deferredStages` entry names the reason this cannot
 * be part of `enqueuePreset`: the finalist field does not exist until the named
 * searches finish, so nothing about it can be expanded in advance. This request
 * names the **finished** batch instead of a preset choice, and the diversity
 * settings an administrator picks at the moment the searches are done rather
 * than at the moment they were started — which is also why they are not on
 * `commander_search`'s own choice: a value chosen before a single generation has
 * run cannot be recovered from anywhere durable once the searches complete, and
 * a request that named it again here needs no such memory.
 *
 * Naming a batch rather than the individual search jobs keeps the same shape
 * `startBatch` already has: an identifier the server resolves, never a location,
 * and never a caller-assembled list of job IDs it would have to re-derive the
 * membership rule for.
 */
export const scheduleChampionshipRequestSchema = z.strictObject({
  /** The `commander_search` batch every one of whose search jobs has completed. */
  batchId: batchIdSchema,
  /** How many sufficiently distinct finalists to keep, per Commander. */
  finalistsPerCommander: z.number().int().min(1).max(8).default(3),
  /** Fresh-seed games per pairing in the mirrored championship round-robin. */
  gamesPerPairing: z.number().int().min(1).max(200).default(4),
  /** The root seed the championship's own match schedule derives from. */
  seed: z.string().min(1).max(64),
});
export type ScheduleChampionshipRequest = z.infer<typeof scheduleChampionshipRequestSchema>;
export type ScheduleChampionshipRequestInput = z.input<typeof scheduleChampionshipRequestSchema>;

/* ------------------------------------------------------- queue requests (M08.9) */

/**
 * Putting a draft batch's jobs into the order they will run in.
 *
 * **The whole order travels, not a move.** A request that said *move this job up
 * one* would be a request whose meaning depends on what the batch looked like
 * when the operator pressed the button, and two screens open on the same draft
 * would each apply their move to an order the other had already changed. The
 * full array is a compare-and-set: the server requires it to be a permutation of
 * the membership it currently holds, so a client working from a stale reading is
 * refused with a sentence naming the disagreement rather than silently producing
 * an order nobody chose. That refusal *is* this contract's concurrent-update
 * answer, and it is the reason the endpoint answers with the whole batch detail
 * instead of an acknowledgement.
 *
 * It carries no new positions, no indices and no insertion points — only job
 * IDs the server already has — so there is nothing here that could name
 * something outside the batch.
 */
export const reorderBatchRequestSchema = z.strictObject({
  batchId: batchIdSchema,
  jobIds: z
    .array(jobIdSchema)
    .min(1)
    .max(MAX_JOBS_PER_BATCH)
    .refine((ids) => new Set(ids).size === ids.length, 'A job appears in its batch exactly once.'),
});
export type ReorderBatchRequest = z.infer<typeof reorderBatchRequestSchema>;

/* ----------------------------------------------------- builder requests (M08.8) */

/**
 * Asking what a choice would schedule, without scheduling it.
 *
 * M08.6 declined to add this and gave a reason worth answering rather than
 * ignoring: *the estimate travels with the jobs rather than from an endpoint of
 * its own … a separate estimate endpoint would also be an endpoint that can
 * disagree with what was created, because nothing would tie the two calls
 * together.* M08.8's requirement is the thing that changes the balance — *the
 * exact total match count shown before anything is enqueued* — and an estimate
 * that only exists after the jobs are created cannot be shown before them.
 *
 * The disagreement M08.6 feared is closed rather than accepted. Both endpoints
 * call `estimatePreset` on the choice, so the two answers differ only if the
 * content differs between the two calls — which is a real event (a rebuild, a
 * content change) and is exactly what the enqueue answer's own estimate is for
 * reporting. The preview is a reading, and the enqueue result stays the record.
 *
 * It **mutates nothing**: expanding a preset creates no batch, no job and no
 * directory, and `mutates: false` on the endpoint says so where a rate limiter
 * and an audit line can read it.
 */
export const estimateChoiceRequestSchema = z.strictObject({ choice: presetChoiceSchema });
export type EstimateChoiceRequest = z.infer<typeof estimateChoiceRequestSchema>;
export type EstimateChoiceRequestInput = z.input<typeof estimateChoiceRequestSchema>;

/**
 * Keeping a filled-in form under a name.
 *
 * There is no ID in the request, so **save always creates**. Replacing a stored
 * configuration in place would need an update path and a way to say "this one,
 * as it was" — and the thing an administrator actually does with a kept form is
 * open it, change two numbers and keep that too, which is a new one. Duplicating
 * is therefore the same call with a different label, and no verb was invented
 * for it.
 *
 * The choice is validated by `presetChoiceSchema` on the way in and expanded by
 * the server before it is stored, so a configuration that could never run is not
 * one that can be saved. What the *stored* form is not checked against is
 * content as it will be later — a precon can be withdrawn between saving and
 * reopening — which is why reopening re-validates rather than trusting.
 */
export const saveChoiceRequestSchema = z.strictObject({
  label: savedChoiceLabelSchema,
  choice: presetChoiceSchema,
});
export type SaveChoiceRequest = z.infer<typeof saveChoiceRequestSchema>;
export type SaveChoiceRequestInput = z.input<typeof saveChoiceRequestSchema>;

/**
 * One page of one of a run's result tables.
 *
 * The table is named from a closed list rather than by a path or a column
 * expression, for the same reason a job is named by an ID: the server resolves
 * the name against a run directory it already knows, and there is nowhere in this
 * shape to put a location.
 */
export const resultTableRequestSchema = z.strictObject({
  jobId: jobIdSchema,
  table: resultTableNameSchema,
  page: pageRequestSchema.prefault({}),
});
export type ResultTableRequest = z.infer<typeof resultTableRequestSchema>;
export type ResultTableRequestInput = z.input<typeof resultTableRequestSchema>;

/**
 * One canonical document of one run, named from a closed list (M08.10).
 *
 * The same rule `resultTableRequestSchema` follows, applied to a file instead of
 * a table: the artifact is an **enum member**, the server maps it onto
 * `experimentPaths` under a directory it resolved itself, and there is nowhere
 * in this shape to put a location. A request that could name `../../etc/passwd`
 * — or, far more likely, `replays/0001.json` — is unspellable rather than
 * filtered.
 */
export const resultArtifactRequestSchema = z.strictObject({
  jobId: jobIdSchema,
  artifact: resultArtifactNameSchema,
});
export type ResultArtifactRequest = z.infer<typeof resultArtifactRequestSchema>;

/**
 * Which directory-keyed Adaptive Counter run to read (M08.19C).
 *
 * Named the same way `jobRefSchema` names a catalog run — one identifying field,
 * nothing shaped like a location. The server combines `experimentId` with its own
 * configured result root exactly as `resolveResultLocation` does for every other
 * result (ADR 0023 §5): the caller never says where on disk the run lives.
 */
export const adaptiveRunRefSchema = z.strictObject({ experimentId: adaptiveExperimentIdSchema });
export type AdaptiveRunRef = z.infer<typeof adaptiveRunRefSchema>;

/**
 * One page of one Adaptive Counter run's result table (M08.19C).
 *
 * `resultTableRequestSchema` restated for a directory-keyed run instead of a
 * catalog job: `table` is named from `adaptiveResultTableNameSchema`'s closed
 * list, and there is nowhere in this shape to put a location either.
 */
export const adaptiveResultTableRequestSchema = z.strictObject({
  experimentId: adaptiveExperimentIdSchema,
  table: adaptiveResultTableNameSchema,
  page: pageRequestSchema.prefault({}),
});
export type AdaptiveResultTableRequest = z.infer<typeof adaptiveResultTableRequestSchema>;
export type AdaptiveResultTableRequestInput = z.input<typeof adaptiveResultTableRequestSchema>;

/**
 * A filtered Player Meta headline reading (M08.25C).
 *
 * Carries only `filter`: unlike an Adaptive Counter run, a Player Meta read
 * has no per-run identifier at all — the server's one configured default
 * result root already names the whole answer, and `filter` is what narrows
 * it. Nothing here is shaped like a location either.
 */
export const playerMetaRunSummaryRequestSchema = z.strictObject({
  filter: playerMetaFilterSchema.prefault({}),
});
export type PlayerMetaRunSummaryRequest = z.infer<typeof playerMetaRunSummaryRequestSchema>;
export type PlayerMetaRunSummaryRequestInput = z.input<typeof playerMetaRunSummaryRequestSchema>;

/**
 * One page of one filtered Player Meta result table (M08.25C).
 *
 * `resultTableRequestSchema` restated the way `adaptiveResultTableRequestSchema`
 * restates it for a directory-keyed run: `table` is named from
 * `playerMetaResultTableNameSchema`'s closed list, `filter` narrows which
 * matches are aggregated, and there is nowhere in this shape to put a
 * location.
 */
export const playerMetaResultTableRequestSchema = z.strictObject({
  filter: playerMetaFilterSchema.prefault({}),
  table: playerMetaResultTableNameSchema,
  page: pageRequestSchema.prefault({}),
});
export type PlayerMetaResultTableRequest = z.infer<typeof playerMetaResultTableRequestSchema>;
export type PlayerMetaResultTableRequestInput = z.input<typeof playerMetaResultTableRequestSchema>;

/**
 * One deck's Deck Explorer view (M08.26B): its exact card list, Commander,
 * observed provenance and — only when named — its Adaptive Counter revision
 * lineage.
 *
 * `adaptiveExperimentId` defaults to `null`, meaning "do not check revision
 * lineage at all," never "checked, found nothing" — see
 * `deck-explorer.ts`'s doc comment for why the two must never be confused.
 * Nothing here is shaped like a location either: the server resolves both
 * the live-match store and the named experiment's run directory itself.
 */
export const deckExplorerRequestSchema = z.strictObject({
  deckHash: liveMatchDeckHashSchema,
  adaptiveExperimentId: adaptiveExperimentIdSchema.nullable().default(null),
});
export type DeckExplorerRequest = z.infer<typeof deckExplorerRequestSchema>;
export type DeckExplorerRequestInput = z.input<typeof deckExplorerRequestSchema>;

/**
 * One card's Card Explorer view (M08.26C): eligible inclusion, partners and
 * unavailable partitions read from live matches, plus — only when a `jobId`
 * is named — draw/play/dead-hand evidence read from that job's `'cards'`
 * result table.
 *
 * `jobId` defaults to `null`, meaning "do not check job-sourced evidence at
 * all," never "checked, found nothing" — the same rule
 * `deckExplorerRequestSchema.adaptiveExperimentId` already follows, extended
 * here to a single-object answer (`card-explorer.ts`'s doc comment).
 */
export const cardExplorerRequestSchema = z.strictObject({
  cardId: contentIdSchema,
  jobId: jobIdSchema.nullable().default(null),
});
export type CardExplorerRequest = z.infer<typeof cardExplorerRequestSchema>;
export type CardExplorerRequestInput = z.input<typeof cardExplorerRequestSchema>;

/**
 * Every request payload the admin contract defines, in one object.
 *
 * Exported so a boundary test can be total over them — "no request payload admits
 * a filesystem location" is a claim about a closed set, and a set nobody
 * enumerated is a set a later tranche adds to quietly. `service.ts` requires every
 * endpoint's request schema to be one of these, so an endpoint cannot acquire a
 * private input shape this scan never sees.
 */
export const ADMIN_REQUEST_PAYLOAD_SCHEMAS = Object.freeze({
  empty: emptyRequestSchema,
  listJobs: listJobsRequestSchema,
  listBatches: listBatchesRequestSchema,
  jobRef: jobRefSchema,
  batchRef: batchRefSchema,
  setJobAnnotations: setJobAnnotationsRequestSchema,
  jobAction: jobActionRequestSchema,
  createBatch: createBatchRequestSchema,
  enqueuePreset: enqueuePresetRequestSchema,
  scheduleChampionship: scheduleChampionshipRequestSchema,
  reorderBatch: reorderBatchRequestSchema,
  estimateChoice: estimateChoiceRequestSchema,
  saveChoice: saveChoiceRequestSchema,
  resultTable: resultTableRequestSchema,
  resultArtifact: resultArtifactRequestSchema,
  adaptiveRunRef: adaptiveRunRefSchema,
  adaptiveResultTable: adaptiveResultTableRequestSchema,
  playerMetaRunSummary: playerMetaRunSummaryRequestSchema,
  playerMetaResultTable: playerMetaResultTableRequestSchema,
  deckExplorerView: deckExplorerRequestSchema,
  cardExplorerView: cardExplorerRequestSchema,
});

export type AdminRequestPayloadName = keyof typeof ADMIN_REQUEST_PAYLOAD_SCHEMAS;

export const ADMIN_REQUEST_PAYLOAD_NAMES = Object.keys(
  ADMIN_REQUEST_PAYLOAD_SCHEMAS,
) as readonly AdminRequestPayloadName[];
