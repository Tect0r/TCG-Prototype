import type { CardDatabase } from '@tcg/card-data';
import { simDeckSchema, type SimDeck } from '@tcg/deck-generator';
import {
  type LiveMatchEnvelope,
  type LiveMatchSource,
  type LiveMatchTerminationOrigin,
  LIVE_MATCH_TERMINATION_ORIGINS,
} from '@tcg/match-telemetry';

import { clusterDecks, type Cluster, type ClusterMatchup, type DeckFeatures } from './clusters.js';
import { mean, percentile, proportion, round, type ProportionEstimate } from './stats.js';

/**
 * M08.24A — source-separated Player Meta aggregates over live matches.
 *
 * Lives beside the simulator's own offline aggregation (`./aggregate.ts`,
 * `./clusters.ts`) rather than in `apps/admin-server`, per ADR 0023 §2:
 * "Scheduling semantics, deck legality, aggregation and report meaning have
 * exactly one implementation, and the admin server is a caller of it." A
 * caller reaches this through `@tcg/simulator`'s barrel, never by depending on
 * `@tcg/card-data`, `@tcg/deck-generator` or `@tcg/match-telemetry` directly.
 *
 * Pure, in-memory reduction over `readonly LiveMatchEnvelope[]`: no file
 * enumeration, no config root, no HTTP address. Those stay deferred to a
 * later, explicitly named slice — the same "computation now, execution-shaped
 * wiring later" split M08.19A/B drew for the Adaptive Counter reader
 * (`apps/admin-server/src/service/adaptive-results.ts`'s own doc comment).
 * `M08.25A` is the tranche that turns this into a query surface.
 *
 * Every aggregate is keyed by `(source, contentVersion, rulesVersion)` and
 * never pooled across that key: `source` already *is* the human/mixed/AI
 * split this milestone requires (`human_human` / `human_ai` / `ai_ai`), and
 * content/rules version separation keeps a card whose text or cost changed
 * from being silently compared against its former self. Honest match- vs.
 * unique-deck-weighted views are M08.24C's job, not this slice's — every
 * count and rate here is a plain match-weighted count, and callers get the
 * decisive sample size for free off `ProportionEstimate.total` rather than a
 * second, easy-to-desync field.
 *
 * A `null` `outcome` means the engine never reached a `MatchResult` at all
 * (`terminationOrigin: 'abandoned_unrecordable'`) — such a match is still
 * counted as a selection (it happened, and a Commander/deck was chosen for
 * it) but excluded from every win-rate, matchup and duration figure, whose
 * denominators would otherwise silently understate a real rate by mixing in
 * matches nobody actually won or lost.
 */

export interface LiveMatchAggregatePartition {
  readonly source: LiveMatchSource;
  readonly contentVersion: number;
  readonly rulesVersion: string;
}

export interface CommanderSelectionEntry {
  readonly commanderId: string;
  /** Every match this Commander was seated in, any outcome. */
  readonly matches: number;
  /** Over decisive matches only; `winRate.total` is that decisive sample size. */
  readonly winRate: ProportionEstimate;
}

export interface DeckUsageEntry {
  readonly deckHash: string;
  readonly commanderId: string;
  readonly matches: number;
  readonly winRate: ProportionEstimate;
}

export interface DeckMatchupEntry {
  readonly deckHash: string;
  readonly opponentDeckHash: string;
  readonly winRate: ProportionEstimate;
}

export interface TerminationOriginCount {
  readonly origin: LiveMatchTerminationOrigin;
  readonly matches: number;
}

export interface LiveMatchDurationStats {
  /** Matches with a `MatchResult`; every figure below is `null` when this is 0. */
  readonly decisiveMatches: number;
  readonly meanFinalTurn: number | null;
  readonly medianFinalTurn: number | null;
  readonly p10FinalTurn: number | null;
  readonly p90FinalTurn: number | null;
  readonly maxFinalTurn: number | null;
}

