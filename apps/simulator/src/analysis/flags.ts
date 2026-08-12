import { z } from 'zod';
import type { AnalysisSettings } from '../config.js';
import type { Aggregate, CardSummary } from './aggregate.js';
import type { Cluster, ClusterMatchup, ClusteringResult } from './clusters.js';
import type { CounterBreadth } from './counters.js';
import type { Displacement } from './displacement.js';
import type { InclusionAnalysis } from './inclusion.js';
import type { CardPair } from './pairs.js';
import type { ReplacementImpact } from './replacement.js';
import type { OpponentSensitivity } from './sensitivity.js';
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
  /** Covers enough *strategic clusters*, by the §5 definition. Never deck share. */
  'broad_cross_cluster_inclusion',
  /**
   * Decks running the card win more than decks without it. A correlation, and
   * separate from cross-cluster coverage — the two used to share one reason code
   * and one message, which is how a deck-share number came to be described as
   * cluster breadth (PHASE4_HARDENING §5).
   */
  'high_inclusion_win_rate_lift',
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
  /**
   * The run's decks contain mechanics no pilot values or no record observes
   * (M05.1). A `run_quality` note, and the reason a card flag beside it may have
   * been downgraded.
   */
  'unsupported_mechanics',
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
  /** Cluster-based inclusion coverage (PHASE4_HARDENING §5). */
  readonly inclusion?: InclusionAnalysis;
  /** Per-card opponent-field sensitivity (PHASE4_HARDENING §10.1). */
  readonly sensitivity?: readonly OpponentSensitivity[];
  /** Replicated, normalized displacement evidence (PHASE4_HARDENING §11). */
  readonly displacement?: readonly Displacement[];
  /** Controlled counter evidence, when a target population was declared. */
  readonly counters?: CounterBreadth;
  /**
   * What the run's own mechanic support lets it claim (M05.1). Absent means "no
   * limits known", which is only correct for a caller that has no decks — every
   * experiment passes it.
   */
  readonly support?: SupportLimits;
  /** Deck count, for the support note's sample size. */
  readonly deckCount?: number;
}

