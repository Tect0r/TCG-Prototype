import type { Capabilities, PresetCatalog } from '@tcg/admin-contracts';

import { callAdmin, isUnauthorized, type AdminFailure, type AdminTransport } from './transport.js';

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
 * ## Two resources, two states, because they fail apart
 *
 * `capabilities` decides whether there is a connection at all; `presets`
 * describes what the connected build can run. A service that answered the first
 * and refused the second is connected with one section missing, not
 * disconnected — so the presets carry their own loading and failure state rather
 * than collapsing the whole screen. That is also what gives the shell its
 * section-level error state something real to render.
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
          busy: false,
        });
        return;
      }
      this.#publish({
        connection: { status: 'unavailable', failure: answer.failure },
        presets: { status: 'idle' },
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
      busy: true,
    });

    await this.#loadPresets();
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
      busy: false,
    });
  }

  /** Asks for the preset catalog again after it, alone, failed. */
  async reloadPresets(): Promise<void> {
    if (this.#state.connection.status !== 'connected') return;
    this.#publish({ ...this.#state, presets: { status: 'loading' }, busy: true });
    await this.#loadPresets();
  }

  async #loadPresets(): Promise<void> {
    const answer = await callAdmin(this.#transport, 'presets', {}, this.#token);
    this.#publish({
      ...this.#state,
      presets: answer.ok
        ? { status: 'ready', value: answer.value }
        : { status: 'failed', failure: answer.failure },
      busy: false,
    });
  }

  #publish(next: AdminSessionState): void {
    this.#state = Object.freeze(next);
    for (const listener of [...this.#listeners]) listener();
  }
}
