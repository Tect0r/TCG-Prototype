import { botWeightsSchema, type BotWeights, type BotWeightsInput } from './scoring.js';
import { createHeuristicPilot } from './heuristic.js';
import type { BotPolicy } from './types.js';

/**
 * Values staying alive and holding the board.
 *
 * Concretely: Health outweighs Attack, keeping a ready blocker is worth real
 * points, an attack that loses a unit is priced dearly, blocking is priced
 * generously, and its own remaining Health is treated as a resource rather than
 * a buffer to spend. It will stall matches it could have closed.
 */
/** 1.1.0 (M05.3): choices are answered from the resolving instruction's intent. */
export const DEFENSIVE_VERSION = '1.1.0';

export const DEFENSIVE_WEIGHTS: BotWeights = Object.freeze(
  botWeightsSchema.parse({
    unitAttack: 0.6,
    unitHealth: 1.3,
    readyBlockerValue: 1.4,
    energyEfficiency: 0.3,
    unspentEnergyPenalty: 0.25,

    faceDamage: 0.7,
    unitDamage: 1.0,
    healing: 1.4,
    removalBonus: 2.2,
    preventionValue: 1.0,

    attackFaceDamage: 0.8,
    attackTradeGain: 1.2,
    attackTradeLoss: 2.4,
    attackExhaustCost: 1.2,

    blockDamagePrevented: 1.8,
    blockTradeGain: 1.3,
    blockTradeLoss: 0.9,
    ownHealthValue: 1.2,
    survivalUrgency: 80,

    focusLowestHealth: 0.4,
    focusBiggestBoard: 0.8,

    curveTop: 4,
    openingCheapCard: 1.0,
    openingExpensiveCard: 0.6,
  }),
);

export function createDefensivePilot(overrides: BotWeightsInput = {}): BotPolicy {
  return createHeuristicPilot({
    id: 'defensive',
    version: DEFENSIVE_VERSION,
    weights: botWeightsSchema.parse({ ...DEFENSIVE_WEIGHTS, ...overrides }),
  });
}
