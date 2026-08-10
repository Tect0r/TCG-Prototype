import { DEVELOPMENT_DECK_FORMAT } from './format.js';
import { describe, expect, it } from 'vitest';
import {
  addCard,
  copyLimitFor,
  countOf,
  createDeck,
  deckSize,
  duplicateDeck,
  removeCard,
  removeUnresolvedCards,
  renameDeck,
  setCardQuantity,
  setCommander,
  setDeckNotes,
} from './operations.js';
import { DECK_SCHEMA_VERSION, savedDeckSchema } from './schema.js';
import { database, deckWith, fixedClock, fixedIdSources } from './test-fixtures.js';

const laterClock = () => '2026-08-08T09:30:00.000Z';

describe('createDeck', () => {
  it('produces a deck that satisfies the saved schema', () => {
    const deck = createDeck({ name: 'New Deck', clock: fixedClock, idSources: fixedIdSources });
    expect(savedDeckSchema.safeParse(deck).success).toBe(true);
    expect(deck.schemaVersion).toBe(DECK_SCHEMA_VERSION);
    expect(deck.commanderId).toBeNull();
    expect(deck.cards).toEqual([]);
    expect(deck.createdAt).toBe(deck.updatedAt);
  });
});

describe('deck edits', () => {
  it('never mutates the deck it is given', () => {
    const deck = deckWith([['goblin_scout', 1]]);
    const snapshot = structuredClone(deck);
    addCard(deck, 'scorch', { clock: laterClock });
    removeCard(deck, 'goblin_scout', { clock: laterClock });
    renameDeck(deck, 'Other', laterClock);
    expect(deck).toEqual(snapshot);
  });

  it('bumps updatedAt only when something changed', () => {
    const deck = deckWith([['goblin_scout', 1]]);
    expect(addCard(deck, 'scorch', { clock: laterClock }).updatedAt).toBe(laterClock());
    // Removing a card that is not in the deck is a no-op.
    expect(removeCard(deck, 'scorch', { clock: laterClock })).toBe(deck);
  });

  it('accumulates copies and removes the entry at zero', () => {
    let deck = deckWith([]);
    deck = addCard(deck, 'goblin_scout', { clock: fixedClock });
    deck = addCard(deck, 'goblin_scout', { clock: fixedClock });
    expect(countOf(deck, 'goblin_scout')).toBe(2);

    deck = removeCard(deck, 'goblin_scout', { amount: 2, clock: fixedClock });
    expect(countOf(deck, 'goblin_scout')).toBe(0);
    expect(deck.cards).toEqual([]);
  });

  it('clamps quantities to the supplied limit', () => {
    const deck = setCardQuantity(deckWith([]), 'goblin_scout', 9, { limit: 2, clock: fixedClock });
    expect(countOf(deck, 'goblin_scout')).toBe(2);
  });

  it('never goes below zero copies', () => {
    const deck = removeCard(deckWith([['goblin_scout', 1]]), 'goblin_scout', {
      amount: 5,
      clock: fixedClock,
    });
    expect(deckSize(deck)).toBe(0);
  });

  it('changes the Commander without touching the card list', () => {
    const deck = deckWith([['goblin_scout', 2]]);
    const changed = setCommander(deck, 'prototype_commander_red', fixedClock);
    expect(changed.commanderId).toBe('prototype_commander_red');
    expect(changed.cards).toEqual(deck.cards);
  });

  it('stores trimmed notes and drops them when emptied', () => {
    const withNotes = setDeckNotes(deckWith([]), '  aggro test  ', fixedClock);
    expect(withNotes.notes).toBe('aggro test');
    expect(setDeckNotes(withNotes, '   ', fixedClock).notes).toBeUndefined();
  });

  it('drops unresolved cards on request', () => {
    const deck = deckWith([
      ['goblin_scout', 2],
      ['ghost_card', 1],
    ]);
    const cleaned = removeUnresolvedCards(deck, ['ghost_card'], fixedClock);
    expect(cleaned.cards.map((e) => e.cardId)).toEqual(['goblin_scout']);
    expect(removeUnresolvedCards(cleaned, [], fixedClock)).toBe(cleaned);
  });
});

describe('duplicateDeck', () => {
  it('copies contents under a fresh identity', () => {
    const original = deckWith([['goblin_scout', 2]]);
    const copy = duplicateDeck(original, { clock: laterClock, idSources: fixedIdSources });

    expect(copy.id).not.toBe(original.id);
    expect(copy.name).toBe('Test Deck (copy)');
    expect(copy.cards).toEqual(original.cards);
    expect(copy.commanderId).toBe(original.commanderId);
    expect(copy.createdAt).toBe(laterClock());
  });

  it('deep-copies entries so edits do not leak between decks', () => {
    const original = deckWith([['goblin_scout', 2]]);
    const copy = duplicateDeck(original, { idSources: fixedIdSources });
    const edited = setCardQuantity(copy, 'goblin_scout', 1, { clock: laterClock });
    expect(countOf(original, 'goblin_scout')).toBe(2);
    expect(countOf(edited, 'goblin_scout')).toBe(1);
  });

  it('honours an explicit name', () => {
    const copy = duplicateDeck(deckWith([]), { name: 'Variant B', idSources: fixedIdSources });
    expect(copy.name).toBe('Variant B');
  });
});

describe('copyLimitFor', () => {
  it('is 1 for unique cards and 2 for regular cards by default', () => {
    const format = DEVELOPMENT_DECK_FORMAT;
    expect(copyLimitFor(database.getOrThrow('overload_conduit'), format)).toBe(1);
    expect(copyLimitFor(database.getOrThrow('goblin_scout'), format)).toBe(2);
  });
});
