import { bundledFormat, type PlayFormat } from '@tcg/card-data';

/**
 * Deck construction limits, flattened from the active `PlayFormat`.
 *
 * These are playtest dials, not confirmed rules — every value is provisional
 * (CLAUDE.md §4, ruleset update §2) and documented in
 * `docs/rules/open-decisions.md`. They are *derived* from `content/formats/`
 * rather than written here, so a format change is a data edit.
 */
export interface DeckFormatConfig {
  /** The format these limits came from. Recorded in results and replays. */
  readonly formatId: string;
  /** Exact number of cards a legal deck must contain. */
  readonly deckSize: number;
  /**
   * No card ID may appear more than once, however the entries are written.
   *
   * Deliberately not collapsed into `copyLimit: 1`. A singleton format rejects
   * a repeated card by *identity*, which a copy limit alone cannot do: an
   * import that splits one card across two entries of quantity 1 passes every
   * per-entry limit and still holds two copies (ruleset update §2).
   */
  readonly singleton: boolean;
  /** Maximum copies of a regular card. Ignored when `singleton` is set. */
  readonly copyLimit: number;
  /** Maximum copies of a card flagged `unique`. Ignored when `singleton` is set. */
  readonly uniqueCopyLimit: number;
  /** Maximum colours in a Commander's colour identity. */
  readonly maxCommanderColors: number;
}

/** Flattens a content-declared format into the limits the validator reads. */
export function deckFormatOf(format: PlayFormat): DeckFormatConfig {
  return {
    formatId: format.formatId,
    deckSize: format.deck.size,
    singleton: format.deck.singleton,
    copyLimit: format.deck.singleton ? 1 : format.deck.copyLimit,
    uniqueCopyLimit: format.deck.singleton ? 1 : format.deck.uniqueCopyLimit,
    maxCommanderColors: format.deck.maxCommanderColors,
  };
}

function requireFormat(formatId: string): DeckFormatConfig {
  const format = bundledFormat(formatId);
  if (!format) {
    throw new Error(
      `Format "${formatId}" is not defined in content/formats. Run \`npm run content:build\`.`,
    );
  }
  return deckFormatOf(format);
}

/**
 * The pre-ruleset-update fixture format: `prototype_core`, 30 cards, two copies.
 *
 * Kept so Phase 1–4 regression tests keep exercising the construction rules
 * they were written against, and because `prototype_core` is too small to build
 * a legal 40-card singleton deck for most of its Commanders.
 */
export const DEVELOPMENT_DECK_FORMAT: DeckFormatConfig = requireFormat('development');

/** The authored playtest format: 40 cards, singleton (ruleset update §2). */
export const PRECON_WAVE_1_DECK_FORMAT: DeckFormatConfig = requireFormat('precon_wave_1');

/**
 * The active format. Callers that mean the fixture rules must say so explicitly
 * with `DEVELOPMENT_DECK_FORMAT` rather than relying on this.
 */
export const DEFAULT_DECK_FORMAT: DeckFormatConfig = PRECON_WAVE_1_DECK_FORMAT;
