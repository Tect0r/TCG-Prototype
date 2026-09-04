import {
  CURRENT_CAPABILITY_VERSIONS,
  MAX_DETAIL_EVENTS,
  MAX_FILTER_VALUES,
  MAX_JOBS_PER_BATCH,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PRESET_REGISTRY,
  canonicalSourceClasses,
  catalogBatchViewOf,
  savedChoiceViewOf,
  adminError,
  catalogJobViewOf,
  operatorActionsFor,
  type AdminEndpointName,
  type AdminRequestOf,
  type AdminResponseOf,
  type BatchDetail,
  type BatchId,
  type CatalogJobView,
  type Capabilities,
  type ChoiceEstimate,
  type ContentCatalog,
  type EnqueuePresetResult,
  type JobDetail,
  type JobId,
  type JobProgressView,
  type OperatorJobAction,
  type PresetCatalog,
  type SavedChoiceList,
  type SavedChoiceView,
} from '@tcg/admin-contracts';
import { err, isErr, ok } from '@tcg/shared';

import type { CatalogResult, CatalogStore } from '../catalog/store.js';
import { ChampionshipScheduler } from '../lab/championship.js';
import { readContentCatalog } from '../lab/content.js';
import { duplicateConfig } from '../lab/duplicate.js';
import { estimateAdaptiveChoice } from '../lab/adaptive-choice.js';
import { PRESET_FORMAT_ID, PresetRefused, scrubRefusal } from '../lab/expand.js';
import { estimatePreset, type PresetEstimate } from '../lab/estimate.js';
import type { JobQueue } from '../run/queue.js';
import { AdaptiveResultReader } from './adaptive-results.js';
import { PlayerMetaResultReader } from './player-meta-results.js';
import { ArtifactReader } from './artifacts.js';
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
  readonly #adaptive: AdaptiveResultReader;
  readonly #playerMeta: PlayerMetaResultReader;
  readonly #artifacts: ArtifactReader;
  readonly #championships: ChampionshipScheduler;
  readonly #startedAt: string;

  constructor(options: AdminServiceOptions) {
    this.#config = options.config;
    this.#store = options.store;
    this.#queue = options.queue;
    this.#results = new ResultReader({ store: options.store, roots: options.config.roots });
    this.#adaptive = new AdaptiveResultReader({
      roots: options.config.roots,
      resultRootId: options.config.resultRootId,
    });
    this.#playerMeta = new PlayerMetaResultReader({
      roots: options.config.roots,
      resultRootId: options.config.resultRootId,
    });
    this.#artifacts = new ArtifactReader({ store: options.store, roots: options.config.roots });
    this.#championships = new ChampionshipScheduler({
      store: options.store,
      roots: options.config.roots,
    });
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
      content: async () => ok(this.#content()),
      estimateChoice: async (payload) => this.#estimateChoice(payload.choice),
      createBatch: (payload) => this.#createBatch(payload),
      saveChoice: (payload) => this.#saveChoice(payload),
      listSavedChoices: () => this.#listSavedChoices(),
      enqueuePreset: (payload) => this.#enqueuePreset(payload),
      scheduleChampionship: (payload) => this.#scheduleChampionship(payload),
      reorderBatch: (payload) => this.#reorderBatch(payload.batchId, payload.jobIds),
      duplicateJob: (payload) => this.#duplicateJob(payload.jobId),
      startBatch: (payload) => this.#startBatch(payload.batchId),
      listBatches: (payload) => this.#listBatches(payload),
      batchDetail: (payload) => this.#batchDetail(payload.batchId),
      listJobs: (payload) => this.#listJobs(payload),
      jobDetail: (payload) => this.#jobDetail(payload.jobId),
      jobAction: (payload) => this.#jobAction(payload.jobId, payload.action),
      setJobAnnotations: (payload) => this.#setAnnotations(payload.jobId, payload.annotations),
      jobProgress: (payload) => this.#jobProgress(payload.jobId),
      resultSummary: (payload) => this.#results.readSummary(payload.jobId),
      resultTable: (payload) => this.#results.readTable(payload.jobId, payload.table, payload.page),
      resultArtifacts: (payload) => this.#artifacts.list(payload.jobId),
      adaptiveRunSummary: (payload) => this.#adaptive.readSummary(payload.experimentId),
      adaptiveResultTable: (payload) =>
        this.#adaptive.readTable(payload.experimentId, payload.table, payload.page),
      playerMetaRunSummary: async (payload) => this.#playerMeta.readSummary(payload.filter),
      playerMetaResultTable: async (payload) =>
        this.#playerMeta.readTable(payload.table, payload.filter, payload.page),
      resultArtifact: (payload) => this.#artifacts.read(payload.jobId, payload.artifact),
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

  /**
   * What content a builder may choose from, resolved now rather than remembered.
   *
   * The projection lives in `lab/content.ts` and the authority lives in
   * `@tcg/simulator`; this handler decides only *that* to ask. Answering from a
   * cache would make "validated against current content" mean "against content
   * as it was when this process started", which is exactly the claim the
   * milestone asks not to be made.
   */
  #content(): ContentCatalog {
    return readContentCatalog();
  }

  /**
   * What a choice would schedule, without scheduling it.
   *
   * The same `estimatePreset` call `#enqueuePreset` makes, and the same refusal
   * path: a choice this answers for is a choice that can be enqueued, and a
   * choice this refuses is refused in the same words by the same layer. That is
   * what closes M08.6's objection to a separate estimate endpoint — the two can
   * only differ if the *content* changed between the calls, which is a real
   * event and is what the enqueue answer's own estimate is for reporting.
   *
   * It writes nothing. `expandPreset` builds configurations in memory; no batch,
   * no job and no directory exists when this returns.
   */
  async #estimateChoice(
    choice: AdminRequestOf<'estimateChoice'>['choice'],
  ): Promise<CatalogResult<ChoiceEstimate>> {
    if (choice.presetId === 'adaptive_counter') return estimateAdaptiveOrRefuse(choice);
    const expanded = expandOrRefuse(choice);
    if (isErr(expanded)) return expanded;
    return ok({ expansion: expanded.value.expansion, estimate: expanded.value.estimate });
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
   *
   * ## What M08.9 took out of this handler, and why
   *
   * Until M08.9 the two statements after the loop took the batch's `enqueue`
   * transition and pumped the queue, so filling a batch and **starting** it were
   * one call. That made the `draft` state zero-width: there was no instant at
   * which a batch existed, held its jobs, and had not been released — which is
   * the only instant in which *add, duplicate, remove and reorder before start*
   * can happen at all.
   *
   * Both statements moved to `startBatch`. This handler now leaves the batch a
   * draft and starts nothing, which also makes a second preset into the same
   * batch legal for the first time: `createJob` refuses a batch that is not
   * `draft`, and this one no longer leaves it in any other state.
   */
  async #enqueuePreset(
    payload: AdminRequestOf<'enqueuePreset'>,
  ): Promise<CatalogResult<EnqueuePresetResult>> {
    const expansion = expandOrRefuse(payload.choice);
    if (isErr(expansion)) return expansion;
    const expanded = expansion.value;

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

    return ok({
      batchId: payload.batchId,
      jobs,
      expansion: expanded.expansion,
      estimate: expanded.estimate,
    });
  }

  /**
   * Keeps a filled-in form, after checking that it could actually run.
   *
   * The expansion happens **before** the write, deliberately: a saved
   * configuration that could never be enqueued is a form somebody will reopen
   * later and be refused by, and the refusal is far more useful now — while the
   * screen still has the values that caused it — than in a month.
   *
   * What it does *not* promise is that reopening it will work. Content moves:
   * a precon can be withdrawn between saving and reopening, which is why the
   * builder re-validates on load rather than trusting what it stored. The stale
   * case is a real one and it is answered by the refusal `estimate` gives,
   * naming the field.
   */
  async #saveChoice(
    payload: AdminRequestOf<'saveChoice'>,
  ): Promise<CatalogResult<SavedChoiceView>> {
    const expanded =
      payload.choice.presetId === 'adaptive_counter'
        ? estimateAdaptiveOrRefuse(payload.choice)
        : expandOrRefuse(payload.choice);
    if (isErr(expanded)) return expanded;

    const created = await this.#store.createSavedChoice({
      label: payload.label,
      choice: payload.choice,
    });
    if (isErr(created)) return created;
    return ok(savedChoiceViewOf(created.value));
  }

  async #listSavedChoices(): Promise<CatalogResult<SavedChoiceList>> {
    const listed = await this.#store.listSavedChoices();
    if (isErr(listed)) return listed;
    return ok({
      items: listed.value.items.map(savedChoiceViewOf),
      total: listed.value.items.length,
      // Counted rather than dropped: a configuration from a newer build and one
      // that was never saved are different facts, and a list that showed neither
      // would make the first look like the second.
      unreadable: listed.value.unreadable.length,
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

  /* ------------------------------------------------------- the queue (M08.9) */

  /**
   * Puts a draft batch's jobs into the order they will run in.
   *
   * The whole check is the store's — `draft` only, and a permutation of the
   * membership it currently holds — because the ordering is a property of the
   * document and a handler that pre-checked it would be a second reader of a
   * value that can change between the two reads. What this adds is the answer:
   * the **whole batch detail**, so the screen that asked renders the order the
   * server now holds rather than the one it computed before asking.
   */
  async #reorderBatch(
    batchId: BatchId,
    jobIds: readonly JobId[],
  ): Promise<CatalogResult<BatchDetail>> {
    const reordered = await this.#store.reorderBatchJobs(batchId, jobIds);
    if (isErr(reordered)) return reordered;
    return this.#batchDetail(batchId);
  }

  /**
   * Adds a copy of one queued job to its own batch, immediately after it.
   *
   * Composed out of four calls the store already had rather than a method of its
   * own, and each of the four is carrying its existing authority:
   *
   * - `readJob` and `readJobConfig` say what the source *is*, re-validated on the
   *   way out the way every stored configuration is.
   * - `duplicateConfig` decides what a copy is — a **replicate**, on its own
   *   derived seed family, because two jobs on one seed play the same matches and
   *   would sit in the catalog looking like independent evidence.
   * - `createJob` refuses a batch that is not `draft`, so *duplicate before
   *   start* needs no separate check here and cannot drift from the rule
   *   membership already obeys.
   * - `reorderBatchJobs` moves the new member from the end of the ordering to the
   *   position after its source, which is where a person who pressed *duplicate*
   *   expects to find it.
   *
   * If the reorder fails the copy is still made and sits at the end of the
   * batch. That is visible, harmless and reported — the answer is the batch
   * detail either way — and it is a far better outcome than a handler that
   * deleted a job to keep an ordering tidy.
   *
   * The copy inherits the source's label, purpose, evidence classes and origin.
   * `origin` matters most: a copy of a preset stage is still that preset's stage,
   * so the limitations `PRESET_REGISTRY` publishes for it stay bound to the run
   * it produces.
   */
  async #duplicateJob(jobId: JobId): Promise<CatalogResult<BatchDetail>> {
    const source = await this.#store.readJob(jobId);
    if (isErr(source)) return source;
    const { batchId } = source.value;

    const config = await this.#store.readJobConfig(jobId);
    if (isErr(config)) return config;

    const members = await this.#store.readBatchJobs(batchId);
    if (isErr(members)) return members;

    const copy = duplicateConfig(
      config.value,
      members.value.map((member) => member.spec.experimentId),
    );
    if (!copy.ok) {
      return err([adminError('admin/schema', copy.problem.message, { path: 'jobId' })]);
    }

    const created = await this.#store.createJob({
      batchId,
      label: source.value.label,
      purpose: source.value.purpose,
      sourceClasses: source.value.sourceClasses,
      config: copy.config,
      origin: source.value.origin,
    });
    if (isErr(created)) return created;

    const order = members.value.map((member) => member.jobId);
    const at = order.indexOf(jobId);
    order.splice(at < 0 ? order.length : at + 1, 0, created.value.jobId);
    const reordered = await this.#store.reorderBatchJobs(batchId, order);
    if (isErr(reordered)) return this.#batchDetail(batchId);

    return this.#batchDetail(batchId);
  }

  /**
   * Turns a completed Commander Search batch into a scheduled finalist
   * championship (M08.15).
   *
   * `commander_search`'s own `deferredStages` entry names the reason this is a
   * separate call rather than a continuation `enqueuePreset` makes on its own:
   * the finalist field does not exist until every named search has finished, so
   * nothing about it could be expanded in advance. `ChampionshipScheduler` reads
   * the named batch's completed search jobs back out of their own canonical
   * directories, selects and freezes finalists per Commander, and creates a new
   * batch and job exactly the way `enqueuePreset` does — which is why the answer
   * is the same `batchDetail` `startBatch` gives, left `draft` for an operator to
   * start.
   */
  async #scheduleChampionship(
    payload: AdminRequestOf<'scheduleChampionship'>,
  ): Promise<CatalogResult<BatchDetail>> {
    const scheduled = await this.#championships.schedule(payload);
    if (isErr(scheduled)) return scheduled;
    return this.#batchDetail(scheduled.value.batchId);
  }

  /**
   * Releases a draft batch to the queue, which is the moment its ordering
   * becomes final and the first moment anything can run.
   *
   * The two statements M08.9 took out of `enqueuePreset`, given an address of
   * their own. `enqueue` is the batch lifecycle's own transition and the store
   * refuses it from anywhere but `draft`, so pressing *start* twice is answered
   * by the same table that greys the button rather than by a flag this class
   * would have to keep.
   *
   * The pump is **not awaited**, for the reason it was not awaited before: a
   * request that waited for a batch to run would be a request that never
   * returns. What comes back is the batch detail, so the screen sees its jobs in
   * the order it just settled — every one of them still `queued`, because
   * whether any of them starts is the queue's decision under the bound
   * `limits.ts` holds and not this call's to promise.
   */
  async #startBatch(batchId: BatchId): Promise<CatalogResult<BatchDetail>> {
    const started = await this.#store.applyBatchAction(batchId, 'enqueue');
    if (isErr(started)) return started;
    // Reconciled before the pump, so a batch whose every job was withdrawn
    // before release settles as `completed` instead of sitting in `queued`
    // waiting for work that will never run.
    await this.#queue.reconcileBatch(batchId);
    void this.#queue.pump();
    return this.#batchDetail(batchId);
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
 * Expanding a choice, with every way it can be wrong reported as a refusal.
 *
 * One helper rather than three copies of the same `try`, because M08.8 gives the
 * expansion three callers — estimate, save and enqueue — and a caller that
 * handled the failure differently would answer a bad precon with a 500 on one
 * address and `admin/schema` on another.
 */
