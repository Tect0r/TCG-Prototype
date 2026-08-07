import type { CardDefinition, CardId, EffectDefinition, TriggerId } from '@tcg/card-data';
import { emit, type MatchContext } from './context.js';
import { findInstance, playerOf } from './derive.js';
import type { GameEvent } from './schema/event.js';
import type { InstanceId, PlayerId } from './schema/primitives.js';
import type { ResolutionItem } from './schema/state.js';

/**
 * Trigger discovery.
 *
 * Every v0.2 trigger is *self-referential*: a source reacts only to events about
 * itself, except `on_turn_start` / `on_turn_end`, which fire for everything a
 * player controls on their own turn. That is the narrowest reading consistent
 * with the bundled card set; broadening it (e.g. "whenever another unit dies")
 * is a card-design decision that has not been made. See open-questions.md.
 */
interface TriggerHit {
  readonly triggerId: TriggerId;
  readonly sourceInstanceId: InstanceId;
  readonly definitionId: CardId;
  readonly controllerId: PlayerId;
  readonly causeSequence: number;
}

/** Instances still in `state.instances` expose their ordinal; defeated tokens do not. */
function ordinalOf(ctx: MatchContext, instanceId: InstanceId): number {
  const instance = findInstance(ctx.state, instanceId);
  if (instance) return instance.ordinal;
  const parsed = Number.parseInt(instanceId.replace(/^\D+/, ''), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function permanentsOf(ctx: MatchContext, playerId: PlayerId): InstanceId[] {
  const player = playerOf(ctx.state, playerId);
  return [
    ...player.units.filter((id): id is InstanceId => id !== null),
    ...player.relics,
    // Commander passives function from the Commander zone (CLAUDE.md §4).
    player.commanderInstanceId,
  ];
}

function hitsFromEvent(ctx: MatchContext, event: GameEvent): TriggerHit[] {
  const hit = (
    triggerId: TriggerId,
    sourceInstanceId: InstanceId,
    definitionId: CardId,
    controllerId: PlayerId,
  ): TriggerHit => ({
    triggerId,
    sourceInstanceId,
    definitionId,
    controllerId,
    causeSequence: event.sequence,
  });

  switch (event.type) {
    case 'unit_deployed':
    case 'relic_deployed':
    case 'token_created':
      return [hit('on_deploy', event.instanceId, event.definitionId, event.playerId)];

    case 'attackers_declared':
      return event.instanceIds.flatMap((instanceId) => {
        const instance = findInstance(ctx.state, instanceId);
        return instance
          ? [hit('on_attack', instanceId, instance.definitionId, instance.controller)]
          : [];
      });

    case 'blockers_assigned':
      return event.blocks.flatMap((block) => {
        const instance = findInstance(ctx.state, block.blockerInstanceId);
        return instance
          ? [hit('on_block', block.blockerInstanceId, instance.definitionId, instance.controller)]
          : [];
      });

    case 'combat_survived': {
      const instance = findInstance(ctx.state, event.instanceId);
      return instance
        ? [hit('on_survive_combat', event.instanceId, event.definitionId, instance.controller)]
        : [];
    }

    case 'unit_defeated': {
      const hits = [hit('on_defeated', event.instanceId, event.definitionId, event.controllerId)];
      if (event.reason === 'sacrificed') {
        hits.unshift(hit('on_sacrifice', event.instanceId, event.definitionId, event.controllerId));
      }
      return hits;
    }

    case 'turn_started':
      return permanentsOf(ctx, event.playerId).flatMap((instanceId) => {
        const instance = findInstance(ctx.state, instanceId);
        return instance
          ? [hit('on_turn_start', instanceId, instance.definitionId, event.playerId)]
          : [];
      });

    case 'phase_changed':
      if (event.to !== 'turn_end') return [];
      return permanentsOf(ctx, ctx.state.activePlayerId).flatMap((instanceId) => {
        const instance = findInstance(ctx.state, instanceId);
        return instance
          ? [hit('on_turn_end', instanceId, instance.definitionId, ctx.state.activePlayerId)]
          : [];
      });

    default:
      return [];
  }
}

interface QueuedTrigger {
  readonly hit: TriggerHit;
  readonly abilityId: string;
  readonly abilityIndex: number;
  readonly effects: readonly EffectDefinition[];
}

/**
 * Discovers triggers for a batch of events and appends them to the resolution
 * queue in the deterministic order required by CLAUDE.md §4: active player
 * first, then non-active player, then source instance creation order, then
 * trigger index within the card definition.
 */
export function collectTriggers(ctx: MatchContext, events: readonly GameEvent[]): void {
  const queued: QueuedTrigger[] = [];

  for (const event of events) {
    for (const hit of hitsFromEvent(ctx, event)) {
      const definition: CardDefinition | undefined = ctx.database.get(hit.definitionId);
      if (!definition) continue;
      definition.abilities.forEach((ability, abilityIndex) => {
        if (ability.trigger !== hit.triggerId) return;
        queued.push({ hit, abilityId: ability.id, abilityIndex, effects: ability.effects });
      });
    }
  }

  if (queued.length === 0) return;

  const active = ctx.state.activePlayerId;
  queued.sort((left, right) => {
    const leftActive = left.hit.controllerId === active ? 0 : 1;
    const rightActive = right.hit.controllerId === active ? 0 : 1;
    if (leftActive !== rightActive) return leftActive - rightActive;

    const leftOrdinal = ordinalOf(ctx, left.hit.sourceInstanceId);
    const rightOrdinal = ordinalOf(ctx, right.hit.sourceInstanceId);
    if (leftOrdinal !== rightOrdinal) return leftOrdinal - rightOrdinal;

    return left.abilityIndex - right.abilityIndex;
  });

  for (const entry of queued) {
    enqueue(ctx, {
      kind: 'triggered_ability',
      sourceInstanceId: entry.hit.sourceInstanceId,
      sourceDefinitionId: entry.hit.definitionId,
      controllerId: entry.hit.controllerId,
      abilityId: entry.abilityId,
      effects: [...entry.effects],
      causeSequence: entry.hit.causeSequence,
      completesSpell: false,
    });
    const item = ctx.state.queue[ctx.state.queue.length - 1];
    if (!item) continue;
    emit(ctx, {
      type: 'trigger_queued',
      sourceInstanceId: entry.hit.sourceInstanceId,
      definitionId: entry.hit.definitionId,
      controllerId: entry.hit.controllerId,
      abilityId: entry.abilityId,
      triggerId: entry.hit.triggerId,
      resolutionId: item.id,
    });
  }
}

export type EnqueueInput = Omit<ResolutionItem, 'id' | 'effectIndex' | 'selections'>;

/** Appends work to the FIFO resolution queue. There is no stack and no priority. */
export function enqueue(ctx: MatchContext, input: EnqueueInput): ResolutionItem {
  const id = `res_${String(ctx.state.nextResolutionOrdinal).padStart(4, '0')}`;
  ctx.state.nextResolutionOrdinal += 1;
  const item: ResolutionItem = { ...input, id, effectIndex: 0, selections: {} };
  ctx.state.queue.push(item);
  return item;
}
