import {
  LIVE_MATCH_VOLUNTARY_TERMINATION_ORIGINS,
  type LiveMatchEnvelope,
  type LiveMatchEventDistance,
  type LiveMatchEventWindow,
  type LiveMatchPreActionCapture,
  type LiveMatchVoluntaryTerminationOrigin,
} from '@tcg/match-telemetry';
import { MATCH_PHASES, type GameEvent, type MatchPhase } from '@tcg/rules-engine';

import type { LiveMatchAggregatePartition } from './live-match-aggregate.js';
import { mean, proportion, round, type ProportionEstimate } from './stats.js';

/**
 * M08.24D — surrender state and exposure windows.
 *
 * Cross-references `LiveMatchPreActionCapture[]` (M08.23A/B, one per voluntary
 * concede) against `LiveMatchEnvelope[]` (M08.24A's own input) by `matchId`, so
 * a capture's `source`/`provenance` — which it does not itself carry — comes
 * from its match record. Partitioning reuses `live-match-aggregate.ts`'s own
 * `(source, contentVersion, rulesVersion)` shape (`LiveMatchAggregatePartition`)
 * so this view can never disagree with M08.24A/B/C about what one bucket is.
 *
 * **"State" is scoped to what a pre-action capture actually carries.** The
 * milestone overview mentions "board, Health and resource state at surrender",
 * but `LiveMatchPreActionCapture` deliberately never captures those (see its
 * own doc comment) — only structural match state: phase, whether combat had
 * declared attacks, whether a Reaction window was open, and whether a pending
 * choice was open (and its `type`). Reporting a fabricated Health/board figure
 * here would violate the "never silently invent" rule this codebase already
 * follows elsewhere (`CardEligibilityEntry.inclusion: null`,
 * `clustersUnavailableReason`); reporting the true structural scope instead
 * does not.
 *
 * **Exposure is relative to this partition's own surrenders, not a whole-match
 * population.** A capture's `eventWindow` only ever holds its own match's last
 * 30 log events (M08.23B), so "exposure" here means: of this partition's
 * surrenders, what share had a given event type or card `definitionId`
 * anywhere in their retained window. That is evidence a reviewer can weigh,
 * never an automatic cause — no field here is named "cause" or "reason";
 * everything is "exposure" or "proximity", matching the restraint
 * `LiveMatchPreActionCapture` and `LiveMatchEventWindow`'s own doc comments
 * already require of this exact computation (both explicitly defer it to
 * "M08.24D").
 *
 * **Distances** reuse `LiveMatchEventDistance`'s own `eventsAgo`/`actionsAgo`/
 * `turnsAgo` fields unchanged, taking the *nearest* (chronologically last, since
 * `recentEvents` is sequence-ascending) occurrence per key within a capture.
 * `roundsAgo` is `floor(turnsAgo / 2)` — a derived arithmetic convenience (one
 * round is both seats' turns in this format's two-seat matches), not a new
 * engine primitive, so it is documented as derived rather than silently
 * invented.
 *
 * **Timeout is excluded structurally, not filtered.** `LiveMatchPreActionCapture.origin`
 * is typed to only `LIVE_MATCH_VOLUNTARY_TERMINATION_ORIGINS`
 * (`concede_action`/`concede_leave`) — a timeout termination never produces a
 * pre-action capture at all, so there is nothing here to exclude. This module
 * additionally cross-checks each capture's `origin` against its envelope's own
 * `terminationOrigin` and reports a mismatch as unmatched rather than trusting
 * either value alone.
 *
 * A capture with no matching envelope, a mismatched termination origin, or a
 * `playerId` not seated in its match is reported in `unmatched` with a stated
 * reason — never silently dropped, per this codebase's dominant idiom.
 */

export interface SurrenderOriginCount {
  readonly origin: LiveMatchVoluntaryTerminationOrigin;
  readonly surrenders: number;
}

export interface SurrenderCommanderEntry {
  readonly commanderId: string;
  readonly surrenders: number;
}

export interface SurrenderDeckEntry {
  readonly deckHash: string;
  readonly commanderId: string;
  readonly surrenders: number;
}

export interface SurrenderTurnEntry {
  readonly turn: number;
  readonly surrenders: number;
}

