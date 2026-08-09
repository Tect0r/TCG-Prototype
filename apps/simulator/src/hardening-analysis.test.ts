import { describe, expect, it } from 'vitest';
import { DEFAULT_ANALYSIS_SETTINGS, type AnalysisSettings } from './config.js';
import { analyzeInclusion } from './analysis/inclusion.js';
import { analyzeDisplacement, type DisplacementReplicate } from './analysis/displacement.js';
import { opponentFieldSensitivity } from './analysis/sensitivity.js';
import { counterBreadth } from './analysis/counters.js';
import { analyzeRobustness } from './analysis/robustness.js';
import { cardPairs } from './analysis/pairs.js';
import { aggregate } from './analysis/aggregate.js';
import { computeFlags, FLAG_REASONS } from './analysis/flags.js';
import { pairedBinary, pairedMean, benjaminiHochberg } from './analysis/paired.js';
import type { Cluster, ClusteringResult } from './analysis/clusters.js';
import {
  TELEMETRY_SCHEMA_VERSION,
  matchRecordSchema,
  type MatchRecord,
} from './telemetry/schema.js';
import { makeDeck, type SimDeck } from './deck-search/deck.js';

/**
 * Hardening regression tests for the analysis layer (PHASE4_HARDENING §14).
 *
 * These use hand-built synthetic fixtures with *known* answers rather than the
 * bundled card set, because the point of each one is that the analyser reaches a
 * specific conclusion — and "the real cards happened to produce a plausible
 * number" is not evidence of that. Every fixture below is small enough to check
 * by hand from the numbers written into it.
 */

/* --------------------------------------------------------------- fixtures */

function deck(id: string, cardIds: readonly string[]): SimDeck {
  return makeDeck({
    id,
    label: id,
    commanderId: 'prototype_commander_blue',
    cards: cardIds.map((cardId) => ({ cardId, quantity: 1 })),
  });
}

function cluster(id: string, decks: readonly SimDeck[], matches: number): Cluster {
  return {
    id,
    label: `cluster ${id}`,
    deckHashes: decks.map((entry) => entry.hash),
    centroid: {},
    matches,
    winRate: {
      point: 0.5,
      low: 0.4,
      high: 0.6,
      successes: matches / 2,
      total: matches,
      margin: 0.1,
    },
  };
}

function clustering(clusters: readonly Cluster[]): ClusteringResult {
  const total = clusters.reduce((sum, entry) => sum + entry.deckHashes.length, 0);
  return {
    features: [],
    clusters,
    matchups: [],
    largestClusterShare:
      total === 0 ? 0 : Math.max(...clusters.map((entry) => entry.deckHashes.length)) / total,
  };
}

/**
 * A schema-valid record assembled from the seat observations a test needs.
 *
 * These are *observation fixtures*, not transcripts of played matches: a test
 * that wants one deck to have won thirty of forty games against one field says
 * exactly that, instead of arranging a simulation that happens to produce it.
 * Only the fields the analyser under test reads carry meaning; everything else
 * holds a neutral placeholder so a fixture cannot tilt an unrelated statistic.
 * `playerCount` is the schema's minimum rather than the seat count for the same
 * reason — no analyser here reads it.
 */
