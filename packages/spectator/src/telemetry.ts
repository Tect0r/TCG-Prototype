import type { CardDatabase, CardId } from '@tcg/card-data';
import {
  commanderDeployCost,
  type GameEvent,
  type MatchState,
  type PlayerId,
  type RulesConfig,
} from '@tcg/rules-engine';
import type {
  SpectatorDecision,
  SpectatorSeat,
  SpectatorSeatTelemetry,
  SpectatorTelemetry,
} from './schema.js';

/**
 * Board-size, Commander and Reaction telemetry (rule adjustment, "Match
 * telemetry"; CLAUDE.md §13.6).
 *
 * Everything here is derived by **replaying the event log**, not by inspecting
 * the final board. That is the difference between "how many units did this seat
 * ever have" and "how many does it have now", and the first question is the one
 * the unlimited battlefield has to be judged on. Deriving it from the log also
 * means it cannot disagree with the replay it ships alongside.
 *
 * Playback timing is deliberately absent. A delay the viewer chose must never
 * reach a number that describes the match — "longest turn" is counted in
 * actions, and the UI tracks wall-clock separately if it wants to.
 */

interface SeatTracker {
  readonly playerId: PlayerId;
  units: Set<string>;
  tokens: Map<string, Set<string>>;
  unitsByRound: number[];
  peakUnits: number;
  peakNonTokenUnits: number;
  peakTokens: number;
  peakTokenStack: number;
  peakTokensByDefinition: Map<CardId, number>;
  commanderDefeats: number;
  maxCommanderDeploymentCost: number;
  reactionsPlayed: number;
  /** Units lost since this seat was at its own peak, and how they went. */
  unitsLostAfterPeak: number;
  lossReasonsAfterPeak: Map<string, number>;
  eliminatedAtSequence: number | null;
}

function newTracker(playerId: PlayerId): SeatTracker {
  return {
    playerId,
    units: new Set(),
    tokens: new Map(),
    unitsByRound: [],
    peakUnits: 0,
    peakNonTokenUnits: 0,
    peakTokens: 0,
    peakTokenStack: 0,
    peakTokensByDefinition: new Map(),
    commanderDefeats: 0,
    maxCommanderDeploymentCost: 0,
    reactionsPlayed: 0,
    unitsLostAfterPeak: 0,
    lossReasonsAfterPeak: new Map(),
    eliminatedAtSequence: null,
  };
}

