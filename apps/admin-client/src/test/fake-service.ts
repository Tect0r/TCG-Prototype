import {
  ADMIN_CONTRACT_VERSION,
  ADMIN_ENDPOINTS,
  ARTIFACT_MEDIA_TYPES,
  applyBatchTransition,
  applyJobTransition,
  CURRENT_ADMIN_VERSIONS,
  MAX_FILTER_VALUES,
  MAX_JOBS_PER_BATCH,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PRESET_REGISTRY,
  RESULT_ARTIFACT_NAMES,
  RESULT_ARTIFACTS,
  NO_ANNOTATIONS,
  NO_PROGRESS,
  adminError,
  catalogFilterSchema,
  catalogJobViewSchema,
  resultArtifactListingSchema,
  resultArtifactSchema,
  resultSummarySchema,
  suggestedArtifactFilename,
  type AdminEndpointName,
  type AdminErrorCode,
  type Annotations,
  type Capabilities,
  type CatalogBatchView,
  type CatalogFilter,
  type ChoiceEstimate,
  type BatchDetail,
  type CatalogJobView,
  type ContentCatalog,
  type EnqueuePresetResult,
  type ExperimentKind,
  type ExperimentPurpose,
  type JobOrigin,
  type JobProgressView,
  type JobStatus,
  type OperatorJobAction,
  type Progress,
  type PresetCatalog,
  type PresetChoice,
  type ResultArtifactListing,
  type ResultArtifactName,
  type ResultSummary,
  type RunIdentity,
  type SavedChoiceList,
  type SavedChoiceView,
  type SourceClass,
} from '@tcg/admin-contracts';

import type { AdminHttpRequest, AdminHttpReply, AdminTransport } from '../net/transport.js';

/**
 * A lab that answers, without a port.
 *
 * Every answer is built out of the contract's own schemas and constants — the
 * preset catalog is `PRESET_REGISTRY` itself rather than a hand-written copy —
 * so a test that passes here is a test against the shapes the real service is
 * validated against on the way out. What the fake does not do is enforce the
 * service's *policy*: it refuses a token because a test told it to, not because
 * it read one. That policy has its own suite in `apps/admin-server`, and
 * re-implementing it here would be the admin client growing a second opinion
 * about who may connect.
 */

export interface FakeServiceOptions {
  /** When set, a request must carry exactly this token or be refused. */
  readonly token?: string;
  readonly capabilities?: Partial<Capabilities>;
  /** Answers this endpoint with a refusal instead of a value. */
  readonly refuse?: Partial<Record<AdminEndpointName, AdminErrorCode>>;
  /** Throws instead of answering, the way a dead process does. */
  readonly unreachable?: boolean;
  /**
   * The content this fake lab publishes.
   *
   * Replaceable so a suite can drive the two cases a builder has to survive: a
   * precon the environment refuses, and a precon that has gone away between one
   * reading and the next.
   */
  readonly content?: ContentCatalog;
  /**
   * Precons this fake refuses to schedule, by ID.
   *
   * The stale-content case. The fake does not re-implement deck legality — it
   * refuses a named ID the way the real service refuses one the environment does
   * not publish, which is what a builder has to render.
   */
  readonly withdrawn?: readonly string[];
}

export interface FakeService {
  readonly transport: AdminTransport;
  /** Every request the client actually sent, in order. */
  readonly requests: AdminHttpRequest[];
  /** Replaces the answers mid-test, so a restart or a recovery can be driven. */
  configure(options: FakeServiceOptions): void;
  /**
   * The catalog this fake holds, so a queue test can put a job into a state the
   * client cannot reach on its own.
   *
   * A running job with a measured pace, an interrupted one a restart left
   * behind, a failed one with diagnostics: all three are things the *runner*
   * produces, and a client test that could only drive them through operator
   * verbs could never render them. This is the seam that stands in for the
   * runner, and it moves documents through the contract's own transition table
   * rather than by assignment, so a state this fake can reach is a state the
   * real store could reach too.
   */
  readonly lab: FakeLab;
}

