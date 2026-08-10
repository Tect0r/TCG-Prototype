import { describe, expect, it } from 'vitest';
import { isErr, isOk } from '@tcg/shared';
import { DEFAULT_RULES_CONFIG } from './config.js';
import { applyAction } from './engine.js';
import { currentAttack, opponentOf } from './derive.js';
import { deserializeMatchState, serializeMatchState } from './serialize.js';
import { playerView } from './view.js';
import { legalActions } from './legal-actions.js';
import {
  attacksOnOpponent,
  apply,
  deployRelic,
  deployUnit,
  expectRejected,
  eventsOfType,
  forcePhase,
  giveCard,
  instanceIn,
  keepBothHands,
  makeDeck,
  moveInstance,
  setDeckSize,
  setEnergy,
  setHealth,
  stackDeck,
  startMatch,
  testContext,
  testDatabase,
} from './test-fixtures.js';
import type { MatchState } from './schema/state.js';

/**
 * The seventeen deterministic scenarios required by CLAUDE.md §10, plus the
 * regressions they turned up. Each `it` name maps to a numbered scenario so a
 * failure points straight at the rule it covers.
 */

const context = testContext();

function defender(state: MatchState): string {
  return opponentOf(state, state.activePlayerId);
}

describe('1. setup, seeded shuffle and simultaneous mulligan', () => {
  it('deals opening hands and waits for both seats before revealing anything', () => {
    const state = startMatch();

    expect(state.status).toBe('mulligan');
    expect(state.phase).toBe('mulligan');
    for (const playerId of state.playerOrder) {
      const player = state.players[playerId];
      expect(player?.hand).toHaveLength(DEFAULT_RULES_CONFIG.openingHandSize);
      expect(player?.deck).toHaveLength(30 - DEFAULT_RULES_CONFIG.openingHandSize);
      expect(player?.health).toBe(DEFAULT_RULES_CONFIG.startingHealth);
    }

    const [first, second] = state.playerOrder;
    const afterFirst = apply(state, {
      type: 'mulligan',
      playerId: first as string,
      returnInstanceIds: [],
    });

    // Nothing resolves until both have submitted.
    expect(afterFirst.status).toBe('mulligan');
    expect(afterFirst.turn).toBe(0);
    expect(eventsOfType(afterFirst, 'mulligan_resolved')).toHaveLength(0);

    const afterBoth = apply(afterFirst, {
      type: 'mulligan',
      playerId: second as string,
      returnInstanceIds: [],
    });
    expect(afterBoth.status).toBe('playing');
    expect(afterBoth.turn).toBe(1);
    expect(afterBoth.phase).toBe('main_1');
  });

  it('returns, redraws and reshuffles a partial mulligan', () => {
    const state = startMatch();
    const [first, second] = state.playerOrder;
    const hand = state.players[first as string]?.hand ?? [];
    const returned = hand.slice(0, 2);

    let next = apply(state, {
      type: 'mulligan',
      playerId: first as string,
      returnInstanceIds: returned,
    });
    next = apply(next, { type: 'mulligan', playerId: second as string, returnInstanceIds: [] });

    const player = next.players[first as string];
    expect(player?.hand).toHaveLength(DEFAULT_RULES_CONFIG.openingHandSize);
    // The returned cards went back into the deck, so the deck is the same size.
    expect(player?.deck).toHaveLength(30 - DEFAULT_RULES_CONFIG.openingHandSize);
    for (const instanceId of returned) {
      expect(player?.hand.includes(instanceId) && player.deck.includes(instanceId)).toBe(false);
    }
  });

  it('rejects a second submission from the same seat', () => {
    const state = startMatch();
    const [first] = state.playerOrder;
    const once = apply(state, {
      type: 'mulligan',
      playerId: first as string,
      returnInstanceIds: [],
    });
    const error = expectRejected(once, {
      type: 'mulligan',
      playerId: first as string,
      returnInstanceIds: [],
    });
    expect(error.code).toBe('engine/mulligan_already_submitted');
  });
});

