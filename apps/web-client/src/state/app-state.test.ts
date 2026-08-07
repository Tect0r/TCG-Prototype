import { describe, expect, it } from 'vitest';
import { createDeck, renameDeck, type SavedDeck } from '@tcg/deck';
import { activeDeck, appReducer, initialAppState, sortDecks, type AppState } from './app-state.js';

let tick = 0;
const nextClock = () => `2026-08-07T12:00:${String(tick++).padStart(2, '0')}.000Z`;

const makeDeck = (name: string): SavedDeck => createDeck({ name, clock: nextClock });

const hydrated = (decks: readonly SavedDeck[]): AppState =>
  appReducer(initialAppState, { type: 'decks_loaded', decks, notice: null });

describe('appReducer', () => {
  it('starts unhydrated so persistence knows to wait', () => {
    expect(initialAppState.hydrated).toBe(false);
    expect(hydrated([]).hydrated).toBe(true);
  });

  it('selects the most recently edited deck after loading', () => {
    const older = makeDeck('Older');
    const newer = makeDeck('Newer');
    const state = hydrated([older, newer]);
    expect(state.activeDeckId).toBe(newer.id);
    expect(state.decks.map((d) => d.name)).toEqual(['Newer', 'Older']);
  });

  it('activates a newly created deck', () => {
    const state = hydrated([makeDeck('First')]);
    const created = makeDeck('Second');
    const next = appReducer(state, { type: 'deck_created', deck: created });
    expect(next.activeDeckId).toBe(created.id);
    expect(next.decks).toHaveLength(2);
  });

  it('replaces a deck on update and ignores unknown decks', () => {
    const deck = makeDeck('Deck');
    const state = hydrated([deck]);
    const renamed = renameDeck(deck, 'Renamed', nextClock);

    expect(appReducer(state, { type: 'deck_updated', deck: renamed }).decks[0]?.name).toBe(
      'Renamed',
    );
    expect(appReducer(state, { type: 'deck_updated', deck: makeDeck('Ghost') })).toBe(state);
  });

  it('moves the selection when the active deck is deleted', () => {
    const first = makeDeck('First');
    const second = makeDeck('Second');
    const state = hydrated([first, second]);

    const afterDelete = appReducer(state, { type: 'deck_deleted', deckId: second.id });
    expect(afterDelete.activeDeckId).toBe(first.id);

    const afterLast = appReducer(afterDelete, { type: 'deck_deleted', deckId: first.id });
    expect(afterLast.activeDeckId).toBeNull();
    expect(afterLast.decks).toEqual([]);
  });

  it('keeps the selection when a different deck is deleted', () => {
    const first = makeDeck('First');
    const second = makeDeck('Second');
    const state = { ...hydrated([first, second]), activeDeckId: first.id };
    expect(appReducer(state, { type: 'deck_deleted', deckId: second.id }).activeDeckId).toBe(
      first.id,
    );
  });

  it('activates the first imported deck and reports the outcome', () => {
    const state = hydrated([makeDeck('Existing')]);
    const imported = makeDeck('Imported');
    const next = appReducer(state, {
      type: 'decks_imported',
      decks: [imported],
      notice: { tone: 'info', message: 'Imported 1 deck.' },
    });
    expect(next.activeDeckId).toBe(imported.id);
    expect(next.notice?.message).toBe('Imported 1 deck.');
  });

  it('shows and dismisses notices', () => {
    const shown = appReducer(initialAppState, {
      type: 'notice_shown',
      notice: { tone: 'error', message: 'Nope' },
    });
    expect(shown.notice?.tone).toBe('error');
    expect(appReducer(shown, { type: 'notice_dismissed' }).notice).toBeNull();
  });
});

describe('selectors', () => {
  it('finds the active deck, or nothing when none is selected', () => {
    const deck = makeDeck('Deck');
    const state = hydrated([deck]);
    expect(activeDeck(state)?.id).toBe(deck.id);
    expect(activeDeck({ ...state, activeDeckId: null })).toBeUndefined();
  });

  it('sorts decks by last edit, newest first', () => {
    const a = makeDeck('A');
    const b = makeDeck('B');
    expect(sortDecks([a, b]).map((d) => d.name)).toEqual(['B', 'A']);
  });
});
