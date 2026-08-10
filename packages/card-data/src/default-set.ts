import { unwrap } from '@tcg/shared';
import bundle from './data/generated/content-bundle.json' with { type: 'json' };
import { CardDatabase } from './database.js';
import { loadCardSets, type LoadedCardData } from './loader.js';
import type { CardDefinition } from './schema/card.js';
import { playFormatSchema, type PlayFormat } from './schema/format.js';
import { preconDefinitionSchema, type PreconDefinition } from './schema/precon.js';

/**
 * Raw, unvalidated set payloads shipped with the prototype.
 *
 * Generated from `content/` by `npm run content:build`; `npm run content:check`
 * fails the build when this file is stale. Edit the per-card sources under
 * `content/sets/<setId>/`, never the bundle (readiness spec C1).
 */
export const BUNDLED_CARD_SETS: readonly unknown[] = bundle.sets;

/**
 * Loads and validates the bundled sets. Invalid bundled data is a programming
 * error — the content build would have rejected it — so this throws with the
 * structured issues attached.
 */
export function loadBundledCardData(): LoadedCardData {
  return unwrap(loadCardSets(BUNDLED_CARD_SETS), 'Bundled card data failed validation');
}

/** Every play format declared under `content/formats/`, in stable file order. */
export const BUNDLED_FORMATS: readonly PlayFormat[] = bundle.formats.map((raw) =>
  playFormatSchema.parse(raw),
);

/**
 * Every built-in precon, in stable file order.
 *
 * Immutable by construction: these are the shipped definitions, and copying one
 * into an editable deck is `preconToDeck`'s job in `@tcg/deck`.
 */
export const BUNDLED_PRECONS: readonly PreconDefinition[] = bundle.precons.map((raw) =>
  preconDefinitionSchema.parse(raw),
);

/** Looks up a built-in precon by its permanent ID. */
export function bundledPrecon(preconId: string): PreconDefinition | undefined {
  return BUNDLED_PRECONS.find((precon) => precon.id === preconId);
}

/** Looks up a bundled format by its permanent ID. */
export function bundledFormat(formatId: string): PlayFormat | undefined {
  return BUNDLED_FORMATS.find((format) => format.formatId === formatId);
}

/**
 * The format the deck builder and simulator use unless one is chosen. Set to
 * the current playtest pool, not the development fixtures.
 */
export const DEFAULT_FORMAT_ID = 'precon_wave_1';

/**
 * Every card legal in a format: the cards of its declared sets, minus its bans.
 *
 * Selecting content deliberately is the whole point of a format (readiness spec
 * B4). `loadBundledCardData().database` is the *universe* — it has to contain
 * every card so replays and saved decks from any format keep resolving — and is
 * not a legal pool for anything on its own.
 *
 * Unimplemented cards are included here: they are legal content, and
 * `validateDeck` is what refuses to let a deck play them. Filtering them out
 * silently would make a precon look complete when it is not.
 */
export function formatCardPool(formatId: string): CardDefinition[] {
  const format = bundledFormat(formatId);
  if (!format) {
    throw new Error(`Format "${formatId}" is not defined in content/formats.`);
  }
  const banned = new Set(format.bannedCardIds);
  const included = new Set(format.setIds);

  const cards: CardDefinition[] = [];
  for (const set of loadBundledCardData().sets) {
    if (!included.has(set.setId)) continue;
    for (const card of set.cards) {
      if (!banned.has(card.id)) cards.push(card);
    }
  }
  return cards;
}

/** A `CardDatabase` containing only the cards legal in `formatId`. */
export function formatDatabase(formatId: string): CardDatabase {
  return new CardDatabase(formatCardPool(formatId));
}
