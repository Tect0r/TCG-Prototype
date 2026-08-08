import { botWeightsSchema, type BotWeights, type BotWeightsInput } from './scoring.js';
import { createHeuristicPilot } from './heuristic.js';
import type { BotPolicy } from './types.js';

/**
 * Values cards, energy and favourable exchanges.
 *
 * Concretely: drawing is worth about as much as a mid-sized body, unspent energy
 * hurts, trades are priced symmetrically so it takes the ones it wins and
 * declines the ones it loses, and persistent sources of advantage — relics,
 * continuous effects, repeatable abilities — are worth more than a one-off swing.
 * It is the closest thing here to a competent generalist, which is exactly why
 * it must never be the only pilot an experiment runs.
 */
export const VALUE_VERSION = '1.0.0';

export const VALUE_WEIGHTS: BotWeights = Object.freeze(
  botWeightsSchema.parse({
    unitAttack: 1.0,
    unitHealth: 1.0,
    keywordBonus: 0.9,
    relicBase: 2.2,
    readyBlockerValue: 0.9,
    energyEfficiency: 0.6,
    unspentEnergyPenalty: 0.7,

    cardDraw: 2.2,
    discardCard: 1.6,
    faceDamage: 0.9,
    unitDamage: 0.9,
    healing: 0.8,
    removalBonus: 1.9,
    tokenValue: 1.1,
    bounceValue: 1.4,

    attackFaceDamage: 1.1,
    attackTradeGain: 1.5,
    attackTradeLoss: 1.5,
    attackExhaustCost: 0.5,

    blockDamagePrevented: 1.1,
    blockTradeGain: 1.5,
    blockTradeLoss: 1.5,
    ownHealthValue: 0.7,

    focusLowestHealth: 0.8,
    focusBiggestBoard: 0.5,

    curveTop: 3,
    openingCheapCard: 1.1,
    openingExpensiveCard: 0.8,
    redrawPenalty: 0.4,
  }),
);

export function createValuePilot(overrides: BotWeightsInput = {}): BotPolicy {
  return createHeuristicPilot({
    id: 'value',
    version: VALUE_VERSION,
    weights: botWeightsSchema.parse({ ...VALUE_WEIGHTS, ...overrides }),
  });
}
