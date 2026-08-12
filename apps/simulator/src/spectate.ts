import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { PILOT_IDS, type PilotId } from '@tcg/bot-interface';
import { DEFAULT_RULES_CONFIG } from '@tcg/rules-engine';
import {
  cardPoolHash,
  defaultSpectatorSetup,
  groupEvents,
  resolveSpectatorSetup,
  runSpectatorMatch,
  setupProvenance,
  spectatorDatabase,
  spectatorPrecons,
  type SpectatorReplay,
  type SpectatorSetup,
} from '@tcg/spectator';

/**
 * Headless AI-spectator matches (rule adjustment, Part 2).
 *
 * The same runner the browser uses, driven from a terminal. It exists for three
 * reasons: to produce a replay a user can load into the spectator screen without
 * waiting for one to be played; to give the precon matchup smoke tests something
 * to call; and to make the reproducibility claim checkable from a script rather
 * than only by watching.
 *
 * There is no second rules path here, and no second replay format. This module
 * writes exactly what the client writes.
 */

export interface SpectateOptions {
  readonly seed: string;
  readonly players: number;
  /** Precon ID per seat. Defaults to one precon per seat, wrapping. */
  readonly precons?: readonly string[];
  /** Pilot per seat. Defaults to one pilot per seat, wrapping. */
  readonly pilots?: readonly PilotId[];
  readonly output?: string | null;
  /**
   * Developer override: run precons that still contain unimplemented cards
   * (M01.2). Everything the run produces is marked invalid.
   */
  readonly allowIncompleteCards?: boolean;
}

export interface SpectateResult {
  readonly replay: SpectatorReplay;
  readonly outputPath: string | null;
  readonly summary: string;
}

