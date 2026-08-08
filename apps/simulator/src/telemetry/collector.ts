import type { CardDatabase, CardId, ZoneId } from '@tcg/card-data';
import type {
  Action,
  GameEvent,
  LegalActions,
  MatchState,
  MatchDeck,
  PlayerId,
} from '@tcg/rules-engine';
import { currentAttack, currentHealth, energyCostOf } from '@tcg/rules-engine';
import type { BotFailure } from '@tcg/bot-interface';
import {
  type CardTelemetry,
  type DeadHandCategory,
  type PlaySnapshot,
  type SeatTelemetry,
} from './schema.js';

/**
 * Collects telemetry *while* the match runs.
 *
 * Reconstructing "what did this card do" from a final board is impossible — the
 * card is usually gone — so every number here is accumulated from the event
 * stream as it is produced, attributed through the causal `sourceInstanceId`
 * the engine already stamps on every event (CLAUDE.md §13.6).
 *
 * Match-local instance IDs are used only to trace causality inside this class.
 * Everything that leaves it is keyed by permanent card definition ID.
 */

const MAX_PLAY_SNAPSHOTS = 8;

interface InstanceTrack {
  readonly instanceId: string;
  readonly definitionId: CardId;
  readonly owner: PlayerId;
  zone: ZoneId;
  zoneSinceTurn: number;
  turnsInHand: number;
  turnsOnBattlefield: number;
  seenInHand: boolean;
  everAffordable: boolean;
  everLegal: boolean;
  used: boolean;
  /**
   * Whether this copy participates in dead-hand accounting.
   *
   * The Commander starts outside the deck and can never be drawn, so calling it
   * `unseen` would put a permanent phantom dead card on every Commander row and
   * make "how often was this card stuck in the deck" unreadable. It still gets a
   * telemetry row for everything it *does* — triggers, damage, attribution.
   */
  countable: boolean;
}

interface CardAccumulator extends Omit<CardTelemetry, 'deadHand' | 'plays'> {
  deadHand: Record<DeadHandCategory, number>;
  plays: PlaySnapshot[];
}

export interface SeatSetup {
  readonly playerId: PlayerId;
  readonly seatIndex: number;
  readonly deckId: string;
  readonly deckHash: string;
  readonly deck: MatchDeck;
  readonly pilotId: string;
  readonly pilotVersion: string;
  readonly pilotConfigHash: string;
  readonly pilotSeed: string;
}

export interface CollectedTelemetry {
  readonly seats: readonly SeatTelemetry[];
  readonly cards: readonly CardTelemetry[];
  readonly decisions: number;
}

export class TelemetryCollector {
  readonly #database: CardDatabase;
  readonly #seats: readonly SeatSetup[];
  readonly #tracks = new Map<string, InstanceTrack>();
  readonly #cards = new Map<string, CardAccumulator>();
  readonly #seatStats = new Map<PlayerId, SeatAccumulator>();
  #turn = 0;
  #decisions = 0;
  #lastTurn = 0;
  #lastActivePlayerId: PlayerId | null = null;

