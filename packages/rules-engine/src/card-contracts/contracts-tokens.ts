import type { CardId } from '@tcg/card-data';
import { check, checkEqual, type CardContract } from './harness.js';

/**
 * The three Wave 1 Tokens.
 *
 * A Token has no cost and cannot be played, so each contract creates it the
 * only way a match ever can — with a card that makes it — and then measures the
 * body that arrived. That is the whole of a Token's printed behaviour.
 */
export const TOKEN_CONTRACTS: Record<CardId, CardContract> = {
  goblin_token: {
    claim: 'arrives from a Goblin-making card as a 1/1',
    run: (table) => {
      table.cast('call_a_goblin');
      const instanceId = table.onlyUnitOf('goblin_token');
      check(table.instance(instanceId).isToken, 'the created Unit is not marked as a Token');
      checkEqual(table.attackOf(instanceId), 1, 'its ATK');
      checkEqual(table.healthOf(instanceId), 1, 'its Health');
    },
  },

  guard_token: {
    claim: 'arrives from a Guard-making card as a 0/2 Guardian',
    run: (table) => {
      table.cast('call_the_watch');
      const instanceId = table.onlyUnitOf('guard_token');
      check(table.instance(instanceId).isToken, 'the created Unit is not marked as a Token');
      checkEqual(table.attackOf(instanceId), 0, 'its ATK');
      checkEqual(table.healthOf(instanceId), 2, 'its Health');
      check(table.hasKeyword(instanceId, 'guardian'), 'Guardian is missing');
    },
  },

  thrall_token: {
    claim: 'arrives from a Thrall-making card as a 1/1',
    run: (table) => {
      table.cast('raise_a_thrall');
      const instanceId = table.onlyUnitOf('thrall_token');
      check(table.instance(instanceId).isToken, 'the created Unit is not marked as a Token');
      checkEqual(table.attackOf(instanceId), 1, 'its ATK');
      checkEqual(table.healthOf(instanceId), 1, 'its Health');
    },
  },
};
