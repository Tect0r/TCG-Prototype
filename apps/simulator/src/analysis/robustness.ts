import { z } from 'zod';
import { PERTURBATION_PROFILE_VERSION } from '@tcg/bot-interface';
import type { AnalysisSettings } from '../config.js';
import type { Aggregate } from './aggregate.js';
import type { ClusteringResult } from './clusters.js';
import type { Flag } from './flags.js';
import { round } from './stats.js';

/**
 * Pilot robustness (PHASE4_HARDENING §10.3).
 *
 * A heuristic pilot is a hypothesis about how the game is played, and every
 * conclusion the laboratory draws is conditional on it. CLAUDE.md §13.11 asks
 * for robustness "across reasonable heuristic-weight perturbations", which was
 * previously only achievable by hand-editing weights and re-reading two reports.
 * This turns it into a measurement.
 *
 * The design that matters: results are compared **per profile**, never pooled.
 * Averaging four differently-tuned pilots into one population would produce a
 * single number that describes no pilot and hides the disagreement, which is the
 * one thing §10.3 explicitly forbids.
 *
 * A conclusion is:
 *
 * - `stable` when the published pilot's finding reappears in at least
 *   `pilotRobustnessAgreement` of the perturbed profiles;
 * - `pilot_sensitive` when the profiles disagree;
 * - `insufficient_evidence` when too few profiles produced a usable sample.
 */

export const robustnessArmSchema = z.strictObject({
  profileId: z.string(),
  matches: z.number().int().min(0),
  usableMatches: z.number().int().min(0),
  /** Flag subjects this profile raised at `review_recommended`. */
  reviewSubjects: z.array(z.string()),
  /** Cluster IDs ordered by win rate, best first. */
  clusterRanking: z.array(z.string()),
  seatSpread: z.number(),
});
export type RobustnessArm = z.infer<typeof robustnessArmSchema>;

export const conclusionStabilitySchema = z.strictObject({
  subject: z.string(),
  kind: z.enum(['card_flag', 'cluster_ranking']),
  /** Profiles in which the published pilot's conclusion also appeared. */
  agreeingProfiles: z.array(z.string()),
  disagreeingProfiles: z.array(z.string()),
  agreement: z.number(),
  status: z.enum(['stable', 'pilot_sensitive', 'insufficient_evidence']),
  note: z.string(),
});
export type ConclusionStability = z.infer<typeof conclusionStabilitySchema>;

export const robustnessReportSchema = z.strictObject({
  profileVersion: z.string(),
  profiles: z.array(z.string()),
  arms: z.array(robustnessArmSchema),
  conclusions: z.array(conclusionStabilitySchema),
  /** Spearman-style agreement of each profile's cluster ranking with `published`. */
  clusterRankAgreement: z.array(
    z.strictObject({ profileId: z.string(), agreement: z.number(), clusters: z.number().int() }),
  ),
  threshold: z.number(),
  note: z.string(),
});
export type RobustnessReport = z.infer<typeof robustnessReportSchema>;

export interface RobustnessArmInput {
  readonly profileId: string;
  readonly aggregate: Aggregate;
  readonly clustering: ClusteringResult;
  readonly flags: readonly Flag[];
}

export const REFERENCE_PROFILE_ID = 'published';

