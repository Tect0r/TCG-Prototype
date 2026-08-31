import { z } from 'zod';
import { agentClassOf } from '@tcg/bot-interface';
import { poolFor, poolReportFor, type GenerationEnvironment } from '@tcg/deck-generator';
import {
  DEAD_HAND_CATEGORIES,
  DEAD_IN_HAND_CATEGORIES,
  MECHANICALLY_UNUSABLE_CATEGORIES,
  STRATEGICALLY_UNUSED_CATEGORIES,
  isAbnormal,
  type MatchRecord,
} from '../telemetry/schema.js';
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
  /**
   * Win rate by honest agent class (M05.4).
   *
   * Reported *beside* the pilot rates rather than instead of them, and
   * deliberately never combined into one number: `random_legal` and a heuristic
   * are two instruments, not two skill levels, and averaging them would produce
   * exactly the pooled skill distribution M05.4 forbids. `agentClass` is a class
   * ID, or `unclassified` for a pilot this build does not know.
   */
  agentClassWinRates: z.array(
    z.strictObject({
      agentClass: z.string(),
      pilotIds: z.array(z.string()),
      rate: proportionSchema,
    }),
  ),
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

/**
 * What one Commander's legal pool says about a card (M08.12).
 *
 * A card is not unpopular in a deck whose Commander could never legally
 * include it, so eligibility is read per Commander before it is read at all.
 * `legalPoolSize` and `forcedInclusionFloor` are `poolReportFor`'s own numbers
 * (`@tcg/deck-generator`), carried rather than recomputed, and are `null` when
 * `eligible` is `false` — a floor is a statement about a legal pool, and has
 * nothing to say about a card that pool does not contain.
 */
export const cardCommanderInclusionSchema = z.strictObject({
  commanderId: z.string(),
  /** Distinct decks in the run seated behind this Commander. */
  decksUnderCommander: z.number().int().min(0),
  eligible: z.boolean(),
  /** Of `decksUnderCommander`, how many ran at least one copy. */
  decksIncluding: z.number().int().min(0),
  legalPoolSize: z.number().int().min(0).nullable(),
  forcedInclusionFloor: z.number().int().min(0).nullable(),
});
export type CardCommanderInclusion = z.infer<typeof cardCommanderInclusionSchema>;

