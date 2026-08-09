import { z } from 'zod';
import type { AnalysisSettings } from '../config.js';
import type { SimDeck } from '../deck-search/deck.js';
import type { MatchRecord } from '../telemetry/schema.js';
import type { ClusteringResult } from './clusters.js';
import { round } from './stats.js';

/**
 * Card inclusion, measured across strategic clusters (PHASE4_HARDENING §5).
 *
 * The defect this replaces: `broad_cross_cluster_inclusion` used to be raised
 * from the share of individual *decks* running a card. That is not what the name
 * says and not what the question needs. Thirty aggro decks that all run the same
 * cheap removal spell produce a very high deck share and tell you nothing about
 * breadth — they are one strategy counted thirty times. The question "does this
 * card go in everything" is a question about how many *distinct strategies*
 * want it, so it has to be asked of the clusters.
 *
 * The definitions, stated exactly as the specification does:
 *
 * ```text
 * cluster_inclusion(c, k) = decks in k running c / decks in k
 * covered(c, k)           = cluster_inclusion(c, k) >= withinClusterInclusionThreshold
 * cross_cluster_share(c)  = covered clusters / eligible clusters
 * ```
 *
 * A cluster is eligible only when it has enough decks *and* enough observed
 * seat-matches. A two-deck cluster that appeared in four games is not a
 * strategy, and letting it count equally in the denominator is how a card ends
 * up flagged or cleared by noise.
 *
 * Broad inclusion is **not** evidence that a card is unhealthy. A card every
 * strategy wants may simply be a good generic card in a small pool. What it is
 * evidence of is low opportunity cost, and that is what the flag says.
 */

export const clusterInclusionSchema = z.strictObject({
  clusterId: z.string(),
  clusterLabel: z.string(),
  decksInCluster: z.number().int().min(0),
  decksIncluding: z.number().int().min(0),
  /** decksIncluding / decksInCluster. */
  inclusion: z.number(),
  /** Seat-matches observed for this cluster, across all its decks. */
  observations: z.number().int().min(0),
  eligible: z.boolean(),
  /** Why an ineligible cluster was left out of the denominator. */
  ineligibleReason: z.string().nullable(),
  covered: z.boolean(),
});
export type ClusterInclusion = z.infer<typeof clusterInclusionSchema>;

export const cardInclusionSchema = z.strictObject({
  definitionId: z.string(),

  /* ------------------------------------------------- deck-level (§5, kept) */
  /**
   * Share of *all* decks in the population running the card.
   *
   * Preserved under its own name because it is a genuinely useful descriptive
   * number — it is just not cluster coverage, and was previously reported as
   * though it were.
   */
  deckInclusionShare: z.number(),
  decksIncluding: z.number().int().min(0),
  decksTotal: z.number().int().min(0),

  /* ---------------------------------------------------------- cluster-level */
  perCluster: z.array(clusterInclusionSchema),
  eligibleClusters: z.number().int().min(0),
  coveredClusters: z.number().int().min(0),
  /** coveredClusters / eligibleClusters. */
  crossClusterShare: z.number(),
  /** Seat-matches behind every covered cluster, summed. */
  supportingObservations: z.number().int().min(0),
  /**
   * Whether every §5 condition is met. The flag layer adds no further criteria;
   * everything that decides the flag is computed and recorded here.
   */
  qualifies: z.boolean(),
  /** Which condition failed first, for a flag that must explain itself. */
  disqualifiedBecause: z.string().nullable(),
});
export type CardInclusion = z.infer<typeof cardInclusionSchema>;

export interface InclusionAnalysis {
  readonly cards: readonly CardInclusion[];
  readonly eligibleClusters: number;
  readonly ineligibleClusters: number;
  /** The thresholds that produced these numbers, echoed for the report. */
  readonly thresholds: {
    readonly withinClusterInclusionThreshold: number;
    readonly crossClusterShare: number;
    readonly minimumCoveredClusters: number;
    readonly minDecksPerCluster: number;
    readonly minObservationsPerCluster: number;
    readonly minDecksSupportingCard: number;
  };
}

