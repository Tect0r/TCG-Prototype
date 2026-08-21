import { z } from 'zod';
import {
  BOT_DECISION_CATEGORIES,
  BOT_SUMMARY_SCHEMA_VERSION,
  botConfigIssues,
  botDecisionCategorySchema,
  botDeckSourcePublicSchema,
  botDifficultySchema,
  botDisplayNameSchema,
  botIdSchema,
  botPacingBudgetsSchema,
  botPacingSchema,
  botStyleSchema,
  botStyleSettingSchema,
  deckHashSchema,
  refuseFutureVersion,
  type BotDecisionCategory,
} from '@tcg/bot-config';
import { cardIdSchema } from '@tcg/card-data';
import { err, error, ok, type Issue, type Result } from '@tcg/shared';
import { seatIdSchema } from './seats.js';

/**
 * The pacing and bot-provenance summary (M09.17) — what one finished match
 * actually cost a person in waiting, and what the bots at that table were.
 *
 * It exists because the owner has to be able to judge whether 50% of thirty
 * seconds is a game or a wait, and M08's durable Player Meta — the thing that
 * would normally answer that — is deferred behind this milestone. So this is
 * deliberately the smallest honest instrument that answers the question:
 * **match-local**, produced once when the match completes, broadcast to every
 * seat, rendered beside the result, and exportable as JSON for a playtest note.
 *
 * Four claims are structural rather than promised.
 *
 * **It is not an analytics store.** Nothing here is written to disk by the
 * server, indexed, aggregated across matches, or retained after the lobby goes.
 * `BOT_SUMMARY_LIMITS` says so in the record itself rather than in a comment a
 * reader of an exported file would never see, and the ingestion seam
 * (`BotSummarySink`, in the server) is a single call with no implementation that
 * keeps anything. M08 replaces that one call; it does not have to reshape this.
 *
 * **Engine metrics and wall-clock metrics are separate objects.** `engine`
 * counts turns, accepted actions and emitted events; `clock` measures
 * milliseconds. Neither borrows a field from the other, and no key appears in
 * both — a match that ran slowly and a match that ran long are different
 * statements, and the summary must not let one be read as the other.
 *
 * **It carries no hidden information.** Every deck fact in it comes from
 * `botDeckSourcePublicSchema` — the projection opponents already see — plus the
 * Commander, which every mode publishes, and the generator content address for a
 * deck the server built, which is broadcast beside the revealed list anyway. A
 * generator seed, a saved deck's name, its ID and its private fingerprint are
 * absent by *shape*, not by a stripping step somebody could forget
 * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §3).
 *
 * **It says which build produced it.** An exported file outlives the wire that
 * carried it, so `summaryVersion` is checked by `readBotMatchSummary` and the
 * play-contract and bot-artifact versions ride along, unread by this build and
 * available to the person reading the note.
 */

/* ------------------------------------------------------------ the limits */

/**
 * What this summary is not, as a closed set of IDs rather than as prose.
 *
 * Structured because the display text belongs to the screen and the *claim*
 * belongs here: a reader of an exported JSON file gets the limitation, and a
 * reworded UI cannot quietly drop one.
 *
 * `concurrent_waits_overlap` is the only conditional member — it is recorded
 * when, and only when, two bots were actually waiting at the same instant, so
 * its presence is a measurement rather than boilerplate.
 */
export const BOT_SUMMARY_LIMITS = [
  /** Produced for this match, held nowhere, and gone when the lobby is. */
  'match_local',
  /** Durations are wall-clock. Turns and actions are the engine's, and separate. */
  'wall_clock_not_engine',
  /** Measured, not scheduled: timer resolution and event-loop latency are in it. */
  'measured_not_scheduled',
  /** Bot pacing only. Nothing here timed, passed for, or defeated a person. */
  'pacing_is_not_a_human_timer',
  /** Two bots waited at once, so the per-seat total exceeds the wall-clock total. */
  'concurrent_waits_overlap',
] as const;
export const botSummaryLimitSchema = z.enum(BOT_SUMMARY_LIMITS);
export type BotSummaryLimit = z.infer<typeof botSummaryLimitSchema>;

/** Every limit that is true of every summary, in the order they are shown. */
export const ALWAYS_TRUE_SUMMARY_LIMITS: readonly BotSummaryLimit[] = Object.freeze([
  'match_local',
  'wall_clock_not_engine',
  'measured_not_scheduled',
  'pacing_is_not_a_human_timer',
]);

