import type { CardDatabase } from '@tcg/card-data';
import {
  applyAction,
  createMatch,
  type MatchState,
  type PlayerId,
  type RulesConfig,
} from '@tcg/rules-engine';
import { isErr } from '@tcg/shared';
import { groupEvents, type EventGroup, type GroupingOptions } from './grouping.js';
import type { SpectatorReplay } from './schema.js';

/**
 * Spectator playback.
 *
 * A **pure state machine** over a finished replay: it knows which group is
 * showing and what the board looked like then, and nothing else. It owns no
 * timers, and the timing presets below are advice the UI reads — a delay must
 * never be able to reach the engine, the pilots, the replay or the telemetry,
 * and the surest way to guarantee that is for the code that computes state to
 * have no concept of time at all.
 *
 * The board at each step is produced by **re-applying the recorded actions**
 * through the real engine rather than by mutating a snapshot. Playback is
 * therefore the same determinism check a replay verifier performs: if the
 * engine has changed, playback diverges visibly instead of showing a plausible
 * fiction.
 */

export const PLAYBACK_SPEEDS = ['0.25x', '0.5x', '1x', '2x', 'instant'] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

/**
 * Milliseconds between ordinary visible actions at 1x.
 *
 * The update asks for "roughly 800–1200 ms"; 1000 sits in the middle. A
 * compound group — a whole combat, a spell and its consequences — is given
 * `weight` 2 and lingers proportionally longer.
 */
export const BASE_STEP_MS = 1000;

const SPEED_FACTORS: Readonly<Record<PlaybackSpeed, number>> = {
  '0.25x': 4,
  '0.5x': 2,
  '1x': 1,
  '2x': 0.5,
  instant: 0,
};

/** How long the UI should hold on this group before advancing. */
export function stepDelayMs(group: EventGroup | undefined, speed: PlaybackSpeed): number {
  if (speed === 'instant' || !group) return 0;
  return Math.round(BASE_STEP_MS * SPEED_FACTORS[speed] * group.weight);
}

/** Normal Spectator hides every hand; Analysis Mode shows them all. */
export const INFORMATION_MODES = ['normal', 'analysis'] as const;
export type InformationMode = (typeof INFORMATION_MODES)[number];

export interface PlaybackFrame {
  readonly groupIndex: number;
  readonly group: EventGroup | null;
  /** Authoritative state as of this group. */
  readonly state: MatchState;
}

export interface PlaybackOptions {
  readonly database: CardDatabase;
  readonly config: RulesConfig;
  readonly grouping?: GroupingOptions;
}

/**
 * A replay, prepared for playback.
 *
 * Every frame is computed up front. A spectator match is a few hundred actions,
 * so this costs milliseconds once and makes stepping, restarting and jumping
 * O(1) — which is what lets "pause, step, restart, speed change and Instant
 * playback preserve event order" be true trivially: they all index the same
 * precomputed list.
 */
export class SpectatorPlayback {
  readonly replay: SpectatorReplay;
  readonly groups: readonly EventGroup[];
  private readonly frames: MatchState[];

  constructor(replay: SpectatorReplay, options: PlaybackOptions) {
    this.replay = replay;
    this.groups = groupEvents(replay.events, options.grouping);
    this.frames = buildFrames(replay, this.groups, options);
  }

  get groupCount(): number {
    return this.groups.length;
  }

  /**
   * The state to render for a group index.
   *
   * `-1` is the position before anything has happened, which is what Restart
   * returns to: an empty table rather than the first action already applied.
   */
  frameAt(groupIndex: number): PlaybackFrame {
    const clamped = Math.max(-1, Math.min(groupIndex, this.groups.length - 1));
    const state = this.frames[clamped + 1] ?? (this.frames[0] as MatchState);
    return {
      groupIndex: clamped,
      group: clamped >= 0 ? (this.groups[clamped] ?? null) : null,
      state,
    };
  }

  /** The final position, for Instant playback and the end-of-match summary. */
  finalFrame(): PlaybackFrame {
    return this.frameAt(this.groups.length - 1);
  }

  /** Groups up to and including `groupIndex`: the log, synchronized to playback. */
  logUpTo(groupIndex: number): readonly EventGroup[] {
    return this.groups.slice(0, Math.max(0, groupIndex + 1));
  }

  /**
   * The hand a viewer may see for a seat.
   *
   * Normal Spectator returns nothing for anybody: every bot's hand is hidden,
   * and cards become visible only by being played, discarded or revealed —
   * which happens through the board and the log, not here. Analysis Mode
   * returns the real hand.
   *
   * The asymmetry is the point. Analysis Mode is confined to AI spectator
   * sessions because there is no human at any seat to disadvantage; nothing
   * here is reachable from a human or online match, which reads hands through
   * `playerView` and always will.
   */
  handFor(frame: PlaybackFrame, playerId: PlayerId, mode: InformationMode): readonly string[] {
    if (mode !== 'analysis') return [];
    return [...(frame.state.players[playerId]?.hand ?? [])];
  }

  /** The bot decision that produced a group, for Analysis Mode. */
  decisionFor(group: EventGroup | null): SpectatorReplay['decisions'][number] | null {
    if (!group) return null;
    // The decision whose events end at or after this group: a decision's
    // `sequenceAfter` is the last event it produced.
    return (
      this.replay.decisions.find((decision) => decision.sequenceAfter >= group.sequence) ?? null
    );
  }
}

/**
 * One state per group boundary, plus the opening position at index 0.
 *
 * Actions are applied in recorded order and the cursor advances to the next
 * group whenever the state's sequence has caught up with it. A recorded action
 * the engine now rejects stops the walk: the remaining frames repeat the last
 * good state, so playback freezes visibly at the divergence rather than
 * silently skipping it.
 */
function buildFrames(
  replay: SpectatorReplay,
  groups: readonly EventGroup[],
  options: PlaybackOptions,
): MatchState[] {
  const { database, config } = options;

  const created = createMatch({
    matchId: replay.matchId,
    seed: replay.seed,
    database,
    config,
    preserveSeatOrder: true,
    seats: replay.seats.map((seat) => ({
      playerId: seat.playerId,
      name: seat.name,
      deck: {
        commanderId: seat.commanderId,
        cards: countCards(seat.cardIds),
      },
    })),
  });
  if (isErr(created)) {
    throw new Error(
      `Replay "${replay.matchId}" could not be recreated: ` +
        `${created.error.code} — ${created.error.message}`,
    );
  }

  const frames: MatchState[] = [created.value.state];
  let state = created.value.state;
  let actionIndex = 0;

  for (const group of groups) {
    while (state.sequence < group.sequence && actionIndex < replay.actions.length) {
      const action = replay.actions[actionIndex];
      actionIndex += 1;
      if (!action) break;
      const applied = applyAction(state, action, { database, config });
      if (isErr(applied)) {
        // Freeze here. Every later frame repeats this state, so the divergence
        // is visible as playback stopping rather than as a board that quietly
        // stops matching the log beside it.
        break;
      }
      state = applied.value.state;
    }
    frames.push(state);
  }

  return frames;
}

function countCards(cardIds: readonly string[]): { cardId: string; quantity: number }[] {
  const counts = new Map<string, number>();
  for (const cardId of cardIds) counts.set(cardId, (counts.get(cardId) ?? 0) + 1);
  return [...counts].map(([cardId, quantity]) => ({ cardId, quantity }));
}