export interface SurrenderPhaseEntry {
  readonly phase: MatchPhase;
  readonly surrenders: number;
}

export interface SurrenderPendingChoiceEntry {
  readonly choiceType: string;
  readonly surrenders: number;
}

/** Structural match state at the surrender instant — never board/Health/resource numbers. See module doc comment. */
export interface SurrenderStateSummary {
  readonly total: number;
  /** Captures whose `combat.attacks` was non-empty — attackers had been declared. */
  readonly inCombat: number;
  readonly reactionWindowOpen: number;
  readonly pendingChoiceOpen: number;
  /** Only entries for captures with an open pending choice, sorted by `choiceType`. */
  readonly pendingChoiceTypes: readonly SurrenderPendingChoiceEntry[];
}

export interface SurrenderProximityDistance {
  readonly min: number;
  readonly mean: number;
  readonly max: number;
}

export interface SurrenderProximityEntry {
  readonly key: string;
  /** Surrenders whose retained event window contained this key at least once. */
  readonly exposures: number;
  /** `exposures / totalSurrenders` for this partition, Wilson-bounded — never a whole-match population rate. */
  readonly exposureRate: ProportionEstimate;
  /** Distance of the nearest occurrence from the surrender instant, over exposed surrenders only. */
  readonly eventsAgo: SurrenderProximityDistance;
  readonly actionsAgo: SurrenderProximityDistance;
  readonly turnsAgo: SurrenderProximityDistance;
  /** `floor(turnsAgo / 2)` — a derived convenience, not a distinct engine concept. See module doc comment. */
  readonly roundsAgo: SurrenderProximityDistance;
}

export interface SurrenderExposureView {
  /** Sorted by `GameEvent['type']`. */
  readonly recentEventTypes: readonly SurrenderProximityEntry[];
  /** Sorted by card ID. */
  readonly recentCards: readonly SurrenderProximityEntry[];
}

export interface LiveMatchSurrenderAggregate {
  readonly partition: LiveMatchAggregatePartition;
  readonly surrenders: number;
  readonly originCounts: readonly SurrenderOriginCount[];
  readonly commanders: readonly SurrenderCommanderEntry[];
  readonly decks: readonly SurrenderDeckEntry[];
  readonly turns: readonly SurrenderTurnEntry[];
  readonly phases: readonly SurrenderPhaseEntry[];
  readonly state: SurrenderStateSummary;
  readonly exposure: SurrenderExposureView;
}

export interface UnmatchedSurrenderCapture {
  readonly matchId: string;
  readonly playerId: string;
  readonly reason: string;
}

export interface LiveMatchSurrenderResult {
  /** One entry per `(source, contentVersion, rulesVersion)` partition that had at least one matched capture, sorted the same way `partitionLiveMatches` orders partitions. */
  readonly aggregates: readonly LiveMatchSurrenderAggregate[];
  readonly unmatched: readonly UnmatchedSurrenderCapture[];
}

export interface LiveMatchSurrenderOptions {
  readonly confidence?: number;
}

interface MatchedCapture {
  readonly capture: LiveMatchPreActionCapture;
  readonly commanderId: string;
  readonly deckHash: string;
}

