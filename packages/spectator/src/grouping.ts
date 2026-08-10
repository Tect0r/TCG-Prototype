import type { GameEvent, PlayerId } from '@tcg/rules-engine';

/**
 * The presentation-only grouping layer (rule adjustment, "Event grouping").
 *
 * Raw engine events are far too granular to watch: playing one unit emits a
 * cost payment, a card move, a deployment, an entry, and then whatever its
 * deploy effects do. A viewer should see "Bot 2 deploys Goblin Piledriver", once.
 *
 * Two rules make this safe:
 *
 *  1. **Grouping never reorders.** A group is a contiguous run of the event log,
 *     and the groups are emitted in log order. Playback therefore shows exactly
 *     the sequence the engine produced, at a coarser grain.
 *  2. **Nothing is dropped.** Every event belongs to exactly one group, so a
 *     viewer stepping through groups has seen the whole log. The UI may hide a
 *     group's detail; the detail is still there.
 *
 * That is what keeps "grouping must never change authoritative resolution order
 * or replay determinism" structurally true rather than a promise.
 */

export const GROUP_KINDS = [
  'setup',
  'turn_start',
  'draw',
  'play_card',
  'commander_deploy',
  'commander_return',
  'activate',
  'attack',
  'block',
  'combat_damage',
  'reaction_window',
  'reaction_play',
  'reaction_passes',
  'effect',
  'choice',
  'elimination',
  'match_end',
  'phase',
] as const;
export type GroupKind = (typeof GROUP_KINDS)[number];

export interface EventGroup {
  readonly index: number;
  readonly kind: GroupKind;
  /** One line, already written for a viewer. */
  readonly summary: string;
  /** The seat this group is about, when it is about one. */
  readonly playerId: PlayerId | null;
  /** Card instances to highlight while this group is showing. */
  readonly highlightInstanceIds: readonly string[];
  /** Sequence number of the last event in the group: the state to render at. */
  readonly sequence: number;
  readonly events: readonly GameEvent[];
  /**
   * Compound groups — a combat, a whole spell resolution — are worth an extra
   * beat on screen. A hint, not a duration: the UI owns timing.
   */
  readonly weight: 1 | 2;
}

export interface GroupingOptions {
  /** Resolves a card ID to a display name. Falls back to the ID. */
  readonly nameOf?: (definitionId: string) => string;
  /** Resolves a seat to a display name. Falls back to the ID. */
  readonly seatName?: (playerId: PlayerId) => string;
}

/**
 * Events that open a group. Anything not listed joins the group in progress,
 * which is what folds a card's own consequences into the play that caused them.
 */
const OPENERS: Partial<Record<GameEvent['type'], GroupKind>> = {
  match_started: 'setup',
  deck_shuffled: 'setup',
  mulligan_submitted: 'setup',
  mulligan_resolved: 'setup',
  turn_started: 'turn_start',
  card_drawn: 'draw',
  draw_skipped: 'draw',
  card_played: 'play_card',
  commander_deployed: 'commander_deploy',
  commander_returned: 'commander_return',
  trigger_queued: 'effect',
  attackers_declared: 'attack',
  blockers_assigned: 'block',
  combat_damage_step: 'combat_damage',
  reaction_window_opened: 'reaction_window',
  reaction_played: 'reaction_play',
  reaction_passed: 'reaction_passes',
  choice_requested: 'choice',
  player_eliminated: 'elimination',
  match_ended: 'match_end',
  phase_changed: 'phase',
};

export function groupEvents(
  events: readonly GameEvent[],
  options: GroupingOptions = {},
): EventGroup[] {
  const nameOf = options.nameOf ?? ((id: string) => id);
  const seatName = options.seatName ?? ((id: PlayerId) => id);

  const groups: EventGroup[] = [];
  let current: { kind: GroupKind; events: GameEvent[] } | null = null;

  const flush = (): void => {
    if (!current || current.events.length === 0) return;
    const built = buildGroup(groups.length, current.kind, current.events, nameOf, seatName);
    // A phase change with nothing in it is bookkeeping, not an action, and a
    // spectator stepping through should not spend a beat on it.
    if (built !== null) groups.push(built);
    current = null;
  };

  for (const event of events) {
    const opener = OPENERS[event.type];
    if (opener !== undefined) {
      // Consecutive passes collapse into one group by *extending* the group in
      // progress rather than starting another. They stay individually present
      // in `events`, so "allow them to be inspected" costs nothing.
      if (opener === 'reaction_passes' && current?.kind === 'reaction_passes') {
        current.events.push(event);
        continue;
      }
      flush();
      current = { kind: opener, events: [event] };
      continue;
    }
    if (current === null) current = { kind: 'effect', events: [] };
    current.events.push(event);
  }
  flush();

  return groups;
}

