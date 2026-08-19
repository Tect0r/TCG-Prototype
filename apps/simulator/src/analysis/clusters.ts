import { z } from 'zod';
import { COLOR_IDS, type CardDatabase, type Role } from '@tcg/card-data';
import { deckSize, type SimDeck } from '@tcg/deck-generator';
import { proportion, round } from './stats.js';
import type { MatchRecord } from '../telemetry/schema.js';

/**
 * Strategic clusters (CLAUDE.md §13.11).
 *
 * The target the analyser is measuring against is a *plural* meta: several
 * viable strategies connected by soft counters. That question cannot be asked of
 * a list of individual decks, so decks are grouped by interpretable features
 * first — colours, curve, type and role mix, keyword density — and the matchup
 * matrix is then asked about the groups.
 *
 * The grouping is deterministic average-linkage agglomerative clustering over a
 * named feature vector. Not because it is the best clustering algorithm, but
 * because every number in the vector is a thing a human can point at on a
 * decklist, and CLAUDE.md forbids introducing an opaque model just to name an
 * archetype.
 */

export const FEATURE_NAMES = [
  ...COLOR_IDS.map((color) => `color_${color}`),
  'cost_cheap',
  'cost_mid',
  'cost_expensive',
  'type_unit',
  'type_spell',
  'type_relic',
  'role_aggressive',
  'role_defensive',
  'role_removal',
  'role_value',
  'role_payoff',
  'keyword_density',
  'unique_density',
] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

const AGGRESSIVE_ROLES: readonly Role[] = ['attacker', 'finisher'];
const DEFENSIVE_ROLES: readonly Role[] = ['blocker', 'support'];
const VALUE_ROLES: readonly Role[] = ['enabler'];
const PAYOFF_ROLES: readonly Role[] = ['payoff', 'build_around'];

export const deckFeaturesSchema = z.strictObject({
  deckHash: z.string(),
  deckId: z.string(),
  commanderId: z.string(),
  features: z.record(z.string(), z.number()),
});
export type DeckFeatures = z.infer<typeof deckFeaturesSchema>;

/** A named, inspectable feature vector for one deck. */
export function featuresOf(deck: SimDeck, database: CardDatabase): DeckFeatures {
  const size = Math.max(1, deckSize(deck));
  const features: Record<string, number> = Object.fromEntries(
    FEATURE_NAMES.map((name) => [name, 0]),
  );

  const commander = database.get(deck.commanderId);
  for (const color of commander?.colorIdentity ?? []) features[`color_${color}`] = 1;

  for (const entry of deck.cards) {
    const card = database.get(entry.cardId);
    if (!card) continue;
    const share = entry.quantity / size;
    const cost = card.cost ?? 0;

    if (cost <= 2) features.cost_cheap = (features.cost_cheap ?? 0) + share;
    else if (cost <= 4) features.cost_mid = (features.cost_mid ?? 0) + share;
    else features.cost_expensive = (features.cost_expensive ?? 0) + share;

    if (card.type === 'unit') features.type_unit = (features.type_unit ?? 0) + share;
    if (card.type === 'spell') features.type_spell = (features.type_spell ?? 0) + share;
    if (card.type === 'relic') features.type_relic = (features.type_relic ?? 0) + share;

    const role = card.role;
    if (role && AGGRESSIVE_ROLES.includes(role)) {
      features.role_aggressive = (features.role_aggressive ?? 0) + share;
    }
    if (role && DEFENSIVE_ROLES.includes(role)) {
      features.role_defensive = (features.role_defensive ?? 0) + share;
    }
    if (role === 'removal') features.role_removal = (features.role_removal ?? 0) + share;
    if (role && VALUE_ROLES.includes(role))
      features.role_value = (features.role_value ?? 0) + share;
    if (role && PAYOFF_ROLES.includes(role)) {
      features.role_payoff = (features.role_payoff ?? 0) + share;
    }

    features.keyword_density = (features.keyword_density ?? 0) + card.keywords.length * share;
    if (card.unique) features.unique_density = (features.unique_density ?? 0) + share;
  }

  for (const name of FEATURE_NAMES) features[name] = round(features[name] ?? 0, 4);

  return {
    deckHash: deck.hash,
    deckId: deck.id,
    commanderId: deck.commanderId,
    features,
  };
}

