import { describe, expect, it } from 'vitest';
import {
  DECK_FINGERPRINT_LENGTH,
  DECK_FINGERPRINT_VERSION,
  canonicalDeckString,
  collectDeckCards,
  deckFingerprint,
  expandDeckCards,
  type FingerprintableDeck,
} from './fingerprint.js';

/**
 * The portable deck fingerprint (M09.6).
 *
 * Its whole job is to let two processes that were handed the same contents agree
 * on one short name for them — the client that freezes a saved deck into a bot
 * snapshot, and the server that rebuilds the list and checks the hash it was
 * sent. So the claims worth testing are: identical contents agree however they
 * were written, different contents differ, and the flattening a snapshot travels
 * in round-trips.
 */

const deck = (
  commanderId: string | null,
  cards: readonly (readonly [string, number])[],
): FingerprintableDeck => ({
  commanderId,
  cards: cards.map(([cardId, quantity]) => ({ cardId, quantity })),
});

describe('deckFingerprint', () => {
  it('is the documented length and hexadecimal', () => {
    const value = deckFingerprint(deck('cmd_a', [['card_a', 1]]));
    expect(value).toHaveLength(DECK_FINGERPRINT_LENGTH);
    expect(value).toMatch(/^[0-9a-f]+$/);
  });

  it('ignores the order entries were written in', () => {
    const written = deck('cmd_a', [
      ['card_c', 1],
      ['card_a', 2],
      ['card_b', 1],
    ]);
    const rewritten = deck('cmd_a', [
      ['card_a', 2],
      ['card_b', 1],
      ['card_c', 1],
    ]);
    expect(deckFingerprint(written)).toBe(deckFingerprint(rewritten));
  });

  it('treats a removed entry and an absent one as the same deck', () => {
    const removed = deck('cmd_a', [
      ['card_a', 1],
      ['card_b', 0],
    ]);
    expect(deckFingerprint(removed)).toBe(deckFingerprint(deck('cmd_a', [['card_a', 1]])));
  });

  it('differs when a quantity, a card or the Commander differs', () => {
    const base = deckFingerprint(deck('cmd_a', [['card_a', 1]]));
    expect(deckFingerprint(deck('cmd_a', [['card_a', 2]]))).not.toBe(base);
    expect(deckFingerprint(deck('cmd_a', [['card_b', 1]]))).not.toBe(base);
    expect(deckFingerprint(deck('cmd_b', [['card_a', 1]]))).not.toBe(base);
    expect(deckFingerprint(deck(null, [['card_a', 1]]))).not.toBe(base);
  });

  it('does not confuse a Commander with a card of the same name', () => {
    // The separator matters: without it, "commander=card_a" with an empty list
    // and no Commander with "card_a" in the list could canonicalise alike.
    expect(deckFingerprint(deck('card_a', []))).not.toBe(
      deckFingerprint(deck(null, [['card_a', 1]])),
    );
  });

  it('hashes the string it says it hashes', () => {
    // The canonical form is exported so a change to it is visible here rather
    // than only as a digest that moved for reasons nobody can read.
    expect(
      canonicalDeckString(
        deck('cmd_a', [
          ['card_b', 1],
          ['card_a', 2],
        ]),
      ),
    ).toBe(`deck/v${DECK_FINGERPRINT_VERSION}|commander=cmd_a|card_a:2,card_b:1`);
  });

  it('sorts by code unit rather than by locale', () => {
    // `localeCompare` is not identical across ICU builds, and a fingerprint two
    // machines disagree about is worse than no fingerprint at all. Underscore
    // (0x5F) sorts after every digit and before every lowercase letter here;
    // some collations disagree.
    expect(
      canonicalDeckString(
        deck(null, [
          ['a_b', 1],
          ['ab', 1],
        ]),
      ),
    ).toContain('a_b:1,ab:1');
  });
});

describe('the snapshot flattening', () => {
  it('round-trips any list a saved deck can hold', () => {
    const cards = [
      { cardId: 'card_a', quantity: 1 },
      { cardId: 'card_b', quantity: 3 },
      { cardId: 'card_c', quantity: 2 },
    ];
    expect(collectDeckCards(expandDeckCards(cards))).toEqual(cards);
  });

  it('expands every copy and counts every repeat back', () => {
    expect(expandDeckCards([{ cardId: 'card_a', quantity: 3 }])).toEqual([
      'card_a',
      'card_a',
      'card_a',
    ]);
    expect(collectDeckCards(['card_a', 'card_b', 'card_a'])).toEqual([
      { cardId: 'card_a', quantity: 2 },
      { cardId: 'card_b', quantity: 1 },
    ]);
  });

  it('keeps the fingerprint stable across the flattening', () => {
    // This is the property the server actually relies on: it never sees the
    // entries the client hashed, only the flat list, and rebuilding must produce
    // the same value or every legal saved deck would be refused.
    const original = deck('cmd_a', [
      ['card_c', 1],
      ['card_a', 2],
    ]);
    const rebuilt: FingerprintableDeck = {
      commanderId: original.commanderId,
      cards: collectDeckCards(expandDeckCards(original.cards)),
    };
    expect(deckFingerprint(rebuilt)).toBe(deckFingerprint(original));
  });
});
