import type { CardDefinition, EffectDefinition } from '@tcg/card-data';
import { nextInt, type Action, type CardInstanceView, type RngState } from '@tcg/rules-engine';
import { candidateActions, rankChoiceOptions, type RankedOption } from './candidates.js';
import {
  greedyBlocks,
  resolveHypotheticalCombat,
  selfSummary,
  summaryOf,
  unitBoardValue,
  unitViewsOf,
  cardValue,
  effectsValue,
  type BotWeights,
} from './scoring.js';
import type { ActionCandidate, BotDecision, BotObservation, BotPolicy } from './types.js';

/**
 * One decision procedure, four pilots.
 *
 * Every heuristic pilot in this package is this scorer driven by a different
 * weight vector. That is deliberate: it means "aggressive beat defensive" is a
 * statement about a published set of numbers rather than about two unrelated
 * lumps of code, and it makes the heuristic-weight perturbation robustness check
 * required by CLAUDE.md §13.11 a one-line experiment.
 */

export interface HeuristicPilotOptions {
  readonly id: string;
  readonly version: string;
  readonly weights: BotWeights;
  /** Experiment policy: a pilot never resigns unless this is switched on. */
  readonly mayConcede?: boolean;
}

export function createHeuristicPilot(options: HeuristicPilotOptions): BotPolicy {
  const { id, version, weights } = options;
  const mayConcede = options.mayConcede ?? false;

  return {
    id,
    version,
    config: Object.freeze({ weights: { ...weights }, mayConcede }),
    decide(observation: BotObservation, rng: RngState): BotDecision {
      const candidates = candidateActions(observation, { weights, mayConcede });
      if (candidates.length === 0) {
        throw new Error(`Pilot "${id}" was asked to decide with no legal candidate action.`);
      }

      const scores = candidates.map((candidate) => ({
        key: candidate.key,
        score: scoreCandidate(observation, candidate, weights),
      }));

      let best = -Infinity;
      for (const entry of scores) best = Math.max(best, entry.score);
      const tied = candidates.filter(
        (_, index) => (scores[index]?.score ?? -Infinity) >= best - weights.tieEpsilon,
      );

      let chosen = tied[0] as ActionCandidate;
      let nextRng = rng;
      let brokeTie = false;
      if (tied.length > 1) {
        const roll = nextInt(rng, tied.length);
        nextRng = roll.state;
        chosen = tied[roll.value] as ActionCandidate;
        brokeTie = true;
      }

      return {
        action: chosen.action,
        rng: nextRng,
        diagnostics: {
          family: chosen.family,
          chosenKey: chosen.key,
          candidateCount: candidates.length,
          scores,
          brokeTie,
          notes: [...(chosen.notes ?? [])],
        },
      };
    },
  };
}

/* ------------------------------------------------------------ the scorer */

export function scoreCandidate(
  observation: BotObservation,
  candidate: ActionCandidate,
  weights: BotWeights,
): number {
  switch (candidate.action.type) {
    case 'pass_phase':
      return (
        weights.passBaseline - weights.unspentEnergyPenalty * selfSummary(observation.view).energy
      );
    case 'play_card':
      return scorePlayCard(observation, candidate.action, weights);
    case 'activate_ability':
      return scoreActivate(observation, candidate.action, weights);
    case 'declare_attackers':
      return scoreAttack(observation, candidate.action, weights);
    case 'assign_blockers':
      return scoreBlock(observation, candidate.action, weights);
    case 'mulligan':
      return scoreMulligan(observation, candidate.action, weights);
    case 'submit_choice':
      return scoreChoice(observation, candidate.action, weights);
    case 'concede':
      // Only ever reachable when conceding is the sole candidate.
      return -Infinity;
    default:
      return 0;
  }
}

function scorePlayCard(
  observation: BotObservation,
  action: Extract<Action, { type: 'play_card' }>,
  weights: BotWeights,
): number {
  const playable = observation.legal.playableCards.find(
    (card) => card.instanceId === action.instanceId,
  );
  const definition = playable ? observation.database.get(playable.definitionId) : undefined;
  if (!definition || !playable) return 0;

  return (
    cardValue(definition, weights, observation.database) +
    weights.energyEfficiency * playable.energyCost
  );
}