export function computeFlags(inputs: FlagInputs): Flag[] {
  const raw: Flag[] = [
    ...runQualityFlags(inputs),
    ...cardFlags(inputs),
    ...inclusionFlags(inputs),
    ...pairFlags(inputs),
    ...replacementFlags(inputs),
    ...clusterFlags(inputs),
    ...sensitivityFlags(inputs),
    ...displacementFlags(inputs),
    ...counterFlags(inputs),
  ];

  // The downgrade runs last and over everything, so a flag added later cannot
  // quietly escape it by being computed in a new helper (M05.1).
  const flags = inputs.support
    ? [
        ...applySupportLimits(raw, inputs.support),
        ...supportFlags(inputs.support, inputs.deckCount ?? 0),
      ]
    : raw;

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

/* ------------------------------------------------- support-limited evidence */

/**
 * Levels a flag can claim about balance. `run_quality` is about the run itself
 * and is never downgraded: "3 matches ended abnormally" stays true however
 * blindly the pilots played.
 */
const BALANCE_LEVELS: readonly FlagLevel[] = ['review_recommended', 'possible_interaction'];

export interface SupportLimits {
  /** Every pilot in the run only plays legally, so none of it is play quality. */
  readonly legalOnlyPilots: boolean;
  /** Card IDs no pilot values at least one thing about. */
  readonly pilotBlindCards: readonly string[];
  /** Card IDs nothing in a match record observes. */
  readonly telemetryBlindCards: readonly string[];
}

/**
 * Declines the balance claims the run's own support cannot carry (M05.1).
 *
 * A flag is *downgraded to `insufficient_data`*, never dropped, for the same
 * reason a small sample is: "we cannot tell" has to stay visible, and a
 * suppressed flag looks exactly like a clean bill of health. The evidence, the
 * sample size and the threshold are all preserved, and the message gains the
 * sentence explaining which support was missing, so the downgrade can be
 * checked and argued with.
 *
 * Three dependencies, and no others:
 *
 * - **Legality-only pilots.** A `random_legal` run is evidence for termination,
 *   loops and crashes. Every balance claim in it is a claim about uniform random
 *   play, so all of them are declined at once.
 * - **A card no pilot values.** A card-subject flag about a card carrying an
 *   unvalued mechanic — a Reaction that counters, today — is a claim about a
 *   card the pilots played blind. It is not evidence that the card is strong or
 *   weak; it is evidence that nobody tried.
 * - **A card nothing observes.** A card-subject flag about a card whose every
 *   mechanic is invisible to telemetry cannot be checked against a single
 *   recorded observation, only against the win column.
 *
 * Deck-, cluster- and run-subject flags are left alone by the last two: they are
 * not claims about one card, and a deck does not become unreadable because one
 * of its forty cards is.
 */
export function applySupportLimits(flags: readonly Flag[], limits: SupportLimits): Flag[] {
  const pilotBlind = new Set(limits.pilotBlindCards);
  const telemetryBlind = new Set(limits.telemetryBlindCards);

  return flags.map((flag) => {
    if (!BALANCE_LEVELS.includes(flag.level)) return flag;

    const reasons: string[] = [];
    if (limits.legalOnlyPilots) {
      reasons.push(
        'every pilot in this run plays only legally, so nothing here is evidence about play quality',
      );
    }
    if (pilotBlind.has(flag.subject)) {
      reasons.push('no pilot values at least one mechanic on this card, so it was played blind');
    }
    if (telemetryBlind.has(flag.subject)) {
      reasons.push(
        'nothing this card does reaches a telemetry counter, so the signal is unchecked',
      );
    }
    if (reasons.length === 0) return flag;

    return {
      ...flag,
      level: 'insufficient_data' as FlagLevel,
      message: `${flag.message} Downgraded: ${reasons.join('; ')}.`,
      evidence: { ...flag.evidence, supportDowngraded: true },
    };
  });
}

/**
 * A `run_quality` note stating what the run's decks are made of (M05.1).
 *
 * Separate from the downgrades above and emitted whether or not anything was
 * downgraded, because "every mechanic in these decks is executed, valued and
 * observed" is worth saying out loud when it is true.
 */
export function supportFlags(limits: SupportLimits, deckCount: number): Flag[] {
  const parts: string[] = [];
  if (limits.legalOnlyPilots) {
    parts.push('every pilot in this run plays only legally');
  }
  if (limits.pilotBlindCards.length > 0) {
    parts.push(`${limits.pilotBlindCards.length} card(s) carry a mechanic no pilot values`);
  }
  if (limits.telemetryBlindCards.length > 0) {
    parts.push(`${limits.telemetryBlindCards.length} card(s) do nothing a match record observes`);
  }
  if (parts.length === 0) return [];

  return [
    {
      level: 'run_quality',
      reason: 'unsupported_mechanics',
      subject: 'run',
      message:
        `${parts.join(', ')}. Card-level review signals about those cards are downgraded to ` +
        'insufficient data rather than dropped; the mechanic support section lists exactly which mechanics are involved.',
      evidence: {
        decks: deckCount,
        legalOnlyPilots: limits.legalOnlyPilots,
        pilotBlindCards: limits.pilotBlindCards.join(',') || 'none',
        telemetryBlindCards: limits.telemetryBlindCards.join(',') || 'none',
      },
      sampleSize: deckCount,
      interval: null,
      threshold: null,
    },
  ];
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
  const { settings } = inputs;
  const flags: Flag[] = [];

  for (const card of inputs.aggregate.cards) {
    if (card.seatMatches < settings.minMatchesPerCard) {
      flags.push(insufficient(card, settings));
      continue;
    }

    if (
      card.inclusionWinRateLift >= settings.autoIncludeWinRateLift &&
      card.winRateWhenIncluded.low > card.winRateWhenAbsent.point
    ) {
      flags.push({
        level: 'review_recommended',
        reason: 'high_inclusion_win_rate_lift',
        subject: card.definitionId,
        message:
          `Decks running ${card.definitionId} win ${round(card.winRateWhenIncluded.point * 100, 1)}% ` +
          `against ${round(card.winRateWhenAbsent.point * 100, 1)}% for decks without it ` +
          `(+${round(card.inclusionWinRateLift * 100, 1)} points). This is an **association** between ` +
          'the card and winning decks, not evidence that the card caused it, and it says nothing ' +
          'about how many strategies want the card — run a replacement experiment for the first ' +
          'question and read the cross-cluster coverage table for the second.',
        evidence: {
          included: card.winRateWhenIncluded.point,
          absent: card.winRateWhenAbsent.point,
          lift: card.inclusionWinRateLift,
          decksIncluding: card.decksIncluding,
        },
        sampleSize: card.seatMatches,
        interval: { low: card.winRateWhenIncluded.low, high: card.winRateWhenIncluded.high },
        threshold: { name: 'autoIncludeWinRateLift', value: settings.autoIncludeWinRateLift },
      });
    }

    if (card.deadInHandShare >= settings.deadHandShare && card.drawRate > 0.3) {
      // Which half dominates changes what the finding *is*, so it changes the
      // sentence rather than only the numbers behind it.
      const mechanical = card.mechanicallyUnusableShare >= card.strategicallyUnusedShare;
      flags.push({
        level: 'review_recommended',
        reason: 'high_dead_hand_rate',
        subject: card.definitionId,
        message:
          `${round(card.deadInHandShare * 100, 1)}% of the copies of ${card.definitionId} that reached ` +
          `hand were never used. Breakdown: ${describeDead(card)}. ` +
          (mechanical
            ? 'Most of that is mechanical — the card could not legally be played — which is a ' +
              'statement about the card and the board.'
            : 'Most of that is strategic — the card was legal and the pilot chose otherwise — which ' +
              'is a statement about these pilots, and may say more about them than about the card.'),
        evidence: {
          ...card.deadHand,
          deadShare: card.deadInHandShare,
          mechanicallyUnusableShare: card.mechanicallyUnusableShare,
          strategicallyUnusedShare: card.strategicallyUnusedShare,
          drawRate: card.drawRate,
        },
        sampleSize: card.seatMatches,
        interval: null,
        threshold: { name: 'deadHandShare', value: settings.deadHandShare },
      });
    }
  }

  return flags;
}

function describeDead(card: CardSummary): string {
  const at = (key: string): number => card.deadHand[key] ?? 0;
  return (
    `${at('never_affordable')} never affordable, ` +
    `${at('no_capacity')} with no room on the board, ` +
    `${at('no_legal_target')} with no legal target, ` +
    `${at('no_legal_window')} with no legal window, ` +
    `${at('legal_but_unchosen')} legal but unchosen, ` +
    `${at('held_at_end')} still in hand at the end`
  );
}

function insufficient(card: CardSummary, settings: AnalysisSettings): Flag {
  return {
    level: 'insufficient_data',
    reason: 'high_inclusion_win_rate_lift',
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

/* ----------------------------------------------- cross-cluster inclusion (§5) */

/**
 * Coverage of *strategic clusters*, not of decks.
 *
 * Every condition was already decided in `analyzeInclusion`, which is
 * deliberate: the criteria and the numbers behind them live together, and this
 * function only turns a qualifying card into a sentence.
 */
function inclusionFlags(inputs: FlagInputs): Flag[] {
  const { inclusion, settings } = inputs;
  if (!inclusion) return [];

  const flags: Flag[] = [];
  for (const card of inclusion.cards) {
    if (!card.qualifies) continue;

    const covered = card.perCluster.filter((entry) => entry.covered);
    const evidence: Record<string, string | number | boolean> = {
      crossClusterShare: card.crossClusterShare,
      coveredClusters: card.coveredClusters,
      eligibleClusters: card.eligibleClusters,
      decksIncluding: card.decksIncluding,
      decksTotal: card.decksTotal,
      deckInclusionShare: card.deckInclusionShare,
    };
    // The qualifying clusters and their individual inclusion values are a §5
    // reporting requirement, not an optional extra.
    for (const entry of covered) {
      evidence[`cluster_${entry.clusterId}`] =
        `${entry.decksIncluding}/${entry.decksInCluster} decks (${round(entry.inclusion * 100, 1)}%), ` +
        `${entry.observations} seat-matches`;
    }

    flags.push({
      level: 'review_recommended',
      reason: 'broad_cross_cluster_inclusion',
      subject: card.definitionId,
      message:
        `${card.definitionId} is run by at least ` +
        `${round(settings.withinClusterInclusionThreshold * 100, 1)}% of the decks in ` +
        `${card.coveredClusters} of ${card.eligibleClusters} eligible strategic cluster(s) ` +
        `(cross-cluster share ${round(card.crossClusterShare * 100, 1)}%): ` +
        `${covered.map((entry) => `${entry.clusterId} ${round(entry.inclusion * 100, 1)}%`).join(', ')}. ` +
        'This is a **review signal for low opportunity cost or broad generic utility**, not a ' +
        'finding that the card is unhealthy — a card every strategy wants may simply be a good ' +
        'generic card in a small pool.',
      evidence,
      sampleSize: card.supportingObservations,
      interval: null,
      threshold: { name: 'crossClusterShare', value: settings.crossClusterShare },
    });
  }
  return flags;
}

/* ------------------------------------------------------------------- pairs */

function pairFlags(inputs: FlagInputs): Flag[] {
  const { settings } = inputs;
  const flags: Flag[] = [];

  for (const pair of inputs.pairs) {
    if (pair.support < settings.minPairSupport) continue;
    const subject = `${pair.cardA}+${pair.cardB}`;

    // A sparse cell makes the difference-in-differences undefined, not merely
    // imprecise. Saying so is the point of PHASE4_HARDENING §9.2.
    if (pair.insufficientEvidence) {
      flags.push({
        level: 'insufficient_data',
        reason: 'strong_card_pair',
        subject,
        message:
          `The interaction between ${pair.cardA} and ${pair.cardB} cannot be estimated: the ` +
          `${pair.sparseCells.join(', ')} cell(s) hold fewer than ${settings.minPairCellSupport} ` +
          'seat-matches. The contrast needs all four cells — both cards, each alone, and neither — ' +
          'so no number is reported rather than one computed from an empty group.',
        evidence: {
          both: pair.support,
          aOnly: pair.supportAOnly,
          bOnly: pair.supportBOnly,
          neither: pair.supportNeither,
          sparseCells: pair.sparseCells.join(','),
        },
        sampleSize: pair.support,
        interval: null,
        threshold: { name: 'minPairCellSupport', value: settings.minPairCellSupport },
      });
      continue;
    }

    if (pair.interaction >= settings.autoIncludeWinRateLift && pair.low > 0) {
      flags.push({
        level: 'possible_interaction',
        reason: 'strong_card_pair',
        subject,
        message:
          `${pair.cardA} and ${pair.cardB} show an interaction of ` +
          `${round(pair.interaction * 100, 1)} points (${round(pair.low * 100, 1)} … ` +
          `${round(pair.high * 100, 1)}, ${pair.effectSizeLabel} effect): what each card adds is ` +
          'larger when the other is present than when it is not. Cell win rates: ' +
          `both ${round(pair.winRateTogether * 100, 1)}%, ` +
          `${pair.cardA} only ${round(pair.winRateAOnly * 100, 1)}%, ` +
          `${pair.cardB} only ${round(pair.winRateBOnly * 100, 1)}%, ` +
          `neither ${round(pair.winRateNeither * 100, 1)}%. ` +
          'This is an **association** in decks a search chose, not an assignment experiment.',
        evidence: {
          interaction: pair.interaction,
          together: pair.winRateTogether,
          aOnly: pair.winRateAOnly,
          bOnly: pair.winRateBOnly,
          neither: pair.winRateNeither,
          supportBoth: pair.support,
          supportAOnly: pair.supportAOnly,
          supportBOnly: pair.supportBOnly,
          supportNeither: pair.supportNeither,
          liftOverBestSingle: pair.liftOverBestSingle,
          effectSize: pair.effectSize,
          strata: pair.strata,
        },
        sampleSize: pair.support,
        interval: { low: pair.low, high: pair.high },
        threshold: { name: 'autoIncludeWinRateLift', value: settings.autoIncludeWinRateLift },
      });
    }
  }

  return flags;
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
          `The ${impact.direction} test for ${impact.subjectCardId} ran ${impact.baseMatches} base and ` +
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
          (impact.direction === 'insertion'
            ? `Inserting ${impact.subjectCardId} in place of ` +
              `${impact.removedCards.map((entry) => `${entry.quantity}× ${entry.cardId}`).join(', ') || 'nothing'}`
            : `Swapping ${impact.subjectCardId} for ${impact.replacementCardId ?? 'nothing'}`) +
          ` moved the deck's win rate by ` +
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
          `"${cluster.label}" loses to only one other **strategic cluster**, ` +
          `${only.opponentClusterId}. That is cluster matchup breadth, not card-level counter ` +
          'availability: it does not name a card anyone could add to answer this, and it cannot ' +
          'tell a broadly playable answer from a silver bullet. Run a replacement experiment with ' +
          '`counterTargetDeckIds` set to this cluster for the card-level question.',
        evidence: {
          label: cluster.label,
          onlyCounter: only.opponentClusterId,
          rate: only.rate.point,
          measure: 'cluster_matchup_breadth',
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

/* -------------------------------------------- opponent-field sensitivity (§10.1) */

function sensitivityFlags(inputs: FlagInputs): Flag[] {
  const { sensitivity, settings } = inputs;
  if (!sensitivity) return [];

  return sensitivity
    .filter((entry) => entry.status === 'sensitive')
    .map((entry) => ({
      level: 'review_recommended' as const,
      reason: 'opponent_field_sensitivity' as const,
      subject: entry.subject,
      message: `${entry.subject}: ${entry.note}`,
      evidence: {
        best: entry.best?.opponentClusterId ?? '',
        bestRate: entry.best?.winRate ?? 0,
        bestMatches: entry.best?.matches ?? 0,
        worst: entry.worst?.opponentClusterId ?? '',
        worstRate: entry.worst?.winRate ?? 0,
        worstMatches: entry.worst?.matches ?? 0,
        spread: entry.spread,
        supportedFields: entry.fields.length,
        droppedFields: entry.droppedFields.length,
      },
      sampleSize: entry.totalMatches,
      interval:
        entry.best && entry.worst
          ? { low: round(entry.worst.low), high: round(entry.best.high) }
          : null,
      threshold: { name: 'opponentFieldSpread', value: settings.opponentFieldSpread },
    }));
}

/* ------------------------------------------------------------ displacement */

/**
 * Did the candidate environment's cards push comparable old cards out of
 * successful decks? (CLAUDE.md §13.11, PHASE4_HARDENING §11.)
 *
 * Every criterion — normalized shares, replicate count, between-replicate
 * variation, pool-legality separation — is decided in `analyzeDisplacement`.
 * A card whose disappearance is unstable arrives here as `insufficient_evidence`
 * and is reported as such, so "we cannot tell" stays visible instead of looking
 * like a confirmed finding or like nothing at all.
 */
function displacementFlags(inputs: FlagInputs): Flag[] {
  const { displacement, settings } = inputs;
  if (!displacement) return [];

  const flags: Flag[] = [];

  for (const entry of displacement.filter((item) => item.status === 'displaced')) {
    flags.push({
      level: 'review_recommended',
      reason: 'candidate_displacement',
      subject: entry.definitionId,
      message: entry.note,
      evidence: {
        baselineMeanShare: entry.baselineMeanShare,
        candidateMeanShare: entry.candidateMeanShare,
        shareDelta: entry.shareDelta,
        relativeDrop: entry.relativeDrop,
        betweenReplicateVariation: entry.betweenReplicateVariation,
        replicates: entry.replicates,
        likelyReplacedBy: entry.likelyReplacedBy.map((item) => item.definitionId).join(', '),
      },
      sampleSize: entry.replicates,
      interval: null,
      threshold: { name: 'displacementShareDrop', value: settings.displacementShareDrop },
    });
  }

  // Only surfaced for cards that actually fell — an `insufficient_evidence` row
  // for every card in the pool would bury the report.
  for (const entry of displacement.filter(
    (item) => item.status === 'insufficient_evidence' && item.shareDelta < 0,
  )) {
    flags.push({
      level: 'insufficient_data',
      reason: 'candidate_displacement',
      subject: entry.definitionId,
      message: entry.note,
      evidence: {
        baselineMeanShare: entry.baselineMeanShare,
        candidateMeanShare: entry.candidateMeanShare,
        shareDelta: entry.shareDelta,
        betweenReplicateVariation: entry.betweenReplicateVariation,
        replicates: entry.replicates,
      },
      sampleSize: entry.replicates,
      interval: null,
      threshold: {
        name: 'minDisplacementReplicates',
        value: settings.minDisplacementReplicates,
      },
    });
  }

  return flags;
}

/* --------------------------------------------------- counter breadth (§10.2) */

function counterFlags(inputs: FlagInputs): Flag[] {
  const { counters } = inputs;
  if (!counters) return [];

  if (counters.status === 'unavailable') {
    return [
      {
        level: 'insufficient_data',
        reason: 'single_narrow_counter',
        subject: counters.targetLabel,
        message: counters.note,
        evidence: {
          counterBreadth: 'unavailable',
          clusterMatchupBreadth: counters.clusterMatchupBreadth,
        },
        sampleSize: 0,
        interval: null,
        threshold: null,
      },
    ];
  }

  const practical = counters.counterBreadth ?? 0;
  if (practical > 1 && (counters.broadAnswers ?? 0) > 0) return [];

  return [
    {
      level: 'review_recommended',
      reason: 'single_narrow_counter',
      subject: counters.targetLabel,
      message:
        practical === 0
          ? `No tested substitution improved results against ${counters.targetLabel} with an ` +
            'interval excluding zero. That is a statement about the substitutions tested, not a ' +
            'proof that no answer exists — but a target with no measured answer is worth a look.'
          : `${practical} substitution(s) answered ${counters.targetLabel}, of which ` +
            `${counters.broadAnswers ?? 0} held up against the rest of the field. A counter ` +
            'relationship resting on one narrow silver bullet is fragile: if that card is not ' +
            'worth running for any other reason, in practice the answer is not available.',
      evidence: {
        counterBreadth: practical,
        broadAnswers: counters.broadAnswers ?? 0,
        narrowAnswers: counters.narrowAnswers ?? 0,
        candidatesTested: counters.candidates.length,
        clusterMatchupBreadth: counters.clusterMatchupBreadth,
      },
      sampleSize: counters.candidates.length,
      interval: null,
      threshold: null,
    },
  ];
}

/** Cluster type re-exported so a caller can build `FlagInputs` from one import. */
export type { Cluster };