function record(options: {
  matchId: string;
  seats: readonly {
    playerId: string;
    deckHash: string;
    deckId: string;
    pilotId?: string;
    seatIndex: number;
    won: boolean;
    cards: readonly string[];
  }[];
  gameIndex?: number;
}): MatchRecord {
  const seats = options.seats.map((seat) => ({
    playerId: seat.playerId,
    seatIndex: seat.seatIndex,
    deckId: seat.deckId,
    deckHash: seat.deckHash,
    commanderId: 'prototype_commander_blue',
    colors: ['blue'],
    pilotId: seat.pilotId ?? 'value',
    pilotVersion: '1.0.0',
    pilotConfigHash: 'fixture',
    pilotSeed: 'fixture',
    won: seat.won,
    lost: !seat.won,
    lossReason: seat.won ? null : 'health',
    eliminatedOnTurn: null,
    startingHealth: 20,
    endingHealth: seat.won ? 10 : 0,
    damageDealtToPlayers: 10,
    damageTaken: 10,
    healingReceived: 0,
    cardsDrawn: 5,
    cardsPlayed: 5,
    cardsDiscarded: 0,
    energySpent: 10,
    energyUnspentAtTurnEnd: 0,
    unitsDeployed: 3,
    relicsDeployed: 0,
    tokensCreated: 0,
    unitsLost: 1,
    attacksDeclared: 3,
    blocksAssigned: 1,
    abilitiesActivated: 0,
    choicesResolved: 0,
    decisions: 20,
  }));

  // Parsed rather than cast: a fixture that has drifted from the schema would
  // otherwise silently prove something about a record shape that cannot exist.
  return matchRecordSchema.parse({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    matchId: options.matchId,
    orderKey: options.matchId,
    experimentId: 'fixture',
    experimentKind: 'batch',
    configHash: 'fixture',
    arm: null,
    environmentId: 'fixture',
    environmentHash: 'fixture',
    cardPoolHash: 'fixture',
    rulesVersion: '0.2.0',
    deckPairId: 'pair',
    variantKey: 'variant',
    gameIndex: options.gameIndex ?? 0,
    orientation: 0,
    playerCount: Math.max(2, seats.length),
    seeds: {
      derivationVersion: 2,
      path: 'fixture',
      matchSeed: 'fixture',
      seatSeed: 'fixture',
      pilotSeeds: seats.map(() => 'fixture'),
    },
    startingPlayerId: seats[0]?.playerId ?? 'player_1',
    outcome: 'win',
    winnerId: seats.find((seat) => seat.won)?.playerId ?? null,
    termination: 'victory',
    endReason: 'health',
    turns: 10,
    actions: 40,
    decisions: 40,
    events: 80,
    resolutionSteps: 40,
    seats,
    cards: options.seats.flatMap((seat) =>
      seat.cards.map((definitionId) => ({
        playerId: seat.playerId,
        definitionId,
        copiesInDeck: 1,
        copiesInOpeningHand: 0,
        copiesMulliganedAway: 0,
        timesDrawn: 1,
        drawnCopies: 1,
        drawnCopiesPlayed: 1,
        firstSeenTurn: 1,
        turnsHeldInHand: 0,
        turnsOnBattlefield: 1,
        playOpportunities: 1,
        affordableOpportunities: 1,
        timesPlayed: 1,
        timesActivated: 0,
        timesDiscarded: 0,
        timesSacrificed: 0,
        timesDefeated: 0,
        timesRemoved: 0,
        timesReturnedToHand: 0,
        energySpent: 1,
        attacksMade: 0,
        blocksMade: 0,
        damageToPlayers: 0,
        damageToUnits: 0,
        healingDone: 0,
        cardsDrawnBy: 0,
        cardsDiscardedBy: 0,
        tokensCreated: 0,
        unitsRemoved: 0,
        triggersFired: 0,
        endedInHand: 0,
        endedOnBattlefield: 0,
        endedInDeck: 0,
        endedInDiscard: 1,
        deadHand: {
          unseen: 0,
          never_affordable: 0,
          no_capacity: 0,
          no_legal_target: 0,
          no_legal_window: 0,
          legal_but_unchosen: 0,
          held_at_end: 0,
          used: 1,
        },
        plays: [],
      })),
    ),
    botFailures: [],
    diagnostics: [],
    replayPath: null,
    softwareCommit: null,
  });
}

/* ------------------------------------------- §5: cross-cluster inclusion */

