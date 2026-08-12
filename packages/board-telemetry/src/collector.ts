import type { CardDatabase, CardId } from '@tcg/card-data';
import {
  commanderDeployCost,
  type GameEvent,
  type MatchPhase,
  type MatchState,
  type PlayerId,
  type RulesConfig,
} from '@tcg/rules-engine';
import {
  BOARD_TELEMETRY_VERSION,
  type BoardSeatTelemetry,
  type BoardTelemetry,
  type CombatTelemetry,
} from './schema.js';

/**
 * The one collector both match paths use (M04.1).
 *
 * It is driven by the event stream and by the turn each accepted action was
 * taken on, and by nothing else — no board inspection, no wall clock, no
 * knowledge of whether a human is watching. That is what lets the spectator feed
 * it a finished log (`collectBoardTelemetry`) while the simulator feeds it live
 * as the match runs, and get the same answer: the two ingestion modes touch the
 * same accumulators in the same order, because event order *is* the order.
 *
 * The class is the primitive and the function is the convenience, rather than
 * the other way round, because only the streaming form can be used by a driver
 * that must not retain the whole log of every match in a large batch
 * (`CLAUDE.md` §13.14 memory boundary).
 */

/** Combat phases, plus the window phase a Reaction inside combat parks in. */
const COMBAT_PHASES: readonly MatchPhase[] = [
  'declare_attackers',
  'assign_blockers',
  'resolve_combat',
  'reaction_window',
];

export interface BoardTelemetrySeat {
  readonly playerId: PlayerId;
  readonly seatIndex: number;
  /**
   * The seat's Commander, so the deployment-cost figure includes the cost the
   * Commander would be deployed at *now* — a Commander sitting in the Command
   * Zone with four defeats behind it has never been deployed at its current
   * price, and reporting only what was paid would understate the tax.
   */
  readonly commanderId: CardId;
}

export interface BoardTelemetryOptions {
  readonly database: CardDatabase;
  readonly config: RulesConfig;
  readonly seats: readonly BoardTelemetrySeat[];
}

interface SeatTracker {
  readonly playerId: PlayerId;
  readonly seatIndex: number;
  readonly commanderId: CardId;
  units: Set<string>;
  tokens: Map<CardId, Set<string>>;
  unitsByRound: number[];
  peakUnits: number;
  peakNonTokenUnits: number;
  peakTokens: number;
  peakTokenStack: number;
  peakTokensByDefinition: Map<CardId, number>;
  commanderDefeats: number;
  maxCommanderDeploymentCost: number;
  reactionsPlayed: number;
  unitsLostAfterPeak: number;
  lossReasonsAfterPeak: Map<string, number>;
  eliminatedAtSequence: number | null;
}

interface OpenCombat {
  turn: number;
  attackers: number;
  blockers: number;
  resolutionEvents: number;
}

