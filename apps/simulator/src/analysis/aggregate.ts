import { z } from 'zod';
import { DEAD_HAND_CATEGORIES, isAbnormal, type MatchRecord } from '../telemetry/schema.js';
import { mean, percentile, proportion, round, type ProportionEstimate } from './stats.js';

/**
 * Turns raw match records into the aggregate views a report is built from
 * (CLAUDE.md §13.11).
 *
 * Two rules run through everything here:
 *
 * - **Order.** Records are processed in `orderKey` order, never in arrival
 *   order, so every floating-point sum is accumulated identically whatever the
 *   worker count was.
 * - **Separation.** Abnormal matches are excluded from ordinary statistics and
 *   counted separately. A turn-limit stall is not a draw and must never be
 *   averaged in as though it were one.
 */

export const proportionSchema = z.strictObject({
  point: z.number(),
  low: z.number(),
  high: z.number(),
  successes: z.number(),
  total: z.number(),
  margin: z.number(),
});

const rounded = (estimate: ProportionEstimate): z.infer<typeof proportionSchema> => ({
  point: round(estimate.point),
  low: round(estimate.low),
  high: round(estimate.high),
  successes: estimate.successes,
  total: estimate.total,
  margin: round(estimate.margin),
});

export const runSummarySchema = z.strictObject({
  matches: z.number().int().min(0),
  usableMatches: z.number().int().min(0),
  abnormalMatches: z.number().int().min(0),
  abnormalShare: z.number(),
  terminations: z.record(z.string(), z.number().int().min(0)),
  endReasons: z.record(z.string(), z.number().int().min(0)),
  draws: z.number().int().min(0),
  turns: z.strictObject({
    mean: z.number(),
    median: z.number(),
    p10: z.number(),
    p90: z.number(),
    max: z.number(),
  }),
  decisionsPerMatch: z.number(),
  botFailures: z.number().int().min(0),
  /** Win rate by seat index: the seat-advantage check (CLAUDE.md §13.11). */
  seatWinRates: z.array(z.strictObject({ seatIndex: z.number().int(), rate: proportionSchema })),
  /** Win rate by pilot: the pilot-sensitivity check. */
  pilotWinRates: z.array(z.strictObject({ pilotId: z.string(), rate: proportionSchema })),
  environments: z.array(z.string()),
});
export type RunSummary = z.infer<typeof runSummarySchema>;

export const deckSummarySchema = z.strictObject({
  deckHash: z.string(),
  deckId: z.string(),
  commanderId: z.string(),
  matches: z.number().int().min(0),
  winRate: proportionSchema,
  /** Win rate by the seat this deck sat in, exposing a mirrored-schedule bias. */
  bySeat: z.array(z.strictObject({ seatIndex: z.number().int(), rate: proportionSchema })),
  averageTurns: z.number(),
  averageDamageDealt: z.number(),
  averageDamageTaken: z.number(),
});
export type DeckSummary = z.infer<typeof deckSummarySchema>;

export const matchupSchema = z.strictObject({
  deckHash: z.string(),
  opponentHash: z.string(),
  rate: proportionSchema,
});
export type Matchup = z.infer<typeof matchupSchema>;

export const cardSummarySchema = z.strictObject({
  definitionId: z.string(),
  /** Distinct decks in the run that ran at least one copy. */
  decksIncluding: z.number().int().min(0),
  /** Seat-matches in which the card was in the deck. */
  seatMatches: z.number().int().min(0),
  copiesPerDeck: z.number(),

  winRateWhenIncluded: proportionSchema,
  winRateWhenAbsent: proportionSchema,
  /** Simple difference of the two above. A correlation, and labelled as one. */
  inclusionWinRateLift: z.number(),

  drawRate: z.number(),
  playRatePerDrawn: z.number(),
  activationsPerMatch: z.number(),
  averageEnergySpent: z.number(),

  averageDamageToPlayers: z.number(),
  averageDamageToUnits: z.number(),
  averageHealing: z.number(),
  averageCardsDrawnBy: z.number(),
  averageTokensCreated: z.number(),
  averageTriggers: z.number(),
  averageTurnsOnBattlefield: z.number(),
  averageAttacks: z.number(),
  averageBlocks: z.number(),

  /** Copy counts by dead-hand category, and the share of *seen* copies dead. */
  deadHand: z.record(z.string(), z.number().int().min(0)),
  deadInHandShare: z.number(),
  removalRate: z.number(),
});
export type CardSummary = z.infer<typeof cardSummarySchema>;

