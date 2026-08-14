import type { CardId } from '@tcg/card-data';
import type { DeckEntry } from './schema.js';

/**
 * A portable fingerprint of a deck's contents (M09.6), and the flattening a
 * frozen snapshot travels in.
 *
 * **Why this exists at all.** M09.6 sends a saved deck's contents to the server
 * as bot configuration, and the server has to be able to say "this is not the
 * list the hash names" — an edit that raced the send, or a record assembled by
 * something that did not agree with itself. That check is only possible if both
 * sides compute the same value from the same contents, so the function has to
 * run in a browser as well as in the server process.
 *
 * **Why it is not `apps/simulator/src/hash.ts`.** That one is SHA-256 through
 * `node:crypto` and is the content address of an experiment directory: changing
 * it would rename every recorded result, and importing it would put `node:crypto`
 * in the deck builder. Making the simulator's chain portable is M09.8's subject,
 * and this deliberately does not pre-empt it. The two are different functions
 * with different owners — `HASH_VERSION` names the simulator's, and
 * `DECK_FINGERPRINT_VERSION` names this one — and M09.8 decides whether they
 * ever converge.
 *
 * **Why a non-cryptographic hash is enough.** Nothing trusts this value on its
 * own. The whole card list travels beside it and is re-validated by
 * `validateDeck` against the server's own pool, so a collision buys an attacker
 * nothing that sending the list plainly would not already have bought them. What
 * the fingerprint catches is an *accidental* disagreement between a list and the
 * hash written for it, and it gives the host a short stable name for the deck
 * their bot is playing.
 */

/** Bump when the canonical string or the digest below changes. */
export const DECK_FINGERPRINT_VERSION = 1;

/** How many hex characters a fingerprint has. `deckHashSchema` allows 8 to 128. */
export const DECK_FINGERPRINT_LENGTH = 16;

/** The part of a deck that decides its identity: the Commander and the list. */
export interface FingerprintableDeck {
  readonly commanderId: CardId | null;
  readonly cards: readonly DeckEntry[];
}

const FNV_OFFSET_BASIS = 0xcbf29ce484222325n;
const FNV_PRIME = 0x100000001b3n;
const UINT64 = 0xffffffffffffffffn;

/**
 * FNV-1a over UTF-16 code units.
 *
 * Code units rather than UTF-8 bytes because the inputs are card IDs and
 * integers — `[a-z][a-z0-9_]*` and digits, where the two encodings agree — and
 * because a hand-written UTF-8 encoder would be a second thing to get wrong. A
 * future input with characters outside ASCII would still hash deterministically;
 * it would simply hash the code units it is made of.
 */
function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= BigInt(input.charCodeAt(index));
    hash = (hash * FNV_PRIME) & UINT64;
  }
  return hash;
}

/**
 * The exact string a fingerprint is taken over. Exported so a test can assert
 * what the digest actually depends on rather than only that it changed.
 *
 * Entries are sorted by raw code unit, **not** by `localeCompare`: the ordering
 * has to be identical in every browser and every Node build, and locale-aware
 * collation is not. Zero-quantity entries are dropped first, so "added two and
 * removed both" and "never added" are the same deck.
 */
export function canonicalDeckString(deck: FingerprintableDeck): string {
  const cards = deck.cards
    .filter((entry) => entry.quantity > 0)
    .map((entry) => `${entry.cardId}:${entry.quantity}`)
    .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
  return `deck/v${DECK_FINGERPRINT_VERSION}|commander=${deck.commanderId ?? ''}|${cards.join(',')}`;
}

/**
 * A stable fingerprint of a deck's contents: independent of the order entries
 * were written in, and different whenever a quantity, a card or the Commander
 * differs.
 */
export function deckFingerprint(deck: FingerprintableDeck): string {
  return fnv1a64(canonicalDeckString(deck)).toString(16).padStart(DECK_FINGERPRINT_LENGTH, '0');
}

/**
 * Deck entries as the flat card list a frozen snapshot carries.
 *
 * A snapshot stores every copy separately because that is the shape
 * `botDeckSnapshotSchema` chose in M09.1, and both directions live here so the
 * client that freezes a deck and the server that rebuilds it cannot disagree
 * about what the flattening means.
 */
export function expandDeckCards(cards: readonly DeckEntry[]): CardId[] {
  const expanded: CardId[] = [];
  for (const entry of cards) {
    for (let copy = 0; copy < entry.quantity; copy += 1) expanded.push(entry.cardId);
  }
  return expanded;
}

/**
 * The inverse: a flat card list back into deck entries, in first-appearance
 * order, with repeats counted rather than duplicated.
 *
 * `collectDeckCards(expandDeckCards(cards))` is `cards` for any list a saved
 * deck can hold, because `deckEntrySchema` already forbids a quantity below 1
 * and `validateDeck` refuses a card ID that appears in two entries.
 */
export function collectDeckCards(cardIds: readonly CardId[]): DeckEntry[] {
  const order: CardId[] = [];
  const counts = new Map<CardId, number>();
  for (const cardId of cardIds) {
    const seen = counts.get(cardId);
    if (seen === undefined) order.push(cardId);
    counts.set(cardId, (seen ?? 0) + 1);
  }
  return order.map((cardId) => ({ cardId, quantity: counts.get(cardId) ?? 1 }));
}