export interface LiveMatchClusterView {
  readonly features: readonly DeckFeatures[];
  readonly clusters: readonly Cluster[];
  readonly matchups: readonly ClusterMatchup[];
  readonly largestClusterShare: number;
}

export interface LiveMatchAggregate {
  readonly partition: LiveMatchAggregatePartition;
  /** Every match in this partition, any outcome. */
  readonly matches: number;
  readonly decisiveMatches: number;
  readonly commanderSelection: readonly CommanderSelectionEntry[];
  readonly deckUsage: readonly DeckUsageEntry[];
  readonly deckMatchups: readonly DeckMatchupEntry[];
  /** `null` exactly when no database was supplied for this partition's `contentVersion`. */
  readonly clusters: LiveMatchClusterView | null;
  readonly clustersUnavailableReason: string | null;
  readonly duration: LiveMatchDurationStats;
  readonly terminationOrigins: readonly TerminationOriginCount[];
}

export interface LiveMatchAggregateOptions {
  /**
   * A card database per `provenance.contentVersion`, so clustering reads each
   * match's cards against the database that was actually live when it was
   * played rather than guessing with the current one. A partition whose
   * version has no entry here reports `clusters: null` with a stated reason
   * instead of resolving cards against the wrong content.
   */
  readonly cardDatabasesByContentVersion?: ReadonlyMap<number, CardDatabase>;
  readonly clusterThreshold?: number;
  readonly confidence?: number;
}

/** Aggregates live matches into one entry per `(source, contentVersion, rulesVersion)` partition. */
export function aggregateLiveMatches(
  matches: readonly LiveMatchEnvelope[],
  options: LiveMatchAggregateOptions = {},
): readonly LiveMatchAggregate[] {
  const confidence = options.confidence ?? 0.95;
  const databases = options.cardDatabasesByContentVersion ?? new Map<number, CardDatabase>();

  const partitions = new Map<string, LiveMatchEnvelope[]>();
  for (const match of matches) {
    const key = partitionKey(match.source, match.provenance.contentVersion, match.provenance.rulesVersion);
    const group = partitions.get(key);
    if (group) group.push(match);
    else partitions.set(key, [match]);
  }

  return [...partitions.values()]
    .map((group) => aggregatePartition(group, databases, options.clusterThreshold, confidence))
    .sort((left, right) => comparePartitions(left.partition, right.partition));
}

function partitionKey(source: LiveMatchSource, contentVersion: number, rulesVersion: string): string {
  return `${source} ${String(contentVersion)} ${rulesVersion}`;
}

function comparePartitions(
  left: LiveMatchAggregatePartition,
  right: LiveMatchAggregatePartition,
): number {
  return (
    left.source.localeCompare(right.source) ||
    left.contentVersion - right.contentVersion ||
    left.rulesVersion.localeCompare(right.rulesVersion)
  );
}

interface Tally {
  wins: number;
  total: number;
}

function bump(tally: Tally, won: boolean): void {
  tally.total += 1;
  if (won) tally.wins += 1;
}

function rate(tally: Tally, confidence: number): ProportionEstimate {
  const estimate = proportion(tally.wins, tally.total, confidence);
  return {
    point: round(estimate.point),
    low: round(estimate.low),
    high: round(estimate.high),
    successes: estimate.successes,
    total: estimate.total,
    margin: round(estimate.margin),
  };
}

