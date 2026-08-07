/**
 * Deck construction limits. These are playtest dials, not confirmed rules —
 * every value here is provisional (CLAUDE.md §4) and documented in
 * docs/rules/open-decisions.md. Keep them configurable rather than inlined.
 */
export interface DeckFormatConfig {
  /** Exact number of cards a legal deck must contain. */
  readonly deckSize: number;
  /** Maximum copies of a regular card. */
  readonly copyLimit: number;
  /** Maximum copies of a card flagged `unique`. */
  readonly uniqueCopyLimit: number;
  /** Maximum colours in a Commander's colour identity. */
  readonly maxCommanderColors: number;
}

export const DEFAULT_DECK_FORMAT: DeckFormatConfig = {
  deckSize: 30,
  copyLimit: 2,
  uniqueCopyLimit: 1,
  maxCommanderColors: 2,
};