/** Whether a group is worth showing at all. */
function buildGroup(
  index: number,
  kind: GroupKind,
  events: readonly GameEvent[],
  nameOf: (definitionId: string) => string,
  seatName: (playerId: PlayerId) => string,
): EventGroup | null {
  const last = events[events.length - 1];
  if (!last) return null;
  // A bare phase change carries no information a viewer needs; the phase is
  // already on screen. One that dragged consequences along with it does.
  if (kind === 'phase' && events.length === 1) return null;

  const highlight = new Set<string>();
  for (const event of events) {
    for (const id of instanceIdsOf(event)) highlight.add(id);
  }

  return {
    index,
    kind,
    summary: summarise(kind, events, nameOf, seatName),
    playerId: playerOf(events),
    highlightInstanceIds: [...highlight],
    sequence: last.sequence,
    events: [...events],
    weight: events.length > 4 || kind === 'combat_damage' || kind === 'attack' ? 2 : 1,
  };
}

function playerOf(events: readonly GameEvent[]): PlayerId | null {
  for (const event of events) {
    if ('playerId' in event && typeof event.playerId === 'string') return event.playerId;
  }
  return null;
}

function instanceIdsOf(event: GameEvent): string[] {
  const ids: string[] = [];
  const push = (value: unknown): void => {
    if (typeof value === 'string') ids.push(value);
  };
  const record = event as unknown as Record<string, unknown>;
  push(record['instanceId']);
  push(record['sourceInstanceId']);
  push(record['targetInstanceId']);
  push(record['replacedByInstanceId']);
  if (Array.isArray(record['instanceIds'])) for (const id of record['instanceIds']) push(id);
  if (Array.isArray(record['blocks'])) {
    for (const block of record['blocks'] as {
      attackerInstanceId?: unknown;
      blockerInstanceId?: unknown;
    }[]) {
      push(block.attackerInstanceId);
      push(block.blockerInstanceId);
    }
  }
  return ids;
}

/* --------------------------------------------------------------- summaries */