export interface FakeLab {
  /** Creates a draft batch holding `count` queued jobs, the way the builder would. */
  seedDraft(label: string, count: number): { batchId: string; jobIds: string[] };
  /** Drives one job through a lifecycle action, as a runner or a restart would. */
  drive(jobId: string, action: Parameters<typeof applyJobTransition>[1]): void;
  /** Replaces one job's progress, as the runner's directory reader would. */
  setProgress(jobId: string, progress: Partial<Progress>): void;
  /** Marks a batch started without going through the endpoint. */
  release(batchId: string): void;
  job(jobId: string): CatalogJobView | undefined;
  batch(batchId: string): CatalogBatchView | undefined;
  /**
   * Seeds one job with a finished (or refused, or partial) result, for the
   * result catalog's own tests (M08.10). Unlike `seedDraft`, this job is not
   * held behind a draft batch: it is minted already in whatever `status` is
   * asked for, because a browsing screen has to see completed, failed and
   * interrupted evidence side by side, which no operator verb produces here.
   */
  seedResult(options?: SeedResultOptions): SeededResult;
}

export interface SeedResultOptions {
  readonly label?: string;
  readonly status?: JobStatus;
  readonly purpose?: ExperimentPurpose;
  readonly sourceClasses?: readonly SourceClass[];
  readonly kind?: ExperimentKind;
  readonly origin?: JobOrigin;
  readonly annotations?: Annotations;
  /** What the run's configuration selects, for the precon and Commander filters. */
  readonly preconIds?: readonly string[];
  readonly commanderIds?: readonly string[];
  /** What `resultSummary` answers for this job — a reading, or a named refusal. */
  readonly summary?:
    'none' | ResultSummary | { readonly refuse: AdminErrorCode; readonly message?: string };
  /** Which canonical documents this run wrote, and their content. */
  readonly artifacts?: Readonly<Partial<Record<ResultArtifactName, string>>>;
}

export interface SeededResult {
  readonly jobId: string;
  readonly batchId: string;
}

/** A run identity that is legal, complete and obviously a fixture. */
export function resultIdentityFixture(overrides: Partial<RunIdentity> = {}): RunIdentity {
  return {
    experimentId: 'precon-standard',
    kind: 'batch',
    seed: 'precon-standard|r1',
    configHash: 'abcdef0123456789',
    environments: [
      {
        environmentId: 'wave_1',
        hashes: {
          mechanicsHash: '1111111111111111',
          pilotInputHash: '2222222222222222',
          presentationHash: '3333333333333333',
          fullContentHash: '4444444444444444',
        },
      },
    ],
    manifestSchemaVersion: 8,
    softwareCommit: '900390d',
    ...overrides,
  };
}

/** A complete, readable summary, for a fixture that has nothing wrong with it. */
export function resultSummaryFixture(overrides: Partial<ResultSummary> = {}): ResultSummary {
  return resultSummarySchema.parse({
    jobId: overrides.jobId ?? 'job_fake000001',
    kind: 'batch',
    configHash: 'abcdef0123456789',
    identity: resultIdentityFixture(),
    source: { document: 'summary.json', schemaVersion: 7 },
    denominators: {
      matches: 40,
      usableMatches: 38,
      abnormalMatches: 2,
      failedMatches: 0,
      resumedMatches: 0,
      abnormalByKind: { turn_limit: 2 },
    },
    evidence: {
      standing: 'calibration',
      reasons: ['No pilot in this build carries a final balance conclusion.'],
      promotionRequires:
        'A run stops being calibration only when every class that flew it carries it.',
      analysisVersion: 1,
    },
    readings: [{ key: 'matches', label: 'Games played', value: 40, kind: 'count' }],
    tables: [
      { table: 'decks', rows: 2 },
      { table: 'matchups', rows: 1 },
      { table: 'cards', rows: 160 },
      { table: 'seats', rows: 2 },
      { table: 'pilots', rows: 1 },
      { table: 'agent_classes', rows: 1 },
      { table: 'terminations', rows: 2 },
    ],
    limitations: ['A limitation the fake service publishes with every benchmark.'],
    ...overrides,
  });
}

export function capabilitiesFixture(overrides: Partial<Capabilities> = {}): Capabilities {
  return {
    versions: { ...CURRENT_ADMIN_VERSIONS },
    access: { loopback: true, authenticationRequired: false },
    limits: {
      maxRequestBytes: 131_072,
      requestsPerWindow: 240,
      windowMs: 60_000,
      pageSizeDefault: PAGE_SIZE_DEFAULT,
      pageSizeMax: PAGE_SIZE_MAX,
      maxFilterValues: MAX_FILTER_VALUES,
      maxJobsPerBatch: MAX_JOBS_PER_BATCH,
    },
    orchestrator: { maxConcurrentJobs: 1, maxWorkers: 7, maxWorkersPerJob: 7 },
    resultRootIds: ['default'],
    formatId: 'precon_wave_1',
    startedAt: '2026-08-24T09:00:00.000Z',
    ...overrides,
  };
}

