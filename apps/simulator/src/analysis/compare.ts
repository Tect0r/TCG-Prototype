import { z } from 'zod';
import type { EnvironmentDiff } from '../environment.js';
import { isAbnormal, type MatchRecord } from '../telemetry/schema.js';
import type { SimDeck } from '@tcg/deck-generator';
import { aggregate, type Aggregate } from './aggregate.js';
import { pairedBinary, pairedMean, type PairedMean } from './paired.js';
import { cohensH, effectSizeLabel, proportion, round } from './stats.js';

/**
 * Baseline versus candidate (CLAUDE.md §13.12).
 *
 * Two comparisons, deliberately kept separate and both required:
 *
 * - **Reference population.** The same decks, unchanged, in both environments,
 *   on common random numbers. This measures what the change did to the game
 *   people are already playing.
 * - **Searched population.** An independent deck search in *each* environment.
 *   This measures what the change made possible — the abuse a reference
 *   population by definition cannot contain, because it was built before the
 *   change existed.
 *
 * Reporting only the first understates a new card; reporting only the second,
 * against a stale baseline, overstates it. The report keeps them apart so a
 * reader can see which question each number answers.
 */

export const deckDeltaSchema = z.strictObject({
  deckHash: z.string(),
  deckId: z.string(),
  baselineWinRate: z.number(),
  candidateWinRate: z.number(),
  delta: z.number(),
  low: z.number(),
  high: z.number(),
  effectSize: z.number(),
  effectSizeLabel: z.string(),
  baselineMatches: z.number().int().min(0),
  candidateMatches: z.number().int().min(0),
  /** Games with the same deck pair and index in both runs: the paired sample. */
  pairedGames: z.number().int().min(0),
  /**
   * The full paired estimate: discordant counts, exclusions and the paired
   * interval. `delta`, `low` and `high` above are taken from it, so the headline
   * numbers and the detail can never disagree (PHASE4_HARDENING §9.1).
   */
  paired: z.unknown(),
  /** Set when too few complete pairs survived for the estimate to mean anything. */
  insufficientEvidence: z.boolean(),
});
export type DeckDelta = z.infer<typeof deckDeltaSchema>;

export const cardDeltaSchema = z.strictObject({
  definitionId: z.string(),
  baselineDecks: z.number().int().min(0),
  candidateDecks: z.number().int().min(0),
  baselineWinRate: z.number(),
  candidateWinRate: z.number(),
  winRateDelta: z.number(),
  /** Change in play events per draw event. Unbounded; never a percentage (§8.1). */
  playsPerDrawDelta: z.number(),
  status: z.enum(['unchanged', 'gained', 'lost', 'more_included', 'less_included']),
});
export type CardDelta = z.infer<typeof cardDeltaSchema>;

export const comparisonReportSchema = z.strictObject({
  diff: z.unknown(),
  /** The declared-change check that ran before any match (§4). */
  declaredDiffCheck: z.unknown().nullable(),
  /**
   * Identity of the one frozen reference population both arms replayed (§6).
   * Equal by construction; recorded so a reader can verify rather than trust.
   */
  referencePopulationHash: z.string(),
  referenceDecksExcluded: z.array(z.unknown()),
  pairedGames: z.number().int().min(0),
  /** How much of the baseline run had a matching candidate game. */
  pairedCoverage: z.number(),
  referenceDeckDeltas: z.array(deckDeltaSchema),
  referenceCardDeltas: z.array(cardDeltaSchema),
  /** Paired difference in match length, in turns (§9.1 continuous outcome). */
  matchLengthDelta: z.unknown(),
  /** Decks the search found only in the candidate environment. */
  strategiesGained: z.array(
    z.strictObject({ deckHash: z.string(), label: z.string(), score: z.number() }),
  ),
  /** Decks the search found only in the baseline environment. */
  strategiesLost: z.array(
    z.strictObject({ deckHash: z.string(), label: z.string(), score: z.number() }),
  ),
  /**
   * Replicated, normalized displacement evidence (§11).
   *
   * Supplied by `analyzeDisplacement` rather than computed here from raw counts:
   * a single search run's archive counts cannot tell displacement from the
   * search's own variance, which is exactly what the old `before → after`
   * halving check was reporting.
   */
  displacement: z.array(z.unknown()),
  /** Cards that appear in searched decks only after the change. */
  newlyViableCards: z.array(z.string()),
  limitations: z.array(z.string()),
});
export type ComparisonReport = z.infer<typeof comparisonReportSchema>;

