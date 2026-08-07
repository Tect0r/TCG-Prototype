import { z } from 'zod';

/**
 * Match state schema version. Bump together with a migration whenever the
 * persisted/serialised match shape changes.
 */
export const MATCH_SCHEMA_VERSION = 1;

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
  'complete',
] as const;
export const matchPhaseSchema = z.enum(MATCH_PHASES);
export type MatchPhase = z.infer<typeof matchPhaseSchema>;

/** Phases in which a player may play cards and activate abilities. */
export const MAIN_PHASES: readonly MatchPhase[] = ['main_1', 'main_2'];

export const MATCH_STATUSES = ['mulligan', 'playing', 'waiting_for_choice', 'complete'] as const;
export const matchStatusSchema = z.enum(MATCH_STATUSES);
export type MatchStatus = z.infer<typeof matchStatusSchema>;

export const MATCH_MODES = ['1v1'] as const;
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
