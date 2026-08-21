/**
 * One writer at a time, per document.
 *
 * `rename` makes a single write atomic — a reader sees the old document or the
 * new one, never half of either. It does nothing about two writers that both
 * read the same document, both apply a change to what they read, and both write:
 * the second rename is perfectly atomic and the first change is perfectly gone.
 * Every mutation in this store is read-modify-write, so that is the failure that
 * would actually happen, and M08.6 will serve concurrent requests into it.
 *
 * Per key rather than one lock for the store, because the promise M08.2 makes is
 * that **jobs are independent**: two jobs in one batch move through their
 * lifecycles without waiting for each other, and a single lock would make that
 * false in the one place a test would not look.
 *
 * In-process only, and deliberately so. Cross-process exclusion would need a
 * lock file with its own staleness policy, and ADR 0023 §4 describes one
 * administrator running one orchestration process — there is no second writer to
 * exclude. What a second process *can* do is read, and a reader is safe by
 * construction because of the rename.
 */
export class KeyedMutex {
  readonly #tails = new Map<string, Promise<void>>();

  /**
   * Runs `task` after every task already queued on `key` has settled.
   *
   * The chain is built from a promise that cannot reject — a failed task must
   * not poison the key and strand every later write on it — while the caller
   * still receives the original rejection.
   */
  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(key) ?? Promise.resolve();
    const result = previous.then(task, task);
    const settled = result.then(
      () => undefined,
      () => undefined,
    );
    this.#tails.set(key, settled);
    try {
      return await result;
    } finally {
      // Only the last task on a key clears it, so the map stays the size of the
      // work in flight rather than the size of the catalog.
      if (this.#tails.get(key) === settled) this.#tails.delete(key);
    }
  }

  /** How many keys currently have work queued. For tests that assert it drains. */
  get pending(): number {
    return this.#tails.size;
  }
}
