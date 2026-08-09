import { z } from 'zod';
import type { AnalysisSettings } from '../config.js';
import type { MatchRecord } from '../telemetry/schema.js';
import type { ClusteringResult } from './clusters.js';
import type { ReplacementVariant } from './replacement.js';
import { pairedBinary, type PairedBinary } from './paired.js';
import { round } from './stats.js';

/**
 * Practical counter breadth (PHASE4_HARDENING §10.2).
 *
 * The defect: counter breadth was being asserted from the cluster matchup
 * matrix. "Strategy A loses to strategy B" is a real observation, but it is not
 * the claim "there is a practical answer to A" — it cannot name the answer, it
 * cannot say whether the answer is a card someone would actually run, and it
 * cannot distinguish a broadly playable card from a silver bullet that is dead
 * in every other matchup. §10.2 says: do not claim card-level counter
 * availability from cluster counts alone.
 *
 * So there are two separate things here, under two honest names:
 *
 * - `clusterMatchupBreadth` — how many *strategies* beat the target. Always
 *   computable, never described as a card-level answer.
 * - `counterBreadth` — how many *cards* are supported by controlled replacement
 *   evidence as practical answers. Requires a replacement experiment that
 *   declared a counter target; otherwise it is reported as `unavailable`, which
 *   is the honest result and not a failure.
 *
 * A candidate counts as a practical counter only when it clears both halves of
 * the test: it must improve the target matchup with evidence, *and* it must not
 * collapse against the wider reference field. That second half is what separates
 * an answer from a silver bullet.
 */

export const counterCandidateSchema = z.strictObject({
  cardId: z.string(),
  /** The card it displaced in the controlled variant. */
  replacedCardId: z.string(),
  baseDeckHash: z.string(),
  variantDeckHash: z.string(),
  /** Paired win-rate change against the declared target population. */
  againstTarget: z.unknown(),
  /** Paired win-rate change against everything else in the opponent field. */
  againstField: z.unknown(),
  targetDelta: z.number(),
  fieldDelta: z.number(),
  /** Improves the target matchup with an interval that excludes zero. */
  improvesTarget: z.boolean(),
  /** Does not significantly worsen results against the rest of the field. */
  survivesField: z.boolean(),
  practical: z.boolean(),
  /** `broad` when it holds up everywhere, `narrow` when it is a silver bullet. */
  breadthLabel: z.enum(['broad', 'narrow', 'unsupported']),
  note: z.string(),
});
export type CounterCandidate = z.infer<typeof counterCandidateSchema>;

export const counterBreadthSchema = z.strictObject({
  targetLabel: z.string(),
  /** Deck hashes the counter evidence was measured against. */
  targetDeckHashes: z.array(z.string()),
  status: z.enum(['available', 'unavailable']),
  /**
   * Number of cards with controlled evidence of being a practical answer.
   * `null` when `status` is `unavailable` — deliberately not zero, because
   * "we did not measure" and "we measured and found none" are different.
   */
  counterBreadth: z.number().int().min(0).nullable(),
  broadAnswers: z.number().int().min(0).nullable(),
  narrowAnswers: z.number().int().min(0).nullable(),
  candidates: z.array(counterCandidateSchema),
  /** Always available: how many distinct clusters beat the target. */
  clusterMatchupBreadth: z.number().int().min(0),
  clustersBeatingTarget: z.array(z.string()),
  note: z.string(),
});
export type CounterBreadth = z.infer<typeof counterBreadthSchema>;

export interface CounterBreadthInputs {
  readonly records: readonly MatchRecord[];
  readonly clustering: ClusteringResult;
  readonly settings: AnalysisSettings;
  readonly seed: string;
  /** Deck hashes forming the population a counter is supposed to answer. */
  readonly targetDeckHashes: readonly string[];
  readonly targetLabel?: string;
  /** Controlled variants available as counter candidates. */
  readonly variants?: readonly ReplacementVariant[];
}

