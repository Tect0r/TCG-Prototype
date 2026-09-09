import { z } from 'zod';

import { contentIdSchema } from './content.js';
import { explorerMatchIdSchema, liveMatchExplorerEvidenceSchema } from './explorers.js';
import { pageOf } from './pagination.js';
import { liveMatchDeckHashSchema, liveMatchTerminationOriginSchema } from './player-meta.js';

/**
 * M08.26D — the Match Explorer.
 *
 * The milestone's own line asks for "filterable match table, termination
 * context, event timeline, deck snapshots, selected decision diagnostics,
 * and authorized replay and surrender artifact links."
 *
 * ## Scope: the live-match record, not a catalog/simulator job's own matches
 *
 * `readLiveMatchEnvelopes`/`filterLiveMatches`/`readLiveMatchPreActionCaptures`
 * (`@tcg/simulator`) are the one evidence source Deck Explorer (M08.26B) and
 * Card Explorer (M08.26C) already read, and this file reads the same source a
 * third time rather than a different one. `packages/admin-contracts/src/artifacts.ts`'s
 * doc comment names a *second*, unrelated evidence source — a catalog or
 * simulator job's own `matches.jsonl`/`replays/` directory — as something "the
 * Match Explorer that needs them" will one day open. That is a real gap, but
 * it is a second system with its own directory layout, its own artifact
 * shapes and no existing reader anywhere in `@tcg/simulator`; wiring it is
 * materially larger than one work slice and was not the evidence source any
 * of M08.26's six work-slice lines actually named ("termination context",
 * "deck snapshots" and "surrender artifact" are live-match vocabulary
 * verbatim — `terminationOrigin`, `liveMatchDeckSnapshotSchema` and the
 * voluntary-termination pre-action capture all live on
 * `@tcg/match-telemetry`, never on a job record). Per `CLAUDE.md`'s "do not
 * silently invent unresolved rules," catalog/simulator job matches are
 * recorded here as a deliberately deferred second evidence source — the same
 * "named gap, not an invented shape" precedent `card-explorer.ts` set for
 * Replacements — rather than built without a named work slice asking for it.
 * `.claude/current-work.md`'s M08.26D entry names this as the exact next
 * question for whichever slice picks it up.
 *
 * ## Reused rather than restated
 *
 * The filterable table reuses `playerMetaFilterSchema` (`./player-meta.ts`)
 * verbatim — a match list narrowed by content version, source, Commander,
 * deck or termination is exactly the query `filterLiveMatches` already
 * answers, and a second filter shape here would be the second copy this
 * package exists to refuse. Every row and the one-match view carry
 * `observedIn: liveMatchExplorerEvidenceSchema` (`./explorers.ts`), the same
 * evidence-source field `deck-explorer.ts`/`card-explorer.ts` already attach
 * to a live-match observation. `explorerMatchIdSchema` (`./explorers.ts`) is
 * this match's own stable identifier. Cross-navigation refs
 * (`explorerRefSchema`) are not emitted by this view, matching the precedent
 * Deck and Card Explorer already set: wiring them is M08.26E's job, not
 * pre-empted here.
 *
 * ## Selected decision diagnostics: the structural scope a capture actually carries
 *
 * `apps/simulator/src/analysis/live-match-surrender.ts`'s own doc comment
 * already draws this line for the *aggregate* surrender view: a pre-action
 * capture never records board, Health or resource state, only structural
 * match state (phase, whether combat had declared attacks, whether a
 * Reaction window was open, whether a pending choice was open and its type).
 * `matchExplorerDecisionDiagnosticsSchema` draws the same line for a *single*
 * match's capture — `inCombat`/`reactionWindowOpen`/`pendingChoiceOpen`
 * mirror `SurrenderStateSummary`'s own fields exactly, rather than exposing
 * `LiveMatchPreActionCapture`'s full nested `combat`/`reactionWindow`/
 * `pendingChoice` engine state, which `@tcg/rules-engine` owns and this
 * package cannot import (`boundary.test.ts`'s "exactly zod and the shared
 * issue vocabulary"). `decisionDiagnostics` is `null` exactly when
 * `artifacts.preActionCapture` is not `'present'` — never a symptom of a
 * capture this build failed to read.
 *
 * ## Event timeline: a flattened result table, not a restated event union
 *
 * `@tcg/rules-engine`'s `gameEventSchema` is a fifty-plus-member discriminated
 * union this package cannot depend on any more than it can depend on
 * `pendingChoiceSchema`. Rather than restate it — or worse, half-restate
 * it and drift — `matchExplorerFlattenedEventSchema` reduces one logged
 * event to exactly the fields every other result table in this package
 * already reduces a rich domain object to: a `type` discriminant and a
 * bounded text `summary`, the same `resultRowSchema`/`resultCellSchema`
 * (`./results.ts`) discipline `card-explorer.ts`'s `experimentEvidence.row`
 * already leans on. The admin server owns the one flattening function, so
 * "what a summary line says" has exactly one implementation, never a second
 * one a client would have to keep in sync.
 *
 * ## Artifact availability: three states, not a boolean
 *
 * `rawEvent`/`replay`/`preActionCapture` are each configuration-gated
 * per-deployment (`liveMatchRetentionConfigSchema`,
 * `@tcg/match-telemetry`'s `retention.ts`) — a match can be fully readable
 * and still carry none of the three. `'not_applicable'` exists only for
 * `preActionCapture`, and only for a match whose `terminationOrigin` is not
 * one of the two voluntary origins — a capture can never exist there, which
 * is a different fact from "this deployment did not keep it."
 * `'not_applicable'` never appears for `rawEvent`/`replay`, which are
 * configuration-only for every termination origin.
 */

