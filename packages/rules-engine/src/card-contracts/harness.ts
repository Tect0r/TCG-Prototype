import type { CardDatabase, CardId, KeywordId } from '@tcg/card-data';
import { isErr } from '@tcg/shared';
import { DEFAULT_RULES_CONFIG, type RulesConfig } from '../config.js';
import { createContext } from '../context.js';
import { playCostOf } from '../costs.js';
import { currentAttack, currentHealth, definitionOf, effectiveKeywords } from '../derive.js';
import { applyAction, type ApplyContext } from '../engine.js';
import { enumerateActions } from '../legal-actions.js';
import { reactionCostOf } from '../reactions.js';
import {
  apply,
  deployCommander,
  deployRelic,
  deployUnit,
  giveCard,
  giveDiscard,
  keepBothHands,
  makeDeck,
  setEnergy,
  setHealth,
  stackDeck,
  startMatch,
  testDatabase,
} from '../test-fixtures.js';
import type { ActionInput } from '../schema/action.js';
import type { PendingChoice } from '../schema/choice.js';
import type { GameEvent } from '../schema/event.js';
import type { InstanceId, PlayerId } from '../schema/primitives.js';
import type { CardInstance, MatchState } from '../schema/state.js';

/**
 * The table a card behaviour contract is played on.
 *
 * Every one of the 155 Wave 1 cards has to be driven to the point where its
 * printed behaviour actually happens, and almost all of them need the same six
 * or seven arrangements to get there. This is those arrangements, expressed
 * once: a two-seat match already past the mulligan, both seats solvent, and a
 * board the contract builds by naming cards rather than by writing instance
 * plumbing.
 *
 * It is deliberately mutable and deliberately loud. A contract reads as a short
 * script — put this on the board, play that, look at what happened — and any
 * step the engine refuses throws immediately with the engine's own error, so a
 * failing contract points at the rule rather than at the harness.
 *
 * Nothing here decides anything a card does. Choices are answered by a fixed,
 * documented policy (`answerFor`) that a contract can override where the
 * interesting answer is not the obvious one.
 */

/**
 * One card's happy-path behaviour contract.
 *
 * `claim` is the sentence the contract proves, in the language of the printed
 * card rather than of the engine. It is the test name, so a failure reads as
 * "Goblin Recruiter: deploying it creates one Goblin Token" rather than as a
 * card ID and a line number.
 */
export interface CardContract {
  readonly claim: string;
  /**
   * The Commander both seats run, when the contract is about one.
   *
   * A Commander lives in the Command Zone from setup, so it cannot be handed to
   * a seat mid-match the way every other card can: the deck has to name it.
   */
  readonly commander?: CardId;
  readonly run: (table: ContractTable) => void;
}

/** Both seats start with the Energy cap so no contract is about affordability. */
const CONTRACT_ENERGY = 10;

/** The filler deck: one vanilla body, so no opening hand can hold a Reaction. */
const FILLER_UNIT: CardId = 'prototype_drone';

export type ChoicePolicy = (choice: PendingChoice, state: MatchState) => readonly string[] | null;

export interface TableOptions {
  readonly database?: CardDatabase;
  readonly config?: RulesConfig;
  /** Extra answering policy, consulted before the default one. */
  readonly choices?: ChoicePolicy;
  /** Commander for both seats. Defaults to a costless prototype Commander. */
  readonly commander?: CardId;
}

export class ContractTable {
  readonly context: ApplyContext;
  /** The contract's own seat. Always the active player on turn 1. */
  readonly self: PlayerId = 'player_1';
  readonly foe: PlayerId = 'player_2';

  state: MatchState;
  private policy: ChoicePolicy | undefined;
  /** Log length at the last `mark()`, so a contract can look at one step. */
  private marker = 0;

  private constructor(state: MatchState, context: ApplyContext, policy: ChoicePolicy | undefined) {
    this.state = state;
    this.context = context;
    this.policy = policy;
  }

