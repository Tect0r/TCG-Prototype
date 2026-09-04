import {
  PAGE_SIZE_DEFAULT,
  catalogFilterSchema,
  pageRequestSchema,
  playerMetaFilterSchema,
} from '@tcg/admin-contracts';
import type {
  AdaptiveExperimentId,
  AdaptiveResultTable,
  AdaptiveResultTableName,
  AdaptiveRunSummary,
  AdminEndpointName,
  AdminRequestOf,
  AdminResponseOf,
  Annotations,
  BatchDetail,
  BatchId,
  BatchPage,
  Capabilities,
  CardExplorerView,
  CatalogFilterInput,
  CatalogJobView,
  ChoiceEstimate,
  ContentCatalog,
  DeckExplorerView,
  EnqueuePresetResult,
  JobId,
  JobPage,
  JobProgressView,
  LiveMatchDeckHash,
  OperatorJobAction,
  PageRequestInput,
  PlayerMetaFilterInput,
  PlayerMetaResultTable,
  PlayerMetaResultTableName,
  PlayerMetaRunSummary,
  PresetCatalog,
  PresetChoice,
  ResultArtifact,
  ResultArtifactListing,
  ResultArtifactName,
  ResultSummary,
  ResultTable,
  ResultTableName,
  SavedChoiceList,
  SavedChoiceView,
} from '@tcg/admin-contracts';

import {
  callAdmin,
  isUnauthorized,
  type AdminFailure,
  type AdminOutcome,
  type AdminTransport,
} from './transport.js';

/**
 * The lab connection, as one observable value.
 *
 * The same shape the player client uses for a match: a plain object that owns
 * the state nobody else may own — here the administrator token, whether this
 * build is talking to a service it can read, and what that service last said
 * about itself — and publishes an immutable snapshot after every change. React
 * subscribes to it with `useSyncExternalStore` and renders what it finds.
 *
 * ## The token lives here, in memory, and nowhere else
 *
 * ADR 0023 §4 forbids the token from a query string, a log line, a report and
 * *anything the browser persists*. It is a private field of this object: it is
 * gone when the tab closes, gone when the page reloads, and gone the moment
 * `forget()` is called. `snapshot()` cannot carry it — the type has no field for
 * one — so no screen, no error boundary and no serialized state can print it by
 * accident. `session.test.ts` stringifies a connected snapshot and requires the
 * token not to appear anywhere in it.
 *
 * Re-entering the token after a reload is the cost, and it is the intended one.
 * A lab that remembered its token across reloads would be a lab whose token
 * outlives the person sitting at it.
 *
 * ## Four resources, four states, because they fail apart
 *
 * `capabilities` decides whether there is a connection at all; the other three
 * describe what the connected build can run (`presets`), what content it can run
 * it against (`content`), and which forms an administrator has kept
 * (`savedChoices`). A service that answered the first and refused any of the
 * rest is connected with one section missing, not disconnected — so each carries
 * its own loading and failure state rather than collapsing the whole screen.
 * That is also what gives the shell its section-level error state something real
 * to render.
 *
 * ## What is *not* a resource here
 *
 * An estimate, an enqueue and a save are **calls**, not readings: each is about
 * one form's current values, each is answered once, and holding the last one in
 * the session would mean a second screen could render a number about a
 * configuration it never saw. So they are methods that return an outcome, and
 * the screen that asked owns the answer.
 *
 * ## Nothing polls
 *
 * There is no timer here. The Overview reports *when it last asked* and offers
 * to ask again, which is honest about a reading that is a few seconds old; a
 * poller would be inventing a refresh cadence for state that does not change on
 * its own yet. The screens that watch running work — a queue, a progress bar —
 * are M08.9's, and the tranche that needs a cadence is the tranche that can
 * choose one.
 */

/** A thing this build asked the service for, and what came of asking. */
export type AdminResource<T> =
  | { readonly status: 'idle' }
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly value: T }
  | { readonly status: 'failed'; readonly failure: AdminFailure };

