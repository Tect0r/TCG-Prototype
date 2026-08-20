import type { DifficultySelection } from '@tcg/bot-config';
import type { CardDefinition, ChoiceIntent } from '@tcg/card-data';
import { nextInt, type Action, type CardInstanceView, type RngState } from '@tcg/rules-engine';
import {
  candidateActions,
  combatModelOf,
  rankChoiceOptions,
  type RankedOption,
} from './candidates.js';
import { BASELINE_TACTICS, type TacticalProfile } from './tactics.js';
import {
  enablerLeadBonus,
  greedyBlocks,
  reactionEnergyReserve,
  resolveHypotheticalCombat,
  selfSummary,
  strandedReactionValue,
  summaryOf,
  unitBoardValue,
  unitViewsOf,
  cardValue,
  costsValue,
  effectValue,
  effectsValue,
  type BotWeights,
  type HeldReaction,
  type PlayableEntry,
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
  /**
   * How this pilot picks among the candidates it just scored (M09.13).
   *
   * Defaults to `best`, which is the argmax-with-tie-break every pilot in this
   * package has always used, so a caller that does not pass one gets byte-for-
   * byte the decision procedure that shipped. Difficulty is exactly this
   * parameter and nothing else: the candidates, the weights and the scores are
   * identical whichever value it takes.
   */
  readonly selection?: DifficultySelection;
  /**
   * How this pilot enumerates and scores its candidates (M09.14).
   *
   * Defaults to `BASELINE_TACTICS`, whose every refinement is off, so a caller
   * that passes none gets byte-for-byte the scorer that shipped. Difficulty has
   * two halves from M09.14 on and this is the other one: `selection` decides
   * which of the scored candidates is taken, and this decides what the
   * candidates are and what they score.
   */
  readonly tactics?: TacticalProfile;
}

export function createHeuristicPilot(options: HeuristicPilotOptions): BotPolicy {
  const { id, version, weights } = options;
  const mayConcede = options.mayConcede ?? false;
  const selection: DifficultySelection = options.selection ?? { kind: 'best' };
  const tactics: TacticalProfile = options.tactics ?? BASELINE_TACTICS;

  return {
    id,
    version,
    // `selection` is in the exported configuration rather than only in the
    // caller's head, so a result that prints a pilot's config says which
    // difficulty produced it without having to be told separately.
    config: Object.freeze({
      weights: { ...weights },
      mayConcede,
      selection: { ...selection },
      tactics: { ...tactics },
    }),
    decide(observation: BotObservation, rng: RngState): BotDecision {
      const candidates = candidateActions(observation, { weights, mayConcede, tactics });
      if (candidates.length === 0) {
        throw new Error(`Pilot "${id}" was asked to decide with no legal candidate action.`);
      }

      const scores = candidates.map((candidate) => ({
        key: candidate.key,
        score: scoreCandidate(observation, candidate, weights, tactics),
      }));

      const picked = selectCandidate(candidates, scores, weights, selection, rng);
      const chosen = picked.chosen;

      return {
        action: chosen.action,
        rng: picked.rng,
        diagnostics: {
          family: chosen.family,
          chosenKey: chosen.key,
          candidateCount: candidates.length,
          scores,
          brokeTie: picked.brokeTie,
          notes: [...(chosen.notes ?? []), ...picked.notes],
        },
      };
    },
  };
}

/* ---------------------------------------------------------- the selection */

interface Selected {
  readonly chosen: ActionCandidate;
  readonly rng: RngState;
  readonly brokeTie: boolean;
  readonly notes: readonly string[];
}

/**
 * Which of the scored candidates this difficulty takes.
 *
 * Two properties hold for **every** selection here and are what make difficulty
 * safe to vary at all: the answer is always one of `candidates`, which the
 * engine has already declared legal, and no reading outside `scores` is
 * consulted. A difficulty cannot invent a move, cannot see anything a pilot
 * cannot, and cannot decline to play.
 */
