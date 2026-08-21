import {
  CURRENT_BOT_CONFIG_VERSIONS,
  BOT_SUMMARY_SCHEMA_VERSION,
  configuredCommanderIdOf,
  deckModeGenerates,
  publicDeckSourceOf,
  type BotDecisionCategory,
  type BotPacingBudgets,
  type BotSeatConfig,
} from '@tcg/bot-config';
import {
  ALWAYS_TRUE_SUMMARY_LIMITS,
  CURRENT_VERSIONS,
  EMPTY_BOT_WAIT_STATS,
  emptyCategoryCounts,
  mergeWaitStats,
  unionSpanMs,
  waitStatsOf,
  type BotMatchSummary,
  type BotSeatSummary,
  type BotSummaryLimit,
  type BotWaitStats,
  type SeatId,
} from '@tcg/protocol';
import type { MatchState } from '@tcg/rules-engine';
import type { BotDelayRecord, BotRunReport } from './bot-runner.js';

/**
 * The pacing and bot-provenance summary, built (M09.17).
 *
 * A pure function over three things the server already has — the frozen budgets,
 * the runner's report, and the final `MatchState` — plus two clock readings. Pure
 * because the acceptance this tranche owes is arithmetic over a fake clock, and a
 * builder that read a real one, or reached into a lobby, could not be asserted to
 * the millisecond.
 *
 * Two decisions in here are worth stating rather than leaving to be read out of
 * the code.
 *
 * **Time is measured, engine progress is counted, and they never mix.** The
 * summary's `clock` and `engine` objects are built from different sources and
 * share no key. A pacing percentage changes every number in the first and none in
 * the second, which is a property the suite proves by replaying one seed at two
 * percentages rather than a sentence anybody has to trust.
 *
 * **What a table spent waiting is a union, not a sum.** Three bots offered the
 * same Reaction window wait concurrently (M09.12), so adding their waits together
 * would report a match that spent more time waiting than it lasted. `botPacingMs`
 * is therefore the wall-clock time during which *at least one* bot was waiting,
 * and the per-seat sum is reported beside it under its own name — with
 * `concurrent_waits_overlap` recorded when, and only when, the two differ.
 */

/* ------------------------------------------------------- the ingestion seam */

/**
 * Where a finished match's summary goes after it has been broadcast.
 *
 * **This is the seam M08 will use, and it is deliberately the whole of it.** One
 * method, one call site, one argument that is already a validated wire shape. A
 * durable Player Meta store is an implementation of this interface and a line in
 * the server's options; it is not a reshaping of the summary, a second producer,
 * or a hook anywhere inside the match loop.
 *
 * What it is emphatically *not* is a promise that anything is kept. M09 ships no
 * implementation that retains a summary past the process — see
 * `NO_DURABLE_SUMMARY_STORE` — and the record itself says so, in
 * `BOT_SUMMARY_LIMITS`, so a reader of an exported file learns the limitation
 * from the file rather than from this comment.
 *
 * `receive` returns `void` and is called inside a `try`. A sink that throws is
 * recorded and stepped over: a match that has just ended must not fail to
 * publish its result because something downstream of it was unavailable.
 */
export interface BotSummarySink {
  /** Names the sink in a diagnostic. Stable for the life of the implementation. */
  readonly sinkId: string;
  receive(summary: BotMatchSummary): void;
}

/**
 * The claim M09 is allowed to make about retention, in one place so that a
 * future tranche which starts keeping summaries has to delete a constant rather
 * than quietly outgrow a comment.
 */
export const NO_DURABLE_SUMMARY_STORE =
  'This summary is produced for one match and held nowhere. The server writes no ' +
  'file, keeps no history and aggregates nothing across matches; when the lobby ' +
  'goes, so does the summary. A durable store is M08 Player Meta and does not ' +
  'exist yet.';

/* ------------------------------------------------------------- the builder */

/** One bot seat, as the summary needs to know it. */
export interface BotSummarySeat {
  readonly seatId: SeatId;
  readonly config: BotSeatConfig;
  /**
   * The Commander this seat actually led, when its configuration cannot say.
   *
   * `exact_precon` names a precon rather than a Commander — the precon owns that
   * fact and duplicating it into the configuration would create a second place
   * for it to be wrong — so the caller resolves it from the deck the server
   * built and passes it here.
   */
  readonly commanderId: string | null;
}

export interface BotMatchSummaryInput {
  readonly matchId: string;
  /** The budgets the lobby froze at match start. Every percentage is of these. */
  readonly budgets: BotPacingBudgets;
  readonly seats: readonly BotSummarySeat[];
  readonly report: BotRunReport;
  readonly state: MatchState | null;
  /** Monotonic readings, from the same clock the runner timed its waits on. */
  readonly startedAtMs: number;
  readonly endedAtMs: number;
}

