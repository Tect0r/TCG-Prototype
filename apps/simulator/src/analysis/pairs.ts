import { z } from 'zod';
import type { MatchRecord } from '../telemetry/schema.js';
import { cohensH, effectSizeLabel, proportion, round } from './stats.js';

/**
 * Card-pair and small-combination lift (CLAUDE.md §13.11).
 *
 * "These two cards together win more than either alone" is the shape most
 * genuine abuse takes, so it gets its own view. Two safeguards keep it honest:
 *
 * - **Minimum support.** A pair seen a handful of times says nothing, and is not
 *   reported at all rather than reported with a wide interval nobody reads.
 * - **Marginals.** Lift is measured against what the two cards achieve
 *   *separately* in this run, not against 50%. Two strong cards appearing
 *   together is not evidence of a combination — and a pair that never appears
 *   apart has no marginal to compare against, so it is not reported either.
 *
 * Only pairs are computed. Triples explode combinatorially and, at the sample
 * sizes a local experiment reaches, cannot clear a support threshold worth
 * having — so they are deliberately not attempted rather than reported badly.
 */

export const cardPairSchema = z.strictObject({
  cardA: z.string(),
  cardB: z.string(),
  /** Seat-matches in which both cards were in the same deck. */
  support: z.number().int().min(0),
  winRateTogether: z.number(),
  /** Win rate of A without B, and of B without A, in the same run. */
  winRateAOnly: z.number(),
  winRateBOnly: z.number(),
  /** Together, minus the better of the two singles. Positive means synergy. */
  lift: z.number(),
  low: z.number(),
  high: z.number(),
  effectSize: z.number(),
  effectSizeLabel: z.string(),
});
export type CardPair = z.infer<typeof cardPairSchema>;

interface Tally {
  wins: number;
  total: number;
}

const bump = (map: Map<string, Tally>, key: string, won: boolean): void => {
  const tally = map.get(key) ?? { wins: 0, total: 0 };
  tally.total += 1;
  if (won) tally.wins += 1;
  map.set(key, tally);
};

export function cardPairs(
  records: readonly MatchRecord[],
  options: { readonly minSupport?: number; readonly confidence?: number } = {},
): CardPair[] {
  const minSupport = options.minSupport ?? 20;
  const confidence = options.confidence ?? 0.95;

  const singles = new Map<string, Tally>();
  const together = new Map<string, Tally>();
  /** A present, B absent — the honest comparison for a pair. */
  const aWithoutB = new Map<string, Tally>();

  for (const record of records) {
    for (const seat of record.seats) {
      const included = record.cards
        .filter((card) => card.playerId === seat.playerId && card.copiesInDeck > 0)
        .map((card) => card.definitionId)
        .sort();
      const includedSet = new Set(included);

      for (const cardId of included) bump(singles, cardId, seat.won);

      for (let i = 0; i < included.length; i += 1) {
        for (let j = i + 1; j < included.length; j += 1) {
          bump(together, `${included[i]} ${included[j]}`, seat.won);
        }
      }

      // For the "A without B" arm we need every ordered pair where A is in and
      // B is out. Restricted to cards that appear somewhere in the run, which is
      // exactly the `singles` key set once the whole pass is done — so this is
      // computed in a second pass below instead.
      void includedSet;
    }
  }

  const universe = [...singles.keys()].sort();
  for (const record of records) {
    for (const seat of record.seats) {
      const included = new Set(
        record.cards
          .filter((card) => card.playerId === seat.playerId && card.copiesInDeck > 0)
          .map((card) => card.definitionId),
      );
      for (const cardA of universe) {
        if (!included.has(cardA)) continue;
        for (const cardB of universe) {
          if (cardA === cardB || included.has(cardB)) continue;
          bump(aWithoutB, `${cardA} ${cardB}`, seat.won);
        }
      }
    }
  }

  const pairs: CardPair[] = [];
  for (const [key, tally] of [...together].sort((left, right) => left[0].localeCompare(right[0]))) {
    if (tally.total < minSupport) continue;
    const [cardA = '', cardB = ''] = key.split(' ');

    const both = proportion(tally.wins, tally.total, confidence);
    const onlyA = aWithoutB.get(`${cardA} ${cardB}`) ?? { wins: 0, total: 0 };
    const onlyB = aWithoutB.get(`${cardB} ${cardA}`) ?? { wins: 0, total: 0 };

    // Two cards that never appear apart have no marginals to compare against.
    // Measuring them anyway would compare a real win rate to an empty sample and
    // manufacture a lift the size of the win rate itself — the exact spurious
    // conclusion the marginals exist to prevent. There is nothing to say here.
    if (onlyA.total === 0 || onlyB.total === 0) continue;

    const rateA = proportion(onlyA.wins, onlyA.total, confidence);
    const rateB = proportion(onlyB.wins, onlyB.total, confidence);

    // Compared against the *better* single, so a pair only looks synergistic
    // when it beats both of its parts.
    const baseline = Math.max(rateA.point, rateB.point);
    const lift = both.point - baseline;

    pairs.push({
      cardA,
      cardB,
      support: tally.total,
      winRateTogether: round(both.point),
      winRateAOnly: round(rateA.point),
      winRateBOnly: round(rateB.point),
      lift: round(lift),
      low: round(both.low - baseline),
      high: round(both.high - baseline),
      effectSize: round(cohensH(both.point, baseline)),
      effectSizeLabel: effectSizeLabel(cohensH(both.point, baseline)),
    });
  }

  return pairs.sort((left, right) => {
    if (right.lift !== left.lift) return right.lift - left.lift;
    return `${left.cardA} ${left.cardB}`.localeCompare(`${right.cardA} ${right.cardB}`);
  });
}
