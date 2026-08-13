import { describe, expect, it } from 'vitest';
import { emptyBoardTelemetry } from '@tcg/board-telemetry';
import { EVIDENCE_CLAIMS } from '@tcg/bot-interface';
import { analyzeAgentClasses, agentEvidenceOf } from './analysis/agent-classes.js';
import { analyzeDeckConstruction } from './analysis/construction.js';
import { analyzeCalibration } from './analysis/calibration.js';
import {
  FLAG_CLAIMS,
  FLAG_REASONS,
  agentClassFlags,
  applyAgentClassLimits,
  computeFlags,
  flagClaimGaps,
  type Flag,
} from './analysis/flags.js';
import { aggregate } from './analysis/aggregate.js';
import { clusterDecks } from './analysis/clusters.js';
import { renderReport, type ReportInputs } from './reporting/report.js';
import { analyzeMechanicSupport } from './analysis/support.js';
import { analyzeInclusion } from './analysis/inclusion.js';
import { aggregateBoard } from './analysis/board.js';
import { describeMultiplicity, ANALYSIS_STATS_VERSION } from './analysis/paired.js';
import { DEFAULT_ANALYSIS_SETTINGS } from './config.js';
import { SEED_DERIVATION_VERSION } from './seed.js';
import {
  TELEMETRY_SCHEMA_VERSION,
  matchRecordSchema,
  type MatchRecord,
} from './telemetry/schema.js';
import { tinyEnvironment, fixtureDeck } from './test-fixtures.js';

/**
 * Honest agent classes (M05.4).
 *
 * Three things are under test, and they are the three the milestone asks for:
 * the claims are *encoded* rather than described in prose, a signal resting on a
 * claim the run's pilots cannot make is declined, and two classes that flew the
 * same run are never pooled into one skill distribution.
 */

const env = tinyEnvironment();

const DECK = fixtureDeck('neutral', 'prototype_commander_blue', [
  ['prototype_drone', 2],
  ['prototype_scout', 2],
  ['prototype_guard', 2],
  ['trench_guard', 2],
  ['unstable_construct', 2],
  ['surveyors_lens', 2],
]);

function flag(overrides: Partial<Flag> = {}): Flag {
  return {
    level: 'review_recommended',
    reason: 'high_inclusion_win_rate_lift',
    subject: 'prototype_drone',
    message: 'Decks running it win more.',
    evidence: { lift: 0.2 },
    sampleSize: 200,
    interval: { low: 0.1, high: 0.3 },
    threshold: { name: 'inclusionLift', value: 0.1 },
    ...overrides,
  };
}

/** A schema-valid record whose only meaningful fields are pilot and outcome. */
function record(matchId: string, seats: readonly { pilotId: string; won: boolean }[]): MatchRecord {
  const parsedSeats = seats.map((seat, index) => ({
    playerId: `player_${index + 1}`,
    seatIndex: index,
    deckId: DECK.id,
    deckHash: DECK.hash,
    commanderId: 'prototype_commander_blue',
    colors: ['blue'],
    pilotId: seat.pilotId,
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
    relicsReplaced: 0,
    tokensCreated: 0,
    unitsLost: 1,
    attacksDeclared: 3,
    blocksAssigned: 1,
    abilitiesActivated: 0,
    choicesResolved: 0,
    decisions: 20,
  }));

  return matchRecordSchema.parse({
    schemaVersion: TELEMETRY_SCHEMA_VERSION,
    matchId,
    orderKey: matchId,
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
    gameIndex: 0,
    orientation: 0,
    playerCount: Math.max(2, parsedSeats.length),
    seeds: {
      derivationVersion: 2,
      path: 'fixture',
      matchSeed: 'fixture',
      seatSeed: 'fixture',
      pilotSeeds: parsedSeats.map(() => 'fixture'),
    },
    startingPlayerId: 'player_1',
    outcome: 'win',
    winnerId: parsedSeats.find((seat) => seat.won)?.playerId ?? null,
    termination: 'victory',
    endReason: 'health',
    turns: 10,
    actions: 40,
    decisions: 40,
    events: 80,
    resolutionSteps: 40,
    seats: parsedSeats,
    cards: [],
    board: emptyBoardTelemetry(),
    botFailures: [],
    diagnostics: [],
    replayPath: null,
    softwareCommit: null,
  });
}