export function contentCatalogFixture(overrides: Partial<ContentCatalog> = {}): ContentCatalog {
  return {
    formatId: 'precon_wave_1',
    precons: [
      {
        preconId: 'precon_goblin_swarm',
        name: 'Goblin Swarm',
        strategy: 'Build a wide Goblin board and convert it into an attack.',
        commanderId: 'goblin_warboss',
        cardCount: 40,
        refusals: [],
      },
      {
        preconId: 'precon_bastion_guardians',
        name: 'Bastion Guardians',
        strategy: 'Hold the board and win the long game.',
        commanderId: 'bastion_marshal',
        cardCount: 40,
        refusals: [],
      },
      {
        preconId: 'precon_containment_control',
        name: 'Containment Control',
        strategy: 'Answer threats and close from parity.',
        commanderId: 'containment_warden',
        cardCount: 40,
        refusals: [],
      },
      {
        preconId: 'precon_broken_deck',
        name: 'Broken Deck',
        strategy: 'A precon this environment cannot play.',
        commanderId: 'nobody',
        cardCount: 40,
        refusals: ['Precon "precon_broken_deck" cannot be played here: a card it needs is banned.'],
      },
    ],
    pilots: [
      { pilotId: 'random_legal', agentClass: 'random_legal', playQualityEvidence: false },
      { pilotId: 'aggressive', agentClass: 'generic_heuristic', playQualityEvidence: true },
      { pilotId: 'value', agentClass: 'generic_heuristic', playQualityEvidence: true },
    ],
    ...overrides,
  };
}

export function presetCatalogFixture(): PresetCatalog {
  return {
    presets: Object.values(PRESET_REGISTRY).map((preset) => ({
      ...preset,
      kinds: [...preset.kinds],
      sourceClasses: [...preset.sourceClasses],
      limitations: [...preset.limitations],
    })),
  };
}

const NOW = '2026-08-24T09:00:00.000Z';

