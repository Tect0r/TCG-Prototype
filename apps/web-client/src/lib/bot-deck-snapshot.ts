import type { CardDatabase } from '@tcg/card-data';
import {
  deckFingerprint,
  expandDeckCards,
  validateDeck,
  type DeckFormatConfig,
  type SavedDeck,
} from '@tcg/deck';
import type { BotDeckSnapshot } from '@tcg/bot-config';

/**
 * Freezing one of the host's own saved decks into bot configuration (M09.6).
 *
 * A snapshot is **contents, not a reference**. The host picks a deck, this
 * builds an immutable copy of what that deck is right now, and the copy is what
 * travels — so editing the deck in the builder afterwards changes the builder's
 * deck and nothing else. The live bot goes on playing the list the host actually
 * chose, and the panel says so rather than silently re-freezing.
 *
 * Everything below is about telling the host something actionable *before* they
 * press a button. None of it is the authority: the server re-derives the
 * fingerprint from the list it receives and re-runs `validateDeck` against its
 * own pool, and its verdict is the one that counts (CLAUDE.md §11). What this
 * saves is a round trip and a refusal the host could not have predicted.
 */

/** Why a saved deck cannot be frozen into bot configuration, or `null`. */
export interface SavedDeckReview {
  /** The deck as it is saved right now, or `null` when it is no longer saved. */
  readonly deck: SavedDeck | null;
  /** What would be sent. `null` whenever `problem` is set. */
  readonly snapshot: BotDeckSnapshot | null;
  /** One actionable sentence for the host, or `null` when the deck is usable. */
  readonly problem: string | null;
}

/**
 * The snapshot a saved deck freezes into.
 *
 * `commanderId` is required by `botDeckSnapshotSchema`, so a deck without one
 * cannot be frozen at all — which is the honest answer: a deck with no Commander
 * is not a deck anyone could play, and `reviewSavedDeckForBot` says that in
 * words rather than sending a record the codec would reject.
 */
export function botDeckSnapshotOf(deck: SavedDeck): BotDeckSnapshot | null {
  if (deck.commanderId === null) return null;
  return {
    sourceDeckId: deck.id,
    name: deck.name,
    commanderId: deck.commanderId,
    cardIds: expandDeckCards(deck.cards),
    deckHash: deckFingerprint(deck),
  };
}

/**
 * What the host should be told about the saved deck they have selected.
 *
 * Four answers, in the order the host can act on them: the deck is gone, it has
 * no Commander yet, it is not legal in this format, or it is fine.
 */
export function reviewSavedDeckForBot(
  deckId: string,
  decks: readonly SavedDeck[],
  database: CardDatabase,
  format: DeckFormatConfig,
): SavedDeckReview {
  const deck = decks.find((candidate) => candidate.id === deckId) ?? null;
  if (!deck) {
    return {
      deck: null,
      snapshot: null,
      problem: 'That deck is no longer saved in this browser. Choose another one.',
    };
  }

  const snapshot = botDeckSnapshotOf(deck);
  if (!snapshot) {
    return {
      deck,
      snapshot: null,
      problem: `"${deck.name}" has no Commander yet. Choose one in the Deck Builder first.`,
    };
  }

  const report = validateDeck(deck, database, format);
  if (!report.legal) {
    const first = report.issues.find((issue) => issue.severity === 'error');
    return {
      deck,
      snapshot: null,
      problem: `"${deck.name}" is not legal in this format: ${first?.message ?? 'it fails deck validation.'}`,
    };
  }

  return { deck, snapshot, problem: null };
}

/**
 * Whether the deck a seated bot was frozen from has changed since.
 *
 * The comparison is against the snapshot's own hash, because that is the only
 * record of what was frozen — the seat view an opponent sees carries the
 * Commander and nothing else, deliberately. A deleted source deck counts as
 * changed: the host can no longer re-freeze it, and saying nothing would leave
 * them believing they still could.
 */
export function snapshotIsStale(snapshot: BotDeckSnapshot, decks: readonly SavedDeck[]): boolean {
  const current = decks.find((deck) => deck.id === snapshot.sourceDeckId);
  if (!current) return true;
  return deckFingerprint(current) !== snapshot.deckHash;
}
