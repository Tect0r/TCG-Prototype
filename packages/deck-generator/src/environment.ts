import {
  bundledFormat,
  formatDatabase,
  type CardDefinition,
  type CardDatabase,
} from '@tcg/card-data';
import { deckFormatOf, type DeckFormatConfig } from '@tcg/deck';

/**
 * The five things generation needs to know, and nothing else.
 *
 * Deliberately narrower than the simulator's `Environment`, which also carries
 * content hashes, a rules configuration, a resolved config and a set list — all
 * of which matter to an *experiment* and none of which changes which cards come
 * out. Keeping the input this small is what lets a live lobby call the same
 * generator without acquiring a simulator: the simulator's `Environment`
 * satisfies this interface structurally, so nothing had to be adapted at the
 * call sites when the generator moved.
 *
 * `pool` and `commanders` are the **format-scoped** pool, never the bundled
 * universe (`CLAUDE.md`, "Any playable pool must be obtained through a
 * format-scoped database"). The generator does not enforce that by itself — it
 * cannot tell where a pool came from — which is why the one constructor below
 * exists and why a caller that builds its own must scope it the same way.
 */
export interface GenerationEnvironment {
  /** Named in every diagnostic, so a refusal says which pool refused. */
  readonly id: string;
  /** Resolves card IDs for `validateDeck`. Must contain the whole pool. */
  readonly database: CardDatabase;
  readonly deckFormat: DeckFormatConfig;
  /** Deckable, allowed cards — what a deck is drawn from. */
  readonly pool: readonly CardDefinition[];
  readonly commanders: readonly CardDefinition[];
}

/**
 * The format-scoped environment a live caller generates against.
 *
 * One function, so "a playable pool comes from a format" is a call rather than a
 * convention. An unknown format throws rather than resolving to a smaller pool:
 * generating from the wrong pool would produce a deck that is legal somewhere
 * and refused here, which is worse than not generating.
 */
export function generationEnvironmentForFormat(formatId: string): GenerationEnvironment {
  const format = bundledFormat(formatId);
  if (!format) {
    throw new Error(
      `Format "${formatId}" is not defined in content/formats, so there is no legal pool to ` +
        'generate from.',
    );
  }
  const database = formatDatabase(formatId);
  return {
    id: formatId,
    database,
    deckFormat: deckFormatOf(format),
    pool: database.deckable(),
    commanders: database.commanders(),
  };
}
