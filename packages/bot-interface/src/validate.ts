import type { Action, LegalActions, RulesConfig } from '@tcg/rules-engine';

/**
 * Checks a pilot's returned action against the engine's own legality
 * description, *before* it is submitted.
 *
 * The runner does this so an illegal bot decision is caught and recorded as a
 * pilot failure rather than reaching `applyAction` and coming back as an
 * indistinguishable engine error (CLAUDE.md §13.3, §13.5). It is a subset check
 * against `LegalActions`, never an independent re-derivation of the rules: the
 * engine remains the only thing that decides what is legal.
 */

export interface ActionCheck {
  readonly ok: boolean;
  readonly reason: string;
}

const OK: ActionCheck = { ok: true, reason: '' };
const fail = (reason: string): ActionCheck => ({ ok: false, reason });

export function checkActionOffered(
  legal: LegalActions,
  action: Action,
  config: RulesConfig,
): ActionCheck {
  if (action.playerId !== legal.playerId) {
    return fail(`action is for "${action.playerId}" but this seat is "${legal.playerId}"`);
  }
  if (legal.eliminated) return fail('seat is eliminated and may only spectate');

  switch (action.type) {
    case 'server_timeout':
      return fail('server_timeout is server-originated and is never a pilot decision');

    case 'concede':
      return legal.canConcede ? OK : fail('conceding is not available');

    case 'mulligan': {
      if (!legal.mulligan) return fail('no mulligan decision is pending');
      if (action.returnInstanceIds.length > legal.mulligan.maxReturn) {
        return fail(`may return at most ${legal.mulligan.maxReturn} cards`);
      }
      if (new Set(action.returnInstanceIds).size !== action.returnInstanceIds.length) {
        return fail('the same card was returned twice');
      }
      for (const instanceId of action.returnInstanceIds) {
        if (!legal.mulligan.handInstanceIds.includes(instanceId)) {
          return fail(`"${instanceId}" is not in the opening hand`);
        }
      }
      return OK;
    }

    case 'play_card': {
      const card = legal.playableCards.find((entry) => entry.instanceId === action.instanceId);
      if (!card) return fail(`"${action.instanceId}" is not playable right now`);
      // Nothing else to check: with an unbounded battlefield, "is this card
      // playable" is the whole question (ruleset update §7).
      return OK;
    }

    case 'activate_ability': {
      const ability = legal.activatableAbilities.find(
        (entry) =>
          entry.sourceInstanceId === action.sourceInstanceId &&
          entry.abilityId === action.abilityId,
      );
      return ability ? OK : fail(`ability "${action.abilityId}" is not activatable right now`);
    }

    case 'pass_phase':
      return legal.canPassPhase ? OK : fail('this seat cannot pass a phase right now');

    case 'pass_reaction':
      // Declining is legal whenever this seat has been offered priority, and
      // only then: a window is not something a seat can opt into.
      return legal.reaction?.canPass === true
        ? OK
        : fail('this seat does not hold priority in a Reaction window');

    case 'play_reaction': {
      if (!legal.reaction) return fail('no Reaction window is open for this seat');
      const card = legal.reaction.playableCards.find(
        (entry) => entry.instanceId === action.instanceId,
      );
      // The engine has already applied the timing window, the subject filter
      // and the discount, so membership of this list is the whole question.
      return card ? OK : fail(`"${action.instanceId}" cannot be played into this window`);
    }

    case 'declare_attackers': {
      if (!legal.attacking) return fail('this seat is not declaring attackers');
      const seen = new Set<string>();
      for (const attack of action.attacks) {
        if (seen.has(attack.attackerInstanceId)) {
          return fail(`"${attack.attackerInstanceId}" was declared twice`);
        }
        seen.add(attack.attackerInstanceId);
        if (!legal.attacking.legalAttackers.includes(attack.attackerInstanceId)) {
          return fail(`"${attack.attackerInstanceId}" cannot attack`);
        }
        if (!legal.attacking.legalDefenders.includes(attack.defenderPlayerId)) {
          return fail(`"${attack.defenderPlayerId}" is not a legal defender`);
        }
      }
      return OK;
    }

    case 'assign_blockers': {
      if (!legal.blocking) return fail('this seat is not assigning blockers');
      const usedBlockers = new Set<string>();
      const perAttacker = new Map<string, number>();
      for (const block of action.blocks) {
        if (usedBlockers.has(block.blockerInstanceId)) {
          return fail(`"${block.blockerInstanceId}" was assigned to two attackers`);
        }
        usedBlockers.add(block.blockerInstanceId);
        if (!legal.blocking.blockerInstanceIds.includes(block.blockerInstanceId)) {
          return fail(`"${block.blockerInstanceId}" cannot block`);
        }
        if (!legal.blocking.attackerInstanceIds.includes(block.attackerInstanceId)) {
          return fail(
            `"${block.attackerInstanceId}" is not a blockable attacker aimed at this seat`,
          );
        }
        const count = (perAttacker.get(block.attackerInstanceId) ?? 0) + 1;
        perAttacker.set(block.attackerInstanceId, count);
        if (count > config.blockersPerAttacker) {
          return fail(`more than ${config.blockersPerAttacker} blockers on one attacker`);
        }
      }
      return OK;
    }

    case 'submit_choice': {
      const choice = legal.pendingChoice;
      if (!choice) return fail('no choice is pending for this seat');
      if (choice.id !== action.choiceId) return fail('that is not the pending choice');
      if (new Set(action.selectedIds).size !== action.selectedIds.length) {
        return fail('the same option was selected twice');
      }
      for (const id of action.selectedIds) {
        if (!choice.validEntityIds.includes(id)) return fail(`"${id}" is not a legal option`);
      }
      if (choice.ordered) {
        return action.selectedIds.length === choice.validEntityIds.length
          ? OK
          : fail('an ordering must include every option exactly once');
      }
      if (
        action.selectedIds.length < choice.minimum ||
        action.selectedIds.length > choice.maximum
      ) {
        return fail(
          `selection must contain between ${choice.minimum} and ${choice.maximum} options`,
        );
      }
      return OK;
    }

    default:
      return fail('unrecognised action type');
  }
}
