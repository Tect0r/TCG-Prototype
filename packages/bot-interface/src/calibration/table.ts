import {
  bundledPrecon,
  loadBundledCardData,
  type CardDatabase,
  type CardDefinition,
  type CardId,
  type KeywordId,
} from '@tcg/card-data';
import {
  DEFAULT_RULES_CONFIG,
  effectiveKeywords,
  legalActions,
  playerView,
  type Action,
  type ActionInput,
  type ApplyContext,
  type InstanceId,
  type MatchDeck,
  type MatchPhase,
  type MatchState,
  type PlayerId,
  type RulesConfig,
} from '@tcg/rules-engine';
import {
  apply,
  deployCommander,
  deployRelic,
  deployUnit,
  giveCard,
  giveDiscard,
  keepAllHands,
  setEnergy,
  setHealth,
  stackDeck,
  startTable,
} from '@tcg/rules-engine/test-fixtures';
import type { BotDecision, BotObservation, BotPolicy, DecisionFamily } from '../types.js';

/**
 * The table a tactical calibration fixture is played on (M05.6).
 *
 * Deliberately close in shape to the engine's own `ContractTable`, and
 * deliberately not the same object. A card behaviour contract asks "did the
 * engine do what the card says"; a calibration fixture asks "given a board a
 * person would recognise, did the pilot make the decision a person would make".
 * The first answers its own questions with a fixed policy. This one hands every
 * question to the pilot under test, through the same redacted `PlayerView` and
 * engine-computed `LegalActions` a networked bot would receive — so a fixture
 * cannot accidentally calibrate a pilot against information no seat can see.
 *
 * The arrangement helpers come from `@tcg/rules-engine/test-fixtures` rather
 * than being written again here: a board a fixture builds has to be a board the
 * engine could have produced, and there is exactly one definition of that.
 */

/** Both seats start solvent unless a fixture is specifically about affordability. */
const FIXTURE_ENERGY = 10;

/** How many decisions a fixture may draw out of a pilot before it is a loop. */
const DECISION_LIMIT = 40;

export interface AskedDecision {
  /** Which seat was asked. Always `self` for a recorded decision. */
  readonly playerId: PlayerId;
  readonly family: DecisionFamily;
  readonly action: Action;
  /** The pilot's own stable key for what it chose, from its diagnostics. */
  readonly key: string;
  /** Every key it was choosing between, so a near-miss is legible. */
  readonly candidateKeys: readonly string[];
  /** True when the pilot's own generator, not its scores, picked this. */
  readonly brokeTie: boolean;
}

export interface TableOptions {
  /** The precon whose Commander and 40 cards every seat runs. */
  readonly preconId: string;
  readonly database?: CardDatabase;
  readonly config?: RulesConfig;
  /** Starting Energy for every seat. */
  readonly energy?: number;
  /**
   * How many seats the table holds. Two unless a fixture is about a decision
   * that only exists with more (M09.14).
   *
   * "Which opponent do I aim this at" is exactly such a decision: with one
   * opponent there is no choice to get wrong, so a multiplayer targeting fixture
   * cannot be posed on a two-seat table at all. Everything else stays as it was —
   * the pilot is `player_1`, the scripted opponent script answers for every other
   * seat, and `foe` still names the first of them.
   */
  readonly seats?: number;
}

let cachedDatabase: CardDatabase | undefined;

export function calibrationDatabase(): CardDatabase {
  cachedDatabase ??= loadBundledCardData().database;
  return cachedDatabase;
}

/** The precon's own list as a match deck: singleton, Commander outside it. */
export function preconMatchDeck(preconId: string): MatchDeck {
  const precon = bundledPrecon(preconId);
  if (!precon) throw new Error(`No bundled precon "${preconId}".`);
  return {
    commanderId: precon.commanderId,
    cards: precon.cardIds.map((cardId) => ({ cardId, quantity: 1 })),
  };
}

export class CalibrationTable {
  readonly context: ApplyContext;
  /** The pilot under test. Always the active player on turn 1. */
  readonly self: PlayerId = 'player_1';
  readonly foe: PlayerId = 'player_2';
  /** The third seat, on a table that has one. `null` on a two-seat table. */
  readonly otherFoe: PlayerId | null;
  readonly preconId: string;

