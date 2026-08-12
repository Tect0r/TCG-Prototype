import { z } from 'zod';
import { cardIdSchema, keywordIdSchema, zoneIdSchema, type CardDatabase } from '@tcg/card-data';
import {
  currentAttack,
  currentHealth,
  effectiveKeywords,
  findInstance,
  isSummoningSick,
  playerOf,
} from './derive.js';
import { playCostOf } from './costs.js';
import { legalActions, legalActionsSchema } from './legal-actions.js';
import { DEFAULT_RULES_CONFIG, type RulesConfig } from './config.js';
import { gameEventSchema, type GameEvent } from './schema/event.js';
import { pendingChoiceSchema } from './schema/choice.js';
import {
  combatStateSchema,
  matchResultSchema,
  mulliganStatusSchema,
  type CombatState,
  type MatchState,
} from './schema/state.js';
import {
  instanceIdSchema,
  lossReasonSchema,
  matchModeSchema,
  matchPhaseSchema,
  matchStatusSchema,
  playerIdSchema,
  MATCH_SCHEMA_VERSION,
  type InstanceId,
  type PlayerId,
} from './schema/primitives.js';

/**
 * What one seat is allowed to know.
 *
 * Authoritative `MatchState` is never sent to a client. This view drops the RNG
 * state, deck order, the opponent's hand, and any option set belonging to the
 * other player's pending choice (CLAUDE.md §10).
 */

export const cardInstanceViewSchema = z.strictObject({
  instanceId: instanceIdSchema,
  definitionId: cardIdSchema,
  owner: playerIdSchema,
  controller: playerIdSchema,
  zone: zoneIdSchema,
  /** Derived, not printed: includes every active modifier. */
  attack: z.number().int(),
  health: z.number().int(),
  markedDamage: z.number().int().min(0),
  exhausted: z.boolean(),
  summoningSick: z.boolean(),
  keywords: z.array(keywordIdSchema),
  isToken: z.boolean(),
  /**
   * Whether this permanent is under a "does not Ready during its controller's
   * next Ready Step" prevention (M02.4).
   *
   * Public for every seat, like `exhausted` beside it. It is a visible board
   * fact: the instruction that applied it was a Spell resolving or a block being
   * declared, both already in the log, and a player who could not see it would
   * be unable to plan around a unit that is about to stay down. Nothing about
   * *who* applied it is exposed here — the log carries the attribution.
   */
  willNotReady: z.boolean(),
  /**
   * What playing this card would cost the viewer right now, after every
   * reduction the board currently grants (M02.3).
   *
   * Populated only for cards in the **viewer's own hand**, and `null` everywhere
   * else. A cost is a fact about a card its holder might play: for a unit on a
   * battlefield there is nothing to pay, and for a card in another seat's hand
   * the number would be both meaningless and a hidden-information leak.
   *
   * Derived rather than printed, because a discount that only appeared once the
   * card became affordable would leave a player unable to see why. `legalActions`
   * still decides what may actually be played; this only says what it would cost.
   */
  energyCost: z.number().int().min(0).nullable(),
});
export type CardInstanceView = z.infer<typeof cardInstanceViewSchema>;

export const playerViewSummarySchema = z.strictObject({
  playerId: playerIdSchema,
  name: z.string(),
  /** Position in the stable seat circle, for rendering the table in order. */
  seatIndex: z.number().int().min(0),
  health: z.number().int(),
  energy: z.number().int().min(0),
  maxEnergy: z.number().int().min(0),
  handCount: z.number().int().min(0),
  deckCount: z.number().int().min(0),
  discard: z.array(instanceIdSchema),
  /**
   * How many cards this seat has had removed from the game (M02.2).
   *
   * A count rather than a list, and deliberately: the `removed` zone is
   * terminal and nothing may target it (CLAUDE.md §12), so the identities buy a
   * player nothing they can act on — while a future card that removed from a
   * hand or a deck would leak hidden information through the same field. The
   * number is what a player needs: it says the pile a card left is smaller
   * because the card is gone for good, not because it was played.
   */
  removedCount: z.number().int().min(0),
  /** Dense and unbounded; position is arrival order, not a slot. */
  units: z.array(instanceIdSchema),
  relics: z.array(instanceIdSchema),
  commanderInstanceId: instanceIdSchema,
  mulliganStatus: mulliganStatusSchema,
  lost: z.boolean(),
  lossReason: lossReasonSchema.nullable(),
  /** Cleanup has run: their board is gone and they are watching (CLAUDE.md §12). */
  eliminated: z.boolean(),
});
export type PlayerViewSummary = z.infer<typeof playerViewSummarySchema>;

