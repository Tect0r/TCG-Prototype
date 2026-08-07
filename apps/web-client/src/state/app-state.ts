import type { Issue } from '@tcg/shared';
import type { SavedDeck } from '@tcg/deck';

/**
 * Deck-builder application state and its reducer. Kept as a pure function of
 * `(state, action)` so it can be unit tested without rendering anything.
 */

export interface Notice {
  readonly tone: 'info' | 'error';
  readonly message: string;
  /** Structured detail shown under the message, e.g. import errors. */
  readonly details?: readonly Issue[];
}

export interface AppState {
  readonly decks: readonly SavedDeck[];
  readonly activeDeckId: string | null;
  readonly notice: Notice | null;
  /**
   * False until saved decks have been read from storage. Persistence must wait
   * for this: writing the initial empty state back would erase the collection.
   */
  readonly hydrated: boolean;
}

export type AppAction =
  | { type: 'decks_loaded'; decks: readonly SavedDeck[]; notice: Notice | null }
  | { type: 'deck_created'; deck: SavedDeck }
  | { type: 'deck_updated'; deck: SavedDeck }
  | { type: 'deck_deleted'; deckId: string }
  | { type: 'deck_selected'; deckId: string | null }
  | { type: 'decks_imported'; decks: readonly SavedDeck[]; notice: Notice }
  | { type: 'notice_shown'; notice: Notice }
  | { type: 'notice_dismissed' };

export const initialAppState: AppState = {
  decks: [],
  activeDeckId: null,
  notice: null,
  hydrated: false,
};

const byUpdatedDesc = (a: SavedDeck, b: SavedDeck): number => b.updatedAt.localeCompare(a.updatedAt);

/** Most recently edited first, so the deck list matches how people work. */
export function sortDecks(decks: readonly SavedDeck[]): SavedDeck[] {
  return [...decks].sort(byUpdatedDesc);
}

export function appReducer(state: AppState, action: AppAction): AppState {
  switch (action.type) {
    case 'decks_loaded': {
      const decks = sortDecks(action.decks);
      return { decks, activeDeckId: decks[0]?.id ?? null, notice: action.notice, hydrated: true };
    }

    case 'deck_created':
      return {
        ...state,
        decks: sortDecks([...state.decks, action.deck]),
        activeDeckId: action.deck.id,
      };

    case 'deck_updated': {
      if (!state.decks.some((deck) => deck.id === action.deck.id)) return state;
      return {
        ...state,
        decks: sortDecks(state.decks.map((deck) => (deck.id === action.deck.id ? action.deck : deck))),
      };
    }

    case 'deck_deleted': {
      const decks = state.decks.filter((deck) => deck.id !== action.deckId);
      const activeDeckId =
        state.activeDeckId === action.deckId ? (decks[0]?.id ?? null) : state.activeDeckId;
      return { ...state, decks, activeDeckId };
    }

    case 'deck_selected':
      return { ...state, activeDeckId: action.deckId };

    case 'decks_imported': {
      const decks = sortDecks([...state.decks, ...action.decks]);
      return { decks, activeDeckId: action.decks[0]?.id ?? state.activeDeckId, notice: action.notice };
    }

    case 'notice_shown':
      return { ...state, notice: action.notice };

    case 'notice_dismissed':
      return { ...state, notice: null };

    default: {
      const exhaustive: never = action;
      return exhaustive;
    }
  }
}

export function activeDeck(state: AppState): SavedDeck | undefined {
  return state.decks.find((deck) => deck.id === state.activeDeckId);
}