function scoreActivate(
  observation: BotObservation,
  action: Extract<Action, { type: 'activate_ability' }>,
  weights: BotWeights,
): number {
  const instance = observation.view.instances[action.sourceInstanceId];
  const definition = instance ? observation.database.get(instance.definitionId) : undefined;
  const ability = definition?.activatedAbilities.find((entry) => entry.id === action.abilityId);
  if (!ability) return 0;

  const costPenalty = ability.costs.reduce((sum, cost) => {
    switch (cost.type) {
      case 'energy':
        return sum - weights.energyEfficiency * cost.amount * 0.2;
      case 'discard':
        return sum - weights.discardCard * cost.amount;
      case 'sacrifice':
        return sum - weights.removalBonus * cost.amount;
      case 'exhaust_source':
        return sum - weights.readyBlockerValue;
      default:
        return sum;
    }
  }, 0);

  return effectsValue(ability.effects, weights, observation.database) + costPenalty;
}

function scoreAttack(
  observation: BotObservation,
  action: Extract<Action, { type: 'declare_attackers' }>,
  weights: BotWeights,
): number {
  const { view, database, rulesConfig } = observation;
  if (action.attacks.length === 0) return 0;

  const byDefender = new Map<string, CardInstanceView[]>();
  for (const attack of action.attacks) {
    const unit = view.instances[attack.attackerInstanceId];
    if (!unit) continue;
    const bucket = byDefender.get(attack.defenderPlayerId) ?? [];
    bucket.push(unit);
    byDefender.set(attack.defenderPlayerId, bucket);
  }

  let score = 0;
  for (const [defenderPlayerId, attackers] of [...byDefender].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const defender = summaryOf(view, defenderPlayerId);
    if (!defender) continue;
    const blockers = unitViewsOf(view, defenderPlayerId).filter(
      (unit) => rulesConfig.exhaustedUnitsMayBlock || !unit.exhausted,
    );

    const rawDamage = attackers.reduce((sum, unit) => sum + unit.attack, 0);
    // Model the defender as blocking to survive when the attack is lethal, and
    // blocking only for value otherwise. Same model both sides of combat use.
    const facingLethal = rawDamage >= defender.health;
    const predicted = greedyBlocks(attackers, blockers, {
      chumpBlock: facingLethal,
      valueOnly: !facingLethal,
    });
    const lookup = new Map(blockers.map((unit) => [unit.instanceId, unit] as const));
    const outcome = resolveHypotheticalCombat(attackers, predicted, lookup);

    score += weights.attackFaceDamage * outcome.faceDamage;
    if (outcome.faceDamage >= defender.health) score += weights.lethalBonus;

    for (const instanceId of outcome.blockersLost) {
      const unit = view.instances[instanceId];
      if (unit) score += weights.attackTradeGain * unitBoardValue(unit, weights, database);
    }
    for (const instanceId of outcome.attackersLost) {
      const unit = view.instances[instanceId];
      if (unit) score -= weights.attackTradeLoss * unitBoardValue(unit, weights, database);
    }
  }

  // Attacking exhausts. That only costs anything when the ruleset says an
  // exhausted unit cannot block, so the penalty reads the configuration rather
  // than assuming a rule that is still provisional (CLAUDE.md §4).
  if (!rulesConfig.exhaustedUnitsMayBlock) {
    score -= weights.attackExhaustCost * action.attacks.length;
  }

  return score;
}

function scoreBlock(
  observation: BotObservation,
  action: Extract<Action, { type: 'assign_blockers' }>,
  weights: BotWeights,
): number {
  const { view, database } = observation;
  const me = selfSummary(view);

  const incoming = view.combat.attacks
    .filter((attack) => attack.defenderPlayerId === me.playerId)
    .map((attack) => view.instances[attack.attackerInstanceId])
    .filter((unit): unit is CardInstanceView => unit !== undefined);

  const baselineFace = incoming.reduce((sum, unit) => sum + unit.attack, 0);
  const blockerLookup = new Map(
    unitViewsOf(view, me.playerId).map((unit) => [unit.instanceId, unit] as const),
  );
  const outcome = resolveHypotheticalCombat(incoming, action.blocks, blockerLookup);
  const prevented = baselineFace - outcome.faceDamage;

  let score = weights.blockDamagePrevented * prevented;

  for (const instanceId of outcome.attackersLost) {
    const unit = view.instances[instanceId];
    if (unit) score += weights.blockTradeGain * unitBoardValue(unit, weights, database);
  }
  for (const instanceId of outcome.blockersLost) {
    const unit = view.instances[instanceId];
    if (unit) score -= weights.blockTradeLoss * unitBoardValue(unit, weights, database);
  }

  // Surviving beats every trade. The bonus is capped at the damage that
  // actually had to be stopped, so it does not reward over-blocking.
  if (baselineFace >= me.health) {
    const needed = baselineFace - me.health + 1;
    score += weights.survivalUrgency * Math.max(0, Math.min(prevented, needed));
  }
  score += weights.ownHealthValue * -outcome.faceDamage;

  return score;
}