export const aggregateSchema = z.strictObject({
  run: runSummarySchema,
  decks: z.array(deckSummarySchema),
  matchups: z.array(matchupSchema),
  cards: z.array(cardSummarySchema),
});
export type Aggregate = z.infer<typeof aggregateSchema>;

/** Canonical processing order. Everything downstream depends on this. */
export function inOrder(records: readonly MatchRecord[]): MatchRecord[] {
  return [...records].sort((left, right) => left.orderKey.localeCompare(right.orderKey));
}

export function usableRecords(records: readonly MatchRecord[]): MatchRecord[] {
  return inOrder(records).filter((record) => !isAbnormal(record.termination));
}

export function aggregate(
  records: readonly MatchRecord[],
  options: { readonly confidence?: number } = {},
): Aggregate {
  const confidence = options.confidence ?? 0.95;
  const all = inOrder(records);
  const usable = all.filter((record) => !isAbnormal(record.termination));

  return {
    run: summarizeRun(all, usable, confidence),
    decks: summarizeDecks(usable, confidence),
    matchups: summarizeMatchups(usable, confidence),
    cards: summarizeCards(usable, confidence),
  };
}

function summarizeRun(
  all: readonly MatchRecord[],
  usable: readonly MatchRecord[],
  confidence: number,
): RunSummary {
  const terminations: Record<string, number> = {};
  const endReasons: Record<string, number> = {};
  for (const record of all) {
    terminations[record.termination] = (terminations[record.termination] ?? 0) + 1;
    const reason = record.endReason ?? 'none';
    endReasons[reason] = (endReasons[reason] ?? 0) + 1;
  }

  const turns = usable.map((record) => record.turns);
  const seatWins = new Map<number, { wins: number; total: number }>();
  const pilotWins = new Map<string, { wins: number; total: number }>();

  for (const record of usable) {
    for (const seat of record.seats) {
      const bySeat = seatWins.get(seat.seatIndex) ?? { wins: 0, total: 0 };
      bySeat.total += 1;
      if (seat.won) bySeat.wins += 1;
      seatWins.set(seat.seatIndex, bySeat);

      const byPilot = pilotWins.get(seat.pilotId) ?? { wins: 0, total: 0 };
      byPilot.total += 1;
      if (seat.won) byPilot.wins += 1;
      pilotWins.set(seat.pilotId, byPilot);
    }
  }

  return {
    matches: all.length,
    usableMatches: usable.length,
    abnormalMatches: all.length - usable.length,
    abnormalShare: all.length === 0 ? 0 : round((all.length - usable.length) / all.length),
    terminations,
    endReasons,
    draws: usable.filter((record) => record.outcome === 'draw').length,
    turns: {
      mean: round(mean(turns), 2),
      median: percentile(turns, 0.5),
      p10: percentile(turns, 0.1),
      p90: percentile(turns, 0.9),
      max: turns.length === 0 ? 0 : Math.max(...turns),
    },
    decisionsPerMatch: round(mean(usable.map((record) => record.decisions)), 2),
    botFailures: all.reduce((sum, record) => sum + record.botFailures.length, 0),
    seatWinRates: [...seatWins]
      .sort((left, right) => left[0] - right[0])
      .map(([seatIndex, tally]) => ({
        seatIndex,
        rate: rounded(proportion(tally.wins, tally.total, confidence)),
      })),
    pilotWinRates: [...pilotWins]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([pilotId, tally]) => ({
        pilotId,
        rate: rounded(proportion(tally.wins, tally.total, confidence)),
      })),
    environments: [...new Set(all.map((record) => record.environmentId))].sort(),
  };
}

interface DeckTally {
  deckId: string;
  commanderId: string;
  wins: number;
  total: number;
  turns: number[];
  damageDealt: number[];
  damageTaken: number[];
  bySeat: Map<number, { wins: number; total: number }>;
}