describe('classifying the agents that flew a run', () => {
  it('names the class of every configured pilot', () => {
    const analysis = analyzeAgentClasses({ pilotIds: ['value', 'aggressive'] });
    expect(analysis.pilots).toEqual([
      { pilotId: 'aggressive', agentClass: 'generic_heuristic' },
      { pilotId: 'value', agentClass: 'generic_heuristic' },
    ]);
    // Two settings of one instrument, not two classes.
    expect(analysis.classes).toEqual(['generic_heuristic']);
    expect(analysis.mixed).toBe(false);
    expect(analysis.registryVersion).toBeGreaterThan(0);
  });

  it('lets a heuristic run claim play quality and refuses it synergy', () => {
    const analysis = analyzeAgentClasses({ pilotIds: ['value'] });
    expect(analysis.carried).toContain('play_quality');
    expect(analysis.carried).toContain('structural_asymmetry');
    for (const claim of ['synergy', 'sacrifice', 'control', 'combo', 'final_balance'] as const) {
      expect(analysis.carried).not.toContain(claim);
      const declined = analysis.declined.find((entry) => entry.claim === claim);
      expect(declined?.blockedBy).toEqual(['generic_heuristic']);
    }
  });

  it('reports a mixed run as mixed and drops it to its weakest instrument', () => {
    const analysis = analyzeAgentClasses({ pilotIds: ['value', 'random_legal'] });
    expect(analysis.classes).toEqual(['random_legal', 'generic_heuristic']);
    expect(analysis.mixed).toBe(true);
    // The pooled columns elsewhere in the report mix both seats, so the pooled
    // claim is the weaker one. The per-class rows keep the heuristic arm visible.
    expect(analysis.carried).not.toContain('play_quality');
    expect(analysis.carried).toContain('termination');
    expect(analysis.declined.find((entry) => entry.claim === 'play_quality')?.blockedBy).toEqual([
      'random_legal',
    ]);
  });

  it('vouches for nothing when a pilot cannot be classified', () => {
    const analysis = analyzeAgentClasses({ pilotIds: ['value', 'mystery_pilot'] });
    expect(analysis.unclassifiedPilotIds).toEqual(['mystery_pilot']);
    // Harsher than treating it as random-legal on purpose: an unknown pilot is
    // not a weak agent, it is one this build cannot vouch for at all.
    expect(analysis.carried).toEqual([]);
    expect(analysis.declined).toHaveLength(EVIDENCE_CLAIMS.length);
  });

  it('says which classes no pilot in this build implements', () => {
    const analysis = analyzeAgentClasses({ pilotIds: ['value'] });
    expect(analysis.classesWithoutPilots).toEqual(['archetype_aware', 'human_playtest']);
  });
});

describe('every review signal names the claim it rests on', () => {
  it('maps every flag reason, in both directions', () => {
    expect(flagClaimGaps()).toEqual([]);
    for (const reason of FLAG_REASONS) {
      expect(EVIDENCE_CLAIMS).toContain(FLAG_CLAIMS[reason]);
    }
  });

  it('puts the four plan-shaped signals on the plan-shaped claims', () => {
    expect(FLAG_CLAIMS.strong_card_pair).toBe('synergy');
    expect(FLAG_CLAIMS.single_narrow_counter).toBe('control');
    // Seat order is a property of the rules, and mirrored seats make even
    // uniform random play an unbiased probe of it.
    expect(FLAG_CLAIMS.seat_sensitivity).toBe('structural_asymmetry');
  });
});

