import { createHash } from 'node:crypto';
import type { CardId } from '@tcg/card-data';

/**
 * Stable hashing.
 *
 * Everything the simulator identifies — a deck, an environment, a match — is
 * named by a hash of its own immutable content rather than by a counter, so the
 * same inputs produce the same names on any machine, in any worker, in any
 * order. That is what makes resume, deduplication and paired comparison work
 * (CLAUDE.md §13.4, §13.7, §13.8).
 *
 * The algorithm is SHA-256 truncated to a documented number of hex characters.
 * Truncation is fine here: these are content addresses for a local experiment
 * directory, not a security boundary.
 */

/** Bump when a hashing input or the truncation length changes. */
export const HASH_VERSION = 1;

export function digest(input: string, length = 16): string {
  return createHash('sha256').update(input, 'utf8').digest('hex').slice(0, length);
}

/** Hashes a JSON-serializable value with sorted object keys. */
export function digestOf(value: unknown, length = 16): string {
  return digest(canonicalJson(value), length);
}

/**
 * JSON with every object key sorted, so two structurally equal values that were
 * built in a different order hash the same.
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right));
    return Object.fromEntries(entries.map(([key, entry]) => [key, sortDeep(entry)]));
  }
  return value;
}

export interface HashableDeck {
  readonly commanderId: CardId | null;
  readonly cards: readonly { readonly cardId: CardId; readonly quantity: number }[];
}

/**
 * Canonical deck hash: independent of the order entries were written in, and
 * different whenever a quantity or the Commander differs (CLAUDE.md §13.8).
 *
 * Zero-quantity entries are dropped first, so "two copies then remove both" and
 * "never added" are the same deck.
 */
export function deckHash(deck: HashableDeck): string {
  const cards = deck.cards
    .filter((entry) => entry.quantity > 0)
    .map((entry) => [entry.cardId, entry.quantity] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return digest(
    `v${HASH_VERSION}|commander=${deck.commanderId ?? ''}|${cards.map(([id, n]) => `${id}:${n}`).join(',')}`,
  );
}