  constructor(database: CardDatabase, seats: readonly SeatSetup[], initial: MatchState) {
    this.#database = database;
    this.#seats = seats;

    for (const seat of seats) {
      this.#seatStats.set(seat.playerId, newSeatAccumulator(initial, seat, database));
      for (const entry of seat.deck.cards) {
        this.#cardRow(seat.playerId, entry.cardId).copiesInDeck += entry.quantity;
      }
    }

    for (const instance of Object.values(initial.instances)) {
      this.#tracks.set(instance.instanceId, {
        instanceId: instance.instanceId,
        definitionId: instance.definitionId,
        owner: instance.owner,
        zone: instance.zone,
        zoneSinceTurn: 0,
        turnsInHand: 0,
        turnsOnBattlefield: 0,
        seenInHand: instance.zone === 'hand',
        everAffordable: false,
        everLegal: false,
        used: false,
        countable: instance.zone !== 'commander_zone',
      });
      if (instance.zone === 'hand') {
        this.#cardRow(instance.owner, instance.definitionId).copiesInOpeningHand += 1;
      }
    }

    this.#lastActivePlayerId = initial.activePlayerId;
  }

  /* --------------------------------------------------------------- ingestion */

  /** Called once per decision, before the pilot chooses. */
  observeDecision(state: MatchState, playerId: PlayerId, legal: LegalActions): void {
    this.#decisions += 1;
    const seat = this.#seatStats.get(playerId);
    if (seat) seat.decisions += 1;

    const player = state.players[playerId];
    if (!player) return;

    const legalIds = new Set(legal.playableCards.map((card) => card.instanceId));
    for (const instanceId of player.hand) {
      const instance = state.instances[instanceId];
      const track = this.#tracks.get(instanceId);
      if (!instance || !track) continue;
      const definition = this.#database.get(instance.definitionId);
      if (!definition) continue;

      const row = this.#cardRow(playerId, instance.definitionId);
      if (energyCostOf(player, definition) <= player.energy) {
        track.everAffordable = true;
        row.affordableOpportunities += 1;
      }
      if (legalIds.has(instanceId)) {
        track.everLegal = true;
        row.playOpportunities += 1;
      }
    }
  }

  /** Called with the accepted action and the state either side of it. */
  observeAction(action: Action, before: MatchState, after: MatchState): void {
    const seat = this.#seatStats.get(action.playerId);

    switch (action.type) {
      case 'play_card': {
        const instance = before.instances[action.instanceId];
        if (!instance) break;
        const row = this.#cardRow(action.playerId, instance.definitionId);
        const track = this.#tracks.get(action.instanceId);
        if (track) track.used = true;
        if (row.plays.length < MAX_PLAY_SNAPSHOTS) {
          row.plays.push(snapshot(before, after, action.playerId, this.#database));
        }
        break;
      }
      case 'activate_ability': {
        const instance = before.instances[action.sourceInstanceId];
        if (!instance) break;
        this.#cardRow(instance.owner, instance.definitionId).timesActivated += 1;
        const track = this.#tracks.get(action.sourceInstanceId);
        if (track) track.used = true;
        if (seat) seat.abilitiesActivated += 1;
        break;
      }
      case 'submit_choice':
        if (seat) seat.choicesResolved += 1;
        break;
      case 'mulligan': {
        for (const instanceId of action.returnInstanceIds) {
          const track = this.#tracks.get(instanceId);
          if (!track) continue;
          this.#cardRow(track.owner, track.definitionId).copiesMulliganedAway += 1;
        }
        break;
      }
      default:
        break;
    }

    this.#observeTurnBoundary(after);
  }

  /** Called with every event the action produced, in order. */
  observeEvents(events: readonly GameEvent[], after: MatchState): void {
    for (const event of events) this.#observeEvent(event, after);
  }

  #observeEvent(event: GameEvent, state: MatchState): void {
    const sourceRow = this.#rowForSource(event.cause.sourceInstanceId);

    switch (event.type) {
      case 'turn_started':
        this.#turn = event.turn;
        break;

      case 'card_drawn': {
        if (event.instanceId === null) break;
        this.#moveInstance(event.instanceId, 'hand', state);
        const track = this.#tracks.get(event.instanceId);
        if (!track) break;
        const row = this.#cardRow(track.owner, track.definitionId);
        row.timesDrawn += 1;
        row.firstSeenTurn ??= this.#turn;
        this.#seatStats.get(event.playerId)?.tallyDraw();
        break;
      }

      case 'card_moved':
        this.#moveInstance(event.instanceId, event.toZone, state);
        break;

      case 'card_discarded': {
        this.#moveInstance(event.instanceId, 'discard', state);
        const track = this.#tracks.get(event.instanceId);
        // Deliberately *not* marked used: a card pitched to the hand-size limit
        // is the textbook `legal_but_unchosen` case, and calling it "used" would
        // hide exactly the signal the dead-hand categories exist to expose
        // (CLAUDE.md §13.6). Paying a discard cost is recorded through the
        // activation that spent it.
        if (track) this.#cardRow(track.owner, track.definitionId).timesDiscarded += 1;
        this.#seatStats.get(event.playerId)?.tallyDiscard();
        if (sourceRow) sourceRow.cardsDiscardedBy += 1;
        break;
      }

      case 'card_played': {
        const row = this.#cardRow(event.playerId, event.definitionId);
        row.timesPlayed += 1;
        row.energySpent += event.energySpent;
        const seat = this.#seatStats.get(event.playerId);
        if (seat) {
          seat.cardsPlayed += 1;
          seat.energySpent += event.energySpent;
        }
        break;
      }

      case 'unit_deployed':
        this.#moveInstance(event.instanceId, 'battlefield', state);
        this.#seatStats.get(event.playerId)?.tallyUnitDeployed();
        break;

      case 'relic_deployed':
        this.#moveInstance(event.instanceId, 'battlefield', state);
        this.#seatStats.get(event.playerId)?.tallyRelicDeployed();
        break;

      case 'token_created': {
        this.#registerInstance(event.instanceId, event.definitionId, event.playerId, 'battlefield');
        this.#seatStats.get(event.playerId)?.tallyToken();
        if (sourceRow) sourceRow.tokensCreated += 1;
        break;
      }

      case 'damage_dealt': {
        if (event.targetPlayerId !== null) {
          if (sourceRow) sourceRow.damageToPlayers += event.amount;
          const attacker = this.#ownerOf(event.cause.sourceInstanceId);
          if (attacker && attacker !== event.targetPlayerId) {
            this.#seatStats.get(attacker)?.tallyDamageDealt(event.amount);
          }
        }
        if (event.targetInstanceId !== null) {
          if (sourceRow) sourceRow.damageToUnits += event.amount;
          if (event.lethal && sourceRow) sourceRow.unitsRemoved += 1;
        }
        break;
      }

      case 'player_damaged':
        this.#seatStats.get(event.playerId)?.tallyDamageTaken(event.amount);
        break;

      case 'player_healed':
        this.#seatStats.get(event.playerId)?.tallyHealed(event.amount);
        if (sourceRow) sourceRow.healingDone += event.amount;
        break;

      case 'healed':
        if (sourceRow) sourceRow.healingDone += event.amount;
        break;

      case 'unit_defeated': {
        const track = this.#tracks.get(event.instanceId);
        if (track) {
          const row = this.#cardRow(track.owner, track.definitionId);
          row.timesDefeated += 1;
          if (event.reason === 'sacrificed') row.timesSacrificed += 1;
          // Already on the battlefield, so it was played or created: `used` is
          // set at that point and dying does not change it.
        }
        this.#seatStats.get(event.controllerId)?.tallyUnitLost();
        break;
      }

      case 'attackers_declared': {
        for (const attack of event.attacks) {
          const track = this.#tracks.get(attack.attackerInstanceId);
          if (track) this.#cardRow(track.owner, track.definitionId).attacksMade += 1;
        }
        this.#seatStats.get(event.playerId)?.tallyAttacks(event.attacks.length);
        break;
      }

      case 'blockers_assigned': {
        for (const block of event.blocks) {
          const track = this.#tracks.get(block.blockerInstanceId);
          if (track) {
            const row = this.#cardRow(track.owner, track.definitionId);
            row.blocksMade += 1;
            this.#seatStats.get(track.owner)?.tallyBlock();
          }
        }
        break;
      }

      case 'trigger_queued': {
        const track = this.#tracks.get(event.sourceInstanceId);
        if (track) this.#cardRow(track.owner, track.definitionId).triggersFired += 1;
        break;
      }

      default:
        break;
    }
  }

  /* ---------------------------------------------------------------- finishing */

  finish(state: MatchState, failures: readonly BotFailure[]): CollectedTelemetry {
    void failures;

    // Flush the time every surviving card spent where it ended up.
    for (const track of this.#tracks.values()) {
      this.#accrueZoneTime(track, this.#turn);
      const row = this.#cardRow(track.owner, track.definitionId);
      row.turnsHeldInHand += track.turnsInHand;
      row.turnsOnBattlefield += track.turnsOnBattlefield;

      switch (track.zone) {
        case 'hand':
          row.endedInHand += 1;
          break;
        case 'battlefield':
          row.endedOnBattlefield += 1;
          break;
        case 'deck':
          row.endedInDeck += 1;
          break;
        case 'discard':
          row.endedInDiscard += 1;
          break;
        case 'removed':
          row.timesRemoved += 1;
          break;
        default:
          break;
      }

      if (track.countable) row.deadHand[classify(track)] += 1;
    }

    const seats = this.#seats.map((seat) => {
      const accumulator = this.#seatStats.get(seat.playerId);
      const player = state.players[seat.playerId];
      if (!accumulator || !player) throw new Error(`Missing seat telemetry for ${seat.playerId}`);
      return accumulator.toRecord(state, player.health);
    });

    const cards = [...this.#cards.values()]
      .map((row): CardTelemetry => ({
        ...row,
        deadHand: { ...row.deadHand },
        plays: [...row.plays],
      }))
      // Stable order so two runs produce byte-identical records.
      .sort((left, right) => {
        const seat = left.playerId.localeCompare(right.playerId);
        return seat !== 0 ? seat : left.definitionId.localeCompare(right.definitionId);
      });

    return { seats, cards, decisions: this.#decisions };
  }

  /* ------------------------------------------------------------------ helpers */

  #cardRow(playerId: PlayerId, definitionId: CardId): CardAccumulator {
    const key = `${playerId}§${definitionId}`;
    let row = this.#cards.get(key);
    if (!row) {
      row = emptyCardRow(playerId, definitionId);
      this.#cards.set(key, row);
    }
    return row;
  }

  #rowForSource(instanceId: string | null): CardAccumulator | null {
    if (instanceId === null) return null;
    const track = this.#tracks.get(instanceId);
    if (!track) return null;
    return this.#cardRow(track.owner, track.definitionId);
  }

  #ownerOf(instanceId: string | null): PlayerId | null {
    if (instanceId === null) return null;
    return this.#tracks.get(instanceId)?.owner ?? null;
  }

  #registerInstance(instanceId: string, definitionId: CardId, owner: PlayerId, zone: ZoneId): void {
    if (this.#tracks.has(instanceId)) {
      this.#moveInstanceTrack(instanceId, zone);
      return;
    }
    this.#tracks.set(instanceId, {
      instanceId,
      definitionId,
      owner,
      zone,
      zoneSinceTurn: this.#turn,
      turnsInHand: 0,
      turnsOnBattlefield: 0,
      seenInHand: zone === 'hand',
      everAffordable: false,
      everLegal: false,
      used: true,
      countable: true,
    });
  }

  #moveInstance(instanceId: string, zone: ZoneId, state: MatchState): void {
    if (!this.#tracks.has(instanceId)) {
      const instance = state.instances[instanceId];
      if (!instance) return;
      this.#registerInstance(instanceId, instance.definitionId, instance.owner, zone);
      return;
    }
    this.#moveInstanceTrack(instanceId, zone);
  }

  #moveInstanceTrack(instanceId: string, zone: ZoneId): void {
    const track = this.#tracks.get(instanceId);
    if (!track || track.zone === zone) return;
    this.#accrueZoneTime(track, this.#turn);
    track.zone = zone;
    track.zoneSinceTurn = this.#turn;
    if (zone === 'hand') track.seenInHand = true;
  }

  #accrueZoneTime(track: InstanceTrack, turn: number): void {
    const elapsed = Math.max(0, turn - track.zoneSinceTurn);
    if (track.zone === 'hand') track.turnsInHand += elapsed;
    if (track.zone === 'battlefield') track.turnsOnBattlefield += elapsed;
    track.zoneSinceTurn = turn;
  }

  /** Energy a seat left on the table is only knowable as its turn ends. */
  #observeTurnBoundary(state: MatchState): void {
    if (state.turn === this.#lastTurn) {
      this.#lastActivePlayerId = state.activePlayerId;
      return;
    }
    const previous = this.#lastActivePlayerId;
    if (previous !== null) {
      const leftover = state.players[previous]?.energy ?? 0;
      this.#seatStats.get(previous)?.tallyUnspentEnergy(leftover);
    }
    this.#lastTurn = state.turn;
    this.#lastActivePlayerId = state.activePlayerId;
  }
}