function scoreMulligan(
  observation: BotObservation,
  action: Extract<Action, { type: 'mulligan' }>,
  weights: BotWeights,
): number {
  const returned = new Set(action.returnInstanceIds);
  const hand = observation.legal.mulligan?.handInstanceIds ?? [];

  let score = 0;
  for (const instanceId of hand) {
    if (returned.has(instanceId)) continue;
    const instance = observation.view.instances[instanceId];
    const definition = instance ? observation.database.get(instance.definitionId) : undefined;
    if (!definition) continue;
    const cost = definition.cost ?? 0;
    score += cost <= weights.curveTop ? weights.openingCheapCard : -weights.openingExpensiveCard;
    score += cardValue(definition, weights, observation.database) * 0.1;
  }
  // A returned card is replaced by an unknown one, valued at neutral, minus the
  // cost of the redraw itself. Returning a card the pilot values negatively is
  // therefore a gain; returning a good one is not.
  score -= weights.redrawPenalty * action.returnInstanceIds.length;
  return score;
}

/**
 * Effect types that make being selected bad for the selected entity. Used to
 * work out whether a `select_units` choice is "pick their best" or "pick my
 * worst" without keying off any card ID.
 */
const HOSTILE_EFFECTS: ReadonlySet<EffectDefinition['type']> = new Set([
  'destroy',
  'sacrifice',
  'deal_damage',
  'exhaust',
  'return_to_hand',
  'discard',
  'move_card',
  'remove_keyword',
]);

function sourceIsHostile(definition: CardDefinition | undefined): boolean {
  if (!definition) return true;
  const effects = [
    ...definition.effects,
    ...definition.abilities.flatMap((ability) => ability.effects),
    ...definition.activatedAbilities.flatMap((ability) => ability.effects),
  ];
  return effects.some((effect) => HOSTILE_EFFECTS.has(effect.type));
}

function scoreChoice(
  observation: BotObservation,
  action: Extract<Action, { type: 'submit_choice' }>,
  weights: BotWeights,
): number {
  const choice = observation.legal.pendingChoice;
  if (!choice || choice.id !== action.choiceId) return 0;

  const ranked = rankChoiceOptions(observation, choice, weights);
  const byId = new Map(ranked.map((entry) => [entry.id, entry] as const));

  if (choice.ordered) {
    // Reordering puts cards back on top of a deck: the earlier the position, the
    // sooner it is drawn, so weight by position.
    const n = action.selectedIds.length;
    return action.selectedIds.reduce((sum, id, index) => {
      const entry = byId.get(id);
      return sum + (entry ? entry.value * (n - index) : 0);
    }, 0);
  }

  const sourceDefinition = choice.sourceInstanceId
    ? observation.database.get(
        observation.view.instances[choice.sourceInstanceId]?.definitionId ?? '',
      )
    : undefined;

  // Reasons whose selection is always a cost to the chooser, whatever asked.
  const alwaysCostly =
    choice.reason === 'discard_effect' ||
    choice.reason === 'discard_cost' ||
    choice.reason === 'hand_size_discard' ||
    choice.reason === 'sacrifice_cost';

  const hostile = alwaysCostly || sourceIsHostile(sourceDefinition);

  return action.selectedIds.reduce((sum, id) => {
    const entry: RankedOption | undefined = byId.get(id);
    if (!entry) return sum;
    if (alwaysCostly) return sum - entry.value;
    if (entry.enemy) return sum + (hostile ? entry.value : -entry.value);
    return sum + (hostile ? -entry.value : entry.value);
  }, 0);
}
