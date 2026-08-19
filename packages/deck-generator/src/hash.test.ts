import { describe, expect, it } from 'vitest';
import { canonicalJson, deckHash, digest, digestOf } from './hash.js';

/** CLAUDE.md §13.15 item 13: canonical deck hashes. */

describe('canonicalJson', () => {
  it('is independent of key insertion order', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe(canonicalJson({ a: 2, b: 1 }));
  });

  it('preserves array order, which is meaningful', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('drops undefined members so an absent key and an undefined key agree', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });

  it('sorts nested objects too', () => {
    expect(canonicalJson({ outer: { z: 1, a: 2 } })).toBe('{"outer":{"a":2,"z":1}}');
  });
});

describe('digest', () => {
  it('is stable and honours the requested length', () => {
    expect(digest('abc', 16)).toBe(digest('abc', 16));
    expect(digest('abc', 8)).toHaveLength(8);
    expect(digest('abc', 32)).toHaveLength(32);
    expect(digest('abc', 32).startsWith(digest('abc', 8))).toBe(true);
  });

  it('separates different inputs', () => {
    expect(digest('abc')).not.toBe(digest('abd'));
  });

  it('hashes structurally equal values identically regardless of build order', () => {
    expect(digestOf({ a: [1, { y: 1, x: 2 }] })).toBe(digestOf({ a: [1, { x: 2, y: 1 }] }));
  });
});

describe('deckHash', () => {
  const cards = [
    { cardId: 'prototype_scout', quantity: 2 },
    { cardId: 'prototype_guard', quantity: 1 },
    { cardId: 'trench_guard', quantity: 2 },
  ] as const;

  it('is stable across card entry order', () => {
    const forward = deckHash({ commanderId: 'prototype_commander_blue', cards });
    const reversed = deckHash({
      commanderId: 'prototype_commander_blue',
      cards: [...cards].reverse(),
    });
    expect(forward).toBe(reversed);
  });

  it('changes when a quantity changes', () => {
    const before = deckHash({ commanderId: 'prototype_commander_blue', cards });
    const after = deckHash({
      commanderId: 'prototype_commander_blue',
      cards: cards.map((entry) =>
        entry.cardId === 'prototype_guard' ? { ...entry, quantity: 2 } : entry,
      ),
    });
    expect(after).not.toBe(before);
  });

  it('changes when the Commander changes', () => {
    expect(deckHash({ commanderId: 'prototype_commander_blue', cards })).not.toBe(
      deckHash({ commanderId: 'prototype_commander_red', cards }),
    );
  });

  it('treats a zero-quantity entry as absent', () => {
    expect(
      deckHash({
        commanderId: 'prototype_commander_blue',
        cards: [...cards, { cardId: 'unstable_construct', quantity: 0 }],
      }),
    ).toBe(deckHash({ commanderId: 'prototype_commander_blue', cards }));
  });

  it('does not confuse two decks that differ only in which card is doubled', () => {
    const left = deckHash({
      commanderId: 'prototype_commander_blue',
      cards: [
        { cardId: 'prototype_scout', quantity: 2 },
        { cardId: 'prototype_guard', quantity: 1 },
      ],
    });
    const right = deckHash({
      commanderId: 'prototype_commander_blue',
      cards: [
        { cardId: 'prototype_scout', quantity: 1 },
        { cardId: 'prototype_guard', quantity: 2 },
      ],
    });
    expect(left).not.toBe(right);
  });
});