/* ------------------------------------------------------------ dead-hand rules */

/**
 * Which dead-hand category a copy fell into (CLAUDE.md §13.6).
 *
 * The order matters and is the point of the categorisation: a card that never
 * left the deck is `unseen`, not dead in hand; a card the pilot could have
 * played and did not is `legal_but_unchosen`, which is a statement about the
 * pilot, not about the card.
 */
function classify(track: InstanceTrack): DeadHandCategory {
  if (track.used) return 'used';
  if (!track.seenInHand) return 'unseen';
  if (!track.everAffordable) return 'never_affordable';
  if (!track.everLegal) return 'no_legal_window';
  return 'legal_but_unchosen';
}

/* --------------------------------------------------------------- board features */

function boardStats(state: MatchState, playerId: PlayerId, database: CardDatabase): number {
  const player = state.players[playerId];
  if (!player) return 0;
  let total = 0;
  for (const instanceId of player.units) {
    if (instanceId === null) continue;
    const instance = state.instances[instanceId];
    if (!instance) continue;
    const definition = database.get(instance.definitionId);
    if (!definition) continue;
    total += currentAttack(instance, definition) + currentHealth(instance, definition);
  }
  return total;
}

function unitCount(state: MatchState, playerId: PlayerId): number {
  return (state.players[playerId]?.units ?? []).filter((id) => id !== null).length;
}