function newTracker(seat: BoardTelemetrySeat): SeatTracker {
  return {
    playerId: seat.playerId,
    seatIndex: seat.seatIndex,
    commanderId: seat.commanderId,
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

export class BoardTelemetryCollector {
  readonly #database: CardDatabase;
  readonly #config: RulesConfig;
  readonly #seats: readonly BoardTelemetrySeat[];
  readonly #trackers = new Map<PlayerId, SeatTracker>();
  readonly #tokenDefinitions = new Set<CardId>();
  readonly #instanceOwner = new Map<string, PlayerId>();
  readonly #instanceDefinition = new Map<string, CardId>();

  readonly #actionsPerTurn = new Map<number, number>();
  readonly #triggersPerTurn = new Map<number, number>();
  readonly #choicesPerTurn = new Map<number, number>();
  readonly #attackersPerRound = new Map<number, number>();

  /**
   * Rounds are complete cycles of the seat order. The engine has no round
   * counter — deliberately, since no rule needs one — so it is derived here,
   * where it is a reporting concept rather than a rule.
   */
  readonly #seatCount: number;
  #round = 0;
  #turn = 0;
  #actions = 0;
  #events = 0;
  #reactionWindows = 0;
  #reactionsPlayed = 0;
  #cardsCountered = 0;
  #eliminationOrder = 0;
  #largestCombat: CombatTelemetry = { turn: 0, attackers: 0, blockers: 0, resolutionEvents: 0 };
  #longestCombat: CombatTelemetry = { turn: 0, attackers: 0, blockers: 0, resolutionEvents: 0 };
  #openCombat: OpenCombat | null = null;

  constructor(options: BoardTelemetryOptions) {
    this.#database = options.database;
    this.#config = options.config;
    this.#seats = options.seats;
    this.#seatCount = Math.max(1, options.seats.length);
    for (const seat of options.seats) this.#trackers.set(seat.playerId, newTracker(seat));
  }

  /**
   * One accepted action, on the turn it was taken.
   *
   * Taken from the driver rather than reconstructed from the log: "longest turn"
   * is about how much the players did, not how much the engine emitted in
   * response, and the engine emits an unbounded number of events for a single
   * decision.
   */
  observeAction(turn: number): void {
    this.#actions += 1;
    this.#actionsPerTurn.set(turn, (this.#actionsPerTurn.get(turn) ?? 0) + 1);
  }

  observeEvents(events: readonly GameEvent[]): void {
    for (const event of events) this.#observeEvent(event);
  }

  #observeEvent(event: GameEvent): void {
    this.#events += 1;
    this.#trackCombat(event);

    switch (event.type) {
      case 'turn_started': {
        if (this.#turn > 0 && this.#turn % this.#seatCount === 0) this.#snapshotRound();
        this.#turn = event.turn;
        this.#round = Math.ceil(this.#turn / this.#seatCount);
        break;
      }

      case 'unit_entered_battlefield':
        this.#addUnit(event.playerId, event.instanceId, event.definitionId);
        break;

      case 'relic_deployed':
        // Relics live in their own zone and are not Units; recorded only so the
        // instance map can answer "whose was that" if one is later defeated.
        this.#instanceOwner.set(event.instanceId, event.playerId);
        this.#instanceDefinition.set(event.instanceId, event.definitionId);
        break;

      case 'unit_defeated':
        this.#removeUnit(event.instanceId, event.reason);
        break;

      case 'card_moved':
        // Anything leaving the battlefield by a route other than defeat: a
        // bounce, a countered permanent, an elimination sweep.
        if (event.fromZone === 'battlefield')
          this.#removeUnit(event.instanceId, `moved_to_${event.toZone}`);
        break;

      case 'commander_returned': {
        const tracker = this.#trackers.get(event.playerId);
        if (!tracker) break;
        tracker.commanderDefeats = event.defeatCount;
        if (event.deploymentCost > tracker.maxCommanderDeploymentCost) {
          tracker.maxCommanderDeploymentCost = event.deploymentCost;
        }
        break;
      }

      case 'commander_deployed': {
        const tracker = this.#trackers.get(event.playerId);
        if (tracker && event.energySpent > tracker.maxCommanderDeploymentCost) {
          tracker.maxCommanderDeploymentCost = event.energySpent;
        }
        break;
      }

      case 'reaction_window_opened':
        this.#reactionWindows += 1;
        break;

      case 'reaction_played': {
        this.#reactionsPlayed += 1;
        const tracker = this.#trackers.get(event.playerId);
        if (tracker) tracker.reactionsPlayed += 1;
        break;
      }

      case 'card_countered':
        this.#cardsCountered += 1;
        break;

      case 'attackers_declared':
        this.#attackersPerRound.set(
          this.#round,
          (this.#attackersPerRound.get(this.#round) ?? 0) + event.instanceIds.length,
        );
        break;

      case 'trigger_queued':
        this.#tallyTrigger();
        break;

      // A delayed effect coming due is an ability of that card resolving, and it
      // reaches the queue without a `trigger_queued` of its own (M02.1). Counted
      // here so "triggers this turn" does not under-report the turn a promise
      // was actually paid.
      case 'delayed_effect_fired':
        this.#tallyTrigger();
        break;

      // A static ability rewriting an arrival or a Ready Step is that card's
      // ability doing its work, and it reaches no queue either (M02.4). A
      // prevention with a null `abilityId` came from a stored `skip_next_ready`
      // whose instruction was already counted where it resolved, so only the
      // standing `replace_ready` half is added here.
      case 'arrival_replaced':
        this.#tallyTrigger();
        break;

      case 'ready_prevented':
        if (event.abilityId !== null) this.#tallyTrigger();
        break;

      case 'choice_requested':
        this.#choicesPerTurn.set(this.#turn, (this.#choicesPerTurn.get(this.#turn) ?? 0) + 1);
        break;

      case 'player_eliminated': {
        this.#eliminationOrder += 1;
        const tracker = this.#trackers.get(event.playerId);
        if (tracker) tracker.eliminatedAtSequence = this.#eliminationOrder;
        break;
      }

      default:
        break;
    }
  }

  finish(finalState: MatchState): BoardTelemetry {
    if (this.#round > 0) this.#snapshotRound();
    this.#closeCombat();

    const longestTurn = pickMax(this.#actionsPerTurn);
    const busiest = pickMax(this.#triggersPerTurn);

    const attackersByRound: number[] = [];
    for (let index = 1; index <= this.#round; index += 1) {
      attackersByRound.push(this.#attackersPerRound.get(index) ?? 0);
    }
    let longestStallRounds = 0;
    let currentStall = 0;
    for (const attackers of attackersByRound) {
      if (attackers === 0) {
        currentStall += 1;
        if (currentStall > longestStallRounds) longestStallRounds = currentStall;
      } else {
        currentStall = 0;
      }
    }

    const seats = this.#seats.map((seat): BoardSeatTelemetry => {
      const tracker = this.#trackers.get(seat.playerId) ?? newTracker(seat);
      const player = finalState.players[seat.playerId];
      const definition = this.#database.get(seat.commanderId);
      const currentCost =
        player && definition ? (commanderDeployCost(player, definition, this.#config) ?? 0) : 0;
      return {
        playerId: seat.playerId,
        seatIndex: seat.seatIndex,
        unitsByRound: tracker.unitsByRound.map((count) => count ?? 0),
        peakUnits: tracker.peakUnits,
        peakNonTokenUnits: tracker.peakNonTokenUnits,
        peakTokens: tracker.peakTokens,
        peakTokenStack: tracker.peakTokenStack,
        peakTokensByDefinition: sortedCounts(tracker.peakTokensByDefinition),
        unitsLostAfterPeak: tracker.unitsLostAfterPeak,
        lossReasonsAfterPeak: sortedCounts(tracker.lossReasonsAfterPeak),
        commanderDefeats: player?.commanderDefeats ?? tracker.commanderDefeats,
        maxCommanderDeploymentCost: Math.max(tracker.maxCommanderDeploymentCost, currentCost),
        reactionsPlayed: tracker.reactionsPlayed,
        eliminatedAtSequence: tracker.eliminatedAtSequence,
      };
    });

    const widest = [...this.#trackers.values()].reduce<SeatTracker | null>(
      (best, tracker) => (best === null || tracker.peakUnits > best.peakUnits ? tracker : best),
      null,
    );

    return {
      schemaVersion: BOARD_TELEMETRY_VERSION,
      seats,
      turns: finalState.turn,
      rounds: this.#round,
      actions: this.#actions,
      events: this.#events,
      longestTurn: { turn: longestTurn.key, actions: longestTurn.value },
      largestCombat: { ...this.#largestCombat },
      longestCombatResolution: { ...this.#longestCombat },
      busiestTurn: {
        turn: busiest.key,
        triggers: busiest.value,
        choices: this.#choicesPerTurn.get(busiest.key) ?? 0,
      },
      reactionWindows: this.#reactionWindows,
      reactionsPlayed: this.#reactionsPlayed,
      cardsCountered: this.#cardsCountered,
      attackersByRound,
      longestStallRounds,
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

  /* ------------------------------------------------------------------ helpers */

  #tallyTrigger(): void {
    this.#triggersPerTurn.set(this.#turn, (this.#triggersPerTurn.get(this.#turn) ?? 0) + 1);
  }

  #snapshotRound(): void {
    for (const tracker of this.#trackers.values()) {
      // Indexed by round, so every seat's array is the same length and a chart
      // can read them side by side.
      tracker.unitsByRound[this.#round - 1] = tracker.units.size;
    }
  }

  /**
   * One combat, from its declaration to the phase that leaves combat.
   *
   * A Reaction window inside combat is part of resolving it, so the window phase
   * does not close the measurement; a turn boundary does, because a combat the
   * engine never left is a combat that ended with the turn.
   */
  #trackCombat(event: GameEvent): void {
    if (event.type === 'attackers_declared') {
      this.#closeCombat();
      this.#openCombat = {
        turn: this.#turn,
        attackers: event.instanceIds.length,
        blockers: 0,
        resolutionEvents: 1,
      };
      return;
    }

    const open = this.#openCombat;
    if (open === null) return;

    if (event.type === 'turn_started' || event.type === 'match_ended') {
      this.#closeCombat();
      return;
    }
    if (event.type === 'phase_changed' && !COMBAT_PHASES.includes(event.to)) {
      this.#closeCombat();
      return;
    }

    open.resolutionEvents += 1;
    if (event.type === 'blockers_assigned') open.blockers = event.blocks.length;
  }

  #closeCombat(): void {
    const combat = this.#openCombat;
    if (combat === null) return;
    this.#openCombat = null;
    const record: CombatTelemetry = { ...combat };
    // Strictly greater, so a tie resolves to the earliest combat on every
    // machine rather than to whichever one was measured last.
    if (record.attackers > this.#largestCombat.attackers) this.#largestCombat = record;
    if (record.resolutionEvents > this.#longestCombat.resolutionEvents) {
      this.#longestCombat = record;
    }
  }

  #bump(tracker: SeatTracker): void {
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
  }

  #addUnit(playerId: PlayerId, instanceId: string, definitionId: CardId): void {
    const tracker = this.#trackers.get(playerId);
    if (!tracker) return;
    this.#instanceOwner.set(instanceId, playerId);
    this.#instanceDefinition.set(instanceId, definitionId);
    tracker.units.add(instanceId);
    if (
      this.#tokenDefinitions.has(definitionId) ||
      this.#database.get(definitionId)?.type === 'token'
    ) {
      this.#tokenDefinitions.add(definitionId);
      const group = tracker.tokens.get(definitionId) ?? new Set<string>();
      group.add(instanceId);
      tracker.tokens.set(definitionId, group);
    }
    this.#bump(tracker);
  }

  #removeUnit(instanceId: string, reason: string): void {
    const playerId = this.#instanceOwner.get(instanceId);
    if (playerId === undefined) return;
    const tracker = this.#trackers.get(playerId);
    if (!tracker || !tracker.units.has(instanceId)) return;
    tracker.units.delete(instanceId);
    const definitionId = this.#instanceDefinition.get(instanceId);
    if (definitionId !== undefined) tracker.tokens.get(definitionId)?.delete(instanceId);
    tracker.unitsLostAfterPeak += 1;
    tracker.lossReasonsAfterPeak.set(reason, (tracker.lossReasonsAfterPeak.get(reason) ?? 0) + 1);
  }
}

/**
 * The whole log at once, for a caller that already holds it.
 *
 * `actionTurns` is the turn each accepted action was taken on, in order — a
 * spectator replay's decisions, or a simulator run's decision traces. Feeding
 * the same events and the same turns through the streaming collector produces a
 * byte-identical result, which is the property M04's acceptance criterion turns
 * on and `collector.test.ts` asserts on a real match.
 */
export function collectBoardTelemetry(options: {
  readonly finalState: MatchState;
  readonly events: readonly GameEvent[];
  readonly actionTurns: readonly number[];
  readonly database: CardDatabase;
  readonly config: RulesConfig;
  readonly seats: readonly BoardTelemetrySeat[];
}): BoardTelemetry {
  const collector = new BoardTelemetryCollector({
    database: options.database,
    config: options.config,
    seats: options.seats,
  });
  collector.observeEvents(options.events);
  for (const turn of options.actionTurns) collector.observeAction(turn);
  return collector.finish(options.finalState);
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

/** A counting map as a record with sorted keys, so two runs serialize alike. */
function sortedCounts<K extends string>(counts: ReadonlyMap<K, number>): Record<K, number> {
  const sorted = [...counts].sort((left, right) => left[0].localeCompare(right[0]));
  return Object.fromEntries(sorted) as Record<K, number>;
}