function summarizeDecks(usable: readonly MatchRecord[], confidence: number): DeckSummary[] {
  const tallies = new Map<string, DeckTally>();

  for (const record of usable) {
    for (const seat of record.seats) {
      let tally = tallies.get(seat.deckHash);
      if (!tally) {
        tally = {
          deckId: seat.deckId,
          commanderId: seat.commanderId,
          wins: 0,
          total: 0,
          turns: [],
          damageDealt: [],
          damageTaken: [],
          bySeat: new Map(),
        };
        tallies.set(seat.deckHash, tally);
      }
      tally.total += 1;
      if (seat.won) tally.wins += 1;
      tally.turns.push(record.turns);
      tally.damageDealt.push(seat.damageDealtToPlayers);
      tally.damageTaken.push(seat.damageTaken);

      const bySeat = tally.bySeat.get(seat.seatIndex) ?? { wins: 0, total: 0 };
      bySeat.total += 1;
      if (seat.won) bySeat.wins += 1;
      tally.bySeat.set(seat.seatIndex, bySeat);
    }
  }

  return [...tallies]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([deckHash, tally]) => ({
      deckHash,
      deckId: tally.deckId,
      commanderId: tally.commanderId,
      matches: tally.total,
      winRate: rounded(proportion(tally.wins, tally.total, confidence)),
      bySeat: [...tally.bySeat]
        .sort((left, right) => left[0] - right[0])
        .map(([seatIndex, seatTally]) => ({
          seatIndex,
          rate: rounded(proportion(seatTally.wins, seatTally.total, confidence)),
        })),
      averageTurns: round(mean(tally.turns), 2),
      averageDamageDealt: round(mean(tally.damageDealt), 2),
      averageDamageTaken: round(mean(tally.damageTaken), 2),
    }));
}

function summarizeMatchups(usable: readonly MatchRecord[], confidence: number): Matchup[] {
  const tallies = new Map<string, { wins: number; total: number }>();

  for (const record of usable) {
    for (const seat of record.seats) {
      for (const other of record.seats) {
        if (other.deckHash === seat.deckHash && other.playerId === seat.playerId) continue;
        if (other.playerId === seat.playerId) continue;
        const key = `${seat.deckHash}§${other.deckHash}`;
        const tally = tallies.get(key) ?? { wins: 0, total: 0 };
        tally.total += 1;
        if (seat.won) tally.wins += 1;
        tallies.set(key, tally);
      }
    }
  }

  return [...tallies]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, tally]) => {
      const [deckHash = '', opponentHash = ''] = key.split('§');
      return {
        deckHash,
        opponentHash,
        rate: rounded(proportion(tally.wins, tally.total, confidence)),
      };
    });
}

interface CardTally {
  decks: Set<string>;
  seatMatches: number;
  copies: number;
  wins: number;
  drawn: number;
  played: number;
  activations: number;
  energy: number;
  damagePlayers: number;
  damageUnits: number;
  healing: number;
  drawnBy: number;
  tokens: number;
  triggers: number;
  battlefieldTurns: number;
  attacks: number;
  blocks: number;
  removed: number;
  dead: Record<string, number>;
}

function emptyCardTally(): CardTally {
  return {
    decks: new Set(),
    seatMatches: 0,
    copies: 0,
    wins: 0,
    drawn: 0,
    played: 0,
    activations: 0,
    energy: 0,
    damagePlayers: 0,
    damageUnits: 0,
    healing: 0,
    drawnBy: 0,
    tokens: 0,
    triggers: 0,
    battlefieldTurns: 0,
    attacks: 0,
    blocks: 0,
    removed: 0,
    dead: Object.fromEntries(DEAD_HAND_CATEGORIES.map((category) => [category, 0])),
  };
}

