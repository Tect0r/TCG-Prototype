import { z } from 'zod';
import type { MatchRecord } from '../telemetry/schema.js';
import { stratifiedBootstrap } from './paired.js';
import { cohensH, effectSizeLabel, proportion, round } from './stats.js';

/**
 * Card-pair interaction (CLAUDE.md §13.11, PHASE4_HARDENING §9.2).
 *
 * "These two cards together win more than either alone" is the shape most
 * genuine abuse takes, so it gets its own view.
 *
 * ## The estimand, stated exactly
 *
 * For cards A and B, every seat-match falls in exactly one of four cells by what
 * the deck contained:
 *
 * ```text
 * both     A and B      win rate p11
 * aOnly    A, not B     win rate p10
 * bOnly    B, not A     win rate p01
 * neither  neither      win rate p00
 * ```
 *
 * The reported `interaction` is the 2×2 difference-in-differences:
 *
 * ```text
 * interaction = (p11 − p10) − (p01 − p00)
 * ```
 *
 * In words: what the second card adds *on top of* the first, minus what it adds
 * on its own. That is the quantity "synergy" actually names. Two independently
 * strong cards produce an interaction near zero however high `p11` is, which is
 * the whole point — the previous estimator compared `p11` against the better
 * single and would call any two good cards a combination.
 *
 * ## Uncertainty
 *
 * The interval comes from a stratified bootstrap over seat-matches, so every one
 * of the four cells contributes its own sampling error to the result. §9.2 makes
 * this a requirement: an interval derived from the `both` cell alone understates
 * the uncertainty of a contrast that involves four of them. Strata are
 * `pilot | seat`, so a resample cannot silently re-weight the pilots.
 *
 * ## Sparsity
 *
 * Every cell must clear `minCellSupport` independently. A pair that never
 * appears apart has no marginal to compare against; a pair whose `neither` cell
 * is empty has no baseline. Both return `insufficientEvidence` rather than a
 * number, because a difference-in-differences over an empty cell is not a small
 * sample, it is undefined.
 *
 * ## Wording
 *
 * These are archive associations, not experiments. Decks were not assigned their
 * cards at random — a search chose them — so `interaction` is an association and
 * is never described as an effect. The controlled replacement experiment is the
 * tool for the causal question.
 */

export const cardPairSchema = z.strictObject({
  cardA: z.string(),
  cardB: z.string(),

  /* --------------------------------------------------------- the four cells */
  /** Seat-matches with both cards. The historical `support` number. */
  support: z.number().int().min(0),
  supportAOnly: z.number().int().min(0),
  supportBOnly: z.number().int().min(0),
  supportNeither: z.number().int().min(0),

  winRateTogether: z.number(),
  winRateAOnly: z.number(),
  winRateBOnly: z.number(),
  winRateNeither: z.number(),

  /* ---------------------------------------------------------- the estimates */
  /** (p11 − p10) − (p01 − p00). The synergy estimand. */
  interaction: z.number(),
  /** Bootstrap interval on `interaction`, propagating all four cells. */
  low: z.number(),
  high: z.number(),
  /**
   * Descriptive: together minus the better single. Kept because it is what a
   * reader expects to see, and labelled so it is not mistaken for the estimand.
   */
  liftOverBestSingle: z.number(),
  effectSize: z.number(),
  effectSizeLabel: z.string(),

  /** Set when any contributing cell is too sparse for the contrast to be defined. */
  insufficientEvidence: z.boolean(),
  /** Which cell fell short, when one did. */
  sparseCells: z.array(z.string()),
  /** Distinct pilot/seat strata the bootstrap resampled within. */
  strata: z.number().int().min(0),
  estimand: z.string(),
});
export type CardPair = z.infer<typeof cardPairSchema>;

interface Observation {
  readonly hasA: boolean;
  readonly hasB: boolean;
  readonly won: boolean;
  readonly stratum: string;
}

export interface CardPairOptions {
  readonly minSupport?: number;
  readonly minCellSupport?: number;
  readonly confidence?: number;
  readonly seed?: string;
  readonly iterations?: number;
}

const ESTIMAND =
  '(win rate with both − win rate with A only) − (win rate with B only − win rate with neither); ' +
  'an observational association over the decks this run happened to contain, not a causal effect';