function opponentStats(state: MatchState, playerId: PlayerId, database: CardDatabase): number {
  return state.seatOrder
    .filter((id) => id !== playerId)
    .reduce((sum, id) => sum + boardStats(state, id, database), 0);
}

function lowestOpponentHealth(state: MatchState, playerId: PlayerId): number {
  const healths = state.seatOrder
    .filter((id) => id !== playerId && state.players[id]?.lost === false)
    .map((id) => state.players[id]?.health ?? 0);
  return healths.length === 0 ? 0 : Math.min(...healths);
}

function snapshot(
  before: MatchState,
  after: MatchState,
  playerId: PlayerId,
  database: CardDatabase,
): PlaySnapshot {
  const energyBefore = before.players[playerId]?.energy ?? 0;
  const energyAfter = after.players[playerId]?.energy ?? 0;
  return {
    turn: before.turn,
    energyBefore,
    energySpent: Math.max(0, energyBefore - energyAfter),
    handSizeBefore: before.players[playerId]?.hand.length ?? 0,
    ownUnitsBefore: unitCount(before, playerId),
    ownUnitsAfter: unitCount(after, playerId),
    ownStatsBefore: boardStats(before, playerId, database),
    ownStatsAfter: boardStats(after, playerId, database),
    opponentStatsBefore: opponentStats(before, playerId, database),
    opponentStatsAfter: opponentStats(after, playerId, database),
    ownHealthBefore: before.players[playerId]?.health ?? 0,
    lowestOpponentHealthBefore: lowestOpponentHealth(before, playerId),
    lowestOpponentHealthAfter: lowestOpponentHealth(after, playerId),
  };
}