/* -------------------------------------------------------------- the parts */

/**
 * One set of waits, as configured and as measured.
 *
 * Both totals, because they answer different questions — intended is what the
 * host asked for, actual is what a stopwatch saw — and the three order
 * statistics because a total alone cannot tell one long wait from twenty short
 * ones. All three are `null` when there were no waits at all, which is the
 * honest record of an instant bot rather than a row of zeroes claiming it waited
 * for none of the time twenty times.
 */
export const botWaitStatsSchema = z.strictObject({
  count: z.number().int().min(0),
  intendedTotalMs: z.number().int().min(0),
  actualTotalMs: z.number().int().min(0),
  minActualMs: z.number().int().min(0).nullable(),
  medianActualMs: z.number().int().min(0).nullable(),
  maxActualMs: z.number().int().min(0).nullable(),
});
export type BotWaitStats = z.infer<typeof botWaitStatsSchema>;

/** Waits with nothing in them. The shape an instant seat records. */
export const EMPTY_BOT_WAIT_STATS: BotWaitStats = Object.freeze({
  count: 0,
  intendedTotalMs: 0,
  actualTotalMs: 0,
  minActualMs: null,
  medianActualMs: null,
  maxActualMs: null,
});

/** A total over the three decision categories. Never a partial record. */
function byCategory<T extends z.ZodTypeAny>(value: T) {
  return z.strictObject({
    ordinary: value,
    pending_choice: value,
    reaction: value,
  });
}

/**
 * Where one bot's cards came from, at exactly the resolution an opponent may
 * read once the match is over.
 *
 * `source` is the privacy projection itself rather than a copy of its fields, so
 * a fifth deck mode arrives here as a type error in `publicDeckSourceOf` rather
 * than as a leak. `commanderId` is resolved beside it because `exact_precon`
 * names a precon and not a Commander, and a summary that could not say what a
 * precon bot led would be answering "which bot was this" with a file name.
 *
 * `deckHash` is the **generator's** content address, so it is `null` for the two
 * exact modes: a precon is already named by its ID, and a saved deck's
 * fingerprint is the one handle onto a list that stays private to the host
 * (M09.6). Recomputing one here from the revealed list would produce a third
 * fingerprint to disagree with the two the project already has.
 */
export const botSummaryDeckSchema = z.strictObject({
  source: botDeckSourcePublicSchema,
  commanderId: cardIdSchema.nullable(),
  deckHash: deckHashSchema.nullable(),
  generatorVersion: z.string().min(1).max(32).nullable(),
});
export type BotSummaryDeck = z.infer<typeof botSummaryDeckSchema>;

/**
 * What one bot seat was, and what it did.
 *
 * The identity half is pairs rather than labels, because each pair answers a
 * question the label alone cannot: `difficulty` is what a host picked and
 * `difficultyBehaviorVersion` is which procedure was behind it; `styleSetting`
 * is what they set and `style` is what the server resolved; `pilotId` and
 * `pilotVersion` are the chooser and its version. A note that cited only the
 * labels could not tell two Normals apart.
 *
 * `pilotFailures` and `incidents` are open records rather than closed enums on
 * purpose. Their vocabularies belong to `@tcg/bot-interface` and to the server's
 * own runner, and neither may be imported here without inverting the dependency
 * direction ADR 0001 chose — so the keys are stated by their owners and a
 * source-scanning test on the server side keeps this able to carry all of them.
 */
export const botSeatSummarySchema = z.strictObject({
  seatId: seatIdSchema,
  botId: botIdSchema,
  displayName: botDisplayNameSchema,

  difficulty: botDifficultySchema,
  /** `null` only for a seat that halted before it ever flew one. */
  difficultyBehaviorVersion: z.string().min(1).nullable(),
  styleSetting: botStyleSettingSchema,
  style: botStyleSchema,
  pilotId: z.string().min(1),
  pilotVersion: z.string(),

  deck: botSummaryDeckSchema,
  pacing: botPacingSchema,

  /** Committed decisions in total, and by the budget the opportunity drew on. */
  decisions: z.number().int().min(0),
  decisionsByCategory: byCategory(z.number().int().min(0)),

  waits: botWaitStatsSchema,
  waitsByCategory: byCategory(botWaitStatsSchema),
  /** Waits abandoned because the opportunity went away. They cost no time here. */
  waitsCancelled: z.number().int().min(0),
  /** Waits restarted because the opportunity changed which budget it drew on. */
  waitsRescheduled: z.number().int().min(0),

  /** `BotFailureKind` to how many times `decideSafely` substituted a decision. */
  pilotFailures: z.record(z.string(), z.number().int().min(0)),
  /** The runner's own incident kinds, to how many times each was recorded. */
  incidents: z.record(z.string(), z.number().int().min(0)),
  /** Why this seat stopped being asked, or `null` if it played to the end. */
  halted: z.string().min(1).nullable(),
});
export type BotSeatSummary = z.infer<typeof botSeatSummarySchema>;