/* -------------------------------------------------------- participant identity */

/**
 * Restates `LiveMatchParticipantId` (`@tcg/match-telemetry`'s `schema.ts`)
 * narrowly, per ADR 0001 — a seat-derived label, never a display name, email
 * or account id.
 */
export const MATCH_EXPLORER_PARTICIPANT_ID_PATTERN = /^player_[1-4]$/;
export const matchExplorerParticipantIdSchema = z
  .string()
  .regex(
    MATCH_EXPLORER_PARTICIPANT_ID_PATTERN,
    'Must be a seat-derived participant id (player_1..player_4).',
  );
export type MatchExplorerParticipantId = z.infer<typeof matchExplorerParticipantIdSchema>;

/** Restates `LIVE_MATCH_PARTICIPANT_KINDS` (`@tcg/match-telemetry`'s `schema.ts`). */
export const MATCH_EXPLORER_PARTICIPANT_KINDS = ['human', 'bot'] as const;
export const matchExplorerParticipantKindSchema = z.enum(MATCH_EXPLORER_PARTICIPANT_KINDS);
export type MatchExplorerParticipantKind = z.infer<typeof matchExplorerParticipantKindSchema>;

/* ----------------------------------------------------------------- phase/outcome */

/** Restates `MATCH_PHASES` (`@tcg/rules-engine`'s `schema/primitives.ts`). */
export const MATCH_EXPLORER_PHASES = [
  'setup',
  'mulligan',
  'turn_start',
  'draw',
  'main_1',
  'declare_attackers',
  'assign_blockers',
  'resolve_combat',
  'main_2',
  'turn_end',
  'reaction_window',
  'complete',
] as const;
export const matchExplorerPhaseSchema = z.enum(MATCH_EXPLORER_PHASES);
export type MatchExplorerPhase = z.infer<typeof matchExplorerPhaseSchema>;

/** Restates `MATCH_END_REASONS` (`@tcg/rules-engine`'s `schema/state.ts`). */
export const MATCH_EXPLORER_END_REASONS = [
  'health_depleted',
  'empty_deck',
  'concede',
  'timeout',
  'simultaneous_loss',
  'engine_error',
] as const;
export const matchExplorerEndReasonSchema = z.enum(MATCH_EXPLORER_END_REASONS);
export type MatchExplorerEndReason = z.infer<typeof matchExplorerEndReasonSchema>;