export function collectTelemetry(
  finalState: MatchState,
  events: readonly GameEvent[],
  decisions: readonly SpectatorDecision[],
  database: CardDatabase,
  config: RulesConfig,
  seats: readonly SpectatorSeat[],
): SpectatorTelemetry {
  const trackers = new Map<PlayerId, SeatTracker>(
    seats.map((seat) => [seat.playerId, newTracker(seat.playerId)]),
  );
  const tokenDefinitions = new Set<CardId>();
  const instanceOwner = new Map<string, PlayerId>();
  const instanceDefinition = new Map<string, CardId>();

  // Rounds are complete cycles of the seat order. The engine has no round
  // counter — deliberately, since nothing in the rules needs one — so it is
  // derived here, where it is a reporting concept rather than a rule.
  const seatCount = Math.max(1, seats.length);
  let round = 0;
  let turn = 0;

  const actionsPerTurn = new Map<number, number>();
  const triggersPerTurn = new Map<number, number>();
  const choicesPerTurn = new Map<number, number>();
  const attackersPerRound = new Map<number, number>();

  let reactionWindows = 0;
  let reactionsPlayed = 0;
  let cardsCountered = 0;
  let largestCombat = { turn: 0, attackers: 0, blockers: 0 };
  let pendingCombat: { turn: number; attackers: number } | null = null;
  let eliminationOrder = 0;

  const snapshotRound = (): void => {
    for (const tracker of trackers.values()) {
      // Index by round, so every seat's array is the same length and a chart
      // can read them side by side.
      tracker.unitsByRound[round - 1] = tracker.units.size;
    }
  };

  const bump = (tracker: SeatTracker): void => {
    const total = tracker.units.size;
    let tokens = 0;
    let largestStack = 0;
    for (const [definitionId, members] of tracker.tokens) {
      tokens += members.size;
      if (members.size > largestStack) largestStack = members.size;
      const previous = tracker.peakTokensByDefinition.get(definitionId) ?? 0;
      if (members.size > previous) tracker.peakTokensByDefinition.set(definitionId, members.size);
    }
    if (total > tracker.peakUnits) {
      tracker.peakUnits = total;
      // The peak moved, so "what answered the largest board" starts counting
      // again from here rather than from an earlier, smaller high-water mark.
      tracker.unitsLostAfterPeak = 0;
      tracker.lossReasonsAfterPeak = new Map();
    }
    if (total - tokens > tracker.peakNonTokenUnits) tracker.peakNonTokenUnits = total - tokens;
    if (tokens > tracker.peakTokens) tracker.peakTokens = tokens;
    if (largestStack > tracker.peakTokenStack) tracker.peakTokenStack = largestStack;
  };

  const addUnit = (playerId: PlayerId, instanceId: string, definitionId: CardId): void => {
    const tracker = trackers.get(playerId);
    if (!tracker) return;
    instanceOwner.set(instanceId, playerId);
    instanceDefinition.set(instanceId, definitionId);
    tracker.units.add(instanceId);
    if (tokenDefinitions.has(definitionId) || database.get(definitionId)?.type === 'token') {
      tokenDefinitions.add(definitionId);
      const group = tracker.tokens.get(definitionId) ?? new Set<string>();
      group.add(instanceId);
      tracker.tokens.set(definitionId, group);
    }
    bump(tracker);
  };

  const removeUnit = (instanceId: string, reason: string): void => {
    const playerId = instanceOwner.get(instanceId);
    if (playerId === undefined) return;
    const tracker = trackers.get(playerId);
    if (!tracker || !tracker.units.has(instanceId)) return;
    tracker.units.delete(instanceId);
    const definitionId = instanceDefinition.get(instanceId);
    if (definitionId !== undefined) tracker.tokens.get(definitionId)?.delete(instanceId);
    tracker.unitsLostAfterPeak += 1;
    tracker.lossReasonsAfterPeak.set(reason, (tracker.lossReasonsAfterPeak.get(reason) ?? 0) + 1);
  };

  for (const event of events) {
    switch (event.type) {
      case 'turn_started': {
        if (turn > 0 && turn % seatCount === 0) snapshotRound();
        turn = event.turn;
        round = Math.ceil(turn / seatCount);
        break;
      }

      case 'unit_entered_battlefield':
        addUnit(event.playerId, event.instanceId, event.definitionId);
        break;

      case 'relic_deployed':
        // Relics live in their own zone and are not units; recorded only so the
        // instance map can answer "whose was that" if one is later defeated.
        instanceOwner.set(event.instanceId, event.playerId);
        instanceDefinition.set(event.instanceId, event.definitionId);
        break;

      case 'unit_defeated':
        removeUnit(event.instanceId, event.reason);
        break;

      case 'card_moved':
        // Anything leaving the battlefield by a route other than defeat: a
        // bounce, a countered permanent, an elimination sweep.
        if (event.fromZone === 'battlefield')
          removeUnit(event.instanceId, `moved_to_${event.toZone}`);
        break;

      case 'commander_returned': {
        const tracker = trackers.get(event.playerId);
        if (!tracker) break;
        tracker.commanderDefeats = event.defeatCount;
        if (event.deploymentCost > tracker.maxCommanderDeploymentCost) {
          tracker.maxCommanderDeploymentCost = event.deploymentCost;
        }
        break;
      }

      case 'commander_deployed': {
        const tracker = trackers.get(event.playerId);
        if (tracker && event.energySpent > tracker.maxCommanderDeploymentCost) {
          tracker.maxCommanderDeploymentCost = event.energySpent;
        }
        break;
      }

      case 'reaction_window_opened':
        reactionWindows += 1;
        break;

      case 'reaction_played': {
        reactionsPlayed += 1;
        const tracker = trackers.get(event.playerId);
        if (tracker) tracker.reactionsPlayed += 1;
        break;
      }

      case 'card_countered':
        cardsCountered += 1;
        break;

      case 'attackers_declared':
        pendingCombat = { turn, attackers: event.instanceIds.length };
        attackersPerRound.set(
          round,
          (attackersPerRound.get(round) ?? 0) + event.instanceIds.length,
        );
        if (event.instanceIds.length > largestCombat.attackers) {
          largestCombat = { turn, attackers: event.instanceIds.length, blockers: 0 };
        }
        break;

      case 'blockers_assigned':
        if (pendingCombat && pendingCombat.attackers === largestCombat.attackers) {
          largestCombat = { ...largestCombat, blockers: event.blocks.length };
        }
        pendingCombat = null;
        break;

      case 'trigger_queued':
        triggersPerTurn.set(turn, (triggersPerTurn.get(turn) ?? 0) + 1);
        break;

      case 'choice_requested':
        choicesPerTurn.set(turn, (choicesPerTurn.get(turn) ?? 0) + 1);
        break;

      case 'player_eliminated': {
        const tracker = trackers.get(event.playerId);
        eliminationOrder += 1;
        if (tracker) tracker.eliminatedAtSequence = eliminationOrder;
        break;
      }

      default:
        break;
    }
  }
  if (round > 0) snapshotRound();

  // Actions per turn, taken from the decisions rather than reconstructed from
  // the log: each decision already records the turn it was made on, and
  // "longest turn" is about how much the players did, not how much the engine
  // emitted in response.
  for (const decision of decisions) {
    actionsPerTurn.set(decision.turn, (actionsPerTurn.get(decision.turn) ?? 0) + 1);
  }

  const longestTurn = pickMax(actionsPerTurn);
  const busiest = pickMax(triggersPerTurn);

  // A stall is a *round* in which nobody attacked. Counted in rounds rather
  // than turns so a three-seat table is not reported as stalling merely because
  // one seat had nothing to attack with.
  let longestStallRounds = 0;
  let currentStall = 0;
  for (let index = 1; index <= round; index += 1) {
    if ((attackersPerRound.get(index) ?? 0) === 0) {
      currentStall += 1;
      if (currentStall > longestStallRounds) longestStallRounds = currentStall;
    } else {
      currentStall = 0;
    }
  }

  const placements = rankSeats(finalState, seats, trackers);

  const seatTelemetry: SpectatorSeatTelemetry[] = seats.map((seat) => {
    const tracker = trackers.get(seat.playerId) ?? newTracker(seat.playerId);
    const player = finalState.players[seat.playerId];
    const definition = database.get(seat.commanderId);
    const currentCost =
      player && definition ? (commanderDeployCost(player, definition, config) ?? 0) : 0;
    return {
      playerId: seat.playerId,
      unitsByRound: tracker.unitsByRound.map((count) => count ?? 0),
      peakUnits: tracker.peakUnits,
      peakNonTokenUnits: tracker.peakNonTokenUnits,
      peakTokens: tracker.peakTokens,
      peakTokenStack: tracker.peakTokenStack,
      peakTokensByDefinition: Object.fromEntries(tracker.peakTokensByDefinition),
      commanderDefeats: player?.commanderDefeats ?? tracker.commanderDefeats,
      maxCommanderDeploymentCost: Math.max(tracker.maxCommanderDeploymentCost, currentCost),
      reactionsPlayed: tracker.reactionsPlayed,
      placement: placements.get(seat.playerId) ?? seats.length,
    };
  });

  const widest = [...trackers.values()].reduce<SeatTracker | null>(
    (best, tracker) => (best === null || tracker.peakUnits > best.peakUnits ? tracker : best),
    null,
  );

  return {
    seats: seatTelemetry,
    turns: finalState.turn,
    rounds: round,
    actions: decisions.length,
    events: events.length,
    longestTurn: { turn: longestTurn.key, actions: longestTurn.value },
    largestCombat,
    busiestTurn: {
      turn: busiest.key,
      triggers: busiest.value,
      choices: choicesPerTurn.get(busiest.key) ?? 0,
    },
    reactionWindows,
    reactionsPlayed,
    cardsCountered,
    longestStallRounds,
    // Three rounds with no attack at all is the point at which "nobody wants to
    // attack" stops looking like a slow opening. Reported, never acted on.
    boardStalled: longestStallRounds >= 3,
    largestBoardAnswer:
      widest && widest.peakUnits > 0
        ? {
            playerId: widest.playerId,
            peakUnits: widest.peakUnits,
            unitsLostAfterPeak: widest.unitsLostAfterPeak,
            reasons: [...widest.lossReasonsAfterPeak]
              .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
              .map(([reason]) => reason),
          }
        : null,
  };
}