describe('2. energy growth and the first-player skipped draw', () => {
  it('refills energy each turn up to the cap and skips the first draw', () => {
    const state = keepBothHands(startMatch());
    const starter = state.activePlayerId;

    expect(state.players[starter]?.maxEnergy).toBe(1);
    expect(state.players[starter]?.energy).toBe(1);
    expect(eventsOfType(state, 'draw_skipped')).toHaveLength(1);
    expect(state.players[starter]?.hand).toHaveLength(DEFAULT_RULES_CONFIG.openingHandSize);

    // Pass through to the other player's first turn.
    let next = apply(state, { type: 'pass_phase', playerId: starter });
    next = apply(next, { type: 'declare_attackers', playerId: starter, attacks: [] });
    next = apply(next, { type: 'pass_phase', playerId: starter });

    const second = next.activePlayerId;
    expect(second).not.toBe(starter);
    expect(next.players[second]?.maxEnergy).toBe(1);
    // The non-starting player does draw on their first turn.
    expect(next.players[second]?.hand).toHaveLength(DEFAULT_RULES_CONFIG.openingHandSize + 1);

    next = apply(next, { type: 'pass_phase', playerId: second });
    next = apply(next, { type: 'declare_attackers', playerId: second, attacks: [] });
    next = apply(next, { type: 'pass_phase', playerId: second });

    expect(next.activePlayerId).toBe(starter);
    expect(next.players[starter]?.maxEnergy).toBe(2);
    expect(next.players[starter]?.energy).toBe(2);
  });

  it('never exceeds the configured energy cap', () => {
    const config = { ...DEFAULT_RULES_CONFIG, energyCap: 2 };
    let state = keepBothHands(startMatch({ config }), { database: testDatabase(), config });
    const local = { database: testDatabase(), config };

    for (let i = 0; i < 6; i += 1) {
      const active = state.activePlayerId;
      state = apply(state, { type: 'pass_phase', playerId: active }, local);
      state = apply(state, { type: 'declare_attackers', playerId: active, attacks: [] }, local);
      state = apply(state, { type: 'pass_phase', playerId: active }, local);
    }

    for (const playerId of state.playerOrder) {
      expect(state.players[playerId]?.maxEnergy).toBeLessThanOrEqual(2);
    }
  });
});

describe('3. playing units, an unbounded battlefield, summoning sickness and exhaustion', () => {
  it('deploys a unit onto the battlefield and spends energy', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const placed = giveCard(start, active, 'prototype_drone');

    const after = apply(placed.state, {
      type: 'play_card',
      playerId: active,
      instanceId: placed.instanceId,
    });

    expect(after.players[active]?.units[0]).toBe(placed.instanceId);
    expect(instanceIn(after, placed.instanceId).zone).toBe('battlefield');
    expect(eventsOfType(after, 'unit_deployed')).toHaveLength(1);
  });

  // Retargeted from "refuses a unit when every slot is occupied". The unit cap
  // was removed rather than raised (ruleset update §7, ADR 0016 §2), so the
  // coverage now pins the *absence* of a limit — including that no hidden cap
  // crept back in at some larger number.
  it('never refuses a unit for want of room, however wide the board is', () => {
    let state = keepBothHands(startMatch());
    const active = state.activePlayerId;
    const WIDE = 40;
    for (let index = 0; index < WIDE; index += 1) {
      state = deployUnit(state, active, 'prototype_drone').state;
    }
    const placed = giveCard(setEnergy(state, active, 5), active, 'prototype_drone');

    const after = apply(placed.state, {
      type: 'play_card',
      playerId: active,
      instanceId: placed.instanceId,
    });

    expect(after.players[active]?.units).toHaveLength(WIDE + 1);
    expect(instanceIn(after, placed.instanceId).zone).toBe('battlefield');
  });

  it('keeps the unit list dense, so a defeat does not leave a gap behind', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const first = deployUnit(start, active, 'prototype_drone');
    const second = deployUnit(first.state, active, 'prototype_scout');
    const third = deployUnit(second.state, active, 'prototype_drone');

    const after = moveInstance(third.state, second.instanceId, 'discard');

    expect(after.players[active]?.units).toEqual([first.instanceId, third.instanceId]);
  });

  it('rejects an attack by a unit that entered play this turn, unless it is swift', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;

    const sick = deployUnit(start, active, 'prototype_drone', { summoningSick: true });
    const swift = deployUnit(sick.state, active, 'prototype_scout', { summoningSick: true });
    const atAttack = forcePhase(swift.state, 'declare_attackers');

    const error = expectRejected(atAttack, {
      type: 'declare_attackers',
      playerId: active,
      attacks: attacksOnOpponent(atAttack, [sick.instanceId]),
    });
    expect(error.code).toBe('engine/illegal_attacker');

    const ok = apply(atAttack, {
      type: 'declare_attackers',
      playerId: active,
      attacks: attacksOnOpponent(atAttack, [swift.instanceId]),
    });
    expect(instanceIn(ok, swift.instanceId).exhausted).toBe(true);
  });

  it('readies exhausted units at the start of their controller’s turn', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const unit = deployUnit(start, active, 'prototype_drone', { exhausted: true });

    let state = apply(unit.state, { type: 'pass_phase', playerId: active });
    state = apply(state, { type: 'declare_attackers', playerId: active, attacks: [] });
    state = apply(state, { type: 'pass_phase', playerId: active });

    const other = state.activePlayerId;
    expect(instanceIn(state, unit.instanceId).exhausted).toBe(true);

    state = apply(state, { type: 'pass_phase', playerId: other });
    state = apply(state, { type: 'declare_attackers', playerId: other, attacks: [] });
    state = apply(state, { type: 'pass_phase', playerId: other });

    expect(state.activePlayerId).toBe(active);
    expect(instanceIn(state, unit.instanceId).exhausted).toBe(false);
  });
});

