import { describe, expect, it } from 'vitest';
import { makeDeck, type SimDeck } from '@tcg/deck-generator';
import {
  buildSchedule,
  deckMultisets,
  deckTuples,
  distinctRotationCount,
  matchesBetween,
  pilotTuples,
  type ScheduleOptions,
} from './schedule.js';
import { RANDOM_PILOT, VALUE_PILOT, AGGRESSIVE_PILOT } from './test-fixtures.js';

/**
 * CLAUDE.md §13.7 (schedules) and §13.15 item 6 (seat mirroring).
 *
 * The schedule is pure, so these tests need no matches: they check the shape of
 * the plan, not the play.
 */

function deck(index: number): SimDeck {
  return makeDeck({
    id: `d${index}`,
    label: `d${index}`,
    commanderId: 'prototype_commander_blue',
    cards: [
      { cardId: 'prototype_scout', quantity: 2 },
      { cardId: 'prototype_guard', quantity: index + 1 },
    ],
  });
}

function options(overrides: Partial<ScheduleOptions> = {}): ScheduleOptions {
  return {
    experimentId: 'exp',
    experimentSeed: 'seed',
    environmentId: 'baseline',
    decks: [deck(0), deck(1), deck(2)],
    pilots: [VALUE_PILOT],
    pilotPairing: 'mirror',
    playerCount: 2,
    gamesPerPairing: 2,
    mirrorSeats: true,
    schedule: 'round_robin',
    sampledPairings: 100,
    ...overrides,
  };
}

describe('deckTuples', () => {
  it('enumerates unordered combinations in stable order', () => {
    expect(deckTuples(4, 2)).toEqual([
      [0, 1],
      [0, 2],
      [0, 3],
      [1, 2],
      [1, 3],
      [2, 3],
    ]);
    expect(deckTuples(4, 3)).toHaveLength(4);
  });
});

describe('deckMultisets', () => {
  it('adds the diagonal to the combinations, in stable order', () => {
    expect(deckMultisets(3, 2)).toEqual([
      [0, 0],
      [0, 1],
      [0, 2],
      [1, 1],
      [1, 2],
      [2, 2],
    ]);
  });

  it('contains every deckTuple plus one mirror per deck', () => {
    const combinations = deckTuples(4, 2).map((tuple) => tuple.join(','));
    const multisets = deckMultisets(4, 2).map((tuple) => tuple.join(','));
    for (const tuple of combinations) expect(multisets).toContain(tuple);
    expect(multisets).toHaveLength(combinations.length + 4);
  });
});

describe('distinctRotationCount', () => {
  it('counts every rotation of a tuple of distinct decks', () => {
    expect(distinctRotationCount([0, 1])).toBe(2);
    expect(distinctRotationCount([0, 1, 2])).toBe(3);
  });

  it('collapses a mirror to one seating', () => {
    // Rotating [0, 0] gives [0, 0] back: playing it twice is two games of one
    // matchup, not the two seat orientations mirroring exists to compare.
    expect(distinctRotationCount([0, 0])).toBe(1);
    expect(distinctRotationCount([2, 2, 2])).toBe(1);
    expect(distinctRotationCount([0, 0, 1])).toBe(3);
  });
});

describe('pilotTuples', () => {
  it('mirrors one pilot into every seat', () => {
    expect(pilotTuples(3, 2, 'mirror')).toEqual([
      [0, 0],
      [1, 1],
      [2, 2],
    ]);
  });

  it('rotates seats so each pilot plays each position', () => {
    expect(pilotTuples(3, 3, 'rotate')).toEqual([
      [0, 1, 2],
      [1, 2, 0],
      [2, 0, 1],
    ]);
  });

  it('enumerates the full cross product for all_pairs', () => {
    expect(pilotTuples(2, 2, 'all_pairs')).toEqual([
      [0, 0],
      [0, 1],
      [1, 0],
      [1, 1],
    ]);
  });

  it('produces nothing when there are no pilots', () => {
    expect(pilotTuples(0, 2, 'mirror')).toEqual([]);
  });
});

