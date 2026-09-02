import { describe, expect, it } from 'vitest';
import { makeDeck, type SimDeck } from '@tcg/deck-generator';
import { proportion } from '../analysis/stats.js';
import type { AdaptiveCheckpoint, AdaptiveCheckpointLineage } from './checkpoint.js';
import {
  adaptiveRevisionSeedPath,
  makeAdaptiveRevision,
  type AdaptiveRevision,
} from './revision.js';
import type {
  AdaptiveCandidateScreening,
  AdaptiveObjective,
  AdaptiveScreeningTally,
} from './evaluate.js';
import type { AdaptiveCandidateEvidence } from './promote.js';
import {
  buildAdaptiveResult,
  buildAdaptiveScreeningRound,
  detectAdaptiveCycles,
  finalAdaptiveDeckDiff,
  makeAdaptiveSeriesRecord,
  renderAdaptiveReport,
  summarizeAdaptiveReferenceField,
  type AdaptiveScreeningRound,
  type AdaptiveSeriesRecord,
} from './report.js';

/**
 * M08.18D: composing series, screening-round and validation evidence into the
 * canonical adaptive result payload and its Markdown view, plus the one
 * cross-series computation this file owns — descriptive repeated-state
 * detection.
 */

const EXPERIMENT_ID = 'report-test';

function deck(label: string, commanderId = 'prototype_commander_blue', extra = 0): SimDeck {
  return makeDeck({
    id: label,
    label,
    commanderId,
    cards: [
      { cardId: 'prototype_scout', quantity: 2 + extra },
      { cardId: 'prototype_guard', quantity: 2 },
    ],
  });
}

function revision(
  label: string,
  revisionDeck: SimDeck,
  overrides: Partial<{
    parentRevisionId: string | null;
    generation: number;
    block: number;
    opponentRevisionId: string | null;
    construction: 'root' | 'swap' | 'rebuild';
    swaps: readonly { cardOut: string; cardIn: string }[];
  }> = {},
): AdaptiveRevision {
  return makeAdaptiveRevision({
    experimentId: EXPERIMENT_ID,
    parentRevisionId: overrides.parentRevisionId ?? null,
    generation: overrides.generation ?? 0,
    block: overrides.block ?? 0,
    opponentRevisionId: overrides.opponentRevisionId ?? null,
    construction: overrides.construction ?? 'root',
    seedPath: adaptiveRevisionSeedPath(
      `report-fixture-seed-${label}`,
      EXPERIMENT_ID,
      overrides.generation ?? 0,
      overrides.block ?? 0,
    ),
    deck: revisionDeck,
    ...(overrides.swaps !== undefined ? { swaps: overrides.swaps } : {}),
  });
}

function lineage(revisions: readonly AdaptiveRevision[]): AdaptiveCheckpointLineage {
  const active = revisions[revisions.length - 1];
  if (!active) throw new Error('a test lineage needs at least one revision');
  return { activeRevisionId: active.revisionId, revisions: [...revisions] };
}

function screeningStub(
  revisionId: string,
  objective: AdaptiveObjective,
): AdaptiveCandidateScreening {
  return { revisionId, objective, opponentMatches: [], fieldMatches: [] };
}

function tally(candidateWins: number, opponentWins: number, noResult = 0): AdaptiveScreeningTally {
  return { candidateWins, opponentWins, noResult };
}

function evidenceFor(
  candidate: AdaptiveRevision,
  objective: AdaptiveObjective,
  opponent: AdaptiveScreeningTally,
  field: AdaptiveScreeningTally | null = null,
): AdaptiveCandidateEvidence {
  return {
    candidate,
    screening: screeningStub(candidate.revisionId, objective),
    tallies: { opponent, field },
  };
}

describe('makeAdaptiveSeriesRecord', () => {
  it('records both sides deck hashes and the decision as given', () => {
    const incumbent = revision('incumbent', deck('incumbent'));
    const opponent = revision('opponent', deck('opponent', undefined, 5));
    const record = makeAdaptiveSeriesRecord({
      generation: 0,
      block: 0,
      incumbent,
      opponent,
      decision: { kind: 'win', loser: 'incumbent' },
    });
    expect(record).toEqual<AdaptiveSeriesRecord>({
      generation: 0,
      block: 0,
      incumbentRevisionId: incumbent.revisionId,
      opponentRevisionId: opponent.revisionId,
      incumbentDeckHash: incumbent.deck.hash,
      opponentDeckHash: opponent.deck.hash,
      decision: { kind: 'win', loser: 'incumbent' },
    });
  });
});