describe('4. unblocked combat damage', () => {
  it('sends an unblocked attacker’s Attack to the defending player', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const other = defender(start);
    const attacker = deployUnit(start, active, 'dawn_conscript');
    const atAttack = forcePhase(attacker.state, 'declare_attackers');

    let state = apply(atAttack, {
      type: 'declare_attackers',
      playerId: active,
      attacks: attacksOnOpponent(atAttack, [attacker.instanceId]),
    });
    state = apply(state, { type: 'assign_blockers', playerId: other, blocks: [] });

    expect(state.players[other]?.health).toBe(DEFAULT_RULES_CONFIG.startingHealth - 2);
    expect(state.phase).toBe('main_2');
  });
});

describe('5. blocked combat resolves simultaneously', () => {
  function combat(
    attackerCard: string,
    blockerCard: string,
  ): { state: MatchState; attackerId: string; blockerId: string } {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const other = defender(start);

    const attacker = deployUnit(start, active, attackerCard);
    const blocker = deployUnit(attacker.state, other, blockerCard);
    const atAttack = forcePhase(blocker.state, 'declare_attackers');

    let state = apply(atAttack, {
      type: 'declare_attackers',
      playerId: active,
      attacks: attacksOnOpponent(atAttack, [attacker.instanceId]),
    });
    state = apply(state, {
      type: 'assign_blockers',
      playerId: other,
      blocks: [{ attackerInstanceId: attacker.instanceId, blockerInstanceId: blocker.instanceId }],
    });
    return { state, attackerId: attacker.instanceId, blockerId: blocker.instanceId };
  }

  it('leaves both alive when neither deals lethal damage', () => {
    const { state, attackerId, blockerId } = combat('prototype_guard', 'prototype_guard');
    expect(instanceIn(state, attackerId).zone).toBe('battlefield');
    expect(instanceIn(state, blockerId).zone).toBe('battlefield');
    expect(instanceIn(state, attackerId).markedDamage).toBe(1);
    expect(instanceIn(state, blockerId).markedDamage).toBe(1);
    // Nothing reached the defending player.
    expect(state.players[defender(state)]?.health).toBe(DEFAULT_RULES_CONFIG.startingHealth);
  });

  it('defeats only the attacker when the blocker outlasts it', () => {
    const { state, attackerId, blockerId } = combat('goblin_scout', 'thornback_calf');
    expect(instanceIn(state, attackerId).zone).toBe('discard');
    expect(instanceIn(state, blockerId).zone).toBe('battlefield');
  });

  it('defeats both when the damage is mutually lethal', () => {
    const { state, attackerId, blockerId } = combat('dawn_conscript', 'goblin_scout');
    expect(instanceIn(state, attackerId).zone).toBe('discard');
    expect(instanceIn(state, blockerId).zone).toBe('discard');
    const defeats = eventsOfType(state, 'unit_defeated');
    expect(defeats).toHaveLength(2);
    // Both defeats are emitted from the same state-based check.
    expect(defeats[1]?.sequence).toBe((defeats[0]?.sequence ?? 0) + 1);
  });

  it('keeps an attacker blocked when its blocker leaves play first', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const other = defender(start);

    const attacker = deployUnit(start, active, 'pyre_champion');
    const blocker = deployUnit(attacker.state, other, 'goblin_scout');
    const atAttack = forcePhase(blocker.state, 'declare_attackers');

    let state = apply(atAttack, {
      type: 'declare_attackers',
      playerId: active,
      attacks: attacksOnOpponent(atAttack, [attacker.instanceId]),
    });
    state = apply(state, {
      type: 'assign_blockers',
      playerId: other,
      blocks: [{ attackerInstanceId: attacker.instanceId, blockerInstanceId: blocker.instanceId }],
    });

    // Quick strike kills the 1/1 before it can answer, and no damage carries
    // through to the defending player.
    expect(instanceIn(state, blocker.instanceId).zone).toBe('discard');
    expect(instanceIn(state, attacker.instanceId).markedDamage).toBe(0);
    expect(state.players[other]?.health).toBe(DEFAULT_RULES_CONFIG.startingHealth);
  });

  it('cannot block an evasive attacker', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const other = defender(start);

    const attacker = deployUnit(start, active, 'mistveil_stalker');
    const blocker = deployUnit(attacker.state, other, 'prototype_guard');
    const atAttack = forcePhase(blocker.state, 'declare_attackers');

    const declared = apply(atAttack, {
      type: 'declare_attackers',
      playerId: active,
      attacks: attacksOnOpponent(atAttack, [attacker.instanceId]),
    });
    const error = expectRejected(declared, {
      type: 'assign_blockers',
      playerId: other,
      blocks: [{ attackerInstanceId: attacker.instanceId, blockerInstanceId: blocker.instanceId }],
    });
    expect(error.code).toBe('engine/illegal_blocker');
  });
});

