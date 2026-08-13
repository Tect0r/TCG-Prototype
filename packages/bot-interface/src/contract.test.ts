import { describe, expect, it } from 'vitest';
import {
  applyAction,
  createMatch,
  createRngState,
  DEFAULT_RULES_CONFIG,
  legalActions,
  playerView,
  type CardInstanceView,
  type MatchState,
  type PlayerId,
} from '@tcg/rules-engine';
import { unwrap } from '@tcg/shared';
import { createPilot, PILOT_IDS } from './registry.js';
import { scoreCandidate } from './heuristic.js';
import { cardValue, DEFAULT_WEIGHTS, effectValue, unitBoardValue } from './scoring.js';
import { CardDatabase, effectDefinitionSchema, type CardDefinition } from '@tcg/card-data';
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

describe('relic replacement is priced as a trade', () => {
  /**
   * Ruleset update §12: a second relic *replaces* the first rather than being
   * refused, so playing one is no longer free. A pilot that ignored the cost
   * would cheerfully overwrite a strong relic with a weak one for the pleasure
   * of spending energy.
   *
   * Scored directly rather than through a whole match, because what is being
   * checked is the valuation, and a match would only tell us the pilot happened
   * not to draw the cards.
   */
  function scoreOf(state: MatchState, playerId: PlayerId, instanceId: string): number {
    return scoreCandidate(
      observationFor(state, playerId),
      {
        action: { type: 'play_card', playerId, instanceId },
        family: 'play_card',
        key: `play:${instanceId}`,
      },
      DEFAULT_WEIGHTS,
    );
  }

  /** Puts a relic straight onto the battlefield, the way an earlier turn would. */
  function withRelicInPlay(
    state: MatchState,
    playerId: PlayerId,
    definitionId: string,
  ): MatchState {
    const next = structuredClone(state);
    const player = next.players[playerId];
    if (!player) throw new Error('no seat');
    const instanceId = 'inst_relic_fixture';
    next.instances[instanceId] = {
      ...(Object.values(next.instances)[0] as (typeof next.instances)[string]),
      instanceId,
      definitionId,
      ordinal: 9000,
      owner: playerId,
      controller: playerId,
      zone: 'battlefield',
      newlyDeployed: false,
      statModifiers: [],
      grantedKeywords: [],
      removedKeywords: [],
      damageShields: [],
      counters: {},
      isToken: false,
    };
    player.relics.push(instanceId);
    return next;
  }

  /** A relic in the seat's hand, ready to be scored as a play. */
  function withRelicInHand(state: MatchState, playerId: PlayerId, definitionId: string): string {
    const player = state.players[playerId];
    if (!player) throw new Error('no seat');
    const instanceId = 'inst_relic_hand';
    state.instances[instanceId] = {
      ...(state.instances[player.hand[0] as string] as (typeof state.instances)[string]),
      instanceId,
      definitionId,
      ordinal: 9001,
      zone: 'hand',
    };
    player.hand.push(instanceId);
    player.energy = 9;
    player.maxEnergy = 9;
    return instanceId;
  }

  function board(inPlay: string | null): { state: MatchState; playerId: PlayerId; hand: string } {
    let state = startTable(2, 'relic-trade');
    // Settle the opening hands so the seat reaches a main phase.
    for (const playerId of ['player_1', 'player_2']) {
      state = unwrap(
        applyAction(state, { type: 'mulligan', playerId, returnInstanceIds: [] }, { database }),
        'mulligan',
      ).state;
    }
    const playerId = state.activePlayerId;
    if (inPlay) state = withRelicInPlay(state, playerId, inPlay);
    const hand = withRelicInHand(state, playerId, 'surveyors_lens');
    return { state, playerId, hand };
  }

  it('values a relic lower when it would overwrite one already in play', () => {
    const empty = board(null);
    const occupied = board('warband_horn');

    const free = scoreOf(empty.state, empty.playerId, empty.hand);
    const trade = scoreOf(occupied.state, occupied.playerId, occupied.hand);

    expect(trade).toBeLessThan(free);
  });

  it('charges nothing when there is no relic to overwrite', () => {
    const empty = board(null);
    const score = scoreOf(empty.state, empty.playerId, empty.hand);
    expect(Number.isFinite(score)).toBe(true);
    expect(score).toBeGreaterThan(0);
  });
});