/** Restates `matchResultSchema` (`@tcg/rules-engine`'s `schema/state.ts`), field for field. */
export const matchExplorerOutcomeSchema = z.strictObject({
  outcome: z.enum(['win', 'draw']),
  winnerId: matchExplorerParticipantIdSchema.nullable(),
  loserIds: z.array(matchExplorerParticipantIdSchema).max(2),
  reason: matchExplorerEndReasonSchema,
  finalTurn: z.number().int().min(0),
  finalSequence: z.number().int().min(0),
  /** Populated only when `reason` is `'engine_error'`. */
  diagnostics: z.string().max(2000).nullable(),
});
export type MatchExplorerOutcome = z.infer<typeof matchExplorerOutcomeSchema>;

/* --------------------------------------------------------------- deck snapshots */

export const MATCH_EXPLORER_MAX_DECK_ENTRIES = 64;

export const matchExplorerDeckEntrySchema = z.strictObject({
  cardId: contentIdSchema,
  quantity: z.number().int().min(1),
});
export type MatchExplorerDeckEntry = z.infer<typeof matchExplorerDeckEntrySchema>;

/** Restates `liveMatchDeckSnapshotSchema` (`@tcg/match-telemetry`'s `schema.ts`). */
export const matchExplorerDeckSnapshotSchema = z.strictObject({
  commanderId: contentIdSchema,
  cards: z.array(matchExplorerDeckEntrySchema).min(1).max(MATCH_EXPLORER_MAX_DECK_ENTRIES),
  deckHash: liveMatchDeckHashSchema,
});
export type MatchExplorerDeckSnapshot = z.infer<typeof matchExplorerDeckSnapshotSchema>;

/* ---------------------------------------------------------------------- seats */

/** A seat as it appears on a match-list row: compact, no full card list. */
export const matchExplorerSeatSummarySchema = z.strictObject({
  seatIndex: z.union([z.literal(0), z.literal(1)]),
  playerId: matchExplorerParticipantIdSchema,
  kind: matchExplorerParticipantKindSchema,
  commanderId: contentIdSchema,
  deckHash: liveMatchDeckHashSchema,
});
export type MatchExplorerSeatSummary = z.infer<typeof matchExplorerSeatSummarySchema>;

/** A seat as it appears on the one-match view: the full deck snapshot. */
export const matchExplorerSeatSchema = z.strictObject({
  seatIndex: z.union([z.literal(0), z.literal(1)]),
  playerId: matchExplorerParticipantIdSchema,
  kind: matchExplorerParticipantKindSchema,
  deck: matchExplorerDeckSnapshotSchema,
});
export type MatchExplorerSeat = z.infer<typeof matchExplorerSeatSchema>;

/* -------------------------------------------------------------- the match list */

export const matchExplorerRowSchema = z.strictObject({
  matchId: explorerMatchIdSchema,
  terminationOrigin: liveMatchTerminationOriginSchema,
  actionCount: z.number().int().min(0),
  seats: z.tuple([matchExplorerSeatSummarySchema, matchExplorerSeatSummarySchema]),
  outcome: matchExplorerOutcomeSchema.nullable(),
  observedIn: liveMatchExplorerEvidenceSchema,
});
export type MatchExplorerRow = z.infer<typeof matchExplorerRowSchema>;

export const matchExplorerListSchema = pageOf(matchExplorerRowSchema);
export type MatchExplorerList = z.infer<typeof matchExplorerListSchema>;

/* ------------------------------------------------------------ artifact states */

/**
 * `'not_applicable'` exists only for `preActionCapture`, on a match whose
 * termination was never voluntary — see file doc comment.
 */
