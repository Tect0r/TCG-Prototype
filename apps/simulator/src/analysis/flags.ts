import { z } from 'zod';
import type { AnalysisSettings } from '../config.js';
import type { Aggregate, CardSummary } from './aggregate.js';
import type { Cluster, ClusterMatchup, ClusteringResult } from './clusters.js';
import type { CardPair } from './pairs.js';
import type { ReplacementImpact } from './replacement.js';
import { round } from './stats.js';

/**
 * Review guidance (CLAUDE.md §13.11).
 *
 * Every flag is a *recommendation to look*, never a verdict. Three rules are
 * enforced structurally rather than by convention:
 *
 * - The labels are `review_recommended`, `possible_interaction`,
 *   `insufficient_data` and `run_quality`. There is deliberately no
 *   "overpowered" and no "balanced".
 * - Every flag carries a reason code, the evidence it was computed from, the
 *   sample size behind it and an uncertainty interval.
 * - A flag whose sample is below the configured minimum is downgraded to
 *   `insufficient_data` rather than dropped, so "we do not know" is visible
 *   instead of looking like "nothing found".
 */

export const FLAG_LEVELS = [
  'review_recommended',
  'possible_interaction',
  'insufficient_data',
  'run_quality',
] as const;
export const flagLevelSchema = z.enum(FLAG_LEVELS);
export type FlagLevel = z.infer<typeof flagLevelSchema>;

export const FLAG_REASONS = [
  'broad_cross_cluster_inclusion',
  'large_replacement_impact',
  'strong_card_pair',
  'no_unfavourable_context',
  'single_narrow_counter',
  'matchup_polarization',
  'candidate_displacement',
  'high_dead_hand_rate',
  'seat_sensitivity',
  'pilot_sensitivity',
  'opponent_field_sensitivity',
  'abnormal_terminations',
  'excessive_match_length',
  'diversity_collapse',
] as const;
export const flagReasonSchema = z.enum(FLAG_REASONS);
export type FlagReason = z.infer<typeof flagReasonSchema>;

export const flagSchema = z.strictObject({
  level: flagLevelSchema,
  reason: flagReasonSchema,
  /** What the flag is about: a card ID, a deck hash, a cluster ID, or the run. */
  subject: z.string(),
  message: z.string(),
  /** Named numbers the flag was computed from, so it can be checked. */
  evidence: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  sampleSize: z.number().int().min(0),
  /** Interval on the headline number, when one exists. */
  interval: z.strictObject({ low: z.number(), high: z.number() }).nullable(),
  /** Which configured threshold produced this flag. */
  threshold: z.strictObject({ name: z.string(), value: z.number() }).nullable(),
});
export type Flag = z.infer<typeof flagSchema>;

export interface FlagInputs {
  readonly aggregate: Aggregate;
  readonly clustering: ClusteringResult;
  readonly pairs: readonly CardPair[];
  readonly replacements: readonly ReplacementImpact[];
  readonly settings: AnalysisSettings;
  /** Cards the candidate environment introduced, for displacement checks. */
  readonly candidateCardIds?: readonly string[];
  /** Card inclusion counts in a baseline population, for displacement checks. */
  readonly baselineInclusion?: ReadonlyMap<string, number>;
  readonly candidateInclusion?: ReadonlyMap<string, number>;
}

export function computeFlags(inputs: FlagInputs): Flag[] {
  const flags: Flag[] = [
    ...runQualityFlags(inputs),
    ...cardFlags(inputs),
    ...pairFlags(inputs),
    ...replacementFlags(inputs),
    ...clusterFlags(inputs),
    ...displacementFlags(inputs),
  ];

  // Stable order: most actionable first, then alphabetically, so two runs of
  // the analyser print the same list in the same order.
  const rank: Record<FlagLevel, number> = {
    review_recommended: 0,
    possible_interaction: 1,
    run_quality: 2,
    insufficient_data: 3,
  };
  return flags.sort((left, right) => {
    if (rank[left.level] !== rank[right.level]) return rank[left.level] - rank[right.level];
    if (left.reason !== right.reason) return left.reason.localeCompare(right.reason);
    return left.subject.localeCompare(right.subject);
  });
}

/* ------------------------------------------------------------- run quality */