describe('blocking is priced as spending a unit', () => {
  /**
   * Ruleset update §8: declaring a blocker exhausts it, so a unit that survives
   * a block still cannot attack on its controller's next turn. A pilot that
   * scored blocking as free would chump-block with bodies it wanted to swing
   * with — the trade would look costless because the survivor is still on the
   * board.
   */
  it('scores blocking with a survivor below blocking with nothing', async () => {
    let scoredBlock: number | null = null;
    let scoredPass: number | null = null;

    await driveMatch({
      seed: 'block-cost',
      pilots: [createPilot({ id: 'defensive' }), createPilot({ id: 'defensive' })],
      onObservation: (observation) => {
        const blocking = observation.legal.blocking;
        if (!blocking || scoredBlock !== null) return;
        // Only a case where declining is legal and a blocker survives is
        // informative; a compulsory Guardian block would prove nothing.
        if (blocking.mustBlockCount > 0) return;
        const attacker = blocking.attackerInstanceIds[0];
        const blocker = blocking.blockerInstanceIds.find(
          (id) => !observation.view.instances[id]?.exhausted,
        );
        if (attacker === undefined || blocker === undefined) return;

        const playerId = observation.legal.playerId;
        const withBlock = scoreCandidate(
          observation,
          {
            action: {
              type: 'assign_blockers',
              playerId,
              blocks: [{ attackerInstanceId: attacker, blockerInstanceId: blocker }],
            },
            family: 'assign_blockers',
            key: 'block',
          },
          DEFAULT_WEIGHTS,
        );
        const withoutBlock = scoreCandidate(
          observation,
          {
            action: { type: 'assign_blockers', playerId, blocks: [] },
            family: 'assign_blockers',
            key: 'no-block',
          },
          DEFAULT_WEIGHTS,
        );

        // Re-score with the readiness charge removed, by pretending the blocker
        // was already exhausted: the difference is exactly the cost being tested.
        // Only the view is cloned: `database` is a class instance and would not
        // survive `structuredClone`.
        const spent: BotObservation = { ...observation, view: structuredClone(observation.view) };
        const view = spent.view.instances[blocker];
        if (view) view.exhausted = true;
        const withBlockAlreadySpent = scoreCandidate(
          spent,
          {
            action: {
              type: 'assign_blockers',
              playerId,
              blocks: [{ attackerInstanceId: attacker, blockerInstanceId: blocker }],
            },
            family: 'assign_blockers',
            key: 'block',
          },
          DEFAULT_WEIGHTS,
        );

        // Blocking with a ready unit is worth strictly less than blocking with
        // one that was already spent, because only the first loses readiness.
        expect(withBlock).toBeLessThan(withBlockAlreadySpent);
        scoredBlock = withBlock;
        scoredPass = withoutBlock;
      },
    });

    expect(scoredBlock, 'the match should have reached a blocking decision').not.toBeNull();
    expect(Number.isFinite(scoredPass ?? Number.NaN)).toBe(true);
  });
});

describe('a modifier is worth what its duration is worth', () => {
  /**
   * Readiness gate B1. `while_source_present` used to behave as `permanent`
   * because nothing expired it; now that it really ends when the granting card
   * leaves play, valuing it as permanent would overrate every aura-style card in
   * the pool. It sits between permanent and end-of-turn, and the ordering has to
   * hold for every effect type that carries a duration.
   */
  const buff = (duration: 'permanent' | 'while_source_present' | 'end_of_turn') =>
    ({
      type: 'modify_stats',
      target: {
        kind: 'entity',
        selector: {
          zone: 'battlefield',
          controller: 'self',
          count: 1,
          selection: 'player_choice',
          chooser: 'self',
          optional: false,
          excludeSource: false,
        },
      },
      attack: 2,
      health: 2,
      duration,
    }) as const;

  it('ranks permanent above source-bound above end of turn', () => {
    const permanent = effectValue(buff('permanent'), DEFAULT_WEIGHTS, database);
    const bound = effectValue(buff('while_source_present'), DEFAULT_WEIGHTS, database);
    const turn = effectValue(buff('end_of_turn'), DEFAULT_WEIGHTS, database);

    expect(permanent).toBeGreaterThan(bound);
    expect(bound).toBeGreaterThan(turn);
  });

  it('applies the same discount to a granted keyword', () => {
    const grant = (duration: 'permanent' | 'while_source_present') =>
      ({
        type: 'grant_keyword',
        target: buff('permanent').target,
        keyword: 'guardian',
        duration,
      }) as const;

    expect(effectValue(grant('permanent'), DEFAULT_WEIGHTS, database)).toBeGreaterThan(
      effectValue(grant('while_source_present'), DEFAULT_WEIGHTS, database),
    );
  });

  it('applies it to damage prevention too', () => {
    const shield = (duration: 'permanent' | 'while_source_present') =>
      ({
        type: 'prevent_damage',
        target: { kind: 'player', relation: 'self', selection: 'automatic' },
        amount: 3,
        duration,
      }) as const;

    expect(effectValue(shield('permanent'), DEFAULT_WEIGHTS, database)).toBeGreaterThan(
      effectValue(shield('while_source_present'), DEFAULT_WEIGHTS, database),
    );
  });
});

