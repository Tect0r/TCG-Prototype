import { useMatchState } from '../../state/MatchContext.js';
import {
  PACING_IS_NOT_A_HUMAN_TIMER,
  ordinaryPacingLabel,
  reactionPacingLabel,
} from '../../lib/bot-pacing-labels.js';

/**
 * What the bots at this table were timed at, printed beside the result (M09.11).
 *
 * Every value here comes off the lobby view the server sent: the budgets are the
 * ones it **froze** at match start, and each percentage is the one on the seat's
 * public projection, which no message can change once the lobby is locked. So
 * this is provenance rather than a copy of the last thing the host typed — a
 * playtest note can quote it, and the numbers in it are the numbers the match
 * ran under.
 *
 * It renders only once the match is complete, beside the revealed decks, because
 * that is when a note gets written. During the match the same settings are
 * visible in the lobby panel, where they are still editable up to the moment
 * they are not.
 *
 * The last sentence is the honest one and is expected to change in M09.12: this
 * build records the timings and submits every bot decision immediately, so a
 * summary that implied the match had been paced would be describing a wait that
 * never happened.
 */
export function BotPacingSummary() {
  const { lobby, view } = useMatchState();

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
        {bots.length === 1 ? 'This bot answered' : 'These bots answered'} immediately: the timings
        above are what the match recorded, not what it waited.
      </p>
    </section>
  );
}
