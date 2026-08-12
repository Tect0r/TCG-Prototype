import { describe, expect, it } from 'vitest';
import { loadBundledCardData } from '@tcg/card-data';
import { ContractTable } from './harness.js';
import { CARD_CONTRACTS, CONTRACT_SET_ID } from './registry.js';

/**
 * Every Wave 1 card, driven once through the engine (M02.6).
 *
 * Two things are under test and they are separate on purpose. The coverage
 * guard proves the registry still describes the whole set — it is what fails
 * when somebody adds a card and no behaviour test with it. The per-card cases
 * prove each contract's claim is still true of the engine.
 */

const bundle = loadBundledCardData();
const set = bundle.sets.find((entry) => entry.setId === CONTRACT_SET_ID);
if (!set) throw new Error(`No set "${CONTRACT_SET_ID}" in the bundled content.`);

const cardIds = [...set.cards.map((card) => card.id)].sort();
const contractIds = Object.keys(CARD_CONTRACTS).sort();

describe('coverage', () => {
  it('has a contract for every card in the set', () => {
    const missing = cardIds.filter((id) => CARD_CONTRACTS[id] === undefined);
    expect(missing, 'cards with no behaviour contract').toEqual([]);
  });

  it('has no contract for a card the set does not contain', () => {
    const known = new Set(cardIds);
    expect(contractIds.filter((id) => !known.has(id))).toEqual([]);
  });

  it('covers the whole 155-card catalogue', () => {
    expect(cardIds).toHaveLength(155);
    expect(contractIds).toHaveLength(cardIds.length);
  });
});

describe.each(cardIds.filter((id) => CARD_CONTRACTS[id] !== undefined))('%s', (cardId) => {
  const contract = CARD_CONTRACTS[cardId];
  if (!contract) return;
  it(contract.claim, () => {
    contract.run(ContractTable.open(contract.commander ? { commander: contract.commander } : {}));
  });
});
