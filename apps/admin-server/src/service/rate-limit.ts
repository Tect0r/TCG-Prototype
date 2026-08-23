/**
 * How many requests one caller may make in a window, and what happens after
 * that.
 *
 * A **fixed window** rather than a sliding one or a token bucket, and the reason
 * is the same reason the catalog is files: the simplest thing that answers the
 * real question. The real question is not "can an attacker be slowed down" — an
 * unauthenticated attacker cannot reach a handler at all, and an authenticated
 * one is the administrator — it is "can a looping client turn a file-backed
 * catalog into a disk benchmark". A counter and a window answer that exactly,
 * and they answer it without a background timer, a heap or a shared clock.
 *
 * The one property a fixed window is genuinely worse at is burst behaviour at a
 * boundary: a caller can spend a whole window's budget in the last instant of one
 * and again in the first instant of the next. At 240 a minute against a local
 * process that is 480 requests in a moment, which is noise. A sliding window
 * would cost a per-caller queue of timestamps to fix a problem this deployment
 * does not have.
 *
 * ## Why the map is bounded
 *
 * Because the key is a remote address, and an unbounded map keyed by anything a
 * caller controls is a memory leak with a nicer name. On a loopback bind there is
 * exactly one key; off loopback there are as many as there are peers. Eviction is
 * oldest-window-first, which is the entry least likely to be counting anything —
 * an entry whose window has expired is about to be reset anyway.
 */

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Requests left in the current window after this one. Zero when refused. */
  readonly remaining: number;
  /** Milliseconds until the window resets. Reported so a refusal can say when to try again. */
  readonly retryAfterMs: number;
}

export interface RateLimiterOptions {
  readonly requestsPerWindow: number;
  readonly windowMs: number;
  /** Injectable so a test can move time rather than wait for it. */
  readonly clock?: () => number;
  /** Most distinct callers tracked at once. See the header. */
  readonly maxClients?: number;
}

/** Most callers tracked at once, before the coldest window is dropped. */
export const DEFAULT_MAX_TRACKED_CLIENTS = 1024;

interface TrackedWindow {
  startedAt: number;
  count: number;
}

export class RateLimiter {
  readonly #requestsPerWindow: number;
  readonly #windowMs: number;
  readonly #clock: () => number;
  readonly #maxClients: number;
  readonly #windows = new Map<string, TrackedWindow>();

  constructor(options: RateLimiterOptions) {
    this.#requestsPerWindow = options.requestsPerWindow;
    this.#windowMs = options.windowMs;
    this.#clock = options.clock ?? (() => Date.now());
    this.#maxClients = options.maxClients ?? DEFAULT_MAX_TRACKED_CLIENTS;
  }

  /** How many callers are being tracked. Exposed so the bound is testable. */
  get tracked(): number {
    return this.#windows.size;
  }

  /**
   * Counts one request from `key` and says whether it may proceed.
   *
   * A refused request is **not** counted again. Counting refusals would extend a
   * window every time a caller retried, which turns a rate limit into a lockout —
   * and a lockout with no way out is how an operator loses access to their own
   * lab at the worst moment.
   */
  check(key: string): RateLimitDecision {
    const now = this.#clock();
    const existing = this.#windows.get(key);

    if (existing === undefined || now - existing.startedAt >= this.#windowMs) {
      this.#evictIfFull(key);
      this.#windows.set(key, { startedAt: now, count: 1 });
      return {
        allowed: true,
        remaining: this.#requestsPerWindow - 1,
        retryAfterMs: this.#windowMs,
      };
    }

    const retryAfterMs = Math.max(0, existing.startedAt + this.#windowMs - now);
    if (existing.count >= this.#requestsPerWindow) {
      return { allowed: false, remaining: 0, retryAfterMs };
    }

    existing.count += 1;
    return {
      allowed: true,
      remaining: this.#requestsPerWindow - existing.count,
      retryAfterMs,
    };
  }

  #evictIfFull(incoming: string): void {
    if (this.#windows.has(incoming) || this.#windows.size < this.#maxClients) return;
    let coldest: string | null = null;
    let coldestStart = Number.POSITIVE_INFINITY;
    for (const [key, tracked] of this.#windows) {
      if (tracked.startedAt >= coldestStart) continue;
      coldest = key;
      coldestStart = tracked.startedAt;
    }
    if (coldest !== null) this.#windows.delete(coldest);
  }
}