/* --------------------------------------------------------------- accumulators */

function emptyCardRow(playerId: PlayerId, definitionId: CardId): CardAccumulator {
  return {
    playerId,
    definitionId,
    copiesInDeck: 0,
    copiesInOpeningHand: 0,
    copiesMulliganedAway: 0,
    timesDrawn: 0,
    firstSeenTurn: null,
    turnsHeldInHand: 0,
    turnsOnBattlefield: 0,
    playOpportunities: 0,
    affordableOpportunities: 0,
    timesPlayed: 0,
    timesActivated: 0,
    timesDiscarded: 0,
    timesSacrificed: 0,
    timesDefeated: 0,
    timesRemoved: 0,
    timesReturnedToHand: 0,
    energySpent: 0,
    attacksMade: 0,
    blocksMade: 0,
    damageToPlayers: 0,
    damageToUnits: 0,
    healingDone: 0,
    cardsDrawnBy: 0,
    cardsDiscardedBy: 0,
    tokensCreated: 0,
    unitsRemoved: 0,
    triggersFired: 0,
    endedInHand: 0,
    endedOnBattlefield: 0,
    endedInDeck: 0,
    endedInDiscard: 0,
    deadHand: {
      unseen: 0,
      never_affordable: 0,
      no_legal_window: 0,
      legal_but_unchosen: 0,
      used: 0,
    },
    plays: [],
  };
}