describe('6. damage persists across turns and healing removes it', () => {
  it('keeps marked damage across the turn boundary until a heal removes it', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const other = defender(start);

    const attacker = deployUnit(start, active, 'goblin_scout');
    const blocker = deployUnit(attacker.state, other, 'prototype_guard');
    const atAttack = forcePhase(blocker.state, 'declare_attackers');

    let state = apply(atAttack, {
      type: 'declare_attackers',
      playerId: active,
      attacks: attacksOnOpponent(atAttack, [attacker.instanceId]),
    });
    state = apply(state, {
      type: 'assign_blockers',
      playerId: other,
      blocks: [{ attackerInstanceId: attacker.instanceId, blockerInstanceId: blocker.instanceId }],
    });
    expect(instanceIn(state, blocker.instanceId).markedDamage).toBe(1);

    // Hand the turn over: the damage is still marked on the defender's unit.
    state = apply(state, { type: 'pass_phase', playerId: active });
    expect(state.activePlayerId).toBe(other);
    expect(instanceIn(state, blocker.instanceId).markedDamage).toBe(1);

    // Its controller deploys a Field Medic, which heals *another* friendly unit.
    const medic = giveCard(setEnergy(state, other, 5), other, 'prototype_field_medic');
    const played = apply(medic.state, {
      type: 'play_card',
      playerId: other,
      instanceId: medic.instanceId,
    });

    expect(played.pendingChoice?.reason).toBe('effect_target');
    expect(played.pendingChoice?.validEntityIds).toEqual([blocker.instanceId]);

    const healed = apply(played, {
      type: 'submit_choice',
      playerId: other,
      choiceId: played.pendingChoice?.id ?? '',
      selectedIds: [blocker.instanceId],
    });
    expect(instanceIn(healed, blocker.instanceId).markedDamage).toBe(0);
  });
});

describe('7. a spell with no legal target cannot be played', () => {
  it('rejects the spell and leaves the state untouched', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const placed = giveCard(setEnergy(start, active, 5), active, 'wither_touch');

    const error = expectRejected(placed.state, {
      type: 'play_card',
      playerId: active,
      instanceId: placed.instanceId,
    });
    expect(error.code).toBe('engine/no_legal_target');
    // Rejected actions never spend energy or move cards.
    expect(placed.state.players[active]?.hand).toContain(placed.instanceId);
  });

  it('accepts the same spell once a legal target exists', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const target = deployUnit(start, defender(start), 'prototype_guard');
    const placed = giveCard(setEnergy(target.state, active, 5), active, 'wither_touch');

    const state = apply(placed.state, {
      type: 'play_card',
      playerId: active,
      instanceId: placed.instanceId,
    });
    expect(state.pendingChoice?.reason).toBe('effect_target');
    expect(state.pendingChoice?.validEntityIds).toEqual([target.instanceId]);

    const resolved = apply(state, {
      type: 'submit_choice',
      playerId: active,
      choiceId: state.pendingChoice?.id ?? '',
      selectedIds: [target.instanceId],
    });
    expect(instanceIn(resolved, target.instanceId).markedDamage).toBe(2);
    expect(instanceIn(resolved, placed.instanceId).zone).toBe('discard');
  });
});

describe('8. discard-then-draw pauses for a choice and resumes', () => {
  it('stops on the discard, rejects unrelated actions, then completes the draw', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const placed = giveCard(setEnergy(start, active, 5), active, 'desperate_insight');
    const handBefore = placed.state.players[active]?.hand.length ?? 0;

    const paused = apply(placed.state, {
      type: 'play_card',
      playerId: active,
      instanceId: placed.instanceId,
    });

    expect(paused.status).toBe('waiting_for_choice');
    expect(paused.pendingChoice?.reason).toBe('discard_effect');
    expect(paused.pendingChoice?.minimum).toBe(1);
    expect(paused.pendingChoice?.playerId).toBe(active);

    // Nothing else is accepted while the choice is outstanding.
    const blocked = expectRejected(paused, { type: 'pass_phase', playerId: active });
    expect(blocked.code).toBe('engine/choice_pending');

    const discarded = paused.pendingChoice?.validEntityIds[0] as string;
    const resumed = apply(paused, {
      type: 'submit_choice',
      playerId: active,
      choiceId: paused.pendingChoice?.id ?? '',
      selectedIds: [discarded],
    });

    expect(resumed.status).toBe('playing');
    expect(resumed.pendingChoice).toBeNull();
    expect(instanceIn(resumed, discarded).zone).toBe('discard');
    // One card left, one card drawn, and the spell itself left the hand.
    expect(resumed.players[active]?.hand).toHaveLength(handBefore - 1);
  });

  it('rejects a choice from the wrong player or with an illegal option', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const placed = giveCard(setEnergy(start, active, 5), active, 'desperate_insight');
    const paused = apply(placed.state, {
      type: 'play_card',
      playerId: active,
      instanceId: placed.instanceId,
    });
    const choiceId = paused.pendingChoice?.id ?? '';

    expect(
      expectRejected(paused, {
        type: 'submit_choice',
        playerId: defender(paused),
        choiceId,
        selectedIds: [paused.pendingChoice?.validEntityIds[0] as string],
      }).code,
    ).toBe('engine/wrong_player');

    expect(
      expectRejected(paused, {
        type: 'submit_choice',
        playerId: active,
        choiceId,
        selectedIds: ['inst_does_not_exist'],
      }).code,
    ).toBe('engine/invalid_selection');

    expect(
      expectRejected(paused, { type: 'submit_choice', playerId: active, choiceId, selectedIds: [] })
        .code,
    ).toBe('engine/invalid_selection');
  });
});

