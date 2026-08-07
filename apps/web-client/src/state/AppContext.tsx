import { createContext, useContext, useEffect, useMemo, useReducer } from 'react';
import type { ReactNode } from 'react';
import type { CardDatabase, CardId } from '@tcg/card-data';
import {
  createDeck,
  DeckRepository,
  duplicateDeck,
  MemoryStore,
  parseDecksFromJson,
  prepareImportedDeck,
  renameDeck,
  type KeyValueStore,
  type SavedDeck,
} from '@tcg/deck';
import { activeDeck as selectActiveDeck, appReducer, initialAppState, type AppState, type Notice } from './app-state.js';

export interface AppActions {
  newDeck(name: string): void;
  selectDeck(deckId: string | null): void;
  updateDeck(deck: SavedDeck): void;
  renameActiveDeck(name: string): void;
  duplicateActiveDeck(): void;
  deleteDeck(deckId: string): void;
  importFromJson(text: string): void;
  showNotice(notice: Notice): void;
  dismissNotice(): void;
}

interface AppContextValue {
  readonly database: CardDatabase;
  readonly state: AppState;
  readonly actions: AppActions;
  readonly deck: SavedDeck | undefined;
}

const AppContext = createContext<AppContextValue | null>(null);

/** Local storage, or an in-memory stand-in when the browser blocks it. */
function resolveStore(): KeyValueStore {
  try {
    const probe = '__tcg_probe__';
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return new MemoryStore();
  }
}

interface AppProviderProps {
  readonly database: CardDatabase;
  readonly children: ReactNode;
  /** Injected in tests; defaults to browser local storage. */
  readonly store?: KeyValueStore;
}

export function AppProvider({ database, children, store }: AppProviderProps) {
  const repository = useMemo(() => new DeckRepository(store ?? resolveStore()), [store]);
  const [state, dispatch] = useReducer(appReducer, initialAppState);

  useEffect(() => {
    const { decks, issues } = repository.load();
    const errors = issues.filter((i) => i.severity === 'error');
    dispatch({
      type: 'decks_loaded',
      decks,
      notice:
        issues.length === 0
          ? null
          : {
              tone: errors.length > 0 ? 'error' : 'info',
              message:
                errors.length > 0
                  ? 'Some saved decks could not be read.'
                  : 'Some saved decks were skipped while loading.',
              details: issues,
            },
    });
  }, [repository]);

  // Persist after every change, but never before hydration. `hydrated` lives in
  // reducer state rather than a ref on purpose: a ref flips synchronously
  // inside the load effect, so this effect would then run in the same commit
  // with the still-empty `state.decks` and erase the stored collection.
  useEffect(() => {
    if (!state.hydrated) return;
    repository.saveAll(state.decks);
  }, [repository, state.hydrated, state.decks]);

  const deck = selectActiveDeck(state);

  const actions = useMemo<AppActions>(
    () => ({
      newDeck: (name) => dispatch({ type: 'deck_created', deck: createDeck({ name }) }),
      selectDeck: (deckId) => dispatch({ type: 'deck_selected', deckId }),
      updateDeck: (updated) => dispatch({ type: 'deck_updated', deck: updated }),
      renameActiveDeck: (name) => {
        if (!deck) return;
        dispatch({ type: 'deck_updated', deck: renameDeck(deck, name) });
      },
      duplicateActiveDeck: () => {
        if (!deck) return;
        dispatch({ type: 'deck_created', deck: duplicateDeck(deck) });
      },
      deleteDeck: (deckId) => dispatch({ type: 'deck_deleted', deckId }),
      importFromJson: (text) => {
        const result = parseDecksFromJson(text);
        if (!result.ok) {
          dispatch({
            type: 'notice_shown',
            notice: {
              tone: 'error',
              message: 'Import failed. Your saved decks were not changed.',
              details: result.error,
            },
          });
          return;
        }
        // Prepared one at a time so two colliding decks in the same file also
        // get distinct names and IDs.
        const prepared: SavedDeck[] = [];
        for (const incoming of result.value.decks) {
          prepared.push(prepareImportedDeck(incoming, { existing: [...state.decks, ...prepared] }));
        }
        dispatch({
          type: 'decks_imported',
          decks: prepared,
          notice: {
            tone: 'info',
            message: `Imported ${prepared.length} deck${prepared.length === 1 ? '' : 's'}.`,
          },
        });
      },
      showNotice: (notice) => dispatch({ type: 'notice_shown', notice }),
      dismissNotice: () => dispatch({ type: 'notice_dismissed' }),
    }),
    [deck, state.decks],
  );

  const value = useMemo<AppContextValue>(
    () => ({ database, state, actions, deck }),
    [database, state, actions, deck],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp must be used inside <AppProvider>');
  return value;
}

export const useCardDatabase = (): CardDatabase => useApp().database;
export const useAppState = (): AppState => useApp().state;
export const useAppActions = (): AppActions => useApp().actions;
export const useActiveDeck = (): SavedDeck | undefined => useApp().deck;

/** Commander card of the active deck, when one is chosen and still exists. */
export function useActiveCommanderId(): CardId | null {
  return useApp().deck?.commanderId ?? null;
}
