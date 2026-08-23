import {
  CURRENT_CAPABILITY_VERSIONS,
  MAX_DETAIL_EVENTS,
  MAX_FILTER_VALUES,
  MAX_JOBS_PER_BATCH,
  OPERATOR_JOB_ACTIONS,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PRESET_REGISTRY,
  canonicalSourceClasses,
  catalogBatchViewOf,
  adminError,
  catalogJobViewOf,
  legalJobActions,
  type AdminEndpointName,
  type AdminRequestOf,
  type AdminResponseOf,
  type BatchDetail,
  type BatchId,
  type CatalogJobView,
  type Capabilities,
  type EnqueuePresetResult,
  type JobDetail,
  type JobId,
  type JobProgressView,
  type JobStatus,
  type OperatorJobAction,
  type PresetCatalog,
} from '@tcg/admin-contracts';
import { err, isErr, ok } from '@tcg/shared';

import type { CatalogResult, CatalogStore } from '../catalog/store.js';
import { PRESET_FORMAT_ID, PresetRefused, scrubRefusal } from '../lab/expand.js';
import { estimatePreset } from '../lab/estimate.js';
import type { JobQueue } from '../run/queue.js';
import type { AdminServiceConfig } from './config.js';
import { ResultReader } from './results.js';

/**
 * One function per endpoint, over the store and the queue that already exist.
 *
 * Nothing here knows about sockets, headers, status codes or tokens — `http.ts`
 * owns all four — and nothing here re-implements a rule the layers below already
 * hold. That division is what keeps the tranche's central promise checkable:
 * *simulator rules, scheduling, deck legality, aggregation and report meaning
 * remain authoritative and are never duplicated in the admin layer*. Read down
 * the file and every handler is a translation:
 *
 * - the **lifecycle** answers what a verb does (`JobQueue`, `applyJobAction`);
 * - the **simulator** answers what a preset expands into and how many matches
 *   that is (`expandPreset`, `estimatePreset`, and `buildSchedule` beneath them);
 * - the **run directory** answers what happened (`ResultReader`);
 * - the **catalog** answers what exists.
 *
 * The one thing this layer decides for itself is *which* of those to ask, and the
 * one policy it enforces is that a job is created from a preset and from nothing
 * else.
 */

export interface AdminServiceOptions {
  readonly config: AdminServiceConfig;
  readonly store: CatalogStore;
  readonly queue: JobQueue;
  /** When this process came up. Reported so a client can tell a restart from a stall. */
  readonly startedAt?: Date;
}

/** Every handler answers the same way the store does: a value, or structured refusals. */
type Handler<N extends AdminEndpointName> = (
  payload: AdminRequestOf<N>,
) => Promise<CatalogResult<AdminResponseOf<N>>>;

export class AdminService {
  readonly #config: AdminServiceConfig;
  readonly #store: CatalogStore;
  readonly #queue: JobQueue;
  readonly #results: ResultReader;
  readonly #startedAt: string;

  constructor(options: AdminServiceOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#queue = options.queue;
    this.#results = new ResultReader({ store: options.store, roots: options.config.roots });
    this.#startedAt = (options.startedAt ?? new Date()).toISOString();
  }

  get config(): AdminServiceConfig {
    return this.#config;
  }

  /**
   * Dispatches one already-parsed request to its handler.
   *
   * The cast is the one place in this file where the registry's per-endpoint
   * typing has to be collapsed: `ADMIN_ENDPOINTS` is a heterogeneous map and
   * TypeScript cannot prove that a handler looked up by a runtime name matches
   * the payload looked up by the same name. It is narrowed to exactly this
   * function, the payload arrives already parsed by that endpoint's own schema,
   * and the answer is re-validated by that endpoint's response schema before it
   * leaves — so the property the cast gives up is recovered on both sides of it.
   */
  async handle<N extends AdminEndpointName>(
    name: N,
    payload: AdminRequestOf<N>,
  ): Promise<CatalogResult<AdminResponseOf<N>>> {
    const handler = this.#handlers()[name] as Handler<N>;
    return handler(payload);
  }