function pickMax(counts: ReadonlyMap<number, number>): { key: number; value: number } {
  let key = 0;
  let value = 0;
  // Ascending key order, so ties resolve to the earliest turn on every machine.
  for (const entry of [...counts].sort((left, right) => left[0] - right[0])) {
    if (entry[1] > value) {
      key = entry[0];
      value = entry[1];
    }
  }
  return { key, value };
}

/**
 * Final placement: the winner is first, then the seats that survived longest.
 *
 * A seat eliminated later placed better than one eliminated earlier, which is
 * the only ordering a free-for-all supports without inventing a scoring system.
 */
function rankSeats(
  state: MatchState,
  seats: readonly SpectatorSeat[],
  trackers: ReadonlyMap<PlayerId, SeatTracker>,
): Map<PlayerId, number> {
  const ordered = [...seats].sort((left, right) => {
    const leftWon = state.result?.winnerId === left.playerId;
    const rightWon = state.result?.winnerId === right.playerId;
    if (leftWon !== rightWon) return leftWon ? -1 : 1;

    const leftOut = trackers.get(left.playerId)?.eliminatedAtSequence;
    const rightOut = trackers.get(right.playerId)?.eliminatedAtSequence;
    if (leftOut === rightOut) return left.seatIndex - right.seatIndex;
    if (leftOut === null || leftOut === undefined) return -1;
    if (rightOut === null || rightOut === undefined) return 1;
    return rightOut - leftOut;
  });

  return new Map(ordered.map((seat, index) => [seat.playerId, index + 1]));
}
