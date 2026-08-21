import { difficultyDefinition, pacingPercentFor, type BotPacing } from '@tcg/bot-config';
import { SUMMARY_CATEGORY_ORDER, type BotMatchSummary, type BotSeatSummary } from '@tcg/protocol';
import { useCardDatabase } from '../../state/AppContext.js';
import { useMatchState } from '../../state/MatchContext.js';
import {
  DECISION_CATEGORY_LABELS,
  PACING_IS_NOT_A_HUMAN_TIMER,
  SUMMARY_LIMIT_TEXT,
  durationLabel,
  ordinaryPacingLabel,
  reactionPacingLabel,
  waitStatsLabel,
} from '../../lib/bot-pacing-labels.js';
import { seatStyleLabel } from '../../lib/bot-style-labels.js';
import { downloadTextFile } from '../../lib/download.js';

/**
 * A seat that waits for nothing, in its own turn and in a Reaction window.
 *
 * `pacingPercentFor` rather than reading the two fields, because `null` means
 * inherit and a screen that read it as zero would call a 100% bot instant.
 */
function seatIsInstant(pacing: BotPacing): boolean {
  return pacingPercentFor(pacing, 'ordinary') === 0 && pacingPercentFor(pacing, 'reaction') === 0;
}

/**
 * What the bots at this table were timed at, and what that actually cost
 * (M09.11, measured in M09.17).
 *
 * Two halves, and they come from two places on purpose.
 *
 * The **configured** half reads the lobby view: the budgets the server froze at
 * match start, and each seat's public percentage, neither of which any message
 * can change once the lobby is locked. It renders as soon as the match is
 * complete, so a table always gets its settings back even if the summary
 * broadcast never arrives.
 *
 * The **measured** half reads the `bot_pacing_summary` the server broadcasts
 * once, at completion. Every number in it was taken by the authoritative server
 * on its own monotonic clock: this component formats them and computes none of
 * them, because a browser that recomputed a duration from its own clock would be
 * a second, disagreeing answer to the one question the record exists to settle.
 *
 * The limits are printed rather than implied. They arrive as IDs in the record
 * and the sentences live in `bot-pacing-labels.ts`, so the claim and its wording
 * have one owner each and a reworded screen cannot quietly drop one.
 *
 * The export is the record exactly as the server sent it. Not a reshaping and
 * not a rendering of what is on screen: a playtest note is worth keeping only if
 * what it holds is what the server measured, and `readBotMatchSummary` on the
 * way back in is what makes that a round trip rather than a hope.
 */
export function BotPacingSummary() {
  const { lobby, view, botMatchSummary } = useMatchState();

  if (!lobby || view?.status !== 'complete') return null;
  const bots = lobby.seats.filter((seat) => seat.controller === 'bot');
  if (bots.length === 0) return null;

  const budgets = lobby.botPacing;

  return (
    <section className="board__pacing" aria-label="Bot pacing">
      <h3>Bot pacing this match</h3>
      <p className="board__pacing-head">
        Budgets locked at start: {budgets.ordinarySeconds} s for a decision or a choice,{' '}
        {budgets.reactionSeconds} s for a Reaction window. {PACING_IS_NOT_A_HUMAN_TIMER}
      </p>
      <ul className="board__pacing-list">
        {bots.map((seat) => (
          <li key={seat.seatId}>
            {seat.bot.displayName}: {ordinaryPacingLabel(seat.bot.pacing, budgets)};{' '}
            {reactionPacingLabel(seat.bot.pacing, budgets)}.
          </li>
        ))}
      </ul>
      <p className="board__pacing-head">
        {bots.every((seat) => seatIsInstant(seat.bot.pacing))
          ? `${bots.length === 1 ? 'This bot was' : 'These bots were'} set to answer immediately, so the match waited for nothing.`
          : `${bots.length === 1 ? 'This bot waited' : 'These bots waited'} for the times above before each decision.`}
      </p>

      {botMatchSummary && <MeasuredSummary summary={botMatchSummary} />}
    </section>
  );
}

