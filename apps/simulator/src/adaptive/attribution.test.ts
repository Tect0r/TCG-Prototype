import { describe, expect, it } from 'vitest';
import { buildSchedule, type ScheduledMatch } from '../schedule.js';
import { VALUE_PILOT } from '../test-fixtures.js';
import {
  tallyAdaptiveSeatOutcomes,
  tallyAdaptiveSeatOutcomesFromMap,
  validateAdaptiveSeatResults,
} from './attribution.js';

/**
 * M08.R21: the shared seat-identity attribution `./evaluate.ts`,
 * `./validate.ts` and `./run.ts` all now go through instead of three
 * independent implementations.
 */

function schedule(
  gamesPerOrientation: number,
  mirrorSeats: boolean,
  group = 'attribution-fixture',
): ScheduledMatch[] {
  return buildSchedule({
    experimentId: group,
    experimentSeed: `${group}-seed`,
    environmentId: 'env',
    decks: [{ hash: 'left-deck' }, { hash: 'right-deck' }],
    pilots: [VALUE_PILOT],
    pilotPairing: 'mirror',
    playerCount: 2,
    gamesPerPairing: gamesPerOrientation,
    mirrorSeats,
    schedule: 'round_robin',
    sampledPairings: 1,
  });
}

function winnerIdForDeckIndex(match: ScheduledMatch, deckIndex: number): string {
  const seat = match.seats.find((entry) => entry.deckIndex === deckIndex);
  if (seat === undefined)
    throw new Error(`match ${match.matchId} has no seat at deckIndex ${String(deckIndex)}`);
  return seat.playerId;
}

describe('tallyAdaptiveSeatOutcomes', () => {
  it('counts a scheduled match missing from results as noResult', () => {
    const matches = schedule(3, false);
    const results = [
      { matchId: matches[0]!.matchId, winnerPlayerId: winnerIdForDeckIndex(matches[0]!, 0) },
      { matchId: matches[1]!.matchId, winnerPlayerId: winnerIdForDeckIndex(matches[1]!, 1) },
      // matches[2] left out entirely.
    ];
    expect(tallyAdaptiveSeatOutcomes(matches, results, 0)).toEqual({
      leftWins: 1,
      rightWins: 1,
      noResult: 1,
    });
  });

  it('is noResult across the board for a fully empty result set, never a silent zero-length tally', () => {
    const matches = schedule(2, false);
    expect(tallyAdaptiveSeatOutcomes(matches, [], 0)).toEqual({
      leftWins: 0,
      rightWins: 0,
      noResult: matches.length,
    });
  });

  it('counts a drawn (null winner) result as noResult', () => {
    const matches = schedule(1, false);
    expect(
      tallyAdaptiveSeatOutcomes(
        matches,
        [{ matchId: matches[0]!.matchId, winnerPlayerId: null }],
        0,
      ),
    ).toEqual({ leftWins: 0, rightWins: 0, noResult: 1 });
  });

  it('counts a winner naming no seat in its own match as noResult, without throwing', () => {
    const matches = schedule(1, false);
    expect(
      tallyAdaptiveSeatOutcomes(
        matches,
        [{ matchId: matches[0]!.matchId, winnerPlayerId: 'not-a-real-seat' }],
        0,
      ),
    ).toEqual({ leftWins: 0, rightWins: 0, noResult: 1 });
  });

  it('refuses a result naming a match outside the schedule', () => {
    const matches = schedule(1, false);
    expect(() =>
      tallyAdaptiveSeatOutcomes(matches, [{ matchId: 'ghost-match', winnerPlayerId: null }], 0),
    ).toThrow(/ghost-match/);
  });

  it('refuses a duplicated result matchId rather than double-counting it', () => {
    const matches = schedule(1, false);
    const winnerPlayerId = winnerIdForDeckIndex(matches[0]!, 0);
    expect(() =>
      tallyAdaptiveSeatOutcomes(
        matches,
        [
          { matchId: matches[0]!.matchId, winnerPlayerId },
          { matchId: matches[0]!.matchId, winnerPlayerId },
        ],
        0,
      ),
    ).toThrow(new RegExp(matches[0]!.matchId));
  });

  it('attributes by seat deckIndex, unaffected by which side is called "left"', () => {
    const matches = schedule(2, false);
    const results = [
      { matchId: matches[0]!.matchId, winnerPlayerId: winnerIdForDeckIndex(matches[0]!, 0) },
      { matchId: matches[1]!.matchId, winnerPlayerId: winnerIdForDeckIndex(matches[1]!, 1) },
    ];
    expect(tallyAdaptiveSeatOutcomes(matches, results, 1)).toEqual({
      leftWins: 1,
      rightWins: 1,
      noResult: 0,
    });
  });
});

describe('validateAdaptiveSeatResults / tallyAdaptiveSeatOutcomesFromMap', () => {
  it('lets two disjoint groups validate once against their combined universe and tally separately', () => {
    const groupA = schedule(1, false, 'group-a');
    const groupB = schedule(1, true, 'group-b');
    const combined = [...groupA, ...groupB];
    const results = [
      { matchId: groupA[0]!.matchId, winnerPlayerId: winnerIdForDeckIndex(groupA[0]!, 0) },
      { matchId: groupB[0]!.matchId, winnerPlayerId: winnerIdForDeckIndex(groupB[0]!, 1) },
      { matchId: groupB[1]!.matchId, winnerPlayerId: winnerIdForDeckIndex(groupB[1]!, 1) },
    ];
    const byMatchId = validateAdaptiveSeatResults(combined, results);

    // Group A's own result is in the shared map; group B's results are simply
    // irrelevant to group A's tally, not "unknown" merely because group A's
    // own matches don't include them.
    expect(tallyAdaptiveSeatOutcomesFromMap(groupA, byMatchId, 0)).toEqual({
      leftWins: 1,
      rightWins: 0,
      noResult: 0,
    });
    expect(tallyAdaptiveSeatOutcomesFromMap(groupB, byMatchId, 0)).toEqual({
      leftWins: 0,
      rightWins: 2,
      noResult: 0,
    });
  });

  it('refuses a duplicate across the combined universe even when each copy sits in a different slice', () => {
    const groupA = schedule(1, false);
    const results = [
      { matchId: groupA[0]!.matchId, winnerPlayerId: winnerIdForDeckIndex(groupA[0]!, 0) },
      { matchId: groupA[0]!.matchId, winnerPlayerId: winnerIdForDeckIndex(groupA[0]!, 1) },
    ];
    expect(() => validateAdaptiveSeatResults(groupA, results)).toThrow(
      new RegExp(groupA[0]!.matchId),
    );
  });
});
