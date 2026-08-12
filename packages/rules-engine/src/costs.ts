import type { CardDefinition } from '@tcg/card-data';
import type { ReadContext } from './context.js';
import { staticAbilityActive } from './continuous.js';
import { definitionOf, energyCostOf, matchesCardFilter, playerOf } from './derive.js';
import { evaluateValue } from './values.js';
import type { CardInstance } from './schema/state.js';
import type { PlayerId } from './schema/primitives.js';

/**
 * What playing a card out of hand costs its controller right now (M02.3).
 *
 * Two reductions stack up on the printed cost, and they work in different ways:
 *
 *  - `player.costModifiers` — the flat, timed deltas a `modify_cost` instruction
 *    applies. Already handled by `energyCostOf`.
 *  - `cost_reduction` static abilities — derived, recomputed here on every call,
 *    because "costs 1 less for each friendly Unit defeated this turn" is a
 *    question about the board at the moment you try to play the card, not about
 *    the board when you drew it.
 *
 * Nothing is ever *stored* on the card. A discounted cost written onto an
 * instance would be stale the moment a unit died, and would have to be
 * invalidated from four different places; deriving it means the number a player
 * sees, the number the legality check uses and the number actually paid are the
 * same computation.
 */

/**
 * The reduction, and the floor it may not take a cost below.
 *
 * Several abilities may apply at once: their amounts add, and the strictest
 * printed floor wins. Adding is the only composition that does not depend on
 * the order they are read in, which matters because the order sources are
 * scanned in is an implementation detail and a cost may not be.
 */
function costReductionFor(
  ctx: ReadContext,
  playerId: PlayerId,
  instance: CardInstance,
  definition: CardDefinition,
): { amount: number; minimum: number } {
  let amount = 0;
  let minimum = 0;

  // Every card the player controls, in creation order. A `cost_reduction` may
  // be printed on a card in any zone — the one authored card discounts itself
  // from hand — so the source set is not the battlefield, and the ability's own
  // `activeZone` is what decides whether it is switched on.
  const sources = Object.values(ctx.state.instances)
    .filter((candidate) => candidate.controller === playerId)
    .sort((left, right) => left.ordinal - right.ordinal);

  for (const source of sources) {
    const sourceDefinition = ctx.database.get(source.definitionId);
    if (!sourceDefinition) continue;
    for (const ability of sourceDefinition.staticAbilities) {
      if (ability.effect.type !== 'cost_reduction') continue;
      if (!staticAbilityActive(source, ability)) continue;

      // `affects.controller` is pinned to `self` by the schema, and every source
      // here is controlled by the player whose cost we are computing, so the
      // controller relation is already satisfied.
      if (ability.affects.onlySource) {
        if (source.instanceId !== instance.instanceId) continue;
      } else {
        if (instance.zone !== ability.affects.zone) continue;
        if (ability.affects.excludeSource && source.instanceId === instance.instanceId) continue;
        if (
          ability.affects.filter &&
          !matchesCardFilter(definition, instance, ability.affects.filter)
        ) {
          continue;
        }
      }

      amount += evaluateValue(ctx, ability.effect.amount, {
        controllerId: playerId,
        sourceInstanceId: source.instanceId,
      });
      minimum = Math.max(minimum, ability.effect.minimum);
    }
  }

  return { amount, minimum };
}

/**
 * The energy cost of playing this card from hand, after every reduction.
 *
 * The floor is the reducing ability's own printed minimum, raised to the
 * format's global `costReductionFloor` and then clamped against the printed
 * cost — so "to a minimum cost of 3" can never make a card that already cost 2
 * cost 3. A reduction that prints no floor at all really can make a card free,
 * which is what `costReductionFloor`'s "when the reducing effect prints one"
 * means (ruleset update §5).
 */
export function playCostOf(
  ctx: ReadContext,
  playerId: PlayerId,
  instance: CardInstance,
  definition: CardDefinition = definitionOf(ctx.database, instance),
): number {
  const base = energyCostOf(playerOf(ctx.state, playerId), definition);
  const { amount, minimum } = costReductionFor(ctx, playerId, instance, definition);
  if (amount === 0) return base;

  const floor = minimum === 0 ? 0 : Math.max(minimum, ctx.config.costReductionFloor);
  return Math.max(0, Math.min(floor, base), base - amount);
}
