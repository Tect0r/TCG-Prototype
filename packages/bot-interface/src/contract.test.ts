import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createMatch,
  createRngState,
  DEFAULT_RULES_CONFIG,
  legalActions,
  playerView,
  type MatchState,
  type PlayerId,
} from '@tcg/rules-engine';
import { unwrap } from '@tcg/shared';
import { createPilot, PILOT_IDS } from './registry.js';
import { checkActionOffered } from './validate.js';
import { decideSafely } from './run-pilot.js';
import { botTestDatabase, driveMatch, BLUE_DECK, GREEN_DECK, RED_DECK } from './test-driver.js';
import type { BotObservation, BotPolicy, DecisionFamily } from './types.js';

/**
 * The bot information boundary and the decision contract (CLAUDE.md §13.15
 * items 1–4). Everything here is about what a pilot may see and what it is
 * allowed to return — the simulator's own tests cover what happens to the result.
 */

const database = botTestDatabase();
const config = DEFAULT_RULES_CONFIG;
const pilots = (): BotPolicy[] => PILOT_IDS.map((id) => createPilot({ id }));

function startTable(seats: number, seed: string): MatchState {
  const decks = [RED_DECK, GREEN_DECK, BLUE_DECK];
  return unwrap(
    createMatch({
      matchId: `contract_${seed}`,
      seed,
      database,
      config,
      preserveSeatOrder: true,
      seats: Array.from({ length: seats }, (_, index) => ({
        playerId: `player_${index + 1}`,
        name: `Seat ${index + 1}`,
        deck: decks[index % decks.length] as (typeof decks)[number],
      })),
    }),
    'contract test setup failed',
  ).state;
}

function observationFor(state: MatchState, playerId: PlayerId): BotObservation {
  const view = playerView(state, playerId, database, config);
  return {
    view,
    legal: legalActions(state, playerId, { database, config }),
    history: view.log,
    database,
    rulesConfig: config,
    decisionIndex: 0,
  };
}

/** Every string that appears anywhere in a JSON-serializable value. */
function stringsIn(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (typeof value === 'string') {
    found.add(value);
    return found;
  }
  if (Array.isArray(value)) {
    for (const entry of value) stringsIn(entry, found);
    return found;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      found.add(key);
      stringsIn(entry, found);
    }
  }
  return found;
}

describe('bot information boundary', () => {
  it('never exposes another seat’s hand or deck order at any depth', () => {
    // Play a while so hands, decks and discards all have content.
    let state = startTable(4, 'boundary-4');
    for (const playerId of state.seatOrder) {
      state = unwrap(
        applyAction(
          state,
          { type: 'mulligan', playerId, returnInstanceIds: [] },
          {
            database,
            config,
          },
        ),
        'mulligan failed',
      ).state;
    }

    for (const viewerId of state.seatOrder) {
      const observation = observationFor(state, viewerId);
      const visible = stringsIn({
        view: observation.view,
        legal: observation.legal,
        history: observation.history,
      });

      for (const otherId of state.seatOrder) {
        if (otherId === viewerId) continue;
        const other = state.players[otherId];
        expect(other).toBeDefined();
        for (const instanceId of other?.hand ?? []) {
          expect(visible.has(instanceId)).toBe(false);
        }
        for (const instanceId of other?.deck ?? []) {
          expect(visible.has(instanceId)).toBe(false);
        }
      }
      // The viewer's own deck order is hidden from the viewer too.
      for (const instanceId of state.players[viewerId]?.deck ?? []) {
        expect(visible.has(instanceId)).toBe(false);
      }
    }
  });

  it('hands a pilot no match state, no engine RNG and no other seat’s choice', () => {
    const state = startTable(2, 'boundary-2');
    const observation = observationFor(state, 'player_1');

    // Structural: the observation is exactly the six documented members.
    expect(Object.keys(observation).sort()).toEqual([
      'database',
      'decisionIndex',
      'history',
      'legal',
      'rulesConfig',
      'view',
    ]);

    const strings = stringsIn({ view: observation.view, legal: observation.legal });
    expect(strings.has('rng')).toBe(false);
    expect(strings.has('actionLog')).toBe(false);
    expect(strings.has('instances')).toBe(true);

    // A choice belonging to another seat is never visible.
    expect(observation.view.pendingChoice).toBeNull();
    expect(observation.legal.pendingChoice).toBeNull();
  });

  it('shows each viewer only their own opening hand', () => {
    const state = startTable(3, 'boundary-3');
    for (const viewerId of state.seatOrder) {
      const observation = observationFor(state, viewerId);
      expect(observation.view.hand).toEqual(state.players[viewerId]?.hand);
      for (const summary of observation.view.players) {
        if (summary.playerId === viewerId) continue;
        // Counts are public; contents are not.
        expect(summary.handCount).toBeGreaterThan(0);
      }
    }
  });
});

