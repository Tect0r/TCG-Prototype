import { z } from 'zod';
import type { AnalysisSettings } from '../config.js';
import type { SimDeck } from '@tcg/deck-generator';
import { mean, round, stdev } from './stats.js';

/**
 * Displacement evidence (PHASE4_HARDENING §11).
 *
 * The defect: a strong "candidate_displacement" warning was raised from raw
 * archive counts such as `6 → 3`. Those counts come from two *separate*
 * evolutionary runs whose populations differ in size, whose search is
 * stochastic, and neither of which is a sample of anything in particular. A
 * halving of a count that small is inside the run-to-run noise of the search
 * itself, so the warning was reporting the search's variance as a finding about
 * a card.
 *
 * What is required instead:
 *
 * - **Normalized shares, not counts.** How many decks ran the card, over how
 *   many decks there were. A candidate archive of 12 and a baseline archive of
 *   24 are not comparable as counts.
 * - **Replicates.** Several independent searches per environment, on separate
 *   deterministic seed families with matched budgets, so between-replicate
 *   variation can be measured rather than assumed away.
 * - **Legality separated from selection.** A card that left because the
 *   candidate pool banned it was not out-competed, and calling that displacement
 *   would be a category error.
 * - **Replacements named.** "What took its slot" is the part a designer can act
 *   on, and its absence is why the old warning was not actionable.
 *
 * Anything that fails those tests is downgraded to `insufficient_evidence` or to
 * an informational note. The default report must never call an unstable archive
 * fluctuation confirmed obsolescence.
 */

export const replicateShareSchema = z.strictObject({
  replicate: z.string(),
  decks: z.number().int().min(0),
  decksIncluding: z.number().int().min(0),
  share: z.number(),
});
export type ReplicateShare = z.infer<typeof replicateShareSchema>;

export const displacementSchema = z.strictObject({
  definitionId: z.string(),
  baselineShares: z.array(replicateShareSchema),
  candidateShares: z.array(replicateShareSchema),
  baselineMeanShare: z.number(),
  candidateMeanShare: z.number(),
  /** Candidate mean minus baseline mean, in share points. */
  shareDelta: z.number(),
  /** Relative drop, as a fraction of the baseline share. */
  relativeDrop: z.number(),
  /** Standard deviation of the share across replicates, per environment. */
  baselineVariation: z.number(),
  candidateVariation: z.number(),
  /** The larger of the two, as the noise floor a claimed drop must clear. */
  betweenReplicateVariation: z.number(),
  replicates: z.number().int().min(0),
  /** True when the card is simply not legal in the candidate environment. */
  removedFromPool: z.boolean(),
  /** Cards whose share rose most in the same slot range, as candidates for what replaced it. */
  likelyReplacedBy: z.array(z.strictObject({ definitionId: z.string(), shareGain: z.number() })),
  status: z.enum(['displaced', 'pool_removal', 'stable', 'insufficient_evidence']),
  note: z.string(),
});
export type Displacement = z.infer<typeof displacementSchema>;

/** One independent search result: the decks it ended up with, under a label. */
export interface DisplacementReplicate {
  readonly label: string;
  readonly decks: readonly SimDeck[];
}

export interface DisplacementInputs {
  readonly baseline: readonly DisplacementReplicate[];
  readonly candidate: readonly DisplacementReplicate[];
  /** Card IDs the candidate environment introduced or changed. Never displaced. */
  readonly changedCardIds: readonly string[];
  /** Card IDs legal in the candidate pool. Anything else left for a legality reason. */
  readonly candidatePoolCardIds: readonly string[];
  readonly settings: AnalysisSettings;
}

