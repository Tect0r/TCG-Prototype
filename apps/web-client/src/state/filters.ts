import type {
  CardQuery,
  CardType,
  ColorId,
  KeywordId,
  PowerClass,
  Role,
} from '@tcg/card-data';

/** UI filter state. Translated into a `CardQuery` for the card database. */
export interface FilterState {
  readonly text: string;
  readonly colors: readonly ColorId[];
  readonly includeNeutral: boolean;
  readonly types: readonly CardType[];
  readonly minCost: number;
  /** `null` means "and above" — the top bucket of the cost filter. */
  readonly maxCost: number | null;
  readonly keywords: readonly KeywordId[];
  readonly tags: readonly string[];
  readonly roles: readonly Role[];
  readonly powerClasses: readonly PowerClass[];
  readonly unique: boolean | undefined;
  /** Hide cards outside the selected Commander's colour identity. */
  readonly commanderLegalOnly: boolean;
}

export const emptyFilters: FilterState = {
  text: '',
  colors: [],
  includeNeutral: true,
  types: [],
  minCost: 0,
  maxCost: null,
  keywords: [],
  tags: [],
  roles: [],
  powerClasses: [],
  unique: undefined,
  commanderLegalOnly: true,
};

/** Toggles a value in a filter array, preserving the caller's ordering. */
export function toggle<T>(values: readonly T[], value: T): T[] {
  return values.includes(value) ? values.filter((v) => v !== value) : [...values, value];
}

export function isFilterActive(filters: FilterState): boolean {
  return (
    filters.text.trim() !== '' ||
    filters.colors.length > 0 ||
    filters.types.length > 0 ||
    filters.minCost !== emptyFilters.minCost ||
    filters.maxCost !== emptyFilters.maxCost ||
    filters.keywords.length > 0 ||
    filters.tags.length > 0 ||
    filters.roles.length > 0 ||
    filters.powerClasses.length > 0 ||
    filters.unique !== undefined
  );
}

export function toCardQuery(
  filters: FilterState,
  commanderColorIdentity: readonly ColorId[] | null,
): CardQuery {
  const query: CardQuery = {
    ...(filters.text.trim() ? { text: filters.text.trim() } : {}),
    ...(filters.colors.length
      ? { colors: filters.colors, includeNeutral: filters.includeNeutral }
      : {}),
    ...(filters.types.length ? { types: filters.types } : {}),
    ...(filters.minCost > 0 ? { minCost: filters.minCost } : {}),
    ...(filters.maxCost !== null ? { maxCost: filters.maxCost } : {}),
    ...(filters.keywords.length ? { keywords: filters.keywords } : {}),
    ...(filters.tags.length ? { tags: filters.tags } : {}),
    ...(filters.roles.length ? { roles: filters.roles } : {}),
    ...(filters.powerClasses.length ? { powerClasses: filters.powerClasses } : {}),
    ...(filters.unique === undefined ? {} : { unique: filters.unique }),
    ...(filters.commanderLegalOnly && commanderColorIdentity !== null
      ? { legalUnderColorIdentity: commanderColorIdentity }
      : {}),
  };
  return query;
}
