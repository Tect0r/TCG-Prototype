import { z } from 'zod';

import { resultArtifactListingSchema, resultArtifactSchema } from './artifacts.js';
import {
  catalogBatchViewSchema,
  catalogJobViewSchema,
  MAX_JOBS_PER_BATCH,
  resultRootIdSchema,
} from './catalog.js';
import { contentCatalogSchema } from './content.js';
import { matchCountEstimateSchema } from './estimate.js';
import { jobEventSchema } from './events.js';
import { MAX_FILTER_VALUES } from './filters.js';
import { batchIdSchema, jobIdSchema, timestampSchema } from './identity.js';
import { jobStatusSchema, progressSchema } from './lifecycle.js';
import { PAGE_SIZE_DEFAULT, PAGE_SIZE_MAX } from './pagination.js';
import { experimentPresetDefinitionSchema, presetExpansionSchema } from './presets.js';
import {
  batchPageSchema,
  batchRefSchema,
  createBatchRequestSchema,
  emptyRequestSchema,
  enqueuePresetRequestSchema,
  estimateChoiceRequestSchema,
  jobActionRequestSchema,
  jobPageSchema,
  jobRefSchema,
  listBatchesRequestSchema,
  listJobsRequestSchema,
  operatorJobActionSchema,
  reorderBatchRequestSchema,
  resultArtifactRequestSchema,
  resultTableRequestSchema,
  saveChoiceRequestSchema,
  setJobAnnotationsRequestSchema,
  ADMIN_REQUEST_PAYLOAD_SCHEMAS,
} from './requests.js';
import { resultSummarySchema, resultTableSchema } from './results.js';
import { savedChoiceListSchema, savedChoiceViewSchema } from './saved.js';
import { ADMIN_CONTRACT_VERSION, CURRENT_ADMIN_VERSIONS } from './version.js';

/**
 * What the admin service *is*: its addresses, the shape of each answer, and the
 * three limits a caller has to know about before it sends anything.
 *
 * M08.1 wrote the payload shapes and deliberately stopped short of this module,
 * saying so: *endpoints, methods, URLs, transport, authentication, rate limits
 * and body limits are M08.6, and a contract package that guessed at them would
 * be writing the service's interface before the service exists*. M08.6 is that
 * tranche, and what it found is that only one of those seven belongs in a
 * schema-only package — the interface. Authentication is a *policy* about
 * headers and binds and is `apps/admin-server`'s; the limits are *numbers* the
 * operator's machine decides and the service reports; the interface is the thing
 * both ends have to agree on ahead of time, and disagreeing about it is what a
 * contract version exists to prevent.
 *
 * ## Everything is a POST with a JSON envelope
 *
 * One framing rather than a REST-shaped verb-and-path scheme, and the reasons are
 * all about the boundary rather than about taste:
 *
 * - **Nothing travels in a URL.** ADR 0023 §4 keeps the administrator's token out
 *   of query strings, and ADR 0023 §5 keeps filesystem locations out of requests
 *   altogether. A service whose inputs are all in a validated body has no query
 *   string to audit and no path parameter to escape.
 * - **One schema per direction, checked at both ends.** A `GET` with filters
 *   would need a second, weaker parser for query text — strings that must become
 *   numbers, repeated keys that must become arrays — and that parser would be the
 *   one place `z.strictObject` could not refuse an unknown field.
 * - **Nothing is cached by accident.** Every answer here is a reading of live
 *   state, and a browser or proxy that cached a queue listing would show an
 *   operator a run that finished ten minutes ago.
 *
 * ## The version is in the path, and it is derived
 *
 * Every address is `/admin/v{ADMIN_CONTRACT_VERSION}/{route}`, computed from the
 * constant rather than written beside it. Two things follow. A client and a
 * server built from different revisions of the contract do not silently exchange
 * payloads that happen to parse — they fail to meet at all. And because the
 * router recognises *any* `/admin/v{n}/{route}` shape, the failure is the
 * repository's readable newer-build or older-build sentence rather than a bare
 * 404: `admin/unknown_endpoint` is reserved for an address that is not an
 * endpoint under any version.
 *
 * The envelope still carries `contractVersion` as well. That is not redundancy
 * for its own sake: the path is what a proxy, a log line and a bookmark see, and
 * the envelope is what the payload was actually written against. A request that
 * agreed on one and not the other is a client assembling its URL and its body
 * from different places, which is worth refusing loudly.
 */