/**
 * Where this build stands with the lab.
 *
 * `needs_token` is a state rather than a flavour of failure because it is the
 * one refusal an operator can act on from the screen itself, and the shell shows
 * a different thing for it: a form, not an error page.
 */
export type AdminConnection =
  | { readonly status: 'idle' }
  | { readonly status: 'connecting' }
  | {
      readonly status: 'needs_token';
      /** The refusal that asked for a token, once one has been offered and rejected. */
      readonly failure: AdminFailure | null;
    }
  | { readonly status: 'unavailable'; readonly failure: AdminFailure }
  | {
      readonly status: 'connected';
      readonly capabilities: Capabilities;
      /** When this build last had an answer, so the screen can say how old it is. */
      readonly checkedAt: string;
      /** Whether this connection is sending a token. Never the token itself. */
      readonly authenticated: boolean;
      /**
       * Whether the service restarted between two readings.
       *
       * `capabilities.startedAt` is the fact M08.6 put on the wire for exactly
       * this — *so a client can tell a restart* — and a restart matters to an
       * operator: M08.5 made a job that was running when the process died come
       * back as `interrupted` and stay there until a person asks.
       */
      readonly restarted: boolean;
    };

export interface AdminSessionState {
  readonly connection: AdminConnection;
  readonly presets: AdminResource<PresetCatalog>;
  /**
   * The precons and pilots this build can run, as the service resolves them now.
   *
   * Re-read whenever the connection is re-established rather than cached across
   * one, because the milestone requires a form to be validated against *current*
   * content and a list held from an earlier reading is a list that was current
   * once.
   */
  readonly content: AdminResource<ContentCatalog>;
  readonly savedChoices: AdminResource<SavedChoiceList>;
  /** True while any request is in flight, so the shell can show one busy region. */
  readonly busy: boolean;
}

export interface AdminSessionOptions {
  readonly transport: AdminTransport;
  /** Injected in tests so a reading's age is a fact rather than a race. */
  readonly now?: () => Date;
}

const INITIAL: AdminSessionState = Object.freeze<AdminSessionState>({
  connection: { status: 'idle' },
  presets: { status: 'idle' },
  content: { status: 'idle' },
  savedChoices: { status: 'idle' },
  busy: false,
});

export class AdminSession {
  readonly #transport: AdminTransport;
  readonly #now: () => Date;
  readonly #listeners = new Set<() => void>();

  /** The administrator token, for as long as this tab is open. Never published. */
  #token: string | null = null;
  #state: AdminSessionState = INITIAL;
  /** The last `startedAt` this build saw, so a restart is a comparison rather than a guess. */
  #lastStartedAt: string | null = null;

  constructor(options: AdminSessionOptions) {
    this.#transport = options.transport;
    this.#now = options.now ?? (() => new Date());
  }

  get state(): AdminSessionState {
    return this.#state;
  }