export function counterBreadth(inputs: CounterBreadthInputs): CounterBreadth {
  const { settings } = inputs;
  const targets = new Set(inputs.targetDeckHashes);
  const targetLabel = inputs.targetLabel ?? 'the declared target population';

  const clusterBreadth = clusterMatchupBreadth(
    inputs.records,
    inputs.clustering,
    targets,
    settings,
  );

  if (targets.size === 0 || !inputs.variants || inputs.variants.length === 0) {
    return {
      targetLabel,
      targetDeckHashes: [...targets].sort(),
      status: 'unavailable',
      counterBreadth: null,
      broadAnswers: null,
      narrowAnswers: null,
      candidates: [],
      clusterMatchupBreadth: clusterBreadth.count,
      clustersBeatingTarget: clusterBreadth.clusterIds,
      note:
        'No controlled replacement evidence was available for this target, so card-level counter ' +
        'breadth is reported as unavailable rather than inferred. ' +
        `${clusterBreadth.count} strategic cluster(s) beat ${targetLabel} in this run, which is a ` +
        'statement about strategies, not about which card answers them. Configure a replacement ' +
        'experiment with `counterTargetDeckIds` to measure the card-level question.',
    };
  }

  const candidates = inputs.variants
    .map((variant) => evaluateCandidate(variant, inputs, targets))
    .filter((entry): entry is CounterCandidate => entry !== null)
    .sort(
      (left, right) =>
        right.targetDelta - left.targetDelta || left.cardId.localeCompare(right.cardId),
    );

  const practical = candidates.filter((entry) => entry.practical);
  const broad = practical.filter((entry) => entry.breadthLabel === 'broad');

  return {
    targetLabel,
    targetDeckHashes: [...targets].sort(),
    status: 'available',
    counterBreadth: practical.length,
    broadAnswers: broad.length,
    narrowAnswers: practical.length - broad.length,
    candidates,
    clusterMatchupBreadth: clusterBreadth.count,
    clustersBeatingTarget: clusterBreadth.clusterIds,
    note:
      `${practical.length} of ${candidates.length} tested substitution(s) improved results against ` +
      `${targetLabel} with an interval excluding zero, of which ${broad.length} also held up ` +
      'against the rest of the field. A single narrow answer is a fragile counter relationship; ' +
      'none at all means the tested substitutions did not find one, not that none exists.',
  };
}

function evaluateCandidate(
  variant: ReplacementVariant,
  inputs: CounterBreadthInputs,
  targets: ReadonlySet<string>,
): CounterCandidate | null {
  const cardId = variant.replacementCardId;
  if (cardId === null) return null;

  const target = pairedFor(variant, inputs, targets, true);
  const field = pairedFor(variant, inputs, targets, false);
  if (target.pairs === 0) return null;

  const improvesTarget =
    !target.insufficientEvidence &&
    target.low > 0 &&
    target.delta >= inputs.settings.replacementImpact;
  // "Does not become nonfunctional against the wider field": a candidate whose
  // field interval sits entirely below zero has bought the matchup by giving up
  // everywhere else. An unmeasured field is not treated as a pass either — it is
  // reported as such through `breadthLabel`.
  const fieldMeasured = field.pairs > 0 && !field.insufficientEvidence;
  const survivesField = !fieldMeasured || field.high >= 0;

  const practical = improvesTarget && survivesField;
  const breadthLabel: CounterCandidate['breadthLabel'] = !practical
    ? 'unsupported'
    : fieldMeasured && field.low >= -inputs.settings.replacementImpact
      ? 'broad'
      : 'narrow';

  return {
    cardId,
    replacedCardId: variant.subjectCardId,
    baseDeckHash: variant.baseDeckHash,
    variantDeckHash: variant.variantDeckHash,
    againstTarget: target,
    againstField: field,
    targetDelta: round(target.delta),
    fieldDelta: round(field.delta),
    improvesTarget,
    survivesField,
    practical,
    breadthLabel,
    note: describe(cardId, variant.subjectCardId, target, field, practical, breadthLabel),
  };
}

/**
 * Pairs the base arm against the variant arm on matching games, restricted to
 * (or excluding) the target population.
 *
 * The pairing key is the opponent plus the game index plus the seat, exactly as
 * the replacement analysis uses: the two arms are different decks by
 * construction, so any key containing this deck could never match.
 */