function expandOrRefuse(choice: unknown): CatalogResult<PresetEstimate> {
  try {
    return ok(estimatePreset(choice));
  } catch (cause) {
    if (cause instanceof PresetRefused) return err(cause.errors);
    // Everything else is still the choice being wrong rather than the service
    // being broken: an unknown precon, a Commander this format does not publish
    // or a card outside the pool is refused by the *simulator*, deeper than
    // `parseExperimentConfig`, and arrives here as an ordinary `Error`. Its
    // sentence is the authoritative one and is reused, with anything path-shaped
    // taken out first (ADR 0023 §5). Answering 500 would tell an operator the
    // lab is broken when their form is.
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
}

/**
 * The adaptive counterpart to `expandOrRefuse`, over `estimateAdaptiveChoice`
 * rather than `estimatePreset` — see `../lab/adaptive-choice.ts`'s header for
 * why `adaptive_counter` needs its own door. Used by `#estimateChoice` and
 * `#saveChoice` only: `#enqueuePreset` still goes through `expandOrRefuse`,
 * which refuses `adaptive_counter` outright, because this build cannot
 * schedule one yet.
 */
function estimateAdaptiveOrRefuse(choice: unknown): CatalogResult<ChoiceEstimate> {
  try {
    return ok(estimateAdaptiveChoice(choice));
  } catch (cause) {
    if (cause instanceof PresetRefused) return err(cause.errors);
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
}