/* ------------------------------------------------------------------ addresses */

/** The one path prefix this service answers under. */
export const ADMIN_API_ROOT = '/admin';

/** The version segment, derived so it cannot drift from the constant it names. */
export const ADMIN_API_VERSION_SEGMENT = `v${String(ADMIN_CONTRACT_VERSION)}`;

/**
 * The shape every admin address has, whatever version it declares.
 *
 * A router matches this first and compares the captured version second, which is
 * what lets a version mismatch be answered with a sentence instead of a 404. The
 * route alphabet is deliberately narrow — lowercase letters and hyphens — so a
 * captured route can never be a traversal fragment even before it is looked up in
 * the registry.
 */
export const ADMIN_PATH_PATTERN = /^\/admin\/v(\d{1,4})\/([a-z][a-z-]{0,39})$/;

/** The address one endpoint answers at, in this build. */
export function adminEndpointPath(name: AdminEndpointName): string {
  return `${ADMIN_API_ROOT}/${ADMIN_API_VERSION_SEGMENT}/${ADMIN_ENDPOINTS[name].route}`;
}

/* ---------------------------------------------------------- what comes back */

/**
 * What this build can do, reported rather than assumed.
 *
 * M08.5 deferred one decision to this tranche in as many words: the resource
 * limits *cross no wire in this tranche, and no client sends one; M08.6 owns the
 * capabilities endpoint and decides then whether a client is told these numbers,
 * in a shape it can also decide.* The decision is **yes**, and the shape is
 * `orchestrator` below — a report, not an input. A queue screen that shows three
 * jobs waiting behind one running one is showing a bound, and a client that had
 * to guess the bound would have to explain the wait by guessing too.
 *
 * The three numbers are plain bounded integers here rather than a copy of the
 * server's `resourceLimitsSchema`. That schema refuses a per-job ceiling above
 * the whole budget and caps the total at the largest run the simulator will
 * accept; both of those are facts about the machine and about `@tcg/simulator`,
 * and a second copy of them in a package that can import neither would be a
 * validator that goes wrong quietly. What travels is what the operator's
 * configuration resolved to, and the thing that decided it stays where it can
 * check it.
 *
 * **No path, no root directory and no token.** `resultRootIds` carries the
 * identifiers an administrator configured and nothing else, which is the same
 * rule `resultLocationSchema` follows: an identifier is what a person can act on,
 * and it is not a location.
 */
export const capabilitiesSchema = z.strictObject({
  versions: z.strictObject({
    contract: z.number().int().min(1),
    catalogDocument: z.number().int().min(1),
    jobEvent: z.number().int().min(1),
    savedChoice: z.number().int().min(1),
  }),
  access: z.strictObject({
    /** Whether the service is bound to a loopback interface (ADR 0023 §4). */
    loopback: z.boolean(),
    /** Whether a request must carry the administrator token. */
    authenticationRequired: z.boolean(),
  }),
  limits: z.strictObject({
    maxRequestBytes: z.number().int().min(1),
    requestsPerWindow: z.number().int().min(1),
    windowMs: z.number().int().min(1),
    pageSizeDefault: z.literal(PAGE_SIZE_DEFAULT),
    pageSizeMax: z.literal(PAGE_SIZE_MAX),
    maxFilterValues: z.literal(MAX_FILTER_VALUES),
    maxJobsPerBatch: z.literal(MAX_JOBS_PER_BATCH),
  }),
  orchestrator: z.strictObject({
    maxConcurrentJobs: z.number().int().min(1),
    maxWorkers: z.number().int().min(1),
    maxWorkersPerJob: z.number().int().min(1),
  }),
  /** Configured result roots, by identifier. Never a path. */
  resultRootIds: z.array(resultRootIdSchema).min(1).max(16),
  /** The format every preset in this build runs in. */
  formatId: z.string().min(1).max(64),
  /** When this orchestration process came up, so a client can tell a restart. */
  startedAt: timestampSchema,
});
export type Capabilities = z.infer<typeof capabilitiesSchema>;

