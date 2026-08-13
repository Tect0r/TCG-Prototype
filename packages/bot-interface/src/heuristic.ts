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
  costsValue,
  effectValue,
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
    case 'play_reaction':
      return scoreReaction(observation, candidate.action, weights);
    case 'pass_reaction':
      // The baseline a Reaction has to beat. Deliberately above zero: holding a
      // Reaction for a better window is usually right, and a pilot that spent
      // one on the first window it saw would misprice every card in the class.
      return weights.passBaseline;
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
    weights.energyEfficiency * playable.energyCost -
    replacedRelicCost(observation, definition, weights) -
    emptySourceZonePenalty(observation, definition, weights)
  );
}

/**
 * Takes back the value of an instruction that pulls a card out of our discard
 * pile when the pile is empty.
 *
 * `cardValue` is computed from the definition alone, so a five-cost "return up
 * to two Units from your discard pile" is priced as two cards gained even on
 * turn three, when there is nothing to return and the card does exactly nothing.
 * The pilot can see its own discard pile — it is public — so this is a fact it
 * is entitled to read rather than a hidden-information shortcut.
 *
 * Deliberately coarse: it asks whether the zone is empty, not whether anything
 * in it matches the selector's filter, and it only covers the discard pile,
 * which is the only source zone a Wave 1 card names and the only one the view
 * lists card by card. A pilot that plays a reanimation spell for one legal
 * target out of a filtered pile is making a defensible play; one that casts it
 * into an empty pile is not. Pricing the filtered pool properly is pilot
 * quality work and belongs to M05, not here.
 */
function emptySourceZonePenalty(
  observation: BotObservation,
  definition: CardDefinition,
  weights: BotWeights,
): number {
  if (selfSummary(observation.view).discard.length > 0) return 0;

  let penalty = 0;
  for (const effect of definition.effects) {
    if (effect.type !== 'move_card') continue;
    if (effect.target.kind !== 'entity') continue;
    const selector = effect.target.selector;
    if (selector.zone !== 'discard' || selector.controller !== 'self') continue;
    penalty += effectsValue([effect], weights, observation.database);
  }
  return penalty;
}

/**
 * What playing a Reaction into the open window is worth.
 *
 * Priced like any other card, plus one thing no ordinary card has: a Reaction
 * that **counters** is worth what it denies, and what it denies is only knowable
 * from the window. The engine names the Spell being answered, so the pilot can
 * value countering a five-cost bomb above countering a cantrip instead of
 * treating every counter as interchangeable.
 *
 * This is an approximate valuation and is labelled as one: a pilot cannot see
 * whether holding the Reaction for a later window would be better, because it
 * cannot see the future. Reaction-heavy decks are exactly the case readiness
 * gate F4 says needs archetype-aware pilots before a balance conclusion is
 * drawn from them.
 */
function scoreReaction(
  observation: BotObservation,
  action: Extract<Action, { type: 'play_reaction' }>,
  weights: BotWeights,
): number {
  const window = observation.legal.reaction;
  const playable = window?.playableCards.find((card) => card.instanceId === action.instanceId);
  const definition = playable ? observation.database.get(playable.definitionId) : undefined;
  if (!definition || !playable || !window) return 0;

  let score = cardValue(definition, weights, observation.database);
  score += weights.energyEfficiency * playable.energyCost;

  const counters = definition.effects.filter((effect) => effect.type === 'counter');
  if (counters.length > 0) {
    // `cardValue` now prices a counter in the abstract, so that a Reaction whose
    // whole text is a counter is not mulliganed away as a blank card (M05.2).
    // Here the window names the card actually on the stack, so the estimate is
    // taken back off and replaced by the truth rather than stacked on top of it.
    score -= counters.reduce(
      (sum, effect) =>
        sum + effectValue(effect, weights, observation.database, definition.delayedAbilities),
      0,
    );

    const subjectId = window.subjectInstanceId;
    const subject = subjectId ? observation.view.instances[subjectId] : undefined;
    const subjectDefinition = subject ? observation.database.get(subject.definitionId) : undefined;
    // Countering is worth roughly what the answered card is worth. Without a
    // subject — a counter played into a combat window, where it will fizzle —
    // it is worth nothing at all, which is what stops a pilot burning one.
    score += subjectDefinition
      ? cardValue(subjectDefinition, weights, observation.database)
      : -weights.passBaseline;
  }

  return score;
}

/**
 * What playing this card costs in relics you already control.
 *
 * A player may hold only one active relic; playing another *replaces* it rather
 * than being refused (ruleset update §12). That makes a second relic a genuine
 * trade, and a pilot that ignored it would happily overwrite a strong relic with
 * a weak one for the pleasure of spending energy. Zero for every other card
 * type, and zero when there is room.
 */
function replacedRelicCost(
  observation: BotObservation,
  definition: CardDefinition,
  weights: BotWeights,
): number {
  if (definition.type !== 'relic') return 0;
  const mine = selfSummary(observation.view).relics;
  const surplus = mine.length - observation.rulesConfig.relicSlots + 1;
  if (surplus <= 0) return 0;

  // The engine replaces the oldest first, so value exactly those.
  return mine.slice(0, surplus).reduce((sum, instanceId) => {
    const instance = observation.view.instances[instanceId];
    const replaced = instance ? observation.database.get(instance.definitionId) : undefined;
    return replaced ? sum + cardValue(replaced, weights, observation.database) : sum;
  }, 0);
}

function scoreActivate(
  observation: BotObservation,
  action: Extract<Action, { type: 'activate_ability' }>,
  weights: BotWeights,
): number {
  const instance = observation.view.instances[action.sourceInstanceId];
  const definition = instance ? observation.database.get(instance.definitionId) : undefined;
  const ability = definition?.activatedAbilities.find((entry) => entry.id === action.abilityId);
  if (!definition || !ability) return 0;

  // The same `costsValue` a played card's additional costs go through, so an
  // activation and a play price a sacrifice identically (M05.2).
  return (
    effectsValue(ability.effects, weights, observation.database, definition.delayedAbilities) +
    costsValue(ability.costs, weights)
  );
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

  // Blocking exhausts the blocker (ruleset update §8), so a unit that survives
  // the block is still spent: it cannot attack on this player's own next turn.
  // Without this the pilot treats defence as free and chump-blocks with bodies
  // it wanted to swing with. A blocker that dies is already priced by
  // `blockTradeLoss`, so only the survivors are charged here.
  const lost = new Set(outcome.blockersLost);
  for (const block of action.blocks) {
    if (lost.has(block.blockerInstanceId)) continue;
    const unit = view.instances[block.blockerInstanceId];
    if (unit && !unit.exhausted) score -= weights.readyBlockerValue;
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

  // A confirm has no entity to be for or against. "yes" is not a card that
  // could belong to an opponent, so the enemy/hostile reasoning below would be
  // reading a ranked option that means nothing — and, because the source of an
  // optional step is routinely a removal card, it would score it hostile and
  // decline every "you may".
  if (choice.type === 'confirm') {
    return action.selectedIds.includes('yes') ? weights.confirmYes : 0;
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