export function analyzeRobustness(
  arms: readonly RobustnessArmInput[],
  settings: AnalysisSettings,
): RobustnessReport {
  const summarized: RobustnessArm[] = arms.map((arm) => ({
    profileId: arm.profileId,
    matches: arm.aggregate.run.matches,
    usableMatches: arm.aggregate.run.usableMatches,
    reviewSubjects: arm.flags
      .filter((flag) => flag.level === 'review_recommended')
      .map((flag) => `${flag.reason}:${flag.subject}`)
      .sort(),
    clusterRanking: [...arm.clustering.clusters]
      .sort(
        (left, right) =>
          right.winRate.point - left.winRate.point || left.id.localeCompare(right.id),
      )
      .map((cluster) => cluster.id),
    seatSpread: round(seatSpreadOf(arm.aggregate), 4),
  }));

  const reference =
    summarized.find((arm) => arm.profileId === REFERENCE_PROFILE_ID) ?? summarized[0];
  const others = summarized.filter((arm) => arm.profileId !== reference?.profileId);

  const conclusions: ConclusionStability[] = [];

  if (reference) {
    for (const subject of reference.reviewSubjects) {
      const agreeing = others
        .filter((arm) => arm.usableMatches > 0 && arm.reviewSubjects.includes(subject))
        .map((arm) => arm.profileId);
      const usable = others.filter((arm) => arm.usableMatches > 0);
      const disagreeing = usable
        .filter((arm) => !arm.reviewSubjects.includes(subject))
        .map((arm) => arm.profileId);
      const agreement = usable.length === 0 ? 0 : agreeing.length / usable.length;

      conclusions.push({
        subject,
        kind: 'card_flag',
        agreeingProfiles: agreeing,
        disagreeingProfiles: disagreeing,
        agreement: round(agreement, 4),
        status:
          usable.length === 0
            ? 'insufficient_evidence'
            : agreement >= settings.pilotRobustnessAgreement
              ? 'stable'
              : 'pilot_sensitive',
        note:
          usable.length === 0
            ? 'No perturbed profile produced a usable sample, so nothing can be said about stability.'
            : `Raised by the published pilot and by ${agreeing.length} of ${usable.length} perturbed ` +
              `profile(s)${disagreeing.length > 0 ? ` (not by ${disagreeing.join(', ')})` : ''}. ` +
              (agreement >= settings.pilotRobustnessAgreement
                ? 'The conclusion survives reasonable re-weighting.'
                : 'The conclusion depends on how the pilot is tuned and should be read as a ' +
                  'statement about these pilots rather than about the cards.'),
      });
    }
  }

  const clusterRankAgreement = others.map((arm) => {
    const shared = arm.clusterRanking.filter((id) => reference?.clusterRanking.includes(id));
    return {
      profileId: arm.profileId,
      agreement: round(rankAgreement(reference?.clusterRanking ?? [], arm.clusterRanking), 4),
      clusters: shared.length,
    };
  });

  if (reference && reference.clusterRanking.length >= 2) {
    const agreeing = clusterRankAgreement
      .filter((entry) => entry.agreement >= settings.pilotRobustnessAgreement)
      .map((entry) => entry.profileId);
    const disagreeing = clusterRankAgreement
      .filter((entry) => entry.agreement < settings.pilotRobustnessAgreement)
      .map((entry) => entry.profileId);
    const agreement =
      clusterRankAgreement.length === 0 ? 0 : agreeing.length / clusterRankAgreement.length;

    conclusions.push({
      subject: 'cluster_ranking',
      kind: 'cluster_ranking',
      agreeingProfiles: agreeing,
      disagreeingProfiles: disagreeing,
      agreement: round(agreement, 4),
      status:
        clusterRankAgreement.length === 0
          ? 'insufficient_evidence'
          : agreement >= settings.pilotRobustnessAgreement
            ? 'stable'
            : 'pilot_sensitive',
      note:
        `The ordering of strategic clusters by win rate agrees with the published pilot in ` +
        `${agreeing.length} of ${clusterRankAgreement.length} perturbed profile(s).`,
    });
  }

  return {
    profileVersion: PERTURBATION_PROFILE_VERSION,
    profiles: summarized.map((arm) => arm.profileId),
    arms: summarized,
    conclusions,
    clusterRankAgreement,
    threshold: settings.pilotRobustnessAgreement,
    note:
      'Each profile is reported separately and never pooled: a merged population would average ' +
      'away exactly the disagreement this experiment exists to expose. A `pilot_sensitive` ' +
      'conclusion is not wrong, it is conditional — it holds for the pilot that produced it.',
  };
}

function seatSpreadOf(aggregate: Aggregate): number {
  const rates = aggregate.run.seatWinRates.map((entry) => entry.rate.point);
  if (rates.length < 2) return 0;
  return Math.max(...rates) - Math.min(...rates);
}

/**
 * Share of ordered cluster pairs the two rankings agree on.
 *
 * A plain concordance rather than a correlation coefficient: it is bounded to
 * [0, 1], it is readable as "these two pilots agree about 80% of the time on
 * which of two strategies is stronger", and it does not need a tie convention.
 */
export function rankAgreement(left: readonly string[], right: readonly string[]): number {
  const shared = left.filter((id) => right.includes(id));
  if (shared.length < 2) return 0;

  let agree = 0;
  let total = 0;
  for (let i = 0; i < shared.length; i += 1) {
    for (let j = i + 1; j < shared.length; j += 1) {
      const a = shared[i] as string;
      const b = shared[j] as string;
      const leftOrder = left.indexOf(a) - left.indexOf(b);
      const rightOrder = right.indexOf(a) - right.indexOf(b);
      total += 1;
      if (leftOrder * rightOrder > 0) agree += 1;
    }
  }
  return total === 0 ? 0 : agree / total;
}
