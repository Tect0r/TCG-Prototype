import type { ScheduledMatch } from '../schedule.js';

/**
 * Canonical seat-identity win attribution, shared by `./evaluate.ts`'s
 * screening tallies, `./validate.ts`'s frozen validation tally and
 * `./run.ts`'s block tally (M08.R21).
 *
 * All three attributed a match's winner independently before this file
 * existed, and each got the same three edges slightly differently: whether a
 * scheduled match missing from the reported results counts as `noResult` or
 * silently vanishes, whether a duplicate or unknown result `matchId` is
 * refused or silently collapsed/ignored, and whether a winner that names no
 * seat in its own match is `noResult` or a thrown invariant violation. This
 * file is the one place that now decides all three, so a caller only has to
 * get the shared parts right once.
 */

/** One scheduled match's reported outcome. `winnerPlayerId` is `null` for a draw or otherwise uncounted result. */
export interface AdaptiveSeatResult {
  readonly matchId: string;
  readonly winnerPlayerId: string | null;
}

/** A two-sided win tally. `noResult` covers missing, drawn and invalid results alike. */
export interface AdaptiveSeatTally {
  readonly leftWins: number;
  readonly rightWins: number;
  readonly noResult: number;
}

/**
 * Validates a raw result list against the matches it claims to report on,
 * refusing rather than silently guessing: a `matchId` naming no match in
 * `matches` is unknown, and a `matchId` reported more than once is a
 * duplicate — either would let a naive `Map`-from-array collapse two results
 * into one or attribute a result to the wrong stage's match, so both are
 * hard errors here rather than tally-time ambiguity. Returns a
 * `matchId -> winnerPlayerId` map for `tallyAdaptiveSeatOutcomesFromMap`, so
 * a caller tallying several disjoint groups drawn from one shared result
 * list (screening's opponent/field split) can validate once against the
 * combined universe and then tally each group from the same map.
 */
export function validateAdaptiveSeatResults(
  matches: readonly ScheduledMatch[],
  results: readonly AdaptiveSeatResult[],
): ReadonlyMap<string, string | null> {
  const knownIds = new Set(matches.map((match) => match.matchId));
  const byMatchId = new Map<string, string | null>();
  for (const result of results) {
    if (!knownIds.has(result.matchId)) {
      throw new Error(
        `adaptive result names match ${result.matchId}, which is not part of this schedule.`,
      );
    }
    if (byMatchId.has(result.matchId)) {
      throw new Error(`adaptive result set names match ${result.matchId} more than once.`);
    }
    byMatchId.set(result.matchId, result.winnerPlayerId);
  }
  return byMatchId;
}

/**
 * Attributes each of `matches` to `leftWins`/`rightWins`/`noResult` by seat
 * identity (`playerId` -> `deckIndex`), never by comparing deck content: two
 * seats can hold decks with the same content hash (`ScheduleDeck.hash`/
 * `SimDeck.hash` are deliberately content-only), which would misattribute
 * every such game to whichever side a hash comparison happened to check
 * first. `leftDeckIndex` names which of the schedule's two fixed deck slots
 * counts as "left" for this call's tally; the caller's own fixed `decks`
 * ordering (candidate/incumbent always index 0 in every adaptive schedule
 * this file serves) is what makes that a constant rather than a lookup.
 *
 * Iterates `matches`, not `resultsByMatchId`, so a scheduled match with no
 * entry in the map counts as `noResult` rather than silently vanishing from
 * the tally — a stage that stops early or a result feed that drops an entry
 * is evidence of an incomplete stage, not a stage with fewer games than it
 * scheduled. A present but `null` (drawn) or seat-unmatched winner is also
 * `noResult`; only an unknown or duplicated result `matchId` is refused, by
 * `validateAdaptiveSeatResults` before a map ever reaches this function,
 * because neither is describable as an outcome of any one scheduled match.
 */
export function tallyAdaptiveSeatOutcomesFromMap(
  matches: readonly ScheduledMatch[],
  resultsByMatchId: ReadonlyMap<string, string | null>,
  leftDeckIndex: number,
): AdaptiveSeatTally {
  let leftWins = 0;
  let rightWins = 0;
  let noResult = 0;
  for (const match of matches) {
    const winnerPlayerId = resultsByMatchId.get(match.matchId) ?? null;
    const winnerSeat =
      winnerPlayerId === null
        ? undefined
        : match.seats.find((seat) => seat.playerId === winnerPlayerId);
    if (winnerSeat === undefined) noResult += 1;
    else if (winnerSeat.deckIndex === leftDeckIndex) leftWins += 1;
    else rightWins += 1;
  }
  return { leftWins, rightWins, noResult };
}

/** Validates `results` against `matches` and tallies them in one call — the common case of a single group reporting against its own full result list. */
export function tallyAdaptiveSeatOutcomes(
  matches: readonly ScheduledMatch[],
  results: readonly AdaptiveSeatResult[],
  leftDeckIndex: number,
): AdaptiveSeatTally {
  const resultsByMatchId = validateAdaptiveSeatResults(matches, results);
  return tallyAdaptiveSeatOutcomesFromMap(matches, resultsByMatchId, leftDeckIndex);
}
