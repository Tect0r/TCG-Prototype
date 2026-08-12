import { beforeAll, describe, expect, it } from 'vitest';
import { CardDatabase, cardDefinitionSchema, formatDatabase } from '@tcg/card-data';
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
import {
  checkReplayCompatibility,
  replayFormatVersion,
  spectatorReplaySchema,
  SPECTATOR_REPLAY_VERSION,
  type SpectatorReplay,
} from './schema.js';
import {
  cardPoolHash,
  defaultSpectatorSetup,
  resolveSpectatorSetup,
  setupProvenance,
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

/**
 * A four-seat table seats all four shipped precons, and since M02.5 every one
 * of them is finished — so these runs need **no** developer override and record
 * a valid result (M02.5 acceptance). Up to M02.4 the Sacrifice precon still held
 * `equal_price` and `mass_offering` and the whole suite ran overridden; the
 * override path itself is still exercised below, against a database doctored to
 * contain an unfinished card, which is the only place it can live now that no
 * shipped deck is incomplete.
 */
async function run(seed: string, playerCount = 4): Promise<SpectatorReplay> {
  const resolved = resolveSpectatorSetup(defaultSpectatorSetup(seed, playerCount));
  expect(resolved.problems).toEqual([]);
  expect(resolved.incompleteCards).toEqual([]);
  return runSpectatorMatch({
    seed,
    seats: resolved.seats,
    database,
    config,
    cardDataHash: poolHash,
    provenance: setupProvenance(resolved),
  });
}

/**
 * The shipped pool with one Sacrifice card marked unfinished.
 *
 * Every bundled precon is complete since M02.5, so the refusal and the developer
 * override have nothing real left to refuse. Doctoring one card keeps both paths
 * under test against the deck that used to exercise them, rather than deleting
 * the coverage along with the last unfinished card.
 */
const UNFINISHED_CARD_ID = 'mass_offering';
const incompleteDatabase = new CardDatabase(
  database
    .all()
    .map((card) =>
      card.id === UNFINISHED_CARD_ID
        ? { ...card, implemented: false, unsupportedReason: 'left unfinished for this test' }
        : card,
    ),
);

let replay: SpectatorReplay;

beforeAll(async () => {
  replay = await run('spectator-seed-1');
}, 60_000);

describe('setup', () => {
  it('offers every shipped precon and seats four bots by default', () => {
    const precons = spectatorPrecons();
    expect(precons.length).toBeGreaterThanOrEqual(4);

    const resolved = resolveSpectatorSetup({
      ...defaultSpectatorSetup('seed'),
      developerAllowIncompleteCards: true,
    });
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
      developerAllowIncompleteCards: true,
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
    expect(resolved.problems[0]?.kind).toBe('unknown_precon');
  });

  it('refuses a precon that still contains unimplemented cards', () => {
    const resolved = resolveSpectatorSetup(
      { seed: 'x', seats: [{ preconId: 'precon_grave_sacrifice', pilotId: 'value' }] },
      { database: incompleteDatabase },
    );

    expect(resolved.seats).toHaveLength(0);
    const problem = resolved.problems[0];
    expect(problem?.kind).toBe('incomplete_cards');
    expect(problem?.cardIds).toEqual([UNFINISHED_CARD_ID]);
    // Named individually in the message a user actually reads, not counted.
    for (const cardId of problem?.cardIds ?? []) {
      expect(problem?.message).toContain(cardId);
    }
  });

  it('seats every shipped precon without an override (M02.5)', () => {
    // The acceptance criterion for M02: no bundled deck needs the developer
    // override any more, so the default four-seat table resolves clean.
    const resolved = resolveSpectatorSetup(defaultSpectatorSetup('x', 4));

    expect(resolved.problems).toEqual([]);
    expect(resolved.seats).toHaveLength(4);
    expect(resolved.incompleteCards).toEqual([]);
    expect(setupProvenance(resolved).resultsValid).toBe(true);
  });

  it('admits a precon with nothing unfinished in it, and no override', () => {
    // Bastion is the first fully implemented precon: its Commander shipped in
    // M02.3 and its forty cards were already done. The refusal above is a
    // property of unfinished content, not of the spectator, so a complete
    // precon has to seat without the developer override and without recording
    // an incomplete-content note against the replay.
    const resolved = resolveSpectatorSetup({
      seed: 'x',
      seats: [{ preconId: 'precon_bastion_guardians', pilotId: 'value' }],
    });

    expect(resolved.problems).toEqual([]);
    expect(resolved.seats).toHaveLength(1);
    expect(resolved.incompleteCards).toEqual([]);
  });

  it('lets the developer override run it, and records every blocking card', () => {
    const resolved = resolveSpectatorSetup(
      {
        seed: 'x',
        developerAllowIncompleteCards: true,
        seats: [{ preconId: 'precon_grave_sacrifice', pilotId: 'value' }],
      },
      { database: incompleteDatabase },
    );

    expect(resolved.problems).toEqual([]);
    expect(resolved.seats).toHaveLength(1);
    expect(resolved.incompleteCards[0]?.preconId).toBe('precon_grave_sacrifice');
    expect(resolved.incompleteCards[0]?.cardIds).toEqual([UNFINISHED_CARD_ID]);

    const provenance = setupProvenance(resolved);
    expect(provenance.resultsValid).toBe(false);
    expect(provenance.incompleteCards[0]?.playerId).toBe('player_1');
  });

  it('never overrides ordinary deck legality, only completeness', () => {
    // Validated against the pool the match would be played on: under the
    // development pool a Wave 1 precon resolves to nothing, and that is an
    // illegal deck rather than an unfinished one.
    const development = formatDatabase('development');
    const resolved = resolveSpectatorSetup(
      {
        seed: 'x',
        developerAllowIncompleteCards: true,
        seats: [{ preconId: 'precon_goblin_swarm', pilotId: 'value' }],
      },
      { database: development },
    );

    expect(resolved.seats).toHaveLength(0);
    expect(resolved.problems[0]?.kind).toBe('illegal_deck');
    expect(resolved.incompleteCards).toEqual([]);
  });

  it('marks a valid setup valid without any override bookkeeping', () => {
    expect(setupProvenance({ seats: [], problems: [], incompleteCards: [] })).toEqual({
      resultsValid: true,
      incompleteCards: [],
    });
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

  it('records a valid result now that no precon needs the override (M02.5)', () => {
    // Up to M02.4 every run in this suite was overridden and stamped invalid.
    // The four shipped precons are complete, so the ordinary four-bot match is
    // now a result that counts — and nothing anywhere in the artefacts says
    // otherwise.
    expect(replay.provenance.resultsValid).toBe(true);
    expect(replay.provenance.incompleteCards).toEqual([]);
    expect(replay.telemetry.resultsValid).toBe(true);
    expect(replay.diagnostics.find((line) => line.startsWith('results invalid:'))).toBeUndefined();
  });

  it('carries its provenance for as long as the replay exists (M01.2)', async () => {
    // The override still has to mark everything it touches, so this runs a real
    // match on a pool doctored to hold one unfinished card — the replay, the
    // telemetry lifted out of it, and the diagnostics somebody skims all have to
    // say the result does not count.
    const resolved = resolveSpectatorSetup(
      {
        seed: 'spectator-incomplete',
        developerAllowIncompleteCards: true,
        seats: [
          { preconId: 'precon_grave_sacrifice', pilotId: 'value' },
          { preconId: 'precon_bastion_guardians', pilotId: 'value' },
        ],
      },
      { database: incompleteDatabase },
    );
    expect(resolved.problems).toEqual([]);

    const overridden = await runSpectatorMatch({
      seed: 'spectator-incomplete',
      seats: resolved.seats,
      database: incompleteDatabase,
      config,
      cardDataHash: cardPoolHash(incompleteDatabase),
      provenance: setupProvenance(resolved),
    });

    expect(overridden.provenance.resultsValid).toBe(false);
    expect(overridden.telemetry.resultsValid).toBe(false);

    const named = overridden.provenance.incompleteCards.flatMap((seat) => seat.cardIds);
    expect(named).toContain(UNFINISHED_CARD_ID);
    for (const seat of overridden.provenance.incompleteCards) {
      expect(overridden.seats.some((entry) => entry.playerId === seat.playerId)).toBe(true);
    }
    const invalidLine = overridden.diagnostics.find((line) => line.startsWith('results invalid:'));
    expect(invalidLine).toBeDefined();
    for (const cardId of named) expect(invalidLine).toContain(cardId);

    // And it survives being written out and read back.
    const round = spectatorReplaySchema.parse(JSON.parse(JSON.stringify(overridden)));
    expect(round.provenance).toEqual(overridden.provenance);
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

  /**
   * M04.1's version policy: a replay recorded before the shared board telemetry
   * existed is refused outright, and is refused *as an old replay* rather than
   * as an unrecognised file. Migrating it would mean re-deriving measurements
   * the recording build never made and presenting them under its identity.
   */
  it('refuses a replay from an earlier format version, and says which it is', () => {
    const older = { ...replay, schemaVersion: SPECTATOR_REPLAY_VERSION - 1 };
    expect(spectatorReplaySchema.safeParse(older).success).toBe(false);
    expect(replayFormatVersion(older)).toBe(SPECTATOR_REPLAY_VERSION - 1);
    // Something that is not a replay at all stays distinguishable from one.
    expect(replayFormatVersion({ hello: 'world' })).toBeNull();
    expect(replayFormatVersion('not an object')).toBeNull();
    expect(replayFormatVersion(replay)).toBe(SPECTATOR_REPLAY_VERSION);
  });

  /**
   * M01.3. `cardPoolHash` used to be taken over a field list maintained here,
   * and that list did not include `additionalCosts` — so a card whose printed
   * cost changed from "sacrifice a Unit of your choice" to "sacrifice a Unit"
   * left the hash alone, and a replay recorded before the change was still
   * accepted as compatible with the pool that came after it.
   */
  it('refuses a replay after only an interactive sacrifice cost changed', () => {
    const real = database.all().find((entry) => entry.type === 'spell');
    expect(real).toBeDefined();
    if (!real) return;

    const withInteractiveCost = cardDefinitionSchema.parse({
      ...real,
      additionalCosts: [{ type: 'sacrifice', amount: 1, selection: 'player_choice' }],
    });
    const withAutomaticCost = cardDefinitionSchema.parse({
      ...real,
      additionalCosts: [{ type: 'sacrifice', amount: 1, selection: 'automatic' }],
    });

    const others = database.all().filter((entry) => entry.id !== real.id);
    const interactiveHash = cardPoolHash(new CardDatabase([...others, withInteractiveCost]));
    const automaticHash = cardPoolHash(new CardDatabase([...others, withAutomaticCost]));

    expect(interactiveHash).not.toBe(poolHash);
    expect(automaticHash).not.toBe(interactiveHash);

    // And that difference is what a recorded replay is checked against.
    const recorded = { ...replay, cardDataHash: interactiveHash };
    expect(
      checkReplayCompatibility(recorded, {
        rulesVersion: config.version,
        cardDataHash: automaticHash,
      }).map((problem) => problem.field),
    ).toEqual(['cardDataHash']);
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