export function analyzeInclusion(
  decks: readonly SimDeck[],
  clustering: ClusteringResult,
  records: readonly MatchRecord[],
  settings: AnalysisSettings,
): InclusionAnalysis {
  const deckByHash = new Map(decks.map((deck) => [deck.hash, deck] as const));

  // Seat-matches per deck, so a cluster's observation count is real rather than
  // assumed from its size.
  const observationsByDeck = new Map<string, number>();
  for (const record of records) {
    for (const seat of record.seats) {
      observationsByDeck.set(seat.deckHash, (observationsByDeck.get(seat.deckHash) ?? 0) + 1);
    }
  }

  interface ClusterContext {
    readonly id: string;
    readonly label: string;
    readonly deckHashes: readonly string[];
    readonly observations: number;
    readonly eligible: boolean;
    readonly ineligibleReason: string | null;
  }

  const clusters: ClusterContext[] = clustering.clusters.map((cluster) => {
    const observations = cluster.deckHashes.reduce(
      (sum, hash) => sum + (observationsByDeck.get(hash) ?? 0),
      0,
    );
    let ineligibleReason: string | null = null;
    if (cluster.deckHashes.length < settings.minDecksPerCluster) {
      ineligibleReason =
        `only ${cluster.deckHashes.length} deck(s), below minDecksPerCluster = ` +
        `${settings.minDecksPerCluster}`;
    } else if (observations < settings.minObservationsPerCluster) {
      ineligibleReason =
        `only ${observations} seat-match(es), below minObservationsPerCluster = ` +
        `${settings.minObservationsPerCluster}`;
    }
    return {
      id: cluster.id,
      label: cluster.label,
      deckHashes: cluster.deckHashes,
      observations,
      eligible: ineligibleReason === null,
      ineligibleReason,
    };
  });

  const eligibleClusters = clusters.filter((cluster) => cluster.eligible);

  const cardIds = new Set<string>();
  for (const deck of decks) for (const entry of deck.cards) cardIds.add(entry.cardId);

  const runs = (deckHash: string, cardId: string): boolean =>
    deckByHash.get(deckHash)?.cards.some((entry) => entry.cardId === cardId) ?? false;

  const cards = [...cardIds].sort().map((definitionId): CardInclusion => {
    const perCluster = clusters.map((cluster): ClusterInclusion => {
      const including = cluster.deckHashes.filter((hash) => runs(hash, definitionId)).length;
      const inclusion = cluster.deckHashes.length === 0 ? 0 : including / cluster.deckHashes.length;
      return {
        clusterId: cluster.id,
        clusterLabel: cluster.label,
        decksInCluster: cluster.deckHashes.length,
        decksIncluding: including,
        inclusion: round(inclusion, 4),
        observations: cluster.observations,
        eligible: cluster.eligible,
        ineligibleReason: cluster.ineligibleReason,
        covered: cluster.eligible && inclusion >= settings.withinClusterInclusionThreshold,
      };
    });

    const covered = perCluster.filter((entry) => entry.covered);
    const share = eligibleClusters.length === 0 ? 0 : covered.length / eligibleClusters.length;
    const decksIncluding = decks.filter((deck) => runs(deck.hash, definitionId)).length;
    const supportingObservations = covered.reduce((sum, entry) => sum + entry.observations, 0);

    // Checked in the order a reader would ask them, so the recorded reason is
    // the *first* thing that was actually wrong rather than an arbitrary one.
    let disqualifiedBecause: string | null = null;
    if (eligibleClusters.length === 0) {
      disqualifiedBecause = 'no cluster in this run met the eligibility minimums';
    } else if (covered.length < settings.minimumCoveredClusters) {
      disqualifiedBecause =
        `covers ${covered.length} eligible cluster(s), below minimumCoveredClusters = ` +
        `${settings.minimumCoveredClusters}`;
    } else if (share < settings.crossClusterShare) {
      disqualifiedBecause =
        `cross-cluster share ${round(share, 3)} is below crossClusterShare = ` +
        `${settings.crossClusterShare}`;
    } else if (decksIncluding < settings.minDecksSupportingCard) {
      disqualifiedBecause =
        `only ${decksIncluding} deck(s) run it, below minDecksSupportingCard = ` +
        `${settings.minDecksSupportingCard}`;
    }

    return {
      definitionId,
      deckInclusionShare: decks.length === 0 ? 0 : round(decksIncluding / decks.length, 4),
      decksIncluding,
      decksTotal: decks.length,
      perCluster,
      eligibleClusters: eligibleClusters.length,
      coveredClusters: covered.length,
      crossClusterShare: round(share, 4),
      supportingObservations,
      qualifies: disqualifiedBecause === null,
      disqualifiedBecause,
    };
  });

  return {
    cards,
    eligibleClusters: eligibleClusters.length,
    ineligibleClusters: clusters.length - eligibleClusters.length,
    thresholds: {
      withinClusterInclusionThreshold: settings.withinClusterInclusionThreshold,
      crossClusterShare: settings.crossClusterShare,
      minimumCoveredClusters: settings.minimumCoveredClusters,
      minDecksPerCluster: settings.minDecksPerCluster,
      minObservationsPerCluster: settings.minObservationsPerCluster,
      minDecksSupportingCard: settings.minDecksSupportingCard,
    },
  };
}
