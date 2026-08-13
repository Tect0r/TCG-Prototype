import { err, error, ok, unwrap, type Issue, type Result } from '@tcg/shared';
import bundle from './data/generated/content-bundle.json' with { type: 'json' };
import { CardDatabase } from './database.js';
import { loadCardSets, type LoadedCardData } from './loader.js';
import type { CardDefinition, CardSet } from './schema/card.js';
import { playFormatSchema, type PlayFormat } from './schema/format.js';
import { preconDefinitionSchema, type PreconDefinition } from './schema/precon.js';
import { deckPlanSchema, type DeckPlan } from './schema/deck-plan.js';

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

/**
 * The built-in precons published for one format, in stable file order.
 *
 * The precon equivalent of `formatCardPool`: every surface that offers precons
 * to choose from — the deck-builder browser, the lobby, the match server —
 * scopes them through this, so a development fixture deck can never be listed
 * beside Wave 1 and the list a player picks from is the list the server will
 * accept from (M03.2).
 *
 * A precon that exists but belongs to another format is still resolvable by ID
 * through `bundledPrecon`, because "this precon is for another format" is a
 * better answer than "no such precon".
 */
export function preconsForFormat(formatId: string): readonly PreconDefinition[] {
  return BUNDLED_PRECONS.filter((precon) => precon.formatId === formatId);
}

/**
 * Every authored deck plan, in stable file order (M05.5).
 *
 * A plan is content like a precon and is immutable for the same reason: a search
 * that mutates a deck must not be able to mutate the description it is being
 * measured against.
 */
export const BUNDLED_DECK_PLANS: readonly DeckPlan[] = bundle.deckPlans.map((raw) =>
  deckPlanSchema.parse(raw),
);

/** Looks up an authored deck plan by its permanent ID. */
export function bundledDeckPlan(deckPlanId: string): DeckPlan | undefined {
  return BUNDLED_DECK_PLANS.find((plan) => plan.id === deckPlanId);
}

/**
 * The deck plans published for one format, in stable file order.
 *
 * The plan equivalent of `preconsForFormat`, and scoped for the same reason: a
 * plan is only meaningful under the construction rules and card pool its cards
 * were checked against.
 */
export function deckPlansForFormat(formatId: string): readonly DeckPlan[] {
  return BUNDLED_DECK_PLANS.filter((plan) => plan.formatId === formatId);
}

/**
 * The plan describing a shipped precon, when one was authored.
 *
 * Deliberately a lookup rather than a field on `PreconDefinition`: a precon is a
 * decklist and stays valid without a plan, and more than one plan may eventually
 * describe the same list at different levels of detail.
 */
export function deckPlanForPrecon(preconId: string): DeckPlan | undefined {
  return BUNDLED_DECK_PLANS.find((plan) => plan.preconId === preconId);
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
  return poolOf(format, loadBundledCardData().sets);
}

/** A `CardDatabase` containing only the cards legal in `formatId`. */
export function formatDatabase(formatId: string): CardDatabase {
  return new CardDatabase(formatCardPool(formatId));
}

/** The single scoping rule every format-pool caller goes through. */
function poolOf(format: PlayFormat, sets: readonly CardSet[]): CardDefinition[] {
  const banned = new Set(format.bannedCardIds);
  const included = new Set(format.setIds);

  const cards: CardDefinition[] = [];
  for (const set of sets) {
    if (!included.has(set.setId)) continue;
    for (const card of set.cards) {
      if (!banned.has(card.id)) cards.push(card);
    }
  }
  return cards;
}

/**
 * The format an entry point runs, from an explicit request or the default.
 *
 * Entry points must never *infer* a format from whatever data happens to be
 * bundled. A blank request means "the shipping format"; anything else is taken
 * literally so a development-format run is a deliberate, visible choice
 * (`VITE_TCG_FORMAT` in the client, `TCG_FORMAT` on the server). An unknown ID
 * is reported by `loadFormatCardData`, not silently replaced with the default.
 */
export function resolveFormatId(requested?: string | null): string {
  const trimmed = requested?.trim();
  return trimmed ? trimmed : DEFAULT_FORMAT_ID;
}

/** Validated bundled content, scoped to one format's legal pool. */
export interface FormatCardData extends LoadedCardData {
  /** The resolved format ID, for provenance in logs, results and replays. */
  readonly formatId: string;
  /** The format definition the pool was scoped with. */
  readonly format: PlayFormat;
}

/**
 * Loads the bundled content and returns *only* the pool legal in `formatId`.
 *
 * This is the shared entry-point API: the deck builder and the match server
 * both resolve their pool through it, so neither can drift into offering or
 * accepting a card the other refuses. `loadBundledCardData()` remains the
 * universe — needed to resolve saved decks and replays from any format — and is
 * not a legal pool for anything.
 *
 * `database` and `sets` are format-scoped. `warnings` are not: they are
 * authoring diagnostics about the bundle as a whole, and hiding the ones
 * outside the active format would make content problems harder to see, not
 * fewer.
 */
export function loadFormatCardData(formatId: string): Result<FormatCardData, Issue[]> {
  const format = bundledFormat(formatId);
  if (!format) {
    const known = BUNDLED_FORMATS.map((entry) => entry.formatId).join(', ');
    return err([
      error(
        'card_data/unknown_format',
        `Format "${formatId}" is not defined in content/formats. Known formats: ${known}.`,
        { context: { formatId, known: BUNDLED_FORMATS.map((entry) => entry.formatId) } },
      ),
    ]);
  }

  const loaded = loadCardSets(BUNDLED_CARD_SETS);
  if (!loaded.ok) return loaded;

  const available = new Set(loaded.value.sets.map((set) => set.setId));
  const missing = format.setIds.filter((setId) => !available.has(setId));
  if (missing.length > 0) {
    // Otherwise the format would quietly resolve to a smaller pool than it
    // declares, and a deck would be rejected for the wrong reason.
    return err([
      error(
        'card_data/unknown_format_set',
        `Format "${formatId}" declares set${missing.length === 1 ? '' : 's'} ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not in the bundled content. Run \`npm run content:build\`.`,
        { context: { formatId, missing } },
      ),
    ]);
  }

  const sets = loaded.value.sets.filter((set) => format.setIds.includes(set.setId));
  return ok({
    formatId: format.formatId,
    format,
    database: new CardDatabase(poolOf(format, loaded.value.sets)),
    sets,
    warnings: loaded.value.warnings,
  });
}