function runQualityFlags(inputs: FlagInputs): Flag[] {
  const { run } = inputs.aggregate;
  const { settings } = inputs;
  const flags: Flag[] = [];

  if (run.abnormalShare > settings.abnormalShare) {
    flags.push({
      level: 'run_quality',
      reason: 'abnormal_terminations',
      subject: 'run',
      message:
        `${run.abnormalMatches} of ${run.matches} matches ended abnormally ` +
        `(${round(run.abnormalShare * 100, 1)}%). Read every other number in this report with that in mind.`,
      evidence: { abnormal: run.abnormalMatches, matches: run.matches, ...run.terminations },
      sampleSize: run.matches,
      interval: null,
      threshold: { name: 'abnormalShare', value: settings.abnormalShare },
    });
  }

  if (run.botFailures > 0) {
    flags.push({
      level: 'run_quality',
      reason: 'abnormal_terminations',
      subject: 'pilots',
      message:
        `${run.botFailures} pilot failure(s) were recovered by the random-legal fallback. ` +
        'Those decisions were not the pilot the configuration named.',
      evidence: { botFailures: run.botFailures },
      sampleSize: run.matches,
      interval: null,
      threshold: null,
    });
  }

  const seatRates = run.seatWinRates;
  if (seatRates.length > 1) {
    const best = seatRates.reduce((a, b) => (a.rate.point >= b.rate.point ? a : b));
    const worst = seatRates.reduce((a, b) => (a.rate.point <= b.rate.point ? a : b));
    const spread = best.rate.point - worst.rate.point;
    // Only a spread whose intervals do not overlap is worth reporting.
    if (spread > 0.1 && best.rate.low > worst.rate.high) {
      flags.push({
        level: 'review_recommended',
        reason: 'seat_sensitivity',
        subject: 'run',
        message:
          `Seat ${best.seatIndex} wins ${round(best.rate.point * 100, 1)}% against ` +
          `seat ${worst.seatIndex}'s ${round(worst.rate.point * 100, 1)}%, and the intervals do not overlap. ` +
          'The schedule mirrors seats, so this is a rules-level advantage rather than a scheduling artefact.',
        evidence: {
          bestSeat: best.seatIndex,
          bestRate: best.rate.point,
          worstSeat: worst.seatIndex,
          worstRate: worst.rate.point,
          spread: round(spread),
        },
        sampleSize: best.rate.total + worst.rate.total,
        interval: {
          low: round(best.rate.low - worst.rate.high),
          high: round(best.rate.high - worst.rate.low),
        },
        threshold: { name: 'seatSpread', value: 0.1 },
      });
    }
  }

  const pilotRates = run.pilotWinRates;
  if (pilotRates.length > 1) {
    const best = pilotRates.reduce((a, b) => (a.rate.point >= b.rate.point ? a : b));
    const worst = pilotRates.reduce((a, b) => (a.rate.point <= b.rate.point ? a : b));
    if (best.rate.point - worst.rate.point > 0.25) {
      flags.push({
        level: 'run_quality',
        reason: 'pilot_sensitivity',
        subject: 'run',
        message:
          `Pilot "${best.pilotId}" wins ${round(best.rate.point * 100, 1)}% and "${worst.pilotId}" ` +
          `wins ${round(worst.rate.point * 100, 1)}%. Results this pilot-sensitive describe the pilots ` +
          'at least as much as they describe the cards.',
        evidence: {
          bestPilot: best.pilotId,
          bestRate: best.rate.point,
          worstPilot: worst.pilotId,
          worstRate: worst.rate.point,
        },
        sampleSize: best.rate.total + worst.rate.total,
        interval: null,
        threshold: { name: 'pilotSpread', value: 0.25 },
      });
    }
  }

  if (run.turns.p90 > 60) {
    flags.push({
      level: 'run_quality',
      reason: 'excessive_match_length',
      subject: 'run',
      message:
        `The slowest tenth of matches ran past turn ${run.turns.p90} (longest: ${run.turns.max}). ` +
        'Long matches may mean the pilots cannot close, or that the format cannot.',
      evidence: { p90: run.turns.p90, max: run.turns.max, mean: run.turns.mean },
      sampleSize: run.usableMatches,
      interval: null,
      threshold: { name: 'turnP90', value: 60 },
    });
  }

  if (inputs.clustering.clusters.length > 0 && inputs.clustering.largestClusterShare > 0.8) {
    flags.push({
      level: 'run_quality',
      reason: 'diversity_collapse',
      subject: 'population',
      message:
        `${round(inputs.clustering.largestClusterShare * 100, 1)}% of decks fall in one strategic cluster. ` +
        'The population is too concentrated to say much about counter relationships.',
      evidence: {
        clusters: inputs.clustering.clusters.length,
        largestShare: inputs.clustering.largestClusterShare,
      },
      sampleSize: inputs.clustering.features.length,
      interval: null,
      threshold: { name: 'largestClusterShare', value: 0.8 },
    });
  }

  return flags;
}