function summarizeCards(usable: readonly MatchRecord[], confidence: number): CardSummary[] {
  const tallies = new Map<string, CardTally>();
  /** Seat-matches in which a card was *not* in the deck, and whether they won. */
  const absence = new Map<string, { wins: number; total: number }>();
  const everSeen = new Set<string>();

  for (const record of usable) {
    for (const card of record.cards) {
      if (card.copiesInDeck > 0) everSeen.add(card.definitionId);
    }
  }

  for (const record of usable) {
    for (const seat of record.seats) {
      const seatCards = record.cards.filter((card) => card.playerId === seat.playerId);
      const included = new Set(
        seatCards.filter((card) => card.copiesInDeck > 0).map((card) => card.definitionId),
      );

      for (const definitionId of [...everSeen].sort()) {
        if (included.has(definitionId)) continue;
        const tally = absence.get(definitionId) ?? { wins: 0, total: 0 };
        tally.total += 1;
        if (seat.won) tally.wins += 1;
        absence.set(definitionId, tally);
      }

      for (const card of seatCards) {
        if (card.copiesInDeck === 0) continue;
        let tally = tallies.get(card.definitionId);
        if (!tally) {
          tally = emptyCardTally();
          tallies.set(card.definitionId, tally);
        }
        tally.decks.add(seat.deckHash);
        tally.seatMatches += 1;
        tally.copies += card.copiesInDeck;
        if (seat.won) tally.wins += 1;
        tally.drawn += card.timesDrawn;
        tally.played += card.timesPlayed;
        tally.activations += card.timesActivated;
        tally.energy += card.energySpent;
        tally.damagePlayers += card.damageToPlayers;
        tally.damageUnits += card.damageToUnits;
        tally.healing += card.healingDone;
        tally.drawnBy += card.cardsDrawnBy;
        tally.tokens += card.tokensCreated;
        tally.triggers += card.triggersFired;
        tally.battlefieldTurns += card.turnsOnBattlefield;
        tally.attacks += card.attacksMade;
        tally.blocks += card.blocksMade;
        tally.removed += card.timesDefeated + card.timesRemoved;
        for (const category of DEAD_HAND_CATEGORIES) {
          tally.dead[category] = (tally.dead[category] ?? 0) + (card.deadHand[category] ?? 0);
        }
      }
    }
  }

  return [...tallies]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([definitionId, tally]) => {
      const included = proportion(tally.wins, tally.seatMatches, confidence);
      const missing = absence.get(definitionId) ?? { wins: 0, total: 0 };
      const absent = proportion(missing.wins, missing.total, confidence);

      const seenCopies =
        (tally.dead.never_affordable ?? 0) +
        (tally.dead.no_legal_window ?? 0) +
        (tally.dead.legal_but_unchosen ?? 0) +
        (tally.dead.used ?? 0);
      const deadCopies =
        (tally.dead.never_affordable ?? 0) +
        (tally.dead.no_legal_window ?? 0) +
        (tally.dead.legal_but_unchosen ?? 0);

      const per = (value: number): number =>
        tally.seatMatches === 0 ? 0 : round(value / tally.seatMatches, 3);

      return {
        definitionId,
        decksIncluding: tally.decks.size,
        seatMatches: tally.seatMatches,
        copiesPerDeck: per(tally.copies),
        winRateWhenIncluded: rounded(included),
        winRateWhenAbsent: rounded(absent),
        inclusionWinRateLift: round(included.point - absent.point),
        drawRate: tally.copies === 0 ? 0 : round(tally.drawn / tally.copies, 3),
        playRatePerDrawn: tally.drawn === 0 ? 0 : round(tally.played / tally.drawn, 3),
        activationsPerMatch: per(tally.activations),
        averageEnergySpent: per(tally.energy),
        averageDamageToPlayers: per(tally.damagePlayers),
        averageDamageToUnits: per(tally.damageUnits),
        averageHealing: per(tally.healing),
        averageCardsDrawnBy: per(tally.drawnBy),
        averageTokensCreated: per(tally.tokens),
        averageTriggers: per(tally.triggers),
        averageTurnsOnBattlefield: per(tally.battlefieldTurns),
        averageAttacks: per(tally.attacks),
        averageBlocks: per(tally.blocks),
        deadHand: { ...tally.dead },
        deadInHandShare: seenCopies === 0 ? 0 : round(deadCopies / seenCopies, 3),
        removalRate: tally.played === 0 ? 0 : round(tally.removed / tally.played, 3),
      };
    });
}