/** Every preset this build publishes, with the limitations each carries. */
export const presetCatalogSchema = z.strictObject({
  presets: z.array(experimentPresetDefinitionSchema).min(1).max(64),
});
export type PresetCatalog = z.infer<typeof presetCatalogSchema>;

/**
 * A batch and its members, in the batch's own order.
 *
 * Not paginated, and that is a bound rather than an omission: membership is
 * capped at `MAX_JOBS_PER_BATCH` by the document schema itself, so "the whole
 * batch" is already a bounded answer. Paginating it would also have to paginate
 * the order, which is the administrator's and is the one thing about a batch a
 * reader must see whole.
 */
export const batchDetailSchema = z
  .strictObject({
    batch: catalogBatchViewSchema,
    jobs: z.array(catalogJobViewSchema).max(MAX_JOBS_PER_BATCH),
  })
  .refine(
    (value) => value.jobs.length === value.batch.jobIds.length,
    'A batch detail carries exactly the jobs its membership names.',
  )
  .refine(
    (value) => value.jobs.every((job, index) => job.jobId === value.batch.jobIds[index]),
    'A batch detail lists its jobs in the batch’s own order.',
  );
export type BatchDetail = z.infer<typeof batchDetailSchema>;

/** Most event lines one job detail carries. The newest ones, when there are more. */
export const MAX_DETAIL_EVENTS = 200;

/**
 * One job, its history, and what the lifecycle table would let an operator do to
 * it next.
 *
 * `availableActions` is computed by the server from `legalJobActions` and sent
 * rather than left for the client to derive. Both ends have the table, so this
 * looks redundant — it is not. A screen deriving it would be a second place that
 * decides what is legal, and the moment a transition changes, a stale bundle in
 * somebody's browser would offer a button the server refuses. The server's answer
 * is the authoritative one, and it is the one that arrives with the job.
 */
export const jobDetailSchema = z.strictObject({
  job: catalogJobViewSchema,
  batchId: batchIdSchema,
  events: z.array(jobEventSchema).max(MAX_DETAIL_EVENTS),
  /** True when older lines exist that this answer did not carry. */
  eventsTruncated: z.boolean(),
  availableActions: z.array(operatorJobActionSchema).max(4),
});
export type JobDetail = z.infer<typeof jobDetailSchema>;

/**
 * How far along a job is, cheap enough to poll.
 *
 * Deliberately not the whole job document. A queue screen polls this every few
 * seconds per running job, and an endpoint that answered with annotations, a spec
 * and an execution record would be re-sending unchanged bytes forever.
 *
 * `inFlight` is the one fact the document cannot hold: it says whether *this*
 * process is currently running the job, which is how an operator tells a
 * `running` document that a crash orphaned from one a worker is actually
 * playing. It is `false` for a job this process never started, which is truthful
 * and is exactly the state M08.5 described a restart leaving behind.
 */
export const jobProgressSchema = z.strictObject({
  jobId: jobIdSchema,
  status: jobStatusSchema,
  progress: progressSchema,
  inFlight: z.boolean(),
  updatedAt: timestampSchema,
});
export type JobProgressView = z.infer<typeof jobProgressSchema>;

/**
 * What a preset choice actually created, plus what it will cost.
 *
 * The estimate travels with the jobs rather than from an endpoint of its own.
 * M08.3 built `estimatePreset` to answer *how much work is this* honestly —
 * including whether the figure is exact, an upper bound or a floor — and the
 * moment that answer matters most is the moment the work has just been queued.
 * A separate estimate endpoint would also be an endpoint that can disagree with
 * what was created, because nothing would tie the two calls together.
 */
export const enqueuePresetResultSchema = z
  .strictObject({
    batchId: batchIdSchema,
    jobs: z.array(catalogJobViewSchema).min(1).max(MAX_JOBS_PER_BATCH),
    expansion: presetExpansionSchema,
    estimate: matchCountEstimateSchema,
  })
  .refine(
    (value) => value.jobs.length === value.expansion.stages.length,
    'One job is created for each stage the preset expanded into.',
  );