  state: MatchState;
  private readonly recorded: AskedDecision[] = [];

  private constructor(
    state: MatchState,
    context: ApplyContext,
    preconId: string,
    otherFoe: PlayerId | null,
  ) {
    this.state = state;
    this.context = context;
    this.preconId = preconId;
    this.otherFoe = otherFoe;
  }

  static open(options: TableOptions): CalibrationTable {
    const database = options.database ?? calibrationDatabase();
    const config = options.config ?? DEFAULT_RULES_CONFIG;
    const context: ApplyContext = { database, config };

    // Every seat runs the precon, so a fixture about one deck's characteristic
    // decision is played against the kind of board that deck actually meets.
    const deck = preconMatchDeck(options.preconId);
    const seats = options.seats ?? 2;
    if (seats < 2 || seats > 4) {
      throw new Error(`A calibration table holds two to four seats, not ${seats}.`);
    }
    const state = keepAllHands(startTable(seats, { database, config, deck }), context);

    const table = new CalibrationTable(
      state,
      context,
      options.preconId,
      seats > 2 ? 'player_3' : null,
    );
    // The opening hands are dealt from a shuffled deck, so they are noise a
    // fixture never wanted: every card the pilot is holding has to be one the
    // fixture put there. They go to the bottom of the deck rather than being
    // deleted, so deck size — and therefore the deck-out clock — stays honest.
    const energy = options.energy ?? FIXTURE_ENERGY;
    for (const playerId of table.state.seatOrder) {
      table.buryHand(playerId);
      table.state = setEnergy(table.state, playerId, energy);
    }
    return table;
  }

  /* ------------------------------------------------------------ arrangement */

  /** Puts a card in a seat's hand and returns its instance. */
  give(cardId: CardId, playerId: PlayerId = this.self): InstanceId {
    const placed = giveCard(this.state, playerId, cardId);
    this.state = placed.state;
    return placed.instanceId;
  }

  /** Puts a card in a seat's discard pile. */
  bury(cardId: CardId, playerId: PlayerId = this.self): InstanceId {
    const placed = giveDiscard(this.state, playerId, cardId);
    this.state = placed.state;
    return placed.instanceId;
  }

  /** Puts a Unit onto the battlefield, ready and past Newly Deployed. */
  board(
    cardId: CardId,
    playerId: PlayerId = this.self,
    options: { readonly exhausted?: boolean; readonly summoningSick?: boolean } = {},
  ): InstanceId {
    const placed = deployUnit(this.state, playerId, cardId, options);
    this.state = placed.state;
    return placed.instanceId;
  }

  /** Puts a Token onto the battlefield without a card having created it. */
  token(cardId: CardId, playerId: PlayerId = this.self): InstanceId {
    const instanceId = this.board(cardId, playerId);
    const instance = this.state.instances[instanceId];
    if (instance) instance.isToken = true;
    return instanceId;
  }

  boardRelic(cardId: CardId, playerId: PlayerId = this.self): InstanceId {
    const placed = deployRelic(this.state, playerId, cardId);
    this.state = placed.state;
    return placed.instanceId;
  }

  boardCommander(playerId: PlayerId = this.self): InstanceId {
    const placed = deployCommander(this.state, playerId);
    this.state = placed.state;
    return placed.instanceId;
  }

  stack(cardIds: readonly CardId[], playerId: PlayerId = this.self): void {
    this.state = stackDeck(this.state, playerId, cardIds);
  }

  energy(value: number, playerId: PlayerId = this.self): void {
    this.state = setEnergy(this.state, playerId, value);
  }

  health(value: number, playerId: PlayerId = this.self): void {
    this.state = setHealth(this.state, playerId, value);
  }

  exhaust(instanceId: InstanceId): void {
    const instance = this.state.instances[instanceId];
    if (!instance) throw new Error(`No instance ${instanceId}`);
    instance.exhausted = true;
  }

  /**
   * Moves a seat's whole hand to the bottom of its deck.
   *
   * Not a deletion: the cards are still in the match, so the deck-out clock and
   * every "cards remaining" reading stay true. It is the one arrangement step
   * with no counterpart in the engine's own fixtures, because only a pilot
   * fixture cares that the hand contains *nothing it did not put there*.
   */
  private buryHand(playerId: PlayerId): void {
    const player = this.state.players[playerId];
    if (!player) throw new Error(`No player ${playerId}`);
    for (const instanceId of [...player.hand]) {
      const instance = this.state.instances[instanceId];
      if (!instance) continue;
      instance.zone = 'deck';
      player.deck.push(instanceId);
    }
    player.hand = [];
  }

