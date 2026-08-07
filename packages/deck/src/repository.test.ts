import { describe, expect, it } from 'vitest';
import { DeckRepository, MemoryStore, DECK_STORAGE_KEY } from './repository.js';
import { deckWith, legalDeck } from './test-fixtures.js';

const newRepo = () => {
  const store = new MemoryStore();
  return { store, repo: new DeckRepository(store) };
};

describe('DeckRepository', () => {
  it('returns nothing for a fresh browser', () => {
    const { repo } = newRepo();
    expect(repo.load()).toEqual({ decks: [], issues: [] });
  });

  it('round-trips decks across a reload', () => {
    const { store, repo } = newRepo();
    const decks = [legalDeck(), deckWith([['goblin_scout', 1]])];
    repo.saveAll(decks);

    const reloaded = new DeckRepository(store).load();
    expect(reloaded.issues).toEqual([]);
    expect(reloaded.decks).toEqual(decks);
  });

  it('quarantines an unreadable payload instead of destroying it', () => {
    const { store, repo } = newRepo();
    store.setItem(DECK_STORAGE_KEY, 'not json at all');

    const result = repo.load();
    expect(result.decks).toEqual([]);
    expect(result.issues[0]?.code).toBe('deck_storage/unreadable');
    expect(store.getItem(`${DECK_STORAGE_KEY}:unreadable`)).toBe('not json at all');
  });

  it('quarantines a payload with an unexpected shape', () => {
    const { store, repo } = newRepo();
    store.setItem(DECK_STORAGE_KEY, JSON.stringify({ decks: 'nope' }));

    const result = repo.load();
    expect(result.issues[0]?.code).toBe('deck_storage/unexpected_shape');
    expect(store.getItem(`${DECK_STORAGE_KEY}:unreadable`)).not.toBeNull();
  });

  it('skips one broken deck but keeps the rest of the collection', () => {
    const { store, repo } = newRepo();
    const good = legalDeck();
    store.setItem(
      DECK_STORAGE_KEY,
      JSON.stringify({ schemaVersion: 1, decks: [good, { name: 'Broken' }] }),
    );

    const result = repo.load();
    expect(result.decks).toEqual([good]);
    expect(result.issues[0]?.code).toBe('deck_storage/deck_skipped');
    expect(result.issues[0]?.severity).toBe('warning');
    expect(result.issues[0]?.message).toContain('"Broken"');
  });

  it('honours a custom storage key so tests and profiles can be isolated', () => {
    const store = new MemoryStore();
    new DeckRepository(store, { storageKey: 'alt' }).saveAll([legalDeck()]);
    expect(store.getItem(DECK_STORAGE_KEY)).toBeNull();
    expect(store.getItem('alt')).not.toBeNull();
  });

  it('clears only its own key', () => {
    const { store, repo } = newRepo();
    store.setItem('unrelated', 'keep me');
    repo.saveAll([legalDeck()]);
    repo.clear();
    expect(repo.load().decks).toEqual([]);
    expect(store.getItem('unrelated')).toBe('keep me');
  });
});