export function cardPairs(
  records: readonly MatchRecord[],
  options: CardPairOptions = {},
): CardPair[] {
  const minSupport = options.minSupport ?? 20;
  const minCellSupport = options.minCellSupport ?? 15;
  const confidence = options.confidence ?? 0.95;
  const seed = options.seed ?? 'pairs';

  // One pass to collect every seat's card set, its outcome and its stratum.
  const seats: { cards: Set<string>; won: boolean; stratum: string }[] = [];
  const universe = new Set<string>();

  for (const record of records) {
    for (const seat of record.seats) {
      const cards = new Set(
        record.cards
          .filter((card) => card.playerId === seat.playerId && card.copiesInDeck > 0)
          .map((card) => card.definitionId),
      );
      for (const cardId of cards) universe.add(cardId);
      seats.push({ cards, won: seat.won, stratum: `${seat.pilotId}|${seat.seatIndex}` });
    }
  }

  const sorted = [...universe].sort();
  const pairs: CardPair[] = [];

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const cardA = sorted[i] as string;
      const cardB = sorted[j] as string;

      const observations: Observation[] = seats.map((seat) => ({
        hasA: seat.cards.has(cardA),
        hasB: seat.cards.has(cardB),
        won: seat.won,
        stratum: seat.stratum,
      }));

      const both = observations.filter((entry) => entry.hasA && entry.hasB);
      if (both.length < minSupport) continue;

      const aOnly = observations.filter((entry) => entry.hasA && !entry.hasB);
      const bOnly = observations.filter((entry) => !entry.hasA && entry.hasB);
      const neither = observations.filter((entry) => !entry.hasA && !entry.hasB);

      const sparseCells: string[] = [];
      if (both.length < minCellSupport) sparseCells.push('both');
      if (aOnly.length < minCellSupport) sparseCells.push('a_only');
      if (bOnly.length < minCellSupport) sparseCells.push('b_only');
      if (neither.length < minCellSupport) sparseCells.push('neither');

      const rate = (group: readonly Observation[]): number =>
        group.length === 0 ? 0 : group.filter((entry) => entry.won).length / group.length;

      const p11 = rate(both);
      const p10 = rate(aOnly);
      const p01 = rate(bOnly);
      const p00 = rate(neither);
      const interaction = p11 - p10 - (p01 - p00);
      const bestSingle = Math.max(p10, p01);
      const h = cohensH(p11, bestSingle);

      let low = Number.NaN;
      let high = Number.NaN;
      let strata = 0;

      if (sparseCells.length === 0) {
        // Resample seat-matches within pilot/seat strata, recomputing all four
        // cells each time. Every cell's sampling error therefore reaches the
        // interval, which is the §9.2 requirement.
        const byStratum = new Map<string, Observation[]>();
        for (const entry of observations) {
          const bucket = byStratum.get(entry.stratum);
          if (bucket) bucket.push(entry);
          else byStratum.set(entry.stratum, [entry]);
        }
        const groups = [...byStratum.entries()]
          .sort((left, right) => left[0].localeCompare(right[0]))
          .map(([, bucket]) => bucket);
        strata = groups.length;

        const result = stratifiedBootstrap(
          groups,
          (resample) => {
            const flat = resample.flat();
            const r11 = flat.filter((entry) => entry.hasA && entry.hasB);
            const r10 = flat.filter((entry) => entry.hasA && !entry.hasB);
            const r01 = flat.filter((entry) => !entry.hasA && entry.hasB);
            const r00 = flat.filter((entry) => !entry.hasA && !entry.hasB);
            // A resample that emptied a cell cannot produce the contrast at all.
            // Substituting a zero would silently bias the interval toward the
            // remaining cells, so the draw is discarded and counted instead.
            if (r11.length === 0 || r10.length === 0 || r01.length === 0 || r00.length === 0) {
              return null;
            }
            return rate(r11) - rate(r10) - (rate(r01) - rate(r00));
          },
          {
            seed: `${seed}|${cardA}|${cardB}`,
            confidence,
            ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
          },
        );
        low = result.low;
        high = result.high;
      }

      pairs.push({
        cardA,
        cardB,
        support: both.length,
        supportAOnly: aOnly.length,
        supportBOnly: bOnly.length,
        supportNeither: neither.length,
        winRateTogether: round(p11),
        winRateAOnly: round(p10),
        winRateBOnly: round(p01),
        winRateNeither: round(p00),
        interaction: round(interaction),
        low: Number.isFinite(low) ? round(low) : Number.NaN,
        high: Number.isFinite(high) ? round(high) : Number.NaN,
        liftOverBestSingle: round(p11 - bestSingle),
        effectSize: round(h),
        effectSizeLabel: effectSizeLabel(h),
        insufficientEvidence: sparseCells.length > 0,
        sparseCells,
        strata,
        estimand: ESTIMAND,
      });
    }
  }

  return pairs.sort((left, right) => {
    if (left.insufficientEvidence !== right.insufficientEvidence) {
      return left.insufficientEvidence ? 1 : -1;
    }
    if (right.interaction !== left.interaction) return right.interaction - left.interaction;
    return `${left.cardA} ${left.cardB}`.localeCompare(`${right.cardA} ${right.cardB}`);
  });
}

/** Re-exported so callers that only need a marginal do not import `stats` too. */
export { proportion };