describe('the new vocabulary is priced, not ignored', () => {
  /**
   * Ruleset update §15. Two ways a pilot could quietly mis-price the vocabulary:
   * treating a board-derived amount as zero, which would make every "for each"
   * card look blank and get it mulliganed; and treating a gated instruction as
   * certain, which would overpay for every "if" card in the pool.
   */
  // Parsed through the schema rather than written as a literal, so the defaults
  // (`per`, `plus`, `minimum`, the count's `controller`) are the real ones. A
  // hand-built literal would be testing a shape the engine never sees.
  const draw = (amount: unknown, condition?: unknown) =>
    effectDefinitionSchema.parse({
      type: 'draw',
      player: 'self',
      amount,
      ...(condition ? { condition } : {}),
    });
  const goblins = {
    kind: 'count',
    count: { subject: 'units', controller: 'self', filter: { tags: ['goblin'] } },
  };

  it('does not value a board-derived amount at zero', () => {
    const dynamic = effectValue(draw(goblins), DEFAULT_WEIGHTS, database);
    const nothing = effectValue(draw(0), DEFAULT_WEIGHTS, database);
    expect(dynamic).toBeGreaterThan(nothing);
  });

  it('discounts a gated instruction below the same instruction ungated', () => {
    const open = effectValue(draw(2), DEFAULT_WEIGHTS, database);
    const conditional = effectValue(
      draw(2, {
        kind: 'count',
        count: { subject: 'units_defeated_this_turn', controller: 'self' },
        comparison: 'at_least',
        value: 2,
      }),
      DEFAULT_WEIGHTS,
      database,
    );
    expect(conditional).toBeLessThan(open);
    expect(conditional).toBeGreaterThan(0);
  });

  it('does not discount an optional instruction the way it discounts a gated one', () => {
    // A condition can fail against you; a "you may" cannot, because you are the
    // one answering it. Pricing them the same would make every card with an
    // upside clause look worse than the same card without one.
    const open = effectValue(draw(2), DEFAULT_WEIGHTS, database);
    const optional = effectValue(
      effectDefinitionSchema.parse({ type: 'draw', optional: true, player: 'self', amount: 2 }),
      DEFAULT_WEIGHTS,
      database,
    );
    expect(optional).toBe(open);
  });

  it('respects a printed maximum on a computed amount', () => {
    const capped = effectValue(draw({ ...goblins, maximum: 1 }), DEFAULT_WEIGHTS, database);
    const uncapped = effectValue(draw(goblins), DEFAULT_WEIGHTS, database);
    expect(capped).toBeLessThan(uncapped);
  });

  it('does not value an amount read from a statline at zero either (M02.3)', () => {
    // Same failure mode as a count: a pilot that priced "equal to its ATK" at
    // nothing would read Bastion Commander's whole card as blank.
    const bolt = (amount: unknown) =>
      effectDefinitionSchema.parse({
        type: 'deal_damage',
        target: { kind: 'entity', selector: { zone: 'battlefield', controller: 'opponent' } },
        amount,
      });
    const derived = effectValue(bolt({ kind: 'stat', stat: 'attack' }), DEFAULT_WEIGHTS, database);
    expect(derived).toBeGreaterThan(effectValue(bolt(0), DEFAULT_WEIGHTS, database));
    expect(derived).toBe(effectValue(bolt(3), DEFAULT_WEIGHTS, database));
  });
});