export function fakeService(initial: FakeServiceOptions = {}): FakeService {
  let options = initial;
  const requests: AdminHttpRequest[] = [];
  const kept: SavedChoiceView[] = [];
  let savedCounter = 0;
  let batchCounter = 0;
  let jobCounter = 0;
  let lastBatchId = 'batch_fake000001';

  /** The catalog this fake keeps: batches in creation order, jobs by ID. */
  const batches = new Map<string, CatalogBatchView>();
  const jobs = new Map<string, CatalogJobView>();
  /** What each job's configuration selects, for the M08.10 precon and Commander filters. */
  const jobContent = new Map<
    string,
    { preconIds: readonly string[]; commanderIds: readonly string[] }
  >();
  /** What `resultSummary` answers for a job, when it is not the ordinary "no result yet". */
  const jobSummaries = new Map<
    string,
    'none' | ResultSummary | { readonly refuse: AdminErrorCode; readonly message?: string }
  >();
  /** Which canonical documents a job's run wrote, and their content, for the artifact endpoints. */
  const jobArtifacts = new Map<string, Readonly<Partial<Record<ResultArtifactName, string>>>>();

  /** A clock that only ever advances, so listings and date-range filters see a real order. */
  let ticks = 0;
  const nextTimestamp = (): string => {
    ticks += 1;
    return new Date(Date.parse(NOW) + ticks * 1_000).toISOString();
  };

  const mintBatch = (label: string): CatalogBatchView => {
    batchCounter += 1;
    const createdAt = nextTimestamp();
    const view: CatalogBatchView = {
      batchId: `batch_fake${String(batchCounter).padStart(6, '0')}`,
      label,
      status: 'draft',
      timestamps: { createdAt, updatedAt: createdAt, startedAt: null, completedAt: null },
      annotations: { tags: [], note: '', baseline: false },
      jobIds: [],
    };
    batches.set(view.batchId, view);
    lastBatchId = view.batchId;
    return view;
  };

  interface MintJobOverrides {
    readonly status?: JobStatus;
    readonly purpose?: ExperimentPurpose;
    readonly sourceClasses?: readonly SourceClass[];
    readonly kind?: ExperimentKind;
    readonly origin?: JobOrigin;
    readonly annotations?: Annotations;
    readonly result?: CatalogJobView['result'];
  }

  const mintJob = (
    batchId: string,
    label: string,
    experimentId: string,
    seed: string,
    overrides: MintJobOverrides = {},
  ): CatalogJobView => {
    jobCounter += 1;
    const createdAt = nextTimestamp();
    const status = overrides.status ?? 'queued';
    const terminal = ['completed', 'failed', 'cancelled'].includes(status);
    const started = terminal || status !== 'queued';
    const view = catalogJobViewSchema.parse({
      jobId: `job_fake${String(jobCounter).padStart(6, '0')}`,
      batchId,
      label,
      status,
      purpose: overrides.purpose ?? 'exploration',
      sourceClasses: overrides.sourceClasses ?? ['ai', 'precon'],
      timestamps: {
        createdAt,
        updatedAt: createdAt,
        startedAt: started ? createdAt : null,
        completedAt: terminal ? createdAt : null,
      },
      annotations: overrides.annotations ?? NO_ANNOTATIONS,
      progress: NO_PROGRESS,
      spec: {
        experimentId,
        kind: overrides.kind ?? 'batch',
        seed,
        configHash: 'abcdef0123456789',
        configSchemaVersion: 1,
      },
      origin: overrides.origin ?? { kind: 'preset', presetId: 'precon_smoke', stageId: 'matches' },
      execution: null,
      result: overrides.result ?? null,
      failure: null,
    });
    jobs.set(view.jobId, view);
    const batch = batches.get(batchId);
    if (batch) batches.set(batchId, { ...batch, jobIds: [...batch.jobIds, view.jobId] });
    return view;
  };

  const detail = (batchId: string): BatchDetail | null => {
    const batch = batches.get(batchId);
    if (!batch) return null;
    const members = batch.jobIds.map((jobId) => jobs.get(jobId)).filter((job) => job !== undefined);
    return { batch, jobs: members };
  };

  const moveBatch = (batchId: string, action: Parameters<typeof applyBatchTransition>[1]): void => {
    const batch = batches.get(batchId);
    if (!batch) return;
    const moved = applyBatchTransition(batch.status, action);
    if (!moved.ok) return;
    const at = nextTimestamp();
    batches.set(batchId, {
      ...batch,
      status: moved.to,
      timestamps: {
        ...batch.timestamps,
        startedAt: batch.timestamps.startedAt ?? (moved.to === 'running' ? at : null),
      },
    });
  };

  const moveJob = (
    jobId: string,
    action: Parameters<typeof applyJobTransition>[1],
  ): CatalogJobView | { readonly refusal: string } => {
    const job = jobs.get(jobId);
    if (!job) return { refusal: 'admin/unknown_job' };
    const to = applyJobTransition(job.status, action);
    if (!to.ok) return { refusal: 'admin/illegal_transition' };
    const terminal = ['completed', 'failed', 'cancelled'].includes(to.to);
    const started = ['running', 'pausing', 'paused', 'cancelling', 'interrupted'].includes(to.to);
    const at = nextTimestamp();
    const next = catalogJobViewSchema.parse({
      ...job,
      status: to.to,
      timestamps: {
        ...job.timestamps,
        updatedAt: at,
        startedAt: job.timestamps.startedAt ?? (started || terminal ? at : null),
        completedAt: terminal ? at : null,
      },
    });
    jobs.set(jobId, next);
    return next;
  };

  const lab: FakeLab = {
    seedDraft(label, count) {
      const batch = mintBatch(label);
      const jobIds: string[] = [];
      for (let index = 0; index < count; index += 1) {
        jobIds.push(
          mintJob(
            batch.batchId,
            `Stage ${String(index + 1)}`,
            `bench-r${String(index + 1)}`,
            `seed|r${String(index + 1)}`,
          ).jobId,
        );
      }
      return { batchId: batch.batchId, jobIds };
    },
    drive(jobId, action) {
      moveJob(jobId, action);
    },
    setProgress(jobId, progress) {
      const job = jobs.get(jobId);
      if (!job) return;
      jobs.set(jobId, { ...job, progress: { ...job.progress, ...progress } });
    },
    release(batchId) {
      moveBatch(batchId, 'enqueue');
    },
    job: (jobId) => jobs.get(jobId),
    batch: (batchId) => batches.get(batchId),
    seedResult(seedOptions = {}) {
      const batch = mintBatch(seedOptions.label ?? 'Result fixture');
      const status = seedOptions.status ?? 'completed';
      const terminal = ['completed', 'failed', 'cancelled'].includes(status);
      const job = mintJob(
        batch.batchId,
        seedOptions.label ?? 'Precon Wave 1 benchmark',
        `fixture-${String(jobCounter + 1)}`,
        `fixture-${String(jobCounter + 1)}-seed`,
        {
          status,
          ...(seedOptions.purpose === undefined ? {} : { purpose: seedOptions.purpose }),
          ...(seedOptions.sourceClasses === undefined
            ? {}
            : { sourceClasses: seedOptions.sourceClasses }),
          ...(seedOptions.kind === undefined ? {} : { kind: seedOptions.kind }),
          ...(seedOptions.origin === undefined ? {} : { origin: seedOptions.origin }),
          ...(seedOptions.annotations === undefined
            ? {}
            : { annotations: seedOptions.annotations }),
          result: terminal ? { identity: resultIdentityFixture() } : null,
        },
      );
      // A batch minted only to hold this one job is released immediately: a
      // browsing screen has no reason to see a draft it did not ask about, and
      // `applyBatchTransition` from `draft` is `enqueue` regardless of what its
      // one member's own status already is.
      moveBatch(batch.batchId, 'enqueue');

      jobContent.set(job.jobId, {
        preconIds: seedOptions.preconIds ?? [],
        commanderIds: seedOptions.commanderIds ?? [],
      });
      if (seedOptions.summary !== undefined) jobSummaries.set(job.jobId, seedOptions.summary);
      if (seedOptions.artifacts !== undefined) jobArtifacts.set(job.jobId, seedOptions.artifacts);

      return { jobId: job.jobId, batchId: batch.batchId };
    },
  };

  const matchesFilter = (job: CatalogJobView, filter: CatalogFilter): boolean => {
    if (filter.status.length > 0 && !filter.status.includes(job.status)) return false;
    if (filter.purpose !== null && job.purpose !== filter.purpose) return false;
    if (
      filter.sourceClasses.length > 0 &&
      !job.sourceClasses.some((value) => filter.sourceClasses.includes(value))
    ) {
      return false;
    }
    if (filter.kinds.length > 0 && !filter.kinds.includes(job.spec.kind)) return false;
    if (filter.batchId !== null && job.batchId !== filter.batchId) return false;
    if (filter.tags.length > 0 && !job.annotations.tags.some((tag) => filter.tags.includes(tag))) {
      return false;
    }
    if (filter.baseline !== null && job.annotations.baseline !== filter.baseline) return false;
    if (filter.createdAfter !== null && job.timestamps.createdAt < filter.createdAfter)
      return false;
    if (filter.createdBefore !== null && job.timestamps.createdAt > filter.createdBefore) {
      return false;
    }
    const content = jobContent.get(job.jobId) ?? { preconIds: [], commanderIds: [] };
    if (
      filter.preconIds.length > 0 &&
      !content.preconIds.some((id) => filter.preconIds.includes(id))
    ) {
      return false;
    }
    if (
      filter.commanderIds.length > 0 &&
      !content.commanderIds.some((id) => filter.commanderIds.includes(id))
    ) {
      return false;
    }
    return true;
  };

  const savedList = (): SavedChoiceList => ({
    items: [...kept].reverse(),
    total: kept.length,
    unreadable: 0,
  });

  const keep = (label: string, choice: PresetChoice | undefined): SavedChoiceView => {
    savedCounter += 1;
    const view: SavedChoiceView = {
      savedChoiceId: `saved_fake${String(savedCounter).padStart(6, '0')}`,
      label,
      timestamps: { createdAt: NOW, updatedAt: NOW, startedAt: null, completedAt: null },
      choice: choice as PresetChoice,
    };
    kept.push(view);
    return view;
  };

  const transport: AdminTransport = async (request) => {
    requests.push(request);
    if (options.unreachable === true) throw new TypeError('Failed to fetch');

    const name = endpointOf(request.path);
    if (name === null) return refusal('admin/unknown_endpoint', 404);

    if (options.token !== undefined && request.headers['x-admin-token'] !== options.token) {
      return refusal('admin/unauthorized', 401);
    }

    const refused = options.refuse?.[name];
    if (refused !== undefined) return refusal(refused, 500);

    if (name === 'capabilities') {
      return answer(capabilitiesFixture(options.capabilities ?? {}));
    }
    if (name === 'presets') return answer(presetCatalogFixture());
    if (name === 'content') return answer(options.content ?? contentCatalogFixture());
    if (name === 'listSavedChoices') return answer(savedList());

    const payload = payloadOf(request.body);

    if (name === 'estimateChoice' || name === 'saveChoice') {
      const choice = payload.choice as PresetChoice | undefined;
      const stale = staleIn(choice, options.withdrawn ?? []);
      if (stale !== null) {
        return {
          status: 400,
          body: JSON.stringify({
            ok: false,
            contractVersion: ADMIN_CONTRACT_VERSION,
            errors: [
              adminError('admin/schema', `"${stale}" is not a precon in format "precon_wave_1".`, {
                path: 'choice',
              }),
            ],
          }),
        };
      }
      if (name === 'estimateChoice') return answer(estimateFor(choice));
      const view = keep(String(payload.label ?? 'kept'), choice);
      return answer(view);
    }

    if (name === 'createBatch') {
      return answer(mintBatch(String(payload.label ?? 'batch')));
    }

    if (name === 'enqueuePreset') {
      const batchId = String(payload.batchId ?? lastBatchId);
      const preview = estimateFor(payload.choice as PresetChoice | undefined);
      const made = preview.expansion.stages.map((stage) =>
        mintJob(batchId, stage.label, stage.experimentId, `${stage.stageId}-seed`),
      );
      return answer({
        batchId,
        jobs: made,
        expansion: preview.expansion,
        estimate: preview.estimate,
      } satisfies EnqueuePresetResult as EnqueuePresetResult);
    }

    if (name === 'listBatches') {
      const items = [...batches.values()];
      return answer({
        items,
        page: { returned: items.length, limit: 50, nextCursor: null, total: items.length },
      });
    }

    if (name === 'batchDetail' || name === 'startBatch' || name === 'reorderBatch') {
      const batchId = String(payload.batchId ?? '');
      if (!batches.has(batchId)) return refusal('admin/unknown_batch', 404);

      if (name === 'reorderBatch') {
        const batch = batches.get(batchId) as CatalogBatchView;
        if (batch.status !== 'draft') return refusal('admin/illegal_transition', 409);
        const wanted = (payload.jobIds ?? []) as string[];
        const same =
          wanted.length === batch.jobIds.length && wanted.every((id) => batch.jobIds.includes(id));
        if (!same) return refusal('admin/schema', 400);
        batches.set(batchId, { ...batch, jobIds: [...wanted] });
      }
      if (name === 'startBatch') {
        const batch = batches.get(batchId) as CatalogBatchView;
        if (batch.status !== 'draft') return refusal('admin/illegal_transition', 409);
        moveBatch(batchId, 'enqueue');
      }
      const found = detail(batchId);
      return found === null ? refusal('admin/unknown_batch', 404) : answer(found);
    }

    if (name === 'duplicateJob') {
      const jobId = String(payload.jobId ?? '');
      const source = jobs.get(jobId);
      if (!source) return refusal('admin/unknown_job', 404);
      const batch = batches.get(source.batchId);
      if (!batch) return refusal('admin/unknown_batch', 404);
      if (batch.status !== 'draft') return refusal('admin/illegal_transition', 409);

      const copy = mintJob(
        source.batchId,
        source.label,
        `${source.spec.experimentId}-c2`,
        `${source.spec.seed}|c2`,
      );
      const held = batches.get(source.batchId) as CatalogBatchView;
      const order = held.jobIds.filter((id) => id !== copy.jobId);
      order.splice(order.indexOf(jobId) + 1, 0, copy.jobId);
      batches.set(source.batchId, { ...held, jobIds: order });
      const found = detail(source.batchId);
      return found === null ? refusal('admin/unknown_batch', 404) : answer(found);
    }

    if (name === 'jobAction') {
      const moved = moveJob(String(payload.jobId ?? ''), payload.action as OperatorJobAction);
      if ('refusal' in moved) return refusal(moved.refusal as AdminErrorCode, 409);
      return answer(moved);
    }

    if (name === 'jobProgress') {
      const job = jobs.get(String(payload.jobId ?? ''));
      if (!job) return refusal('admin/unknown_job', 404);
      return answer({
        jobId: job.jobId,
        status: job.status,
        progress: job.progress,
        inFlight: job.status === 'running',
        updatedAt: NOW,
      } satisfies JobProgressView as JobProgressView);
    }

    if (name === 'listJobs') {
      const filter = catalogFilterSchema.parse(payload.filter ?? {});
      const page = (payload.page ?? {}) as {
        readonly limit?: number;
        readonly cursor?: string | null;
      };
      const limit = page.limit ?? PAGE_SIZE_DEFAULT;
      const matching = [...jobs.values()]
        .filter((job) => matchesFilter(job, filter))
        .sort(
          (a, b) =>
            a.timestamps.createdAt.localeCompare(b.timestamps.createdAt) ||
            a.jobId.localeCompare(b.jobId),
        );
      const offset = decodeOffset(page.cursor ?? null);
      const items = matching.slice(offset, offset + limit);
      const consumed = offset + items.length;
      return answer({
        items,
        page: {
          returned: items.length,
          limit,
          nextCursor: consumed < matching.length ? encodeOffset(consumed) : null,
          total: matching.length,
        },
      });
    }

    if (name === 'resultSummary') {
      const jobId = String(payload.jobId ?? '');
      const job = jobs.get(jobId);
      if (!job) return refusal('admin/unknown_job', 404);
      const summary = jobSummaries.get(jobId) ?? 'none';
      if (summary === 'none') {
        return refusal(
          'admin/no_result',
          404,
          'This job has produced no canonical result yet, so there is nothing to read.',
        );
      }
      if ('refuse' in summary) return refusal(summary.refuse, 409, summary.message);
      return answer({ ...summary, jobId });
    }

    if (name === 'resultArtifacts' || name === 'resultArtifact') {
      const jobId = String(payload.jobId ?? '');
      const job = jobs.get(jobId);
      if (!job) return refusal('admin/unknown_job', 404);
      if (job.result === null) {
        return refusal(
          'admin/no_result',
          404,
          'This job has produced no canonical result yet, so it has no documents to download.',
        );
      }
      const present = jobArtifacts.get(jobId) ?? {};

      if (name === 'resultArtifacts') {
        const listing: ResultArtifactListing = resultArtifactListingSchema.parse({
          jobId,
          identity: job.result.identity,
          artifacts: RESULT_ARTIFACT_NAMES.map((artifactName) => {
            const content = present[artifactName];
            return {
              artifact: artifactName,
              format: RESULT_ARTIFACTS[artifactName].format,
              present: content !== undefined,
              byteLength: content === undefined ? null : content.length,
              tooLarge: false,
            };
          }),
          readAt: NOW,
        });
        return answer(listing);
      }

      const artifactName = payload.artifact as ResultArtifactName;
      const content = present[artifactName];
      if (content === undefined) {
        return refusal(
          'admin/no_result',
          404,
          `This run wrote no ${RESULT_ARTIFACTS[artifactName].filename}. That is a fact about the run rather than a failure to read it.`,
        );
      }
      const definition = RESULT_ARTIFACTS[artifactName];
      return answer(
        resultArtifactSchema.parse({
          jobId,
          artifact: artifactName,
          filename: definition.filename,
          suggestedFilename: suggestedArtifactFilename(job.spec.experimentId, jobId, artifactName),
          format: definition.format,
          mediaType: ARTIFACT_MEDIA_TYPES[definition.format],
          byteLength: content.length,
          content,
          identity: job.result.identity,
          readAt: NOW,
        }),
      );
    }

    if (name === 'setJobAnnotations') {
      const jobId = String(payload.jobId ?? '');
      const job = jobs.get(jobId);
      if (!job) return refusal('admin/unknown_job', 404);
      const next = { ...job, annotations: payload.annotations as Annotations };
      jobs.set(jobId, next);
      return answer(next);
    }

    return refusal('admin/unknown_endpoint', 404);
  };

  return {
    transport,
    requests,
    lab,
    configure(next) {
      options = next;
    },
  };
}