export async function runSpectate(options: SpectateOptions): Promise<SpectateResult> {
  const database = spectatorDatabase();
  const base = defaultSpectatorSetup(options.seed, options.players);

  const setup: SpectatorSetup = {
    seed: options.seed,
    seats: base.seats.map((seat, index) => ({
      preconId: options.precons?.[index] ?? seat.preconId,
      pilotId: options.pilots?.[index] ?? seat.pilotId,
    })),
    ...(options.allowIncompleteCards ? { developerAllowIncompleteCards: true } : {}),
  };

  const resolved = resolveSpectatorSetup(setup, { database });
  if (resolved.problems.length > 0) {
    // Reported, never repaired: substituting a deck would make the match a
    // different experiment from the one that was asked for.
    const incomplete = resolved.problems.some((p) => p.kind === 'incomplete_cards');
    throw new Error(
      'Spectator setup is not runnable:\n' +
        resolved.problems.map((p) => `  seat ${p.seatIndex + 1}: ${p.message}`).join('\n') +
        (incomplete
          ? '\n\nThose cards are not implemented yet, so a match containing them would not be ' +
            'evidence about the game. --allow-incomplete-cards runs it anyway and marks every ' +
            'result invalid.'
          : '') +
        `\n\nAvailable precons: ${spectatorPrecons()
          .map((p) => p.id)
          .join(', ')}` +
        `\nAvailable pilots:  ${PILOT_IDS.join(', ')}`,
    );
  }

  const replay = await runSpectatorMatch({
    seed: options.seed,
    seats: resolved.seats,
    database,
    config: DEFAULT_RULES_CONFIG,
    cardDataHash: cardPoolHash(database),
    provenance: setupProvenance(resolved),
  });

  let outputPath: string | null = null;
  if (options.output) {
    outputPath = resolve(options.output);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${JSON.stringify(replay, null, 2)}\n`, 'utf8');
  }

  return { replay, outputPath, summary: formatSpectateSummary(replay) };
}

/**
 * The "results invalid" notice a developer-override run carries.
 *
 * It names every blocking card rather than counting them, because the point of
 * reading it is to know what was wrong with the match you are looking at.
 */
function invalidResultsBanner(replay: SpectatorReplay): string[] {
  return [
    '!! RESULTS INVALID — developer override !!',
    'This match ran with cards whose printed behaviour is not implemented yet, so what',
    'happened is not what those cards say. It is not evidence about the game.',
    ...replay.provenance.incompleteCards.map((seat) => {
      const name = replay.seats.find((entry) => entry.playerId === seat.playerId)?.name;
      return `  ${name ?? seat.playerId}: ${seat.cardIds.join(', ')}`;
    }),
  ];
}

/** The end-of-match report, in the same terms the spectator screen shows. */
export function formatSpectateSummary(replay: SpectatorReplay): string {
  const { telemetry } = replay;
  const lines: string[] = [];

  // First and last, because a warning that scrolls off the top is not a warning.
  if (!replay.provenance.resultsValid) {
    lines.push(...invalidResultsBanner(replay), '');
  }

  lines.push(
    `match:   ${replay.matchId}`,
    `seed:    ${replay.seed}`,
    `rules:   ${replay.rulesVersion}   cards: ${replay.cardDataHash}`,
    `result:  ${
      replay.result?.outcome === 'draw' ? 'draw' : `${replay.result?.winnerId ?? 'nobody'} wins`
    } (${replay.result?.reason ?? replay.termination}) after ${telemetry.turns} turn(s)`,
    `groups:  ${groupEvents(replay.events).length} visible step(s) from ${replay.events.length} events`,
    '',
    'seat                                     place  peak  nonTok  tok  stack  cmdr✝  cmdrMax  react',
  );

  const byPlacement = [...telemetry.seats].sort((left, right) => left.placement - right.placement);
  for (const seat of byPlacement) {
    const config = replay.seats.find((entry) => entry.playerId === seat.playerId);
    const label = `${config?.name ?? seat.playerId}`.slice(0, 40).padEnd(40);
    lines.push(
      [
        label,
        String(seat.placement).padStart(5),
        String(seat.peakUnits).padStart(5),
        String(seat.peakNonTokenUnits).padStart(7),
        String(seat.peakTokens).padStart(4),
        String(seat.peakTokenStack).padStart(6),
        String(seat.commanderDefeats).padStart(6),
        String(seat.maxCommanderDeploymentCost).padStart(8),
        String(seat.reactionsPlayed).padStart(6),
      ].join(' '),
    );
  }

  lines.push(
    '',
    `longest turn:    turn ${telemetry.longestTurn.turn} (${telemetry.longestTurn.actions} actions)`,
    `largest combat:  turn ${telemetry.largestCombat.turn} (${telemetry.largestCombat.attackers} attackers, ${telemetry.largestCombat.blockers} blockers)`,
    `busiest turn:    turn ${telemetry.busiestTurn.turn} (${telemetry.busiestTurn.triggers} triggers, ${telemetry.busiestTurn.choices} choices)`,
    `reactions:       ${telemetry.reactionsPlayed} played across ${telemetry.reactionWindows} window(s); ${telemetry.cardsCountered} card(s) countered`,
    `board stall:     ${telemetry.boardStalled ? 'yes' : 'no'} (longest ${telemetry.longestStallRounds} round(s) with no attack)`,
  );

  if (telemetry.largestBoardAnswer) {
    const answer = telemetry.largestBoardAnswer;
    lines.push(
      `largest board:   ${answer.playerId} peaked at ${answer.peakUnits} unit(s); ` +
        `${answer.unitsLostAfterPeak} lost afterwards` +
        (answer.reasons.length > 0 ? ` (${answer.reasons.join(', ')})` : ''),
    );
  }

  if (replay.diagnostics.length > 0) {
    lines.push('', 'diagnostics:', ...replay.diagnostics.map((line) => `  ${line}`));
  }

  // Said out loud rather than left implied: these are observations about one
  // match, and a single match is not evidence about balance (CLAUDE.md §13.1).
  lines.push(
    '',
    'This is one match. It is evidence about what the rules did, not about whether they are balanced.',
  );
  if (!replay.provenance.resultsValid) lines.push('', ...invalidResultsBanner(replay));
  return lines.join('\n');
}