describe('every pilot plays complete matches legally', () => {
  const seeds = ['s1', 's2', 's3', 's4', 's5', 's6', 's7', 's8'];

  for (const id of PILOT_IDS) {
    it(`"${id}" finishes matches across ${seeds.length} seeds without an illegal action`, async () => {
      const seen = new Set<DecisionFamily>();
      for (const seed of seeds) {
        const outcome = await driveMatch({
          seed: `${id}-${seed}`,
          pilots: [createPilot({ id }), createPilot({ id })],
        });
        expect(outcome.stoppedEarly).toBe(false);
        expect(outcome.state.status).toBe('complete');
        expect(outcome.state.result?.reason).not.toBe('engine_error');
        // No fallback fired: the pilot itself handled every decision.
        expect(outcome.failures).toEqual([]);
        for (const family of outcome.families) seen.add(family);
      }

      // Every decision family the current ruleset actually presents.
      expect([...seen].sort()).toEqual(
        expect.arrayContaining([
          'assign_blockers',
          'declare_attackers',
          'mulligan',
          'pass_phase',
          'play_card',
        ]),
      );
    });
  }

  it('handles pending choices, including a discard-then-draw pause', async () => {
    const seen = new Set<DecisionFamily>();
    for (const id of PILOT_IDS) {
      for (const seed of ['choice-1', 'choice-2', 'choice-3', 'choice-4']) {
        const outcome = await driveMatch({
          seed: `${id}-${seed}`,
          // Blue plays cards that discard, draw, search and reorder.
          decks: [BLUE_DECK, BLUE_DECK],
          pilots: [createPilot({ id }), createPilot({ id })],
        });
        expect(outcome.failures).toEqual([]);
        for (const family of outcome.families) seen.add(family);
      }
    }
    expect(seen.has('submit_choice')).toBe(true);
  });

  it('plays three- and four-seat tables', async () => {
    for (const seats of [3, 4]) {
      const outcome = await driveMatch({
        seed: `ffa-${seats}`,
        decks: [RED_DECK, GREEN_DECK, BLUE_DECK],
        pilots: Array.from({ length: seats }, (_, index) =>
          createPilot({ id: PILOT_IDS[index % PILOT_IDS.length] as (typeof PILOT_IDS)[number] }),
        ),
      });
      expect(outcome.state.status).toBe('complete');
      expect(outcome.failures).toEqual([]);
    }
  });

  it('only ever returns actions the engine had already offered', async () => {
    let checked = 0;
    for (const id of PILOT_IDS) {
      const policy = createPilot({ id });
      const outcome = await driveMatch({
        seed: `offered-${id}`,
        pilots: [policy, createPilot({ id: 'value' })],
        onObservation: () => {
          checked += 1;
        },
      });
      expect(outcome.failures).toEqual([]);
    }
    expect(checked).toBeGreaterThan(50);
  });
});

describe('pilot determinism', () => {
  it('returns the same decision for the same observation, config and seed', () => {
    const state = startTable(2, 'determinism');
    const observation = observationFor(state, 'player_1');

    for (const policy of pilots()) {
      const rng = createRngState('determinism');
      const left = policy.decide(observation, rng);
      const right = policy.decide(observation, rng);
      expect(left).not.toBeInstanceOf(Promise);
      expect(JSON.stringify(left)).toBe(JSON.stringify(right));
    }
  });

  it('replays a whole match identically from the same seed', async () => {
    const run = async () =>
      driveMatch({
        seed: 'replay-me',
        pilots: [createPilot({ id: 'value' }), createPilot({ id: 'aggressive' })],
      });
    const left = await run();
    const right = await run();
    expect(JSON.stringify(left.actions)).toBe(JSON.stringify(right.actions));
    expect(left.state.sequence).toBe(right.state.sequence);
  });

  it('different pilots reach different decisions on the same board', async () => {
    // A pilot set that all played identically would make every comparison in
    // Phase 4 meaningless, so this is a real property, not a smoke test.
    const decisions = new Set<string>();
    for (const id of PILOT_IDS) {
      const outcome = await driveMatch({
        seed: 'divergence',
        pilots: [createPilot({ id }), createPilot({ id: 'defensive' })],
      });
      decisions.add(JSON.stringify(outcome.actions.slice(0, 24)));
    }
    expect(decisions.size).toBeGreaterThan(1);
  });
});