/**
 * The engine's own count of the match. Deliberately holds no duration.
 *
 * Separate from `clock` below because the two are independent: a match can be
 * long in turns and instant in seconds, or one turn long and five minutes of
 * waiting, and a summary that mixed them would let a tester read pacing as
 * gameplay. Nothing in this object is affected by a pacing percentage, which is
 * a property the suite asserts by replaying one seed at two of them.
 */
export const botSummaryEngineSchema = z.strictObject({
  turns: z.number().int().min(0),
  /** Accepted actions, human and bot alike, as the engine logged them. */
  actions: z.number().int().min(0),
  events: z.number().int().min(0),
  /** The final event sequence, so a note can be tied to a replay. */
  sequence: z.number().int().min(0),
  /** `true` when the engine declared the match over rather than it being cut short. */
  complete: z.boolean(),
});
export type BotSummaryEngine = z.infer<typeof botSummaryEngineSchema>;

/**
 * The wall clock. Deliberately holds no turn and no action count.
 *
 * `botPacingMs` is the **union** of every bot's waits — the wall-clock time
 * during which at least one bot was waiting — because that is what a person at
 * the table actually spent. `botWaitSumMs` is the per-seat sum beside it, which
 * is larger whenever two bots waited at once; both are recorded because a table
 * that felt slow because one bot is slow and a table that felt slow because
 * three bots overlap are different findings, and `concurrent_waits_overlap` is
 * how the record says which one this was.
 */
export const botSummaryClockSchema = z.strictObject({
  /** Match start to completion, on a monotonic clock. */
  matchDurationMs: z.number().int().min(0),
  botPacingMs: z.number().int().min(0),
  botWaitSumMs: z.number().int().min(0),
  /** `botPacingMs` as a whole percentage of the match, or `null` for a zero-length one. */
  botPacingPercent: z.number().int().min(0).max(100).nullable(),
});
export type BotSummaryClock = z.infer<typeof botSummaryClockSchema>;

/** Every version this record was written against, for a reader with only the file. */
export const botSummaryVersionsSchema = z.strictObject({
  protocol: z.number().int().min(1),
  rules: z.string().min(1),
  cardSchema: z.number().int().min(1),
  botConfig: z.number().int().min(1),
  difficultyRegistry: z.number().int().min(1),
  pacing: z.number().int().min(1),
});
export type BotSummaryVersions = z.infer<typeof botSummaryVersionsSchema>;

/**
 * One finished match's summary.
 *
 * `summaryVersion` accepts anything this build can read rather than only what it
 * writes, because the point of the constant is to refuse a *newer* record: an
 * older one is readable by construction, and refusing it would make a tester's
 * two-week-old note unopenable for no reason.
 */
export const botMatchSummarySchema = z.strictObject({
  summaryVersion: z.number().int().min(1).max(BOT_SUMMARY_SCHEMA_VERSION),
  versions: botSummaryVersionsSchema,
  /** The match this describes. No invite code, no player name, no account. */
  matchId: z.string().min(1).max(64),
  /** The budgets the lobby froze at match start; every percentage is of these. */
  budgets: botPacingBudgetsSchema,
  engine: botSummaryEngineSchema,
  clock: botSummaryClockSchema,
  seats: z.array(botSeatSummarySchema),
  /** Every seat's decisions and waits added up, so a note need not do arithmetic. */
  totals: z.strictObject({
    bots: z.number().int().min(0),
    decisions: z.number().int().min(0),
    decisionsByCategory: byCategory(z.number().int().min(0)),
    waits: botWaitStatsSchema,
    pilotFailures: z.number().int().min(0),
    incidents: z.number().int().min(0),
  }),
  /** The runner's match-level findings, recorded rather than resolved. */
  stalled: z.string().min(1).nullable(),
  crashed: z.string().min(1).nullable(),
  limits: z.array(botSummaryLimitSchema),
});
export type BotMatchSummary = z.infer<typeof botMatchSummarySchema>;