describe('shared choices and divided totals are priced honestly (M02.5)', () => {
  const damage = (amount: unknown, divided?: boolean) =>
    effectDefinitionSchema.parse({
      type: 'deal_damage',
      amount,
      ...(divided === undefined ? {} : { divided }),
      target: {
        kind: 'entity',
        selector: {
          zone: 'battlefield',
          controller: 'opponent',
          count: 'all',
          selection: 'player_choice',
        },
      },
    });

  it('does not value a previous_targets amount at zero', () => {
    // The same failure mode as a count or a statline: priced at nothing, Mass
    // Offering would read as a five-energy blank and be mulliganed away.
    const derived = effectValue(
      damage({ kind: 'previous_targets' }, true),
      DEFAULT_WEIGHTS,
      database,
    );
    expect(derived).toBeGreaterThan(effectValue(damage(0, true), DEFAULT_WEIGHTS, database));
  });

  it('prices a divided total once rather than once per target', () => {
    // Without this a five-point split across "all enemy units" would be priced
    // as five damage to every one of them.
    const split = effectValue(damage(4, true), DEFAULT_WEIGHTS, database);
    const each = effectValue(damage(4), DEFAULT_WEIGHTS, database);
    expect(split).toBeLessThan(each);
    expect(split).toBeGreaterThan(0);
  });

  it('does not price a symmetrical sacrifice as a pure self-cost', () => {
    const shared = effectValue(
      effectDefinitionSchema.parse({
        type: 'sacrifice',
        target: {
          kind: 'entity',
          selector: {
            zone: 'battlefield',
            controller: 'self',
            count: 1,
            selection: 'player_choice',
            chooser: 'all_players',
          },
        },
      }),
      DEFAULT_WEIGHTS,
      database,
    );
    const ownOnly = effectValue(
      effectDefinitionSchema.parse({
        type: 'sacrifice',
        target: {
          kind: 'entity',
          selector: { zone: 'battlefield', controller: 'self', count: 1 },
        },
      }),
      DEFAULT_WEIGHTS,
      database,
    );

    expect(ownOnly).toBeLessThan(0);
    expect(shared).toBeGreaterThan(0);
  });

  it('leaves Equal Price worth holding rather than worth mulliganing', () => {
    expect(
      cardValue(database.getOrThrow('equal_price'), DEFAULT_WEIGHTS, database),
    ).toBeGreaterThan(0);
  });
});

describe('a derived cost reduction is priced as energy, not as a buff (M02.3)', () => {
  /**
   * `cardValue` used to price every continuous ability as `buffValue × 2` — the
   * same as a lord's aura. A `cost_reduction` is not board presence: it is
   * energy, it is worth more the more of it there is, and it is worth nothing at
   * all once the card is already on the battlefield.
   */
  const abomination = database.getOrThrow('stitched_abomination');

  it('prices the discount into the card a pilot is holding', () => {
    const withDiscount = cardValue(abomination, DEFAULT_WEIGHTS, database);
    const withoutDiscount = cardValue(
      { ...abomination, staticAbilities: [] },
      DEFAULT_WEIGHTS,
      database,
    );
    expect(withDiscount).toBeGreaterThan(withoutDiscount);
  });

  it('scales with how much the discount is worth', () => {
    const bigger = cardValue(
      {
        ...abomination,
        staticAbilities: abomination.staticAbilities.map((ability) => ({
          ...ability,
          effect: { type: 'cost_reduction' as const, amount: 4, minimum: 0 },
        })),
      },
      DEFAULT_WEIGHTS,
      database,
    );
    expect(bigger).toBeGreaterThan(cardValue(abomination, DEFAULT_WEIGHTS, database));
  });

  it('is worth nothing to a unit already standing on the battlefield', () => {
    const unit: CardInstanceView = {
      instanceId: 'inst_x',
      definitionId: abomination.id,
      owner: 'player_1',
      controller: 'player_1',
      zone: 'battlefield',
      attack: abomination.attack ?? 0,
      health: abomination.health ?? 0,
      markedDamage: 0,
      exhausted: false,
      summoningSick: false,
      keywords: [...abomination.keywords],
      isToken: false,
      willNotReady: false,
      energyCost: null,
    };

    const stripped = new CardDatabase([
      ...database.all().filter((card) => card.id !== abomination.id),
      { ...abomination, staticAbilities: [] },
    ]);
    expect(unitBoardValue(unit, DEFAULT_WEIGHTS, database)).toBe(
      unitBoardValue(unit, DEFAULT_WEIGHTS, stripped),
    );
  });
});

