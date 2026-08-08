import { z } from 'zod';
import type { EnvironmentDiff } from '../environment.js';
import type { MatchRecord } from '../telemetry/schema.js';
import type { SimDeck } from '../deck-search/deck.js';
import { aggregate, type Aggregate } from './aggregate.js';
import { cohensH, effectSizeLabel, proportion, proportionDifference, round } from './stats.js';

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
});
export type DeckDelta = z.infer<typeof deckDeltaSchema>;

export const cardDeltaSchema = z.strictObject({
  definitionId: z.string(),
  baselineDecks: z.number().int().min(0),
  candidateDecks: z.number().int().min(0),
  baselineWinRate: z.number(),
  candidateWinRate: z.number(),
  winRateDelta: z.number(),
  playRateDelta: z.number(),
  status: z.enum(['unchanged', 'gained', 'lost', 'more_included', 'less_included']),
});
export type CardDelta = z.infer<typeof cardDeltaSchema>;

export const comparisonReportSchema = z.strictObject({
  diff: z.unknown(),
  pairedGames: z.number().int().min(0),
  /** How much of the baseline run had a matching candidate game. */
  pairedCoverage: z.number(),
  referenceDeckDeltas: z.array(deckDeltaSchema),
  referenceCardDeltas: z.array(cardDeltaSchema),
  /** Decks the search found only in the candidate environment. */
  strategiesGained: z.array(
    z.strictObject({ deckHash: z.string(), label: z.string(), score: z.number() }),
  ),
  /** Decks the search found only in the baseline environment. */
  strategiesLost: z.array(
    z.strictObject({ deckHash: z.string(), label: z.string(), score: z.number() }),
  ),
  /** Cards that lost at least half their inclusion in searched decks. */
  displacedCards: z.array(
    z.strictObject({ definitionId: z.string(), before: z.number(), after: z.number() }),
  ),
  /** Cards that appear in searched decks only after the change. */
  newlyViableCards: z.array(z.string()),
  limitations: z.array(z.string()),
});
export type ComparisonReport = z.infer<typeof comparisonReportSchema>;

export interface CompareInputs {
  readonly diff: EnvironmentDiff;
  readonly baselineRecords: readonly MatchRecord[];
  readonly candidateRecords: readonly MatchRecord[];
  readonly baselineSearchDecks?: readonly SimDeck[];
  readonly candidateSearchDecks?: readonly SimDeck[];
  readonly baselineSearchScores?: ReadonlyMap<string, number>;
  readonly candidateSearchScores?: ReadonlyMap<string, number>;
  readonly confidence?: number;
  readonly minMatches?: number;
}

export function compareEnvironments(inputs: CompareInputs): ComparisonReport {
  const confidence = inputs.confidence ?? 0.95;
  const minMatches = inputs.minMatches ?? 20;

  const baseline = aggregate(inputs.baselineRecords, { confidence });
  const candidate = aggregate(inputs.candidateRecords, { confidence });

  const baselineGames = gameKeys(inputs.baselineRecords);
  const candidateGames = gameKeys(inputs.candidateRecords);
  const shared = [...baselineGames].filter((key) => candidateGames.has(key));

  const referenceDeckDeltas = compareDecks(
    inputs.baselineRecords,
    inputs.candidateRecords,
    confidence,
  );
  const referenceCardDeltas = compareCards(baseline, candidate);

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
  const changedCardIds = new Set([
    ...inputs.diff.cardsAdded,
    ...inputs.diff.cardsChanged.map((entry) => entry.cardId),
  ]);

  const displacedCards = [...before]
    .filter(([cardId, count]) => !changedCardIds.has(cardId) && count >= 2)
    .map(([cardId, count]) => ({
      definitionId: cardId,
      before: count,
      after: after.get(cardId) ?? 0,
    }))
    .filter((entry) => entry.after <= entry.before / 2)
    .sort((left, right) => left.definitionId.localeCompare(right.definitionId));

  const newlyViableCards = [...after.keys()]
    .filter((cardId) => (before.get(cardId) ?? 0) === 0)
    .sort();

  const limitations: string[] = [];
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

  return {
    diff: inputs.diff,
    pairedGames: shared.length,
    pairedCoverage: baselineGames.size === 0 ? 0 : round(shared.length / baselineGames.size, 3),
    referenceDeckDeltas,
    referenceCardDeltas,
    strategiesGained,
    strategiesLost,
    displacedCards,
    newlyViableCards,
    limitations,
  };
}

function gameKeys(records: readonly MatchRecord[]): Set<string> {
  return new Set(
    records.map((record) => `${record.deckPairId}:${record.variantKey}:${record.gameIndex}`),
  );
}

function compareDecks(
  baselineRecords: readonly MatchRecord[],
  candidateRecords: readonly MatchRecord[],
  confidence: number,
): DeckDelta[] {
  interface DeckTally {
    deckId: string;
    wins: number;
    total: number;
    games: Set<string>;
  }

  const tally = (records: readonly MatchRecord[]): Map<string, DeckTally> => {
    const map = new Map<string, DeckTally>();
    for (const record of records) {
      for (const seat of record.seats) {
        const entry: DeckTally = map.get(seat.deckHash) ?? {
          deckId: seat.deckId,
          wins: 0,
          total: 0,
          games: new Set<string>(),
        };
        entry.total += 1;
        if (seat.won) entry.wins += 1;
        entry.games.add(`${record.deckPairId}:${record.variantKey}:${record.gameIndex}`);
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
      const difference = proportionDifference(
        { successes: right.wins, total: right.total },
        { successes: left.wins, total: left.total },
        confidence,
      );
      const h = cohensH(candidateRate.point, baselineRate.point);
      const paired = [...left.games].filter((game) => right.games.has(game)).length;

      return {
        deckHash: hash,
        deckId: left.deckId,
        baselineWinRate: round(baselineRate.point),
        candidateWinRate: round(candidateRate.point),
        delta: round(difference.point),
        low: round(difference.low),
        high: round(difference.high),
        effectSize: round(h),
        effectSizeLabel: effectSizeLabel(h),
        baselineMatches: left.total,
        candidateMatches: right.total,
        pairedGames: paired,
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
      playRateDelta: round((right?.playRatePerDrawn ?? 0) - (left?.playRatePerDrawn ?? 0)),
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