/* ------------------------------------------------------------------- cards */

function cardFlags(inputs: FlagInputs): Flag[] {
  const { settings, clustering } = inputs;
  const flags: Flag[] = [];
  const clusterOf = new Map<string, string>();
  for (const cluster of clustering.clusters) {
    for (const hash of cluster.deckHashes) clusterOf.set(hash, cluster.id);
  }

  for (const card of inputs.aggregate.cards) {
    if (card.seatMatches < settings.minMatchesPerCard) {
      flags.push(insufficient(card, settings));
      continue;
    }

    if (
      card.inclusionWinRateLift >= settings.autoIncludeWinRateLift &&
      card.winRateWhenIncluded.low > card.winRateWhenAbsent.point
    ) {
      const clusters = new Set(
        clustering.clusters.filter((cluster) => cluster.deckHashes.length > 0).map((c) => c.id),
      );
      const share =
        clusters.size === 0 ? 0 : card.decksIncluding / Math.max(1, clustering.features.length);
      flags.push({
        level: 'review_recommended',
        reason: 'broad_cross_cluster_inclusion',
        subject: card.definitionId,
        message:
          `Decks running ${card.definitionId} win ${round(card.winRateWhenIncluded.point * 100, 1)}% ` +
          `against ${round(card.winRateWhenAbsent.point * 100, 1)}% for decks without it ` +
          `(+${round(card.inclusionWinRateLift * 100, 1)} points). This is a correlation, not a controlled ` +
          'result — run a replacement experiment before drawing a conclusion.',
        evidence: {
          included: card.winRateWhenIncluded.point,
          absent: card.winRateWhenAbsent.point,
          lift: card.inclusionWinRateLift,
          decksIncluding: card.decksIncluding,
          populationShare: round(share, 3),
        },
        sampleSize: card.seatMatches,
        interval: { low: card.winRateWhenIncluded.low, high: card.winRateWhenIncluded.high },
        threshold: { name: 'autoIncludeWinRateLift', value: settings.autoIncludeWinRateLift },
      });
    }

    if (card.deadInHandShare >= settings.deadHandShare && card.drawRate > 0.3) {
      flags.push({
        level: 'review_recommended',
        reason: 'high_dead_hand_rate',
        subject: card.definitionId,
        message:
          `${round(card.deadInHandShare * 100, 1)}% of drawn copies of ${card.definitionId} were never used. ` +
          `Breakdown: ${describeDead(card)}. That is a card doing nothing in the decks that chose it.`,
        evidence: { ...card.deadHand, deadShare: card.deadInHandShare, drawRate: card.drawRate },
        sampleSize: card.seatMatches,
        interval: null,
        threshold: { name: 'deadHandShare', value: settings.deadHandShare },
      });
    }
  }

  return flags;
}

function describeDead(card: CardSummary): string {
  return (
    `${card.deadHand.never_affordable ?? 0} never affordable, ` +
    `${card.deadHand.no_legal_window ?? 0} with no legal window, ` +
    `${card.deadHand.legal_but_unchosen ?? 0} legal but unchosen`
  );
}

function insufficient(card: CardSummary, settings: AnalysisSettings): Flag {
  return {
    level: 'insufficient_data',
    reason: 'broad_cross_cluster_inclusion',
    subject: card.definitionId,
    message:
      `${card.definitionId} appeared in ${card.seatMatches} seat-matches, below the configured ` +
      `minimum of ${settings.minMatchesPerCard}. Nothing is claimed about it.`,
    evidence: { seatMatches: card.seatMatches, decksIncluding: card.decksIncluding },
    sampleSize: card.seatMatches,
    interval: null,
    threshold: { name: 'minMatchesPerCard', value: settings.minMatchesPerCard },
  };
}