export type EnqueuePresetResult = z.infer<typeof enqueuePresetResultSchema>;

/**
 * What a choice *would* schedule, answered without scheduling it (M08.8).
 *
 * The same two members `enqueuePresetResultSchema` carries minus the jobs,
 * because they are produced by the same call — `estimatePreset`, which expands
 * first and counts what it expanded into. A preview that computed its total any
 * other way would be the second scheduler ADR 0023 §2 exists to forbid, and a
 * preview that omitted the expansion would show a number with no account of what
 * the number is made of.
 *
 * The expansion travels because the milestone requires the *stages* to be
 * visible before enqueue as well as the total: a choice of four replicates is
 * four jobs, and an administrator seeing one number and receiving four queue
 * entries has been surprised by their own form.
 */
export const choiceEstimateSchema = z.strictObject({
  expansion: presetExpansionSchema,
  estimate: matchCountEstimateSchema,
});
export type ChoiceEstimate = z.infer<typeof choiceEstimateSchema>;

/* ------------------------------------------------------------- the registry */

export interface AdminEndpoint<Req extends z.ZodType, Res extends z.ZodType> {
  /** The last path segment. Lowercase and hyphens, so it can never be a traversal. */
  readonly route: string;
  readonly request: Req;
  readonly response: Res;
  /**
   * Whether calling it changes durable state.
   *
   * Recorded rather than inferred from the name, because it is what a rate
   * limiter, an audit line and a client's retry policy each need and none of
   * them should be guessing from a verb.
   */
  readonly mutates: boolean;
}

function endpoint<Req extends z.ZodType, Res extends z.ZodType>(
  spec: AdminEndpoint<Req, Res>,
): AdminEndpoint<Req, Res> {
  return spec;
}

/**
 * Every address this service answers at, with the shape of what goes each way.
 *
 * One object rather than seventeen registrations scattered through a router, so
 * three properties are checkable rather than habitual: every endpoint has a
 * request schema *and* a response schema, every request schema is one of the
 * closed set `ADMIN_REQUEST_PAYLOAD_SCHEMAS` enumerates, and the set of routes is
 * something a test can be total over. `service.test.ts` checks all three.
 *
 * The order is the order an administrator meets them: what can this build do,
 * what can it run, make something, look at what exists, act on it, watch it, read
 * what it produced.
 */