describe('declining a claim the pilots are not the kind of agent to make', () => {
  const heuristic = agentEvidenceOf(analyzeAgentClasses({ pilotIds: ['value'] }));
  const mixed = agentEvidenceOf(analyzeAgentClasses({ pilotIds: ['value', 'random_legal'] }));
  const random = agentEvidenceOf(analyzeAgentClasses({ pilotIds: ['random_legal'] }));

  it('keeps a play-quality signal a generic heuristic can support', () => {
    const [kept] = applyAgentClassLimits([flag()], heuristic);
    expect(kept?.level).toBe('review_recommended');
  });

  it('downgrades a synergy signal no shipped pilot can support', () => {
    const [downgraded] = applyAgentClassLimits(
      [flag({ reason: 'strong_card_pair', level: 'possible_interaction', subject: 'a+b' })],
      heuristic,
    );
    expect(downgraded?.level).toBe('insufficient_data');
    expect(downgraded?.message).toMatch(/cannot support a "synergy" claim/);
    expect(downgraded?.evidence.agentClassDowngraded).toBe(true);
    expect(downgraded?.evidence.requiredClaim).toBe('synergy');
    // The evidence survives the downgrade, exactly as it does for M05.1.
    expect(downgraded?.sampleSize).toBe(200);
    expect(downgraded?.interval).toEqual({ low: 0.1, high: 0.3 });
  });

  it('downgrades play quality in a mixed run, because the numbers pool the seats', () => {
    const [downgraded] = applyAgentClassLimits([flag()], mixed);
    expect(downgraded?.level).toBe('insufficient_data');
    expect(downgraded?.message).toMatch(/random-legal/);
  });

  it('keeps seat sensitivity in a random-legal run', () => {
    const [kept] = applyAgentClassLimits(
      [flag({ reason: 'seat_sensitivity', subject: 'run' })],
      random,
    );
    expect(kept?.level).toBe('review_recommended');
  });

  it('withdraws everything when a pilot cannot be classified', () => {
    const unknown = agentEvidenceOf(analyzeAgentClasses({ pilotIds: ['mystery_pilot'] }));
    const [downgraded] = applyAgentClassLimits([flag()], unknown);
    expect(downgraded?.level).toBe('insufficient_data');
    expect(downgraded?.message).toMatch(/cannot classify/);
  });

  it('leaves run-quality flags alone, because they are not balance claims', () => {
    const quality = flag({ level: 'run_quality', reason: 'abnormal_terminations', subject: 'run' });
    expect(applyAgentClassLimits([quality], random)).toEqual([quality]);
  });

  it('raises the class note even when nothing was downgraded', () => {
    const [note] = agentClassFlags(heuristic, 40);
    expect(note?.level).toBe('run_quality');
    expect(note?.reason).toBe('agent_class_evidence');
    expect(note?.evidence.agentClasses).toBe('generic_heuristic');
    expect(note?.evidence.mixedClasses).toBe(false);
    expect(String(note?.evidence.carriedClaims)).toContain('play_quality');
    expect(String(note?.evidence.declinedClaims)).toContain('synergy');
    expect(note?.sampleSize).toBe(40);
  });

  it('says out loud when more than one class flew', () => {
    const [note] = agentClassFlags(mixed, 40);
    expect(note?.evidence.mixedClasses).toBe(true);
    expect(note?.message).toMatch(/never averaged into one skill distribution/);
  });
});

describe('computeFlags', () => {
  it('applies the class limit after every flag has been computed', () => {
    const flags = computeFlags({
      aggregate: aggregate([], { confidence: DEFAULT_ANALYSIS_SETTINGS.confidence }),
      clustering: clusterDecks([DECK], env.database, [], {
        confidence: DEFAULT_ANALYSIS_SETTINGS.confidence,
      }),
      pairs: [],
      replacements: [],
      settings: DEFAULT_ANALYSIS_SETTINGS,
      agentEvidence: agentEvidenceOf(analyzeAgentClasses({ pilotIds: ['random_legal'] })),
      deckCount: 1,
    });
    expect(flags.map((entry) => entry.reason)).toContain('agent_class_evidence');
    expect(flags.every((entry) => entry.level !== 'review_recommended')).toBe(true);
  });

  it('is a no-op for a caller that names no pilots', () => {
    const flags = computeFlags({
      aggregate: aggregate([], { confidence: DEFAULT_ANALYSIS_SETTINGS.confidence }),
      clustering: clusterDecks([DECK], env.database, [], {
        confidence: DEFAULT_ANALYSIS_SETTINGS.confidence,
      }),
      pairs: [],
      replacements: [],
      settings: DEFAULT_ANALYSIS_SETTINGS,
      deckCount: 1,
    });
    expect(flags.map((entry) => entry.reason)).not.toContain('agent_class_evidence');
  });
});

describe('win rates are reported per class and never pooled', () => {
  const records = [
    record('m_1', [
      { pilotId: 'value', won: true },
      { pilotId: 'random_legal', won: false },
    ]),
    record('m_2', [
      { pilotId: 'value', won: true },
      { pilotId: 'random_legal', won: false },
    ]),
    record('m_3', [
      { pilotId: 'aggressive', won: false },
      { pilotId: 'random_legal', won: true },
    ]),
  ];

  it('keeps the two instruments in separate rows', () => {
    const summary = aggregate(records).run;
    const byClass = new Map(summary.agentClassWinRates.map((row) => [row.agentClass, row]));

    // Two pilots of one class share a row; two classes never do.
    expect(byClass.get('generic_heuristic')?.pilotIds).toEqual(['aggressive', 'value']);
    expect(byClass.get('generic_heuristic')?.rate.total).toBe(3);
    expect(byClass.get('generic_heuristic')?.rate.successes).toBe(2);
    expect(byClass.get('random_legal')?.rate.total).toBe(3);
    expect(byClass.get('random_legal')?.rate.successes).toBe(1);
    // Nothing averages the two: the rows sum to the seat-matches and no more.
    expect(summary.agentClassWinRates).toHaveLength(2);
    expect(summary.pilotWinRates).toHaveLength(3);
  });

  it('buckets a pilot this build does not know apart from the rest', () => {
    const summary = aggregate([
      record('m_x', [
        { pilotId: 'value', won: true },
        { pilotId: 'mystery_pilot', won: false },
      ]),
    ]).run;
    const classes = summary.agentClassWinRates.map((row) => row.agentClass);
    expect(classes).toContain('unclassified');
    expect(classes).toContain('generic_heuristic');
  });
});

