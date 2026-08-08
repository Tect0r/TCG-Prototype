import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { migrateSavedDeck } from '@tcg/deck';
import type { DeckSource } from './config.js';
import type { Environment } from './environment.js';
import { checkDeck, fromSavedDeck, makeDeck, type SimDeck } from './deck-search/deck.js';
import { generatePopulation, type GenerationDiagnostic } from './deck-search/generate.js';

/**
 * Turns a configured deck source into validated decks (CLAUDE.md §13.8).
 *
 * Whatever the source, the decks come out the other side having been through
 * `validateDeck` against the environment they will actually be played in. An
 * illegal deck is reported, never repaired: quietly "fixing" a decklist would
 * mean the experiment did not test what its configuration says it tested.
 */

export interface ResolvedDecks {
  readonly decks: readonly SimDeck[];
  readonly diagnostics: readonly GenerationDiagnostic[];
  /** Decks that were supplied but rejected, with the reason. */
  readonly rejected: readonly { readonly id: string; readonly reasons: readonly string[] }[];
}

export function resolveDeckSource(
  source: DeckSource,
  environment: Environment,
  seed: string,
  configDir = '.',
): ResolvedDecks {
  switch (source.kind) {
    case 'generated': {
      const generated = generatePopulation(environment, seed, source.count, source.generator);
      return vet(generated.decks, environment, generated.diagnostics);
    }
    case 'inline': {
      const decks = source.decks.map((entry) =>
        makeDeck({
          commanderId: entry.commanderId,
          cards: entry.cards,
          ...(entry.id === undefined ? {} : { id: entry.id }),
          ...(entry.label === undefined ? {} : { label: entry.label }),
        }),
      );
      return vet(decks, environment, []);
    }
    case 'files': {
      const decks: SimDeck[] = [];
      const diagnostics: GenerationDiagnostic[] = [];
      for (const path of source.paths) {
        const full = isAbsolute(path) ? path : resolvePath(configDir, path);
        let parsed: unknown;
        try {
          parsed = JSON.parse(readFileSync(full, 'utf8'));
        } catch (error) {
          diagnostics.push({
            code: 'sim/deck_file_unreadable',
            message: `Could not read "${full}": ${error instanceof Error ? error.message : String(error)}`,
          });
          continue;
        }
        for (const entry of asDeckArray(parsed)) {
          const migrated = migrateSavedDeck(entry);
          if (!migrated.ok) {
            diagnostics.push({
              code: 'sim/deck_file_invalid',
              message: `"${full}": ${migrated.error.map((issue) => issue.message).join('; ')}`,
            });
            continue;
          }
          if (migrated.value.commanderId === null) {
            diagnostics.push({
              code: 'sim/deck_without_commander',
              message: `Deck "${migrated.value.id}" in "${full}" has no Commander.`,
            });
            continue;
          }
          decks.push(fromSavedDeck(migrated.value));
        }
      }
      return vet(decks, environment, diagnostics);
    }
    default:
      return { decks: [], diagnostics: [], rejected: [] };
  }
}

/** Deck-builder exports are either one deck or a `{ decks: [...] }` envelope. */
function asDeckArray(parsed: unknown): unknown[] {
  if (Array.isArray(parsed)) return parsed;
  if (
    parsed &&
    typeof parsed === 'object' &&
    Array.isArray((parsed as { decks?: unknown }).decks)
  ) {
    return (parsed as { decks: unknown[] }).decks;
  }
  return [parsed];
}

function vet(
  decks: readonly SimDeck[],
  environment: Environment,
  diagnostics: readonly GenerationDiagnostic[],
): ResolvedDecks {
  const accepted: SimDeck[] = [];
  const rejected: { id: string; reasons: string[] }[] = [];

  for (const deck of decks) {
    const legality = checkDeck(deck, environment);
    if (legality.legal) {
      accepted.push(deck);
      continue;
    }
    rejected.push({
      id: deck.id,
      reasons: legality.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => `${issue.code}: ${issue.message}`),
    });
  }

  return { decks: accepted, diagnostics, rejected };
}

/** Directory a config file's relative paths are resolved against. */
export function configDirOf(configPath: string): string {
  return dirname(resolvePath(configPath));
}
