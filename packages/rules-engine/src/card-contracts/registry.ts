import type { CardId } from '@tcg/card-data';
import type { CardContract } from './harness.js';
import { CONTROL_CONTRACTS } from './contracts-control.js';
import { GOBLIN_CONTRACTS } from './contracts-goblin.js';
import { GUARDIAN_CONTRACTS } from './contracts-guardian.js';
import { NEUTRAL_CONTRACTS } from './contracts-neutral.js';
import { SACRIFICE_CONTRACTS } from './contracts-sacrifice.js';
import { TOKEN_CONTRACTS } from './contracts-tokens.js';

/**
 * One executable happy-path behaviour contract per Wave 1 card (M02.6).
 *
 * The point of the registry is the **gap it cannot hide**: `registry.test.ts`
 * compares its keys against every card in `CONTRACT_SET_ID` and fails when the
 * two disagree, so a newly authored or newly implemented card arrives with no
 * behaviour test and the suite says so by name. That is the property the
 * milestone asks for; the individual contracts are what make it worth having.
 *
 * A contract is deliberately *one* claim: the card's printed headline, driven
 * through the real engine from a real action. It is not a substitute for the
 * focused mechanic suites — `delayed.test.ts`, `replacement.test.ts` and the
 * rest still own the edge cases — and no contract should grow a second
 * scenario. When a card needs more coverage than one claim, that coverage
 * belongs in the suite for the mechanic it stresses.
 */
export const CONTRACT_SET_ID = 'precon_wave_1';

export const CARD_CONTRACTS: Record<CardId, CardContract> = {
  ...CONTROL_CONTRACTS,
  ...GOBLIN_CONTRACTS,
  ...GUARDIAN_CONTRACTS,
  ...NEUTRAL_CONTRACTS,
  ...SACRIFICE_CONTRACTS,
  ...TOKEN_CONTRACTS,
};