/** Aggregates voluntary-surrender state and exposure-adjusted proximity into one entry per partition. */
export function aggregateLiveMatchSurrenders(
  captures: readonly LiveMatchPreActionCapture[],
  matches: readonly LiveMatchEnvelope[],
  options: LiveMatchSurrenderOptions = {},
): LiveMatchSurrenderResult {
  const confidence = options.confidence ?? 0.95;
  const envelopesByMatchId = new Map<string, LiveMatchEnvelope>();
  for (const match of matches) {
    if (!envelopesByMatchId.has(match.matchId)) envelopesByMatchId.set(match.matchId, match);
  }

  const unmatched: UnmatchedSurrenderCapture[] = [];
  const grouped = new Map<
    string,
    { partition: LiveMatchAggregatePartition; captures: MatchedCapture[] }
  >();

  for (const capture of captures) {
    const envelope = envelopesByMatchId.get(capture.matchId);
    if (envelope === undefined) {
      unmatched.push({
        matchId: capture.matchId,
        playerId: capture.playerId,
        reason: "No live-match record was found for this capture's matchId.",
      });
      continue;
    }
    if (envelope.terminationOrigin !== capture.origin) {
      unmatched.push({
        matchId: capture.matchId,
        playerId: capture.playerId,
        reason:
          `This capture's origin ("${capture.origin}") does not match its match record's ` +
          `terminationOrigin ("${envelope.terminationOrigin}").`,
      });
      continue;
    }
    const seat = envelope.seats.find((candidate) => candidate.playerId === capture.playerId);
    if (seat === undefined) {
      unmatched.push({
        matchId: capture.matchId,
        playerId: capture.playerId,
        reason: 'This capture names a player not seated in its match record.',
      });
      continue;
    }

    const partition: LiveMatchAggregatePartition = {
      source: envelope.source,
      contentVersion: envelope.provenance.contentVersion,
      rulesVersion: envelope.provenance.rulesVersion,
    };
    const key = partitionKey(partition);
    let bucket = grouped.get(key);
    if (!bucket) {
      bucket = { partition, captures: [] };
      grouped.set(key, bucket);
    }
    bucket.captures.push({
      capture,
      commanderId: seat.deck.commanderId,
      deckHash: seat.deck.deckHash,
    });
  }

  const aggregates = [...grouped.values()]
    .sort((left, right) => comparePartitions(left.partition, right.partition))
    .map(({ partition, captures: group }) => aggregatePartition(group, partition, confidence));

  return { aggregates, unmatched };
}

function partitionKey(partition: LiveMatchAggregatePartition): string {
  return `${partition.source} ${String(partition.contentVersion)} ${partition.rulesVersion}`;
}

function comparePartitions(
  left: LiveMatchAggregatePartition,
  right: LiveMatchAggregatePartition,
): number {
  return (
    left.source.localeCompare(right.source) ||
    left.contentVersion - right.contentVersion ||
    left.rulesVersion.localeCompare(right.rulesVersion)
  );
}

interface ProximityAccumulator {
  exposures: number;
  eventsAgo: number[];
  actionsAgo: number[];
  turnsAgo: number[];
  roundsAgo: number[];
}

function bumpProximity(
  map: Map<string, ProximityAccumulator>,
  key: string,
  distance: LiveMatchEventDistance,
): void {
  let acc = map.get(key);
  if (!acc) {
    acc = { exposures: 0, eventsAgo: [], actionsAgo: [], turnsAgo: [], roundsAgo: [] };
    map.set(key, acc);
  }
  acc.exposures += 1;
  acc.eventsAgo.push(distance.eventsAgo);
  acc.actionsAgo.push(distance.actionsAgo);
  acc.turnsAgo.push(distance.turnsAgo);
  acc.roundsAgo.push(Math.floor(distance.turnsAgo / 2));
}

function cardIdOf(event: GameEvent): string | null {
  if ('definitionId' in event) return event.definitionId ?? null;
  return null;
}

/** The nearest (chronologically last) distance per event type and per card ID within one capture's window. */
function nearestPerCapture(eventWindow: LiveMatchEventWindow): {
  eventTypes: Map<string, LiveMatchEventDistance>;
  cards: Map<string, LiveMatchEventDistance>;
} {
  const eventTypes = new Map<string, LiveMatchEventDistance>();
  const cards = new Map<string, LiveMatchEventDistance>();
  eventWindow.recentEvents.forEach((event, index) => {
    const distance = eventWindow.eventDistances[index];
    if (distance === undefined) return;
    eventTypes.set(event.type, distance);
    const cardId = cardIdOf(event);
    if (cardId !== null) cards.set(cardId, distance);
  });
  return { eventTypes, cards };
}

function distanceStats(values: readonly number[]): SurrenderProximityDistance {
  return { min: Math.min(...values), mean: round(mean(values), 2), max: Math.max(...values) };
}

function rate(successes: number, total: number, confidence: number): ProportionEstimate {
  const estimate = proportion(successes, total, confidence);
  return {
    point: round(estimate.point),
    low: round(estimate.low),
    high: round(estimate.high),
    successes: estimate.successes,
    total: estimate.total,
    margin: round(estimate.margin),
  };
}

