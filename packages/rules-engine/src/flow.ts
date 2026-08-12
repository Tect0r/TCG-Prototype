import { emit, type MatchContext } from './context.js';
import { clearCombat, resolveCombat } from './combat.js';
import { reachDelayedBoundary } from './delayed.js';
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
import { openReactionWindow, resumeReactionWindow } from './reactions.js';
import {
  consumeReadySkip,
  readyReplacementOffers,
  readyStepCandidates,
  takeReadyReplacement,
} from './replacement.js';
import { shuffleDeck } from './zones.js';
import { drawOne } from './zones.js';
import { freshTurnEvents } from './schema/state.js';
import type { Continuation } from './schema/choice.js';
import type { InstanceId, MatchPhase, PlayerId } from './schema/primitives.js';

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

  // The end-of-turn boundary is the transition itself, not the later
  // `performTurnEnd` bookkeeping: by the time that runs, `advance` has already
  // drained the queue and is about to hand the turn to the next player, so
  // anything queued there would resolve on somebody else's turn (M02.1).
  //
  // Queued *before* `settle`, which is what discovers the `on_turn_end`
  // abilities of this same transition — so a promise made earlier in the turn
  // resolves ahead of an ability that only now noticed the turn ending. Both
  // orders are defensible; this one is fixed, documented and deterministic.
  if (to === 'turn_end') reachDelayedBoundary(ctx, 'end_of_turn');

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
  // "… this turn" starts counting again from here (ruleset update §15).
  ctx.state.turnEvents = freshTurnEvents();

  // "Until the beginning of your next turn" ends here, and only for this
  // player — that is exactly what makes it outlast the opponents' turns that
  // came between (ruleset update §15).
  expireModifiers(ctx, NEXT_TURN_DURATIONS, playerId);

  const player = playerOf(ctx.state, playerId);

  // "The first Reaction Spell you play after the beginning of each of your
  // turns" (rule adjustment §6). Reset here and nowhere else, which is exactly
  // what makes the discount survive every opponent's turn in between — the
  // turns on which a Reaction is actually played.
  player.reactionDiscountSpent = false;

  // The Ready Step is also where `Newly Deployed` ends: the state lasts through
  // opponents' turns and clears when its controller's own turn begins
  // (ADR 0016 Q-B). Relics are included because a Commander or relic can carry
  // the state too.
  //
  // Cleared for every permanent, including one a replacement is about to keep
  // Exhausted. `Newly Deployed` ends *at* the Ready Step, not because the unit
  // readied — the two are separate facts, and a unit held down by Stasis is no
  // longer newly deployed either way.
  for (const instanceId of [...player.units, ...player.relics]) {
    const instance = findInstance(ctx.state, instanceId);
    if (!instance) continue;
    instance.newlyDeployed = false;
  }

  runReadyStep(ctx, [], []);
}

/**
 * The Ready Step itself, and the one part of turn start that can pause (M02.4).
 *
 * Three stages, in a fixed order:
 *
 *  1. **Stored preventions.** A `skip_next_ready` already sitting on a permanent
 *     is consumed. Free, and already committed by the card that applied it.
 *  2. **Standing replacements.** Each active `replace_ready` on any board is
 *     offered, in the engine's deterministic replacement order, and one that
 *     costs Energy pauses for its controller's answer.
 *  3. **Readying.** Everything not kept Exhausted becomes Ready.
 *
 * Stage 1 runs before stage 2 deliberately, and it is a gameplay decision rather
 * than an implementation detail: a unit already held down for free is not
 * offered to a replacement that would charge for the same outcome, so nobody is
 * ever asked to pay for a no-op.
 *
 * `keptExhausted` and `askedSourceIds` are the whole of the resumable state.
 * They are carried through the pending choice rather than recomputed, because
 * stage 1 is destructive — a consumed `skip_next_ready` is gone, so re-running
 * stage 1 after a pause would find nothing and ready a unit that is meant to
 * stay down.
 */
