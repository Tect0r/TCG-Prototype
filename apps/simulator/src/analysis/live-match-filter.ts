import type {
  LiveMatchEnvelope,
  LiveMatchSource,
  LiveMatchTerminationOrigin,
} from '@tcg/match-telemetry';

/**
 * M08.25A — the service half of the Player Meta query surface.
 *
 * `packages/admin-contracts/src/player-meta.ts`'s `playerMetaFilterSchema` is
 * the client-facing shape of the same five fields below; this file is the
 * one place that actually reads a `LiveMatchEnvelope` to decide whether it
 * matches, per ADR 0023 §2 ("aggregation and report meaning have exactly one
 * implementation"). The two are not linked by an import — `@tcg/simulator`
 * does not depend on `@tcg/admin-contracts` (that dependency runs the other
 * way, through `apps/admin-server`) — they are linked by both restating the
 * same five field names over the same primitive types, so a parsed
 * `PlayerMetaFilter` is assignable here without translation.
 *
 * `filterLiveMatches` only narrows *which* envelopes reach
 * `partitionLiveMatches`/`aggregateLiveMatches` (`./live-match-aggregate.ts`)
 * — it does not touch partitioning, weighting or any other computed field.
 * That is what "retaining evidence class and denominator" means here: the
 * source-keyed partition and the match-weighted/unique-deck-weighted counts
 * M08.24C already computes are produced by code this file never runs, so a
 * filter cannot silently widen, collapse or fabricate either.
 */

export interface LiveMatchFilter {
  /** Any of these content versions. Empty/absent matches every content version. */
  readonly contentVersions?: readonly number[];
  /** Any of these sources. Empty/absent matches every source; never pools them regardless. */
  readonly sources?: readonly LiveMatchSource[];
  /** Matches where either seat's deck was led by one of these Commanders. */
  readonly commanderIds?: readonly string[];
  /** Matches where either seat played one of these exact decks. */
  readonly deckHashes?: readonly string[];
  /** Any of these termination origins. */
  readonly terminations?: readonly LiveMatchTerminationOrigin[];
}

/** `true` when `set` is empty or absent — the "this field does not filter" case every field shares. */
function matchesAny<T>(set: readonly T[] | undefined, value: T): boolean {
  return set === undefined || set.length === 0 || set.includes(value);
}

function matchesEitherSeat<T>(
  set: readonly T[] | undefined,
  match: LiveMatchEnvelope,
  read: (deck: LiveMatchEnvelope['seats'][number]['deck']) => T,
): boolean {
  if (set === undefined || set.length === 0) return true;
  return match.seats.some((seat) => set.includes(read(seat.deck)));
}

/**
 * Narrows `matches` to the envelopes a `LiveMatchFilter` admits.
 *
 * OR within a field, AND across fields — the same reading
 * `packages/admin-contracts/src/filters.ts` states for `catalogFilterSchema`,
 * restated here because this is the function that actually applies it.
 */
export function filterLiveMatches(
  matches: readonly LiveMatchEnvelope[],
  filter: LiveMatchFilter,
): readonly LiveMatchEnvelope[] {
  return matches.filter(
    (match) =>
      matchesAny(filter.contentVersions, match.provenance.contentVersion) &&
      matchesAny(filter.sources, match.source) &&
      matchesEitherSeat(filter.commanderIds, match, (deck) => deck.commanderId) &&
      matchesEitherSeat(filter.deckHashes, match, (deck) => deck.deckHash) &&
      matchesAny(filter.terminations, match.terminationOrigin),
  );
}

/** The filter that excludes nothing, for a caller that would rather not spell `{}`. */
export const NO_LIVE_MATCH_FILTER: LiveMatchFilter = {};
