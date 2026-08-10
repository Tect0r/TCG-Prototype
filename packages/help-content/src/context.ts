import type { ZoneId } from '@tcg/card-data';
import type { PlayerView } from '@tcg/rules-engine';
import { numberWord, plural, sentence } from './explain/grammar.js';

/**
 * "Why can't I play this?", answered from authoritative data only.
 *
 * Every fact in `PublicCardContext` is either copied straight out of the seat's
 * `PlayerView` or read from `view.legalActions`, which the engine computed. The
 * client never re-derives legality: if the engine has not said a card is
 * playable, this module will not claim to know why, it will say so plainly.
 *
 * That restraint is deliberate. A cost reducer, a filter or a target
 * requirement can each make a card unplayable, and several can apply at once;
 * a client that guessed would eventually tell a player something false about
 * the rules. A neutral sentence is worth more than a confident wrong one.
 */

export interface PublicCardContext {
  readonly zone: ZoneId;
  /** True when the card belongs to the viewing seat. */
  readonly ownedByViewer: boolean;
  readonly exhausted: boolean;
  readonly summoningSick: boolean;
  readonly markedDamage: number;
  /** Derived attack/health, including every active modifier. */
  readonly attack: number | null;
  readonly health: number | null;
  /** Energy the engine says it costs, when the engine says it is playable. */
  readonly playableForEnergy: number | null;
  readonly canAttackNow: boolean;
  readonly canBlockNow: boolean;
  /** Activated ability IDs the engine currently offers on this card. */
  readonly activatableAbilityIds: readonly string[];
  /** The viewer may act at all — their turn, a main phase, nothing resolving. */
  readonly viewerMayPlayCards: boolean;
  /**
   * Units the viewer controls, or null when it is not their board.
   *
   * Reported for context, never as a limit: there is no cap to be near
   * (ruleset update §7).
   */
  readonly viewerUnitCount: number | null;
  readonly viewerEliminated: boolean;
  /** A choice is pending, so ordinary actions are refused. */
  readonly choicePending: boolean;
}

/**
 * Reads one card's public situation out of the seat's own view.
 *
 * `instanceId` must already be in `view.instances`, which by construction only
 * contains cards this seat may legitimately identify — both battlefields, both
 * discard piles, the Commanders, and the viewer's own hand. Nothing else is
 * reachable, so an inspector built on this cannot surface hidden information
 * even if it asks for it.
 */
export function publicCardContext(view: PlayerView, instanceId: string): PublicCardContext | null {
  const instance = view.instances[instanceId];
  if (!instance) return null;

  const legal = view.legalActions;
  const me = view.players.find((player) => player.playerId === view.viewerId);
  const playable = legal.playableCards.find((card) => card.instanceId === instanceId);

  return {
    zone: instance.zone,
    ownedByViewer: instance.owner === view.viewerId,
    exhausted: instance.exhausted,
    summoningSick: instance.summoningSick,
    markedDamage: instance.markedDamage,
    attack: instance.attack,
    health: instance.health,
    playableForEnergy: playable?.energyCost ?? null,
    canAttackNow: legal.attacking?.legalAttackers.includes(instanceId) ?? false,
    canBlockNow: legal.blocking?.blockerInstanceIds.includes(instanceId) ?? false,
    activatableAbilityIds: legal.activatableAbilities
      .filter((ability) => ability.sourceInstanceId === instanceId)
      .map((ability) => ability.abilityId),
    // "Can play cards at all right now" is exactly what the engine reports by
    // offering a pass-phase action during a main phase.
    viewerMayPlayCards: legal.canPassPhase && legal.mulligan === null,
    viewerUnitCount: instance.controller === view.viewerId && me ? me.units.length : null,
    viewerEliminated: legal.eliminated,
    choicePending: legal.pendingChoice !== null || view.awaitingChoiceFrom !== null,
  };
}

/**
 * Turns the context into sentences a player can read.
 *
 * Deliberately takes no card definition. Every sentence here is derived from
 * the seat's own redacted view and the engine's legality report, never from the
 * card's printed data — which is what stops the help text from claiming
 * something the server has not actually offered.
 */
export function contextMessages(context: PublicCardContext): readonly string[] {
  const messages: string[] = [];

  if (context.zone === 'battlefield') {
    if (context.markedDamage > 0 && context.health !== null) {
      messages.push(
        sentence(
          `This has ${numberWord(context.markedDamage)} damage marked on it and is defeated at ${numberWord(
            context.health,
          )}. Damage stays until it is healed`,
        ),
      );
    }
    if (context.summoningSick) {
      messages.push('This unit arrived this turn, so it cannot attack yet.');
    } else if (context.exhausted) {
      messages.push('This unit is exhausted. It readies at the start of its controller’s turn.');
    }
    if (context.canAttackNow) messages.push('You can declare this as an attacker right now.');
    if (context.canBlockNow) messages.push('You can assign this as a blocker right now.');
    if (context.activatableAbilityIds.length > 0) {
      messages.push(
        sentence(
          `You can activate ${plural(context.activatableAbilityIds.length, 'its ability', 'its abilities')} right now`,
        ),
      );
    }
  }

  if (context.zone === 'hand') {
    if (context.playableForEnergy !== null) {
      messages.push(`You can play this now for ${context.playableForEnergy} energy.`);
    } else if (context.viewerEliminated) {
      messages.push('You are out of the match and can no longer play cards.');
    } else if (context.choicePending) {
      messages.push('A choice is being resolved, so no cards can be played until it is answered.');
    } else if (!context.viewerMayPlayCards) {
      messages.push('Cards can only be played during your own Main Phase.');
    } else {
      // "Your battlefield is full" used to be a branch here. It cannot happen
      // any more: the battlefield is unbounded (ruleset update §7).
      // Several rules could each be the reason, and the view does not say which.
      // Guessing is worse than admitting it.
      messages.push(
        'The server is not offering this card as playable right now — you may not be able to afford it, or it may have no legal target.',
      );
    }
  }

  if (context.zone === 'discard') {
    messages.push('This card is in a discard pile. Discard piles are public.');
  }
  if (context.zone === 'commander_zone') {
    messages.push('This Commander stays in the Commander zone for the whole match.');
  }

  return messages;
}