describe('cross-cluster inclusion measures clusters, not deck share', () => {
  const settings: AnalysisSettings = {
    ...DEFAULT_ANALYSIS_SETTINGS,
    withinClusterInclusionThreshold: 0.5,
    crossClusterShare: 0.75,
    minimumCoveredClusters: 3,
    minDecksPerCluster: 3,
    minObservationsPerCluster: 4,
    minDecksSupportingCard: 3,
  };

  /**
   * Four clusters of three decks each. `generic` is in every deck of clusters
   * A, B and C; `parochial` is in *all nine* decks of one large cluster and
   * nowhere else. Deck share would rank `parochial` at 9/12 = 75% and `generic`
   * at 9/12 = 75% — identical. Cluster coverage separates them completely, which
   * is the entire point of the correction.
   */
  function fixture() {
    const clusters: Cluster[] = [];
    const decks: SimDeck[] = [];
    const records: MatchRecord[] = [];

    for (const [index, id] of ['a', 'b', 'c', 'd'].entries()) {
      const members = [0, 1, 2].map((n) => {
        const cards = ['filler_' + id];
        if (id !== 'd') cards.push('generic');
        return deck(`${id}_${n}`, cards);
      });
      decks.push(...members);
      clusters.push(cluster(id, members, 12));
      // Four seat-matches per deck, so every cluster clears the observation
      // minimum on its own.
      for (const member of members) {
        for (let game = 0; game < 4; game += 1) {
          records.push(
            record({
              matchId: `m_${id}_${member.id}_${game}`,
              gameIndex: game,
              seats: [
                {
                  playerId: 'player_1',
                  deckId: member.id,
                  deckHash: member.hash,
                  seatIndex: 0,
                  won: index % 2 === 0,
                  cards: member.cards.map((entry) => entry.cardId),
                },
              ],
            }),
          );
        }
      }
    }
    return { decks, clustering: clustering(clusters), records };
  }

  it('flags a card that covers enough eligible clusters', () => {
    const { decks, clustering: groups, records } = fixture();
    const analysis = analyzeInclusion(decks, groups, records, settings);
    const generic = analysis.cards.find((card) => card.definitionId === 'generic');

    expect(analysis.eligibleClusters).toBe(4);
    expect(generic?.coveredClusters).toBe(3);
    expect(generic?.crossClusterShare).toBe(0.75);
    expect(generic?.qualifies).toBe(true);
    expect(generic?.disqualifiedBecause).toBeNull();
  });

  it('does not flag high inclusion inside a single cluster', () => {
    const { decks, clustering: groups, records } = fixture();
    const analysis = analyzeInclusion(decks, groups, records, settings);
    const parochial = analysis.cards.find((card) => card.definitionId === 'filler_a');

    // Every deck in cluster A runs it — 100% within-cluster inclusion — and it
    // still must not be called broadly included.
    expect(parochial?.perCluster.find((entry) => entry.clusterId === 'a')?.inclusion).toBe(1);
    expect(parochial?.coveredClusters).toBe(1);
    expect(parochial?.qualifies).toBe(false);
    expect(parochial?.disqualifiedBecause).toMatch(/minimumCoveredClusters/);
  });

  it('does not flag low inclusion scattered across many clusters', () => {
    // One deck per cluster runs it: present everywhere, wanted nowhere.
    const clusters: Cluster[] = [];
    const decks: SimDeck[] = [];
    const records: MatchRecord[] = [];
    for (const id of ['a', 'b', 'c', 'd']) {
      const members = [0, 1, 2].map((n) => deck(`${id}_${n}`, n === 0 ? ['scattered'] : ['other']));
      decks.push(...members);
      clusters.push(cluster(id, members, 12));
      for (const member of members) {
        for (let game = 0; game < 4; game += 1) {
          records.push(
            record({
              matchId: `m_${member.id}_${game}`,
              gameIndex: game,
              seats: [
                {
                  playerId: 'player_1',
                  deckId: member.id,
                  deckHash: member.hash,
                  seatIndex: 0,
                  won: true,
                  cards: member.cards.map((entry) => entry.cardId),
                },
              ],
            }),
          );
        }
      }
    }

    const analysis = analyzeInclusion(decks, clustering(clusters), records, settings);
    const scattered = analysis.cards.find((card) => card.definitionId === 'scattered');
    expect(scattered?.deckInclusionShare).toBeCloseTo(4 / 12, 3);
    // 1/3 within each cluster is below the 50% coverage threshold everywhere.
    expect(scattered?.coveredClusters).toBe(0);
    expect(scattered?.qualifies).toBe(false);
  });

  it('excludes tiny and rarely-observed clusters from the denominator', () => {
    const { decks, clustering: groups, records } = fixture();
    const tiny = deck('tiny_0', ['generic']);
    const withTiny = clustering([...groups.clusters, cluster('tiny', [tiny], 1)]);

    const analysis = analyzeInclusion([...decks, tiny], withTiny, records, settings);
    // Five clusters exist, but the one-deck cluster is not a strategy.
    expect(analysis.eligibleClusters).toBe(4);
    expect(analysis.ineligibleClusters).toBe(1);
    const entry = analysis.cards
      .find((card) => card.definitionId === 'generic')
      ?.perCluster.find((item) => item.clusterId === 'tiny');
    expect(entry?.eligible).toBe(false);
    expect(entry?.ineligibleReason).toMatch(/minDecksPerCluster/);
    expect(entry?.covered).toBe(false);
  });

  it('excludes a cluster that met the deck minimum but not the observation minimum', () => {
    const { decks, clustering: groups, records } = fixture();
    // Three decks, but almost no games played: not enough to weigh equally.
    const quiet = [0, 1, 2].map((n) => deck(`quiet_${n}`, ['generic']));
    const withQuiet = clustering([...groups.clusters, cluster('quiet', quiet, 1)]);

    const analysis = analyzeInclusion([...decks, ...quiet], withQuiet, records, settings);
    const entry = analysis.cards
      .find((card) => card.definitionId === 'generic')
      ?.perCluster.find((item) => item.clusterId === 'quiet');
    expect(entry?.decksInCluster).toBe(3);
    expect(entry?.observations).toBe(0);
    expect(entry?.eligible).toBe(false);
    expect(entry?.ineligibleReason).toMatch(/minObservationsPerCluster/);
  });

  it('changes its answer when crossClusterShare is changed', () => {
    const { decks, clustering: groups, records } = fixture();
    const strict = analyzeInclusion(decks, groups, records, {
      ...settings,
      crossClusterShare: 0.9,
    });
    const lenient = analyzeInclusion(decks, groups, records, {
      ...settings,
      crossClusterShare: 0.5,
    });
    expect(strict.cards.find((card) => card.definitionId === 'generic')?.qualifies).toBe(false);
    expect(lenient.cards.find((card) => card.definitionId === 'generic')?.qualifies).toBe(true);
  });

  it('keeps deck-level inclusion as a separate, differently named metric', () => {
    const { decks, clustering: groups, records } = fixture();
    const analysis = analyzeInclusion(decks, groups, records, settings);
    const generic = analysis.cards.find((card) => card.definitionId === 'generic');
    // 9 of 12 decks run it, which is *not* the cross-cluster share of 3/4.
    expect(generic?.deckInclusionShare).toBe(0.75);
    expect(generic?.crossClusterShare).toBe(0.75);
    const strict = analyzeInclusion(decks, groups, records, {
      ...settings,
      withinClusterInclusionThreshold: 1.1,
    });
    // Raising the within-cluster bar past reach drops coverage to zero while the
    // deck share is untouched: two independent numbers, as required.
    const under = strict.cards.find((card) => card.definitionId === 'generic');
    expect(under?.deckInclusionShare).toBe(0.75);
    expect(under?.crossClusterShare).toBe(0);
  });

  it('says a review signal about opportunity cost, never that the card is unhealthy', () => {
    const { decks, clustering: groups, records } = fixture();
    const analysis = analyzeInclusion(decks, groups, records, settings);
    const flags = computeFlags({
      aggregate: aggregate(records),
      clustering: groups,
      pairs: [],
      replacements: [],
      settings,
      inclusion: analysis,
    });
    const flag = flags.find((entry) => entry.reason === 'broad_cross_cluster_inclusion');
    expect(flag).toBeDefined();
    expect(flag?.subject).toBe('generic');
    expect(flag?.message).toMatch(/low opportunity cost|generic utility/i);
    expect(flag?.message).not.toMatch(/overpowered|broken|unbalanced/i);
    // The qualifying clusters and their individual inclusion values are evidence.
    expect(
      Object.keys(flag?.evidence ?? {}).filter((key) => key.startsWith('cluster_')),
    ).toHaveLength(3);
  });
});