describe('buildSchedule', () => {
  it('covers every deck pair in both seat orientations', () => {
    const matches = buildSchedule(options());
    // 3 pairs x 1 pilot tuple x 2 orientations x 2 games.
    expect(matches).toHaveLength(12);

    const byPair = new Map<string, number[]>();
    for (const match of matches) {
      byPair.set(match.deckPairId, [...(byPair.get(match.deckPairId) ?? []), match.orientation]);
    }
    expect(byPair.size).toBe(3);
    for (const orientations of byPair.values()) {
      expect(orientations.filter((value) => value === 0)).toHaveLength(2);
      expect(orientations.filter((value) => value === 1)).toHaveLength(2);
    }
  });

  it('mirrors seats: every deck sits in every seat an equal number of times', () => {
    const matches = buildSchedule(options());
    const seatCounts = new Map<string, number[]>();
    for (const match of matches) {
      match.seats.forEach((seat, seatIndex) => {
        const key = `d${seat.deckIndex}`;
        const counts = seatCounts.get(key) ?? [0, 0];
        counts[seatIndex] = (counts[seatIndex] ?? 0) + 1;
        seatCounts.set(key, counts);
      });
    }
    for (const counts of seatCounts.values()) {
      expect(counts[0]).toBe(counts[1]);
    }
  });

  it('plays both orientations of one game index on the same shuffles', () => {
    // This is what makes a seat advantage measurable rather than noise: the two
    // orientations of a deck pair share a deck-pair identity, so the seed path
    // for game N is the same in both.
    const matches = buildSchedule(options({ gamesPerPairing: 1 }));
    const pair = matches[0]?.deckPairId as string;
    const inPair = matches.filter((match) => match.deckPairId === pair);
    expect(inPair).toHaveLength(2);
    const [first, second] = inPair;
    expect(first?.seats.map((seat) => seat.deckIndex)).not.toEqual(
      second?.seats.map((seat) => seat.deckIndex),
    );
    // Same pair path, different game index -> different concrete seed, but both
    // derive from a single shared deck-pair path.
    const stripGame = (path: string): string => path.replace(/\|game:\d+$/, '');
    expect(stripGame(first?.seeds.path ?? '')).toBe(stripGame(second?.seeds.path ?? ''));
  });

  it('is a pure function of its options', () => {
    expect(buildSchedule(options())).toEqual(buildSchedule(options()));
  });

  it('returns matches in canonical order regardless of deck ordering', () => {
    const forward = buildSchedule(options());
    const reversed = buildSchedule(options({ decks: [deck(2), deck(1), deck(0)] }));
    expect(reversed.map((match) => match.matchId)).toEqual(forward.map((match) => match.matchId));
    expect(forward.map((match) => match.orderKey)).toEqual(
      [...forward.map((match) => match.orderKey)].sort(),
    );
  });

  it('gives every scheduled match a distinct ID', () => {
    const matches = buildSchedule(
      options({ pilots: [VALUE_PILOT, AGGRESSIVE_PILOT, RANDOM_PILOT], gamesPerPairing: 3 }),
    );
    expect(new Set(matches.map((match) => match.matchId)).size).toBe(matches.length);
  });

  it('separates pilot tuples through the variant key', () => {
    const matches = buildSchedule(options({ pilots: [VALUE_PILOT, AGGRESSIVE_PILOT] }));
    expect(new Set(matches.map((match) => match.variantKey)).size).toBe(2);
  });

  it('samples deterministically and honours the cap', () => {
    const many = Array.from({ length: 8 }, (_, index) => deck(index));
    const sampled = buildSchedule(
      options({ decks: many, schedule: 'sampled', sampledPairings: 5, gamesPerPairing: 1 }),
    );
    expect(new Set(sampled.map((match) => match.deckPairId)).size).toBe(5);
    const again = buildSchedule(
      options({ decks: many, schedule: 'sampled', sampledPairings: 5, gamesPerPairing: 1 }),
    );
    expect(again.map((match) => match.matchId)).toEqual(sampled.map((match) => match.matchId));
  });

  it('drops the environment from the seed path when seeds are paired', () => {
    const plain = buildSchedule(options({ gamesPerPairing: 1, mirrorSeats: false }));
    const paired = buildSchedule(
      options({ gamesPerPairing: 1, mirrorSeats: false, pairedSeeds: true }),
    );
    const candidate = buildSchedule(
      options({
        gamesPerPairing: 1,
        mirrorSeats: false,
        pairedSeeds: true,
        environmentId: 'candidate',
      }),
    );

    expect(plain[0]?.seeds.path).toContain('env:baseline');
    expect(paired[0]?.seeds.path).not.toContain('env:');
    // Common random numbers across environments.
    expect(candidate.map((match) => match.seeds.matchSeed)).toEqual(
      paired.map((match) => match.seeds.matchSeed),
    );
    // …but the records still say which environment they belong to.
    expect(candidate[0]?.environmentId).toBe('candidate');
  });

  it('masks replacement arms in the seed path only', () => {
    const arms = [deck(0), deck(1)];
    const field = deck(2);
    const base: Partial<ScheduleOptions> = {
      decks: [arms[0] as SimDeck, field],
      gamesPerPairing: 1,
      mirrorSeats: false,
    };
    const masked = [arms[0]?.hash ?? '', arms[1]?.hash ?? ''];

    const armA = buildSchedule(
      options({ ...base, decks: [arms[0] as SimDeck, field], seedIgnoreDeckHashes: masked }),
    );
    const armB = buildSchedule(
      options({ ...base, decks: [arms[1] as SimDeck, field], seedIgnoreDeckHashes: masked }),
    );

    // Same shuffles for both arms of the substitution…
    expect(armB[0]?.seeds.matchSeed).toBe(armA[0]?.seeds.matchSeed);
    // …but the recorded deck-pair identity still distinguishes them.
    expect(armB[0]?.deckPairId).not.toBe(armA[0]?.deckPairId);
  });

  it('schedules every ordered pair, mirrors included, when asked (M03.4)', () => {
    const decks = Array.from({ length: 4 }, (_, index) => deck(index));
    const matches = buildSchedule(
      options({ decks, gamesPerPairing: 1, includeMirrorMatchups: true }),
    );

    // 4 x 4 ordered pairs: six deck pairs both ways round, plus four mirrors.
    expect(matches).toHaveLength(16);

    const ordered = new Set(
      matches.map((match) => match.seats.map((seat) => seat.deckIndex).join('->')),
    );
    expect(ordered.size).toBe(16);
    for (let first = 0; first < 4; first += 1) {
      for (let second = 0; second < 4; second += 1) {
        expect(ordered).toContain(`${first}->${second}`);
      }
    }
    expect(new Set(matches.map((match) => match.matchId)).size).toBe(16);
  });

  it('plays a mirror once rather than twice on two seeds', () => {
    const matches = buildSchedule(
      options({ decks: [deck(0), deck(1)], gamesPerPairing: 1, includeMirrorMatchups: true }),
    );
    const mirrors = matches.filter(
      (match) => match.seats[0]?.deckIndex === match.seats[1]?.deckIndex,
    );
    expect(mirrors).toHaveLength(2);
    for (const mirror of mirrors) expect(mirror.orientation).toBe(0);
  });

  it('leaves a schedule without mirrors byte-identical', () => {
    // Turning the option on must be the only thing that adds matches: every
    // tuple of distinct decks has as many distinct rotations as it has seats.
    const decks = Array.from({ length: 4 }, (_, index) => deck(index));
    const plain = buildSchedule(options({ decks, gamesPerPairing: 2 }));
    const withMirrors = buildSchedule(
      options({ decks, gamesPerPairing: 2, includeMirrorMatchups: true }),
    );
    const notMirrored = withMirrors.filter(
      (match) => match.seats[0]?.deckIndex !== match.seats[1]?.deckIndex,
    );
    expect(notMirrored).toEqual(plain);
  });

  it('refuses a table it cannot seat', () => {
    expect(() => buildSchedule(options({ decks: [deck(0)], playerCount: 2 }))).toThrow(
      /at least 2 decks/,
    );
  });

  it('scales to a four-player table', () => {
    const decks = Array.from({ length: 4 }, (_, index) => deck(index));
    const matches = buildSchedule(
      options({ decks, playerCount: 4, gamesPerPairing: 1, pilots: [VALUE_PILOT] }),
    );
    // One tuple, four rotations.
    expect(matches).toHaveLength(4);
    expect(matches[0]?.seats).toHaveLength(4);
    expect(matches[0]?.seeds.pilotSeeds).toHaveLength(4);
  });
});

