import { describe, expect, it } from 'vitest';
import { DEFAULT_RULES_CONFIG } from './config.js';
import { legalActions } from './legal-actions.js';
import { legalTargets } from './targeting.js';
import {
  apply,
  databaseWith,
  eventsOfType,
  expectRejected,
  giveCard,
  instanceIn,
  keepBothHands,
  setEnergy,
  startMatch,
  testContext,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';

/**
 * One active Relic, and what replacing it does and does not do.
 *
 * Ruleset update §12 and ADR 0016 §3: playing a Relic while controlling one
 * replaces it. The replaced Relic moves to its owner's discard **as a rules
 * action** — neither destruction nor sacrifice — so `on_defeated` and
 * `on_sacrifice` must stay silent, and the only event announcing it is
 * `relic_replaced`.
 *
 * Fixture cards live here rather than in `prototype_core`: adding to the shared
 * set changes the pool every seeded generated population draws from, which
 * silently moves unrelated simulator tests.
 */
const CARDS = [
  {
    schemaVersion: 3,
    id: 'relic_watcher',
    name: 'Relic Watcher',
    type: 'relic',
    colorIdentity: ['blue'],
    cost: 1,
    // Both death triggers, so a replacement that fired either one would be
    // caught rather than merely suspected.
    abilities: [
      {
        id: 'on_death',
        trigger: 'on_defeated',
        effects: [{ type: 'draw', player: 'self', amount: 1 }],
      },
      {
        id: 'on_sac',
        trigger: 'on_sacrifice',
        effects: [{ type: 'draw', player: 'self', amount: 1 }],
      },
    ],
    displayText: 'When this relic is defeated or sacrificed, draw a card.',
  },
  {
    schemaVersion: 3,
    id: 'relic_second',
    name: 'Second Relic',
    type: 'relic',
    colorIdentity: ['blue'],
    cost: 1,
    displayText: 'Does nothing at all.',
  },
  {
    schemaVersion: 3,
    id: 'relic_breaker',
    name: 'Relic Breaker',
    type: 'spell',
    colorIdentity: [],
    cost: 1,
    effects: [
      {
        type: 'destroy',
        target: {
          kind: 'entity',
          selector: {
            zone: 'battlefield',
            controller: 'any',
            filter: { cardTypes: ['relic'] },
            count: 1,
          },
        },
      },
    ],
    displayText: 'Defeat the active Relic.',
  },
] as const;

const database = databaseWith(CARDS as never);
const context = { ...testContext(), database };

function opened(): MatchState {
  return keepBothHands(startMatch({ database }));
}

/** Plays `definitionId` from a freshly conjured copy in the active seat's hand. */
function play(state: MatchState, definitionId: string): { state: MatchState; instanceId: string } {
  const active = state.activePlayerId;
  const placed = giveCard(setEnergy(state, active, 8), active, definitionId);
  return {
    state: apply(
      placed.state,
      { type: 'play_card', playerId: active, instanceId: placed.instanceId },
      context,
    ),
    instanceId: placed.instanceId,
  };
}

describe('one active relic', () => {
  it('defaults to exactly one', () => {
    expect(DEFAULT_RULES_CONFIG.relicSlots).toBe(1);
  });

  it('replaces the current relic instead of refusing the new one', () => {
    const start = opened();
    const active = start.activePlayerId;

    const first = play(start, 'relic_watcher');
    expect(first.state.players[active]?.relics).toEqual([first.instanceId]);

    const second = play(first.state, 'relic_second');

    expect(second.state.players[active]?.relics).toEqual([second.instanceId]);
    expect(instanceIn(second.state, first.instanceId).zone).toBe('discard');
    expect(second.state.players[active]?.discard).toContain(first.instanceId);
  });

  it('announces the replacement with its own event, naming both relics', () => {
    const first = play(opened(), 'relic_watcher');
    const second = play(first.state, 'relic_second');

    const events = eventsOfType(second.state, 'relic_replaced');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      instanceId: first.instanceId,
      definitionId: 'relic_watcher',
      replacedByInstanceId: second.instanceId,
      replacedByDefinitionId: 'relic_second',
    });
  });

  it('is neither a defeat nor a sacrifice, so neither trigger fires', () => {
    const first = play(opened(), 'relic_watcher');
    const before = eventsOfType(first.state, 'trigger_queued').length;

    const second = play(first.state, 'relic_second');

    // `relic_watcher` would draw a card on either death trigger. Nothing new was
    // queued, and no defeat was announced at all.
    expect(eventsOfType(second.state, 'trigger_queued')).toHaveLength(before);
    expect(
      eventsOfType(second.state, 'unit_defeated').filter(
        (event) => event.instanceId === first.instanceId,
      ),
    ).toHaveLength(0);
  });

  it('destroying a relic is still a defeat, and does fire on_defeated', () => {
    const start = opened();
    const active = start.activePlayerId;
    const first = play(start, 'relic_watcher');

    const cast = play(first.state, 'relic_breaker');
    // `controller: 'any'` means the caster picks, so the spell pauses even with
    // one relic on the table — the engine may not choose a victim for them.
    const choice = cast.state.pendingChoice;
    expect(choice?.validEntityIds).toEqual([first.instanceId]);
    const broken = {
      state: apply(
        cast.state,
        {
          type: 'submit_choice',
          playerId: active,
          choiceId: choice?.id ?? '',
          selectedIds: [first.instanceId],
        },
        context,
      ),
    };

    const defeats = eventsOfType(broken.state, 'unit_defeated').filter(
      (event) => event.instanceId === first.instanceId,
    );
    expect(defeats).toHaveLength(1);
    expect(defeats[0]?.reason).toBe('destroyed');
    expect(
      eventsOfType(broken.state, 'trigger_queued').filter(
        (event) => event.sourceInstanceId === first.instanceId,
      ).length,
    ).toBeGreaterThan(0);
    expect(broken.state.players[active]?.relics).toEqual([]);
  });

  it('offers a relic as playable even while one is already out', () => {
    const first = play(opened(), 'relic_watcher');
    const active = first.state.activePlayerId;
    const placed = giveCard(setEnergy(first.state, active, 8), active, 'relic_second');

    const legal = legalActions(placed.state, active, { database });
    expect(legal.playableCards.map((card) => card.instanceId)).toContain(placed.instanceId);
  });

  it('refuses a relic outright only when the format allows none', () => {
    const config = { ...DEFAULT_RULES_CONFIG, relicSlots: 0 };
    const start = keepBothHands(startMatch({ database, config }));
    const active = start.activePlayerId;
    const placed = giveCard(setEnergy(start, active, 8), active, 'relic_watcher');

    const error = expectRejected(
      placed.state,
      { type: 'play_card', playerId: active, instanceId: placed.instanceId },
      { database, config },
    );
    expect(error.code).toBe('engine/relic_limit');
    // …and it is not offered either. The rest of the hand stays playable.
    const offered = legalActions(placed.state, active, { database, config }).playableCards;
    expect(offered.map((card) => card.instanceId)).not.toContain(placed.instanceId);
  });
});