/* ------------------------------------------------------- §11: displacement */

describe('displacement requires normalized, replicated evidence', () => {
  const settings: AnalysisSettings = {
    ...DEFAULT_ANALYSIS_SETTINGS,
    minDisplacementReplicates: 2,
    minDecksPerReplicate: 8,
    displacementShareDrop: 0.5,
  };

  function replicate(label: string, withCard: number, total: number): DisplacementReplicate {
    return {
      label,
      decks: Array.from({ length: total }, (_, index) =>
        deck(`${label}_${index}`, index < withCard ? ['victim', 'filler'] : ['filler']),
      ),
    };
  }

  it('refuses to call a single-run change displacement', () => {
    // The exact shape of the audited defect: 6 → 3 from two one-off archives.
    const result = analyzeDisplacement({
      baseline: [replicate('b0', 6, 12)],
      candidate: [replicate('c0', 3, 12)],
      changedCardIds: [],
      candidatePoolCardIds: ['victim', 'filler'],
      settings,
    });
    const victim = result.find((entry) => entry.definitionId === 'victim');
    expect(victim?.status).toBe('insufficient_evidence');
    expect(victim?.note).toMatch(/replicate/i);
  });

  it('reports a stable, replicated drop as a review signal', () => {
    const result = analyzeDisplacement({
      baseline: [replicate('b0', 10, 12), replicate('b1', 10, 12)],
      candidate: [replicate('c0', 1, 12), replicate('c1', 1, 12)],
      changedCardIds: [],
      candidatePoolCardIds: ['victim', 'filler'],
      settings,
    });
    const victim = result.find((entry) => entry.definitionId === 'victim');
    expect(victim?.status).toBe('displaced');
    // Shares, not counts.
    expect(victim?.baselineMeanShare).toBeCloseTo(10 / 12, 3);
    expect(victim?.candidateMeanShare).toBeCloseTo(1 / 12, 3);
    expect(victim?.replicates).toBe(2);
    expect(victim?.note).toMatch(/review signal/i);
    // Even the confirmed case refuses the word: §11 forbids the default report
    // describing an archive change as confirmed obsolescence.
    expect(victim?.note).toMatch(/not a statement that the card is obsolete/i);
  });

  it('will not call a drop smaller than the search’s own variance displacement', () => {
    // A relative drop of 83% — comfortably past the threshold — but the two
    // baseline replicates disagree with each other by more than the drop itself,
    // so the change is inside the search's own noise.
    const result = analyzeDisplacement({
      baseline: [replicate('b0', 12, 12), replicate('b1', 0, 12)],
      candidate: [replicate('c0', 2, 12), replicate('c1', 0, 12)],
      changedCardIds: [],
      candidatePoolCardIds: ['victim', 'filler'],
      settings,
    });
    const victim = result.find((entry) => entry.definitionId === 'victim');
    expect(victim?.relativeDrop).toBeGreaterThan(settings.displacementShareDrop);
    expect(victim?.status).toBe('insufficient_evidence');
    expect(victim?.note).toMatch(/noise|variance/i);
    expect(victim?.betweenReplicateVariation).toBeGreaterThan(Math.abs(victim?.shareDelta ?? 0));
  });

  it('separates a card removed from the pool from one that was out-competed', () => {
    const result = analyzeDisplacement({
      baseline: [replicate('b0', 10, 12), replicate('b1', 10, 12)],
      candidate: [replicate('c0', 0, 12), replicate('c1', 0, 12)],
      changedCardIds: [],
      // `victim` is no longer legal in the candidate pool.
      candidatePoolCardIds: ['filler'],
      settings,
    });
    const victim = result.find((entry) => entry.definitionId === 'victim');
    expect(victim?.status).toBe('pool_removal');
    expect(victim?.removedFromPool).toBe(true);
    expect(victim?.note).toMatch(/not displacement/i);
  });

  it('requires enough decks per replicate before claiming anything', () => {
    const result = analyzeDisplacement({
      baseline: [replicate('b0', 4, 4), replicate('b1', 4, 4)],
      candidate: [replicate('c0', 0, 4), replicate('c1', 0, 4)],
      changedCardIds: [],
      candidatePoolCardIds: ['victim', 'filler'],
      settings,
    });
    expect(result.find((entry) => entry.definitionId === 'victim')?.status).toBe(
      'insufficient_evidence',
    );
  });

  it('names what gained share in the displaced card’s place', () => {
    const baseline = [0, 1].map((n) => ({
      label: `b${n}`,
      decks: Array.from({ length: 12 }, (_, index) =>
        deck(`b${n}_${index}`, index < 10 ? ['victim'] : ['other']),
      ),
    }));
    const candidate = [0, 1].map((n) => ({
      label: `c${n}`,
      decks: Array.from({ length: 12 }, (_, index) =>
        deck(`c${n}_${index}`, index < 10 ? ['successor'] : ['other']),
      ),
    }));

    const result = analyzeDisplacement({
      baseline,
      candidate,
      changedCardIds: [],
      candidatePoolCardIds: ['victim', 'successor', 'other'],
      settings,
    });
    const victim = result.find((entry) => entry.definitionId === 'victim');
    expect(victim?.status).toBe('displaced');
    expect(victim?.likelyReplacedBy.map((entry) => entry.definitionId)).toContain('successor');
  });

  it('never treats the changed card itself as displaced', () => {
    const result = analyzeDisplacement({
      baseline: [replicate('b0', 10, 12), replicate('b1', 10, 12)],
      candidate: [replicate('c0', 0, 12), replicate('c1', 0, 12)],
      changedCardIds: ['victim'],
      candidatePoolCardIds: ['victim', 'filler'],
      settings,
    });
    expect(result.some((entry) => entry.definitionId === 'victim')).toBe(false);
  });
});