/**
 * A delayed effect as every seat may see it (M02.1).
 *
 * Public in full. Nothing here is hidden information: the instruction that
 * scheduled it was a Spell resolving or a trigger firing, both already in the
 * log, and the subject is a card on a battlefield or in a discard pile. Hiding
 * it would leave a player unable to see why two tokens appeared three decisions
 * later.
 *
 * The instruction list is deliberately *not* carried over. A client renders the
 * promise from the card's own explanation, which is generated from the same
 * structured data — shipping a second copy of the effects would give the UI a
 * way to disagree with the card inspector.
 */
export const delayedEffectViewSchema = z.strictObject({
  id: z.string(),
  definitionId: cardIdSchema,
  abilityId: z.string(),
  controllerId: playerIdSchema,
  subjectInstanceId: instanceIdSchema.nullable(),
  boundary: z.string(),
  triggerId: z.string().nullable(),
});
export type DelayedEffectView = z.infer<typeof delayedEffectViewSchema>;

export const playerViewSchema = z.strictObject({
  schemaVersion: z.literal(MATCH_SCHEMA_VERSION),
  rulesVersion: z.string(),
  matchId: z.string(),
  mode: matchModeSchema,
  viewerId: playerIdSchema,
  status: matchStatusSchema,
  phase: matchPhaseSchema,
  turn: z.number().int().min(0),
  activePlayerId: playerIdSchema,
  sequence: z.number().int().min(0),
  /** Stable seat circle; never reordered, even as players are eliminated. */
  seatOrder: z.array(playerIdSchema),
  playerOrder: z.array(playerIdSchema),
  players: z.array(playerViewSummarySchema),
  /** The viewer's own hand. Never populated for anyone else. */
  hand: z.array(instanceIdSchema),
  instances: z.record(instanceIdSchema, cardInstanceViewSchema),
  /** Redacted: other defenders' pending blocker submissions are stripped. */
  combat: combatStateSchema,
  /** Promises waiting on a boundary or an event this turn. Public (M02.1). */
  delayedEffects: z.array(delayedEffectViewSchema),
  /** Only ever the viewer's own choice; otherwise null. */
  pendingChoice: pendingChoiceSchema.nullable(),
  /** Who the match is waiting on, so the other seat can show "please wait". */
  awaitingChoiceFrom: playerIdSchema.nullable(),
  result: matchResultSchema.nullable(),
  /**
   * Engine-computed legality for this seat. The client highlights from this and
   * never works out what is playable on its own (CLAUDE.md §11).
   */
  legalActions: legalActionsSchema,
  log: z.array(gameEventSchema),
});
export type PlayerView = z.infer<typeof playerViewSchema>;

/**
 * Strips hidden information out of a single event. Called for every event in the
 * log, so a client that replays the log cannot reconstruct what it was not
 * shown live.
 */
export function redactEvent(event: GameEvent, viewerId: PlayerId): GameEvent {
  switch (event.type) {
    case 'card_drawn':
      return event.playerId === viewerId
        ? event
        : { ...event, instanceId: null, definitionId: null };
    case 'card_moved':
      // Moving into a hidden zone hides the card from everyone but its owner.
      if (event.playerId === viewerId) return event;
      if (event.toZone === 'hand' || event.toZone === 'deck') {
        return { ...event, definitionId: null };
      }
      return event;
    case 'choice_requested':
      return event.playerId === viewerId ? event : { ...event, validEntityIds: null };
    case 'choice_resolved':
      return event.playerId === viewerId ? event : { ...event, selectedIds: null };
    default:
      return event;
  }
}

/**
 * Combat as one seat may see it.
 *
 * Attacks are public the moment they are declared. Blocker submissions are not:
 * each defender answers independently and nobody — attacker or fellow defender —
 * sees an assignment until every defender has submitted, at which point the
 * merged `blocks` list becomes public (CLAUDE.md §12).
 */
function redactCombat(state: MatchState, viewerId: PlayerId): CombatState {
  const combat = structuredClone(state.combat);
  return {
    ...combat,
    submissions: combat.submissions.filter(
      (submission) => submission.defenderPlayerId === viewerId,
    ),
  };
}