function summarise(
  kind: GroupKind,
  events: readonly GameEvent[],
  nameOf: (definitionId: string) => string,
  seatName: (playerId: PlayerId) => string,
): string {
  const first = events[0];
  if (!first) return '';

  switch (kind) {
    case 'setup': {
      if (first.type === 'match_started') {
        return `Match begins — ${seatName(first.startingPlayerId)} goes first.`;
      }
      if (first.type === 'mulligan_resolved') {
        return first.returnedCount === 0
          ? `${seatName(first.playerId)} keeps their opening hand.`
          : `${seatName(first.playerId)} returns ${first.returnedCount} card(s) and redraws.`;
      }
      return 'Setting up.';
    }

    case 'turn_start':
      return first.type === 'turn_started'
        ? `Turn ${first.turn} — ${seatName(first.playerId)}.`
        : 'Turn begins.';

    case 'draw':
      if (first.type === 'draw_skipped') return `${seatName(first.playerId)} skips their draw.`;
      return first.type === 'card_drawn' ? `${seatName(first.playerId)} draws.` : 'Draw.';

    case 'play_card': {
      if (first.type !== 'card_played') return 'A card is played.';
      const extra = consequenceSuffix(events, nameOf);
      return `${seatName(first.playerId)} plays ${nameOf(first.definitionId)} for ${first.energySpent} Energy${extra}`;
    }

    case 'commander_deploy':
      return first.type === 'commander_deployed'
        ? `${seatName(first.playerId)} deploys their Commander ${nameOf(first.definitionId)} for ${first.energySpent} Energy` +
            (first.defeatCount > 0 ? ` (${first.defeatCount} defeat surcharge).` : '.')
        : 'A Commander is deployed.';

    case 'commander_return':
      return first.type === 'commander_returned'
        ? `${nameOf(first.definitionId)} is defeated and returns to the Command Zone — next deployment costs ${first.deploymentCost}.`
        : 'A Commander returns to its Command Zone.';

    case 'attack': {
      if (first.type !== 'attackers_declared') return 'Attackers are declared.';
      const targets = new Set(first.attacks.map((attack) => attack.defenderPlayerId));
      const who = [...targets].map(seatName).join(', ');
      return first.instanceIds.length === 0
        ? `${seatName(first.playerId)} declines to attack.`
        : `${seatName(first.playerId)} attacks ${who} with ${first.instanceIds.length} unit(s).`;
    }

    case 'block':
      return first.type === 'blockers_assigned'
        ? first.blocks.length === 0
          ? 'No blockers are assigned.'
          : `${first.blocks.length} blocker(s) are assigned.`
        : 'Blockers are assigned.';

    case 'combat_damage': {
      const defeats = events.filter((event) => event.type === 'unit_defeated').length;
      return defeats === 0
        ? 'Combat damage is dealt.'
        : `Combat damage is dealt — ${defeats} unit(s) defeated.`;
    }

    case 'reaction_window':
      return first.type === 'reaction_window_opened'
        ? `Reaction window opens (${first.windows.join(', ')}).`
        : 'A Reaction window opens.';

    case 'reaction_play':
      return first.type === 'reaction_played'
        ? `${seatName(first.playerId)} plays the Reaction ${nameOf(first.definitionId)}` +
            (first.discountApplied > 0 ? ` (${first.discountApplied} less).` : '.')
        : 'A Reaction is played.';

    case 'reaction_passes': {
      const who = events
        .filter(
          (event): event is Extract<GameEvent, { type: 'reaction_passed' }> =>
            event.type === 'reaction_passed',
        )
        .map((event) => seatName(event.playerId));
      return who.length === 1 ? `${who[0]} passes.` : `${who.join(', ')} pass.`;
    }

    case 'effect': {
      const trigger = events.find(
        (event): event is Extract<GameEvent, { type: 'trigger_queued' }> =>
          event.type === 'trigger_queued',
      );
      if (trigger) return `${nameOf(trigger.definitionId)} triggers.`;
      return summariseConsequences(events, nameOf) ?? 'Effects resolve.';
    }

    case 'choice':
      return first.type === 'choice_requested'
        ? `${seatName(first.playerId)} must choose (${first.reason.replace(/_/g, ' ')}).`
        : 'A choice is made.';

    case 'elimination':
      return first.type === 'player_eliminated'
        ? `${seatName(first.playerId)} is eliminated.`
        : 'A player is eliminated.';

    case 'match_end':
      return first.type === 'match_ended'
        ? first.outcome === 'draw'
          ? `The match is a draw (${first.reason}).`
          : `${first.winnerId ? seatName(first.winnerId) : 'Nobody'} wins (${first.reason}).`
        : 'The match ends.';

    case 'phase':
      return summariseConsequences(events, nameOf) ?? 'The phase changes.';

    default:
      return 'Something happens.';
  }
}

/** ", dealing 3 damage" and friends — the visible half of what a card did. */
function consequenceSuffix(
  events: readonly GameEvent[],
  nameOf: (definitionId: string) => string,
): string {
  const summary = summariseConsequences(events.slice(1), nameOf);
  return summary === null ? '.' : ` — ${summary}`;
}

function summariseConsequences(
  events: readonly GameEvent[],
  nameOf: (definitionId: string) => string,
): string | null {
  const parts: string[] = [];
  let damage = 0;
  let tokens = 0;
  const defeated: string[] = [];
  let countered = 0;

  for (const event of events) {
    switch (event.type) {
      case 'damage_dealt':
        damage += event.amount;
        break;
      case 'token_created':
        tokens += 1;
        break;
      case 'unit_defeated':
        defeated.push(nameOf(event.definitionId));
        break;
      case 'card_countered':
        countered += 1;
        break;
      default:
        break;
    }
  }

  if (damage > 0) parts.push(`${damage} damage`);
  if (tokens > 0) parts.push(`${tokens} token(s) created`);
  if (defeated.length > 0) parts.push(`${defeated.join(', ')} defeated`);
  if (countered > 0) parts.push(`${countered} card(s) countered`);
  return parts.length === 0 ? null : parts.join(', ');
}
