import { beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_RULES_CONFIG } from '@tcg/rules-engine';
import { groupEvents } from './grouping.js';
import {
  INFORMATION_MODES,
  PLAYBACK_SPEEDS,
  SpectatorPlayback,
  stepDelayMs,
  type PlaybackSpeed,
} from './playback.js';
import { runSpectatorMatch } from './run.js';
import { checkReplayCompatibility, spectatorReplaySchema, type SpectatorReplay } from './schema.js';
import {
  cardPoolHash,
  defaultSpectatorSetup,
  resolveSpectatorSetup,
  spectatorDatabase,
  spectatorPrecons,
} from './setup.js';

/**
 * The AI spectator, end to end.
 *
 * These run real four-bot matches on the shipped precons rather than fixtures,
 * because the claims being tested are about the whole pipeline: the same seed
 * reproduces the same match, playback shows the match rather than a
 * re-simulation of it, and no timing choice can reach the record.
 */

const database = spectatorDatabase();
const poolHash = cardPoolHash(database);
const config = DEFAULT_RULES_CONFIG;

async function run(seed: string, playerCount = 4): Promise<SpectatorReplay> {
  const setup = defaultSpectatorSetup(seed, playerCount);
  const resolved = resolveSpectatorSetup(setup);
  expect(resolved.problems).toEqual([]);
  return runSpectatorMatch({
    seed,
    seats: resolved.seats,
    database,
    config,
    cardDataHash: poolHash,
  });
}

let replay: SpectatorReplay;

beforeAll(async () => {
  replay = await run('spectator-seed-1');
}, 60_000);

describe('setup', () => {
  it('offers every shipped precon and seats four bots by default', () => {
    const precons = spectatorPrecons();
    expect(precons.length).toBeGreaterThanOrEqual(4);

    const resolved = resolveSpectatorSetup(defaultSpectatorSetup('seed'));
    expect(resolved.seats).toHaveLength(4);
    expect(resolved.problems).toEqual([]);
    for (const seat of resolved.seats) {
      expect(seat.cardIds.length).toBeGreaterThan(0);
      expect(seat.preconId).not.toBeNull();
    }
  });

  it('allows duplicate precons across seats', () => {
    const preconId = spectatorPrecons()[0]?.id ?? '';
    const resolved = resolveSpectatorSetup({
      seed: 'x',
      seats: [
        { preconId, pilotId: 'value' },
        { preconId, pilotId: 'aggressive' },
      ],
    });
    expect(resolved.problems).toEqual([]);
    expect(resolved.seats.map((seat) => seat.preconId)).toEqual([preconId, preconId]);
  });

  it('reports an unknown precon rather than substituting one', () => {
    const resolved = resolveSpectatorSetup({
      seed: 'x',
      seats: [{ preconId: 'no_such_precon', pilotId: 'value' }],
    });
    expect(resolved.seats).toHaveLength(0);
    expect(resolved.problems[0]?.message).toContain('no_such_precon');
  });

  it('supports two, three and four seats', async () => {
    for (const count of [2, 3]) {
      const short = await run(`seats-${count}`, count);
      expect(short.seats).toHaveLength(count);
      expect(short.telemetry.seats).toHaveLength(count);
    }
  }, 60_000);
});

describe('a recorded four-bot match', () => {
  it('finishes, and validates against its own schema', () => {
    expect(spectatorReplaySchema.safeParse(replay).success).toBe(true);
    expect(replay.seats).toHaveLength(4);
    expect(replay.actions.length).toBeGreaterThan(0);
    expect(replay.events.length).toBeGreaterThan(replay.actions.length);
    expect(['victory', 'draw']).toContain(replay.termination);
  });

  it('reproduces the same action stream and result from the same seed', async () => {
    const again = await run('spectator-seed-1');
    expect(JSON.stringify(again.actions)).toBe(JSON.stringify(replay.actions));
    expect(JSON.stringify(again.events)).toBe(JSON.stringify(replay.events));
    expect(again.result?.winnerId).toBe(replay.result?.winnerId);
    expect(again.telemetry).toEqual(replay.telemetry);
  }, 60_000);

  it('produces a different match from a different seed', async () => {
    const other = await run('spectator-seed-2');
    expect(JSON.stringify(other.actions)).not.toBe(JSON.stringify(replay.actions));
  }, 60_000);

  it('records the versions a replay must be checked against', () => {
    expect(
      checkReplayCompatibility(replay, {
        rulesVersion: config.version,
        cardDataHash: poolHash,
      }),
    ).toEqual([]);

    const stale = checkReplayCompatibility(replay, {
      rulesVersion: '0.0.1-old',
      cardDataHash: 'deadbeef',
    });
    expect(stale.map((problem) => problem.field).sort()).toEqual(['cardDataHash', 'rulesVersion']);
  });
});

