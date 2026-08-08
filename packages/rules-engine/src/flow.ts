import { emit, type MatchContext } from './context.js';
import { clearCombat, resolveCombat } from './combat.js';
import {
  findInstance,
  instanceOf,
  isAlive,
  isMatchOver,
  nextLivingPlayer,
  playerOf,
} from './derive.js';
import { nextChoiceId } from './effects.js';
import { pumpQueue, settle } from './queue.js';
import { shuffleDeck } from './zones.js';
import { drawOne } from './zones.js';
import type { MatchPhase, PlayerId } from './schema/primitives.js';

/**
 * Turn and phase machine. Every transition happens here and is observable in the
 * log; nothing about phase legality is left to the UI (CLAUDE.md §10).
 */

export function setPhase(ctx: MatchContext, to: MatchPhase): void {
  const from = ctx.state.phase;
  if (from === to) return;
  const before = ctx.events.length;
  ctx.state.phase = to;
  emit(ctx, { type: 'phase_changed', from, to });
  // `on_turn_end` triggers hang off the transition into `turn_end`.
  settle(ctx, before);
}

/** Every seat has submitted; apply the redraws and start turn 1. */
export function resolveMulligans(ctx: MatchContext): void {
  for (const playerId of ctx.state.playerOrder) {
    const player = playerOf(ctx.state, playerId);
    const returned = [...player.mulligan.returnedInstanceIds];

    if (returned.length > 0) {
      // Set the returned cards aside, draw replacements, then shuffle them back
      // in — drawing first is what makes a redraw meaningfully random.
      for (const instanceId of returned) {
        const index = player.hand.indexOf(instanceId);
        if (index >= 0) player.hand.splice(index, 1);
      }
      for (let i = 0; i < returned.length; i += 1) drawOne(ctx, playerId);
      for (const instanceId of returned) {
        const instance = instanceOf(ctx.state, instanceId);
        instance.zone = 'deck';
        player.deck.push(instanceId);
      }
      shuffleDeck(ctx, playerId);
    }

    player.mulligan = {
      status: 'resolved',
      returnedInstanceIds: returned,
      redrawsUsed: returned.length > 0 ? player.mulligan.redrawsUsed : player.mulligan.redrawsUsed,
    };
    emit(ctx, { type: 'mulligan_resolved', playerId, returnedCount: returned.length });
  }

  ctx.state.status = 'playing';
  const first = ctx.state.playerOrder.find((id) => isAlive(ctx.state, id));
  if (first === undefined) throw new Error('Match has no living players');
  beginTurn(ctx, first, 1);
}

/** Turn-start bookkeeping, then the `on_turn_start` triggers. */
export function beginTurn(ctx: MatchContext, playerId: PlayerId, turn: number): void {
  ctx.state.turn = turn;
  ctx.state.activePlayerId = playerId;
  ctx.state.phase = 'turn_start';
  clearCombat(ctx);

  const player = playerOf(ctx.state, playerId);

  for (const instanceId of player.units) {
    if (instanceId === null) continue;
    const instance = findInstance(ctx.state, instanceId);
    if (!instance || !instance.exhausted) continue;
    instance.exhausted = false;
    emit(ctx, { type: 'unit_readied', instanceId });
  }

  player.maxEnergy = Math.min(
    player.maxEnergy + ctx.config.energyGainPerTurn,
    ctx.config.energyCap,
  );
  player.energy = player.maxEnergy;
  emit(ctx, {
    type: 'energy_updated',
    playerId,
    energy: player.energy,
    maxEnergy: player.maxEnergy,
  });

  const before = ctx.events.length;
  emit(ctx, { type: 'turn_started', playerId, turn });
  settle(ctx, before);
}

function performDraw(ctx: MatchContext): void {
  const player = playerOf(ctx.state, ctx.state.activePlayerId);
  const before = ctx.events.length;

  if (player.skipNextDraw) {
    // The player who acts first skips their first normal draw, to soften the
    // first-player advantage (CLAUDE.md §4, provisional).
    player.skipNextDraw = false;
    emit(ctx, { type: 'draw_skipped', playerId: player.playerId });
    return;
  }

  drawOne(ctx, player.playerId);
  settle(ctx, before);
}

/** Removes everything that lasts "until end of turn". */
function expireEndOfTurnEffects(ctx: MatchContext): void {
  const before = ctx.events.length;

  for (const instance of Object.values(ctx.state.instances)) {
    const sizeBefore =
      instance.statModifiers.length +
      instance.grantedKeywords.length +
      instance.removedKeywords.length +
      instance.damageShields.length;

    instance.statModifiers = instance.statModifiers.filter((m) => m.duration !== 'end_of_turn');
    instance.grantedKeywords = instance.grantedKeywords.filter((m) => m.duration !== 'end_of_turn');
    instance.removedKeywords = instance.removedKeywords.filter((m) => m.duration !== 'end_of_turn');
    instance.damageShields = instance.damageShields.filter((s) => s.duration !== 'end_of_turn');

    const sizeAfter =
      instance.statModifiers.length +
      instance.grantedKeywords.length +
      instance.removedKeywords.length +
      instance.damageShields.length;

    if (sizeAfter !== sizeBefore) {
      emit(ctx, {
        type: 'modifiers_expired',
        instanceId: instance.instanceId,
        count: sizeBefore - sizeAfter,
      });
    }
  }

  for (const playerId of ctx.state.seatOrder) {
    const player = playerOf(ctx.state, playerId);
    player.costModifiers = player.costModifiers.filter((m) => m.duration !== 'end_of_turn');
    player.damageShields = player.damageShields.filter((s) => s.duration !== 'end_of_turn');
  }

  // Losing a temporary Health bonus can be lethal to an already damaged unit.
  settle(ctx, before);
}

