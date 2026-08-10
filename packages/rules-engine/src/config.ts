import { z } from 'zod';

/**
 * Rules configuration version. Every match records the version it was created
 * with so replays and logs can be interpreted correctly after a balance change.
 *
 * Bump the minor version when a provisional value changes; bump the major
 * version when a structural rule changes (and write a rules decision record
 * first — CLAUDE.md §17).
 */
export const RULES_VERSION = '0.4.0';

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

  /**
   * Relics each player may control at once. One, under `precon_wave_1`:
   * playing another **replaces** the current one rather than being refused
   * (ruleset update §12, ADR 0016 §3).
   *
   * Still a dial rather than a constant, because "how many relics" is a
   * playtest question. Zero is meaningful and means relics cannot be played at
   * all; above one, the oldest is replaced first.
   *
   * There is deliberately no companion `unitSlots`. The battlefield is
   * unbounded (ruleset update §7, ADR 0016 §2): the cap was *removed* rather
   * than raised, and must not come back as a large number here or as a hidden
   * limit anywhere else. Energy is the intended constraint, and §17's telemetry
   * exists to judge whether it is sufficient.
   */
  relicSlots: z.number().int().min(0).max(20),

  /**
   * Exhausted units may still be assigned as blockers.
   *
   * `false` under the confirmed ruleset: a unit must be Ready to block
   * (ruleset update §8/§9). Kept as a dial because the blocking economy is one
   * of the loudest playtest levers there is — turning it back on makes defence
   * nearly free, and it is worth being able to measure that rather than argue
   * about it.
   *
   * This dial covers only *who may be declared*. The other half of §8 —
   * declaring a blocker **exhausts** it — is unconditional engine behaviour in
   * `flow.ts#finalizeBlockers`, because it is a confirmed rule rather than a
   * number. The two are coherent together: with this set to `true` an already
   * exhausted unit may block, and blocking still spends a ready one.
   */
  exhaustedUnitsMayBlock: z.boolean(),
  /** How many blockers a single attacker may receive. */
  blockersPerAttacker: z.number().int().min(1).max(5),
  /** Damage reduction granted by one instance of the `armored` keyword. */
  armoredReduction: z.number().int().min(0).max(10),

  /**
   * Extra Energy a Commander's deployment costs for each time it has already
   * been defeated (rule adjustment §2).
   *
   * The escalation is what makes a Commander a resource rather than a permanent
   * fixture: it comes straight back to the Command Zone when it dies, and the
   * only thing that gets worse is the price of bringing it out again.
   */
  commanderCostPerDefeat: z.number().int().min(0).max(10),
  /**
   * Ceiling on a Commander's **total** deployment cost, not on the surcharge.
   *
   * `10` for the current test phase, which equals `energyCap` and therefore
   * keeps a much-defeated Commander expensive but always eventually playable.
   * The likely later experiment is `11`, which would make it unplayable under a
   * 10-Energy maximum; that is a deliberate, separate decision and is why this
   * is a dial rather than a constant.
   */
  commanderCostCap: z.number().int().min(0).max(50),

  /**
   * Whether Reaction cards may be played at all (rule adjustment §5).
   *
   * A dial because Reactions are the one addition that changes the *shape* of a
   * turn rather than a number in it: with this off, a match runs exactly the
   * pre-Reaction phase machine, which is what makes "did Reactions cause this?"
   * an answerable question in a balance run rather than a guess.
   */
  reactionsEnabled: z.boolean(),
  /**
   * How many Reactions one player may play in a single window. One, under the
   * MVP response system; kept here because the chaining policy is explicitly
   * versioned and replaceable (CLAUDE.md §17).
   */
  reactionsPerPlayerPerWindow: z.number().int().min(1).max(5),
  /**
   * The floor a cost reduction may not take a cost below when the reducing
   * effect prints one — "costs 1 less, **to a minimum of 1**" (ruleset update
   * §5). Reductions that print no minimum still bottom out at zero.
   */
  costReductionFloor: z.number().int().min(0).max(10),

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

  relicSlots: 1,

  exhaustedUnitsMayBlock: false,
  blockersPerAttacker: 1,
  armoredReduction: 1,

  commanderCostPerDefeat: 1,
  commanderCostCap: 10,

  reactionsEnabled: true,
  reactionsPerPlayerPerWindow: 1,
  costReductionFloor: 1,

  emptyDeckDrawLoses: true,

  maxResolutionSteps: 2000,
  maxRepeatedStates: 20,

  disconnectGraceSeconds: 90,
});

/** Validates an externally supplied (or persisted) configuration. */
export function parseRulesConfig(input: unknown): RulesConfig {
  return rulesConfigSchema.parse(input);
}
