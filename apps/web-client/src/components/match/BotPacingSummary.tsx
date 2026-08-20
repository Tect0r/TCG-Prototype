import { pacingPercentFor, type BotPacing } from '@tcg/bot-config';
import { useMatchState } from '../../state/MatchContext.js';
import {
  PACING_IS_NOT_A_HUMAN_TIMER,
  ordinaryPacingLabel,
  reactionPacingLabel,
} from '../../lib/bot-pacing-labels.js';

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
 * The last sentence is the honest one, and M09.12 is what changed it: the server
 * now waits for the fraction each seat was set to, so the numbers above describe
 * the match that was actually played rather than a configuration nothing spent.
 * A seat at 0% is still instant, and the line says which of the two this table
 * was rather than asserting one for all of them.
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
        {bots.every((seat) => seatIsInstant(seat.bot.pacing))
          ? `${bots.length === 1 ? 'This bot was' : 'These bots were'} set to answer immediately, so the match waited for nothing.`
          : `${bots.length === 1 ? 'This bot waited' : 'These bots waited'} for the times above before each decision.`}
      </p>
    </section>
  );
}
