import { deckFingerprint } from '@tcg/deck';
import { z } from 'zod';
import {
  combatStateSchema,
  matchPhaseSchema,
  pendingChoiceSchema,
  reactionWindowStateSchema,
} from '@tcg/rules-engine';
import { liveMatchEventWindowSchema } from './event-window.js';
import {
  liveMatchDeckSnapshotSchema,
  liveMatchParticipantIdSchema,
  liveMatchProvenanceSchema,
  liveMatchVoluntaryTerminationOriginSchema,
} from './schema.js';

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
 * the reason. `eventWindow` (M08.23B) adds the last meaningful event chain,
 * the current/previous turn windows and each retained event's distance from
 * the capture instant — in events, actions and turns — but never labels any
 * of them as causal; that judgment is reserved for a human reviewing
 * exposure-adjusted aggregates later (M08.24D). `provenance` and `deck`
 * (also M08.23B) place the capture against the content/rules build and the
 * conceding player's own deck, reusing `@tcg/deck`'s and this package's own
 * verbatim shapes rather than restating them. `origin` (M08.23C) distinguishes
 * an explicit `concede` action from a `leave()`-triggered concession — the
 * same two-value split `LIVE_MATCH_VOLUNTARY_TERMINATION_ORIGINS` draws on the
 * finished-match envelope's own `terminationOrigin` — but still assigns no
 * cause: it names which mechanism the player used, never why.
 */

export const LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION = 3;

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

export const liveMatchPreActionCaptureSchema = z
  .strictObject({
    schemaVersion: z.literal(LIVE_MATCH_PRE_ACTION_CAPTURE_SCHEMA_VERSION),
    /** The same opaque identifier as the match's summary envelope. */
    matchId: z.string().min(1).max(128),
    /** The seat-derived id of the player whose concede or leave this captures. */
    playerId: liveMatchParticipantIdSchema,
    /** Which voluntary mechanism the player used (M08.23C): an explicit concede action, or leaving the match. */
    origin: liveMatchVoluntaryTerminationOriginSchema,
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
    /** The recent event chain, its per-event distances and the turn windows either side of `sequence` (M08.23B). */
    eventWindow: liveMatchEventWindowSchema,
    /** The content/rules build the capture was taken under. Never a claim about the current build. */
    provenance: liveMatchProvenanceSchema,
    /** The conceding player's own deck, exactly as it stood for this match. */
    deck: liveMatchDeckSnapshotSchema,
  })
  .superRefine((capture, ctx) => {
    const { eventWindow } = capture;

    if (eventWindow.currentTurnWindow.turn !== capture.turn) {
      ctx.addIssue({
        code: 'custom',
        path: ['eventWindow', 'currentTurnWindow', 'turn'],
        message: "The current turn window's turn must match the capture's own turn.",
      });
    }
    if (eventWindow.currentTurnWindow.endSequence !== capture.sequence) {
      ctx.addIssue({
        code: 'custom',
        path: ['eventWindow', 'currentTurnWindow', 'endSequence'],
        message: "The current turn window must end at the capture's own sequence.",
      });
    }

    const { previousTurnWindow, currentTurnWindow } = eventWindow;
    if (currentTurnWindow.turn <= 1) {
      if (previousTurnWindow !== null) {
        ctx.addIssue({
          code: 'custom',
          path: ['eventWindow', 'previousTurnWindow'],
          message: 'Turn 0 or 1 has no previous turn window; it must be null.',
        });
      }
    } else if (previousTurnWindow === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['eventWindow', 'previousTurnWindow'],
        message: 'A capture past turn 1 must carry its previous turn window.',
      });
    } else if (previousTurnWindow.turn !== currentTurnWindow.turn - 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['eventWindow', 'previousTurnWindow', 'turn'],
        message: "The previous turn window's turn must be exactly one less than the current one's.",
      });
    } else if (previousTurnWindow.endSequence + 1 !== currentTurnWindow.startSequence) {
      ctx.addIssue({
        code: 'custom',
        path: ['eventWindow', 'previousTurnWindow', 'endSequence'],
        message: 'The previous turn window must end immediately before the current one starts.',
      });
    }

    if (eventWindow.recentEvents.length !== eventWindow.eventDistances.length) {
      ctx.addIssue({
        code: 'custom',
        path: ['eventWindow', 'eventDistances'],
        message: 'There must be exactly one event distance per recent event.',
      });
    } else {
      eventWindow.recentEvents.forEach((event, index) => {
        const distance = eventWindow.eventDistances[index];
        if (distance === undefined || distance.sequence !== event.sequence) {
          ctx.addIssue({
            code: 'custom',
            path: ['eventWindow', 'eventDistances', index, 'sequence'],
            message: 'Event distances must be recorded in the same order as their recent events, by sequence.',
          });
        } else if (distance.eventsAgo !== capture.sequence - event.sequence) {
          ctx.addIssue({
            code: 'custom',
            path: ['eventWindow', 'eventDistances', index, 'eventsAgo'],
            message: "eventsAgo must equal the capture's sequence minus this event's own sequence.",
          });
        }
      });
      const lastEvent = eventWindow.recentEvents.at(-1);
      if (lastEvent !== undefined && lastEvent.sequence !== capture.sequence) {
        ctx.addIssue({
          code: 'custom',
          path: ['eventWindow', 'recentEvents'],
          message: "The most recent retained event must be the one at the capture's own sequence.",
        });
      }
    }

    const expectedHash = deckFingerprint({
      commanderId: capture.deck.commanderId,
      cards: capture.deck.cards,
    });
    if (capture.deck.deckHash !== expectedHash) {
      ctx.addIssue({
        code: 'custom',
        path: ['deck', 'deckHash'],
        message: "This deck snapshot's hash does not match its own contents.",
      });
    }
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