/* ------------------------------------------ §10.1: opponent-field sensitivity */

describe('opponent-field sensitivity is computed, not merely declared', () => {
  const settings: AnalysisSettings = {
    ...DEFAULT_ANALYSIS_SETTINGS,
    minMatchesPerOpponentField: 10,
    minOpponentFields: 2,
    opponentFieldSpread: 0.2,
  };

  /** `subject` faces two fields with deliberately different win rates. */
  function fixture(winsVersusA: number, winsVersusB: number, games = 20) {
    const subject = deck('subject', ['probe']);
    const fieldA = deck('field_a', ['a_card']);
    const fieldB = deck('field_b', ['b_card']);
    const groups = clustering([
      cluster('subject', [subject], games * 2),
      cluster('field_a', [fieldA], games),
      cluster('field_b', [fieldB], games),
    ]);

    const records: MatchRecord[] = [];
    for (const [field, wins] of [
      [fieldA, winsVersusA],
      [fieldB, winsVersusB],
    ] as const) {
      for (let game = 0; game < games; game += 1) {
        records.push(
          record({
            matchId: `m_${field.id}_${game}`,
            gameIndex: game,
            seats: [
              {
                playerId: 'player_1',
                deckId: subject.id,
                deckHash: subject.hash,
                seatIndex: 0,
                won: game < wins,
                cards: ['probe'],
              },
              {
                playerId: 'player_2',
                deckId: field.id,
                deckHash: field.hash,
                seatIndex: 1,
                won: game >= wins,
                cards: [field.cards[0]?.cardId ?? 'x'],
              },
            ],
          }),
        );
      }
    }
    return { clustering: groups, records };
  }

  it('flags a card whose results depend heavily on the field it faced', () => {
    const { clustering: groups, records } = fixture(20, 0);
    const [probe] = opponentFieldSensitivity({ records, clustering: groups, settings }).filter(
      (entry) => entry.subject === 'probe',
    );
    expect(probe?.status).toBe('sensitive');
    expect(probe?.fields).toHaveLength(2);
    expect(probe?.spread).toBe(1);
    expect(probe?.separated).toBe(true);
    expect(probe?.best?.opponentClusterId).toBe('field_a');
    expect(probe?.worst?.opponentClusterId).toBe('field_b');
    // Context sensitivity is described, never called a defect.
    expect(probe?.note).toMatch(/context sensitivity/i);
    expect(probe?.note).not.toMatch(/broken|overpowered/i);
  });

  it('calls a card with the same results everywhere consistent', () => {
    const { clustering: groups, records } = fixture(10, 10);
    const [probe] = opponentFieldSensitivity({ records, clustering: groups, settings }).filter(
      (entry) => entry.subject === 'probe',
    );
    expect(probe?.status).toBe('consistent');
    expect(probe?.spread).toBe(0);
  });

  it('drops a field that did not reach the minimum and says nothing on one field', () => {
    const { clustering: groups, records } = fixture(20, 0, 5);
    const [probe] = opponentFieldSensitivity({ records, clustering: groups, settings }).filter(
      (entry) => entry.subject === 'probe',
    );
    expect(probe?.status).toBe('insufficient_evidence');
    expect(probe?.fields).toHaveLength(0);
    expect(probe?.droppedFields).toHaveLength(2);
    expect(probe?.note).toMatch(/No statement is made/i);
  });

  it('raises the reason code that used to exist with nothing behind it', () => {
    expect(FLAG_REASONS).toContain('opponent_field_sensitivity');
    const { clustering: groups, records } = fixture(20, 0);
    const sensitivity = opponentFieldSensitivity({ records, clustering: groups, settings });
    const flags = computeFlags({
      aggregate: aggregate(records),
      clustering: groups,
      pairs: [],
      replacements: [],
      settings,
      sensitivity,
    });
    const flag = flags.find((entry) => entry.reason === 'opponent_field_sensitivity');
    expect(flag).toBeDefined();
    expect(flag?.sampleSize).toBeGreaterThan(0);
    expect(flag?.threshold?.name).toBe('opponentFieldSpread');
  });
});