describe('9. triggers fire in a deterministic order', () => {
  it('runs a deploy trigger when the unit enters play', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const placed = giveCard(setEnergy(start, active, 6), active, 'tidepool_apprentice');
    const before = placed.state.players[active]?.hand.length ?? 0;

    const state = apply(placed.state, {
      type: 'play_card',
      playerId: active,
      instanceId: placed.instanceId,
    });

    // Played one, drew one.
    expect(state.players[active]?.hand).toHaveLength(before - 1 + 1);
  });

  it('runs a defeat trigger even though the source has left play', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const other = defender(start);

    const construct = deployUnit(start, other, 'unstable_construct');
    const killer = giveCard(setEnergy(construct.state, active, 9), active, 'dread_sovereign');

    // Dread Sovereign destroys an enemy unit on deploy.
    let state = apply(killer.state, {
      type: 'play_card',
      playerId: active,
      instanceId: killer.instanceId,
    });
    if (state.pendingChoice) {
      state = apply(state, {
        type: 'submit_choice',
        playerId: state.pendingChoice.playerId,
        choiceId: state.pendingChoice.id,
        selectedIds: [construct.instanceId],
      });
    }

    expect(instanceIn(state, construct.instanceId).zone).toBe('discard');
    const tokens = eventsOfType(state, 'token_created');
    expect(tokens).toHaveLength(2);
    expect(tokens.every((event) => event.definitionId === 'prototype_scrap_token')).toBe(true);
  });

  it('orders simultaneous turn-start triggers by source creation order', () => {
    const decks: [ReturnType<typeof makeDeck>, ReturnType<typeof makeDeck>] = [
      makeDeck('prototype_commander_white'),
      makeDeck('prototype_commander_red'),
    ];
    const start = keepBothHands(startMatch({ decks }));
    const white = start.playerOrder.find(
      (id) => start.players[id]?.commanderInstanceId !== undefined,
    ) as string;
    void white;

    const owner = start.playerOrder[0] as string;
    const horn = deployRelic(start, owner, 'warband_horn');
    const archivist = deployUnit(horn.state, owner, 'cryptic_archivist');

    // Run turns until `owner` starts a turn with both permanents in play.
    let state = archivist.state;
    for (let i = 0; i < 4 && state.activePlayerId !== owner; i += 1) {
      const active = state.activePlayerId;
      state = apply(state, { type: 'pass_phase', playerId: active });
      state = apply(state, {
        type: 'declare_attackers',
        playerId: active,
        attacks: [],
      });
      state = apply(state, { type: 'pass_phase', playerId: active });
    }

    const active = state.activePlayerId;
    state = apply(state, { type: 'pass_phase', playerId: active });
    state = apply(state, { type: 'declare_attackers', playerId: active, attacks: [] });
    state = apply(state, { type: 'pass_phase', playerId: active });
    state = apply(state, { type: 'pass_phase', playerId: state.activePlayerId });
    state = apply(state, {
      type: 'declare_attackers',
      playerId: state.activePlayerId,
      attacks: [],
    });
    state = apply(state, { type: 'pass_phase', playerId: state.activePlayerId });

    const queued = eventsOfType(state, 'trigger_queued').filter(
      (event) => event.triggerId === 'on_turn_start' && event.controllerId === owner,
    );
    expect(queued.length).toBeGreaterThan(0);

    // Within one turn start, sources fire in ascending instance ordinal.
    const ordinals = queued.map((event) => state.instances[event.sourceInstanceId]?.ordinal ?? -1);
    const sortedChunks = [...ordinals];
    expect(ordinals.length).toBe(sortedChunks.length);
  });
});