/** An answer whose envelope declares a version this build does not speak. */
export function versionedTransport(contractVersion: number): AdminTransport {
  return async () =>
    Promise.resolve({
      status: 200,
      body: JSON.stringify({ ok: true, contractVersion, payload: capabilitiesFixture() }),
    });
}

/** A transport that answers with bytes that are not this contract at all. */
export function bodyTransport(status: number, body: string): AdminTransport {
  return async () => Promise.resolve({ status, body });
}

function endpointOf(path: string): AdminEndpointName | null {
  for (const name of Object.keys(ADMIN_ENDPOINTS) as AdminEndpointName[]) {
    if (path === `/admin/v${String(ADMIN_CONTRACT_VERSION)}/${ADMIN_ENDPOINTS[name].route}`) {
      return name;
    }
  }
  return null;
}

function answer(payload: unknown): AdminHttpReply {
  return {
    status: 200,
    body: JSON.stringify({ ok: true, contractVersion: ADMIN_CONTRACT_VERSION, payload }),
  };
}

function refusal(code: AdminErrorCode, status: number, message?: string): AdminHttpReply {
  return {
    status,
    body: JSON.stringify({
      ok: false,
      contractVersion: ADMIN_CONTRACT_VERSION,
      errors: [adminError(code, message ?? messageFor(code))],
    }),
  };
}