/** The half the server measured. Rendered only when the broadcast has arrived. */
function MeasuredSummary({ summary }: { readonly summary: BotMatchSummary }) {
  const { clock, engine, totals } = summary;

  return (
    <div className="board__pacing-measured" aria-label="Pacing summary">
      <h4>What it cost</h4>
      <p className="board__pacing-head">
        The match lasted {durationLabel(clock.matchDurationMs)} on the clock. Bots were waiting for{' '}
        {durationLabel(clock.botPacingMs)} of it
        {clock.botPacingPercent === null ? '' : ` — ${clock.botPacingPercent}%`}, and the per-bot
        total was {durationLabel(clock.botWaitSumMs)}.
      </p>
      {/* Deliberately its own sentence rather than a column beside the seconds:
          engine progress and wall-clock time are separate measurements, and a
          table that mixed them would let one be read as the other. */}
      <p className="board__pacing-head">
        The engine counted {engine.turns} {engine.turns === 1 ? 'turn' : 'turns'}, {engine.actions}{' '}
        accepted {engine.actions === 1 ? 'action' : 'actions'} and {engine.events} events, to
        sequence {engine.sequence}. Those are turns and actions, not seconds.
      </p>
      <p className="board__pacing-head">
        {totals.decisions} bot {totals.decisions === 1 ? 'decision' : 'decisions'} in total:{' '}
        {SUMMARY_CATEGORY_ORDER.map(
          (category) =>
            `${totals.decisionsByCategory[category]} in ${DECISION_CATEGORY_LABELS[category]}`,
        ).join(', ')}
        . {waitStatsLabel(totals.waits)}.
      </p>

      <ul className="board__pacing-list">
        {summary.seats.map((seat) => (
          <SeatSummaryLine key={seat.seatId} seat={seat} />
        ))}
      </ul>

      {(summary.stalled || summary.crashed) && (
        <p className="board__pacing-head" role="status">
          {summary.stalled ? `Stalled: ${summary.stalled}. ` : ''}
          {summary.crashed ? `The bot runner stopped: ${summary.crashed}.` : ''}
        </p>
      )}

      <h4>What this does not tell you</h4>
      <ul className="board__pacing-list">
        {summary.limits.map((limit) => (
          <li key={limit}>{SUMMARY_LIMIT_TEXT[limit]}</li>
        ))}
      </ul>

      <button
        type="button"
        className="button--quiet"
        onClick={() =>
          downloadTextFile(
            `${summary.matchId}-pacing-summary.json`,
            `${JSON.stringify(summary, null, 2)}\n`,
          )
        }
      >
        Export the pacing summary
      </button>
    </div>
  );
}

/**
 * One bot seat: what it was, and what it did.
 *
 * The provenance half is pairs rather than labels — difficulty with its
 * behaviour version, the style with the setting that produced it, the pilot with
 * its version — because that is what makes a note quotable a month later. The
 * deck half prints only what the record carries, which is the public projection:
 * a generated deck names its generator and its content address, and an exact one
 * names neither, because it has none to name.
 */
function SeatSummaryLine({ seat }: { readonly seat: BotSeatSummary }) {
  const database = useCardDatabase();
  const commander =
    seat.deck.commanderId === null
      ? null
      : (database.get(seat.deck.commanderId)?.name ?? seat.deck.commanderId);
  const failures = Object.entries(seat.pilotFailures);

  return (
    <li>
      <strong>{seat.displayName}</strong> — {difficultyDefinition(seat.difficulty).label}
      {seat.difficultyBehaviorVersion === null ? '' : ` v${seat.difficultyBehaviorVersion}`},{' '}
      {seatStyleLabel({ style: seat.style, styleSetting: seat.styleSetting })}, pilot {seat.pilotId}{' '}
      v{seat.pilotVersion}. Deck: {seat.deck.source.mode.replace(/_/g, ' ')}
      {commander === null ? '' : ` under ${commander}`}
      {seat.deck.deckHash === null
        ? ''
        : ` — generator v${seat.deck.generatorVersion ?? '?'}, deck ${seat.deck.deckHash}`}
      . {seat.decisions} {seat.decisions === 1 ? 'decision' : 'decisions'} (
      {SUMMARY_CATEGORY_ORDER.map(
        (category) => `${seat.decisionsByCategory[category]} ${DECISION_CATEGORY_LABELS[category]}`,
      ).join(', ')}
      ). {waitStatsLabel(seat.waits)}
      {seat.waitsCancelled === 0 ? '' : `, ${seat.waitsCancelled} cancelled`}
      {seat.waitsRescheduled === 0 ? '' : `, ${seat.waitsRescheduled} rescheduled`}.
      {failures.length === 0
        ? ''
        : ` Pilot fallbacks: ${failures.map(([kind, count]) => `${kind} ×${count}`).join(', ')}.`}
      {seat.halted === null ? '' : ` Stopped being asked: ${seat.halted}.`}
    </li>
  );
}
