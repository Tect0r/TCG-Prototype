import { describe, expect, it } from 'vitest';
import { MAX_FORMAT_DECK_SIZE, bundledPrecon, loadBundledCardData } from '@tcg/card-data';
import { DEFAULT_DECK_FORMAT, deckFingerprint, preconToDeck, type SavedDeck } from '@tcg/deck';
import { botDeckSnapshotSchema } from '@tcg/bot-config';
import { botDeckSnapshotOf, reviewSavedDeckForBot, snapshotIsStale } from './bot-deck-snapshot.js';

/**
 * Freezing a saved deck into bot configuration (M09.6).
 *
 * These are the four answers the host can act on — the deck is gone, it has no
 * Commander, it is not legal here, or it is fine — plus the one question the
 * panel asks after a bot is seated: has the deck this bot was frozen from
 * changed since?
 */

const { database } = loadBundledCardData();

function requirePrecon(preconId: string) {
  const precon = bundledPrecon(preconId);
  if (!precon) throw new Error(`${preconId} is missing from the bundle.`);
  return precon;
}

function legalDeck(overrides: Partial<SavedDeck> = {}): SavedDeck {
  return {
    ...preconToDeck(requirePrecon('precon_goblin_swarm'), {
      id: 'deck_mine',
      now: '2026-08-14T09:00:00.000Z',
    }),
    name: 'My secret brew',
    ...overrides,
  };
}

describe('botDeckSnapshotOf', () => {
  it('freezes the Commander, the name, every copy and a fingerprint of the lot', () => {
    const deck = legalDeck();
    const snapshot = botDeckSnapshotOf(deck);

    expect(snapshot).toEqual({
      sourceDeckId: 'deck_mine',
      name: 'My secret brew',
      commanderId: deck.commanderId,
      cardIds: deck.cards.map((entry) => entry.cardId),
      deckHash: deckFingerprint(deck),
    });
  });

  it('cannot freeze a deck with no Commander', () => {
    expect(botDeckSnapshotOf(legalDeck({ commanderId: null }))).toBeNull();
  });
});

describe('reviewSavedDeckForBot', () => {
  it('accepts a legal deck and offers the snapshot that would be sent', () => {
    const deck = legalDeck();
    const review = reviewSavedDeckForBot(deck.id, [deck], database, DEFAULT_DECK_FORMAT);

    expect(review.problem).toBeNull();
    expect(review.deck).toBe(deck);
    expect(review.snapshot?.deckHash).toBe(deckFingerprint(deck));
  });

  it('says so when the deck is no longer saved', () => {
    const review = reviewSavedDeckForBot(
      'deck_deleted',
      [legalDeck()],
      database,
      DEFAULT_DECK_FORMAT,
    );

    expect(review.deck).toBeNull();
    expect(review.snapshot).toBeNull();
    expect(review.problem).toContain('no longer saved');
  });

  it('says so when the deck has no Commander yet', () => {
    const incomplete = legalDeck({ commanderId: null });
    const review = reviewSavedDeckForBot(
      incomplete.id,
      [incomplete],
      database,
      DEFAULT_DECK_FORMAT,
    );

    expect(review.snapshot).toBeNull();
    expect(review.problem).toContain('no Commander yet');
  });

  it('names the rule a deck breaks rather than only that it is illegal', () => {
    const short = legalDeck({ cards: legalDeck().cards.slice(0, 12) });
    const review = reviewSavedDeckForBot(short.id, [short], database, DEFAULT_DECK_FORMAT);

    expect(review.snapshot).toBeNull();
    expect(review.problem).toContain('12 of 40');
    // The deck itself is still returned: the host chose it, and hiding it would
    // make the picker disagree with the message beside it.
    expect(review.deck).toBe(short);
  });

  /**
   * The one path a saved deck reaches `botDeckSnapshotSchema.cardIds` by, and
   * what the M09.18 ceiling means on it.
   *
   * A deck long enough to breach the ceiling is refused here **as an illegal
   * deck**, by the format's exact size, and never reaches the bound at all —
   * which is the evidence that narrowing the schema refuses nothing a host could
   * legitimately have sent. The bound is the backstop behind that, not the
   * first line of it.
   */
  it('refuses an over-long deck on the format rule, well before the schema ceiling', () => {
    const base = legalDeck();
    const first = base.cards[0];
    if (!first) throw new Error('The fixture precon has no cards.');
    const huge = legalDeck({
      cards: [...base.cards, { cardId: first.cardId, quantity: MAX_FORMAT_DECK_SIZE }],
    });

    const review = reviewSavedDeckForBot(huge.id, [huge], database, DEFAULT_DECK_FORMAT);
    expect(review.snapshot).toBeNull();
    expect(review.problem).toContain('is not legal in this format');
    // The active format asks for exactly 40 singleton cards, so its legal decks
    // are nowhere near the ceiling and the host is told a rule they can act on
    // rather than a limit they will never meet.
    expect(DEFAULT_DECK_FORMAT.deckSize).toBeLessThan(MAX_FORMAT_DECK_SIZE);

    // And had it somehow been sent anyway, the schema is the backstop: the raw
    // freeze is longer than any format can require, so the codec refuses it.
    const raw = botDeckSnapshotOf(huge);
    expect(raw?.cardIds.length).toBeGreaterThan(MAX_FORMAT_DECK_SIZE);
    expect(botDeckSnapshotSchema.safeParse(raw).success).toBe(false);
  });
});

describe('snapshotIsStale', () => {
  const deck = legalDeck();
  const snapshot = botDeckSnapshotOf(deck);
  if (!snapshot) throw new Error('The fixture deck should freeze.');

  it('is false while the source deck still holds what was frozen', () => {
    expect(snapshotIsStale(snapshot, [deck])).toBe(false);
  });

  it('is true once a card has moved', () => {
    const edited: SavedDeck = { ...deck, cards: deck.cards.slice(1) };
    expect(snapshotIsStale(snapshot, [edited])).toBe(true);
  });

  it('is false for a rename, because a name is not the list', () => {
    expect(snapshotIsStale(snapshot, [{ ...deck, name: 'Renamed' }])).toBe(false);
  });

  it('is true when the source deck has been deleted', () => {
    // The host can no longer re-freeze it, and saying nothing would leave them
    // believing they still could.
    expect(snapshotIsStale(snapshot, [])).toBe(true);
  });
});