/* -------------------------------------------------- §10.2: counter breadth */

describe('counter breadth never claims a card-level answer from cluster counts', () => {
  const settings = DEFAULT_ANALYSIS_SETTINGS;

  it('reports unavailable when there is no controlled evidence, and not zero', () => {
    const target = deck('target', ['boss']);
    const beater = deck('beater', ['answer']);
    const groups = clustering([cluster('target', [target], 40), cluster('beater', [beater], 40)]);

    const records: MatchRecord[] = Array.from({ length: 40 }, (_, game) =>
      record({
        matchId: `m_${game}`,
        gameIndex: game,
        seats: [
          {
            playerId: 'player_1',
            deckId: beater.id,
            deckHash: beater.hash,
            seatIndex: 0,
            won: true,
            cards: ['answer'],
          },
          {
            playerId: 'player_2',
            deckId: target.id,
            deckHash: target.hash,
            seatIndex: 1,
            won: false,
            cards: ['boss'],
          },
        ],
      }),
    );

    const result = counterBreadth({
      records,
      clustering: groups,
      settings,
      seed: 'counters',
      targetDeckHashes: [target.hash],
      targetLabel: 'the boss deck',
    });

    // A whole cluster beats the target — and that is still not an answer.
    expect(result.clusterMatchupBreadth).toBe(1);
    expect(result.clustersBeatingTarget).toEqual(['beater']);
    expect(result.status).toBe('unavailable');
    // Deliberately null rather than 0: "not measured" is not "measured none".
    expect(result.counterBreadth).toBeNull();
    expect(result.broadAnswers).toBeNull();
    expect(result.note).toMatch(/about strategies, not about which card/i);
  });

  it('keeps cluster matchup breadth under its own honest name in the flag', () => {
    const target = deck('target', ['boss']);
    const groups = clustering([cluster('target', [target], 40)]);
    const result = counterBreadth({
      records: [],
      clustering: groups,
      settings,
      seed: 'counters',
      targetDeckHashes: [target.hash],
    });
    const flags = computeFlags({
      aggregate: aggregate([]),
      clustering: groups,
      pairs: [],
      replacements: [],
      settings,
      counters: result,
    });
    const flag = flags.find((entry) => entry.reason === 'single_narrow_counter');
    expect(flag?.level).toBe('insufficient_data');
    expect(flag?.evidence.counterBreadth).toBe('unavailable');
    expect(flag?.evidence).toHaveProperty('clusterMatchupBreadth');
  });
});

/* ----------------------------------------------------- §10.3: robustness */