/**
 * Reads a summary from outside this build — an exported file, or a future M08
 * ingestion path.
 *
 * The version check runs before the parse for the reason `readBotSeatConfig`
 * gives: a record from a newer build should be told that, rather than handed a
 * list of complaints about fields this build has not learned about yet. It is
 * the same refusal, through the same `refuseFutureVersion`, so there is one
 * wording for "this was written by a newer build" and not a second one here.
 */
export function readBotMatchSummary(raw: unknown): Result<BotMatchSummary, Issue[]> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err([error('bot_config/malformed', 'A bot match summary must be a JSON object.')]);
  }
  const refusal = refuseFutureVersion(
    'matchSummary',
    (raw as Record<string, unknown>).summaryVersion,
    'summaryVersion',
  );
  if (refusal) return err([refusal]);

  const parsed = botMatchSummarySchema.safeParse(raw);
  if (!parsed.success) return err(botConfigIssues(parsed.error));
  return ok(parsed.data);
}

/**
 * Turns a list of measured waits into one distribution.
 *
 * Here rather than in the server because the shape it produces is this file's,
 * and a second implementation beside a schema is how a per-seat total and a
 * table total come to disagree. The median is the lower of the two middle
 * readings on an even count — chosen rather than averaged so the value printed
 * is always a wait that actually happened.
 */
export function waitStatsOf(
  waits: readonly { intendedMs: number; actualMs: number }[],
): BotWaitStats {
  if (waits.length === 0) return EMPTY_BOT_WAIT_STATS;
  const actual = waits.map((wait) => wait.actualMs).sort((left, right) => left - right);
  return {
    count: waits.length,
    intendedTotalMs: waits.reduce((total, wait) => total + wait.intendedMs, 0),
    actualTotalMs: waits.reduce((total, wait) => total + wait.actualMs, 0),
    minActualMs: actual[0] ?? null,
    medianActualMs: actual[Math.floor((actual.length - 1) / 2)] ?? null,
    maxActualMs: actual[actual.length - 1] ?? null,
  };
}

/**
 * Adds two wait distributions.
 *
 * The medians are deliberately **not** combined — a median of medians is not a
 * median — so a merged distribution keeps the extremes, which do combine, and
 * reports `null` for the middle unless one side contributed nothing at all.
 */
export function mergeWaitStats(left: BotWaitStats, right: BotWaitStats): BotWaitStats {
  if (left.count === 0) return right;
  if (right.count === 0) return left;
  return {
    count: left.count + right.count,
    intendedTotalMs: left.intendedTotalMs + right.intendedTotalMs,
    actualTotalMs: left.actualTotalMs + right.actualTotalMs,
    minActualMs: minOf(left.minActualMs, right.minActualMs),
    medianActualMs: null,
    maxActualMs: maxOf(left.maxActualMs, right.maxActualMs),
  };
}

function minOf(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function maxOf(left: number | null, right: number | null): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

/**
 * The wall-clock time during which **at least one** bot was waiting.
 *
 * A union of half-open intervals rather than a sum, because three bots answering
 * one Reaction window cost the table the slowest of them and not all three
 * (M09.12), and a summary that added them up would tell a tester their match
 * spent more time waiting than it lasted. The sum is reported beside it, so both
 * questions have an answer and neither is disguised as the other.
 */
export function unionSpanMs(spans: readonly { startMs: number; endMs: number }[]): number {
  const ordered = spans
    .filter((span) => span.endMs > span.startMs)
    .sort((left, right) => left.startMs - right.startMs);
  let total = 0;
  let openFrom: number | null = null;
  let openTo = 0;
  for (const span of ordered) {
    if (openFrom === null) {
      openFrom = span.startMs;
      openTo = span.endMs;
      continue;
    }
    if (span.startMs > openTo) {
      total += openTo - openFrom;
      openFrom = span.startMs;
      openTo = span.endMs;
      continue;
    }
    openTo = Math.max(openTo, span.endMs);
  }
  if (openFrom !== null) total += openTo - openFrom;
  return total;
}

/** A zeroed count for each category, for a caller that is about to add to it. */
export function emptyCategoryCounts(): Record<BotDecisionCategory, number> {
  return { ordinary: 0, pending_choice: 0, reaction: 0 };
}

/** The categories, in the order every screen and every record lists them. */
export const SUMMARY_CATEGORY_ORDER: readonly BotDecisionCategory[] = BOT_DECISION_CATEGORIES;

export { botDecisionCategorySchema };