class SeatAccumulator {
  cardsDrawn = 0;
  cardsPlayed = 0;
  cardsDiscarded = 0;
  energySpent = 0;
  energyUnspentAtTurnEnd = 0;
  unitsDeployed = 0;
  relicsDeployed = 0;
  tokensCreated = 0;
  unitsLost = 0;
  attacksDeclared = 0;
  blocksAssigned = 0;
  abilitiesActivated = 0;
  choicesResolved = 0;
  decisions = 0;
  damageDealtToPlayers = 0;
  damageTaken = 0;
  healingReceived = 0;

  // Written out longhand rather than as constructor parameter properties: the
  // simulator's worker threads run under Node's erasable-syntax-only TypeScript
  // support, which cannot strip a parameter property (see `workers/pool.ts`).
  readonly #seat: SeatSetup;
  readonly #startingHealth: number;
  readonly #commanderId: CardId;
  readonly #colors: readonly string[];

  constructor(
    seat: SeatSetup,
    startingHealth: number,
    commanderId: CardId,
    colors: readonly string[],
  ) {
    this.#seat = seat;
    this.#startingHealth = startingHealth;
    this.#commanderId = commanderId;
    this.#colors = colors;
  }

  tallyDraw(): void {
    this.cardsDrawn += 1;
  }
  tallyDiscard(): void {
    this.cardsDiscarded += 1;
  }
  tallyUnitDeployed(): void {
    this.unitsDeployed += 1;
  }
  tallyRelicDeployed(): void {
    this.relicsDeployed += 1;
  }
  tallyToken(): void {
    this.tokensCreated += 1;
  }
  tallyUnitLost(): void {
    this.unitsLost += 1;
  }
  tallyAttacks(count: number): void {
    this.attacksDeclared += count;
  }
  tallyBlock(): void {
    this.blocksAssigned += 1;
  }
  tallyDamageDealt(amount: number): void {
    this.damageDealtToPlayers += amount;
  }
  tallyDamageTaken(amount: number): void {
    this.damageTaken += amount;
  }
  tallyHealed(amount: number): void {
    this.healingReceived += amount;
  }
  tallyUnspentEnergy(amount: number): void {
    this.energyUnspentAtTurnEnd += amount;
  }

  toRecord(state: MatchState, endingHealth: number): SeatTelemetry {
    const player = state.players[this.#seat.playerId];
    return {
      playerId: this.#seat.playerId,
      seatIndex: this.#seat.seatIndex,
      deckId: this.#seat.deckId,
      deckHash: this.#seat.deckHash,
      commanderId: this.#commanderId,
      colors: [...this.#colors],
      pilotId: this.#seat.pilotId,
      pilotVersion: this.#seat.pilotVersion,
      pilotConfigHash: this.#seat.pilotConfigHash,
      pilotSeed: this.#seat.pilotSeed,

      won: state.result?.winnerId === this.#seat.playerId,
      lost: player?.lost ?? false,
      lossReason: player?.lossReason ?? null,
      eliminatedOnTurn: player?.eliminatedOnTurn ?? null,

      startingHealth: this.#startingHealth,
      endingHealth,
      damageDealtToPlayers: this.damageDealtToPlayers,
      damageTaken: this.damageTaken,
      healingReceived: this.healingReceived,

      cardsDrawn: this.cardsDrawn,
      cardsPlayed: this.cardsPlayed,
      cardsDiscarded: this.cardsDiscarded,
      energySpent: this.energySpent,
      energyUnspentAtTurnEnd: this.energyUnspentAtTurnEnd,
      unitsDeployed: this.unitsDeployed,
      relicsDeployed: this.relicsDeployed,
      tokensCreated: this.tokensCreated,
      unitsLost: this.unitsLost,
      attacksDeclared: this.attacksDeclared,
      blocksAssigned: this.blocksAssigned,
      abilitiesActivated: this.abilitiesActivated,
      choicesResolved: this.choicesResolved,
      decisions: this.decisions,
    };
  }
}

function newSeatAccumulator(
  state: MatchState,
  seat: SeatSetup,
  database: CardDatabase,
): SeatAccumulator {
  const player = state.players[seat.playerId];
  const commander = database.get(seat.deck.commanderId);
  return new SeatAccumulator(
    seat,
    player?.health ?? 0,
    seat.deck.commanderId,
    commander?.colorIdentity ?? [],
  );
}
