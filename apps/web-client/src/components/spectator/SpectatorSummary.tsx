import type { SpectatorReplay, StallClassification } from '@tcg/spectator';

/**
 * The end-of-match screen: result, placements, and the board-size telemetry the
 * unlimited battlefield has to be judged on (rule adjustment, "Match telemetry").
 *
 * Deliberately plain numbers, and the one verdict on the screen is not this
 * component's. A wide board is not a failure and nothing here may imply it is:
 * the stall classification comes from the engine-side rule in
 * `@tcg/board-telemetry`, is shown with the streak and threshold that produced
 * it, and every other figure is a count a human weighs for themselves.
 */

/** Wording only. The value is the shared classification, unchanged. */
function stallVerdictLabel(classification: StallClassification): string {
  return classification === 'stalled' ? 'stalled' : 'not stalled';
}

export interface SpectatorSummaryProps {
  readonly replay: SpectatorReplay;
}

export function SpectatorSummary({ replay }: SpectatorSummaryProps) {
  const { telemetry } = replay;
  const nameOf = (playerId: string): string =>
    replay.seats.find((seat) => seat.playerId === playerId)?.name ?? playerId;

  const ordered = [...telemetry.seats].sort((left, right) => left.placement - right.placement);

  return (
    <section className="spectator-summary" aria-label="Match result">
      <header>
        <h3>
          {replay.result?.outcome === 'draw'
            ? 'Draw'
            : `${replay.result?.winnerId ? nameOf(replay.result.winnerId) : 'Nobody'} wins`}
        </h3>
        <p className="spectator-summary__reason">
          {replay.result?.reason ?? replay.termination} · {telemetry.turns} turns ·{' '}
          {telemetry.rounds} rounds · {telemetry.actions} actions
        </p>
      </header>

      <table className="spectator-summary__table">
        <caption className="spectator-summary__caption">
          Board size per seat. Peak counts are high-water marks across the whole match, not the
          final board.
        </caption>
        <thead>
          <tr>
            <th scope="col">#</th>
            <th scope="col">Bot</th>
            <th scope="col">Peak units</th>
            <th scope="col">Non-token</th>
            <th scope="col">Tokens</th>
            <th scope="col">Largest stack</th>
            <th scope="col">Cmdr defeats</th>
            <th scope="col">Max cmdr cost</th>
            <th scope="col">Reactions</th>
          </tr>
        </thead>
        <tbody>
          {ordered.map((seat) => (
            <tr key={seat.playerId}>
              <td>{seat.placement}</td>
              <td>{nameOf(seat.playerId)}</td>
              <td>{seat.peakUnits}</td>
              <td>{seat.peakNonTokenUnits}</td>
              <td>{seat.peakTokens}</td>
              <td>{seat.peakTokenStack}</td>
              <td>{seat.commanderDefeats}</td>
              <td>{seat.maxCommanderDeploymentCost}</td>
              <td>{seat.reactionsPlayed}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <ul className="spectator-summary__facts">
        <li>
          Longest turn: turn {telemetry.longestTurn.turn} ({telemetry.longestTurn.actions} actions)
        </li>
        <li>
          Largest combat: turn {telemetry.largestCombat.turn} ({telemetry.largestCombat.attackers}{' '}
          attackers, {telemetry.largestCombat.blockers} blockers)
        </li>
        <li>
          Busiest turn: turn {telemetry.busiestTurn.turn} ({telemetry.busiestTurn.triggers}{' '}
          triggers, {telemetry.busiestTurn.choices} choices)
        </li>
        <li>
          Reactions: {telemetry.reactionsPlayed} played across {telemetry.reactionWindows}{' '}
          window(s); {telemetry.cardsCountered} card(s) countered
        </li>
        {/*
         * The evidence, then the verdict cut from it (M04.2, M04.3). The old line
         * said "board stall: yes" off three quiet rounds, which could not tell a
         * table that declined from a table that had nothing to attack with. These
         * three say which it was, what the rule counted, and what it concluded —
         * in that order, because the verdict is only readable against the rule.
         */}
        <li>
          Attack steps: {telemetry.attackOpportunity.steps} — {telemetry.attackOpportunity.able}{' '}
          able, {telemetry.attackOpportunity.declined} declined,{' '}
          {telemetry.attackOpportunity.unable} unable
          {telemetry.attackOpportunity.readyPreventions > 0
            ? `; ${telemetry.attackOpportunity.readyPreventions} Ready Step(s) prevented by an effect`
            : ''}
        </li>
        <li>
          Quiet rounds: longest run of {telemetry.longestStallRounds} with no attack —{' '}
          {telemetry.attackOpportunity.longestDeclinedStreak} where somebody could have attacked,{' '}
          {telemetry.attackOpportunity.longestUnableStreak} where nobody could.
        </li>
        <li>
          Stall verdict: {stallVerdictLabel(telemetry.attackOpportunity.classification)} —{' '}
          {telemetry.attackOpportunity.longestUnanimousDeclinedStreak} round(s) where every living
          seat could have attacked and none did, against a threshold of{' '}
          {telemetry.attackOpportunity.stallDefinition.thresholdRounds}.
        </li>
        {telemetry.largestBoardAnswer && (
          <li>
            Largest board: {nameOf(telemetry.largestBoardAnswer.playerId)} peaked at{' '}
            {telemetry.largestBoardAnswer.peakUnits} units;{' '}
            {telemetry.largestBoardAnswer.unitsLostAfterPeak} lost afterwards
            {telemetry.largestBoardAnswer.reasons.length > 0
              ? ` (${telemetry.largestBoardAnswer.reasons.join(', ')})`
              : ''}
          </li>
        )}
      </ul>

      {telemetry.seats.some((seat) => seat.unitsByRound.length > 0) && (
        <div className="spectator-summary__rounds">
          <h4>Units at the end of each round</h4>
          <table className="spectator-summary__table">
            <thead>
              <tr>
                <th scope="col">Bot</th>
                {telemetry.seats[0]?.unitsByRound.map((_, index) => (
                  <th scope="col" key={index}>
                    R{index + 1}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {telemetry.seats.map((seat) => (
                <tr key={seat.playerId}>
                  <td>{nameOf(seat.playerId)}</td>
                  {seat.unitsByRound.map((count, index) => (
                    <td key={index}>{count}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {replay.diagnostics.length > 0 && (
        <div className="spectator-summary__diagnostics">
          <h4>Diagnostics</h4>
          <ul>
            {replay.diagnostics.map((line, index) => (
              <li key={index}>{line}</li>
            ))}
          </ul>
        </div>
      )}

      <p className="spectator-summary__caveat">
        This is one match. It is evidence about what the rules did, not about whether they are
        balanced.
      </p>

      {/* Repeated at the result, because this is the screen whose numbers are
          most likely to be copied somewhere else (M01.2). */}
      {!replay.provenance.resultsValid && (
        <p className="spectator-summary__invalid" role="alert">
          <strong>Results invalid.</strong> This match ran under the developer override with cards
          that are not implemented yet:{' '}
          {replay.provenance.incompleteCards.flatMap((seat) => seat.cardIds).join(', ')}. None of
          these numbers describe the printed game.
        </p>
      )}
    </section>
  );
}