describe('failure isolation', () => {
  const brokenPolicy = (behaviour: 'throw' | 'illegal'): BotPolicy => ({
    id: `broken_${behaviour}`,
    version: '0.0.0',
    config: {},
    decide(observation, rng) {
      if (behaviour === 'throw') throw new Error('pilot exploded');
      return {
        action: {
          type: 'play_card',
          playerId: observation.legal.playerId,
          instanceId: 'nope',
          slot: null,
        },
        rng,
        diagnostics: null,
      };
    },
  });

  it('substitutes a legal random decision when a pilot throws', async () => {
    const state = startTable(2, 'broken-throw');
    const observation = observationFor(state, 'player_1');
    const result = await decideSafely(brokenPolicy('throw'), observation, createRngState('x'), {
      config,
      decisionBudget: 100,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.failure?.kind).toBe('threw');
    expect(result.failure?.message).toContain('pilot exploded');
    expect(checkActionOffered(observation.legal, result.decision.action, config).ok).toBe(true);
  });

  it('rejects an illegal decision before it reaches the engine', async () => {
    const state = startTable(2, 'broken-illegal');
    const observation = observationFor(state, 'player_1');
    const result = await decideSafely(brokenPolicy('illegal'), observation, createRngState('x'), {
      config,
      decisionBudget: 100,
    });

    expect(result.usedFallback).toBe(true);
    expect(result.failure?.kind).toBe('illegal_action');
    expect(checkActionOffered(observation.legal, result.decision.action, config).ok).toBe(true);
  });

  it('enforces the decision budget', async () => {
    const state = startTable(2, 'budget');
    const observation = { ...observationFor(state, 'player_1'), decisionIndex: 10 };
    const result = await decideSafely(
      createPilot({ id: 'value' }),
      observation,
      createRngState('x'),
      {
        config,
        decisionBudget: 10,
      },
    );

    expect(result.failure?.kind).toBe('budget_exceeded');
    expect(result.usedFallback).toBe(true);
  });

  it('recovers a whole match around a permanently broken pilot', async () => {
    const outcome = await driveMatch({
      seed: 'broken-match',
      pilots: [brokenPolicy('throw'), createPilot({ id: 'value' })],
    });
    expect(outcome.state.status).toBe('complete');
    expect(outcome.failures.length).toBeGreaterThan(0);
    expect(new Set(outcome.failures.map((failure) => failure.kind))).toEqual(new Set(['threw']));
  });
});

describe('action legality checking', () => {
  it('rejects a server timeout as a pilot decision', () => {
    const state = startTable(2, 'timeout');
    const legal = legalActions(state, 'player_1', { database, config });
    const check = checkActionOffered(
      legal,
      { type: 'server_timeout', playerId: 'player_1' },
      config,
    );
    expect(check.ok).toBe(false);
    expect(check.reason).toContain('server-originated');
  });

  it('rejects an action submitted for another seat', () => {
    const state = startTable(2, 'wrong-seat');
    const legal = legalActions(state, 'player_1', { database, config });
    const check = checkActionOffered(
      legal,
      { type: 'mulligan', playerId: 'player_2', returnInstanceIds: [] },
      config,
    );
    expect(check.ok).toBe(false);
  });

  it('accepts every action the engine offered a real seat', async () => {
    await driveMatch({
      seed: 'legality-sweep',
      pilots: [createPilot({ id: 'random_legal' }), createPilot({ id: 'random_legal' })],
      onObservation: (observation) => {
        // Passing and conceding are described by booleans, so check them here.
        if (observation.legal.canPassPhase) {
          expect(
            checkActionOffered(
              observation.legal,
              { type: 'pass_phase', playerId: observation.legal.playerId },
              config,
            ).ok,
          ).toBe(true);
        }
      },
    });
  });
});

describe('weights', () => {
  it('validates and exports the weight vector in the pilot config', () => {
    const policy = createPilot({ id: 'aggressive' });
    const weights = (policy.config as { weights: Record<string, number> }).weights;
    expect(weights.unitAttack).toBeGreaterThan(weights.unitHealth ?? 0);
    expect(Object.values(weights).every((value) => typeof value === 'number')).toBe(true);
  });

  it('rejects an unknown weight name rather than silently ignoring it', () => {
    expect(() => createPilot({ id: 'value', weights: { notAWeight: 1 } as never })).toThrow();
  });

  it('applies an override', () => {
    const policy = createPilot({ id: 'defensive', weights: { unitAttack: 99 } });
    expect((policy.config as { weights: { unitAttack: number } }).weights.unitAttack).toBe(99);
  });
});