  #handlers(): { [N in AdminEndpointName]: Handler<N> } {
    return {
      capabilities: async () => ok(this.#capabilities()),
      presets: async () => ok(this.#presets()),
      createBatch: (payload) => this.#createBatch(payload),
      enqueuePreset: (payload) => this.#enqueuePreset(payload),
      listBatches: (payload) => this.#listBatches(payload),
      batchDetail: (payload) => this.#batchDetail(payload.batchId),
      listJobs: (payload) => this.#listJobs(payload),
      jobDetail: (payload) => this.#jobDetail(payload.jobId),
      jobAction: (payload) => this.#jobAction(payload.jobId, payload.action),
      setJobAnnotations: (payload) => this.#setAnnotations(payload.jobId, payload.annotations),
      jobProgress: (payload) => this.#jobProgress(payload.jobId),
      resultSummary: (payload) => this.#results.readSummary(payload.jobId),
      resultTable: (payload) => this.#results.readTable(payload.jobId, payload.table, payload.page),
    };
  }

  /* ------------------------------------------------------------ capabilities */

  #capabilities(): Capabilities {
    const limits = this.#queue.limits;
    return {
      versions: { ...CURRENT_CAPABILITY_VERSIONS },
      access: {
        loopback: this.#config.loopback,
        authenticationRequired: this.#config.token !== null,
      },
      limits: {
        maxRequestBytes: this.#config.requestLimits.maxRequestBytes,
        requestsPerWindow: this.#config.requestLimits.requestsPerWindow,
        windowMs: this.#config.requestLimits.windowMs,
        // Echoed from the constants that own them rather than typed again. The
        // response declares these four as literals, so a number that drifted here
        // would fail this service's own outbound validation instead of quietly
        // telling a client a limit the server does not have.
        pageSizeDefault: PAGE_SIZE_DEFAULT,
        pageSizeMax: PAGE_SIZE_MAX,
        maxFilterValues: MAX_FILTER_VALUES,
        maxJobsPerBatch: MAX_JOBS_PER_BATCH,
      },
      orchestrator: {
        maxConcurrentJobs: limits.maxConcurrentJobs,
        maxWorkers: limits.maxWorkers,
        maxWorkersPerJob: limits.maxWorkersPerJob,
      },
      // Identifiers only. `resolveCatalogRoots` holds the paths and never lets
      // one out (ADR 0023 §5).
      resultRootIds: [...this.#config.roots.resultRoots.keys()],
      formatId: PRESET_FORMAT_ID,
      startedAt: this.#startedAt,
    };
  }

  #presets(): PresetCatalog {
    // The registry as it stands, including the `reserved` entry. Omitting one
    // would leave a client unable to explain why a preset it has heard of is not
    // offered, and `presetStatusSchema` exists precisely so it can be told.
    return {
      presets: Object.values(PRESET_REGISTRY).map((preset) => ({
        ...preset,
        kinds: [...preset.kinds],
        sourceClasses: [...preset.sourceClasses],
        limitations: [...preset.limitations],
      })),
    };
  }

  /* -------------------------------------------------------------- creation */