function selectCandidate(
  candidates: readonly ActionCandidate[],
  scores: readonly { key: string; score: number }[],
  weights: BotWeights,
  selection: DifficultySelection,
  rng: RngState,
): Selected {
  if (selection.kind === 'bounded_error') {
    const band = boundedErrorBand(candidates, scores, selection);
    // A band of one is not a choice, so it costs no draw — the same rule the
    // tie-break below follows, which keeps a bot's stream a function of the
    // decisions it actually faced.
    if (band.length > 1) {
      const roll = nextInt(rng, band.length);
      const chosen = band[roll.value] as ActionCandidate;
      return {
        chosen,
        rng: roll.state,
        brokeTie: true,
        notes: [`easy: took ${roll.value + 1} of ${band.length} within the band`],
      };
    }
    if (band.length === 1) {
      return { chosen: band[0] as ActionCandidate, rng, brokeTie: false, notes: [] };
    }
    // Nothing finite to be wrong about — every candidate scored `-Infinity`,
    // which in practice means conceding was the only thing on offer. Fall
    // through to the exact `best` path rather than inventing a rule for it.
  }

  let best = -Infinity;
  for (const entry of scores) best = Math.max(best, entry.score);
  const tied = candidates.filter(
    (_, index) => (scores[index]?.score ?? -Infinity) >= best - weights.tieEpsilon,
  );

  if (tied.length > 1) {
    const roll = nextInt(rng, tied.length);
    return {
      chosen: tied[roll.value] as ActionCandidate,
      rng: roll.state,
      brokeTie: true,
      notes: [],
    };
  }
  return { chosen: tied[0] as ActionCandidate, rng, brokeTie: false, notes: [] };
}

/**
 * The candidates a bounded-error difficulty is allowed to pick from.
 *
 * Best first, then by the candidate's own stable key, so the band is a function
 * of the observation alone and two runs enumerate it identically. Three things
 * are excluded before anything is ranked:
 *
 * - a non-finite score, which is how `concede` is priced. That is what makes
 *   "Easy never concedes" a property of this function rather than a promise
 *   made somewhere else;
 * - anything scoring below `best − errorBudget × (best − worst)`, which is the
 *   bound the registry publishes;
 * - anything past `maxBand`, which is what stops a board with thirty plays on it
 *   from turning the bound into a soft uniform sample.
 */
function boundedErrorBand(
  candidates: readonly ActionCandidate[],
  scores: readonly { key: string; score: number }[],
  selection: Extract<DifficultySelection, { kind: 'bounded_error' }>,
): ActionCandidate[] {
  const finite = candidates
    .map((candidate, index) => ({ candidate, score: scores[index]?.score ?? -Infinity }))
    .filter((entry) => Number.isFinite(entry.score));
  if (finite.length === 0) return [];

  let best = -Infinity;
  let worst = Infinity;
  for (const entry of finite) {
    best = Math.max(best, entry.score);
    worst = Math.min(worst, entry.score);
  }
  const floor = best - selection.errorBudget * (best - worst);

  return finite
    .filter((entry) => entry.score >= floor)
    .sort((a, b) => b.score - a.score || a.candidate.key.localeCompare(b.candidate.key))
    .slice(0, selection.maxBand)
    .map((entry) => entry.candidate);
}

/* ------------------------------------------------------------ the scorer */

