import { botWeightsSchema, type BotWeights, type BotWeightsInput } from './scoring.js';
import { createHeuristicPilot } from './heuristic.js';
import type { BotPolicy } from './types.js';

/**
 * Values reaching the opponent's face above everything else.
 *
 * Concretely: a point of Attack is worth more than a point of Health, damage
 * pushed through is worth more than a favourable trade, losing a unit in an
 * attack barely registers, and blocking is only worth doing to survive. It will
 * happily race and will lose to a board it could have stabilised against.
 */
export const AGGRESSIVE_VERSION = '1.0.0';

export const AGGRESSIVE_WEIGHTS: BotWeights = Object.freeze(
  botWeightsSchema.parse({
    unitAttack: 1.5,
    unitHealth: 0.4,
    readyBlockerValue: 0.2,
    energyEfficiency: 0.5,
    unspentEnergyPenalty: 0.6,

    faceDamage: 1.6,
    unitDamage: 0.5,
    healing: 0.2,
    removalBonus: 1.0,

    attackFaceDamage: 2.2,
    attackTradeGain: 0.8,
    attackTradeLoss: 0.5,
    attackExhaustCost: 0.1,

    blockDamagePrevented: 0.5,
    blockTradeGain: 0.9,
    blockTradeLoss: 1.4,
    ownHealthValue: 0.2,

    focusLowestHealth: 1.5,
    focusBiggestBoard: 0,

    curveTop: 3,
    openingCheapCard: 1.3,
    openingExpensiveCard: 1.2,
  }),
);

export function createAggressivePilot(overrides: BotWeightsInput = {}): BotPolicy {
  return createHeuristicPilot({
    id: 'aggressive',
    version: AGGRESSIVE_VERSION,
    weights: botWeightsSchema.parse({ ...AGGRESSIVE_WEIGHTS, ...overrides }),
  });
}