export const cardSummarySchema = z.strictObject({
  definitionId: z.string(),
  /** Distinct decks in the run that ran at least one copy. */
  decksIncluding: z.number().int().min(0),
  /**
   * Distinct decks in the run whose Commander could legally run this card,
   * whether or not they chose to. `null` when eligibility was not computed for
   * this aggregation (no environment was supplied) — never a guess.
   */
  eligibleDecks: z.number().int().min(0).nullable(),
  /** `decksIncluding / eligibleDecks`. `null` on the same terms as the above. */
  inclusionAmongEligibleShare: z.number().nullable(),
  /** Eligibility and inclusion, broken out by the Commanders this run seated. */
  perCommander: z.array(cardCommanderInclusionSchema),
  /** Seat-matches in which the card was in the deck. */
  seatMatches: z.number().int().min(0),
  copiesPerDeck: z.number(),

  winRateWhenIncluded: proportionSchema,
  winRateWhenAbsent: proportionSchema,
  /**
   * Simple difference of the two above. A correlation, and labelled as one.
   *
   * `null` — read as `insufficient_data` — when either comparison group has no
   * observations. A card nobody ever left out, or nobody ever ran, has no
   * contrast to report; treating a fabricated 0% as the other side of the
   * comparison was the defect M08.12 fixes.
   */
  inclusionWinRateLift: z.number().nullable(),

  drawRate: z.number(),

  /* ------------------------------------- play metrics (PHASE4_HARDENING §8.1) */
  /**
   * Play events per draw event. **Unbounded** — a card returned to hand and
   * replayed, or copied, legitimately exceeds 1.
   *
   * This is the number that used to be called `playRatePerDrawn` and formatted
   * as a percentage, which made "112%" a thing a report could print. It is kept,
   * under a name that says what it is, because "how many times does this card
   * get cast per draw" is a real question — it just is not a rate.
   */
  playsPerDraw: z.number(),
  /**
   * Distinct drawn copies played at least once, over distinct drawn copies.
   * Bounded 0–1. `null` when the records predate per-copy tracking.
   */
  drawnCopyPlayConversion: z.number().nullable(),
  /**
   * Games in which the card was drawn *and* played, over games in which it was
   * drawn. Bounded 0–1.
   */
  gamesDrawnAndPlayedShare: z.number(),
  /** Games in which at least one copy reached hand. Denominator of the above. */
  gamesDrawn: z.number().int().min(0),

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
  /**
   * Dead share split by what it means (PHASE4_HARDENING §8.2).
   *
   * `mechanicallyUnusable` is a fact about the card and the board;
   * `strategicallyUnused` is a fact about the pilot. A high second number with a
   * low first one says the pilots do not want the card, which is a different
   * finding from "the card could not be played".
   */
  mechanicallyUnusableShare: z.number(),
  strategicallyUnusedShare: z.number(),
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
  options: {
    readonly confidence?: number;
    /**
     * Supplies the legal pool per Commander (M08.12). Omitted callers — a
     * baseline/candidate comparison has no single environment to hand in, and
     * the `analysis.test.ts` unit fixtures predate this field — get
     * `eligibleDecks: null` and an empty `perCommander` rather than a guess:
     * eligibility is either read from the format or left unstated, never
     * assumed.
     */
    readonly environment?: GenerationEnvironment;
  } = {},
): Aggregate {
  const confidence = options.confidence ?? 0.95;
  const all = inOrder(records);
  const usable = all.filter((record) => !isAbnormal(record.termination));

  return {
    run: summarizeRun(all, usable, confidence),
    decks: summarizeDecks(usable, confidence),
    matchups: summarizeMatchups(usable, confidence),
    cards: summarizeCards(usable, confidence, options.environment),
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
  const classWins = new Map<string, { wins: number; total: number; pilots: Set<string> }>();

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

      // A pilot this build does not know is bucketed apart rather than guessed
      // at: an unrecognised ID is an unvouched-for agent, not a weak one.
      const key = agentClassOf(seat.pilotId) ?? 'unclassified';
      const byClass = classWins.get(key) ?? { wins: 0, total: 0, pilots: new Set<string>() };
      byClass.total += 1;
      if (seat.won) byClass.wins += 1;
      byClass.pilots.add(seat.pilotId);
      classWins.set(key, byClass);
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
    agentClassWinRates: [...classWins]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([agentClass, tally]) => ({
        agentClass,
        pilotIds: [...tally.pilots].sort(),
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
  drawnCopies: number;
  drawnCopiesPlayed: number;
  gamesDrawn: number;
  gamesDrawnAndPlayed: number;
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
    drawnCopies: 0,
    drawnCopiesPlayed: 0,
    gamesDrawn: 0,
    gamesDrawnAndPlayed: 0,
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

/** A Commander's legal pool and forced-inclusion floor, read once per run (M08.12). */
interface CommanderEligibility {
  readonly legalPool: ReadonlySet<string>;
  readonly legalPoolSize: number;
  readonly forcedInclusionFloor: number;
}

function summarizeCards(
  usable: readonly MatchRecord[],
  confidence: number,
  environment: GenerationEnvironment | undefined,
): CardSummary[] {
  const tallies = new Map<string, CardTally>();
  /** Seat-matches in which a card was *not* in the deck, and whether they won. */
  const absence = new Map<string, { wins: number; total: number }>();
  const everSeen = new Set<string>();
  const deckCommander = new Map<string, string>();
  const decksByCommander = new Map<string, Set<string>>();

  for (const record of usable) {
    for (const card of record.cards) {
      if (card.copiesInDeck > 0) everSeen.add(card.definitionId);
    }
    for (const seat of record.seats) {
      deckCommander.set(seat.deckHash, seat.commanderId);
      let decks = decksByCommander.get(seat.commanderId);
      if (!decks) {
        decks = new Set();
        decksByCommander.set(seat.commanderId, decks);
      }
      decks.add(seat.deckHash);
    }
  }

  // Read once per Commander this run seated, never recomputed per card: the
  // legal pool and the forced-inclusion floor are properties of the Commander
  // and the format, not of any one card (M08.12).
  const eligibility = new Map<string, CommanderEligibility>();
  if (environment) {
    for (const commanderId of decksByCommander.keys()) {
      const commander = environment.database.get(commanderId);
      if (!commander) continue;
      const report = poolReportFor(environment, commander);
      eligibility.set(commanderId, {
        legalPool: new Set(poolFor(environment, commander).map((card) => card.id)),
        legalPoolSize: report.legalPoolSize,
        forcedInclusionFloor: report.forcedInclusionFloor,
      });
    }
  }
  // Two different defaults for two different situations, never conflated:
  // no `environment` at all means eligibility was not computed and every seat
  // counts as before (`true`, unconditionally); an `environment` that does not
  // recognise a Commander this run seated is eligibility that could not be
  // read, so it defaults closed (`false`) — the same default `perCommander`
  // below uses for the same case, so the two never disagree about one row.
  const isEligible = (commanderId: string, definitionId: string): boolean => {
    if (!environment) return true;
    return eligibility.get(commanderId)?.legalPool.has(definitionId) ?? false;
  };

  for (const record of usable) {
    for (const seat of record.seats) {
      const seatCards = record.cards.filter((card) => card.playerId === seat.playerId);
      const included = new Set(
        seatCards.filter((card) => card.copiesInDeck > 0).map((card) => card.definitionId),
      );

      for (const definitionId of [...everSeen].sort()) {
        if (included.has(definitionId)) continue;
        // A deck whose Commander could never legally run this card is not
        // choosing to leave it out, so it is not a contrast the "absent" side
        // may count (M08.12's eligibility-aware denominator). `isEligible`
        // defaults open only when no environment was supplied at all — see its
        // definition above.
        if (!isEligible(seat.commanderId, definitionId)) continue;
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
        tally.drawnCopies += card.drawnCopies;
        tally.drawnCopiesPlayed += card.drawnCopiesPlayed;
        if (card.drawnCopies > 0) {
          tally.gamesDrawn += 1;
          if (card.timesPlayed > 0 || card.timesActivated > 0) tally.gamesDrawnAndPlayed += 1;
        }
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

      const sumOf = (categories: readonly string[]): number =>
        categories.reduce((sum, category) => sum + (tally.dead[category] ?? 0), 0);

      const deadCopies = sumOf(DEAD_IN_HAND_CATEGORIES);
      const seenCopies = deadCopies + (tally.dead.used ?? 0);
      const mechanical = sumOf(MECHANICALLY_UNUSABLE_CATEGORIES);
      const strategic = sumOf(STRATEGICALLY_UNUSED_CATEGORIES);

      const per = (value: number): number =>
        tally.seatMatches === 0 ? 0 : round(value / tally.seatMatches, 3);

      const perCommander: CardCommanderInclusion[] = environment
        ? [...decksByCommander.entries()]
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([commanderId, decks]) => {
              const commanderEligibility = eligibility.get(commanderId) ?? null;
              const eligible = commanderEligibility?.legalPool.has(definitionId) ?? false;
              const decksIncludingUnderCommander = [...tally.decks].filter(
                (deckHash) => deckCommander.get(deckHash) === commanderId,
              ).length;
              return {
                commanderId,
                decksUnderCommander: decks.size,
                eligible,
                decksIncluding: decksIncludingUnderCommander,
                legalPoolSize: eligible ? (commanderEligibility?.legalPoolSize ?? null) : null,
                forcedInclusionFloor: eligible
                  ? (commanderEligibility?.forcedInclusionFloor ?? null)
                  : null,
              };
            })
        : [];
      const eligibleEntries = perCommander.filter((entry) => entry.eligible);
      const eligibleDecks = environment
        ? eligibleEntries.reduce((sum, entry) => sum + entry.decksUnderCommander, 0)
        : null;
      // The numerator is drawn from the same eligible entries as the
      // denominator — never `tally.decks.size` (every deck that ran the card,
      // eligible or not) — so the two sides describe the same population and
      // the share cannot exceed 1 (M08.12).
      const inclusionAmongEligibleShare =
        eligibleDecks === null || eligibleDecks === 0
          ? null
          : round(
              eligibleEntries.reduce((sum, entry) => sum + entry.decksIncluding, 0) / eligibleDecks,
              4,
            );
      // Zero observations are not a zero win rate (M08.12): a contrast where
      // either side never played is `insufficient_data`, never a fabricated
      // point difference.
      const inclusionWinRateLift =
        included.total === 0 || absent.total === 0 ? null : round(included.point - absent.point);

      return {
        definitionId,
        decksIncluding: tally.decks.size,
        eligibleDecks,
        inclusionAmongEligibleShare,
        perCommander,
        seatMatches: tally.seatMatches,
        copiesPerDeck: per(tally.copies),
        winRateWhenIncluded: rounded(included),
        winRateWhenAbsent: rounded(absent),
        inclusionWinRateLift,
        drawRate: tally.copies === 0 ? 0 : round(tally.drawn / tally.copies, 3),
        playsPerDraw: tally.drawn === 0 ? 0 : round(tally.played / tally.drawn, 3),
        drawnCopyPlayConversion:
          tally.drawnCopies === 0 ? null : round(tally.drawnCopiesPlayed / tally.drawnCopies, 3),
        gamesDrawnAndPlayedShare:
          tally.gamesDrawn === 0 ? 0 : round(tally.gamesDrawnAndPlayed / tally.gamesDrawn, 3),
        gamesDrawn: tally.gamesDrawn,
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
        mechanicallyUnusableShare: seenCopies === 0 ? 0 : round(mechanical / seenCopies, 3),
        strategicallyUnusedShare: seenCopies === 0 ? 0 : round(strategic / seenCopies, 3),
        removalRate: tally.played === 0 ? 0 : round(tally.removed / tally.played, 3),
      };
    });
}