function runReadyStep(
  ctx: MatchContext,
  keptExhausted: readonly InstanceId[],
  askedSourceIds: readonly InstanceId[],
): void {
  const playerId = ctx.state.activePlayerId;
  const kept = [...keptExhausted];
  const asked = [...askedSourceIds];

  for (const instanceId of readyStepCandidates(ctx, playerId)) {
    const instance = findInstance(ctx.state, instanceId);
    if (!instance) continue;
    if (consumeReadySkip(ctx, instance) && !kept.includes(instanceId)) kept.push(instanceId);
  }

  // Bounded by the number of replacement sources on the board: every pass either
  // asks a source that is then recorded in `asked` and never revisited, or ends.
  for (;;) {
    const offer = readyReplacementOffers(ctx, playerId, kept).find(
      (entry) => !asked.includes(entry.sourceInstanceId),
    );
    if (offer === undefined) break;
    asked.push(offer.sourceInstanceId);

    // A replacement with no cost is not a decision, so nothing is asked. It
    // applies to as many permanents as its limit allows: every one in scope when
    // it is `unlimited`, the first when it is "the first each turn".
    if (offer.energyCost === 0) {
      for (const instanceId of offer.candidateIds) {
        if (!takeReadyReplacement(ctx, offer, instanceId)) continue;
        kept.push(instanceId);
        if (offer.limit === 'first_each_turn') break;
      }
      continue;
    }

    ctx.state.pendingChoice = {
      id: nextChoiceId(ctx),
      playerId: offer.controllerId,
      type: 'select_units',
      reason: 'keep_exhausted',
      zone: 'battlefield',
      minimum: 0,
      maximum: 1,
      validEntityIds: [...offer.candidateIds],
      ordered: false,
      sourceInstanceId: offer.sourceInstanceId,
      continuation: {
        kind: 'ready_step_replacement',
        playerId,
        sourceInstanceId: offer.sourceInstanceId,
        askedSourceIds: asked,
        keptExhaustedIds: kept,
      },
    };
    ctx.state.status = 'waiting_for_choice';
    emit(ctx, {
      type: 'choice_requested',
      choiceId: ctx.state.pendingChoice.id,
      playerId: offer.controllerId,
      choiceType: 'select_units',
      reason: 'keep_exhausted',
      minimum: 0,
      maximum: 1,
      validEntityIds: [...offer.candidateIds],
    });
    return;
  }

  finishReadyStep(ctx, kept);
}

/**
 * Answers one `replace_ready` offer and carries the Ready Step on.
 *
 * The offer is rebuilt from the current board rather than trusted from the
 * choice: a paused match may have been serialised, stored and reloaded, and the
 * engine re-derives legality for every answer it accepts (CLAUDE.md §9). An
 * answer that no longer validates simply does not apply, and the unit readies.
 */
export function resumeReadyStepReplacement(
  ctx: MatchContext,
  continuation: Extract<Continuation, { kind: 'ready_step_replacement' }>,
  selectedIds: readonly InstanceId[],
): void {
  const kept = [...continuation.keptExhaustedIds];
  const offer = readyReplacementOffers(ctx, continuation.playerId, kept).find(
    (entry) => entry.sourceInstanceId === continuation.sourceInstanceId,
  );

  const chosen = selectedIds[0];
  if (offer !== undefined && chosen !== undefined && takeReadyReplacement(ctx, offer, chosen)) {
    kept.push(chosen);
  }

  runReadyStep(ctx, kept, continuation.askedSourceIds);
}