/**
 * The crossing filter a replacement experiment and a search generation both use,
 * and which M08.3's estimator now counts through (ADR 0023 §2).
 */
describe('matchesBetween', () => {
  const decks = Array.from({ length: 4 }, (_, index) => deck(index));
  const schedule = buildSchedule(options({ decks, gamesPerPairing: 1 }));

  it('keeps exactly the matches that seat one deck from each group', () => {
    const arms = new Set([decks[0]?.hash ?? '', decks[1]?.hash ?? '']);
    const field = new Set([decks[2]?.hash ?? '', decks[3]?.hash ?? '']);
    const crossing = matchesBetween(schedule, decks, arms, field);

    expect(crossing.length).toBeGreaterThan(0);
    for (const match of crossing) {
      const hashes = match.seats.map((seat) => decks[seat.deckIndex]?.hash ?? '');
      expect(hashes.some((hash) => arms.has(hash))).toBe(true);
      expect(hashes.some((hash) => field.has(hash))).toBe(true);
    }
    // Four decks, two per group: four crossing pairs, two seat orientations each.
    expect(crossing).toHaveLength(8);
    // Arm-versus-arm and field-versus-field are what the filter is there to drop.
    expect(schedule.length - crossing.length).toBe(4);
  });

  it('is a subset of the schedule it was given, in the same order', () => {
    const arms = new Set([decks[0]?.hash ?? '']);
    const field = new Set(decks.map((entry) => entry.hash));
    const crossing = matchesBetween(schedule, decks, arms, field);
    expect(crossing).toEqual(schedule.filter((match) => crossing.includes(match)));
  });

  it('lets one seat satisfy both groups, because a search field overlaps its population', () => {
    // A search's opponents are drawn from the archive *and* the current
    // population, so a contender can be its own field. The rule is about the
    // match seating a member of each group, and one seat can be both members —
    // which is what `evaluate` has always done and what the estimator must
    // therefore count the same way.
    const both = new Set([decks[0]?.hash ?? '', decks[1]?.hash ?? '']);
    const crossing = matchesBetween(schedule, decks, both, both);
    // Five of the six tuples seat d0 or d1; each is played in two orientations.
    expect(crossing).toHaveLength(10);
    expect(schedule).toHaveLength(12);
  });

  it('keeps nothing when a group names no deck in the schedule', () => {
    const arms = new Set([decks[0]?.hash ?? '']);
    expect(matchesBetween(schedule, decks, arms, new Set(['not-a-deck-hash']))).toEqual([]);
  });
});
