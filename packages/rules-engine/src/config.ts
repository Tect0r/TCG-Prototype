import { z } from 'zod';

/**
 * Rules configuration version. Every match records the version it was created
 * with so replays and logs can be interpreted correctly after a balance change.
 *
 * Bump the minor version when a provisional value changes; bump the major
 * version when a structural rule changes (and write a rules decision record
 * first — CLAUDE.md §17).
 */
export const RULES_VERSION = '0.2.0';

/**
 * Every provisional numeric rule lives here, in one place (CLAUDE.md §4).
 * Nothing in the engine may inline these values.
 *
 * All of them are playtest dials, not confirmed balance. See
 * `docs/rules/open-decisions.md` for the current status of each.
 */
export const rulesConfigSchema = z.strictObject({
  version: z.string().min(1),

  /** Starting player health. */
  startingHealth: z.number().int().min(1).max(999),
  /** Cards drawn in the opening hand, before any redraw. */
  openingHandSize: z.number().int().min(0).max(20),
  /** Cards a player may hold at the end of their own turn. */
  maxHandSize: z.number().int().min(1).max(50),
  /** How many free opening-hand redraws each player gets. */
  openingRedraws: z.number().int().min(0).max(5),
  /** The player who acts first skips their first normal draw step. */
  firstPlayerSkipsFirstDraw: z.boolean(),

  /** Maximum energy on a player's very first turn. */
  startingMaxEnergy: z.number().int().min(0).max(20),
  /** Maximum energy gained at the start of each of a player's turns. */
  energyGainPerTurn: z.number().int().min(0).max(20),
  /** Hard ceiling on maximum energy. */
  energyCap: z.number().int().min(1).max(50),

  /** Unit slots available to each player. */
  unitSlots: z.number().int().min(1).max(20),
  /** Relics each player may control at once. */
  relicSlots: z.number().int().min(0).max(20),

  /** Exhausted units may still be assigned as blockers. */
  exhaustedUnitsMayBlock: z.boolean(),
  /** How many blockers a single attacker may receive. */
  blockersPerAttacker: z.number().int().min(1).max(5),
  /** Damage reduction granted by one instance of the `armored` keyword. */
  armoredReduction: z.number().int().min(0).max(10),

  /** Drawing from an empty deck loses the match (rather than dealing fatigue). */
  emptyDeckDrawLoses: z.boolean(),

  /**
   * Safeguards. A match that exceeds either limit terminates with a structured
   * engine error and a complete log instead of hanging (CLAUDE.md §9).
   */
  maxResolutionSteps: z.number().int().min(16).max(100_000),
  maxRepeatedStates: z.number().int().min(2).max(1000),

  /**
   * Server-enforced, not engine-enforced: the engine never reads a clock. The
   * value lives here so every provisional rule number has one home.
   */
  disconnectGraceSeconds: z.number().int().min(0).max(3600),
});

export type RulesConfig = z.infer<typeof rulesConfigSchema>;

export const DEFAULT_RULES_CONFIG: RulesConfig = Object.freeze({
  version: RULES_VERSION,

  startingHealth: 20,
  openingHandSize: 5,
  maxHandSize: 10,
  openingRedraws: 1,
  firstPlayerSkipsFirstDraw: true,

  startingMaxEnergy: 1,
  energyGainPerTurn: 1,
  energyCap: 10,

  unitSlots: 5,
  relicSlots: 3,

  exhaustedUnitsMayBlock: true,
  blockersPerAttacker: 1,
  armoredReduction: 1,

  emptyDeckDrawLoses: true,

  maxResolutionSteps: 2000,
  maxRepeatedStates: 20,

  disconnectGraceSeconds: 90,
});

/** Validates an externally supplied (or persisted) configuration. */
export function parseRulesConfig(input: unknown): RulesConfig {
  return rulesConfigSchema.parse(input);
}
