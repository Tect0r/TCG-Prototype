import type { StallDefinition } from '@tcg/board-telemetry';
import type { MatchRecord } from '../telemetry/schema.js';
import { mean, percentile, round } from './stats.js';

/**
 * Board telemetry across a batch (M04.3).
 *
 * M04 exists to decide whether an unbounded battlefield (`CLAUDE.md`, "The
 * battlefield has no Unit limit") produces clutter, long turns, trigger overload
 * or meaningful stalls. Every one of those is a claim about a population of
 * matches, and until M04.1 only a watched match measured anything at all. This
 * module is the batch-level reading: it aggregates the per-match `board` block
 * every record now carries, and it aggregates rather than re-derives — nothing
 * here touches an event stream, so a number in a report cannot disagree with the
 * record it came from.
 *
 * **Distributions, not averages.** Each measure carries its maximum, its mean and
 * its 90th percentile, plus the match the maximum came from. A mean peak board of
 * six with a maximum of sixty is the finding; a mean on its own hides it, and
 * clutter is a question about the worst boards rather than the typical one.
 *
 * **The stall verdict is read, never computed.** The rule lives in
 * `@tcg/board-telemetry/stall` and is applied where the evidence is collected, so
 * this module counts verdicts and never decides one. If a batch somehow mixes
 * records cut under different rules, that is reported rather than averaged away:
 * a stall count is meaningless unless every record behind it was asked the same
 * question.
 */

/** One measure over the batch. `matchId` names the match the maximum came from. */
export interface BoardMeasure {
  readonly max: number;
  readonly mean: number;
  readonly p90: number;
  readonly matchId: string | null;
}

export interface BoardAggregate {
  readonly matches: number;

  /* ------------------------------------------------------------- clutter */
  /** Widest board any single seat held, per match. */
  readonly peakUnits: BoardMeasure;
  readonly peakNonTokenUnits: BoardMeasure;
  /** Largest group of identical Tokens one seat held — one visual stack. */
  readonly peakTokenStack: BoardMeasure;

  /* ----------------------------------------------------------- long turns */
  /** Accepted actions in the busiest turn of the match. */
  readonly longestTurnActions: BoardMeasure;
  readonly largestCombatAttackers: BoardMeasure;
  /** Engine events spent resolving the most expensive combat. */
  readonly longestCombatEvents: BoardMeasure;

  /* ----------------------------------------------------- trigger overload */
  readonly busiestTurnTriggers: BoardMeasure;
  readonly busiestTurnChoices: BoardMeasure;

  /* ------------------------------------------------------------- stalling */
  /**
   * The rule every verdict below was cut with, or `null` when the batch mixed
   * rules and the counts must not be read as one population.
   */
  readonly stallDefinition: StallDefinition | null;
  readonly mixedStallDefinitions: boolean;
  readonly stalledMatches: number;
  /** Matches classified `stalled`, up to a readable number of them. */
  readonly stalledMatchIds: readonly string[];
  /** Consecutive rounds every living seat could have attacked in and none did. */
  readonly stallStreak: BoardMeasure;
  /** The permissive series, for contrast. Not what the verdict reads. */
  readonly declinedStreak: BoardMeasure;
  readonly unableStreak: BoardMeasure;

  /* ------------------------------------------------ raw attack opportunity */
  readonly attackSteps: number;
  readonly attackStepsAble: number;
  readonly attackStepsDeclined: number;
  readonly attackStepsUnable: number;
  readonly readyPreventions: number;
}

/** How many stalled match IDs a report is willing to name before deferring. */
const STALLED_ID_LIMIT = 20;

const EMPTY_MEASURE: BoardMeasure = Object.freeze({ max: 0, mean: 0, p90: 0, matchId: null });

export function aggregateBoard(records: readonly MatchRecord[]): BoardAggregate {
  const measure = (of: (record: MatchRecord) => number): BoardMeasure => measureOver(records, of);

  // A definition is shared only if every record agrees on every field of it.
  const definitions = new Set(
    records.map((record) => JSON.stringify(record.board.attackOpportunity.stallDefinition)),
  );
  const mixedStallDefinitions = definitions.size > 1;
  const first = records[0]?.board.attackOpportunity.stallDefinition ?? null;

  const stalled = records.filter(
    (record) => record.board.attackOpportunity.classification === 'stalled',
  );

  let attackSteps = 0;
  let attackStepsAble = 0;
  let attackStepsDeclined = 0;
  let attackStepsUnable = 0;
  let readyPreventions = 0;
  for (const record of records) {
    const opportunity = record.board.attackOpportunity;
    attackSteps += opportunity.steps;
    attackStepsAble += opportunity.able;
    attackStepsDeclined += opportunity.declined;
    attackStepsUnable += opportunity.unable;
    readyPreventions += opportunity.readyPreventions;
  }

  return {
    matches: records.length,

    peakUnits: measure((record) => maxOverSeats(record, (seat) => seat.peakUnits)),
    peakNonTokenUnits: measure((record) => maxOverSeats(record, (seat) => seat.peakNonTokenUnits)),
    peakTokenStack: measure((record) => maxOverSeats(record, (seat) => seat.peakTokenStack)),

    longestTurnActions: measure((record) => record.board.longestTurn.actions),
    largestCombatAttackers: measure((record) => record.board.largestCombat.attackers),
    longestCombatEvents: measure((record) => record.board.longestCombatResolution.resolutionEvents),

    busiestTurnTriggers: measure((record) => record.board.busiestTurn.triggers),
    busiestTurnChoices: measure((record) => record.board.busiestTurn.choices),

    // Withheld rather than guessed when the batch is not one population.
    stallDefinition: mixedStallDefinitions ? null : first,
    mixedStallDefinitions,
    stalledMatches: stalled.length,
    stalledMatchIds: stalled.slice(0, STALLED_ID_LIMIT).map((record) => record.matchId),
    stallStreak: measure((record) => record.board.attackOpportunity.longestUnanimousDeclinedStreak),
    declinedStreak: measure((record) => record.board.attackOpportunity.longestDeclinedStreak),
    unableStreak: measure((record) => record.board.attackOpportunity.longestUnableStreak),

    attackSteps,
    attackStepsAble,
    attackStepsDeclined,
    attackStepsUnable,
    readyPreventions,
  };
}

function maxOverSeats(
  record: MatchRecord,
  of: (seat: MatchRecord['board']['seats'][number]) => number,
): number {
  let largest = 0;
  for (const seat of record.board.seats) {
    const value = of(seat);
    if (value > largest) largest = value;
  }
  return largest;
}

function measureOver(
  records: readonly MatchRecord[],
  of: (record: MatchRecord) => number,
): BoardMeasure {
  if (records.length === 0) return { ...EMPTY_MEASURE };

  const values: number[] = [];
  let max = Number.NEGATIVE_INFINITY;
  let matchId: string | null = null;
  for (const record of records) {
    const value = of(record);
    values.push(value);
    // Strictly greater, so a tie names the earliest match in record order rather
    // than whichever one happened to be read last.
    if (value > max) {
      max = value;
      matchId = record.matchId;
    }
  }

  return {
    max: max === Number.NEGATIVE_INFINITY ? 0 : max,
    mean: round(mean(values), 2),
    p90: round(percentile(values, 0.9), 2),
    matchId,
  };
}
