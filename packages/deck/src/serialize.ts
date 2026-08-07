import { err, error, generateId, ok, type IdSources, type Issue, type Result } from '@tcg/shared';
import { migrateSavedDeck } from './migrate.js';
import type { SavedDeck } from './schema.js';
import type { Clock } from './operations.js';

/**
 * Deck import/export. Exports are plain, readable, versioned JSON in exactly
 * the saved-deck shape, referencing cards by permanent ID only.
 *
 * Import is total: it never throws and never mutates anything the caller
 * already holds, so a malformed file cannot corrupt saved decks.
 */

/** Key order chosen for readability when a human opens the file. */
function orderedDeck(deck: SavedDeck): Record<string, unknown> {
  return {
    schemaVersion: deck.schemaVersion,
    id: deck.id,
    name: deck.name,
    commanderId: deck.commanderId,
    cards: [...deck.cards]
      .sort((a, b) => a.cardId.localeCompare(b.cardId))
      .map((entry) => ({ cardId: entry.cardId, quantity: entry.quantity })),
    createdAt: deck.createdAt,
    updatedAt: deck.updatedAt,
    ...(deck.notes === undefined ? {} : { notes: deck.notes }),
  };
}

export function exportDeckToJson(deck: SavedDeck): string {
  return `${JSON.stringify(orderedDeck(deck), null, 2)}\n`;
}

/** Bulk export as a JSON array, for backing up a whole collection. */
export function exportDecksToJson(decks: readonly SavedDeck[]): string {
  return `${JSON.stringify(decks.map(orderedDeck), null, 2)}\n`;
}

export interface ImportedDecks {
  readonly decks: readonly SavedDeck[];
}

/**
 * Parses one deck or an array of decks. Every deck must be valid — a partial
 * import would leave the user guessing which half landed.
 */
export function parseDecksFromJson(text: string): Result<ImportedDecks, Issue[]> {
  let payload: unknown;
  try {
    payload = JSON.parse(text);
  } catch (cause) {
    return err([
      error(
        'deck/invalid_json',
        `That file is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
      ),
    ]);
  }

  const raw = Array.isArray(payload) ? payload : [payload];
  if (raw.length === 0) {
    return err([error('deck/empty_import', 'That file contains no decks.')]);
  }

  const decks: SavedDeck[] = [];
  const issues: Issue[] = [];

  raw.forEach((entry, index) => {
    const result = migrateSavedDeck(entry);
    if (result.ok) {
      decks.push(result.value);
      return;
    }
    const prefix = raw.length > 1 ? `decks[${index}].` : '';
    issues.push(
      ...result.error.map((problem) => ({
        ...problem,
        ...(problem.path === undefined && !prefix ? {} : { path: `${prefix}${problem.path ?? ''}` }),
      })),
    );
  });

  if (issues.length > 0) return err(issues);
  return ok({ decks });
}

export interface ImportPreparationOptions {
  readonly existing: readonly SavedDeck[];
  readonly clock?: Clock;
  readonly idSources?: IdSources;
}

/**
 * Rewrites an imported deck so it cannot overwrite anything already saved:
 * a colliding deck ID gets a fresh one, and a colliding name is suffixed.
 */
export function prepareImportedDeck(
  deck: SavedDeck,
  options: ImportPreparationOptions,
): SavedDeck {
  const usedIds = new Set(options.existing.map((d) => d.id));
  const usedNames = new Set(options.existing.map((d) => d.name.toLowerCase()));
  const clock = options.clock ?? (() => new Date().toISOString());

  const id = usedIds.has(deck.id) ? generateId('deck', options.idSources) : deck.id;

  let name = deck.name;
  if (usedNames.has(name.toLowerCase())) {
    name = `${deck.name} (imported)`;
    let counter = 2;
    while (usedNames.has(name.toLowerCase())) {
      name = `${deck.name} (imported ${counter})`;
      counter += 1;
    }
  }

  if (id === deck.id && name === deck.name) return deck;
  return { ...deck, id, name, updatedAt: clock() };
}

/** Filename suggestion for a downloaded deck. */
export function suggestDeckFilename(deck: SavedDeck): string {
  const slug =
    deck.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48) || 'deck';
  return `${slug}.deck.json`;
}
