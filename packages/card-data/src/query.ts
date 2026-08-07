import type { CardDefinition } from './schema/card.js';
import type { CardType, ColorId, KeywordId, PowerClass, Role } from './schema/primitives.js';

/**
 * Deck-builder browse query. Every field is optional; an empty query matches
 * every card. Filters combine with AND, values inside one filter with OR.
 */
export interface CardQuery {
  /** Matches display name and rules text, case-insensitively. */
  readonly text?: string;
  readonly colors?: readonly ColorId[];
  /** When true, an empty colour identity also matches a colour filter. */
  readonly includeNeutral?: boolean;
  readonly types?: readonly CardType[];
  /** Inclusive energy cost bounds. `max` of `null` means "no upper bound". */
  readonly minCost?: number;
  readonly maxCost?: number | null;
  readonly keywords?: readonly KeywordId[];
  readonly tags?: readonly string[];
  readonly roles?: readonly Role[];
  readonly powerClasses?: readonly PowerClass[];
  /** `true` = unique only, `false` = non-unique only, omitted = either. */
  readonly unique?: boolean;
  /** Restrict to cards legal under this Commander colour identity. */
  readonly legalUnderColorIdentity?: readonly ColorId[];
}

/**
 * A card is legal only when every colour in its identity is present in the
 * Commander's identity. Neutral (empty identity) is legal everywhere.
 */
export function isColorIdentityLegal(
  cardColorIdentity: readonly ColorId[],
  commanderColorIdentity: readonly ColorId[],
): boolean {
  return cardColorIdentity.every((color) => commanderColorIdentity.includes(color));
}

function matchesText(card: CardDefinition, needle: string): boolean {
  const haystack = `${card.name}\n${card.displayText ?? ''}`.toLowerCase();
  return needle
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
    .every((term) => haystack.includes(term));
}

export function matchesQuery(card: CardDefinition, query: CardQuery): boolean {
  if (query.text && !matchesText(card, query.text)) return false;

  if (query.types?.length && !query.types.includes(card.type)) return false;

  if (query.colors?.length) {
    const neutralOk = query.includeNeutral === true && card.colorIdentity.length === 0;
    const colorHit = card.colorIdentity.some((color) => query.colors!.includes(color));
    if (!neutralOk && !colorHit) return false;
  }

  if (query.minCost !== undefined && (card.cost === null || card.cost < query.minCost))
    return false;
  if (
    query.maxCost !== undefined &&
    query.maxCost !== null &&
    (card.cost === null || card.cost > query.maxCost)
  ) {
    return false;
  }

  if (query.keywords?.length && !query.keywords.some((k) => card.keywords.includes(k)))
    return false;
  if (query.tags?.length && !query.tags.some((t) => card.tags.includes(t))) return false;

  if (query.roles?.length && (card.role === undefined || !query.roles.includes(card.role))) {
    return false;
  }
  if (
    query.powerClasses?.length &&
    (card.powerClass === undefined || !query.powerClasses.includes(card.powerClass))
  ) {
    return false;
  }

  if (query.unique !== undefined && card.unique !== query.unique) return false;

  if (
    query.legalUnderColorIdentity &&
    !isColorIdentityLegal(card.colorIdentity, query.legalUnderColorIdentity)
  ) {
    return false;
  }

  return true;
}

/** Stable browse order: cost, then colour identity, then name. */
export function compareCards(a: CardDefinition, b: CardDefinition): number {
  const costA = a.cost ?? -1;
  const costB = b.cost ?? -1;
  if (costA !== costB) return costA - costB;
  const colorsA = a.colorIdentity.join(',');
  const colorsB = b.colorIdentity.join(',');
  if (colorsA !== colorsB) return colorsA.localeCompare(colorsB);
  return a.name.localeCompare(b.name);
}