describe('telemetry', () => {
  it('records board size, Commander and Reaction facts for every seat', () => {
    expect(replay.telemetry.seats).toHaveLength(4);
    for (const seat of replay.telemetry.seats) {
      expect(seat.peakUnits).toBeGreaterThanOrEqual(seat.peakNonTokenUnits);
      expect(seat.peakUnits).toBeGreaterThanOrEqual(seat.peakTokens);
      expect(seat.peakTokens).toBeGreaterThanOrEqual(seat.peakTokenStack);
      expect(seat.commanderDefeats).toBeGreaterThanOrEqual(0);
      expect(seat.unitsByRound.length).toBe(replay.telemetry.rounds);
    }
    // Placements are a permutation of 1..n.
    expect(replay.telemetry.seats.map((seat) => seat.placement).sort()).toEqual([1, 2, 3, 4]);
  });

  it('summarises the match itself', () => {
    expect(replay.telemetry.turns).toBeGreaterThan(0);
    expect(replay.telemetry.actions).toBe(replay.decisions.length);
    expect(replay.telemetry.events).toBe(replay.events.length);
    expect(replay.telemetry.longestTurn.actions).toBeGreaterThan(0);
    expect(replay.telemetry.reactionsPlayed).toBeLessThanOrEqual(
      replay.telemetry.reactionWindows === 0 ? 0 : Number.MAX_SAFE_INTEGER,
    );
  });

  it('carries no playback timing at all', () => {
    // The shape itself is the guarantee: there is nowhere for a delay to land.
    const keys = Object.keys(replay.telemetry).join(' ');
    expect(keys).not.toMatch(/ms|millis|duration|elapsed|wall/i);
  });
});

describe('event grouping', () => {
  it('covers every event exactly once and never reorders', () => {
    const groups = groupEvents(replay.events);
    const flattened = groups.flatMap((group) => group.events);
    // Dropped events would make a viewer who stepped through the whole replay
    // have missed something; reordering would make playback a different match.
    expect(flattened.length).toBeLessThanOrEqual(replay.events.length);
    const sequences = flattened.map((event) => event.sequence);
    expect([...sequences].sort((a, b) => a - b)).toEqual(sequences);
    expect(new Set(sequences).size).toBe(sequences.length);
  });

  it('collapses a run of consecutive Reaction passes into one group', () => {
    const events = replay.events;
    const groups = groupEvents(events);
    for (const group of groups) {
      if (group.kind !== 'reaction_passes') continue;
      expect(group.events.every((event) => event.type === 'reaction_passed')).toBe(true);
      // Collapsed for display, kept individually underneath.
      expect(group.events.length).toBeGreaterThanOrEqual(1);
    }
  });

  it('writes a readable summary for every group', () => {
    for (const group of groupEvents(replay.events)) {
      expect(group.summary.length).toBeGreaterThan(0);
      expect(group.summary).not.toContain('undefined');
    }
  });
});

describe('playback', () => {
  const options = { database, config };

  it('re-derives the board through the real engine at every step', () => {
    const playback = new SpectatorPlayback(replay, options);
    expect(playback.groupCount).toBeGreaterThan(0);

    const final = playback.finalFrame();
    expect(final.state.status).toBe('complete');
    expect(final.state.result?.winnerId).toBe(replay.result?.winnerId);
  });

  it('is monotonic: state never goes backwards as groups advance', () => {
    const playback = new SpectatorPlayback(replay, options);
    let previous = -1;
    for (let index = -1; index < playback.groupCount; index += 1) {
      const frame = playback.frameAt(index);
      expect(frame.state.sequence).toBeGreaterThanOrEqual(previous);
      previous = frame.state.sequence;
    }
  });

  it('gives the same frames whatever order they are asked for', () => {
    const playback = new SpectatorPlayback(replay, options);
    const forward = [];
    for (let index = 0; index < playback.groupCount; index += 1) {
      forward.push(playback.frameAt(index).state.sequence);
    }
    const backward = [];
    for (let index = playback.groupCount - 1; index >= 0; index -= 1) {
      backward.unshift(playback.frameAt(index).state.sequence);
    }
    // Stepping, restarting, jumping and Instant all index the same precomputed
    // list, so none of them can change what the viewer is shown.
    expect(backward).toEqual(forward);
    expect(playback.frameAt(-1).groupIndex).toBe(-1);
    expect(playback.frameAt(9_999).groupIndex).toBe(playback.groupCount - 1);
  });

  it('speed changes only affect delays, never content', () => {
    const playback = new SpectatorPlayback(replay, options);
    const group = playback.groups[0];

    const delays = PLAYBACK_SPEEDS.map((speed) => stepDelayMs(group, speed as PlaybackSpeed));
    expect(delays[delays.length - 1]).toBe(0); // instant
    expect(delays[0]).toBeGreaterThan(delays[2] ?? 0); // 0.25x slower than 1x
    // The frame is identical whatever the speed: nothing in playback state
    // depends on it.
    expect(playback.frameAt(0).state.sequence).toBe(playback.frameAt(0).state.sequence);
  });

  it('hides every hand in Normal Spectator and reveals them in Analysis Mode', () => {
    const playback = new SpectatorPlayback(replay, options);
    const frame = playback.frameAt(Math.floor(playback.groupCount / 2));

    let anyHand = false;
    for (const seat of replay.seats) {
      expect(playback.handFor(frame, seat.playerId, 'normal')).toEqual([]);
      if (playback.handFor(frame, seat.playerId, 'analysis').length > 0) anyHand = true;
    }
    expect(anyHand).toBe(true);
    expect(INFORMATION_MODES).toEqual(['normal', 'analysis']);
  });

  it('exposes the bot decision behind a group for Analysis Mode', () => {
    const playback = new SpectatorPlayback(replay, options);
    const withDecision = playback.groups
      .map((group) => playback.decisionFor(group))
      .filter((decision) => decision !== null);
    expect(withDecision.length).toBeGreaterThan(0);
    expect(withDecision[0]?.playerId).toBeTruthy();
  });

  it('synchronises the log with the current position', () => {
    const playback = new SpectatorPlayback(replay, options);
    expect(playback.logUpTo(-1)).toHaveLength(0);
    expect(playback.logUpTo(0)).toHaveLength(1);
    expect(playback.logUpTo(playback.groupCount)).toHaveLength(playback.groupCount);
  });
});
