import { describe, expect, it } from 'vitest';
import { makeDeck, type SimDeck } from '@tcg/deck-generator';
import { tinyEnvironment, VALUE_PILOT } from '../test-fixtures.js';
import {
  adaptiveRevisionSeedPath,
  makeAdaptiveRevision,
  type AdaptiveRevision,
} from './revision.js';
import type { AdaptiveConfig } from './config.js';
import {
  scheduleAdaptiveCandidateScreening,
  type AdaptiveCandidateScreening,
  type AdaptiveCandidateScreeningInput,
  type AdaptiveScreeningTallies,
  type AdaptiveScreeningTally,
} from './evaluate.js';
import {
  adaptivePromotionScore,
  decideAdaptivePromotion,
  tallyAdaptiveSeries,
  type AdaptiveCandidateEvidence,
  type AdaptiveSeriesEntry,
} from './promote.js';

/**
 * M08.17C: deciding, from finished screening evidence, which candidate (if
 * any) is promoted — and refusing to decide at all when a candidate's
 * evidence was collected against an opponent revision that has since moved.
 * `AdaptiveSeriesTally` is exercised separately to prove it never reads
 * candidate-screening evidence (`./promote.ts` top-of-file comment).
 */

const environment = tinyEnvironment();

function deck(label: string, extra = 0): SimDeck {
  return makeDeck({
    id: label,
    label,
    commanderId: 'prototype_commander_blue',
    cards: [
      { cardId: 'prototype_scout', quantity: 2 + extra },
      { cardId: 'prototype_guard', quantity: 2 },
    ],
  });
}

function revision(label: string, revisionDeck: SimDeck, generation = 0): AdaptiveRevision {
  return makeAdaptiveRevision({
    experimentId: 'promote-test',
    parentRevisionId: null,
    generation,
    block: 0,
    opponentRevisionId: null,
    construction: 'root',
    seedPath: adaptiveRevisionSeedPath(
      `promote-fixture-seed-${label}`,
      'promote-test',
      generation,
      0,
    ),
    deck: revisionDeck,
  });
}

function baseConfig(overrides: Partial<AdaptiveConfig> = {}): AdaptiveConfig {
  return {
    schemaVersion: 1,
    id: 'promote-test',
    label: '',
    seed: 'promote-fixture-seed',
    output: 'results',
    environment: environment.config,
    startingDecks: { kind: 'precon', preconIds: ['some_precon'] },
    commanderPolicy: 'locked',
    selectedCommanderIds: [],
    informationPolicy: 'public_observation',
    totalLearningBudget: 1000,
    blockSize: 20,
    mirrorSeats: true,
    candidateCount: 6,
    swapBound: { minCards: 1, maxCards: 3 },
    rebuildTrigger: null,
    referenceFieldShare: 0,
    retention: { replaySampleRate: 50, keepLogs: false, keepDecisions: false },
    finalValidationGames: 50,
    ...overrides,
  };
}

/** Builds a real screening (correct `opponentDeckHash`) against `opponentDeck` for `candidate`. */
function screeningFor(
  candidate: AdaptiveRevision,
  opponentDeck: SimDeck,
  overrides: Partial<AdaptiveCandidateScreeningInput> = {},
): AdaptiveCandidateScreening {
  return scheduleAdaptiveCandidateScreening({
    environment,
    config: baseConfig({ blockSize: 4, mirrorSeats: false, referenceFieldShare: 0 }),
    candidate,
    block: 0,
    opponentDeck,
    referenceField: [],
    pilots: [VALUE_PILOT],
    ...overrides,
  });
}

function tally(candidateWins: number, opponentWins: number, noResult = 0): AdaptiveScreeningTally {
  return { candidateWins, opponentWins, noResult };
}

function evidenceFor(
  candidate: AdaptiveRevision,
  opponentDeck: SimDeck,
  opponent: AdaptiveScreeningTally,
  field: AdaptiveScreeningTally | null = null,
): AdaptiveCandidateEvidence {
  const tallies: AdaptiveScreeningTallies = { opponent, field };
  return { candidate, screening: screeningFor(candidate, opponentDeck), tallies };
}