function pairedFor(
  variant: ReplacementVariant,
  inputs: CounterBreadthInputs,
  targets: ReadonlySet<string>,
  insideTarget: boolean,
): PairedBinary {
  const collect = (deckHash: string): Map<string, { won: boolean; stratum: string }> => {
    const games = new Map<string, { won: boolean; stratum: string }>();
    for (const record of inputs.records) {
      for (const seat of record.seats) {
        if (seat.deckHash !== deckHash) continue;
        const opponents = record.seats.filter((other) => other.playerId !== seat.playerId);
        const hits = opponents.some((other) => targets.has(other.deckHash));
        if (hits !== insideTarget) continue;
        const key = `${opponents
          .map((other) => other.deckHash)
          .sort()
          .join(',')}:${record.variantKey}:${record.gameIndex}:${seat.seatIndex}`;
        games.set(key, { won: seat.won, stratum: `${seat.pilotId}|${seat.seatIndex}` });
      }
    }
    return games;
  };

  const base = collect(variant.baseDeckHash);
  const changed = collect(variant.variantDeckHash);

  const outcomes = [...base]
    .filter(([key]) => changed.has(key))
    .map(([key, entry]) => ({
      key,
      baselineWon: entry.won,
      candidateWon: changed.get(key)?.won ?? false,
      stratum: entry.stratum,
    }));

  const unmatched = base.size - outcomes.length;

  return pairedBinary(outcomes, {
    seed: `${inputs.seed}|counter:${variant.variantDeckHash}:${insideTarget ? 'target' : 'field'}`,
    confidence: inputs.settings.confidence,
    minPairs: inputs.settings.minPairedGames,
    iterations: inputs.settings.bootstrapIterations,
    ...(unmatched > 0 ? { excluded: { no_matching_game_in_other_arm: unmatched } } : {}),
  });
}

function describe(
  cardId: string,
  replaced: string,
  target: PairedBinary,
  field: PairedBinary,
  practical: boolean,
  breadthLabel: CounterCandidate['breadthLabel'],
): string {
  if (target.insufficientEvidence) {
    return (
      `Playing ${cardId} over ${replaced} was measured on ${target.pairs} paired game(s) against ` +
      'the target, below the configured minimum. No counter claim is made.'
    );
  }
  if (!practical) {
    return (
      `Playing ${cardId} over ${replaced} moved the target matchup by ` +
      `${round(target.delta * 100, 1)} points (${round(target.low * 100, 1)} … ` +
      `${round(target.high * 100, 1)}), which does not clear the threshold with an interval ` +
      'excluding zero. Not supported as a practical answer.'
    );
  }
  return breadthLabel === 'broad'
    ? `Playing ${cardId} over ${replaced} improved the target matchup by ` +
        `${round(target.delta * 100, 1)} points and cost ${round(-field.delta * 100, 1)} points ` +
        'against the rest of the field: a broadly playable answer on this evidence.'
    : `Playing ${cardId} over ${replaced} improved the target matchup by ` +
        `${round(target.delta * 100, 1)} points but moved the wider field by ` +
        `${round(field.delta * 100, 1)} points. That is a narrow silver bullet, not a broadly ` +
        'playable answer — a counter relationship resting on it is fragile.';
}

function clusterMatchupBreadth(
  records: readonly MatchRecord[],
  clustering: ClusteringResult,
  targets: ReadonlySet<string>,
  settings: AnalysisSettings,
): { count: number; clusterIds: string[] } {
  const clusterOf = new Map<string, string>();
  for (const cluster of clustering.clusters) {
    for (const hash of cluster.deckHashes) clusterOf.set(hash, cluster.id);
  }

  const targetClusters = new Set([...targets].map((hash) => clusterOf.get(hash) ?? ''));
  const tallies = new Map<string, { wins: number; total: number }>();

  for (const record of records) {
    for (const seat of record.seats) {
      const own = clusterOf.get(seat.deckHash);
      if (!own || targetClusters.has(own)) continue;
      const opponents = record.seats.filter((other) => other.playerId !== seat.playerId);
      const facesTarget = opponents.some(
        (other) =>
          targets.has(other.deckHash) || targetClusters.has(clusterOf.get(other.deckHash) ?? ''),
      );
      if (!facesTarget) continue;
      const tally = tallies.get(own) ?? { wins: 0, total: 0 };
      tally.total += 1;
      if (seat.won) tally.wins += 1;
      tallies.set(own, tally);
    }
  }

  const beating = [...tallies]
    .filter(
      ([, tally]) => tally.total >= settings.minMatchesPerDeck && tally.wins * 2 > tally.total,
    )
    .map(([clusterId]) => clusterId)
    .sort();

  return { count: beating.length, clusterIds: beating };
}
