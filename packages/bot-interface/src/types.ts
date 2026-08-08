import { z } from 'zod';
import type { CardDatabase } from '@tcg/card-data';
import type { Action, LegalActions, PlayerView, RngState, RulesConfig } from '@tcg/rules-engine';

/**
 * The pilot contract.
 *
 * A pilot is handed exactly what a human at that seat would have: its own
 * redacted `PlayerView`, the engine's structured `LegalActions`, the public
 * event history as that seat saw it, its own immutable configuration and its own
 * seeded generator stream. It returns one `Action` and, optionally, structured
 * diagnostics. It never receives `MatchState`, another seat's hand or deck
 * order, another seat's pending choice, or the match RNG (CLAUDE.md §13.3).
 *
 * Nothing here gives a pilot mutation access: the runner validates the returned
 * action against the current legal-action description and submits it through
 * `applyAction` itself.
 */

/** Every family of decision the current ruleset can ask a pilot to make. */
export const DECISION_FAMILIES = [
  'mulligan',
  'play_card',
  'activate_ability',
  'pass_phase',
  'declare_attackers',
  'assign_blockers',
  'submit_choice',
  'concede',
] as const;
export const decisionFamilySchema = z.enum(DECISION_FAMILIES);
export type DecisionFamily = z.infer<typeof decisionFamilySchema>;

/**
 * What a pilot is allowed to see.
 *
 * Deliberately a plain interface with no `MatchState` member: the information
 * boundary is enforced by the type, not by a convention the next pilot might
 * forget (ADR 0009).
 */
export interface BotObservation {
  /** Authoritative, redacted view of the match for this seat. */
  readonly view: PlayerView;
  /** Engine-computed legality for this seat. Never re-derived by the pilot. */
  readonly legal: LegalActions;
  /** Public match history as this seat saw it — i.e. already redacted. */
  readonly history: readonly PlayerView['log'][number][];
  /** Card definitions. Entirely public information. */
  readonly database: CardDatabase;
  /** The rules configuration the match runs under. Public. */
  readonly rulesConfig: RulesConfig;
  /** How many decisions this seat has already made, for budget accounting. */
  readonly decisionIndex: number;
}

/**
 * Why a pilot chose what it chose. Serializable, so it can be written into a
 * replay bundle and read back without the pilot that produced it.
 */
export const botDiagnosticsSchema = z.strictObject({
  family: decisionFamilySchema,
  /** Stable key of the chosen candidate, for diffing two pilots' decisions. */
  chosenKey: z.string(),
  candidateCount: z.number().int().min(0),
  /** Every candidate considered and its score, in evaluation order. */
  scores: z.array(z.strictObject({ key: z.string(), score: z.number() })),
  /** Set when the choice came down to the pilot's RNG rather than the scores. */
  brokeTie: z.boolean(),
  notes: z.array(z.string()),
});
export type BotDiagnostics = z.infer<typeof botDiagnosticsSchema>;

export interface BotDecision {
  readonly action: Action;
  /**
   * Successor generator state. Returned rather than mutated so a pilot stays a
   * pure function of (observation, config, rng) and replays exactly.
   */
  readonly rng: RngState;
  readonly diagnostics: BotDiagnostics | null;
}

/**
 * A pilot. `decide` may return a promise so a future networked or learned pilot
 * fits the same contract; every built-in pilot is synchronous and fast.
 */
export interface BotPolicy {
  /** Stable identifier, recorded in every result. */
  readonly id: string;
  /** Bumped whenever the decision function changes, so old results stay honest. */
  readonly version: string;
  /** Immutable, serializable configuration, exported in result metadata. */
  readonly config: Readonly<Record<string, unknown>>;
  decide(observation: BotObservation, rng: RngState): BotDecision | Promise<BotDecision>;
}

/** A pilot failure, recorded rather than hidden as an ordinary decision. */
export const BOT_FAILURE_KINDS = [
  'threw',
  'illegal_action',
  'no_action',
  'budget_exceeded',
] as const;
export const botFailureKindSchema = z.enum(BOT_FAILURE_KINDS);
export type BotFailureKind = z.infer<typeof botFailureKindSchema>;

export const botFailureSchema = z.strictObject({
  kind: botFailureKindSchema,
  botId: z.string(),
  playerId: z.string(),
  decisionIndex: z.number().int().min(0),
  message: z.string(),
});
export type BotFailure = z.infer<typeof botFailureSchema>;

/** A candidate action a pilot is choosing between, with a stable ordering key. */
export interface ActionCandidate {
  readonly action: Action;
  readonly family: DecisionFamily;
  /**
   * Stable, human-readable, seed-independent. Used both as the tie-break
   * ordering key and as the diagnostics label, so two runs of the same pilot on
   * the same observation always resolve a tie the same way.
   */
  readonly key: string;
  readonly notes?: readonly string[];
}