function instanceView(
  state: MatchState,
  database: CardDatabase,
  instanceId: InstanceId,
  config: RulesConfig,
  viewerId: PlayerId,
): CardInstanceView | null {
  const instance = findInstance(state, instanceId);
  if (!instance) return null;
  const definition = database.get(instance.definitionId);
  if (!definition) return null;

  const inViewersHand = instance.zone === 'hand' && instance.controller === viewerId;

  return {
    energyCost: inViewersHand
      ? playCostOf({ state, database, config }, viewerId, instance, definition)
      : null,
    instanceId,
    definitionId: instance.definitionId,
    owner: instance.owner,
    controller: instance.controller,
    zone: instance.zone,
    attack: currentAttack(instance, definition),
    health: currentHealth(instance, definition),
    markedDamage: instance.markedDamage,
    exhausted: instance.exhausted,
    summoningSick: instance.zone === 'battlefield' && isSummoningSick(instance, state),
    keywords: [...effectiveKeywords(instance, definition)],
    isToken: instance.isToken,
    willNotReady: instance.readySkip !== null,
  };
}

/**
 * Derives the redacted view for one seat.
 *
 * The instance map contains only cards the viewer may legitimately identify:
 * their own hand, both battlefields, both discard piles and both Commanders.
 * Deck contents and the opponent's hand are omitted entirely rather than
 * included with a blanked-out name, so there is nothing to leak.
 */
export function playerView(
  state: MatchState,
  viewerId: PlayerId,
  database: CardDatabase,
  config: RulesConfig = DEFAULT_RULES_CONFIG,
): PlayerView {
  const visible: Record<InstanceId, CardInstanceView> = {};

  const reveal = (instanceId: InstanceId): void => {
    const view = instanceView(state, database, instanceId, config, viewerId);
    if (view) visible[instanceId] = view;
  };

  for (const playerId of state.seatOrder) {
    const player = playerOf(state, playerId);
    for (const unit of player.units) reveal(unit);
    for (const relic of player.relics) reveal(relic);
    for (const card of player.discard) reveal(card);
    reveal(player.commanderInstanceId);
    if (playerId === viewerId) for (const card of player.hand) reveal(card);
  }

  // A pending choice may legally point at cards the viewer would not otherwise
  // see — their own deck during a search, for example.
  if (state.pendingChoice?.playerId === viewerId) {
    for (const entityId of state.pendingChoice.validEntityIds) reveal(entityId);
  }

  const players = state.seatOrder.map((playerId, seatIndex) => {
    const player = playerOf(state, playerId);
    return {
      playerId,
      name: player.name,
      seatIndex,
      health: player.health,
      energy: player.energy,
      maxEnergy: player.maxEnergy,
      handCount: player.hand.length,
      deckCount: player.deck.length,
      discard: [...player.discard],
      removedCount: player.removed.length,
      units: [...player.units],
      relics: [...player.relics],
      commanderInstanceId: player.commanderInstanceId,
      mulliganStatus: player.mulligan.status,
      lost: player.lost,
      lossReason: player.lossReason,
      eliminated: player.eliminatedOnTurn !== null,
    };
  });

  const viewer = playerOf(state, viewerId);

  return {
    schemaVersion: state.schemaVersion,
    rulesVersion: state.rulesVersion,
    matchId: state.matchId,
    mode: state.mode,
    viewerId,
    status: state.status,
    phase: state.phase,
    turn: state.turn,
    activePlayerId: state.activePlayerId,
    sequence: state.sequence,
    seatOrder: [...state.seatOrder],
    playerOrder: [...state.playerOrder],
    players,
    hand: [...viewer.hand],
    instances: visible,
    combat: redactCombat(state, viewerId),
    delayedEffects: state.delayedEffects.map((entry) => ({
      id: entry.id,
      definitionId: entry.sourceDefinitionId,
      abilityId: entry.abilityId,
      controllerId: entry.controllerId,
      subjectInstanceId: entry.subjectInstanceId,
      boundary: entry.boundary,
      triggerId: entry.trigger,
    })),
    pendingChoice:
      state.pendingChoice && state.pendingChoice.playerId === viewerId
        ? structuredClone(state.pendingChoice)
        : null,
    awaitingChoiceFrom: state.pendingChoice?.playerId ?? null,
    result: state.result ? structuredClone(state.result) : null,
    legalActions: legalActions(state, viewerId, { database, config }),
    log: state.log.map((event) => redactEvent(event, viewerId)),
  };
}

/** The redacted tail of the log, for clients that already have events up to `after`. */
export function eventsSince(state: MatchState, viewerId: PlayerId, after: number): GameEvent[] {
  return state.log
    .filter((event) => event.sequence > after)
    .map((event) => redactEvent(event, viewerId));
}