/** Readies everything the replacement layer did not keep down, then starts the turn. */
function finishReadyStep(ctx: MatchContext, keptExhausted: readonly InstanceId[]): void {
  const playerId = ctx.state.activePlayerId;
  const player = playerOf(ctx.state, playerId);

  for (const instanceId of [...player.units, ...player.relics]) {
    if (keptExhausted.includes(instanceId)) continue;
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
  emit(ctx, { type: 'turn_started', playerId, turn: ctx.state.turn });
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

/**
 * Removes every modifier whose duration boundary has just been reached.
 *
 * One function for three boundaries rather than three near-identical ones,
 * because they differ only in *which* durations they clear and every one of
 * them has to be followed by a state-based check — losing a Health bonus can be
 * lethal (CLAUDE.md §4).
 *
 * `until_your_next_turn` is cleared only for the player whose turn is starting,
 * which is what makes it outlast the opponents' turns in between.
 */
function expireModifiers(
  ctx: MatchContext,
  durations: ReadonlySet<string>,
  onlyFor: PlayerId | null = null,
): void {
  const before = ctx.events.length;
  const expired = <T extends { duration: string }>(entry: T): boolean =>
    !durations.has(entry.duration);

  for (const instance of Object.values(ctx.state.instances)) {
    if (onlyFor !== null && instance.controller !== onlyFor) continue;
    const sizeBefore =
      instance.statModifiers.length +
      instance.grantedKeywords.length +
      instance.removedKeywords.length +
      instance.damageShields.length;

    instance.statModifiers = instance.statModifiers.filter(expired);
    instance.grantedKeywords = instance.grantedKeywords.filter(expired);
    instance.removedKeywords = instance.removedKeywords.filter(expired);
    instance.damageShields = instance.damageShields.filter(expired);

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
    if (onlyFor !== null && playerId !== onlyFor) continue;
    const player = playerOf(ctx.state, playerId);
    player.costModifiers = player.costModifiers.filter(expired);
    player.damageShields = player.damageShields.filter(expired);
  }

  settle(ctx, before);
}

const END_OF_TURN_DURATIONS: ReadonlySet<string> = new Set(['end_of_turn']);
const END_OF_COMBAT_DURATIONS: ReadonlySet<string> = new Set(['end_of_combat']);
const NEXT_TURN_DURATIONS: ReadonlySet<string> = new Set(['until_your_next_turn']);

/**
 * "For that combat" ends when combat resolution does (ruleset update §15).
 *
 * The boundary is *after* the survive-combat triggers, not before them: a trick
 * that granted +2/+2 is the reason a unit survived, and a trigger asking about
 * that unit's stats should still see the combat it was fought with.
 */
function expireEndOfCombatEffects(ctx: MatchContext): void {
  expireModifiers(ctx, END_OF_COMBAT_DURATIONS);
}

/** Removes everything that lasts "until end of turn". */
function expireEndOfTurnEffects(ctx: MatchContext): void {
  expireModifiers(ctx, END_OF_TURN_DURATIONS);
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

  // "Survived combat as a blocker since your previous turn" resets here, at the
  // end of the controller's own turn, so the `on_turn_start` cards that read it
  // still have something to read. Nothing can be added during your own turn:
  // blocking only ever happens on the turn of whoever declared the attack.
  for (const instance of Object.values(ctx.state.instances)) {
    if (instance.controller === ctx.state.activePlayerId) instance.survivedAsBlocker = false;
  }

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

  // Declaring a unit as a blocker exhausts it (ruleset update §8).
  //
  // Done here, at the moment the merged list becomes public, rather than when
  // each defender submits. `exhausted` is visible in every seat's view, so
  // exhausting on submission would tell the attacker and the other defenders
  // exactly who had been committed while submissions are still meant to be
  // hidden (CLAUDE.md §12). Exhaustion does not stop the blocker dealing its
  // own combat damage; it is what stops it blocking again next turn without
  // readying.
  for (const block of combat.blocks) {
    const blocker = findInstance(ctx.state, block.blockerInstanceId);
    if (!blocker || blocker.exhausted) continue;
    blocker.exhausted = true;
    emit(ctx, { type: 'unit_exhausted', instanceId: block.blockerInstanceId });
  }

  emit(ctx, {
    type: 'blockers_assigned',
    playerId: null,
    blocks: combat.blocks.map((block) => ({ ...block })),
  });
  // `on_block` triggers resolve before combat damage.
  settle(ctx, before);

  // The last chance to change a combat before damage (rule adjustment §5).
  const opened = openReactionWindow(ctx, {
    windows: ['after_blockers_declared'],
    resumePhase: 'resolve_combat',
  });
  if (!opened) setPhase(ctx, 'resolve_combat');
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

      case 'resolve_combat': {
        resolveCombat(ctx);
        if (isMatchOver(ctx.state)) return;
        // Losing a combat-only Health bonus here can defeat an already-damaged
        // unit, so this runs before the phase advances rather than lazily at
        // turn end.
        expireEndOfCombatEffects(ctx);
        if (isMatchOver(ctx.state)) return;
        // "After combat damage" and "after combat" are the same moment once
        // damage and its defeats have settled, so one window admits both. The
        // combat state is still populated, which is what lets a Reaction ask
        // about "a Unit that attacked that combat".
        const opened = openReactionWindow(ctx, {
          windows: ['after_combat_damage', 'after_combat'],
          resumePhase: 'main_2',
        });
        if (!opened) setPhase(ctx, 'main_2');
        break;
      }

      case 'reaction_window':
        // Priority is still going round: the window is waiting on a player.
        if (!resumeReactionWindow(ctx)) return;
        break;

      case 'turn_end':
        if (!performTurnEnd(ctx)) return;
        break;

      default:
        return;
    }
  }
}
