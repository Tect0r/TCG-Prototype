import type { RepresentativeMatchKind } from '@tcg/admin-contracts';

/**
 * M08.26E — label wording for the seven representative-match categories.
 *
 * The filter form this panel needs is the identical `playerMetaFilterSchema`
 * `matchExplorerList` already reads (`matchRepresentativesRequestSchema.filter`,
 * see `match-representatives.ts`'s own doc comment), so this file adds no
 * second filter type: reuse `MatchExplorerFilterState`/`EMPTY_MATCH_EXPLORER_FILTER`/
 * `matchExplorerFilterIsEmpty`/`toMatchExplorerFilterInput` from
 * `./match-explorer-view.js` directly.
 */

const REPRESENTATIVE_MATCH_KIND_LABELS: Readonly<Record<RepresentativeMatchKind, string>> =
  Object.freeze({
    closest: 'Closest matchup',
    largest_upset: 'Largest upset',
    most_one_sided: 'Most one-sided',
    shortest: 'Shortest',
    longest: 'Longest',
    pre_adaptation: 'Pre-adaptation',
    random_ordinary: 'Deterministic ordinary sample',
  });

/** One of the seven representative-match categories, in words. */
export function representativeMatchKindLabel(kind: RepresentativeMatchKind): string {
  return REPRESENTATIVE_MATCH_KIND_LABELS[kind];
}