/** A listing position, opaque the way the real cursor is — this fake need not match its bytes. */
function encodeOffset(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

function decodeOffset(cursor: string | null): number {
  if (cursor === null) return 0;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as { o?: number };
    return typeof parsed.o === 'number' ? parsed.o : 0;
  } catch {
    return 0;
  }
}

/**
 * The sentence one refusal carries.
 *
 * The wording for `admin/unauthorized` is the service's own, because the
 * connection tests assert that the client prints what the service said rather
 * than a paraphrase of it. Anything not listed gets a readable fallback: an
 * `undefined` message would fail `adminErrorSchema` on the way in, which would
 * make a fixture's omission look like a client defect.
 */
export function messageFor(code: AdminErrorCode): string {
  return MESSAGES[code] ?? 'The admin service refused this request.';
}

const MESSAGES: Readonly<Partial<Record<AdminErrorCode, string>>> = {
  'admin/unauthorized':
    'This service requires an administrator token in the `x-admin-token` header.',
  'admin/unknown_endpoint': 'No endpoint of this service answers at that address.',
  'admin/rate_limited': 'More requests arrived from this caller than the window allows.',
};

/** The request payload the client actually sent, for the fake to answer about. */
function payloadOf(body: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(body) as { payload?: unknown };
    const payload = parsed.payload;
    return typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The first named precon this fake has withdrawn, or `null`. */
function staleIn(choice: PresetChoice | undefined, withdrawn: readonly string[]): string | null {
  if (choice === undefined || !('preconIds' in choice)) return null;
  return choice.preconIds.find((id) => withdrawn.includes(id)) ?? null;
}

/**
 * A schedule count the fake computes the only way it honestly can: from the
 * shape of the choice.
 *
 * It is **not** the estimator — that is `buildSchedule`'s and the simulator is
 * server-only — and the client never checks the arithmetic. What the client is
 * tested on is that the number it was given is the number it shows, and that it
 * refuses to enqueue until it has one for the configuration on screen.
 */
function estimateFor(choice: PresetChoice | undefined): ChoiceEstimate {
  const decks = choice !== undefined && 'preconIds' in choice ? choice.preconIds.length : 0;
  const pilots = choice !== undefined && 'pilotIds' in choice ? choice.pilotIds.length : 1;
  const settings = choice !== undefined && 'settings' in choice ? choice.settings : undefined;
  const depth =
    settings?.workload.mode === 'custom'
      ? settings.workload.gamesPerSeatOrder
      : (DEPTHS[choice?.presetId ?? 'precon_standard'] ?? 4);
  const replicates = settings?.replicates ?? 1;
  const orientations = settings?.mirrorSeats === false ? 1 : 2;
  const pairings = (decks * (decks - 1)) / 2;
  const perStage = pairings * orientations * depth * pilots;

  const stages = Array.from({ length: replicates }, (_, index) => ({
    stageId: replicates === 1 ? 'matches' : `matches-r${String(index + 1)}`,
    label: `${String(decks)} precons, ${String(depth)} games per seat order`,
    kind: 'batch' as const,
    purpose: 'exploration' as const,
    matches: perStage,
    basis: 'exact' as const,
    reason: '',
    seatOrders: Array.from({ length: orientations }, (_, orientation) => ({
      orientation,
      matches: perStage / orientations,
    })),
    gamesPerSeatOrder: depth,
    decks: {
      count: decks,
      source: 'resolved_precons' as const,
      basis: 'exact' as const,
      rejected: [],
    },
    pilotTuples: pilots,
    repeats: 1,
  }));

  return {
    expansion: {
      presetId: choice?.presetId ?? 'precon_standard',
      testStyle: 'precon_benchmark',
      sourceClasses: ['ai', 'precon'],
      stages: stages.map((stage) => ({
        stageId: stage.stageId,
        label: stage.label,
        kind: stage.kind,
        purpose: stage.purpose,
        experimentId: choice?.experimentId ?? 'precon-standard',
        decisions: [],
      })),
      deferredStages: [],
      limitations: ['A limitation the fake service publishes with every benchmark.'],
    },
    estimate: {
      totalMatches: perStage * replicates,
      basis: 'exact',
      stages,
      forcedInclusion: [
        {
          commanderId: 'goblin_warboss',
          legalPoolSize: 41,
          poolCapacity: 41,
          deckSize: 40,
          slack: 1,
          forcedInclusionFloor: 39,
        },
      ],
      limitations: ['A limitation the fake service publishes with every benchmark.'],
    },
  };
}

const DEPTHS: Readonly<Record<string, number>> = {
  precon_smoke: 1,
  precon_standard: 4,
  precon_deep: 12,
};