export interface CompareInputs {
  readonly diff: EnvironmentDiff;
  /** Outcome of the declared-change check, when the experiment declared one. */
  readonly declaredDiffCheck?: unknown;
  /** Hash of the frozen population both arms replayed (§6). */
  readonly referencePopulationHash: string;
  readonly referenceDecksExcluded?: readonly unknown[];
  readonly baselineRecords: readonly MatchRecord[];
  readonly candidateRecords: readonly MatchRecord[];
  readonly baselineSearchDecks?: readonly SimDeck[];
  readonly candidateSearchDecks?: readonly SimDeck[];
  readonly baselineSearchScores?: ReadonlyMap<string, number>;
  readonly candidateSearchScores?: ReadonlyMap<string, number>;
  readonly confidence?: number;
  readonly minMatches?: number;
  readonly minPairs?: number;
  readonly bootstrapIterations?: number;
  readonly seed?: string;
  /** Replicated displacement evidence, computed by `analyzeDisplacement` (§11). */
  readonly displacement?: readonly unknown[];
}

export function compareEnvironments(inputs: CompareInputs): ComparisonReport {
  const confidence = inputs.confidence ?? 0.95;
  const minMatches = inputs.minMatches ?? 20;
  const minPairs = inputs.minPairs ?? 20;
  const iterations = inputs.bootstrapIterations ?? 2000;
  const seed = inputs.seed ?? 'compare';

  const baseline = aggregate(inputs.baselineRecords, { confidence });
  const candidate = aggregate(inputs.candidateRecords, { confidence });

  const baselineGames = gameKeys(inputs.baselineRecords);
  const candidateGames = gameKeys(inputs.candidateRecords);
  const shared = [...baselineGames].filter((key) => candidateGames.has(key));

  const referenceDeckDeltas = compareDecks(
    inputs.baselineRecords,
    inputs.candidateRecords,
    confidence,
    minPairs,
    seed,
    iterations,
  );
  const referenceCardDeltas = compareCards(baseline, candidate);
  const matchLengthDelta = compareMatchLength(
    inputs.baselineRecords,
    inputs.candidateRecords,
    confidence,
    minPairs,
  );

  const baselineDecks = new Map(
    (inputs.baselineSearchDecks ?? []).map((d) => [d.hash, d] as const),
  );
  const candidateDecks = new Map(
    (inputs.candidateSearchDecks ?? []).map((d) => [d.hash, d] as const),
  );

  const strategiesGained = [...candidateDecks.values()]
    .filter((deck) => !baselineDecks.has(deck.hash))
    .map((deck) => ({
      deckHash: deck.hash,
      label: deck.label,
      score: round(inputs.candidateSearchScores?.get(deck.hash) ?? 0, 4),
    }))
    .sort((left, right) => right.score - left.score || left.deckHash.localeCompare(right.deckHash));

  const strategiesLost = [...baselineDecks.values()]
    .filter((deck) => !candidateDecks.has(deck.hash))
    .map((deck) => ({
      deckHash: deck.hash,
      label: deck.label,
      score: round(inputs.baselineSearchScores?.get(deck.hash) ?? 0, 4),
    }))
    .sort((left, right) => right.score - left.score || left.deckHash.localeCompare(right.deckHash));

  const before = inclusionCounts([...baselineDecks.values()]);
  const after = inclusionCounts([...candidateDecks.values()]);

  const newlyViableCards = [...after.keys()]
    .filter((cardId) => (before.get(cardId) ?? 0) === 0)
    .sort();

  const limitations: string[] = [
    'Reference impact and discovery impact answer different questions and are reported ' +
      'separately (PHASE4_HARDENING §6). The reference population is frozen and identical in ' +
      'both environments, so it cannot contain a card the candidate added — that is what the ' +
      'searched populations are for, and mixing the two would make both uninterpretable.',
  ];
  if (shared.length === 0) {
    limitations.push(
      'No game in the candidate run shares a seed with the baseline run, so nothing here is a paired comparison.',
    );
  } else if (shared.length < Math.min(baselineGames.size, candidateGames.size) / 2) {
    limitations.push(
      `Only ${shared.length} of ${baselineGames.size} baseline games had a matching candidate game; ` +
        'the rest are unpaired and noisier.',
    );
  }
  if (referenceDeckDeltas.some((delta) => delta.baselineMatches < minMatches)) {
    limitations.push(
      `Some reference decks were played fewer than ${minMatches} times; their deltas are indicative only.`,
    );
  }
  if (!inputs.candidateSearchDecks || !inputs.baselineSearchDecks) {
    limitations.push(
      'No independent deck search was run, so this compares existing decks only and cannot see novel abuse ' +
        'the change enables (CLAUDE.md §13.12).',
    );
  }
  if (inputs.diff.identical) {
    limitations.push('The two environments hash identically: there is nothing to compare.');
  }

  if (referenceDeckDeltas.some((delta) => delta.insufficientEvidence)) {
    limitations.push(
      `Some reference decks produced fewer than ${minPairs} complete pairs; their paired ` +
        'estimates are marked `insufficientEvidence` and should not be read as results.',
    );
  }

  return {
    diff: inputs.diff,
    declaredDiffCheck: inputs.declaredDiffCheck ?? null,
    referencePopulationHash: inputs.referencePopulationHash,
    referenceDecksExcluded: [...(inputs.referenceDecksExcluded ?? [])],
    pairedGames: shared.length,
    pairedCoverage: baselineGames.size === 0 ? 0 : round(shared.length / baselineGames.size, 3),
    referenceDeckDeltas,
    referenceCardDeltas,
    matchLengthDelta,
    strategiesGained,
    strategiesLost,
    displacement: [...(inputs.displacement ?? [])],
    newlyViableCards,
    limitations,
  };
}