function aggregatePartition(
  group: readonly LiveMatchEnvelope[],
  databases: ReadonlyMap<number, CardDatabase>,
  clusterThreshold: number | undefined,
  confidence: number,
): LiveMatchAggregate {
  const first = group[0] as LiveMatchEnvelope;
  const partition: LiveMatchAggregatePartition = {
    source: first.source,
    contentVersion: first.provenance.contentVersion,
    rulesVersion: first.provenance.rulesVersion,
  };

  const commanderSelection = new Map<string, number>();
  const commanderDecisive = new Map<string, Tally>();
  const deckCommander = new Map<string, string>();
  const deckSelection = new Map<string, number>();
  const deckDecisive = new Map<string, Tally>();
  const matchupDecisive = new Map<string, Tally>();
  const terminationCounts = new Map<LiveMatchTerminationOrigin, number>();
  const deckSnapshots = new Map<string, { commanderId: string; cards: SimDeck['cards'] }>();
  const finalTurns: number[] = [];
  let decisiveMatches = 0;

  for (const match of group) {
    terminationCounts.set(
      match.terminationOrigin,
      (terminationCounts.get(match.terminationOrigin) ?? 0) + 1,
    );

    for (const seat of match.seats) {
      commanderSelection.set(
        seat.deck.commanderId,
        (commanderSelection.get(seat.deck.commanderId) ?? 0) + 1,
      );
      deckSelection.set(seat.deck.deckHash, (deckSelection.get(seat.deck.deckHash) ?? 0) + 1);
      deckCommander.set(seat.deck.deckHash, seat.deck.commanderId);
      if (!deckSnapshots.has(seat.deck.deckHash)) {
        deckSnapshots.set(seat.deck.deckHash, {
          commanderId: seat.deck.commanderId,
          cards: seat.deck.cards,
        });
      }
    }

    const outcome = match.outcome;
    if (outcome === null) continue;
    decisiveMatches += 1;
    finalTurns.push(outcome.finalTurn);

    const [seatA, seatB] = match.seats;
    for (const seat of [seatA, seatB] as const) {
      const won = seat.playerId === outcome.winnerId;

      const commanderTally = commanderDecisive.get(seat.deck.commanderId) ?? { wins: 0, total: 0 };
      bump(commanderTally, won);
      commanderDecisive.set(seat.deck.commanderId, commanderTally);

      const deckTally = deckDecisive.get(seat.deck.deckHash) ?? { wins: 0, total: 0 };
      bump(deckTally, won);
      deckDecisive.set(seat.deck.deckHash, deckTally);

      const opponent = seat === seatA ? seatB : seatA;
      const matchupKey = `${seat.deck.deckHash} ${opponent.deck.deckHash}`;
      const matchupTally = matchupDecisive.get(matchupKey) ?? { wins: 0, total: 0 };
      bump(matchupTally, won);
      matchupDecisive.set(matchupKey, matchupTally);
    }
  }

  const commanderSelectionEntries: CommanderSelectionEntry[] = [...commanderSelection]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([commanderId, matchCount]) => ({
      commanderId,
      matches: matchCount,
      winRate: rate(commanderDecisive.get(commanderId) ?? { wins: 0, total: 0 }, confidence),
    }));

  const deckUsageEntries: DeckUsageEntry[] = [...deckSelection]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([deckHash, matchCount]) => ({
      deckHash,
      commanderId: deckCommander.get(deckHash) as string,
      matches: matchCount,
      winRate: rate(deckDecisive.get(deckHash) ?? { wins: 0, total: 0 }, confidence),
    }));

  const deckMatchupEntries: DeckMatchupEntry[] = [...matchupDecisive]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, tally]) => {
      const [deckHash = '', opponentDeckHash = ''] = key.split(' ');
      return { deckHash, opponentDeckHash, winRate: rate(tally, confidence) };
    });

  const terminationOrigins: TerminationOriginCount[] = LIVE_MATCH_TERMINATION_ORIGINS.filter(
    (origin) => terminationCounts.has(origin),
  ).map((origin) => ({ origin, matches: terminationCounts.get(origin) as number }));

  const duration: LiveMatchDurationStats =
    finalTurns.length === 0
      ? {
          decisiveMatches: 0,
          meanFinalTurn: null,
          medianFinalTurn: null,
          p10FinalTurn: null,
          p90FinalTurn: null,
          maxFinalTurn: null,
        }
      : {
          decisiveMatches: finalTurns.length,
          meanFinalTurn: round(mean(finalTurns), 2),
          medianFinalTurn: percentile(finalTurns, 0.5),
          p10FinalTurn: percentile(finalTurns, 0.1),
          p90FinalTurn: percentile(finalTurns, 0.9),
          maxFinalTurn: Math.max(...finalTurns),
        };

  const database = databases.get(partition.contentVersion);
  const { clusters, clustersUnavailableReason } =
    database === undefined
      ? {
          clusters: null,
          clustersUnavailableReason:
            `No card database was supplied for content version ${String(partition.contentVersion)}, ` +
            'so decks in this partition were not clustered.',
        }
      : { clusters: clusterView(deckSnapshots, database, group, clusterThreshold, confidence), clustersUnavailableReason: null };

  return {
    partition,
    matches: group.length,
    decisiveMatches,
    commanderSelection: commanderSelectionEntries,
    deckUsage: deckUsageEntries,
    deckMatchups: deckMatchupEntries,
    clusters,
    clustersUnavailableReason,
    duration,
    terminationOrigins,
  };
}

