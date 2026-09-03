import { z } from 'zod';
import {
  combatStateSchema,
  matchPhaseSchema,
  pendingChoiceSchema,
  reactionWindowStateSchema,
} from '@tcg/rules-engine';
import { liveMatchParticipantIdSchema } from './schema.js';

/**
 * The pre-action capture contract (M08.23A): what a match looked like the
 * instant before a human's explicit `concede` action or a `leave()`-triggered
 * concession reached the engine, so later analysis can see what a surrendering
 * player was actually facing without the engine's own concede resolution
 * (which clears `pendingChoice`, ends `combat` and closes any open
 * `reactionWindow`) ever having overwritten it.
 *
 * Contract only, mirroring `./retention.ts`'s split: a versioned strict
 * schema plus the standard readable-refusal boilerplate. The pure builder
 * that actually reads a live `MatchState` and produces one of these, and the
 * two call sites in `apps/multiplayer-server/src/match-server.ts` that invoke
 * it immediately before `applyAction`, are that app's job — this package
 * defines the shape, never the capture.
 *
 * Deliberately reuses `@tcg/rules-engine`'s own `pendingChoiceSchema`,
 * `combatStateSchema` and `reactionWindowStateSchema` rather than restating
 * them, the same choice `./retention.ts` made for `gameEventSchema` and
 * `loggedActionSchema`: this is the engine's own pre-action state, verbatim,
 * not a hand-derived summary of it that could drift.
 *
 * Assigning no cause: this artifact is silent on *why* the player conceded.
 * `matchId`, `turn`, `phase`, `activePlayerId` and `sequence` place the
 * capture on the match's own timeline; `playerId` names who conceded, never
 * the reason. `M08.23B`/`M08.23C` add the event/turn windows and the
 * explicit-vs-leave distinction respectively; this contract carries neither.
 */

export const LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION = 1;

/** Whether `found` is a readable schema version this build is simply too new or old to read. */
export function isReadableLiveMatchPreActionCaptureVersion(found: unknown): found is number {
  return (
    typeof found === 'number' &&
    Number.isInteger(found) &&
    found === LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION
  );
}

/** The readable refusal for a pre-action capture's declared `schemaVersion`. `null` when readable. */
export function describeLiveMatchPreActionCaptureVersionProblem(found: unknown): string | null {
  if (typeof found !== 'number' || !Number.isInteger(found) || found < 1) {
    return 'This pre-action capture does not declare a readable schema version, so it cannot be read.';
  }
  if (found > LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION) {
    return (
      `This pre-action capture was written by a newer build (schema version ${String(found)}; ` +
      `this build reads up to ${String(LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION)}). Update the application.`
    );
  }
  if (found < LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION) {
    return (
      `This pre-action capture was written by an older build (schema version ${String(found)}; ` +
      `this build reads version ${String(LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION)}) and ` +
      'there is no migration for it, so it was left where it is rather than guessed at.'
    );
  }
  return null;
}

/** Throws the readable refusal above when `found` is not a version this build reads. */
export function assertReadableLiveMatchPreActionCaptureVersion(found: unknown): void {
  const problem = describeLiveMatchPreActionCaptureVersionProblem(found);
  if (problem !== null) throw new Error(problem);
}

export const liveMatchPreActionCaptureSchema = z.strictObject({
  schemaVersion: z.literal(LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION),
  /** The same opaque identifier as the match's summary envelope. */
  matchId: z.string().min(1).max(128),
  /** The seat-derived id of the player whose concede or leave this captures. */
  playerId: liveMatchParticipantIdSchema,
  turn: z.number().int().min(0),
  phase: matchPhaseSchema,
  activePlayerId: liveMatchParticipantIdSchema,
  /** `MatchState.sequence` at the instant of capture, for causal ordering against `log`. */
  sequence: z.number().int().min(0),
  /** `MatchState.pendingChoice` verbatim. Null when nothing was awaiting an answer. */
  pendingChoice: pendingChoiceSchema.nullable(),
  /** `MatchState.combat` verbatim. `EMPTY_COMBAT`-shaped when no combat was in progress. */
  combat: combatStateSchema,
  /** `MatchState.reactionWindow` verbatim. Null when no Reaction window was open. */
  reactionWindow: reactionWindowStateSchema.nullable(),
});
export type LiveMatchPreActionCapture = z.infer<typeof liveMatchPreActionCaptureSchema>;

/** Parses a pre-action capture, refusing an unreadable schema version before the strict shape check runs. */
export function parseLiveMatchPreActionCapture(input: unknown): LiveMatchPreActionCapture {
  if (input !== null && typeof input === 'object') {
    assertReadableLiveMatchPreActionCaptureVersion(
      (input as { schemaVersion?: unknown }).schemaVersion,
    );
  }
  return liveMatchPreActionCaptureSchema.parse(input);
}