describe('detectAdaptiveCycles', () => {
  it('names a block whose active deck pair exactly repeats an earlier block', () => {
    const a = revision('a', deck('a'));
    const b = revision('b', deck('b'));
    const c = revision('c', deck('c', undefined, 9));

    const seriesEntry = (
      block: number,
      generation: number,
      incumbent: AdaptiveRevision,
      opponent: AdaptiveRevision,
    ): AdaptiveSeriesRecord =>
      makeAdaptiveSeriesRecord({
        generation,
        block,
        incumbent,
        opponent,
        decision: { kind: 'tie' },
      });

    const series = [seriesEntry(0, 0, a, b), seriesEntry(1, 1, a, c), seriesEntry(2, 2, a, b)];

    const cycles = detectAdaptiveCycles(series);
    expect(cycles).toEqual([
      {
        block: 2,
        generation: 2,
        repeatsBlock: 0,
        incumbentDeckHash: a.deck.hash,
        opponentDeckHash: b.deck.hash,
      },
    ]);
  });

  it('reports no cycles when every block plays a distinct deck pair', () => {
    const a = revision('a2', deck('a2'));
    const b = revision('b2', deck('b2', undefined, 1));
    const c = revision('c2', deck('c2', undefined, 2));
    const series = [0, 1].map((block) =>
      makeAdaptiveSeriesRecord({
        generation: block,
        block,
        incumbent: a,
        opponent: block === 0 ? b : c,
        decision: { kind: 'tie' },
      }),
    );
    expect(detectAdaptiveCycles(series)).toEqual([]);
  });
});

describe('buildAdaptiveScreeningRound', () => {
  const candidateA = revision('cand-a', deck('cand-a'), {
    parentRevisionId: 'rev_parent',
    generation: 1,
    opponentRevisionId: 'rev_opponent',
    construction: 'swap',
    swaps: [{ cardOut: 'prototype_scout', cardIn: 'prototype_guard' }],
  });
  const candidateB = revision('cand-b', deck('cand-b', undefined, 3), {
    parentRevisionId: 'rev_parent',
    generation: 1,
    opponentRevisionId: 'rev_opponent',
    construction: 'swap',
    swaps: [{ cardOut: 'prototype_scout', cardIn: 'prototype_guard' }],
  });

  it('flattens every candidate and reports a promoted decision', () => {
    const round = buildAdaptiveScreeningRound({
      generation: 1,
      block: 0,
      loserSide: 'incumbent',
      opponentRevisionId: 'rev_opponent',
      evidence: [
        evidenceFor(candidateA, 'pure_counter', tally(3, 7)),
        evidenceFor(candidateB, 'pure_counter', tally(9, 1)),
      ],
      score: (evidence) => proportion(evidence.tallies.opponent.candidateWins, 10),
      decision: { kind: 'promoted', revision: candidateB, score: proportion(9, 10) },
    });

    expect(round.generation).toBe(1);
    expect(round.candidates.map((c) => c.revisionId)).toEqual([
      candidateA.revisionId,
      candidateB.revisionId,
    ]);
    expect(round.candidates[1]?.score.successes).toBe(9);
    expect(round.decision).toEqual({ kind: 'promoted', revisionId: candidateB.revisionId });
  });

  it('reports a retained decision with its reason', () => {
    const round = buildAdaptiveScreeningRound({
      generation: 1,
      block: 0,
      loserSide: 'opponent',
      opponentRevisionId: 'rev_opponent',
      evidence: [evidenceFor(candidateA, 'pure_counter', tally(4, 4))],
      score: (evidence) => proportion(evidence.tallies.opponent.candidateWins, 8),
      decision: { kind: 'retained', reason: 'nothing decisively beat the opponent' },
    });
    expect(round.decision).toEqual({
      kind: 'retained',
      reason: 'nothing decisively beat the opponent',
    });
  });
});

describe('summarizeAdaptiveReferenceField', () => {
  function roundWith(
    fieldTallies: readonly (AdaptiveScreeningTally | null)[],
  ): AdaptiveScreeningRound {
    return {
      generation: 1,
      block: 0,
      loserSide: 'incumbent',
      opponentRevisionId: 'rev_opponent',
      candidates: fieldTallies.map((fieldTally, index) => ({
        revisionId: `rev_cand_${String(index)}`,
        objective: 'meta_aware',
        opponentTally: tally(1, 1),
        fieldTally,
        score: proportion(1, 2),
      })),
      decision: { kind: 'retained', reason: 'test' },
    };
  }

  it('returns null when no round ever scheduled a reference-field game', () => {
    expect(summarizeAdaptiveReferenceField([roundWith([null, null])])).toBeNull();
  });

  it('pools candidate and opponent field wins across every round', () => {
    const standing = summarizeAdaptiveReferenceField([
      roundWith([tally(3, 1), null]),
      roundWith([tally(2, 4, 1)]),
    ]);
    expect(standing).not.toBeNull();
    expect(standing?.candidateWins).toBe(5);
    expect(standing?.opponentWins).toBe(5);
    expect(standing?.noResult).toBe(1);
    expect(standing?.gamesPlayed).toBe(11);
    expect(standing?.standing.total).toBe(10);
  });
});