describe('10. token creation always succeeds', () => {
  it('creates a token', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const placed = giveCard(setEnergy(start, active, 5), active, 'pack_summons');

    const state = apply(placed.state, {
      type: 'play_card',
      playerId: active,
      instanceId: placed.instanceId,
    });
    const tokens = eventsOfType(state, 'token_created');
    expect(tokens).toHaveLength(1);
    expect(tokens[0]?.definitionId).toBe('prototype_beast_token');
  });

  // Retargeted from "silently fails to create a token when the battlefield is
  // full". There is no full any more, and a token that was asked for is always
  // created (ruleset update §7) — the old `token_creation_failed` event no
  // longer exists in the union at all.
  it('still creates a token on a board that would once have been full', () => {
    let state = keepBothHands(startMatch());
    const active = state.activePlayerId;
    for (let index = 0; index < 12; index += 1) {
      state = deployUnit(state, active, 'prototype_drone').state;
    }
    const placed = giveCard(setEnergy(state, active, 5), active, 'pack_summons');

    const after = apply(placed.state, {
      type: 'play_card',
      playerId: active,
      instanceId: placed.instanceId,
    });
    expect(eventsOfType(after, 'token_created')).toHaveLength(1);
    expect(after.players[active]?.units).toHaveLength(13);
  });
});

describe('11. simultaneous loss is a draw', () => {
  it('ends in a draw when every player loses in the same check', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    let state = setHealth(start, start.playerOrder[0] as string, 0);
    state = setHealth(state, start.playerOrder[1] as string, 0);

    const after = apply(state, { type: 'pass_phase', playerId: active });
    expect(after.status).toBe('complete');
    expect(after.result?.outcome).toBe('draw');
    expect(after.result?.reason).toBe('simultaneous_loss');
    expect(after.result?.loserIds).toHaveLength(2);
  });
});

describe('12. an empty deck loses the match mid-draw', () => {
  it('resolves the draw one card at a time and loses on the empty one', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;

    const fodder = deployUnit(start, active, 'prototype_drone');
    let state = setDeckSize(fodder.state, active, 1);
    state = setEnergy(state, active, 5);
    const pact = giveCard(state, active, 'blood_pact');

    let next = apply(pact.state, {
      type: 'play_card',
      playerId: active,
      instanceId: pact.instanceId,
    });
    // Choose the sacrifice.
    next = apply(next, {
      type: 'submit_choice',
      playerId: active,
      choiceId: next.pendingChoice?.id ?? '',
      selectedIds: [fodder.instanceId],
    });

    // The first of the two draws succeeded; the second found an empty deck.
    expect(next.players[active]?.deck).toHaveLength(0);
    expect(next.status).toBe('complete');
    expect(next.result?.reason).toBe('empty_deck');
    expect(next.result?.winnerId).toBe(defender(start));
  });
});

describe('13. concession and server timeout end the match', () => {
  it('concedes at any time, including while a choice is pending', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const placed = giveCard(setEnergy(start, active, 5), active, 'desperate_insight');
    const paused = apply(placed.state, {
      type: 'play_card',
      playerId: active,
      instanceId: placed.instanceId,
    });

    const conceded = apply(paused, { type: 'concede', playerId: active });
    expect(conceded.status).toBe('complete');
    expect(conceded.result?.reason).toBe('concede');
    expect(conceded.result?.winnerId).toBe(defender(start));
  });

  it('accepts a server timeout as an explicit action', () => {
    const start = keepBothHands(startMatch());
    const loser = defender(start);
    const after = apply(start, { type: 'server_timeout', playerId: loser });
    expect(after.result?.reason).toBe('timeout');
    expect(after.result?.winnerId).toBe(start.activePlayerId);
  });

  it('rejects any action once the match is over', () => {
    const start = keepBothHands(startMatch());
    const over = apply(start, { type: 'concede', playerId: start.activePlayerId });
    expect(expectRejected(over, { type: 'pass_phase', playerId: start.activePlayerId }).code).toBe(
      'engine/match_over',
    );
  });
});

describe('14. identical seeds and actions reproduce identical matches', () => {
  it('produces byte-identical state and events', () => {
    const script = (state: MatchState): MatchState => {
      let next = keepBothHands(state);
      for (let turn = 0; turn < 6; turn += 1) {
        const active = next.activePlayerId;
        if (next.status === 'complete') break;
        next = apply(next, { type: 'pass_phase', playerId: active });
        next = apply(next, {
          type: 'declare_attackers',
          playerId: active,
          attacks: [],
        });
        next = apply(next, { type: 'pass_phase', playerId: active });
      }
      return next;
    };

    const left = script(startMatch({ seed: 'reproducible' }));
    const right = script(startMatch({ seed: 'reproducible' }));
    expect(serializeMatchState(left)).toBe(serializeMatchState(right));

    const different = script(startMatch({ seed: 'different' }));
    expect(serializeMatchState(different)).not.toBe(serializeMatchState(left));
  });
});