/**
 * Reuses this module's own deterministic average-linkage clustering
 * (`clusterDecks`/`featuresOf` in `./clusters.js`) for the genuinely
 * nontrivial part — grouping decks by feature distance — without fabricating
 * the simulator's own offline `MatchRecord` shape just to get win rates out
 * of it. `clusterDecks` is called with an empty `records` array (skipping its
 * internal win-rate tally entirely, which is scoped to that heavier shape)
 * and this function tallies decisive wins/matchups itself, directly off the
 * `LiveMatchEnvelope`s already in hand, then folds them onto the clusters
 * `clusterDecks` found.
 */
function clusterView(
  deckSnapshots: ReadonlyMap<string, { commanderId: string; cards: SimDeck['cards'] }>,
  database: CardDatabase,
  group: readonly LiveMatchEnvelope[],
  threshold: number | undefined,
  confidence: number,
): LiveMatchClusterView {
  const decks: SimDeck[] = [...deckSnapshots]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([deckHash, snapshot]) =>
      simDeckSchema.parse({
        id: deckHash,
        label: deckHash,
        commanderId: snapshot.commanderId,
        cards: snapshot.cards,
        hash: deckHash,
      }),
    );

  const base = clusterDecks(
    decks,
    database,
    [],
    threshold === undefined ? { confidence } : { threshold, confidence },
  );

  const membership = new Map<string, string>();
  for (const cluster of base.clusters) {
    for (const deckHash of cluster.deckHashes) membership.set(deckHash, cluster.id);
  }

  const tallies = new Map<string, Tally>();
  const pairTallies = new Map<string, Tally>();
  for (const match of group) {
    const outcome = match.outcome;
    if (outcome === null) continue;

    const [seatA, seatB] = match.seats;
    for (const seat of [seatA, seatB] as const) {
      const clusterId = membership.get(seat.deck.deckHash);
      if (!clusterId) continue;
      const won = seat.playerId === outcome.winnerId;

      const tally = tallies.get(clusterId) ?? { wins: 0, total: 0 };
      bump(tally, won);
      tallies.set(clusterId, tally);

      const opponent = seat === seatA ? seatB : seatA;
      const opponentClusterId = membership.get(opponent.deck.deckHash);
      if (!opponentClusterId) continue;
      const pairKey = `${clusterId} ${opponentClusterId}`;
      const pairTally = pairTallies.get(pairKey) ?? { wins: 0, total: 0 };
      bump(pairTally, won);
      pairTallies.set(pairKey, pairTally);
    }
  }

  const clusters: Cluster[] = base.clusters.map((cluster) => {
    const tally = tallies.get(cluster.id) ?? { wins: 0, total: 0 };
    return { ...cluster, matches: tally.total, winRate: rate(tally, confidence) };
  });

  const matchups: ClusterMatchup[] = [...pairTallies]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, tally]) => {
      const [clusterId = '', opponentClusterId = ''] = key.split(' ');
      return { clusterId, opponentClusterId, rate: rate(tally, confidence) };
    });

  return {
    features: base.features,
    clusters,
    matchups,
    largestClusterShare: base.largestClusterShare,
  };
}