describe('tallyAdaptiveSeries', () => {
  function entry(
    decision: AdaptiveSeriesEntry['decision'],
    generation = 0,
    block = 0,
  ): AdaptiveSeriesEntry {
    return {
      generation,
      block,
      incumbentRevisionId: 'rev_incumbent',
      opponentRevisionId: 'rev_opponent',
      decision,
    };
  }

  it('counts a win for the side that was not named loser', () => {
    const tally = tallyAdaptiveSeries([
      entry({ kind: 'win', loser: 'incumbent' }),
      entry({ kind: 'win', loser: 'opponent' }, 1),
      entry({ kind: 'win', loser: 'opponent' }, 2),
    ]);
    expect(tally).toEqual({ incumbentWins: 2, opponentWins: 1, ties: 0, noDecisions: 0 });
  });

  it('counts ties and no-decisions without crediting either side a win', () => {
    const tally = tallyAdaptiveSeries([
      entry({ kind: 'tie' }),
      entry({ kind: 'no_decision', reason: 'no game was scheduled for this block' }, 1),
    ]);
    expect(tally).toEqual({ incumbentWins: 0, opponentWins: 0, ties: 1, noDecisions: 1 });
  });

  it('is order-independent', () => {
    const entries = [
      entry({ kind: 'win', loser: 'incumbent' }),
      entry({ kind: 'tie' }, 1),
      entry({ kind: 'win', loser: 'opponent' }, 2),
    ];
    expect(tallyAdaptiveSeries(entries)).toEqual(tallyAdaptiveSeries([...entries].reverse()));
  });

  it('returns an all-zero tally for an empty series', () => {
    expect(tallyAdaptiveSeries([])).toEqual({
      incumbentWins: 0,
      opponentWins: 0,
      ties: 0,
      noDecisions: 0,
    });
  });
});

describe('adaptivePromotionScore', () => {
  const candidate = revision('candidate', deck('candidate'));
  const opponentDeck = deck('opponent', 10);

  it('reads only the opponent group under pure_counter, even with a field tally present', () => {
    const evidence = evidenceFor(candidate, opponentDeck, tally(7, 3), tally(0, 5));
    const score = adaptivePromotionScore(evidence);
    expect(score.successes).toBe(7);
    expect(score.total).toBe(10);
  });

  it('combines opponent and field groups into one pool under meta_aware', () => {
    const meta = scheduleAdaptiveCandidateScreening({
      environment,
      config: baseConfig({ blockSize: 4, mirrorSeats: false, referenceFieldShare: 0.5 }),
      candidate,
      block: 0,
      opponentDeck,
      referenceField: [deck('field-a', 1)],
      pilots: [VALUE_PILOT],
    });
    const evidence: AdaptiveCandidateEvidence = {
      candidate,
      screening: meta,
      tallies: { opponent: tally(5, 1), field: tally(2, 0) },
    };
    const score = adaptivePromotionScore(evidence);
    expect(score.successes).toBe(7);
    expect(score.total).toBe(8);
  });

  it('falls back to opponent-only when a meta_aware screening has a null field tally', () => {
    const meta = scheduleAdaptiveCandidateScreening({
      environment,
      config: baseConfig({ blockSize: 4, mirrorSeats: false, referenceFieldShare: 0.5 }),
      candidate,
      block: 0,
      opponentDeck,
      referenceField: [],
      pilots: [VALUE_PILOT],
    });
    expect(meta.objective).toBe('meta_aware');
    const evidence: AdaptiveCandidateEvidence = {
      candidate,
      screening: meta,
      tallies: { opponent: tally(4, 0), field: null },
    };
    const score = adaptivePromotionScore(evidence);
    expect(score.successes).toBe(4);
    expect(score.total).toBe(4);
  });
});