  /* ----------------------------------------------------------------- acting */

  /**
   * Applies an action nobody is being calibrated on. Scenery, not a decision.
   *
   * A fixture uses this to put the match *at* the moment it is about — the
   * opponent's attack, the Spell that opens a Reaction window — and it fails
   * loudly rather than silently skipping if the engine refuses.
   */
  act(action: ActionInput): void {
    this.state = apply(this.state, action, this.context);
  }

  /** Passes phases until `phase` is reached, from the seat that may pass. */
  toPhase(phase: MatchPhase, playerId: PlayerId = this.state.activePlayerId): void {
    for (let guard = 0; guard < 8 && this.state.phase !== phase; guard += 1) {
      this.act({ type: 'pass_phase', playerId });
    }
    if (this.state.phase !== phase) {
      throw new Error(`Could not reach phase "${phase}"; stuck in "${this.state.phase}".`);
    }
  }

  /* ---------------------------------------------------------------- asking */

  /**
   * The observation the seat would be handed right now.
   *
   * Public because a fixture occasionally asserts on what the pilot *could* see
   * — that a target it should have preferred was on the menu at all — and doing
   * that through anything but the redacted view would prove nothing.
   */
  observationFor(playerId: PlayerId): BotObservation {
    const { database, config } = this.context;
    const rulesConfig = config ?? DEFAULT_RULES_CONFIG;
    const view = playerView(this.state, playerId, database, rulesConfig);
    return {
      view,
      legal: legalActions(this.state, playerId, { database, config: rulesConfig }),
      history: view.log,
      database,
      rulesConfig,
      decisionIndex: this.recorded.length,
    };
  }

  /**
   * Whose decision the engine is waiting on, mirroring the engine's own order.
   *
   * `null` when the match is over or nobody can act, which is a fixture bug
   * rather than a pilot result and is reported as one.
   */
  seatToAct(): PlayerId | null {
    const state = this.state;
    if (state.status === 'complete') return null;
    if (state.pendingChoice) return state.pendingChoice.playerId;
    const awaiting = state.combat.awaitingDefenders[0];
    if (state.phase === 'assign_blockers' && awaiting !== undefined) return awaiting;
    const window = state.reactionWindow;
    if (window && !window.closed) {
      return window.priorityOrder[window.priorityIndex] ?? null;
    }
    return state.activePlayerId;
  }

  /**
   * Asks the pilot for exactly one decision, applies it, and records it.
   *
   * Every decision the *opponent* is asked for on the way is answered by
   * `foeAnswer` below, which never plays a card: the seat opposite a calibration
   * fixture is scenery, and a scripted opponent is what makes the fixture's
   * board the same board for every pilot.
   */
  ask(pilot: BotPolicy, rng: BotRng): AskedDecision {
    for (let guard = 0; guard < DECISION_LIMIT; guard += 1) {
      const seat = this.seatToAct();
      if (seat === null) {
        throw new Error(`The fixture ran out of decisions before "${pilot.id}" was asked.`);
      }
      if (seat !== this.self) {
        this.answerOnScript(seat);
        continue;
      }
      const observation = this.observationFor(seat);
      const decided = pilot.decide(observation, rng.state);
      if (isThenable(decided)) {
        // Every built-in pilot is synchronous. A fixture is a synchronous script
        // by design — its assertions read the board straight after the decision —
        // so an asynchronous pilot is refused rather than silently awaited into
        // a different ordering.
        throw new Error(
          `Pilot "${pilot.id}" decides asynchronously; fixtures require a sync pilot.`,
        );
      }
      rng.state = decided.rng;
      const record: AskedDecision = {
        playerId: seat,
        family: decided.diagnostics?.family ?? familyOf(decided.action),
        action: decided.action,
        key: decided.diagnostics?.chosenKey ?? decided.action.type,
        candidateKeys: decided.diagnostics?.scores.map((entry) => entry.key) ?? [],
        brokeTie: decided.diagnostics?.brokeTie ?? false,
      };
      this.recorded.push(record);
      this.state = apply(this.state, decided.action, this.context);
      return record;
    }
    throw new Error(`The opponent seat never handed priority back to "${pilot.id}".`);
  }