  static open(options: TableOptions = {}): ContractTable {
    const database = options.database ?? testDatabase();
    const config = options.config ?? DEFAULT_RULES_CONFIG;
    const context: ApplyContext = { database, config };

    // Both seats run the same filler deck and the same Commander so nothing in
    // the arrangement depends on which precon a card came from.
    const deck = makeDeck(options.commander ?? 'prototype_commander_blue', [FILLER_UNIT]);
    let state = keepBothHands(startMatch({ database, config, decks: [deck, deck] }), context);
    state = setEnergy(state, 'player_1', CONTRACT_ENERGY);
    state = setEnergy(state, 'player_2', CONTRACT_ENERGY);

    const table = new ContractTable(state, context, options.choices);
    table.mark();
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

  /**
   * Puts a unit straight onto the battlefield, ready and past Newly Deployed.
   *
   * This is scenery, not the card under test: it skips the deploy so a contract
   * about combat is not also a contract about a deploy trigger.
   */
  board(
    cardId: CardId,
    playerId: PlayerId = this.self,
    options: { readonly exhausted?: boolean; readonly summoningSick?: boolean } = {},
  ): InstanceId {
    const placed = deployUnit(this.state, playerId, cardId, options);
    this.state = placed.state;
    return placed.instanceId;
  }

  /**
   * Puts a Token onto the battlefield without a card having created it.
   *
   * Distinct from `board` because `isToken` is what tells the engine this is a
   * Token rather than a printed Unit that happens to have a Token's definition,
   * and Token grouping and "cease existing" both read it.
   */
  token(cardId: CardId, playerId: PlayerId = this.self): InstanceId {
    const instanceId = this.board(cardId, playerId);
    this.instance(instanceId).isToken = true;
    return instanceId;
  }

  /** Exhausts a permanent already in play, without paying anything for it. */
  exhaust(instanceId: InstanceId): void {
    this.instance(instanceId).exhausted = true;
  }

  /** Puts a Relic straight into play, past Newly Deployed. */
  boardRelic(cardId: CardId, playerId: PlayerId = this.self): InstanceId {
    const placed = deployRelic(this.state, playerId, cardId);
    this.state = placed.state;
    return placed.instanceId;
  }

  /** Moves a seat's own Commander onto its battlefield, as deploying would. */
  boardCommander(playerId: PlayerId = this.self): InstanceId {
    const placed = deployCommander(this.state, playerId);
    this.state = placed.state;
    return placed.instanceId;
  }

  /** Replaces the top of a seat's deck with an exact list. */
  stack(cardIds: readonly CardId[], playerId: PlayerId = this.self): void {
    this.state = stackDeck(this.state, playerId, cardIds);
  }

  health(playerId: PlayerId, value: number): void {
    this.state = setHealth(this.state, playerId, value);
  }

  energy(playerId: PlayerId, value: number): void {
    this.state = setEnergy(this.state, playerId, value);
  }

  /** Overrides the choice policy for the rest of the contract. */
  choose(policy: ChoicePolicy | undefined): void {
    this.policy = policy;
  }

  /**
   * Answers every choice with these instances wherever they are legal.
   *
   * Used where the board has to hold more than one legal target and the
   * contract is about a specific one — killing *this* Unit rather than
   * whichever the default policy listed first.
   */
  prefer(...instanceIds: readonly InstanceId[]): void {
    this.choose((choice) => {
      const wanted = instanceIds.filter((id) => choice.validEntityIds.includes(id));
      if (wanted.length === 0) return null;
      if (choice.type === 'divide_damage') {
        const first = wanted[0] as InstanceId;
        return Array.from({ length: choice.minimum }, () => first);
      }
      const take = Math.max(choice.minimum, Math.min(choice.maximum, wanted.length));
      return wanted.slice(0, take);
    });
  }

  /* ----------------------------------------------------------------- acting */

  /** Applies an action and settles everything it started. */
  act(action: ActionInput): void {
    this.applyOnly(action);
    this.settle();
  }

  /**
   * Applies an action and stops wherever it left the engine.
   *
   * A Reaction contract needs the window the action opened, and `act` would
   * have closed it on the way out.
   */
  applyOnly(action: ActionInput): void {
    this.state = apply(this.state, action, this.context);
  }

  /** Declares attacks without settling, leaving the window open. */
  declareAttack(
    attackers: readonly InstanceId[],
    playerId: PlayerId = this.state.activePlayerId,
  ): void {
    const defenderPlayerId = playerId === this.self ? this.foe : this.self;
    this.toPhase('declare_attackers', playerId);
    this.applyOnly({
      type: 'declare_attackers',
      playerId,
      attacks: attackers.map((attackerInstanceId) => ({ attackerInstanceId, defenderPlayerId })),
    });
  }

  /** Assigns blocks without settling, leaving the window open. */
  declareBlock(
    blocks: readonly { readonly attacker: InstanceId; readonly blocker: InstanceId }[],
    playerId: PlayerId = this.self,
  ): void {
    this.applyOnly({
      type: 'assign_blockers',
      playerId,
      blocks: blocks.map((pair) => ({
        attackerInstanceId: pair.attacker,
        blockerInstanceId: pair.blocker,
      })),
    });
  }

  /** The open Reaction window, or a loud failure if there is none. */
  window(): NonNullable<MatchState['reactionWindow']> {
    const open = this.state.reactionWindow;
    if (!open) {
      throw new Error(`Expected an open Reaction window; the phase is "${this.state.phase}".`);
    }
    return open;
  }

  /**
   * Passes priority in the open window until it is this seat's turn to act.
   *
   * Priority is offered active-player-first, so a Reaction held by the
   * non-active seat usually has to wait for one pass.
   */
  priorityTo(playerId: PlayerId): void {
    for (let guard = 0; guard < 8; guard += 1) {
      const open = this.window();
      const holder = open.priorityOrder[open.priorityIndex];
      if (holder === playerId) return;
      if (holder === undefined) break;
      this.applyOnly({ type: 'pass_reaction', playerId: holder });
    }
    throw new Error(`${playerId} was never offered priority in the window.`);
  }

  /** Plays a card from hand for its printed cost. */
  play(instanceId: InstanceId, playerId: PlayerId = this.self): void {
    this.act({ type: 'play_card', playerId, instanceId });
  }

  /** Puts a card in hand and plays it in one step — the commonest contract. */
  cast(cardId: CardId, playerId: PlayerId = this.self): InstanceId {
    const instanceId = this.give(cardId, playerId);
    this.play(instanceId, playerId);
    return instanceId;
  }

  /** Deploys a seat's Commander out of the Command Zone by playing it. */
  playCommander(playerId: PlayerId = this.self): InstanceId {
    const player = this.player(playerId);
    this.play(player.commanderInstanceId, playerId);
    return player.commanderInstanceId;
  }

  activate(instanceId: InstanceId, abilityId: string, playerId: PlayerId = this.self): void {
    this.act({ type: 'activate_ability', playerId, sourceInstanceId: instanceId, abilityId });
  }

  /** Plays a Reaction into the open window. */
  react(instanceId: InstanceId, playerId: PlayerId = this.self): void {
    this.state = apply(this.state, { type: 'play_reaction', playerId, instanceId }, this.context);
    this.settle();
  }

  passPhase(playerId: PlayerId = this.state.activePlayerId): void {
    this.act({ type: 'pass_phase', playerId });
  }

  /** Declares attacks, then settles blockers and damage. */
  attack(attackers: readonly InstanceId[], playerId: PlayerId = this.state.activePlayerId): void {
    const defenderPlayerId = playerId === this.self ? this.foe : this.self;
    this.toPhase('declare_attackers', playerId);
    this.act({
      type: 'declare_attackers',
      playerId,
      attacks: attackers.map((attackerInstanceId) => ({ attackerInstanceId, defenderPlayerId })),
    });
  }

  /** The defender's answer. An empty list is "no blocks". */
  block(
    blocks: readonly { readonly attacker: InstanceId; readonly blocker: InstanceId }[],
    playerId: PlayerId = this.self,
  ): void {
    this.act({
      type: 'assign_blockers',
      playerId,
      blocks: blocks.map((pair) => ({
        attackerInstanceId: pair.attacker,
        blockerInstanceId: pair.blocker,
      })),
    });
  }

  /**
   * Passes phases until `phase` is reached on the current turn.
   *
   * Bounded by the number of phases in a turn so a step the engine will not
   * leave fails as a loud error rather than as a hung test.
   */
  toPhase(phase: MatchState['phase'], playerId: PlayerId = this.state.activePlayerId): void {
    for (let guard = 0; guard < 8 && this.state.phase !== phase; guard += 1) {
      this.passPhase(playerId);
    }
    if (this.state.phase !== phase) {
      throw new Error(`Could not reach phase "${phase}"; stuck in "${this.state.phase}".`);
    }
  }

  /**
   * Hands the turn on, stopping in the next seat's first Main Phase.
   *
   * The whole of turn end and the whole of the next turn's start run on the
   * way, which is exactly what an `on_turn_end`, `on_opponent_turn_end`,
   * `on_turn_start`, replacement or delayed contract needs.
   *
   * It never plays a card. Combat steps are stepped through with the empty
   * declaration rather than passed, because a phase that is waiting for a
   * declaration has nothing to pass.
   */
  endTurn(): void {
    const from = this.state.activePlayerId;
    for (let guard = 0; guard < 40; guard += 1) {
      this.settle();
      if (this.state.status === 'complete') return;
      if (this.state.activePlayerId !== from && this.state.phase === 'main_1') return;
      if (!this.advance()) break;
    }
    throw new Error(`Turn did not pass on from ${from}; phase is "${this.state.phase}".`);
  }

  /**
   * Takes the cheapest legal step that moves the match forward, from whichever
   * seat has one. Returns false when nobody does.
   */
  private advance(): boolean {
    for (const playerId of this.state.playerOrder) {
      const actions = enumerateActions(this.state, playerId, this.context);
      const declare = actions.find(
        (action) => action.type === 'declare_attackers' && action.attacks.length === 0,
      );
      const block = actions.find(
        (action) => action.type === 'assign_blockers' && action.blocks.length === 0,
      );
      const pick =
        declare ??
        block ??
        actions.find((action) => action.type === 'pass_reaction') ??
        actions.find((action) => action.type === 'pass_phase');
      if (!pick) continue;
      this.applyOnly(pick);
      return true;
    }
    return false;
  }

  /* --------------------------------------------------------------- settling */

  /**
   * Answers every pending choice and closes every Reaction window until the
   * engine is waiting on a real decision again.
   *
   * A window is closed by passing from whoever actually holds priority: a seat
   * without a playable Reaction is never offered it, so passing on behalf of a
   * fixed player would be an illegal action rather than a no-op.
   */
  settle(): void {
    for (let guard = 0; guard < 64; guard += 1) {
      const choice = this.state.pendingChoice;
      if (choice) {
        const selectedIds = this.policy?.(choice, this.state) ?? answerFor(choice);
        this.state = apply(
          this.state,
          {
            type: 'submit_choice',
            playerId: choice.playerId,
            choiceId: choice.id,
            selectedIds: [...selectedIds],
          },
          this.context,
        );
        continue;
      }

      const open = this.state.reactionWindow;
      if (!open || open.closed) return;
      const holder = open.priorityOrder[open.priorityIndex];
      if (holder === undefined) return;
      const result = applyAction(
        this.state,
        { type: 'pass_reaction', playerId: holder },
        this.context,
      );
      if (isErr(result)) return;
      this.state = result.value.state;
    }
    throw new Error('Settling did not finish: the engine kept asking for decisions.');
  }

  /* ------------------------------------------------------------- inspection */

  /** Remembers the log position so `since()` reports one step in isolation. */
  mark(): void {
    this.marker = this.state.log.length;
  }

  /** Events logged since the last `mark()`. */
  since(): readonly GameEvent[] {
    return this.state.log.slice(this.marker);
  }

  events<T extends GameEvent['type']>(type: T): Extract<GameEvent, { type: T }>[] {
    return this.state.log.filter(
      (event): event is Extract<GameEvent, { type: T }> => event.type === type,
    );
  }

  /** True when at least one event of `type` matches every field in `fields`. */
  logged<T extends GameEvent['type']>(
    type: T,
    fields: Partial<Extract<GameEvent, { type: T }>> = {},
  ): boolean {
    return this.events(type).some((event) =>
      Object.entries(fields).every(
        ([key, value]) => (event as Record<string, unknown>)[key] === value,
      ),
    );
  }

  player(playerId: PlayerId = this.self): MatchState['players'][string] & object {
    const player = this.state.players[playerId];
    if (!player) throw new Error(`No player ${playerId}`);
    return player;
  }

  instance(instanceId: InstanceId): CardInstance {
    const instance = this.state.instances[instanceId];
    if (!instance) throw new Error(`No instance ${instanceId}`);
    return instance;
  }

  /**
   * What playing this card would cost its holder right now.
   *
   * Reads through `playCostOf` and `reactionCostOf` rather than the printed
   * number, so a contract about a discount is about the answer the play path,
   * the legal actions and the view all use.
   */
  costOf(instanceId: InstanceId, playerId: PlayerId = this.self): number {
    const instance = this.instance(instanceId);
    const database = this.context.database;
    const config = this.context.config ?? DEFAULT_RULES_CONFIG;
    const definition = definitionOf(database, instance);
    // A Reaction's answer includes the once-per-turn-cycle discount, which only
    // `reactionCostOf` knows about; everything else is `playCostOf`.
    if (definition.type === 'reaction') {
      return reactionCostOf(createContext(this.state, database, config), playerId, instance).cost;
    }
    return playCostOf({ database, config, state: this.state }, playerId, instance, definition);
  }

  /** How many copies of `cardId` sit in a seat's zone. */
  countIn(zone: 'hand' | 'discard' | 'deck' | 'removed', cardId: CardId, playerId = this.self) {
    return this.player(playerId)[zone].filter((id) => this.instance(id).definitionId === cardId)
      .length;
  }

  handSize(playerId: PlayerId = this.self): number {
    return this.player(playerId).hand.length;
  }

  /** Instance IDs on a seat's battlefield whose definition is `cardId`. */
  unitsOf(cardId: CardId, playerId: PlayerId = this.self): InstanceId[] {
    return this.player(playerId).units.filter((id) => this.instance(id).definitionId === cardId);
  }

  /** The one instance of `cardId` a seat controls, or a loud failure. */
  onlyUnitOf(cardId: CardId, playerId: PlayerId = this.self): InstanceId {
    const found = this.unitsOf(cardId, playerId);
    if (found.length !== 1) {
      throw new Error(`Expected exactly one "${cardId}" in play but found ${found.length}.`);
    }
    return found[0] as InstanceId;
  }

  /** How many units a seat controls, tokens included. */
  unitCount(playerId: PlayerId = this.self): number {
    return this.player(playerId).units.length;
  }

  attackOf(instanceId: InstanceId): number {
    const instance = this.instance(instanceId);
    return currentAttack(instance, definitionOf(this.context.database, instance));
  }

  healthOf(instanceId: InstanceId): number {
    const instance = this.instance(instanceId);
    return currentHealth(instance, definitionOf(this.context.database, instance));
  }

  hasKeyword(instanceId: InstanceId, keyword: KeywordId): boolean {
    const instance = this.instance(instanceId);
    return effectiveKeywords(instance, definitionOf(this.context.database, instance)).has(keyword);
  }

  zoneOf(instanceId: InstanceId): CardInstance['zone'] {
    return this.instance(instanceId).zone;
  }

  /**
   * Whether the engine still knows this instance at all.
   *
   * A Token that ceases existing is deleted rather than moved, so asking for
   * its zone would throw where the contract wants to assert it is gone.
   */
  exists(instanceId: InstanceId): boolean {
    return this.state.instances[instanceId] !== undefined;
  }
}

/* ------------------------------------------------------------- assertions */

/**
 * Assertions the contracts use instead of `expect`.
 *
 * The registry lives beside the engine rather than in a test file, so it must
 * not import a test runner. A thrown `Error` fails the surrounding `it` with
 * the message written here, which is the same information `expect` would have
 * produced and is written by the contract author rather than inferred.
 */
export function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export function checkEqual(actual: unknown, expected: unknown, label: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${label}: expected ${String(expected)} but got ${String(actual)}.`);
  }
}

/**
 * The default answer to a pending choice: the most the card allows.
 *
 * A contract is a *happy path*, so the policy is "take the offer" — every
 * optional instruction is accepted and every "up to N" takes N. The two
 * exceptions are both about paying: an additional cost offered to the player
 * being countered is declined, because the happy path of a Reaction is the
 * Reaction resolving, and an allocation puts every point on one target because
 * that is the only split that is legal at every total.
 */
export function answerFor(choice: PendingChoice): readonly string[] {
  if (choice.ordered) return choice.validEntityIds;
  if (choice.type === 'confirm') {
    return choice.reason === 'pay_additional_cost' ? ['no'] : ['yes'];
  }
  if (choice.type === 'divide_damage') {
    const first = choice.validEntityIds[0];
    if (first === undefined) return [];
    return Array.from({ length: choice.minimum }, () => first);
  }
  const take = Math.max(choice.minimum, Math.min(choice.maximum, choice.validEntityIds.length));
  return choice.validEntityIds.slice(0, take);
}