describe('decideAdaptivePromotion', () => {
  const incumbent = revision('incumbent', deck('incumbent'));
  const opponentRevision = revision('opponent', deck('opponent', 10));

  it('promotes the highest-scoring candidate that decisively beat the opponent', () => {
    const weak = revision('weak', deck('weak', 1));
    const strong = revision('strong', deck('strong', 2));
    const candidates = [
      evidenceFor(weak, opponentRevision.deck, tally(3, 2)),
      evidenceFor(strong, opponentRevision.deck, tally(9, 1)),
    ];
    const decision = decideAdaptivePromotion({ incumbent, opponentRevision, candidates });
    expect(decision.kind).toBe('promoted');
    expect(decision.kind === 'promoted' && decision.revision.revisionId).toBe(strong.revisionId);
  });

  it('breaks an exact score tie by revisionId, independent of array order', () => {
    const a = revision('cand-a', deck('cand-a', 1));
    const b = revision('cand-b', deck('cand-b', 2));
    const expectedWinner = [a, b].map((r) => r.revisionId).sort()[0];

    const forward = decideAdaptivePromotion({
      incumbent,
      opponentRevision,
      candidates: [
        evidenceFor(a, opponentRevision.deck, tally(6, 2)),
        evidenceFor(b, opponentRevision.deck, tally(6, 2)),
      ],
    });
    const reversed = decideAdaptivePromotion({
      incumbent,
      opponentRevision,
      candidates: [
        evidenceFor(b, opponentRevision.deck, tally(6, 2)),
        evidenceFor(a, opponentRevision.deck, tally(6, 2)),
      ],
    });
    expect(forward.kind).toBe('promoted');
    expect(reversed.kind).toBe('promoted');
    expect(forward.kind === 'promoted' && forward.revision.revisionId).toBe(expectedWinner);
    expect(reversed.kind === 'promoted' && reversed.revision.revisionId).toBe(expectedWinner);
  });

  it('retains the incumbent when a candidate only ties the opponent', () => {
    const tied = revision('tied', deck('tied', 1));
    const decision = decideAdaptivePromotion({
      incumbent,
      opponentRevision,
      candidates: [evidenceFor(tied, opponentRevision.deck, tally(5, 5))],
    });
    expect(decision.kind).toBe('retained');
    expect(decision.kind === 'retained' && decision.reason).toContain(incumbent.revisionId);
  });

  it('retains the incumbent when no candidates were available at all', () => {
    const decision = decideAdaptivePromotion({ incumbent, opponentRevision, candidates: [] });
    expect(decision.kind).toBe('retained');
    expect(decision.kind === 'retained' && decision.reason).toContain('no candidate was available');
  });

  it('refuses to decide when a candidate was screened against a stale opponent revision', () => {
    const movedOpponentDeck = deck('moved-opponent', 50);
    const stale = revision('stale-candidate', deck('stale-candidate'));
    const decision = decideAdaptivePromotion({
      incumbent,
      opponentRevision,
      // screened against `movedOpponentDeck`, not `opponentRevision.deck`.
      candidates: [evidenceFor(stale, movedOpponentDeck, tally(9, 1))],
    });
    expect(decision.kind).toBe('stale');
    expect(decision.kind === 'stale' && decision.staleRevisionIds).toEqual([stale.revisionId]);
  });

  it('refuses the whole decision if even one of several candidates is stale', () => {
    const fresh = revision('fresh-candidate', deck('fresh-candidate'));
    const stale = revision('stale-candidate-2', deck('stale-candidate-2'));
    const movedOpponentDeck = deck('moved-opponent-2', 50);
    const decision = decideAdaptivePromotion({
      incumbent,
      opponentRevision,
      candidates: [
        evidenceFor(fresh, opponentRevision.deck, tally(9, 1)),
        evidenceFor(stale, movedOpponentDeck, tally(1, 9)),
      ],
    });
    expect(decision.kind).toBe('stale');
    expect(decision.kind === 'stale' && decision.staleRevisionIds).toEqual([stale.revisionId]);
  });
});
