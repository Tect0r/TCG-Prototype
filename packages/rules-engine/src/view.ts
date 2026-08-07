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
import { legalActions, legalActionsSchema } from './legal-actions.js';
import { DEFAULT_RULES_CONFIG, type RulesConfig } from './config.js';
import { gameEventSchema, type GameEvent } from './schema/event.js';
import { pendingChoiceSchema } from './schema/choice.js';
import {
  combatStateSchema,
  matchResultSchema,
  mulliganStatusSchema,
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
  slot: z.number().int().min(0).nullable(),
  /** Derived, not printed: includes every active modifier. */
  attack: z.number().int(),
  health: z.number().int(),
  markedDamage: z.number().int().min(0),
  exhausted: z.boolean(),
  summoningSick: z.boolean(),
  keywords: z.array(keywordIdSchema),
  isToken: z.boolean(),
});
export type CardInstanceView = z.infer<typeof cardInstanceViewSchema>;

export const playerViewSummarySchema = z.strictObject({
  playerId: playerIdSchema,
  name: z.string(),
  health: z.number().int(),
  energy: z.number().int().min(0),
  maxEnergy: z.number().int().min(0),
  handCount: z.number().int().min(0),
  deckCount: z.number().int().min(0),
  discard: z.array(instanceIdSchema),
  units: z.array(instanceIdSchema.nullable()),
  relics: z.array(instanceIdSchema),
  commanderInstanceId: instanceIdSchema,
  mulliganStatus: mulliganStatusSchema,
  lost: z.boolean(),
  lossReason: lossReasonSchema.nullable(),
});
export type PlayerViewSummary = z.infer<typeof playerViewSummarySchema>;

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
  playerOrder: z.array(playerIdSchema),
  players: z.array(playerViewSummarySchema),
  /** The viewer's own hand. Never populated for anyone else. */
  hand: z.array(instanceIdSchema),
  instances: z.record(instanceIdSchema, cardInstanceViewSchema),
  combat: combatStateSchema,
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
      return event.playerId === viewerId ? event : { ...event, definitionId: null };
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

function instanceView(
  state: MatchState,
  database: CardDatabase,
  instanceId: InstanceId,
): CardInstanceView | null {
  const instance = findInstance(state, instanceId);
  if (!instance) return null;
  const definition = database.get(instance.definitionId);
  if (!definition) return null;

  return {
    instanceId,
    definitionId: instance.definitionId,
    owner: instance.owner,
    controller: instance.controller,
    zone: instance.zone,
    slot: instance.slot,
    attack: currentAttack(instance, definition),
    health: currentHealth(instance, definition),
    markedDamage: instance.markedDamage,
    exhausted: instance.exhausted,
    summoningSick: instance.zone === 'battlefield' && isSummoningSick(instance, state),
    keywords: [...effectiveKeywords(instance, definition)],
    isToken: instance.isToken,
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

  const reveal = (instanceId: InstanceId | null): void => {
    if (instanceId === null) return;
    const view = instanceView(state, database, instanceId);
    if (view) visible[instanceId] = view;
  };

  for (const playerId of state.playerOrder) {
    const player = playerOf(state, playerId);
    for (const slot of player.units) reveal(slot);
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

  const players = state.playerOrder.map((playerId) => {
    const player = playerOf(state, playerId);
    return {
      playerId,
      name: player.name,
      health: player.health,
      energy: player.energy,
      maxEnergy: player.maxEnergy,
      handCount: player.hand.length,
      deckCount: player.deck.length,
      discard: [...player.discard],
      units: [...player.units],
      relics: [...player.relics],
      commanderInstanceId: player.commanderInstanceId,
      mulliganStatus: player.mulligan.status,
      lost: player.lost,
      lossReason: player.lossReason,
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
    playerOrder: [...state.playerOrder],
    players,
    hand: [...viewer.hand],
    instances: visible,
    combat: structuredClone(state.combat),
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
