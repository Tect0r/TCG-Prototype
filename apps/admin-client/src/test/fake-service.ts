import {
  ADMIN_CONTRACT_VERSION,
  ADMIN_ENDPOINTS,
  CURRENT_ADMIN_VERSIONS,
  MAX_FILTER_VALUES,
  MAX_JOBS_PER_BATCH,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PRESET_REGISTRY,
  NO_ANNOTATIONS,
  NO_PROGRESS,
  adminError,
  catalogJobViewSchema,
  type AdminEndpointName,
  type AdminErrorCode,
  type Capabilities,
  type CatalogBatchView,
  type ChoiceEstimate,
  type ContentCatalog,
  type EnqueuePresetResult,
  type PresetCatalog,
  type PresetChoice,
  type SavedChoiceList,
  type SavedChoiceView,
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
  let lastBatchId = 'batch_fake000001';

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
      batchCounter += 1;
      const view: CatalogBatchView = {
        batchId: `batch_fake${String(batchCounter).padStart(6, '0')}`,
        label: String(payload.label ?? 'batch'),
        status: 'draft',
        timestamps: {
          createdAt: NOW,
          updatedAt: NOW,
          startedAt: null,
          completedAt: null,
        },
        annotations: { tags: [], note: '', baseline: false },
        jobIds: [],
      };
      lastBatchId = view.batchId;
      return answer(view);
    }

    if (name === 'enqueuePreset') {
      return answer(enqueueFor(payload.choice as PresetChoice | undefined, lastBatchId));
    }

    return refusal('admin/unknown_endpoint', 404);
  };

  return {
    transport,
    requests,
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

function refusal(code: AdminErrorCode, status: number): AdminHttpReply {
  return {
    status,
    body: JSON.stringify({
      ok: false,
      contractVersion: ADMIN_CONTRACT_VERSION,
      errors: [adminError(code, messageFor(code))],
    }),
  };
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

function enqueueFor(choice: PresetChoice | undefined, batchId: string): EnqueuePresetResult {
  const preview = estimateFor(choice);
  return {
    batchId: batchId as EnqueuePresetResult['batchId'],
    // Parsed by the contract's own schema rather than hand-shaped, so a fixture
    // the real service could not have sent fails here instead of teaching a
    // screen to render something no service produces.
    jobs: preview.expansion.stages.map((stage, index) =>
      catalogJobViewSchema.parse({
        jobId: `job_fake${String(index + 1).padStart(6, '0')}`,
        batchId,
        label: stage.label,
        status: 'queued',
        purpose: stage.purpose,
        sourceClasses: ['ai', 'precon'],
        timestamps: { createdAt: NOW, updatedAt: NOW, startedAt: null, completedAt: null },
        annotations: NO_ANNOTATIONS,
        progress: NO_PROGRESS,
        spec: {
          experimentId: stage.experimentId,
          kind: 'batch',
          seed: 'seed',
          configHash: 'abcdef0123456789',
          configSchemaVersion: 1,
        },
        origin: { kind: 'preset', presetId: preview.expansion.presetId, stageId: stage.stageId },
        execution: null,
        result: null,
        failure: null,
      }),
    ),
    expansion: preview.expansion,
    estimate: preview.estimate,
  };
}