  /**
   * Asks the pilot repeatedly until it passes the phase, or `limit` decisions.
   *
   * This is what a sequencing fixture needs: the decision under test is not one
   * action but the *order* of several, and the order only exists once the pilot
   * has finished with the turn.
   */
  /**
   * Asks the pilot until it makes a decision of `family`, or gives up the turn.
   *
   * A targeting fixture is about the answer to a choice, and a choice only
   * exists once the pilot has played the card that asks it. Making the fixture
   * name each intervening decision would make it a script rather than a
   * question — and would break the moment a pilot legitimately deployed its
   * Commander first. Returns `null` when the pilot passed without ever being
   * asked, which is itself an answer: it declined to use the card.
   */
  askUntilFamily(
    pilot: BotPolicy,
    rng: BotRng,
    family: DecisionFamily,
    limit = 12,
  ): AskedDecision | null {
    for (let step = 0; step < limit; step += 1) {
      const decision = this.ask(pilot, rng);
      if (decision.family === family) return decision;
      if (decision.action.type === 'pass_phase') return null;
    }
    return null;
  }

  askUntilPass(pilot: BotPolicy, rng: BotRng, limit = 12): AskedDecision[] {
    const taken: AskedDecision[] = [];
    for (let step = 0; step < limit; step += 1) {
      const decision = this.ask(pilot, rng);
      taken.push(decision);
      if (decision.action.type === 'pass_phase') return taken;
    }
    return taken;
  }

  /**
   * Hands the turn on until `playerId` is the active seat in its Main Phase.
   *
   * Every step on the way is taken on the fixed script below, for **both**
   * seats, because none of it is the decision under test: a fixture that needs
   * the opponent's turn wants the board that turn produces and nothing else.
   * The pilot is asked no questions here, which is deliberate and is why the
   * fixtures that use it say so.
   */
  handTurnTo(playerId: PlayerId): void {
    for (let guard = 0; guard < 60; guard += 1) {
      if (this.state.activePlayerId === playerId && this.state.phase === 'main_1') return;
      const seat = this.seatToAct();
      if (seat === null) break;
      this.answerOnScript(seat);
    }
    throw new Error(
      `The turn never reached ${playerId}'s Main Phase; ` +
        `active is ${this.state.activePlayerId} in "${this.state.phase}".`,
    );
  }

  /**
   * The fixed script: never play a card, and never choose badly on purpose.
   *
   * Passing, declining to attack, declining to block and taking the first legal
   * answer to a choice are all decisions no fixture is measuring, and pinning
   * them means the board a pilot is asked about is decided by the fixture rather
   * than by whichever policy happened to be sitting opposite.
   */
  private answerOnScript(seat: PlayerId): void {
    const choice = this.state.pendingChoice;
    if (choice && choice.playerId === seat) {
      this.act({
        type: 'submit_choice',
        playerId: seat,
        choiceId: choice.id,
        selectedIds: [...defaultAnswer(choice)],
      });
      return;
    }
    const window = this.state.reactionWindow;
    if (window && !window.closed) {
      this.act({ type: 'pass_reaction', playerId: seat });
      return;
    }
    if (this.state.phase === 'declare_attackers') {
      this.act({ type: 'declare_attackers', playerId: seat, attacks: [] });
      return;
    }
    if (this.state.phase === 'assign_blockers') {
      this.act({ type: 'assign_blockers', playerId: seat, blocks: [] });
      return;
    }
    this.act({ type: 'pass_phase', playerId: seat });
  }

  /* ------------------------------------------------------------- inspection */

  /** Every decision this table has drawn out of the pilot, in order. */
  decisions(): readonly AskedDecision[] {
    return this.recorded;
  }

  definitionOf(instanceId: InstanceId): CardDefinition {
    const instance = this.state.instances[instanceId];
    if (!instance) throw new Error(`No instance ${instanceId}`);
    return this.context.database.getOrThrow(instance.definitionId);
  }

  /** True when the engine still knows this instance at all. */
  exists(instanceId: InstanceId): boolean {
    return this.state.instances[instanceId] !== undefined;
  }