  async #createBatch(
    payload: AdminRequestOf<'createBatch'>,
  ): Promise<CatalogResult<AdminResponseOf<'createBatch'>>> {
    const created = await this.#store.createBatch({
      label: payload.label,
      annotations: payload.annotations,
    });
    if (isErr(created)) return created;
    return ok(catalogBatchViewOf(created.value));
  }

  /**
   * Expands a preset into jobs, and counts what it expanded into.
   *
   * The order is deliberate and each step is a refusal a later step would make
   * worse: the **expansion** happens first, so a choice the simulator would not
   * accept creates nothing at all; the **batch** is read second, so a batch that
   * cannot take jobs is refused before any are minted; and the jobs are created
   * last, in the preset's own stage order, which is the order the queue will run
   * them in because `listJobs` orders by creation.
   *
   * A failure part-way through leaves the jobs already created, and that is the
   * honest outcome rather than a gap: nothing in this workspace deletes anything
   * (ADR 0023 §3, and `store.ts` has no delete to call), the batch is still
   * `draft`, and an operator sees exactly what was made. Rolling back would mean
   * inventing a removal path for the one case where it is least safe to have one.
   */
  async #enqueuePreset(
    payload: AdminRequestOf<'enqueuePreset'>,
  ): Promise<CatalogResult<EnqueuePresetResult>> {
    let expanded;
    try {
      expanded = estimatePreset(payload.choice);
    } catch (cause) {
      if (cause instanceof PresetRefused) return err(cause.errors);
      // Everything else is still the choice being wrong rather than the service
      // being broken: an unknown precon, a Commander this format does not
      // publish or a card outside the pool is refused by the *simulator*, deeper
      // than `parseExperimentConfig`, and arrives here as an ordinary `Error`.
      // Its sentence is the authoritative one and is reused, with anything
      // path-shaped taken out first (ADR 0023 §5). Answering 500 would tell an
      // operator the lab is broken when their form is.
      return err([
        adminError(
          'admin/schema',
          scrubRefusal(
            `This preset choice could not be expanded: ${cause instanceof Error ? cause.message : String(cause)}`,
          ),
          { path: 'choice' },
        ),
      ]);
    }

    const batch = await this.#store.readBatch(payload.batchId);
    if (isErr(batch)) return batch;

    const definition = PRESET_REGISTRY[payload.choice.presetId];
    const sourceClasses = canonicalSourceClasses(definition.sourceClasses);
    const jobs: CatalogJobView[] = [];

    for (const stage of expanded.stages) {
      const created = await this.#store.createJob({
        batchId: payload.batchId,
        label: stage.label.slice(0, 120),
        purpose: stage.purpose,
        sourceClasses,
        config: stage.config,
        origin: {
          kind: 'preset',
          presetId: payload.choice.presetId,
          stageId: stage.stageId,
        },
      });
      if (isErr(created)) return created;
      jobs.push(catalogJobViewOf(created.value));
    }

    // Membership stops being editable now, which is what `enqueue` means in the
    // batch lifecycle. `createJob` already refuses a batch that is not `draft`,
    // so this is the move that makes a second preset into the same batch a
    // refusal rather than a surprise.
    const enqueued = await this.#store.applyBatchAction(payload.batchId, 'enqueue');
    if (isErr(enqueued)) return enqueued;

    // Starting work is the queue's decision, under the bound `limits.ts` holds.
    // It is not awaited: a request that waited for a batch to run would be a
    // request that never returns.
    void this.#queue.pump();

    return ok({
      batchId: payload.batchId,
      jobs,
      expansion: expanded.expansion,
      estimate: expanded.estimate,
    });
  }

  /* --------------------------------------------------------------- reading */

  async #listBatches(
    payload: AdminRequestOf<'listBatches'>,
  ): Promise<CatalogResult<AdminResponseOf<'listBatches'>>> {
    const listed = await this.#store.listBatches(payload.page);
    if (isErr(listed)) return listed;
    return ok({
      items: listed.value.items.map(catalogBatchViewOf),
      page: listed.value.page,
    });
  }

  async #listJobs(
    payload: AdminRequestOf<'listJobs'>,
  ): Promise<CatalogResult<AdminResponseOf<'listJobs'>>> {
    const listed = await this.#store.listJobs(payload.filter, payload.page);
    if (isErr(listed)) return listed;
    return ok({ items: listed.value.items.map(catalogJobViewOf), page: listed.value.page });
  }

  async #batchDetail(batchId: BatchId): Promise<CatalogResult<BatchDetail>> {
    const batch = await this.#store.readBatch(batchId);
    if (isErr(batch)) return batch;
    const jobs = await this.#store.readBatchJobs(batchId);
    if (isErr(jobs)) return jobs;
    return ok({
      batch: catalogBatchViewOf(batch.value),
      jobs: jobs.value.map(catalogJobViewOf),
    });
  }

  async #jobDetail(jobId: JobId): Promise<CatalogResult<JobDetail>> {
    const job = await this.#store.readJob(jobId);
    if (isErr(job)) return job;
    const log = await this.#store.readJobEvents(jobId);
    if (isErr(log)) return log;

    // The newest lines, because a job with a long history is one an operator has
    // acted on repeatedly and the recent moves are the ones that explain where it
    // is. The flag says the rest exists rather than pretending it does not.
    const events = log.value.events;
    const shown = events.slice(Math.max(0, events.length - MAX_DETAIL_EVENTS));

    return ok({
      job: catalogJobViewOf(job.value),
      batchId: job.value.batchId,
      events: shown,
      eventsTruncated: shown.length < events.length,
      availableActions: operatorActionsFor(job.value.status),
    });
  }

  async #jobProgress(jobId: JobId): Promise<CatalogResult<JobProgressView>> {
    const job = await this.#store.readJob(jobId);
    if (isErr(job)) return job;
    return ok({
      jobId,
      status: job.value.status,
      progress: job.value.progress,
      inFlight: this.#queue.snapshot().inFlight.includes(jobId),
      updatedAt: job.value.timestamps.updatedAt,
    });
  }

  /* -------------------------------------------------------------- mutation */

  /**
   * The four verbs, routed through the queue rather than through the store.
   *
   * `JobQueue` is what knows whether *this* process is running the job, and a
   * pause that only wrote a document would leave the run playing matches while
   * the catalog said it was stopping. The store still owns whether the transition
   * is legal — the queue takes it before it throws any switch — so an illegal verb
   * is refused by the same table a screen greys a button from.
   */
  async #jobAction(
    jobId: JobId,
    action: OperatorJobAction,
  ): Promise<CatalogResult<CatalogJobView>> {
    const moved = await this.#queue[action](jobId);
    if (isErr(moved)) return moved;
    return ok(catalogJobViewOf(moved.value));
  }

  async #setAnnotations(
    jobId: JobId,
    annotations: AdminRequestOf<'setJobAnnotations'>['annotations'],
  ): Promise<CatalogResult<CatalogJobView>> {
    const updated = await this.#store.setJobAnnotations(jobId, annotations);
    if (isErr(updated)) return updated;
    return ok(catalogJobViewOf(updated.value));
  }
}

/**
 * The verbs the lifecycle table allows from a state, narrowed to an operator's.
 *
 * Both halves matter. `legalJobActions` is the authority on what the table
 * permits, so this cannot offer a move the store would refuse; `OPERATOR_JOB_ACTIONS`
 * is the authority on what a request may carry, so this cannot offer a move no
 * client could send. Computing it here rather than in a screen is what keeps a
 * stale bundle from showing a button the server does not have.
 */
export function operatorActionsFor(status: JobStatus): OperatorJobAction[] {
  const allowed = new Set<string>(legalJobActions(status));
  return OPERATOR_JOB_ACTIONS.filter((action) => allowed.has(action));
}
