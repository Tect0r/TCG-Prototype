import { useRef, useState } from 'react';
import { exportDeckToJson, exportDecksToJson, suggestDeckFilename, type SavedDeck } from '@tcg/deck';
import { useAppActions, useAppState } from '../state/AppContext.js';
import { downloadTextFile } from '../lib/download.js';

/** Deck management: create, select, rename, duplicate, delete, import, export. */
export function DeckToolbar({ deck }: { readonly deck: SavedDeck | undefined }) {
  const { decks } = useAppState();
  const actions = useAppActions();
  const fileInput = useRef<HTMLInputElement>(null);
  const [renaming, setRenaming] = useState(false);
  const [draftName, setDraftName] = useState('');

  const startRename = () => {
    if (!deck) return;
    setDraftName(deck.name);
    setRenaming(true);
  };

  const commitRename = () => {
    const trimmed = draftName.trim();
    if (trimmed) actions.renameActiveDeck(trimmed);
    setRenaming(false);
  };

  const handleImportFile = async (file: File | undefined) => {
    if (!file) return;
    try {
      actions.importFromJson(await file.text());
    } catch (cause) {
      actions.showNotice({
        tone: 'error',
        message: `Could not read that file: ${cause instanceof Error ? cause.message : String(cause)}`,
      });
    }
  };

  return (
    <div className="deck-toolbar">
      <label className="visually-hidden" htmlFor="deck-select">
        Active deck
      </label>
      <select
        id="deck-select"
        value={deck?.id ?? ''}
        disabled={decks.length === 0}
        onChange={(event) => actions.selectDeck(event.target.value || null)}
      >
        {decks.length === 0 && <option value="">No decks yet</option>}
        {decks.map((entry) => (
          <option key={entry.id} value={entry.id}>
            {entry.name}
          </option>
        ))}
      </select>

      <button type="button" className="primary" onClick={() => actions.newDeck(`Deck ${decks.length + 1}`)}>
        New deck
      </button>

      {renaming ? (
        <span className="deck-toolbar__rename">
          <label className="visually-hidden" htmlFor="deck-rename">
            Deck name
          </label>
          <input
            id="deck-rename"
            autoFocus
            value={draftName}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') commitRename();
              if (event.key === 'Escape') setRenaming(false);
            }}
          />
          <button type="button" onClick={commitRename}>
            Save
          </button>
          <button type="button" onClick={() => setRenaming(false)}>
            Cancel
          </button>
        </span>
      ) : (
        <button type="button" disabled={!deck} onClick={startRename}>
          Rename
        </button>
      )}

      <button type="button" disabled={!deck} onClick={() => actions.duplicateActiveDeck()}>
        Duplicate
      </button>

      <button
        type="button"
        className="danger"
        disabled={!deck}
        onClick={() => {
          if (!deck) return;
          if (window.confirm(`Delete "${deck.name}"? This cannot be undone.`)) {
            actions.deleteDeck(deck.id);
          }
        }}
      >
        Delete
      </button>

      <span className="deck-toolbar__spacer" />

      <button
        type="button"
        disabled={!deck}
        onClick={() => {
          if (!deck) return;
          downloadTextFile(suggestDeckFilename(deck), exportDeckToJson(deck));
        }}
      >
        Export deck
      </button>

      <button
        type="button"
        disabled={decks.length === 0}
        onClick={() => downloadTextFile('all-decks.deck.json', exportDecksToJson(decks))}
      >
        Export all
      </button>

      <button type="button" onClick={() => fileInput.current?.click()}>
        Import
      </button>
      <input
        ref={fileInput}
        className="visually-hidden"
        type="file"
        accept="application/json,.json"
        aria-label="Import decks from a JSON file"
        onChange={(event) => {
          void handleImportFile(event.target.files?.[0]);
          event.target.value = '';
        }}
      />
    </div>
  );
}