export function analyzeDisplacement(inputs: DisplacementInputs): Displacement[] {
  const { settings } = inputs;
  const changed = new Set(inputs.changedCardIds);
  const candidatePool = new Set(inputs.candidatePoolCardIds);

  const replicates = Math.min(inputs.baseline.length, inputs.candidate.length);
  const cardIds = new Set<string>();
  for (const replicate of [...inputs.baseline, ...inputs.candidate]) {
    for (const deck of replicate.decks) {
      for (const entry of deck.cards) cardIds.add(entry.cardId);
    }
  }

  const sharesOf = (group: readonly DisplacementReplicate[], cardId: string): ReplicateShare[] =>
    group.map((replicate) => {
      const including = replicate.decks.filter((deck) =>
        deck.cards.some((entry) => entry.cardId === cardId),
      ).length;
      return {
        replicate: replicate.label,
        decks: replicate.decks.length,
        decksIncluding: including,
        share: replicate.decks.length === 0 ? 0 : round(including / replicate.decks.length, 4),
      };
    });

  // Precomputed so "what replaced it" is answered from the same numbers rather
  // than from a second, differently-defined pass.
  const meanShare = (group: readonly DisplacementReplicate[], cardId: string): number =>
    mean(sharesOf(group, cardId).map((entry) => entry.share));
  const gains = [...cardIds]
    .map((cardId) => ({
      definitionId: cardId,
      shareGain: round(meanShare(inputs.candidate, cardId) - meanShare(inputs.baseline, cardId), 4),
    }))
    .filter((entry) => entry.shareGain > 0)
    .sort(
      (left, right) =>
        right.shareGain - left.shareGain || left.definitionId.localeCompare(right.definitionId),
    );

  return [...cardIds]
    .sort()
    .filter((cardId) => !changed.has(cardId))
    .map((definitionId): Displacement => {
      const baselineShares = sharesOf(inputs.baseline, definitionId);
      const candidateShares = sharesOf(inputs.candidate, definitionId);
      const baselineMean = mean(baselineShares.map((entry) => entry.share));
      const candidateMean = mean(candidateShares.map((entry) => entry.share));
      const baselineVariation = stdev(baselineShares.map((entry) => entry.share));
      const candidateVariation = stdev(candidateShares.map((entry) => entry.share));
      const variation = Math.max(baselineVariation, candidateVariation);
      const delta = candidateMean - baselineMean;
      const relativeDrop = baselineMean === 0 ? 0 : -delta / baselineMean;
      const removedFromPool = !candidatePool.has(definitionId);

      const smallestReplicate = Math.min(
        ...[...baselineShares, ...candidateShares].map((entry) => entry.decks),
        Number.POSITIVE_INFINITY,
      );

      const base = {
        definitionId,
        baselineShares,
        candidateShares,
        baselineMeanShare: round(baselineMean, 4),
        candidateMeanShare: round(candidateMean, 4),
        shareDelta: round(delta, 4),
        relativeDrop: round(relativeDrop, 4),
        baselineVariation: round(baselineVariation, 4),
        candidateVariation: round(candidateVariation, 4),
        betweenReplicateVariation: round(variation, 4),
        replicates,
        removedFromPool,
        likelyReplacedBy: [] as { definitionId: string; shareGain: number }[],
      };

      if (removedFromPool) {
        return {
          ...base,
          status: 'pool_removal',
          note:
            `${definitionId} is not legal in the candidate pool, so its disappearance is a card-pool ` +
            'change rather than evolutionary selection. This is not displacement.',
        };
      }

      if (
        replicates < settings.minDisplacementReplicates ||
        smallestReplicate < settings.minDecksPerReplicate
      ) {
        return {
          ...base,
          status: 'insufficient_evidence',
          note:
            `${replicates} replicate(s) of at least ${Number.isFinite(smallestReplicate) ? smallestReplicate : 0} ` +
            `deck(s) each. Displacement needs ${settings.minDisplacementReplicates} replicate(s) of ` +
            `${settings.minDecksPerReplicate}+ decks before a change can be told apart from search ` +
            'variance. Nothing is claimed.',
        };
      }

      if (relativeDrop < settings.displacementShareDrop) {
        return {
          ...base,
          status: 'stable',
          note:
            `Inclusion share moved from ${round(baselineMean * 100, 1)}% to ` +
            `${round(candidateMean * 100, 1)}%, a relative change of ${round(relativeDrop * 100, 1)}%, ` +
            `below displacementShareDrop = ${round(settings.displacementShareDrop * 100, 1)}%.`,
        };
      }

      // The drop has to be bigger than the search's own run-to-run wobble.
      // Without this, a card whose share swings by 30 points between replicates
      // of the *same* environment would be reported as displaced by the change.
      if (Math.abs(delta) <= variation) {
        return {
          ...base,
          status: 'insufficient_evidence',
          note:
            `Inclusion share fell by ${round(-delta * 100, 1)} points, but the share varies by ` +
            `${round(variation * 100, 1)} points between replicates of the same environment. ` +
            'The drop is inside the search’s own noise, so it is not evidence about the card.',
        };
      }

      return {
        ...base,
        likelyReplacedBy: gains.slice(0, 3),
        status: 'displaced',
        note:
          `Inclusion share fell from ${round(baselineMean * 100, 1)}% to ` +
          `${round(candidateMean * 100, 1)}% across ${replicates} independent replicate(s), a drop ` +
          `larger than the ${round(variation * 100, 1)}-point between-replicate variation. ` +
          (gains.length > 0
            ? `The largest offsetting gains were ${gains
                .slice(0, 3)
                .map((entry) => `${entry.definitionId} (+${round(entry.shareGain * 100, 1)} pts)`)
                .join(', ')}. `
            : '') +
          'This is a review signal about what the search preferred, not a statement that the card ' +
          'is obsolete.',
      };
    })
    .filter((entry) => entry.status !== 'stable' || entry.baselineMeanShare > 0);
}