export const MATCH_EXPLORER_ARTIFACT_STATUSES = [
  'present',
  'not_retained',
  'not_applicable',
] as const;
export const matchExplorerArtifactStatusSchema = z.enum(MATCH_EXPLORER_ARTIFACT_STATUSES);
export type MatchExplorerArtifactStatus = z.infer<typeof matchExplorerArtifactStatusSchema>;

export const matchExplorerArtifactAvailabilitySchema = z.strictObject({
  rawEvent: matchExplorerArtifactStatusSchema,
  replay: matchExplorerArtifactStatusSchema,
  preActionCapture: matchExplorerArtifactStatusSchema,
});
export type MatchExplorerArtifactAvailability = z.infer<
  typeof matchExplorerArtifactAvailabilitySchema
>;

/* ----------------------------------------------------------- flattened events */

/** One `GameEvent`, reduced to a result-table-shaped row. See file doc comment. */
export const matchExplorerFlattenedEventSchema = z.strictObject({
  sequence: z.number().int().min(0),
  type: z.string().min(1).max(64),
  /** A short, deterministic rendering of this event's own fields, never a restated union member. */
  summary: z.string().max(200),
});
export type MatchExplorerFlattenedEvent = z.infer<typeof matchExplorerFlattenedEventSchema>;

/** Most recent events one capture's `eventWindow` carries — M08.23B already bounds this small. */
export const MATCH_EXPLORER_MAX_RECENT_EVENTS = 64;

/* ----------------------------------------------------- decision diagnostics */

export const matchExplorerDecisionDiagnosticsSchema = z.strictObject({
  playerId: matchExplorerParticipantIdSchema,
  origin: z.enum(['concede_action', 'concede_leave']),
  turn: z.number().int().min(0),
  phase: matchExplorerPhaseSchema,
  activePlayerId: matchExplorerParticipantIdSchema,
  sequence: z.number().int().min(0),
  /** Whether attackers had been declared at the capture instant. */
  inCombat: z.boolean(),
  reactionWindowOpen: z.boolean(),
  pendingChoiceOpen: z.boolean(),
  /** Only present when `pendingChoiceOpen` is true. */
  pendingChoiceType: z.string().min(1).max(64).nullable(),
  recentEvents: z.array(matchExplorerFlattenedEventSchema).max(MATCH_EXPLORER_MAX_RECENT_EVENTS),
});
export type MatchExplorerDecisionDiagnostics = z.infer<
  typeof matchExplorerDecisionDiagnosticsSchema
>;

/* -------------------------------------------------------------------- the view */

export const matchExplorerViewSchema = z.strictObject({
  matchId: explorerMatchIdSchema,
  terminationOrigin: liveMatchTerminationOriginSchema,
  actionCount: z.number().int().min(0),
  seats: z.tuple([matchExplorerSeatSchema, matchExplorerSeatSchema]),
  outcome: matchExplorerOutcomeSchema.nullable(),
  artifacts: matchExplorerArtifactAvailabilitySchema,
  /** `null` exactly when `artifacts.preActionCapture` is not `'present'`. See file doc comment. */
  decisionDiagnostics: matchExplorerDecisionDiagnosticsSchema.nullable(),
  observedIn: liveMatchExplorerEvidenceSchema,
});
export type MatchExplorerView = z.infer<typeof matchExplorerViewSchema>;

/* -------------------------------------------------------------- event timeline */

/**
 * `page` is `null` exactly when `status` is not `'present'` — an unsupported
 * or unretained raw-event stream has no page to serve, never an empty one
 * that could be mistaken for a match with zero events.
 */
export const matchExplorerEventTimelineSchema = z
  .strictObject({
    status: matchExplorerArtifactStatusSchema,
    page: pageOf(matchExplorerFlattenedEventSchema).nullable(),
  })
  .refine(
    (value) => (value.status === 'present') === (value.page !== null),
    'A timeline page is present exactly when its raw-event artifact status is "present".',
  );
export type MatchExplorerEventTimeline = z.infer<typeof matchExplorerEventTimelineSchema>;