  /** Whether a token is being sent. The value itself never leaves this object. */
  get hasToken(): boolean {
    return this.#token !== null;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Asks the service what it is, with the token supplied — or with none.
   *
   * Called with no argument on first load, deliberately: a loopback service with
   * no token configured answers, and an operator running the ordinary local lab
   * never sees a form. One that requires a token refuses with
   * `admin/unauthorized`, and *that* is what puts the form on the screen. The
   * client never decides in advance whether authentication is needed — the
   * service's `access.authenticationRequired` is a report, and asking is the
   * only way to find out.
   */
  async connect(token?: string): Promise<void> {
    if (token !== undefined) this.#token = token === '' ? null : token;
    this.#publish({ ...this.#state, connection: { status: 'connecting' }, busy: true });

    const answer = await callAdmin(this.#transport, 'capabilities', {}, this.#token);
    if (!answer.ok) {
      // A rejected token is dropped rather than kept. Holding one the service
      // has already refused would mean every later call re-sends a value known
      // to be wrong, and an operator correcting a typo would be correcting a
      // field that still had the old value behind it.
      if (isUnauthorized(answer.failure)) {
        const offered = this.#token !== null;
        this.#token = null;
        this.#publish({
          connection: { status: 'needs_token', failure: offered ? answer.failure : null },
          presets: { status: 'idle' },
          content: { status: 'idle' },
          savedChoices: { status: 'idle' },
          busy: false,
        });
        return;
      }
      this.#publish({
        connection: { status: 'unavailable', failure: answer.failure },
        presets: { status: 'idle' },
        content: { status: 'idle' },
        savedChoices: { status: 'idle' },
        busy: false,
      });
      return;
    }

    const capabilities = answer.value;
    const restarted =
      this.#lastStartedAt !== null && this.#lastStartedAt !== capabilities.startedAt;
    this.#lastStartedAt = capabilities.startedAt;
    this.#publish({
      connection: {
        status: 'connected',
        capabilities,
        checkedAt: this.#now().toISOString(),
        authenticated: this.#token !== null,
        restarted,
      },
      presets: { status: 'loading' },
      content: { status: 'loading' },
      savedChoices: { status: 'loading' },
      busy: true,
    });

    await Promise.all([this.#loadPresets(), this.#loadContent(), this.#loadSavedChoices()]);
    this.#publish({ ...this.#state, busy: false });
  }

  /** Asks both questions again with the connection already established. */
  async refresh(): Promise<void> {
    await this.connect();
  }

  /**
   * Drops the token and returns to the gate.
   *
   * Not a "log out" — there is no session on the service to end, and saying so
   * would be inventing a server-side concept this boundary deliberately does not
   * have (ADR 0023 §4: *no accounts, no roles, no sessions*). What it does is
   * exactly what it says: this tab stops holding the token.
   */
  forget(): void {
    this.#token = null;
    this.#lastStartedAt = null;
    this.#publish({
      connection: { status: 'needs_token', failure: null },
      presets: { status: 'idle' },
      content: { status: 'idle' },
      savedChoices: { status: 'idle' },
      busy: false,
    });
  }

  /** Asks for the preset catalog again after it, alone, failed. */
  async reloadPresets(): Promise<void> {
    if (this.#state.connection.status !== 'connected') return;
    this.#publish({ ...this.#state, presets: { status: 'loading' }, busy: true });
    await this.#loadPresets();
    this.#publish({ ...this.#state, busy: false });
  }

  /** Asks for the content catalog again after it, alone, failed. */
  async reloadContent(): Promise<void> {
    if (this.#state.connection.status !== 'connected') return;
    this.#publish({ ...this.#state, content: { status: 'loading' }, busy: true });
    await this.#loadContent();
    this.#publish({ ...this.#state, busy: false });
  }

  /** Asks for the kept forms again — after a failure, and after saving one. */
  async reloadSavedChoices(): Promise<void> {
    if (this.#state.connection.status !== 'connected') return;
    this.#publish({ ...this.#state, savedChoices: { status: 'loading' }, busy: true });
    await this.#loadSavedChoices();
    this.#publish({ ...this.#state, busy: false });
  }

  /**
   * Asks what a choice would schedule, without scheduling it.
   *
   * Returns the answer rather than publishing it, because it is about one form's
   * current values and a second screen rendering it would be rendering a number
   * about a configuration it never saw.
   */
  async estimate(choice: PresetChoice): Promise<AdminOutcome<ChoiceEstimate>> {
    return this.#call('estimateChoice', { choice });
  }

  /**
   * Creates the batch and fills it, which is what "enqueue" means here.
   *
   * Two calls rather than one, because the service has two endpoints and this
   * client does not get to invent a third. The order is the service's own: a
   * batch that could not be created means nothing was enqueued, and an enqueue
   * that fails leaves an empty draft batch — which is visible and harmless, and
   * is what the answer says happened.
   */
  async enqueue(label: string, choice: PresetChoice): Promise<AdminOutcome<EnqueuePresetResult>> {
    const batch = await this.#call('createBatch', {
      label,
      annotations: { tags: [], note: '', baseline: false },
    });
    if (!batch.ok) return batch;
    return this.#call('enqueuePreset', { batchId: batch.value.batchId, choice });
  }

  /** Keeps a filled-in form under a name, and re-reads the list it joined. */
  async saveChoice(label: string, choice: PresetChoice): Promise<AdminOutcome<SavedChoiceView>> {
    const saved = await this.#call('saveChoice', { label, choice });
    if (saved.ok) await this.reloadSavedChoices();
    return saved;
  }

  /* ------------------------------------------------------ the queue (M08.9) */

  /**
   * The queue's readings and verbs, as calls rather than as session resources.
   *
   * Deliberately not held here, for the reason the four resources above *are*:
   * `capabilities`, `presets`, `content` and `savedChoices` describe the build
   * and change only when the build or the operator's catalog does, so one copy
   * shared by every screen is right. A queue is the opposite — it changes while
   * nobody touches it — and a snapshot kept in the session would be a snapshot
   * some other screen could render minutes later as though it were now.
   *
   * So the screen that asked owns the answer and decides when to ask again. That
   * also settles the cadence question this class recorded and left open:
   * *nothing polls … the tranche that needs a cadence is the tranche that can
   * choose one*. M08.9 chooses it, and it chooses it **in the screen**, because
   * the right interval depends on what is on that screen — a draft nobody has
   * started needs no poll at all.
   */
  async listBatches(): Promise<AdminOutcome<BatchPage>> {
    return this.#call('listBatches', { page: { limit: PAGE_SIZE_DEFAULT, cursor: null } });
  }

  async batchDetail(batchId: BatchId): Promise<AdminOutcome<BatchDetail>> {
    return this.#call('batchDetail', { batchId });
  }

  /** The whole new order, which is the only shape this request has. */
  async reorderBatch(
    batchId: BatchId,
    jobIds: readonly JobId[],
  ): Promise<AdminOutcome<BatchDetail>> {
    return this.#call('reorderBatch', { batchId, jobIds: [...jobIds] });
  }

  async duplicateJob(jobId: JobId): Promise<AdminOutcome<BatchDetail>> {
    return this.#call('duplicateJob', { jobId });
  }

  async startBatch(batchId: BatchId): Promise<AdminOutcome<BatchDetail>> {
    return this.#call('startBatch', { batchId });
  }

  /**
   * Turns a completed Commander Search batch into a scheduled finalist
   * championship (M08.15). Answers with the new, still-`draft` batch —
   * `startBatch` is what an operator calls next to run it.
   */
  async scheduleChampionship(
    batchId: BatchId,
    settings: { finalistsPerCommander: number; gamesPerPairing: number; seed: string },
  ): Promise<AdminOutcome<BatchDetail>> {
    return this.#call('scheduleChampionship', { batchId, ...settings });
  }

  async jobAction(jobId: JobId, action: OperatorJobAction): Promise<AdminOutcome<CatalogJobView>> {
    return this.#call('jobAction', { jobId, action });
  }

  /* ---------------------------------------------------- the result catalog (M08.10) */

  /**
   * A filtered, paged listing over every job the catalog holds — completed,
   * partial, refused and never-run alike.
   *
   * Deliberately not a session resource, for the reason the queue's readings
   * are not: a filter is one screen's current values, and a listing changes
   * while nobody is watching it. The screen that asked owns the answer.
   */
  async listJobs(
    filter?: CatalogFilterInput,
    page?: PageRequestInput,
  ): Promise<AdminOutcome<JobPage>> {
    return this.#call('listJobs', {
      filter: catalogFilterSchema.parse(filter ?? {}),
      page: pageRequestSchema.parse(page ?? {}),
    });
  }

  /**
   * A run's headline reading, or the one refusal that says why there is none.
   *
   * A refusal here is not a client failure — a queued job, a run with no
   * calibration standing and a corrupt summary all answer through this same
   * call, and the detail screen's job is to tell those apart rather than to
   * treat every refusal as the same blank state.
   */
  async resultSummary(jobId: JobId): Promise<AdminOutcome<ResultSummary>> {
    return this.#call('resultSummary', { jobId });
  }

  /**
   * One page of one result table — the exact rows a chart's cell or bar
   * summarizes, for the reason `resultTableSchema` gives: a reading is
   * transport, not a definition, so a screen that draws a bar from this table
   * and a screen that lists its rows are reading the same numbers rather than
   * two computations that could disagree.
   */
  async resultTable(
    jobId: JobId,
    table: ResultTableName,
    page?: PageRequestInput,
  ): Promise<AdminOutcome<ResultTable>> {
    return this.#call('resultTable', {
      jobId,
      table,
      page: pageRequestSchema.parse(page ?? {}),
    });
  }

  /** Which of a run's canonical documents exist, and which are too large to download. */
  async resultArtifacts(jobId: JobId): Promise<AdminOutcome<ResultArtifactListing>> {
    return this.#call('resultArtifacts', { jobId });
  }

  /** One canonical document, byte for byte, with the identity that names the run. */
  async resultArtifact(
    jobId: JobId,
    artifact: ResultArtifactName,
  ): Promise<AdminOutcome<ResultArtifact>> {
    return this.#call('resultArtifact', { jobId, artifact });
  }

  /* ------------------------------------------------ the adaptive result reader (M08.19C) */

  /**
   * A directory-keyed Adaptive Counter run's headline reading, or the one
   * refusal that says why there is none.
   *
   * Mirrors `resultSummary` exactly, for a run that has no `JobId` to be read
   * by yet: `adaptive-summary` takes only `experimentId`, and the server
   * resolves its directory itself (`AdaptiveResultReader`, ADR 0023 §5) — this
   * client never learns or sends a path.
   */
  async adaptiveRunSummary(
    experimentId: AdaptiveExperimentId,
  ): Promise<AdminOutcome<AdaptiveRunSummary>> {
    return this.#call('adaptiveRunSummary', { experimentId });
  }

  /** One page of one Adaptive Counter run's result table — mirrors `resultTable`. */
  async adaptiveResultTable(
    experimentId: AdaptiveExperimentId,
    table: AdaptiveResultTableName,
    page?: PageRequestInput,
  ): Promise<AdminOutcome<AdaptiveResultTable>> {
    return this.#call('adaptiveResultTable', {
      experimentId,
      table,
      page: pageRequestSchema.parse(page ?? {}),
    });
  }

  /* -------------------------------------------------- the player meta reader (M08.25C) */

  /**
   * A filtered Player Meta headline reading, or the one refusal that says why
   * there is none.
   *
   * Unlike `adaptiveRunSummary`, this takes no run identifier at all — a
   * Player Meta read has neither a `JobId` nor an `experimentId`, only
   * `filter` (`PlayerMetaResultReader`, ADR 0023 §5): the server's one
   * configured default result root already names the whole answer.
   */
  async playerMetaRunSummary(
    filter?: PlayerMetaFilterInput,
  ): Promise<AdminOutcome<PlayerMetaRunSummary>> {
    return this.#call('playerMetaRunSummary', {
      filter: playerMetaFilterSchema.parse(filter ?? {}),
    });
  }

  /** One page of one filtered Player Meta result table — mirrors `resultTable`. */
  async playerMetaResultTable(
    table: PlayerMetaResultTableName,
    filter?: PlayerMetaFilterInput,
    page?: PageRequestInput,
  ): Promise<AdminOutcome<PlayerMetaResultTable>> {
    return this.#call('playerMetaResultTable', {
      filter: playerMetaFilterSchema.parse(filter ?? {}),
      table,
      page: pageRequestSchema.parse(page ?? {}),
    });
  }

  /* -------------------------------------------------------- the deck explorer (M08.26B) */

  /**
   * A deck's immutable identity, plus known Adaptive Counter revision lineage
   * when `adaptiveExperimentId` is named.
   *
   * `adaptiveExperimentId` omitted or `null` means "not checked" — the answer
   * comes back with `knownRevisions: null`, not `[]`. Naming an experiment
   * whose run cannot be read fails the whole call rather than reporting either
   * in its place (`deckExplorerRequestSchema`, ADR 0023 §2).
   */
  async deckExplorerView(
    deckHash: LiveMatchDeckHash,
    adaptiveExperimentId?: AdaptiveExperimentId | null,
  ): Promise<AdminOutcome<DeckExplorerView>> {
    return this.#call('deckExplorerView', {
      deckHash,
      adaptiveExperimentId: adaptiveExperimentId ?? null,
    });
  }

  /* -------------------------------------------------------- the card explorer (M08.26C) */

  /**
   * A card's eligible-inclusion and partner evidence across live matches, plus
   * one named job's draw/play/dead-hand evidence when `jobId` is named.
   *
   * `jobId` omitted or `null` means "not checked" — the answer comes back with
   * `experimentEvidence: null`, not a populated entry with an empty row. Naming
   * a job whose run cannot be read fails the whole call rather than reporting
   * either in its place (`cardExplorerRequestSchema`, ADR 0023 §2).
   */
  async cardExplorerView(
    cardId: string,
    jobId?: JobId | null,
  ): Promise<AdminOutcome<CardExplorerView>> {
    return this.#call('cardExplorerView', {
      cardId,
      jobId: jobId ?? null,
    });
  }

  /**
   * Replacing a job's tags, note and baseline mark.
   *
   * The whole block, never a patch — `setJobAnnotationsRequestSchema` gives the
   * reason: there is no way to say "leave this one" that is distinguishable from
   * "clear it", so a screen that lets an operator edit one field sends the other
   * two back unchanged rather than omitting them.
   */
  async setJobAnnotations(
    jobId: JobId,
    annotations: Annotations,
  ): Promise<AdminOutcome<CatalogJobView>> {
    return this.#call('setJobAnnotations', { jobId, annotations });
  }

  /**
   * How far one job has got, without the busy flag.
   *
   * The one call that does **not** go through `#call`. Every other request is a
   * thing a person asked for and belongs in the shell's busy region; a poll is
   * not, and raising the flag two or three times a second would make the whole
   * surface flicker and would tell an operator the lab is working when nothing
   * has been asked of it.
   */
  async jobProgress(jobId: JobId): Promise<AdminOutcome<JobProgressView>> {
    return callAdmin(this.#transport, 'jobProgress', { jobId }, this.#token);
  }

  /**
   * One request, with the busy flag raised around it.
   *
   * The flag is the shell's single busy region, and raising it here rather than
   * at each call site is what keeps a screen from forgetting to lower it on the
   * failure path.
   */
  async #call<N extends AdminEndpointName>(
    name: N,
    payload: AdminRequestOf<N>,
  ): Promise<AdminOutcome<AdminResponseOf<N>>> {
    this.#publish({ ...this.#state, busy: true });
    const answer = await callAdmin(this.#transport, name, payload, this.#token);
    this.#publish({ ...this.#state, busy: false });
    return answer;
  }

  async #loadPresets(): Promise<void> {
    const answer = await callAdmin(this.#transport, 'presets', {}, this.#token);
    this.#publish({
      ...this.#state,
      presets: answer.ok
        ? { status: 'ready', value: answer.value }
        : { status: 'failed', failure: answer.failure },
    });
  }

  async #loadContent(): Promise<void> {
    const answer = await callAdmin(this.#transport, 'content', {}, this.#token);
    this.#publish({
      ...this.#state,
      content: answer.ok
        ? { status: 'ready', value: answer.value }
        : { status: 'failed', failure: answer.failure },
    });
  }

  async #loadSavedChoices(): Promise<void> {
    const answer = await callAdmin(this.#transport, 'listSavedChoices', {}, this.#token);
    this.#publish({
      ...this.#state,
      savedChoices: answer.ok
        ? { status: 'ready', value: answer.value }
        : { status: 'failed', failure: answer.failure },
    });
  }

  #publish(next: AdminSessionState): void {
    this.#state = Object.freeze(next);
    for (const listener of [...this.#listeners]) listener();
  }
}