describe('pilot robustness keeps the arms apart', () => {
  const settings: AnalysisSettings = {
    ...DEFAULT_ANALYSIS_SETTINGS,
    pilotRobustnessAgreement: 0.75,
  };

  /**
   * A profile only counts towards agreement if it produced a usable sample, so
   * each arm carries a real (if tiny) set of records rather than an empty one.
   */
  const armRecords = (profileId: string): MatchRecord[] =>
    Array.from({ length: 10 }, (_, game) =>
      record({
        matchId: `m_${profileId}_${game}`,
        gameIndex: game,
        seats: [
          {
            playerId: 'player_1',
            deckId: 'd',
            deckHash: 'h',
            seatIndex: 0,
            won: game % 2 === 0,
            cards: ['x'],
          },
        ],
      }),
    );

  function arm(profileId: string, subjects: readonly string[], ranking: readonly string[]) {
    const groups = clustering(
      ranking.map((id, index) => cluster(id, [deck(id, ['x'])], 10 + index)),
    );
    return {
      profileId,
      aggregate: aggregate(armRecords(profileId)),
      clustering: {
        ...groups,
        clusters: ranking.map((id, index) => ({
          ...(groups.clusters[index] as Cluster),
          id,
          winRate: {
            point: 1 - index * 0.1,
            low: 0.9 - index * 0.1,
            high: 1 - index * 0.1,
            successes: 1,
            total: 10,
            margin: 0.1,
          },
        })),
      },
      flags: subjects.map((subject) => ({
        level: 'review_recommended' as const,
        reason: 'high_inclusion_win_rate_lift' as const,
        subject,
        message: '',
        evidence: {},
        sampleSize: 100,
        interval: null,
        threshold: null,
      })),
    };
  }

  it('calls a conclusion stable when the perturbed profiles agree', () => {
    const report = analyzeRobustness(
      [
        arm('published', ['card_a'], ['c1', 'c2', 'c3']),
        arm('combat_forward', ['card_a'], ['c1', 'c2', 'c3']),
        arm('combat_cautious', ['card_a'], ['c1', 'c2', 'c3']),
        arm('card_advantage', ['card_a'], ['c1', 'c2', 'c3']),
      ],
      settings,
    );
    const conclusion = report.conclusions.find((entry) => entry.kind === 'card_flag');
    expect(conclusion?.status).toBe('stable');
    expect(conclusion?.agreement).toBe(1);
    expect(report.profileVersion).toBeTruthy();
  });

  it('calls a conclusion pilot-sensitive when they do not', () => {
    const report = analyzeRobustness(
      [
        arm('published', ['card_a'], ['c1', 'c2', 'c3']),
        arm('combat_forward', [], ['c1', 'c2', 'c3']),
        arm('combat_cautious', [], ['c1', 'c2', 'c3']),
        arm('card_advantage', ['card_a'], ['c1', 'c2', 'c3']),
      ],
      settings,
    );
    const conclusion = report.conclusions.find((entry) => entry.kind === 'card_flag');
    expect(conclusion?.status).toBe('pilot_sensitive');
    expect(conclusion?.disagreeingProfiles.sort()).toEqual(['combat_cautious', 'combat_forward']);
    expect(conclusion?.note).toMatch(/depends on how the pilot is tuned/i);
  });

  it('reports each profile separately rather than pooling them', () => {
    const report = analyzeRobustness(
      [arm('published', ['a'], ['c1', 'c2']), arm('combat_forward', ['b'], ['c2', 'c1'])],
      settings,
    );
    expect(report.arms.map((entry) => entry.profileId)).toEqual(['published', 'combat_forward']);
    expect(report.note).toMatch(/never pooled/i);
    // A reversed ranking is total disagreement, and must be visible as such.
    expect(report.clusterRankAgreement[0]?.agreement).toBe(0);
  });

  it('is deterministic', () => {
    const arms = [
      arm('published', ['a'], ['c1', 'c2']),
      arm('combat_forward', ['a'], ['c1', 'c2']),
    ];
    expect(JSON.stringify(analyzeRobustness(arms, settings))).toBe(
      JSON.stringify(analyzeRobustness(arms, settings)),
    );
  });
});

/* ---------------------------------------------------------- §9: statistics */