/* ------------------------------------------------------------------- pairs */

function pairFlags(inputs: FlagInputs): Flag[] {
  return inputs.pairs
    .filter((pair) => pair.support >= inputs.settings.minPairSupport)
    .filter((pair) => pair.lift >= inputs.settings.autoIncludeWinRateLift && pair.low > 0)
    .map((pair) => ({
      level: 'possible_interaction' as const,
      reason: 'strong_card_pair' as const,
      subject: `${pair.cardA}+${pair.cardB}`,
      message:
        `Decks running both ${pair.cardA} and ${pair.cardB} win ${round(pair.winRateTogether * 100, 1)}%, ` +
        `against ${round(Math.max(pair.winRateAOnly, pair.winRateBOnly) * 100, 1)}% for the better card alone ` +
        `(+${round(pair.lift * 100, 1)} points, ${pair.effectSizeLabel} effect).`,
      evidence: {
        together: pair.winRateTogether,
        aOnly: pair.winRateAOnly,
        bOnly: pair.winRateBOnly,
        lift: pair.lift,
        effectSize: pair.effectSize,
      },
      sampleSize: pair.support,
      interval: { low: pair.low, high: pair.high },
      threshold: { name: 'minPairSupport', value: inputs.settings.minPairSupport },
    }));
}

/* ------------------------------------------------------------- replacement */

function replacementFlags(inputs: FlagInputs): Flag[] {
  const flags: Flag[] = [];
  for (const impact of inputs.replacements) {
    if (impact.insufficientData) {
      flags.push({
        level: 'insufficient_data',
        reason: 'large_replacement_impact',
        subject: impact.subjectCardId,
        message:
          `The replacement test for ${impact.subjectCardId} ran ${impact.baseMatches} base and ` +
          `${impact.variantMatches} variant seat-matches, below the configured minimum. Nothing is claimed.`,
        evidence: { base: impact.baseMatches, variant: impact.variantMatches },
        sampleSize: Math.min(impact.baseMatches, impact.variantMatches),
        interval: { low: impact.low, high: impact.high },
        threshold: { name: 'minMatchesPerCard', value: inputs.settings.minMatchesPerCard },
      });
      continue;
    }

    if (
      Math.abs(impact.impact) >= inputs.settings.replacementImpact &&
      impact.low * impact.high > 0
    ) {
      flags.push({
        level: 'review_recommended',
        reason: 'large_replacement_impact',
        subject: impact.subjectCardId,
        message:
          `Swapping ${impact.subjectCardId} for ` +
          `${impact.replacementCardId ?? 'nothing'} moved the deck's win rate by ` +
          `${round(impact.impact * 100, 1)} points ` +
          `(${round(impact.low * 100, 1)} to ${round(impact.high * 100, 1)}, ${impact.effectSizeLabel} effect) ` +
          `over ${impact.pairedGames} paired games.` +
          (impact.confounds.length > 0
            ? ` Not a clean comparison: ${impact.confounds.join('; ')}.`
            : ''),
        evidence: {
          baseWinRate: impact.baseWinRate,
          variantWinRate: impact.variantWinRate,
          impact: impact.impact,
          pairedGames: impact.pairedGames,
          confounds: impact.confounds.length,
        },
        sampleSize: Math.min(impact.baseMatches, impact.variantMatches),
        interval: { low: impact.low, high: impact.high },
        threshold: { name: 'replacementImpact', value: inputs.settings.replacementImpact },
      });
    }
  }
  return flags;
}

/* ---------------------------------------------------------------- clusters */

