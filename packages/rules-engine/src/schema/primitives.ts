import { z } from 'zod';

/**
 * Match state schema version. Bump together with a migration whenever the
 * persisted/serialised match shape changes.
 *
 * v2 (Phase 3) added the stable seat order, the terminal `removed` zone, the
 * derived continuous-effect layer on every instance, and per-defender combat.
 *
 * v3 (Precon Wave 1) removed the unit-slot model: `PlayerState.units` became a
 * dense list with no fixed length, and `CardInstance.slot` disappeared entirely
 * (ruleset update §7, ADR 0016 §2). There is no v2→v3 migration function
 * because a `MatchState` is never persisted between processes — lobbies and
 * matches live in memory and a server restart ends them (CLAUDE.md §11). A v2
 * document therefore fails validation loudly instead of being silently
 * reinterpreted, which is the correct outcome for a shape whose only writers
 * are same-version processes and whose replay bundles are regenerated.
 *
 * v4 (Precon Wave 1) added the two "survived combat as a blocker" records: the
 * `survivedAsBlocker` flag on `CardInstance` and the matching turn-history list
 * (ruleset update §15). No migration, for the reason given for v3.
 *
 * v5 (rule adjustments) added `MatchState.reactionWindow`, the `reaction_window`
 * phase, and the two per-player Commander/Reaction records
 * (`commanderDefeats`, `reactionDiscountSpent`). No migration, for the reason
 * given for v3.
 *
 * v6 (Precon Wave 1) added the two halves of optional instructions and
 * interactive costs: `ResolutionItem.previousStepActed`, which is what "if you
 * do" reads, and the `cost_selection` continuation, which is a paused *action*
 * rather than a paused resolution. No migration, for the reason given for v3.
 *
 * v7 (M05.3) added `PendingChoice.provenance`: the resolution item and effect
 * index that asked, the asking instruction, the source's controller, how the
 * seat being asked relates to it, whose entities the options are, and what being
 * selected does to the thing selected. No migration, for the reason given for
 * v3 — and a v6 document could not be migrated anyway, because the intent of a
 * question that has already been asked is not recoverable from the answer.
 */
export const MATCH_SCHEMA_VERSION = 7;

/** Seats a single match may hold. Two is 1v1; three and four are free-for-all. */
export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 4;

/** Seat identity within a match. Not an account: temporary for the match. */
export const playerIdSchema = z.string().min(1).max(64);
export type PlayerId = z.infer<typeof playerIdSchema>;

/**
 * Identity of one physical card *in this match*. Distinct from the permanent
 * `CardId` of its definition: two copies of `goblin_scout` are one definition
 * and two instances (CLAUDE.md §10).
 */
export const instanceIdSchema = z.string().min(1).max(64);
export type InstanceId = z.infer<typeof instanceIdSchema>;

/**
 * The turn state machine. `setup` and `mulligan` precede turn 1; the eight
 * in-turn phases are the provisional sequence from CLAUDE.md §4.
 *
 * Phase legality is enforced here, never by the UI.
 */
export const MATCH_PHASES = [
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
  /**
   * A bounded Reaction window is open (rule adjustment §5).
   *
   * One phase rather than one per window: *which* window it is, whose priority
   * it is, and what the window is about are all facts about the window and live
   * on `MatchState.reactionWindow`, which also records the phase to return to.
   * Splitting it into six phases would put the same information in two places
   * and make every exhaustive phase switch six cases longer for no rule.
   */
  'reaction_window',
  'complete',
] as const;
export const matchPhaseSchema = z.enum(MATCH_PHASES);
export type MatchPhase = z.infer<typeof matchPhaseSchema>;

/** Phases in which a player may play cards and activate abilities. */
export const MAIN_PHASES: readonly MatchPhase[] = ['main_1', 'main_2'];

export const MATCH_STATUSES = ['mulligan', 'playing', 'waiting_for_choice', 'complete'] as const;
export const matchStatusSchema = z.enum(MATCH_STATUSES);
export type MatchStatus = z.infer<typeof matchStatusSchema>;

/**
 * `1v1` and `ffa` run through exactly the same engine paths — the mode is
 * recorded for logs and presentation, never branched on for a rule. A
 * two-player free-for-all and a 1v1 are the same match (CLAUDE.md §12).
 */
export const MATCH_MODES = ['1v1', 'ffa'] as const;
export const matchModeSchema = z.enum(MATCH_MODES);
export type MatchMode = z.infer<typeof matchModeSchema>;

/** Why a player left the match. Recorded on both the player and the result. */
export const LOSS_REASONS = [
  'health_depleted',
  'empty_deck',
  'concede',
  'timeout',
  'engine_error',
] as const;
export const lossReasonSchema = z.enum(LOSS_REASONS);
export type LossReason = z.infer<typeof lossReasonSchema>;