export function buildBotMatchSummary(input: BotMatchSummaryInput): BotMatchSummary {
  const configBySeat = new Map(input.seats.map((seat) => [seat.seatId, seat]));

  const seats: BotSeatSummary[] = [];
  const allWaits: BotDelayRecord[] = [];
  const totalsByCategory = emptyCategoryCounts();
  let totalDecisions = 0;
  let totalPilotFailures = 0;
  let totalIncidents = 0;

  for (const activity of input.report.seats) {
    const seat = configBySeat.get(activity.seatId);
    // A seat the lobby no longer holds cannot be described honestly: its deck
    // source and its Commander are gone, and inventing either would put a
    // guess in a provenance record. Skipped rather than half-reported.
    if (!seat) continue;

    const incidents = input.report.incidents.filter((entry) => entry.seatId === activity.seatId);
    const pilotFailures = countBy(
      incidents.flatMap((entry) => (entry.pilotFailure === null ? [] : [entry.pilotFailure])),
    );
    const incidentCounts = countBy(incidents.map((entry) => entry.kind));

    allWaits.push(...activity.delays);
    totalDecisions += activity.decisions;
    for (const category of CATEGORIES) {
      totalsByCategory[category] += activity.decisionsByCategory[category];
    }
    totalPilotFailures += Object.values(pilotFailures).reduce((sum, count) => sum + count, 0);
    totalIncidents += incidents.length;

    const generated =
      deckModeGenerates(seat.config.deck.mode) && 'generated' in seat.config.deck
        ? seat.config.deck.generated
        : null;

    seats.push({
      seatId: activity.seatId,
      botId: activity.botId,
      displayName: seat.config.controller.displayName,

      difficulty: activity.difficulty,
      difficultyBehaviorVersion: activity.difficultyBehaviorVersion,
      styleSetting: activity.styleSetting,
      style: activity.style,
      pilotId: activity.pilotId,
      pilotVersion: activity.pilotVersion,

      deck: {
        // The privacy projection itself, not a copy of its fields: a fifth deck
        // mode arrives here as a type error in `publicDeckSourceOf` rather than
        // as a leak (ADR 0024 §3).
        source: publicDeckSourceOf(seat.config.deck),
        commanderId: configuredCommanderIdOf(seat.config.deck) ?? seat.commanderId,
        deckHash: generated?.deckHash ?? null,
        generatorVersion: generated?.generatorVersion ?? null,
      },
      pacing: seat.config.pacing,

      decisions: activity.decisions,
      decisionsByCategory: { ...activity.decisionsByCategory },

      waits: waitStatsOf(activity.delays),
      waitsByCategory: statsByCategory(activity.delays),
      waitsCancelled: activity.delaysCancelled,
      waitsRescheduled: activity.delaysRescheduled,

      pilotFailures,
      incidents: incidentCounts,
      halted: activity.halted,
    });
  }

  const matchDurationMs = Math.max(0, Math.round(input.endedAtMs - input.startedAtMs));
  const botPacingMs = unionSpanMs(
    allWaits.map((wait) => {
      const startMs = Math.max(0, Math.round(wait.startedAtMs - input.startedAtMs));
      return { startMs, endMs: startMs + wait.actualMs };
    }),
  );
  const botWaitSumMs = allWaits.reduce((sum, wait) => sum + wait.actualMs, 0);

  return {
    summaryVersion: BOT_SUMMARY_SCHEMA_VERSION,
    versions: {
      protocol: CURRENT_VERSIONS.protocol,
      rules: CURRENT_VERSIONS.rules,
      cardSchema: CURRENT_VERSIONS.cardSchema,
      botConfig: CURRENT_BOT_CONFIG_VERSIONS.botConfig,
      difficultyRegistry: CURRENT_BOT_CONFIG_VERSIONS.difficultyRegistry,
      pacing: CURRENT_BOT_CONFIG_VERSIONS.pacing,
    },
    matchId: input.matchId,
    budgets: input.budgets,
    engine: {
      turns: input.state?.turn ?? 0,
      actions: input.state?.actionLog.length ?? 0,
      events: input.state?.log.length ?? 0,
      sequence: input.state?.sequence ?? 0,
      complete: input.state?.status === 'complete',
    },
    clock: {
      matchDurationMs,
      botPacingMs,
      botWaitSumMs,
      botPacingPercent:
        matchDurationMs === 0
          ? null
          : Math.min(100, Math.max(0, Math.round((botPacingMs * 100) / matchDurationMs))),
    },
    seats,
    totals: {
      bots: seats.length,
      decisions: totalDecisions,
      decisionsByCategory: totalsByCategory,
      waits: seats.reduce<BotWaitStats>(
        (merged, seat) => mergeWaitStats(merged, seat.waits),
        EMPTY_BOT_WAIT_STATS,
      ),
      pilotFailures: totalPilotFailures,
      incidents: totalIncidents,
    },
    stalled: input.report.stalled,
    crashed: input.report.crashed,
    limits: limitsOf(botWaitSumMs, botPacingMs),
  };
}

const CATEGORIES: readonly BotDecisionCategory[] = ['ordinary', 'pending_choice', 'reaction'];

/**
 * The limits this particular summary carries.
 *
 * The four unconditional ones are true of every summary and are stated anyway,
 * because the audience is a person reading an exported file weeks later with no
 * access to this repository. `concurrent_waits_overlap` is conditional and is the
 * one that is genuinely a measurement: it appears exactly when two bots were
 * waiting at the same instant, which is the only case where the per-seat sum and
 * the wall-clock total disagree.
 */
function limitsOf(botWaitSumMs: number, botPacingMs: number): BotSummaryLimit[] {
  const limits = [...ALWAYS_TRUE_SUMMARY_LIMITS];
  if (botWaitSumMs > botPacingMs) limits.push('concurrent_waits_overlap');
  return limits;
}

/** One distribution per category, total over the three, from one pass. */
function statsByCategory(
  waits: readonly BotDelayRecord[],
): Record<BotDecisionCategory, BotWaitStats> {
  return {
    ordinary: waitStatsOf(waits.filter((wait) => wait.category === 'ordinary')),
    pending_choice: waitStatsOf(waits.filter((wait) => wait.category === 'pending_choice')),
    reaction: waitStatsOf(waits.filter((wait) => wait.category === 'reaction')),
  };
}

/** Counts occurrences, sorted by key so two equal summaries serialize equally. */
function countBy(values: readonly string[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  return Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right)));
}