export function featureDistance(left: DeckFeatures, right: DeckFeatures): number {
  let sum = 0;
  for (const name of FEATURE_NAMES) {
    const delta = (left.features[name] ?? 0) - (right.features[name] ?? 0);
    sum += delta * delta;
  }
  return Math.sqrt(sum);
}

export const clusterSchema = z.strictObject({
  id: z.string(),
  label: z.string(),
  deckHashes: z.array(z.string()),
  /** Mean feature vector, so the label can be checked against the numbers. */
  centroid: z.record(z.string(), z.number()),
  matches: z.number().int().min(0),
  winRate: z.strictObject({
    point: z.number(),
    low: z.number(),
    high: z.number(),
    successes: z.number(),
    total: z.number(),
    margin: z.number(),
  }),
});
export type Cluster = z.infer<typeof clusterSchema>;

export const clusterMatchupSchema = z.strictObject({
  clusterId: z.string(),
  opponentClusterId: z.string(),
  rate: clusterSchema.shape.winRate,
});
export type ClusterMatchup = z.infer<typeof clusterMatchupSchema>;

export interface ClusteringResult {
  readonly features: readonly DeckFeatures[];
  readonly clusters: readonly Cluster[];
  readonly matchups: readonly ClusterMatchup[];
  /** Share of decks in the largest cluster: the concentration warning sign. */
  readonly largestClusterShare: number;
}

/**
 * Average-linkage agglomerative clustering, merged until every remaining pair is
 * further apart than `threshold`.
 *
 * Ties are broken by deck hash so the dendrogram is identical on every run.
 */
export function clusterDecks(
  decks: readonly SimDeck[],
  database: CardDatabase,
  records: readonly MatchRecord[],
  options: { readonly threshold?: number; readonly confidence?: number } = {},
): ClusteringResult {
  const threshold = options.threshold ?? 0.35;
  const confidence = options.confidence ?? 0.95;

  const features = [...decks]
    .sort((left, right) => left.hash.localeCompare(right.hash))
    .map((deck) => featuresOf(deck, database));

  let groups: DeckFeatures[][] = features.map((entry) => [entry]);

  for (;;) {
    let bestDistance = Infinity;
    let bestPair: [number, number] | null = null;

    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const distance = averageLinkage(groups[i] as DeckFeatures[], groups[j] as DeckFeatures[]);
        if (distance < bestDistance - 1e-12) {
          bestDistance = distance;
          bestPair = [i, j];
        }
      }
    }

    if (!bestPair || bestDistance > threshold) break;
    const [i, j] = bestPair;
    const merged = [...(groups[i] as DeckFeatures[]), ...(groups[j] as DeckFeatures[])];
    groups = groups.filter((_, index) => index !== i && index !== j);
    groups.push(merged);
    groups.sort((left, right) => (left[0]?.deckHash ?? '').localeCompare(right[0]?.deckHash ?? ''));
  }

  const membership = new Map<string, string>();
  const clusters: Cluster[] = groups.map((group, index) => {
    const id = `cluster_${String(index + 1).padStart(2, '0')}`;
    for (const entry of group) membership.set(entry.deckHash, id);
    return {
      id,
      label: labelFor(group),
      deckHashes: group.map((entry) => entry.deckHash).sort(),
      centroid: centroidOf(group),
      matches: 0,
      winRate: { point: 0, low: 0, high: 1, successes: 0, total: 0, margin: 0.5 },
    };
  });

  const tallies = new Map<string, { wins: number; total: number }>();
  const pairTallies = new Map<string, { wins: number; total: number }>();

  for (const record of records) {
    for (const seat of record.seats) {
      const clusterId = membership.get(seat.deckHash);
      if (!clusterId) continue;
      const tally = tallies.get(clusterId) ?? { wins: 0, total: 0 };
      tally.total += 1;
      if (seat.won) tally.wins += 1;
      tallies.set(clusterId, tally);

      for (const other of record.seats) {
        if (other.playerId === seat.playerId) continue;
        const opponentId = membership.get(other.deckHash);
        if (!opponentId) continue;
        const key = `${clusterId} ${opponentId}`;
        const pair = pairTallies.get(key) ?? { wins: 0, total: 0 };
        pair.total += 1;
        if (seat.won) pair.wins += 1;
        pairTallies.set(key, pair);
      }
    }
  }

  const withRates: Cluster[] = clusters.map((cluster) => {
    const tally = tallies.get(cluster.id) ?? { wins: 0, total: 0 };
    const rate = proportion(tally.wins, tally.total, confidence);
    return {
      ...cluster,
      matches: tally.total,
      winRate: {
        point: round(rate.point),
        low: round(rate.low),
        high: round(rate.high),
        successes: rate.successes,
        total: rate.total,
        margin: round(rate.margin),
      },
    };
  });

  const matchups: ClusterMatchup[] = [...pairTallies]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, tally]) => {
      const [clusterId = '', opponentClusterId = ''] = key.split(' ');
      const rate = proportion(tally.wins, tally.total, confidence);
      return {
        clusterId,
        opponentClusterId,
        rate: {
          point: round(rate.point),
          low: round(rate.low),
          high: round(rate.high),
          successes: rate.successes,
          total: rate.total,
          margin: round(rate.margin),
        },
      };
    });

  const largest = withRates.reduce((best, cluster) => Math.max(best, cluster.deckHashes.length), 0);

  return {
    features,
    clusters: withRates,
    matchups,
    largestClusterShare: decks.length === 0 ? 0 : round(largest / decks.length, 3),
  };
}