describe('paired analysis', () => {
  it('uses only complete pairs and exposes the exclusions', () => {
    const outcomes = Array.from({ length: 30 }, (_, index) => ({
      key: `k${index}`,
      baselineWon: index % 2 === 0,
      candidateWon: index % 3 !== 0,
      stratum: `pilot|${index % 2}`,
    }));
    const result = pairedBinary(outcomes, {
      seed: 'paired',
      minPairs: 10,
      iterations: 300,
      excluded: { no_matching_game_in_other_arm: 4 },
    });
    expect(result.pairs).toBe(30);
    expect(result.excludedPairs).toBe(4);
    expect(result.exclusionReasons.no_matching_game_in_other_arm).toBe(4);
    expect(result.candidateOnlyWins + result.baselineOnlyWins + result.concordantPairs).toBe(30);
    expect(result.insufficientEvidence).toBe(false);
  });

  it('marks an underpowered pair count as insufficient rather than reporting it', () => {
    const result = pairedBinary([{ key: 'a', baselineWon: false, candidateWon: true }], {
      seed: 'paired',
      minPairs: 20,
      iterations: 100,
    });
    expect(result.pairs).toBe(1);
    expect(result.insufficientEvidence).toBe(true);
  });

  it('produces a tighter interval than an independent estimate on correlated data', () => {
    // Perfectly correlated arms differing on a handful of pairs: the paired
    // design knows almost everything, and its interval must show that.
    const outcomes = Array.from({ length: 200 }, (_, index) => ({
      key: `k${String(index).padStart(3, '0')}`,
      baselineWon: index % 2 === 0,
      candidateWon: index % 2 === 0 || index < 10,
      stratum: 'one',
    }));
    const paired = pairedBinary(outcomes, { seed: 'tight', minPairs: 20, iterations: 800 });
    expect(paired.candidateOnlyWins).toBe(5);
    expect(paired.baselineOnlyWins).toBe(0);
    // Two independent samples of 200 at ~50% each carry a margin around ±0.10 on
    // the difference; the paired estimate of the same data is far narrower.
    expect(paired.high - paired.low).toBeLessThan(0.08);
  });

  it('uses the within-pair differences for a continuous outcome', () => {
    const observations = Array.from({ length: 40 }, (_, index) => ({
      baseline: 20 + (index % 7),
      candidate: 22 + (index % 7),
    }));
    const result = pairedMean(observations, { confidence: 0.95, minPairs: 20 });
    expect(result.meanDifference).toBe(2);
    // Every pair differs by exactly two, so the paired interval collapses onto
    // it. An independent-sample interval over two spread-out piles could not.
    expect(result.low).toBe(2);
    expect(result.high).toBe(2);
    expect(result.method).toMatch(/paired/i);
  });

  it('adjusts p-values without discarding the unadjusted ones', () => {
    const raw = [0.001, 0.01, 0.04, 0.2, 0.6];
    const adjusted = benjaminiHochberg(raw);
    expect(adjusted).toHaveLength(raw.length);
    for (const [index, value] of adjusted.entries()) {
      expect(value).toBeGreaterThanOrEqual(raw[index] as number);
      expect(value).toBeLessThanOrEqual(1);
    }
    // Monotone in the input order used here, which is already sorted.
    expect(adjusted[0]).toBeLessThanOrEqual(adjusted[4] as number);
  });
});

describe('card-pair synergy uncertainty', () => {
  /**
   * A four-cell fixture with a deliberately large interaction: A alone and B
   * alone are mediocre, and together they win everything.
   */
  function synergyRecords(count: number): MatchRecord[] {
    const combos: [string[], number][] = [
      [['a', 'b'], 0.95],
      [['a'], 0.5],
      [['b'], 0.5],
      [[], 0.5],
    ];
    const records: MatchRecord[] = [];
    for (const [cards, rate] of combos) {
      const id = cards.join('') || 'none';
      const owner = deck(`deck_${id}`, cards.length > 0 ? cards : ['filler']);
      for (let game = 0; game < count; game += 1) {
        records.push(
          record({
            matchId: `m_${id}_${game}`,
            gameIndex: game,
            seats: [
              {
                playerId: 'player_1',
                deckId: owner.id,
                deckHash: owner.hash,
                seatIndex: game % 2,
                won: game < Math.round(count * rate),
                cards: cards.length > 0 ? cards : ['filler'],
              },
            ],
          }),
        );
      }
    }
    return records;
  }

  it('estimates the difference-in-differences and bounds it away from zero', () => {
    const pairs = cardPairs(synergyRecords(40), {
      minSupport: 10,
      minCellSupport: 10,
      iterations: 600,
      seed: 'synergy',
    });
    const pair = pairs.find((entry) => entry.cardA === 'a' && entry.cardB === 'b');
    expect(pair).toBeDefined();
    expect(pair?.insufficientEvidence).toBe(false);
    expect(pair?.interaction).toBeCloseTo(0.45, 1);
    expect(pair?.low).toBeGreaterThan(0);
    expect(pair?.strata).toBeGreaterThan(0);
  });

  it('returns insufficient evidence when any contributing cell is sparse', () => {
    const records = synergyRecords(40).filter(
      // Strip almost all of the "neither" cell: the baseline group of the contrast.
      (entry, index) => !entry.matchId.startsWith('m_none_') || index % 20 === 0,
    );
    const pairs = cardPairs(records, {
      minSupport: 10,
      minCellSupport: 10,
      iterations: 200,
      seed: 'synergy',
    });
    const pair = pairs.find((entry) => entry.cardA === 'a' && entry.cardB === 'b');
    expect(pair?.insufficientEvidence).toBe(true);
    expect(pair?.sparseCells).toContain('neither');
    expect(Number.isFinite(pair?.low ?? Number.NaN)).toBe(false);
  });

  it('widens as the contributing cells get noisier', () => {
    const tight = cardPairs(synergyRecords(120), {
      minSupport: 10,
      minCellSupport: 10,
      iterations: 600,
      seed: 'synergy',
    }).find((entry) => entry.cardA === 'a' && entry.cardB === 'b');
    const loose = cardPairs(synergyRecords(20), {
      minSupport: 10,
      minCellSupport: 10,
      iterations: 600,
      seed: 'synergy',
    }).find((entry) => entry.cardA === 'a' && entry.cardB === 'b');

    expect(tight).toBeDefined();
    expect(loose).toBeDefined();
    const width = (entry: { low: number; high: number }) => entry.high - entry.low;
    expect(width(tight!)).toBeLessThan(width(loose!));
  });
});