describe('the report', () => {
  function reportFor(pilotIds: readonly string[], records: readonly MatchRecord[]): string {
    const summary = aggregate(records);
    const clusters = clusterDecks([DECK], env.database, records);
    const inputs: ReportInputs = {
      title: 'Agent class fixture',
      experimentId: 'agent_classes',
      kind: 'batch',
      seed: 'seed',
      configHash: 'agent-class-test',
      softwareCommit: null,
      rulesVersion: env.rulesConfig.version,
      seedDerivationVersion: SEED_DERIVATION_VERSION,
      telemetrySchemaVersion: TELEMETRY_SCHEMA_VERSION,
      analysisStatsVersion: ANALYSIS_STATS_VERSION,
      environmentSummaries: [
        { id: env.id, hash: env.hash, cardPoolHash: env.cardPoolHash, label: env.label },
      ],
      settings: DEFAULT_ANALYSIS_SETTINGS,
      aggregate: summary,
      board: aggregateBoard(records),
      mechanicSupport: analyzeMechanicSupport({
        decks: [DECK],
        database: env.database,
        pilotIds,
      }),
      agentClasses: analyzeAgentClasses({ pilotIds }),
      deckConstruction: analyzeDeckConstruction([DECK]),
      calibration: analyzeCalibration({ agentClasses: analyzeAgentClasses({ pilotIds }) }),
      clustering: clusters,
      inclusion: analyzeInclusion([DECK], clusters, records, DEFAULT_ANALYSIS_SETTINGS),
      pairs: [],
      replacements: [],
      sensitivity: [],
      displacement: [],
      multiplicity: describeMultiplicity(0, 0, 0.05),
      flags: [],
      matchesPath: 'matches.jsonl',
      resumedMatches: 0,
      recoveredLines: 0,
      failedMatches: 0,
      abnormalMatches: [],
      deckCount: 1,
      pilots: pilotIds.map((id) => ({ id, version: '1.0.0' })),
      wallClockMs: 1,
      workers: 1,
    };
    return renderReport(inputs);
  }

  it('states the class, what it may be cited for, and what it may not', () => {
    const report = reportFor(['value'], [record('m_1', [{ pilotId: 'value', won: true }])]);
    expect(report).toContain('## Agent classes');
    expect(report).toContain('generic heuristic');
    expect(report).toMatch(/\| `play_quality` \|.*\| \*\*carried\*\* \|/);
    expect(report).toMatch(/\| `synergy` \|.*\| declined —/);
    expect(report).toMatch(/never pooled into one skill distribution/i);
    expect(report).toMatch(/No pilot in this build implements archetype-aware or human playtest/);
  });

  it('prints a row per class and refuses to average them', () => {
    const report = reportFor(
      ['value', 'random_legal'],
      [
        record('m_1', [
          { pilotId: 'value', won: true },
          { pilotId: 'random_legal', won: false },
        ]),
      ],
    );
    expect(report).toContain('**Win rate by agent class.**');
    expect(report).toContain('| generic_heuristic | value |');
    expect(report).toContain('| random_legal | random_legal |');
    expect(report).toMatch(/More than one class flew this run/);
  });

  it('opens with the calibration standing, before any number it could qualify', () => {
    const report = reportFor(['value'], [record('m_1', [{ pilotId: 'value', won: true }])]);
    expect(report).toContain('## Calibration standing');
    expect(report).toContain('**These results are calibration, not a balance verdict.**');
    expect(report).toContain('| Standing | `calibration` |');
    expect(report).toContain('| Classes still missing | `human_playtest` |');
    expect(report).toMatch(/no configuration setting that changes this label/i);
    // Before the limitations, which are before everything else.
    expect(report.indexOf('## Calibration standing')).toBeLessThan(
      report.indexOf('## Limitations, first'),
    );
    expect(report.indexOf('## Calibration standing')).toBeLessThan(
      report.indexOf('## Agent classes'),
    );
  });
});