function gameKeys(records: readonly MatchRecord[]): Set<string> {
  return new Set(
    records.map((record) => `${record.deckPairId}:${record.variantKey}:${record.gameIndex}`),
  );
}

/**
 * Paired difference in match length (PHASE4_HARDENING §9.1, continuous outcome).
 *
 * Same games, same shuffles, one environment change: the within-pair difference
 * is the observation, and its ordinary interval is already the paired one. An
 * independent-sample interval over two piles of turn counts would be both wider
 * and wrong.
 */
function compareMatchLength(
  baselineRecords: readonly MatchRecord[],
  candidateRecords: readonly MatchRecord[],
  confidence: number,
  minPairs: number,
): PairedMean {
  const key = (record: MatchRecord): string =>
    `${record.deckPairId}:${record.variantKey}:${record.gameIndex}`;

  const usable = (records: readonly MatchRecord[]): Map<string, number> => {
    const map = new Map<string, number>();
    for (const record of records) {
      // Abnormal matches are excluded here for the same reason they are excluded
      // from every other statistic: a turn-limit stall is not a long game, it is
      // a failed one, and averaging it in would manufacture a length change.
      if (isAbnormal(record.termination)) continue;
      map.set(key(record), record.turns);
    }
    return map;
  };

  const before = usable(baselineRecords);
  const after = usable(candidateRecords);

  const observations = [...before]
    .filter(([gameKey]) => after.has(gameKey))
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([gameKey, turns]) => ({ baseline: turns, candidate: after.get(gameKey) ?? 0 }));

  return pairedMean(observations, {
    confidence,
    minPairs,
    excluded: before.size - observations.length,
  });
}

/**
 * Per-deck delta, analysed as a **paired** contrast.
 *
 * The two runs share their seeds by construction (`pairedSeeds` in the
 * schedule): the same deck, the same opponents, the same shuffles, the same
 * pilot streams, differing only in the environment. Treating those as two
 * independent samples — which is what `proportionDifference` did here — throws
 * away the design and reports a wider interval than the experiment earned.
 * PHASE4_HARDENING §9.1 requires the pairing to survive into the estimate.
 *
 * Games without a partner in the other arm are excluded from the paired
 * estimate, counted, and reported. They are never quietly folded in as though
 * everything were independent.
 */