function proximityEntries(
  map: Map<string, ProximityAccumulator>,
  totalSurrenders: number,
  confidence: number,
): SurrenderProximityEntry[] {
  return [...map.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, acc]) => ({
      key,
      exposures: acc.exposures,
      exposureRate: rate(acc.exposures, totalSurrenders, confidence),
      eventsAgo: distanceStats(acc.eventsAgo),
      actionsAgo: distanceStats(acc.actionsAgo),
      turnsAgo: distanceStats(acc.turnsAgo),
      roundsAgo: distanceStats(acc.roundsAgo),
    }));
}

function aggregatePartition(
  group: readonly MatchedCapture[],
  partition: LiveMatchAggregatePartition,
  confidence: number,
): LiveMatchSurrenderAggregate {
  const originCounts = new Map<LiveMatchVoluntaryTerminationOrigin, number>();
  const commanderCounts = new Map<string, number>();
  const deckCounts = new Map<string, { commanderId: string; count: number }>();
  const turnCounts = new Map<number, number>();
  const phaseCounts = new Map<MatchPhase, number>();
  let inCombat = 0;
  let reactionWindowOpen = 0;
  let pendingChoiceOpen = 0;
  const pendingChoiceTypeCounts = new Map<string, number>();
  const eventTypeExposure = new Map<string, ProximityAccumulator>();
  const cardExposure = new Map<string, ProximityAccumulator>();

  for (const { capture, commanderId, deckHash } of group) {
    originCounts.set(capture.origin, (originCounts.get(capture.origin) ?? 0) + 1);
    commanderCounts.set(commanderId, (commanderCounts.get(commanderId) ?? 0) + 1);
    const deckEntry = deckCounts.get(deckHash) ?? { commanderId, count: 0 };
    deckEntry.count += 1;
    deckCounts.set(deckHash, deckEntry);
    turnCounts.set(capture.turn, (turnCounts.get(capture.turn) ?? 0) + 1);
    phaseCounts.set(capture.phase, (phaseCounts.get(capture.phase) ?? 0) + 1);

    if (capture.combat.attacks.length > 0) inCombat += 1;
    if (capture.reactionWindow !== null) reactionWindowOpen += 1;
    if (capture.pendingChoice !== null) {
      pendingChoiceOpen += 1;
      const choiceType = capture.pendingChoice.type;
      pendingChoiceTypeCounts.set(choiceType, (pendingChoiceTypeCounts.get(choiceType) ?? 0) + 1);
    }

    const nearest = nearestPerCapture(capture.eventWindow);
    for (const [eventType, distance] of nearest.eventTypes)
      bumpProximity(eventTypeExposure, eventType, distance);
    for (const [cardId, distance] of nearest.cards) bumpProximity(cardExposure, cardId, distance);
  }

  const originCountsList: SurrenderOriginCount[] = LIVE_MATCH_VOLUNTARY_TERMINATION_ORIGINS.filter(
    (origin) => originCounts.has(origin),
  ).map((origin) => ({ origin, surrenders: originCounts.get(origin) as number }));

  const commanders: SurrenderCommanderEntry[] = [...commanderCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([commanderId, surrenders]) => ({ commanderId, surrenders }));

  const decks: SurrenderDeckEntry[] = [...deckCounts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([deckHash, entry]) => ({
      deckHash,
      commanderId: entry.commanderId,
      surrenders: entry.count,
    }));

  const turns: SurrenderTurnEntry[] = [...turnCounts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([turn, surrenders]) => ({ turn, surrenders }));

  const phasesList: SurrenderPhaseEntry[] = MATCH_PHASES.filter((phase) =>
    phaseCounts.has(phase),
  ).map((phase) => ({ phase, surrenders: phaseCounts.get(phase) as number }));

  const pendingChoiceTypesList: SurrenderPendingChoiceEntry[] = [
    ...pendingChoiceTypeCounts.entries(),
  ]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([choiceType, surrenders]) => ({ choiceType, surrenders }));

  return {
    partition,
    surrenders: group.length,
    originCounts: originCountsList,
    commanders,
    decks,
    turns,
    phases: phasesList,
    state: {
      total: group.length,
      inCombat,
      reactionWindowOpen,
      pendingChoiceOpen,
      pendingChoiceTypes: pendingChoiceTypesList,
    },
    exposure: {
      recentEventTypes: proximityEntries(eventTypeExposure, group.length, confidence),
      recentCards: proximityEntries(cardExposure, group.length, confidence),
    },
  };
}