/**
 * Turn end: hand-size discard first (it pauses for a choice), then expiry, then
 * the next player's turn.
 */
function performTurnEnd(ctx: MatchContext): boolean {
  const player = playerOf(ctx.state, ctx.state.activePlayerId);
  const excess = player.hand.length - ctx.config.maxHandSize;

  if (excess > 0) {
    ctx.state.pendingChoice = {
      id: nextChoiceId(ctx),
      playerId: player.playerId,
      type: 'select_cards',
      reason: 'hand_size_discard',
      zone: 'hand',
      minimum: excess,
      maximum: excess,
      validEntityIds: [...player.hand],
      ordered: false,
      sourceInstanceId: null,
      continuation: { kind: 'turn_end_discard' },
    };
    ctx.state.status = 'waiting_for_choice';
    emit(ctx, {
      type: 'choice_requested',
      choiceId: ctx.state.pendingChoice.id,
      playerId: player.playerId,
      choiceType: 'select_cards',
      reason: 'hand_size_discard',
      minimum: excess,
      maximum: excess,
      validEntityIds: [...player.hand],
    });
    return false;
  }

  expireEndOfTurnEffects(ctx);
  if (isMatchOver(ctx.state)) return false;

  // An eliminated seat is skipped without renumbering or reordering the rest,
  // so the circle stays exactly as it was dealt (CLAUDE.md §12).
  const next = nextLivingPlayer(ctx.state, ctx.state.activePlayerId);
  if (next === null) return false;

  beginTurn(ctx, next, ctx.state.turn + 1);
  return true;
}

/**
 * Merges the independently collected blocker submissions into one public
 * assignment and moves to damage.
 *
 * Ordering the merge by seat rather than by arrival is what makes two defenders
 * answering in either network order produce byte-identical state
 * (CLAUDE.md §12).
 */
function finalizeBlockers(ctx: MatchContext): void {
  const combat = ctx.state.combat;
  const bySeat = ctx.state.seatOrder
    .map((playerId) => combat.submissions.find((entry) => entry.defenderPlayerId === playerId))
    .filter((entry): entry is NonNullable<typeof entry> => entry !== undefined);

  combat.blocks = bySeat.flatMap((entry) => entry.blocks.map((block) => ({ ...block })));

  const before = ctx.events.length;
  emit(ctx, {
    type: 'blockers_assigned',
    playerId: null,
    blocks: combat.blocks.map((block) => ({ ...block })),
  });
  // `on_block` triggers resolve before combat damage.
  settle(ctx, before);

  setPhase(ctx, 'resolve_combat');
}

/**
 * Drives the match forward until it needs a player: a Main Phase pass, an attack
 * or block declaration, a pending choice, or the end of the match.
 */
export function advance(ctx: MatchContext): void {
  for (let guard = 0; guard < 1024; guard += 1) {
    pumpQueue(ctx);
    if (isMatchOver(ctx.state)) return;
    if (ctx.state.pendingChoice !== null) return;
    if (ctx.state.status === 'waiting_for_choice') ctx.state.status = 'playing';

    // The active seat can be eliminated in the middle of its own turn: an
    // empty-deck draw, a concession, a timeout, or an effect that kills its
    // controller. The circle skips it immediately rather than stalling on a turn
    // nobody is left to take (CLAUDE.md §12). With two seats the match is
    // already over by the time this is reached, so it only ever fires in a
    // free-for-all.
    if (!isAlive(ctx.state, ctx.state.activePlayerId)) {
      const heir = nextLivingPlayer(ctx.state, ctx.state.activePlayerId);
      if (heir === null) return;
      beginTurn(ctx, heir, ctx.state.turn + 1);
      continue;
    }

    switch (ctx.state.phase) {
      case 'setup':
      case 'mulligan':
      case 'main_1':
      case 'main_2':
      case 'declare_attackers':
      case 'complete':
        return;

      case 'assign_blockers':
        // Several defenders answer independently; damage waits for the last of
        // them. An eliminated defender is dropped from the list rather than
        // stalling the match (CLAUDE.md §12).
        ctx.state.combat.awaitingDefenders = ctx.state.combat.awaitingDefenders.filter((id) =>
          isAlive(ctx.state, id),
        );
        if (ctx.state.combat.awaitingDefenders.length > 0) return;
        finalizeBlockers(ctx);
        break;

      case 'turn_start':
        setPhase(ctx, 'draw');
        break;

      case 'draw':
        performDraw(ctx);
        if (isMatchOver(ctx.state)) return;
        setPhase(ctx, 'main_1');
        break;

      case 'resolve_combat':
        resolveCombat(ctx);
        if (isMatchOver(ctx.state)) return;
        setPhase(ctx, 'main_2');
        break;

      case 'turn_end':
        if (!performTurnEnd(ctx)) return;
        break;

      default:
        return;
    }
  }
}