  zoneOf(instanceId: InstanceId): string {
    const instance = this.state.instances[instanceId];
    return instance ? instance.zone : 'gone';
  }

  /** True when the instance is gone, or in any zone other than the battlefield. */
  offBoard(instanceId: InstanceId): boolean {
    return this.zoneOf(instanceId) !== 'battlefield';
  }

  unitCount(playerId: PlayerId = this.self): number {
    return this.state.players[playerId]?.units.length ?? 0;
  }

  /** Instance IDs on a seat's battlefield whose definition is `cardId`. */
  unitsOf(cardId: CardId, playerId: PlayerId = this.self): InstanceId[] {
    const units = this.state.players[playerId]?.units ?? [];
    return units.filter((id) => this.state.instances[id]?.definitionId === cardId);
  }

  /** The one instance of `cardId` a seat controls, or `null` if it is not there. */
  onlyUnitOf(cardId: CardId, playerId: PlayerId = this.self): InstanceId | null {
    const found = this.unitsOf(cardId, playerId);
    return found.length === 1 ? (found[0] as InstanceId) : null;
  }

  hasKeyword(instanceId: InstanceId, keyword: KeywordId): boolean {
    const instance = this.state.instances[instanceId];
    if (!instance) return false;
    return effectiveKeywords(instance, this.definitionOf(instanceId)).has(keyword);
  }

  handSize(playerId: PlayerId = this.self): number {
    return this.state.players[playerId]?.hand.length ?? 0;
  }
}

/** A mutable generator handle, so a fixture can be re-run from the same seed. */
export interface BotRng {
  state: Parameters<BotPolicy['decide']>[1];
}

/** The instructions a `submit_choice` needs when nobody is being measured. */
function defaultAnswer(choice: NonNullable<MatchState['pendingChoice']>): readonly string[] {
  if (choice.ordered) return choice.validEntityIds;
  if (choice.type === 'confirm') return ['no'];
  if (choice.type === 'divide_damage') {
    const first = choice.validEntityIds[0];
    if (first === undefined) return [];
    return Array.from({ length: choice.minimum }, () => first);
  }
  const take = Math.max(choice.minimum, Math.min(choice.maximum, choice.validEntityIds.length));
  return choice.validEntityIds.slice(0, take);
}

/** Fallback for a pilot that returns no diagnostics — `random_legal` does not. */
function familyOf(action: Action): DecisionFamily {
  return action.type as DecisionFamily;
}

/**
 * The blockers a block decision actually assigned, in the pilot's own order.
 *
 * A blocking fixture asserts on the *plan* rather than on the wreckage: "the
 * 2/5 blocked and the 2/1 stayed home" and "nothing of mine died" are different
 * statements, and only the first is the decision. Declining to block at all
 * leaves everything alive too.
 */
export function blockersIn(decision: AskedDecision): readonly InstanceId[] {
  if (decision.action.type !== 'assign_blockers') return [];
  return decision.action.blocks.map((block) => block.blockerInstanceId);
}

/**
 * The attackers a declaration actually sent, in the pilot's own order.
 *
 * The attacking twin of `blockersIn`, and for the same reason: an attack fixture
 * asserts on the *plan* — "the body it cannot answer went and the other stayed" —
 * rather than on the wreckage, which several different plans can produce.
 */
export function attackersIn(decision: AskedDecision): readonly InstanceId[] {
  if (decision.action.type !== 'declare_attackers') return [];
  return decision.action.attacks.map((attack) => attack.attackerInstanceId);
}

/**
 * Where in a run of decisions a specific card was played, or `-1`.
 *
 * What a sequencing fixture asserts on. The *outcome* of an order is often
 * ambiguous — a Commander's free Token can make the right order and the wrong
 * order produce the same board — while the order itself is exactly the decision
 * the fixture is about.
 */
export function playIndexOf(decisions: readonly AskedDecision[], instanceId: InstanceId): number {
  return decisions.findIndex(
    (decision) => decision.action.type === 'play_card' && decision.action.instanceId === instanceId,
  );
}

function isThenable(value: BotDecision | Promise<BotDecision>): value is Promise<BotDecision> {
  return typeof (value as Promise<BotDecision>).then === 'function';
}