function compareDecks(
  baselineRecords: readonly MatchRecord[],
  candidateRecords: readonly MatchRecord[],
  confidence: number,
  minPairs: number,
  seed: string,
  iterations: number,
): DeckDelta[] {
  interface SeatOutcome {
    readonly won: boolean;
    readonly stratum: string;
  }
  interface DeckTally {
    deckId: string;
    wins: number;
    total: number;
    games: Map<string, SeatOutcome>;
  }

  const tally = (records: readonly MatchRecord[]): Map<string, DeckTally> => {
    const map = new Map<string, DeckTally>();
    for (const record of records) {
      for (const seat of record.seats) {
        const entry: DeckTally = map.get(seat.deckHash) ?? {
          deckId: seat.deckId,
          wins: 0,
          total: 0,
          games: new Map<string, SeatOutcome>(),
        };
        entry.total += 1;
        if (seat.won) entry.wins += 1;
        // The seat index is part of the key: a mirrored schedule plays the same
        // game twice with the seats swapped, and those are two experimental
        // units, not one observed twice.
        entry.games.set(
          `${record.deckPairId}:${record.variantKey}:${record.gameIndex}:${seat.seatIndex}`,
          { won: seat.won, stratum: `${seat.pilotId}|${seat.seatIndex}` },
        );
        map.set(seat.deckHash, entry);
      }
    }
    return map;
  };

  const before = tally(baselineRecords);
  const after = tally(candidateRecords);

  return [...before.keys()]
    .filter((hash) => after.has(hash))
    .sort()
    .map((hash) => {
      const left = before.get(hash) as DeckTally;
      const right = after.get(hash) as DeckTally;
      const baselineRate = proportion(left.wins, left.total, confidence);
      const candidateRate = proportion(right.wins, right.total, confidence);
      const h = cohensH(candidateRate.point, baselineRate.point);

      const outcomes = [...left.games]
        .filter(([key]) => right.games.has(key))
        .map(([key, entry]) => ({
          key,
          baselineWon: entry.won,
          candidateWon: right.games.get(key)?.won ?? false,
          stratum: entry.stratum,
        }));

      const unmatchedBaseline = left.games.size - outcomes.length;
      const unmatchedCandidate = right.games.size - outcomes.length;
      const excluded: Record<string, number> = {};
      if (unmatchedBaseline > 0) excluded.baseline_game_without_candidate = unmatchedBaseline;
      if (unmatchedCandidate > 0) excluded.candidate_game_without_baseline = unmatchedCandidate;

      const paired = pairedBinary(outcomes, {
        seed: `${seed}|deck:${hash}`,
        confidence,
        minPairs,
        iterations,
        ...(Object.keys(excluded).length > 0 ? { excluded } : {}),
      });

      return {
        deckHash: hash,
        deckId: left.deckId,
        baselineWinRate: round(baselineRate.point),
        candidateWinRate: round(candidateRate.point),
        delta: paired.delta,
        low: paired.low,
        high: paired.high,
        effectSize: round(h),
        effectSizeLabel: effectSizeLabel(h),
        baselineMatches: left.total,
        candidateMatches: right.total,
        pairedGames: paired.pairs,
        paired,
        insufficientEvidence: paired.insufficientEvidence,
      };
    })
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta) || a.deckHash.localeCompare(b.deckHash));
}

function compareCards(baseline: Aggregate, candidate: Aggregate): CardDelta[] {
  const before = new Map(baseline.cards.map((card) => [card.definitionId, card] as const));
  const after = new Map(candidate.cards.map((card) => [card.definitionId, card] as const));
  const ids = [...new Set([...before.keys(), ...after.keys()])].sort();

  return ids.map((definitionId) => {
    const left = before.get(definitionId);
    const right = after.get(definitionId);

    let status: CardDelta['status'] = 'unchanged';
    if (!left && right) status = 'gained';
    else if (left && !right) status = 'lost';
    else if (left && right) {
      if (right.decksIncluding > left.decksIncluding) status = 'more_included';
      else if (right.decksIncluding < left.decksIncluding) status = 'less_included';
    }

    return {
      definitionId,
      baselineDecks: left?.decksIncluding ?? 0,
      candidateDecks: right?.decksIncluding ?? 0,
      baselineWinRate: left?.winRateWhenIncluded.point ?? 0,
      candidateWinRate: right?.winRateWhenIncluded.point ?? 0,
      winRateDelta: round(
        (right?.winRateWhenIncluded.point ?? 0) - (left?.winRateWhenIncluded.point ?? 0),
      ),
      playsPerDrawDelta: round((right?.playsPerDraw ?? 0) - (left?.playsPerDraw ?? 0)),
      status,
    };
  });
}

function inclusionCounts(decks: readonly SimDeck[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const deck of decks) {
    for (const entry of deck.cards) {
      counts.set(entry.cardId, (counts.get(entry.cardId) ?? 0) + 1);
    }
  }
  return counts;
}