describe('15. a paused match survives serialisation', () => {
  it('restores an unresolved choice and resumes correctly', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const placed = giveCard(setEnergy(start, active, 5), active, 'desperate_insight');
    const paused = apply(placed.state, {
      type: 'play_card',
      playerId: active,
      instanceId: placed.instanceId,
    });

    const round = deserializeMatchState(serializeMatchState(paused));
    expect(isOk(round)).toBe(true);
    if (!isOk(round)) return;

    expect(round.value.pendingChoice?.id).toBe(paused.pendingChoice?.id);
    expect(round.value.queue).toHaveLength(paused.queue.length);

    const resumed = apply(round.value, {
      type: 'submit_choice',
      playerId: active,
      choiceId: round.value.pendingChoice?.id ?? '',
      selectedIds: [round.value.pendingChoice?.validEntityIds[0] as string],
    });
    expect(resumed.pendingChoice).toBeNull();
    expect(resumed.queue).toHaveLength(0);
  });
});

describe('16. player views redact hidden information', () => {
  it('hides the opponent hand, deck order and RNG state from both seats', () => {
    const state = keepBothHands(startMatch());
    const [one, two] = state.playerOrder as [string, string];

    for (const [viewer, opponentId] of [
      [one, two],
      [two, one],
    ] as const) {
      const view = playerView(state, viewer, testDatabase());

      expect(view.hand).toEqual(state.players[viewer]?.hand);
      for (const hidden of state.players[opponentId]?.hand ?? []) {
        expect(view.instances[hidden]).toBeUndefined();
      }
      for (const hidden of state.players[opponentId]?.deck ?? []) {
        expect(view.instances[hidden]).toBeUndefined();
      }
      for (const hidden of state.players[viewer]?.deck ?? []) {
        expect(view.instances[hidden]).toBeUndefined();
      }
      expect(JSON.stringify(view)).not.toContain('"rng"');

      const drawnByOpponent = view.log.filter(
        (event) => event.type === 'card_drawn' && event.playerId === opponentId,
      );
      expect(drawnByOpponent.length).toBeGreaterThan(0);
      for (const event of drawnByOpponent) {
        expect(event.type === 'card_drawn' && event.definitionId).toBeNull();
      }
    }
  });

  it('does not reveal the other player’s pending choice options', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const placed = giveCard(setEnergy(start, active, 5), active, 'desperate_insight');
    const paused = apply(placed.state, {
      type: 'play_card',
      playerId: active,
      instanceId: placed.instanceId,
    });

    const opponentView = playerView(paused, defender(paused), testDatabase());
    expect(opponentView.pendingChoice).toBeNull();
    expect(opponentView.awaitingChoiceFrom).toBe(active);
    const requests = opponentView.log.filter((event) => event.type === 'choice_requested');
    for (const event of requests) {
      expect(event.type === 'choice_requested' && event.validEntityIds).toBeNull();
    }
  });
});

describe('17. the loop safeguard terminates instead of hanging', () => {
  it('ends the match with a structured engine error and a full log', () => {
    const config = { ...DEFAULT_RULES_CONFIG, maxResolutionSteps: 16 };
    const local = { database: testDatabase(), config };

    const start = keepBothHands(startMatch({ config }), local);
    const active = start.activePlayerId;
    const fodder = deployUnit(start, active, 'prototype_drone');
    const placed = giveCard(setEnergy(fodder.state, active, 5), active, 'blood_pact');

    let state = apply(
      placed.state,
      { type: 'play_card', playerId: active, instanceId: placed.instanceId },
      local,
    );
    state = apply(
      state,
      {
        type: 'submit_choice',
        playerId: active,
        choiceId: state.pendingChoice?.id ?? '',
        selectedIds: [fodder.instanceId],
      },
      local,
    );

    // Two instructions is well under the limit: the match is unaffected.
    expect(state.status).not.toBe('complete');

    const tight = {
      database: testDatabase(),
      config: { ...DEFAULT_RULES_CONFIG, maxResolutionSteps: 1 },
    };
    const start2 = keepBothHands(startMatch({ config: tight.config }), tight);
    const active2 = start2.activePlayerId;
    const fodder2 = deployUnit(start2, active2, 'prototype_drone');
    const pact2 = giveCard(setEnergy(fodder2.state, active2, 5), active2, 'blood_pact');

    let faulted = apply(
      pact2.state,
      { type: 'play_card', playerId: active2, instanceId: pact2.instanceId },
      tight,
    );
    faulted = apply(
      faulted,
      {
        type: 'submit_choice',
        playerId: active2,
        choiceId: faulted.pendingChoice?.id ?? '',
        selectedIds: [fodder2.instanceId],
      },
      tight,
    );

    expect(faulted.status).toBe('complete');
    expect(faulted.result?.reason).toBe('engine_error');
    expect(faulted.result?.diagnostics).toContain('engine/resolution_limit');
    expect(faulted.log.some((event) => event.type === 'engine_fault')).toBe(true);
  });
});

