import type { CardDatabase } from '@tcg/card-data';
import type { GameEvent, PlayerView } from '@tcg/rules-engine';

/**
 * Turns a structured public event into one readable log line.
 *
 * Presentation only. The engine's events stay machine-readable; this is the
 * single place that renders them, and it never influences any rule.
 */
export function describeEvent(
  event: GameEvent,
  view: PlayerView,
  database: CardDatabase,
): string | null {
  const playerName = (playerId: string | null): string =>
    view.players.find((player) => player.playerId === playerId)?.name ?? 'Someone';

  const cardName = (definitionId: string | null | undefined): string =>
    definitionId ? (database.get(definitionId)?.name ?? definitionId) : 'a card';

  const instanceName = (instanceId: string | null): string =>
    instanceId ? cardName(view.instances[instanceId]?.definitionId) : 'something';

  switch (event.type) {
    case 'match_started':
      return `Match begins. ${playerName(event.startingPlayerId)} goes first.`;
    case 'mulligan_submitted':
      return `${playerName(event.playerId)} submitted their opening hand decision.`;
    case 'mulligan_resolved':
      return event.returnedCount === 0
        ? `${playerName(event.playerId)} kept their opening hand.`
        : `${playerName(event.playerId)} redrew ${event.returnedCount} card(s).`;
    case 'turn_started':
      return `— Turn ${event.turn}: ${playerName(event.playerId)} —`;
    case 'draw_skipped':
      return `${playerName(event.playerId)} skips their first draw.`;
    case 'card_drawn':
      return event.playerId === view.viewerId
        ? `You drew ${cardName(event.definitionId)}.`
        : `${playerName(event.playerId)} drew a card.`;
    case 'card_discarded':
      return `${playerName(event.playerId)} discarded ${cardName(event.definitionId)}.`;
    case 'card_played':
      return `${playerName(event.playerId)} played ${cardName(event.definitionId)} for ${event.energySpent} energy.`;
    case 'unit_deployed':
      return `${cardName(event.definitionId)} enters the battlefield.`;
    case 'relic_deployed':
      return `${cardName(event.definitionId)} is deployed.`;
    case 'relic_replaced':
      return `${cardName(event.replacedByDefinitionId)} replaces ${cardName(event.definitionId)}, which goes to the discard pile.`;
    case 'token_created':
      return `${playerName(event.playerId)} creates ${cardName(event.definitionId)}.`;
    case 'attackers_declared': {
      if (event.attacks.length === 0) return `${playerName(event.playerId)} declines to attack.`;
      // Who each attacker chose matters in a free-for-all, so the log says so.
      const byDefender = new Map<string, string[]>();
      for (const attack of event.attacks) {
        const names = byDefender.get(attack.defenderPlayerId) ?? [];
        names.push(instanceName(attack.attackerInstanceId));
        byDefender.set(attack.defenderPlayerId, names);
      }
      const parts = [...byDefender].map(
        ([defenderId, names]) => `${names.join(', ')} → ${playerName(defenderId)}`,
      );
      return `${playerName(event.playerId)} attacks: ${parts.join('; ')}.`;
    }
    case 'blockers_submitted':
      return event.awaitingPlayerIds.length === 0
        ? `${playerName(event.playerId)} has chosen blockers.`
        : `${playerName(event.playerId)} has chosen blockers; waiting for ${event.awaitingPlayerIds.map(playerName).join(', ')}.`;
    case 'blockers_assigned':
      return event.blocks.length === 0
        ? `Nobody blocks.`
        : `Blocks: ${event.blocks.map((block) => `${instanceName(block.blockerInstanceId)} blocks ${instanceName(block.attackerInstanceId)}`).join('; ')}.`;
    case 'player_eliminated':
      return `${playerName(event.playerId)} is out of the match.`;
    case 'control_returned':
      return `${instanceName(event.instanceId)} returns to ${playerName(event.playerId)}.`;
    case 'damage_dealt':
      return event.targetPlayerId
        ? `${playerName(event.targetPlayerId)} takes ${event.amount} damage.`
        : `${instanceName(event.targetInstanceId)} takes ${event.amount} damage.`;
    case 'damage_prevented':
      return `${event.amount} damage prevented.`;
    case 'healed':
      return event.targetPlayerId
        ? `${playerName(event.targetPlayerId)} heals ${event.amount}.`
        : `${instanceName(event.targetInstanceId)} heals ${event.amount}.`;
    case 'unit_defeated':
      return `${cardName(event.definitionId)} is defeated (${event.reason.replace(/_/g, ' ')}).`;
    case 'stats_modified':
      return `${instanceName(event.instanceId)} gets ${event.attack >= 0 ? '+' : ''}${event.attack}/${event.health >= 0 ? '+' : ''}${event.health}.`;
    case 'keyword_granted':
      return `${instanceName(event.instanceId)} gains ${event.keyword}.`;
    case 'keyword_removed':
      return `${instanceName(event.instanceId)} loses ${event.keyword}.`;
    case 'cost_modified':
      return `${playerName(event.playerId)}'s cards cost ${Math.abs(event.delta)} ${event.delta < 0 ? 'less' : 'more'}.`;
    case 'trigger_queued':
      return `${cardName(event.definitionId)} triggers.`;
    case 'card_moved':
      return `${cardName(event.definitionId)} moves to ${event.toZone.replace(/_/g, ' ')}.`;
    case 'cards_revealed':
      return `${playerName(event.playerId)} reveals ${(event.definitionIds ?? []).map(cardName).join(', ')}.`;
    case 'zone_reordered':
      return `${playerName(event.playerId)} reorders the top of their deck.`;
    case 'player_lost':
      return `${playerName(event.playerId)} loses: ${event.reason.replace(/_/g, ' ')}.`;
    case 'match_ended':
      return event.outcome === 'draw'
        ? `The match is a draw (${event.reason.replace(/_/g, ' ')}).`
        : `${playerName(event.winnerId)} wins (${event.reason.replace(/_/g, ' ')}).`;
    case 'engine_fault':
      return `Engine fault: ${event.message}`;

    // Bookkeeping events that would only add noise to a player-facing log.
    case 'phase_changed':
    case 'energy_updated':
    case 'deck_shuffled':
    case 'unit_exhausted':
    case 'unit_readied':
    case 'modifiers_expired':
    case 'combat_damage_step':
    case 'combat_survived':
    case 'effect_resolved':
    case 'effect_fizzled':
    case 'choice_requested':
    case 'choice_resolved':
    case 'spell_resolved':
    case 'damage_shield_added':
    case 'player_damaged':
    case 'player_healed':
    case 'effects_cancelled':
    case 'choice_cancelled':
      return null;

    default:
      return null;
  }
}

export interface LogLine {
  readonly sequence: number;
  readonly text: string;
}

export function buildLog(view: PlayerView, database: CardDatabase): LogLine[] {
  const lines: LogLine[] = [];
  for (const event of view.log) {
    const text = describeEvent(event, view, database);
    if (text !== null) lines.push({ sequence: event.sequence, text });
  }
  return lines;
}