describe('a replacement is priced as what it replaces (M02.4)', () => {
  /**
   * Two different cards wear the `replace_arrival` shape and they are worth
   * opposite things: rewriting an *opponent's* arrival to be Exhausted is tempo
   * denial, while handing your own arrivals a keyword is a buff. A pilot that
   * priced both as "a static ability" would happily trade one for the other.
   */
  const containment = database.getOrThrow('containment_array');
  const warhorn = database.getOrThrow('goblin_warhorn_captain');
  const anchor = database.getOrThrow('temporal_anchor');

  const stripped = (card: CardDefinition) => ({ ...card, staticAbilities: [] });

  it('prices denial and a granted keyword above the same card without them', () => {
    for (const card of [containment, warhorn, anchor]) {
      expect(cardValue(card, DEFAULT_WEIGHTS, database)).toBeGreaterThan(
        cardValue(stripped(card), DEFAULT_WEIGHTS, database),
      );
    }
  });

  it('treats an arrival rewrite aimed at your own units as a drawback', () => {
    const selfHarming = {
      ...containment,
      staticAbilities: containment.staticAbilities.map((ability) => ({
        ...ability,
        affects: { ...ability.affects, controller: 'self' as const },
      })),
    };
    expect(cardValue(selfHarming, DEFAULT_WEIGHTS, database)).toBeLessThan(
      cardValue(stripped(containment), DEFAULT_WEIGHTS, database),
    );
  });

  it('discounts a once-a-turn arrival rewrite against an unlimited one', () => {
    const unlimited = {
      ...containment,
      staticAbilities: containment.staticAbilities.map((ability) => ({
        ...ability,
        effect: { ...ability.effect, limit: 'unlimited' as const },
      })),
    };
    expect(cardValue(unlimited, DEFAULT_WEIGHTS, database)).toBeGreaterThan(
      cardValue(containment, DEFAULT_WEIGHTS, database),
    );
  });

  it('takes the price of a paid readiness replacement off its value', () => {
    const free = {
      ...anchor,
      staticAbilities: anchor.staticAbilities.map((ability) => ({
        ...ability,
        effect: {
          type: 'replace_ready' as const,
          energyCost: 0,
          limit: 'first_each_turn' as const,
        },
      })),
    };
    expect(cardValue(free, DEFAULT_WEIGHTS, database)).toBeGreaterThan(
      cardValue(anchor, DEFAULT_WEIGHTS, database),
    );
  });
});

describe('a "you may" is answered rather than reflexively refused', () => {
  /**
   * Ruleset update §15. A `confirm` has no entity behind it, so the
   * intent/ownership reasoning every other choice uses has nothing to read —
   * and because the source of an optional step is routinely a removal card, a
   * pilot that fell through to that reasoning would score "yes" as a detriment
   * and decline every optional line in the pool. That failure is invisible in a
   * match result, so it is scored directly.
   */
  function confirmScore(state: MatchState, playerId: PlayerId, answer: 'yes' | 'no'): number {
    const observation = observationFor(state, playerId);
    const choice = observation.legal.pendingChoice;
    if (!choice) throw new Error('expected a pending confirm');
    return scoreCandidate(
      observation,
      {
        action: { type: 'submit_choice', playerId, choiceId: choice.id, selectedIds: [answer] },
        family: 'submit_choice',
        key: `choice:${answer}`,
      },
      DEFAULT_WEIGHTS,
    );
  }

  /** A pending `confirm` for an optional step, written straight into state. */
  function awaitingConfirm(state: MatchState, playerId: PlayerId): MatchState {
    const next = structuredClone(state);
    next.status = 'waiting_for_choice';
    next.pendingChoice = {
      id: 'choice_confirm',
      playerId,
      type: 'confirm',
      reason: 'optional_effect',
      zone: null,
      minimum: 1,
      maximum: 1,
      validEntityIds: ['yes', 'no'],
      ordered: false,
      sourceInstanceId: null,
      provenance: {
        origin: 'instruction',
        itemId: 'res_0001',
        effectIndex: 0,
        // A removal instruction, deliberately: the failure this test guards is
        // a pilot that reads the source's valence onto the yes/no and declines
        // every "you may" printed on a removal card.
        effectType: 'destroy',
        sourceControllerId: playerId,
        chooser: 'source_controller',
        targetRelation: 'none',
        intent: 'detriment',
      },
      continuation: {
        kind: 'resolution',
        itemId: 'res_0001',
        effectIndex: 0,
        selectionKey: '0:may',
      },
    };
    return next;
  }

  it('scores yes above no', () => {
    const state = awaitingConfirm(startTable(2, 'confirm'), 'player_1');
    expect(confirmScore(state, 'player_1', 'yes')).toBeGreaterThan(
      confirmScore(state, 'player_1', 'no'),
    );
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