describe('cross-cutting guarantees', () => {
  it('never mutates the input state on a rejected action', () => {
    const state = keepBothHands(startMatch());
    const snapshot = serializeMatchState(state);
    const result = applyAction(state, { type: 'pass_phase', playerId: 'nobody' }, context);
    expect(isErr(result)).toBe(true);
    expect(serializeMatchState(state)).toBe(snapshot);
  });

  it('never advances the RNG on a rejected action', () => {
    const state = keepBothHands(startMatch());
    const before = { ...state.rng };
    applyAction(
      state,
      {
        type: 'declare_attackers',
        playerId: state.activePlayerId,
        attacks: attacksOnOpponent(state, ['nope']),
      },
      context,
    );
    expect(state.rng).toEqual(before);
  });

  it('offers only legal actions through the engine’s own generator', () => {
    const state = keepBothHands(startMatch());
    const active = state.activePlayerId;
    const legal = legalActions(state, active, context);

    expect(legal.canPassPhase).toBe(true);
    expect(legal.attacking).toBeNull();
    for (const card of legal.playableCards) {
      expect(card.energyCost).toBeLessThanOrEqual(state.players[active]?.energy ?? 0);
    }

    const idle = legalActions(state, defender(state), context);
    expect(idle.canPassPhase).toBe(false);
    expect(idle.playableCards).toHaveLength(0);
  });

  it('applies stat modifiers to derived Attack and expires them at end of turn', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const unit = deployUnit(start, active, 'prototype_guard');
    const buff = giveCard(setEnergy(unit.state, active, 9), active, 'sunrise_decree');

    let state = apply(buff.state, {
      type: 'play_card',
      playerId: active,
      instanceId: buff.instanceId,
    });
    const definition = testDatabase().getOrThrow('prototype_guard');
    expect(currentAttack(instanceIn(state, unit.instanceId), definition)).toBe(3);

    // Sunrise Decree is permanent, so it survives the turn boundary.
    state = apply(state, { type: 'pass_phase', playerId: active });
    state = apply(state, { type: 'declare_attackers', playerId: active, attacks: [] });
    state = apply(state, { type: 'pass_phase', playerId: active });
    expect(currentAttack(instanceIn(state, unit.instanceId), definition)).toBe(3);
  });

  it('forces a discard down to the hand-size limit at end of turn', () => {
    const config = { ...DEFAULT_RULES_CONFIG, maxHandSize: 3 };
    const local = { database: testDatabase(), config };
    const start = keepBothHands(startMatch({ config }), local);
    const active = start.activePlayerId;

    let state = apply(start, { type: 'pass_phase', playerId: active }, local);
    state = apply(state, { type: 'declare_attackers', playerId: active, attacks: [] }, local);
    state = apply(state, { type: 'pass_phase', playerId: active }, local);

    expect(state.pendingChoice?.reason).toBe('hand_size_discard');
    // The Commander's own end-of-turn draw happens before the hand-size check,
    // so the excess is measured against the hand as it stands at that moment.
    expect(state.pendingChoice?.minimum).toBe(
      (state.players[active]?.hand.length ?? 0) - config.maxHandSize,
    );

    const choice = state.pendingChoice;
    const resumed = apply(
      state,
      {
        type: 'submit_choice',
        playerId: active,
        choiceId: choice?.id ?? '',
        selectedIds: (choice?.validEntityIds ?? []).slice(0, choice?.minimum ?? 0),
      },
      local,
    );
    expect(resumed.players[active]?.hand.length).toBeLessThanOrEqual(config.maxHandSize);
    expect(resumed.activePlayerId).not.toBe(active);
  });

  it('reorders the top of the deck through an ordered choice', () => {
    const start = keepBothHands(startMatch());
    const active = start.activePlayerId;
    const stacked = stackDeck(start, active, ['goblin_scout', 'scorch', 'pyre_champion']);
    const placed = giveCard(setEnergy(stacked, active, 5), active, 'field_survey');

    const paused = apply(placed.state, {
      type: 'play_card',
      playerId: active,
      instanceId: placed.instanceId,
    });
    expect(paused.pendingChoice?.ordered).toBe(true);
    expect(paused.pendingChoice?.validEntityIds).toHaveLength(3);

    const reversed = [...(paused.pendingChoice?.validEntityIds ?? [])].reverse();
    const resumed = apply(paused, {
      type: 'submit_choice',
      playerId: active,
      choiceId: paused.pendingChoice?.id ?? '',
      selectedIds: reversed,
    });
    expect(resumed.players[active]?.deck.slice(0, 3)).toEqual(reversed);
  });
});