export function scoreCandidate(
  observation: BotObservation,
  candidate: ActionCandidate,
  weights: BotWeights,
  tactics: TacticalProfile = BASELINE_TACTICS,
): number {
  switch (candidate.action.type) {
    case 'pass_phase':
      return scorePass(observation, weights, tactics);
    case 'play_card':
      return scorePlayCard(observation, candidate.action, weights, tactics);
    case 'activate_ability':
      return scoreActivate(observation, candidate.action, weights);
    case 'declare_attackers':
      return scoreAttack(observation, candidate.action, weights, tactics);
    case 'assign_blockers':
      return scoreBlock(observation, candidate.action, weights, tactics);
    case 'mulligan':
      return scoreMulligan(observation, candidate.action, weights);
    case 'submit_choice':
      return scoreChoice(observation, candidate.action, weights, tactics);
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
  tactics: TacticalProfile,
): number {
  const playable = observation.legal.playableCards.find(
    (card) => card.instanceId === action.instanceId,
  );
  if (!playable) return 0;

  const base = basePlayScore(observation, playable, weights);
  const energy = selfSummary(observation.view).energy;

  let score = base;
  if (tactics.sequencesEnablers) {
    score += enablerLeadBonus(
      { ...playable, baseScore: base },
      playHorizon(observation, weights),
      energy,
      weights,
      observation.database,
    );
  }
  if (tactics.reservesReactionEnergy) {
    // Only ever a subtraction, and only for the Energy this play actually
    // spends: a play that leaves the reserve intact is charged nothing.
    score -= strandedReactionValue(
      heldReactions(observation),
      observation.view,
      energy,
      energy - playable.energyCost,
      weights,
      observation.database,
    );
  }
  return score;
}

/** What a play is worth on its own, before any short-horizon correction. */
function basePlayScore(
  observation: BotObservation,
  playable: BotObservation['legal']['playableCards'][number],
  weights: BotWeights,
): number {
  const definition = observation.database.get(playable.definitionId);
  if (!definition) return 0;
  return (
    cardValue(definition, weights, observation.database) +
    weights.energyEfficiency * playable.energyCost -
    replacedRelicCost(observation, definition, weights) -
    emptySourceZonePenalty(observation, definition, weights)
  );
}

/**
 * Every currently legal play, priced on its own, for the pair search.
 *
 * `basePlayScore` and nothing else, which is what keeps the depth at two: the
 * follower is valued by the scorer that shipped, so the search cannot recurse
 * into itself and a sequence is never scored against another sequence.
 */
function playHorizon(observation: BotObservation, weights: BotWeights): PlayableEntry[] {
  return observation.legal.playableCards.map((playable) => ({
    ...playable,
    baseScore: basePlayScore(observation, playable, weights),
  }));
}

/**
 * The Reactions this seat is holding, read from its own hand.
 *
 * The engine does not list a Reaction among `playableCards` outside a window, so
 * the cost is the printed one. A discount a Relic is granting is deliberately
 * not modelled: it can only make the real cost *lower*, so the reserve this
 * produces is never smaller than the Energy actually needed.
 */
function heldReactions(observation: BotObservation): HeldReaction[] {
  const held: HeldReaction[] = [];
  for (const instanceId of observation.view.hand) {
    const instance = observation.view.instances[instanceId];
    if (!instance) continue;
    const definition = observation.database.get(instance.definitionId);
    if (!definition || definition.type !== 'reaction' || definition.cost === null) continue;
    held.push({ definition, energyCost: definition.cost });
  }
  return held;
}

/**
 * What passing the Main Phase is worth.
 *
 * `passBaseline` less the unspent-Energy penalty, which is the only thing in the
 * scorer pulling Energy out of a pilot at all. With the reserve on, the penalty
 * stops being charged on the points a held Reaction needs — those points are not
 * idle, they are the price of an answer — and is charged on every other point
 * exactly as before.
 */
function scorePass(
  observation: BotObservation,
  weights: BotWeights,
  tactics: TacticalProfile,
): number {
  const energy = selfSummary(observation.view).energy;
  const reserve = tactics.reservesReactionEnergy
    ? reactionEnergyReserve(heldReactions(observation), observation.view, energy)
    : 0;
  return weights.passBaseline - weights.unspentEnergyPenalty * Math.max(0, energy - reserve);
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

/**
 * What a body of our own lost in combat is charged at (M09.14).
 *
 * The baseline prices an exchange with two independent weights — `…TradeGain`
 * for the enemy body, `…TradeLoss` for ours — and that is a style's eagerness to
 * trade rather than an arithmetic identity. On an *even* trade it produces
 * points out of nothing: a vector that values taking an enemy 3/2 at 1.3 and
 * losing its own at 0.9 reads two identical units annihilating each other as a
 * gain, which is exactly the M05.6 finding that blocking "prefers a trade to a
 * block that loses nothing".
 *
 * Under a profile with `ownLossAversion`, the loss coefficient is raised to the
 * style's own gain coefficient whenever it is lower. That makes an even trade
 * worth precisely zero for every weight vector, leaves a style that was already
 * loss-averse completely untouched, and can never *lower* a coefficient — so it
 * cannot make any pilot more willing to throw a body away than it already was.
 */
function lossWeight(gain: number, loss: number, tactics: TacticalProfile): number {
  return tactics.ownLossAversion ? Math.max(gain, loss) : loss;
}

function scoreAttack(
  observation: BotObservation,
  action: Extract<Action, { type: 'declare_attackers' }>,
  weights: BotWeights,
  tactics: TacticalProfile,
): number {
  const { view, database, rulesConfig } = observation;
  if (action.attacks.length === 0) return 0;
  const model = combatModelOf(tactics);
  const attackerLoss = lossWeight(weights.attackTradeGain, weights.attackTradeLoss, tactics);

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
      // Deliberately not `preserve`: this models what the *defender* will do,
      // and assuming an opponent plays the improved block would be a claim about
      // somebody else's difficulty. The combat model is shared because it is
      // arithmetic about the engine rather than a policy.
      model,
    });
    const lookup = new Map(blockers.map((unit) => [unit.instanceId, unit] as const));
    const outcome = resolveHypotheticalCombat(attackers, predicted, lookup, model);

    score += weights.attackFaceDamage * outcome.faceDamage;
    if (outcome.faceDamage >= defender.health) score += weights.lethalBonus;

    for (const instanceId of outcome.blockersLost) {
      const unit = view.instances[instanceId];
      if (unit) score += weights.attackTradeGain * unitBoardValue(unit, weights, database);
    }
    for (const instanceId of outcome.attackersLost) {
      const unit = view.instances[instanceId];
      if (unit) score -= attackerLoss * unitBoardValue(unit, weights, database);
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
  tactics: TacticalProfile,
): number {
  const { view, database } = observation;
  const me = selfSummary(view);
  const model = combatModelOf(tactics);
  const blockerLoss = lossWeight(weights.blockTradeGain, weights.blockTradeLoss, tactics);

  const incoming = view.combat.attacks
    .filter((attack) => attack.defenderPlayerId === me.playerId)
    .map((attack) => view.instances[attack.attackerInstanceId])
    .filter((unit): unit is CardInstanceView => unit !== undefined);

  const baselineFace = incoming.reduce((sum, unit) => sum + unit.attack, 0);
  const blockerLookup = new Map(
    unitViewsOf(view, me.playerId).map((unit) => [unit.instanceId, unit] as const),
  );
  const outcome = resolveHypotheticalCombat(incoming, action.blocks, blockerLookup, model);
  const prevented = baselineFace - outcome.faceDamage;

  let score = weights.blockDamagePrevented * prevented;

  for (const instanceId of outcome.attackersLost) {
    const unit = view.instances[instanceId];
    if (unit) score += weights.blockTradeGain * unitBoardValue(unit, weights, database);
  }
  for (const instanceId of outcome.blockersLost) {
    const unit = view.instances[instanceId];
    if (unit) score -= blockerLoss * unitBoardValue(unit, weights, database);
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
 * Which way an option's value points for the seat being asked (M05.3).
 *
 * `+1` means "name your best", `-1` means "name your worst", `0` means the
 * instruction does nothing to the thing selected that can be called good or bad.
 * Two facts decide it and both are given: what the resolving instruction does to
 * whatever is selected, and whether the option belongs to somebody else.
 *
 * This replaces a scan of the source card's entire effect list for anything that
 * looked hostile. That scan was wrong in one specific, invisible way: a card that
 * removed one unit and buffed another was hostile *for both of its questions*, so
 * a pilot handed the buff picked its worst unit — and a match result cannot show
 * you that. It also required a hard-coded list of "always costly" choice reasons,
 * which is now just `intent: 'detriment'` on an option the chooser owns.
 */
function optionDirection(intent: ChoiceIntent, enemy: boolean): number {
  const valence = intent === 'benefit' ? 1 : intent === 'detriment' ? -1 : 0;
  return valence * (enemy ? -1 : 1);
}

function scoreChoice(
  observation: BotObservation,
  action: Extract<Action, { type: 'submit_choice' }>,
  weights: BotWeights,
  tactics: TacticalProfile,
): number {
  const choice = observation.legal.pendingChoice;
  if (!choice || choice.id !== action.choiceId) return 0;

  // The same ranking `choiceCandidates` enumerated from, and the same profile:
  // a scorer that valued the options differently from the enumerator would
  // silently score a selection it never built.
  const ranked = rankChoiceOptions(observation, choice, weights, tactics);
  const byId = new Map(ranked.map((entry) => [entry.id, entry] as const));
  const intent = choice.provenance.intent;

  if (choice.ordered) {
    // Reordering puts cards back on top of a deck: the earlier the position, the
    // sooner it is drawn, so weight by position. An early position is a benefit
    // to whoever owns the zone, which is what makes ordering somebody else's
    // deck come out the right way round without a rule of its own.
    const n = action.selectedIds.length;
    return action.selectedIds.reduce((sum, id, index) => {
      const entry = byId.get(id);
      if (!entry) return sum;
      return sum + optionDirection(intent, entry.enemy) * entry.value * (n - index);
    }, 0);
  }

  // A confirm has no entity to be for or against. "yes" is not a card that could
  // belong to an opponent, so there is no option for the direction above to read
  // — which is why the engine records `targetRelation: 'none'` on exactly these.
  if (choice.type === 'confirm') {
    return action.selectedIds.includes('yes') ? weights.confirmYes : 0;
  }

  return action.selectedIds.reduce((sum, id) => {
    const entry: RankedOption | undefined = byId.get(id);
    if (!entry) return sum;
    return sum + optionDirection(intent, entry.enemy) * entry.value;
  }, 0);
}