describe('finalAdaptiveDeckDiff', () => {
  it('reports no change when the active revision is still the root', () => {
    const root = revision('root-only', deck('root-only'));
    const diff = finalAdaptiveDeckDiff(lineage([root]));
    expect(diff.swaps).toEqual([]);
    expect(diff.commanderChanged).toBe(false);
    expect(diff.rootRevisionId).toBe(root.revisionId);
    expect(diff.finalRevisionId).toBe(root.revisionId);
  });

  it('reports the net swaps and a commander change between root and the active revision', () => {
    const root = revision('diff-root', deck('diff-root', 'prototype_commander_blue'));
    const changed = revision(
      'diff-child',
      makeDeck({
        id: 'diff-child',
        label: 'diff-child',
        commanderId: 'prototype_commander_red',
        cards: [
          { cardId: 'prototype_scout', quantity: 1 },
          { cardId: 'prototype_guard', quantity: 3 },
        ],
      }),
      {
        parentRevisionId: root.revisionId,
        generation: 1,
        opponentRevisionId: 'rev_opponent',
        construction: 'swap',
        swaps: [{ cardOut: 'prototype_scout', cardIn: 'prototype_guard' }],
      },
    );
    const diff = finalAdaptiveDeckDiff(lineage([root, changed]));
    expect(diff.commanderChanged).toBe(true);
    expect(diff.swaps).toEqual([{ cardOut: 'prototype_scout', cardIn: 'prototype_guard' }]);
    expect(diff.finalRevisionId).toBe(changed.revisionId);
  });
});

describe('buildAdaptiveResult and renderAdaptiveReport', () => {
  function checkpointFixture(): AdaptiveCheckpoint {
    const incumbentRoot = revision('inc-root', deck('inc-root'));
    const opponentRoot = revision('opp-root', deck('opp-root', undefined, 4));
    return {
      schemaVersion: 2,
      experimentId: EXPERIMENT_ID,
      configHash: 'report-test-config-hash',
      lineages: {
        incumbent: lineage([incumbentRoot]),
        opponent: lineage([opponentRoot]),
      },
      gamesSpent: 4,
      referenceField: [],
      pendingGeneration: null,
      nextGeneration: 1,
      nextBlock: 1,
      nextSeedPath: adaptiveRevisionSeedPath('report-fixture-seed', EXPERIMENT_ID, 1, 1),
    };
  }

  it('composes series tally, cycles and deck diffs from the checkpoint and accumulated evidence, with no validation yet', () => {
    const checkpoint = checkpointFixture();
    const incumbentRoot = checkpoint.lineages.incumbent.revisions[0]!;
    const opponentRoot = checkpoint.lineages.opponent.revisions[0]!;
    const series = [
      makeAdaptiveSeriesRecord({
        generation: 0,
        block: 0,
        incumbent: incumbentRoot,
        opponent: opponentRoot,
        decision: { kind: 'win', loser: 'incumbent' },
      }),
    ];

    const result = buildAdaptiveResult({
      checkpoint,
      series,
      screeningRounds: [],
      validation: null,
    });

    expect(result.seriesTally).toEqual({
      incumbentWins: 0,
      opponentWins: 1,
      ties: 0,
      noDecisions: 0,
    });
    expect(result.cycles).toEqual([]);
    expect(result.referenceField).toBeNull();
    expect(result.validation).toBeNull();
    expect(result.finalDeckDiff.incumbent.rootRevisionId).toBe(incumbentRoot.revisionId);
    expect(result.finalDeckDiff.incumbent.swaps).toEqual([]);

    const markdown = renderAdaptiveReport({
      ...result,
      experimentId: checkpoint.experimentId,
      configHash: checkpoint.configHash,
    });
    expect(markdown).toContain('# Adaptive Counter report — report-test');
    expect(markdown).toContain('## Series score');
    expect(markdown).toContain('## Repeated states');
    expect(markdown).toContain('descriptive observation only');
    expect(markdown).toContain('never a verdict that the meta is healthy, stuck or converged');
    expect(markdown).toContain('The frozen validation stage has not been run');
  });

  it('folds a frozen validation outcome into its own section, never into seriesTally', () => {
    const checkpoint = checkpointFixture();
    const incumbentRoot = checkpoint.lineages.incumbent.revisions[0]!;
    const opponentRoot = checkpoint.lineages.opponent.revisions[0]!;
    const outcome = { incumbentWins: 1, opponentWins: 3, noResult: 0 };

    const result = buildAdaptiveResult({
      checkpoint,
      series: [],
      screeningRounds: [],
      validation: {
        decks: {
          incumbent: { revisionId: incumbentRoot.revisionId, deck: incumbentRoot.deck },
          opponent: { revisionId: opponentRoot.revisionId, deck: opponentRoot.deck },
        },
        outcome,
        standing: proportion(outcome.incumbentWins, outcome.incumbentWins + outcome.opponentWins),
      },
    });

    expect(result.seriesTally).toEqual({
      incumbentWins: 0,
      opponentWins: 0,
      ties: 0,
      noDecisions: 0,
    });
    expect(result.validation).toEqual({
      incumbentRevisionId: incumbentRoot.revisionId,
      opponentRevisionId: opponentRoot.revisionId,
      incumbentWins: 1,
      opponentWins: 3,
      noResult: 0,
      standing: proportion(1, 4),
    });

    const markdown = renderAdaptiveReport({
      ...result,
      experimentId: checkpoint.experimentId,
      configHash: checkpoint.configHash,
    });
    expect(markdown).toContain('## Frozen validation');
    expect(markdown).toContain('1-3');
  });
});
