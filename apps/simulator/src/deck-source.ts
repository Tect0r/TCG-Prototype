import { readFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve as resolvePath } from 'node:path';
import { z } from 'zod';
import { bundledPrecon, cardIdSchema, preconIdSchema, preconsForFormat } from '@tcg/card-data';
import { migrateSavedDeck, preconToDeck, reviewPrecon } from '@tcg/deck';
import type { DeckSource } from './config.js';
import type { Environment } from './environment.js';
import {
  checkDeck,
  fromSavedDeck,
  makeDeck,
  withConstruction,
  type SimDeck,
} from './deck-search/deck.js';
import { generatePopulation, type GenerationDiagnostic } from './deck-search/generate.js';
import {
  conformanceOf,
  PlanResolutionError,
  resolvePlanForPrecon,
  type ResolvedPlan,
} from './deck-search/plan.js';

/**
 * Turns a configured deck source into validated decks (CLAUDE.md §13.8).
 *
 * Whatever the source, the decks come out the other side having been through
 * `validateDeck` against the environment they will actually be played in. An
 * illegal deck is reported, never repaired: quietly "fixing" a decklist would
 * mean the experiment did not test what its configuration says it tested.
 *
 * A `precon` source is stricter still, and deliberately so. The other sources
 * describe decks the experiment invented, so dropping one and reporting it is a
 * loss of sample size; a precon source *names* a shipped deck, so dropping one
 * would leave a run reporting on "the four precons" having played three.
 * Anything wrong with a named precon therefore throws (M03.3).
 */

/** A precon a source resolved, recorded in the experiment manifest. */
export const resolvedPreconSchema = z.strictObject({
  preconId: preconIdSchema,
  name: z.string().min(1),
  /** The format the precon is built to, which the environment had to match. */
  formatId: z.string().min(1),
  commanderId: cardIdSchema,
  /** The deck it materialised into, tying it to `deckHashes` in the manifest. */
  deckHash: z.string().min(1),
});
export type ResolvedPrecon = z.infer<typeof resolvedPreconSchema>;

export interface ResolvedDecks {
  readonly decks: readonly SimDeck[];
  readonly diagnostics: readonly GenerationDiagnostic[];
  /** Decks that were supplied but rejected, with the reason. */
  readonly rejected: readonly { readonly id: string; readonly reasons: readonly string[] }[];
  /** Precons this source resolved by ID. Empty for every other source kind. */
  readonly precons: readonly ResolvedPrecon[];
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
      // A person typed this list into a config file, which is exactly what
      // `hand_authored` means (M05.5).
      const decks = source.decks.map((entry) =>
        makeDeck({
          commanderId: entry.commanderId,
          cards: entry.cards,
          ...(entry.id === undefined ? {} : { id: entry.id }),
          ...(entry.label === undefined ? {} : { label: entry.label }),
          construction: { kind: 'hand_authored' },
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
          // A deck-builder export is somebody's deck, however it was arrived at.
          decks.push(fromSavedDeck(migrated.value, { kind: 'hand_authored' }));
        }
      }
      return vet(decks, environment, diagnostics);
    }
    case 'precon':
      return resolvePrecons(source.preconIds, environment);
    default:
      return { decks: [], diagnostics: [], rejected: [], precons: [] };
  }
}

/**
 * Fixed, because a precon copy made for an experiment is not a saved deck. The
 * timestamps are outside `SimDeck` anyway; pinning them keeps the intermediate
 * `SavedDeck` free of anything that varies between runs.
 */
const PRECON_TIMESTAMP = '2026-01-01T00:00:00.000Z';

/**
 * Resolves precon IDs into decks, or stops the experiment.
 *
 * Each ID goes through the same two questions every other surface asks — does
 * this precon exist, and can it be played *here* — answered by `bundledPrecon`
 * and the shared `reviewPrecon`. The environment's declared `deckFormat` is what
 * "here" means, so an environment that has not stated the precon's format is a
 * format mismatch rather than a silent success against the wrong rules.
 *
 * The resulting decks are then vetted exactly like any other source, which is
 * what catches a precon whose cards the environment bans or leaves out of its
 * pool. A rejection at that stage throws too: an experiment named after a set of
 * precons must run those precons or not run.
 */
function resolvePrecons(preconIds: readonly string[], environment: Environment): ResolvedDecks {
  const decks: SimDeck[] = [];
  const precons: ResolvedPrecon[] = [];
  const seen = new Set<string>();

  for (const preconId of preconIds) {
    if (seen.has(preconId)) {
      throw new Error(
        `Precon "${preconId}" is listed twice in one deck source. A deck source is a set of ` +
          'distinct decks; repeating an ID does not seat the precon twice.',
      );
    }
    seen.add(preconId);

    const precon = bundledPrecon(preconId);
    if (!precon) {
      const published = preconsForFormat(environment.deckFormat.formatId).map((entry) => entry.id);
      throw new Error(
        `No built-in precon has ID "${preconId}". Precons published for ` +
          `"${environment.deckFormat.formatId}": ${published.join(', ') || 'none'}.`,
      );
    }

    const review = reviewPrecon(precon, environment.database, environment.deckFormat);
    if (!review.legal) {
      throw new Error(
        `Precon "${precon.id}" cannot be played in environment "${environment.id}":\n` +
          review.issues
            .filter((issue) => issue.severity === 'error')
            .map((issue) => `  - ${issue.code}: ${issue.message}`)
            .join('\n'),
      );
    }

    const drafted = fromSavedDeck(
      preconToDeck(precon, { id: precon.id, name: precon.name, now: PRECON_TIMESTAMP }),
      { kind: 'hand_authored' },
    );
    // A shipped precon is hand-authored, and when a deck plan describes it the
    // deck is *also* measured against that plan (M05.5). The two are separate
    // facts: the plan says what the deck is made of, and `hand_authored` says a
    // person made it — a report that conflated them would credit the generator
    // with a designer's deck the moment a plan happened to fit.
    //
    // The plan is an annotation on a deck that was named by a different ID, so
    // failing to resolve it must not become this precon's error message. An
    // environment that bans a packaged card will be refused by `vet` below, in
    // the precon's own words; here the annotation is simply dropped.
    let plan: ResolvedPlan | null = null;
    try {
      plan = resolvePlanForPrecon(precon.id, environment);
    } catch (cause) {
      if (!(cause instanceof PlanResolutionError)) throw cause;
    }
    const deck = withConstruction(drafted, conformanceOf(drafted, plan, 'hand_authored'));
    decks.push(deck);
    precons.push({
      preconId: precon.id,
      name: precon.name,
      formatId: precon.formatId,
      commanderId: precon.commanderId,
      deckHash: deck.hash,
    });
  }

  const vetted = vet(decks, environment, []);
  if (vetted.rejected.length > 0) {
    throw new Error(
      `Environment "${environment.id}" rejects precon(s) it was asked to run:\n` +
        vetted.rejected.map((entry) => `  - ${entry.id}: ${entry.reasons.join('; ')}`).join('\n') +
        '\n\nA named precon is never dropped and never substituted; fix the environment’s pool, ' +
        'bans or format instead.',
    );
  }

  return { ...vetted, precons };
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

  return { decks: accepted, diagnostics, rejected, precons: [] };
}

/** Directory a config file's relative paths are resolved against. */
export function configDirOf(configPath: string): string {
  return dirname(resolvePath(configPath));
}