function clusterFlags(inputs: FlagInputs): Flag[] {
  const { clustering, settings } = inputs;
  const flags: Flag[] = [];

  for (const cluster of clustering.clusters) {
    const asAttacker = clustering.matchups.filter((entry) => entry.clusterId === cluster.id);
    if (asAttacker.length === 0) continue;
    // A cluster of one deck is a deck, not a strategy. Calling a single decklist
    // "a strategy with no unfavourable matchup" would be a category error.
    if (cluster.deckHashes.length < 2) continue;

    const unfavourable = asAttacker.filter((entry) => entry.rate.high < 0.5);
    if (
      asAttacker.length >= 3 &&
      unfavourable.length === 0 &&
      cluster.matches >= settings.minMatchesPerDeck
    ) {
      flags.push({
        level: 'review_recommended',
        reason: 'no_unfavourable_context',
        subject: cluster.id,
        message:
          `"${cluster.label}" has no losing matchup against any other cluster in this run. ` +
          'A strategy without an unfavourable context is the shape a dominant strategy takes.',
        evidence: {
          label: cluster.label,
          matchupsMeasured: asAttacker.length,
          winRate: cluster.winRate.point,
          decks: cluster.deckHashes.length,
        },
        sampleSize: cluster.matches,
        interval: { low: cluster.winRate.low, high: cluster.winRate.high },
        threshold: { name: 'minMatchesPerDeck', value: settings.minMatchesPerDeck },
      });
    }

    if (asAttacker.length >= 3 && unfavourable.length === 1) {
      const only = unfavourable[0] as ClusterMatchup;
      flags.push({
        level: 'review_recommended',
        reason: 'single_narrow_counter',
        subject: cluster.id,
        message:
          `"${cluster.label}" loses only to ${only.opponentClusterId}. A single narrow answer is a ` +
          'fragile counter relationship: if that one strategy is unpopular, this one has none.',
        evidence: {
          label: cluster.label,
          onlyCounter: only.opponentClusterId,
          rate: only.rate.point,
        },
        sampleSize: cluster.matches,
        interval: { low: only.rate.low, high: only.rate.high },
        threshold: null,
      });
    }

    for (const matchup of asAttacker) {
      if (matchup.rate.total < settings.minMatchesPerDeck) continue;
      if (matchup.rate.low >= settings.polarizationThreshold) {
        flags.push({
          level: 'review_recommended',
          reason: 'matchup_polarization',
          subject: `${matchup.clusterId}>${matchup.opponentClusterId}`,
          message:
            `${matchup.clusterId} beats ${matchup.opponentClusterId} ` +
            `${round(matchup.rate.point * 100, 1)}% of the time. Matchups this one-sided are non-games ` +
            'for the player on the wrong side.',
          evidence: { rate: matchup.rate.point, matches: matchup.rate.total },
          sampleSize: matchup.rate.total,
          interval: { low: matchup.rate.low, high: matchup.rate.high },
          threshold: { name: 'polarizationThreshold', value: settings.polarizationThreshold },
        });
      }
    }
  }

  return flags;
}

/* ------------------------------------------------------------ displacement */

/**
 * Did the candidate environment's new cards push comparable old cards out of
 * successful decks? (CLAUDE.md §13.11.)
 */
function displacementFlags(inputs: FlagInputs): Flag[] {
  const { baselineInclusion, candidateInclusion, candidateCardIds } = inputs;
  if (!baselineInclusion || !candidateInclusion || !candidateCardIds) return [];

  const flags: Flag[] = [];
  const dropped: { cardId: string; before: number; after: number }[] = [];

  for (const [cardId, before] of [...baselineInclusion].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (candidateCardIds.includes(cardId)) continue;
    const after = candidateInclusion.get(cardId) ?? 0;
    if (before >= 3 && after <= before / 2) dropped.push({ cardId, before, after });
  }

  if (dropped.length > 0) {
    flags.push({
      level: 'review_recommended',
      reason: 'candidate_displacement',
      subject: candidateCardIds.join('+') || 'candidate',
      message:
        `${dropped.length} card(s) at least halved their inclusion in successful decks after the change: ` +
        `${dropped.map((entry) => `${entry.cardId} (${entry.before}→${entry.after})`).join(', ')}.`,
      evidence: Object.fromEntries(
        dropped.map((entry) => [entry.cardId, entry.after - entry.before]),
      ),
      sampleSize: dropped.length,
      interval: null,
      threshold: { name: 'displacementHalving', value: 0.5 },
    });
  }

  return flags;
}

/** Cluster type re-exported so a caller can build `FlagInputs` from one import. */
export type { Cluster };