export const ADMIN_ENDPOINTS = Object.freeze({
  capabilities: endpoint({
    route: 'capabilities',
    request: emptyRequestSchema,
    response: capabilitiesSchema,
    mutates: false,
  }),
  presets: endpoint({
    route: 'presets',
    request: emptyRequestSchema,
    response: presetCatalogSchema,
    mutates: false,
  }),
  content: endpoint({
    route: 'content',
    request: emptyRequestSchema,
    response: contentCatalogSchema,
    mutates: false,
  }),
  estimateChoice: endpoint({
    route: 'estimate',
    request: estimateChoiceRequestSchema,
    response: choiceEstimateSchema,
    mutates: false,
  }),
  createBatch: endpoint({
    route: 'create-batch',
    request: createBatchRequestSchema,
    response: catalogBatchViewSchema,
    mutates: true,
  }),
  enqueuePreset: endpoint({
    route: 'enqueue-preset',
    request: enqueuePresetRequestSchema,
    response: enqueuePresetResultSchema,
    mutates: true,
  }),
  reorderBatch: endpoint({
    route: 'reorder-batch',
    request: reorderBatchRequestSchema,
    response: batchDetailSchema,
    mutates: true,
  }),
  duplicateJob: endpoint({
    route: 'duplicate-job',
    request: jobRefSchema,
    response: batchDetailSchema,
    mutates: true,
  }),
  startBatch: endpoint({
    route: 'start-batch',
    request: batchRefSchema,
    response: batchDetailSchema,
    mutates: true,
  }),
  saveChoice: endpoint({
    route: 'save-choice',
    request: saveChoiceRequestSchema,
    response: savedChoiceViewSchema,
    mutates: true,
  }),
  listSavedChoices: endpoint({
    route: 'saved-choices',
    request: emptyRequestSchema,
    response: savedChoiceListSchema,
    mutates: false,
  }),
  listBatches: endpoint({
    route: 'list-batches',
    request: listBatchesRequestSchema,
    response: batchPageSchema,
    mutates: false,
  }),
  batchDetail: endpoint({
    route: 'batch',
    request: batchRefSchema,
    response: batchDetailSchema,
    mutates: false,
  }),
  listJobs: endpoint({
    route: 'list-jobs',
    request: listJobsRequestSchema,
    response: jobPageSchema,
    mutates: false,
  }),
  jobDetail: endpoint({
    route: 'job',
    request: jobRefSchema,
    response: jobDetailSchema,
    mutates: false,
  }),
  jobAction: endpoint({
    route: 'job-action',
    request: jobActionRequestSchema,
    response: catalogJobViewSchema,
    mutates: true,
  }),
  setJobAnnotations: endpoint({
    route: 'annotate-job',
    request: setJobAnnotationsRequestSchema,
    response: catalogJobViewSchema,
    mutates: true,
  }),
  jobProgress: endpoint({
    route: 'job-progress',
    request: jobRefSchema,
    response: jobProgressSchema,
    mutates: false,
  }),
  resultSummary: endpoint({
    route: 'result-summary',
    request: jobRefSchema,
    response: resultSummarySchema,
    mutates: false,
  }),
  resultTable: endpoint({
    route: 'result-table',
    request: resultTableRequestSchema,
    response: resultTableSchema,
    mutates: false,
  }),
  resultArtifacts: endpoint({
    route: 'result-artifacts',
    request: jobRefSchema,
    response: resultArtifactListingSchema,
    mutates: false,
  }),
  resultArtifact: endpoint({
    route: 'result-artifact',
    request: resultArtifactRequestSchema,
    response: resultArtifactSchema,
    mutates: false,
  }),
});

export type AdminEndpointName = keyof typeof ADMIN_ENDPOINTS;

export const ADMIN_ENDPOINT_NAMES = Object.keys(ADMIN_ENDPOINTS) as readonly AdminEndpointName[];

/** Route segment to endpoint name, for a router that has just matched a path. */
export const ADMIN_ROUTES: ReadonlyMap<string, AdminEndpointName> = new Map(
  ADMIN_ENDPOINT_NAMES.map((name) => [ADMIN_ENDPOINTS[name].route, name]),
);

/** The request payload type one endpoint accepts, after parsing. */
export type AdminRequestOf<N extends AdminEndpointName> = z.infer<
  (typeof ADMIN_ENDPOINTS)[N]['request']
>;

/** The response payload type one endpoint answers with. */
export type AdminResponseOf<N extends AdminEndpointName> = z.infer<
  (typeof ADMIN_ENDPOINTS)[N]['response']
>;

/**
 * Every request schema an endpoint uses is one the payload registry enumerates.
 *
 * Exported as a value rather than asserted only in a test, because it is the
 * property that makes the *other* boundary check total: `boundary.test.ts` proves
 * no member of `ADMIN_REQUEST_PAYLOAD_SCHEMAS` admits a filesystem location, and
 * that proof is worth nothing if an endpoint can accept something outside the
 * set.
 */
export function endpointRequestsAreRegistered(): boolean {
  const known = new Set<unknown>(Object.values(ADMIN_REQUEST_PAYLOAD_SCHEMAS));
  return ADMIN_ENDPOINT_NAMES.every((name) => known.has(ADMIN_ENDPOINTS[name].request));
}

/** The versions this build stamps, in the shape `capabilitiesSchema` reports. */
export const CURRENT_CAPABILITY_VERSIONS = Object.freeze({
  contract: CURRENT_ADMIN_VERSIONS.contract,
  catalogDocument: CURRENT_ADMIN_VERSIONS.catalogDocument,
  jobEvent: CURRENT_ADMIN_VERSIONS.jobEvent,
  savedChoice: CURRENT_ADMIN_VERSIONS.savedChoice,
});
