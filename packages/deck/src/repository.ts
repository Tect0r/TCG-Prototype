import { error, warning, type Issue } from '@tcg/shared';
import { migrateSavedDeck } from './migrate.js';
import type { SavedDeck } from './schema.js';

/**
 * The subset of `Storage` the repository needs. Keeping it an interface means
 * the persistence logic is testable in plain Node and reusable if local storage
 * is ever swapped for something else.
 */
export interface KeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const DECK_STORAGE_KEY = 'tcg-prototype:decks:v1';
/** Where an unreadable payload is parked instead of being silently destroyed. */
export const DECK_STORAGE_QUARANTINE_KEY = `${DECK_STORAGE_KEY}:unreadable`;

const COLLECTION_VERSION = 1;

export interface LoadDecksResult {
  readonly decks: readonly SavedDeck[];
  /** Problems encountered while reading. Never fatal — valid decks still load. */
  readonly issues: readonly Issue[];
}

interface RepositoryOptions {
  readonly storageKey?: string;
}

/**
 * Local deck persistence. Reads are salvaging: one corrupt deck never costs the
 * player the rest of their collection, and an unreadable payload is quarantined
 * rather than overwritten.
 */
export class DeckRepository {
  readonly #store: KeyValueStore;
  readonly #key: string;

  constructor(store: KeyValueStore, options: RepositoryOptions = {}) {
    this.#store = store;
    this.#key = options.storageKey ?? DECK_STORAGE_KEY;
  }

  load(): LoadDecksResult {
    const raw = this.#store.getItem(this.#key);
    if (raw === null) return { decks: [], issues: [] };

    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      this.#quarantine(raw);
      return {
        decks: [],
        issues: [
          error(
            'deck_storage/unreadable',
            'Saved decks could not be read and have been set aside instead of overwritten. Nothing was deleted.',
            { context: { quarantineKey: `${this.#key}:unreadable` } },
          ),
        ],
      };
    }

    const decksField = (payload as { decks?: unknown } | null)?.decks;
    if (!Array.isArray(decksField)) {
      this.#quarantine(raw);
      return {
        decks: [],
        issues: [
          error(
            'deck_storage/unexpected_shape',
            'Saved deck storage has an unexpected shape and has been set aside instead of overwritten.',
            { context: { quarantineKey: `${this.#key}:unreadable` } },
          ),
        ],
      };
    }

    const decks: SavedDeck[] = [];
    const issues: Issue[] = [];
    decksField.forEach((entry, index) => {
      const result = migrateSavedDeck(entry);
      if (result.ok) {
        decks.push(result.value);
        return;
      }
      const name =
        typeof (entry as { name?: unknown })?.name === 'string'
          ? `"${(entry as { name: string }).name}"`
          : `#${index + 1}`;
      issues.push(
        warning(
          'deck_storage/deck_skipped',
          `Saved deck ${name} could not be read and was skipped. The rest of your decks are unaffected.`,
          { path: `decks[${index}]`, context: { reasons: result.error.map((e) => e.message) } },
        ),
      );
    });

    return { decks, issues };
  }

  saveAll(decks: readonly SavedDeck[]): void {
    this.#store.setItem(this.#key, JSON.stringify({ schemaVersion: COLLECTION_VERSION, decks }));
  }

  clear(): void {
    this.#store.removeItem(this.#key);
  }

  #quarantine(raw: string): void {
    try {
      this.#store.setItem(`${this.#key}:unreadable`, raw);
    } catch {
      // Quarantine is best-effort; a full storage quota must not break loading.
    }
  }
}

/** In-memory store, for tests and for browsers that block local storage. */
export class MemoryStore implements KeyValueStore {
  readonly #map = new Map<string, string>();

  getItem(key: string): string | null {
    return this.#map.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.#map.set(key, value);
  }

  removeItem(key: string): void {
    this.#map.delete(key);
  }
}