describe('"the active relic" as a target', () => {
  /**
   * There is no dedicated `active_relic` target kind. "The active Relic" is a
   * well-defined phrase only because a player controls at most one, so a
   * battlefield selector filtered to relics *is* the active relic — a second way
   * to say it would give the rule two places to drift (ruleset update §12).
   */
  it('finds each player’s single relic, and no units', () => {
    const start = opened();
    const active = start.activePlayerId;
    const mine = play(start, 'relic_watcher');

    const targets = legalTargets(
      { ...context, state: mine.state, events: [], cause: {} } as never,
      {
        kind: 'entity',
        selector: {
          zone: 'battlefield',
          controller: 'any',
          filter: { cardTypes: ['relic'] },
          count: 1,
          selection: 'player_choice',
          chooser: 'self',
          optional: false,
          excludeSource: false,
        },
      },
      { controllerId: active, sourceInstanceId: null },
    );

    expect(targets).toEqual([mine.instanceId]);
  });

  it('cannot be played when no relic is in play', () => {
    const start = opened();
    const active = start.activePlayerId;
    const placed = giveCard(setEnergy(start, active, 8), active, 'relic_breaker');

    const error = expectRejected(
      placed.state,
      { type: 'play_card', playerId: active, instanceId: placed.instanceId },
      context,
    );
    expect(error.code).toBe('engine/no_legal_target');
  });
});