function averageLinkage(left: readonly DeckFeatures[], right: readonly DeckFeatures[]): number {
  let sum = 0;
  for (const a of left) for (const b of right) sum += featureDistance(a, b);
  return sum / (left.length * right.length);
}

function centroidOf(group: readonly DeckFeatures[]): Record<string, number> {
  const centroid: Record<string, number> = {};
  for (const name of FEATURE_NAMES) {
    const total = group.reduce((sum, entry) => sum + (entry.features[name] ?? 0), 0);
    centroid[name] = round(total / group.length, 4);
  }
  return centroid;
}

/**
 * A descriptive label built from the centroid's strongest features.
 *
 * Deliberately mechanical — "green, cheap curve, attacker-heavy" — rather than
 * an archetype name. Naming archetypes is a design judgement, and a clustering
 * routine has not earned it.
 */
function labelFor(group: readonly DeckFeatures[]): string {
  const centroid = centroidOf(group);
  const colors = COLOR_IDS.filter((color) => (centroid[`color_${color}`] ?? 0) >= 0.5);

  const curve = (
    [
      ['cheap curve', centroid.cost_cheap ?? 0],
      ['mid curve', centroid.cost_mid ?? 0],
      ['expensive curve', centroid.cost_expensive ?? 0],
    ] as const
  ).reduce((best, entry) => (entry[1] > best[1] ? entry : best));

  const emphasis = (
    [
      ['attacker-heavy', centroid.role_aggressive ?? 0],
      ['blocker-heavy', centroid.role_defensive ?? 0],
      ['removal-heavy', centroid.role_removal ?? 0],
      ['value-heavy', centroid.role_value ?? 0],
      ['payoff-heavy', centroid.role_payoff ?? 0],
    ] as const
  ).reduce((best, entry) => (entry[1] > best[1] ? entry : best));

  const colorPart = colors.length > 0 ? colors.join('/') : 'neutral';
  return `${colorPart}, ${curve[0]}, ${emphasis[0]}`;
}
