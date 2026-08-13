import { z } from 'zod';

/**
 * Honest agent classes (M05.4).
 *
 * A pilot is not a skill level on one axis. `random_legal` and `value` are not
 * "a worse player and a better player": they are two instruments that measure
 * different things, and the difference between them is *what may be cited from a
 * run they flew*, not how well they did. This module encodes that as data.
 *
 * Four classes, fixed by the milestone:
 *
 * - **random-legal** — legality, termination, loops and crashes. Nothing else.
 * - **generic heuristic** — the above plus approximate play quality, on the
 *   linear mechanics the valuation actually prices.
 * - **archetype-aware** — the above plus synergy, sacrifice, control and combo,
 *   because those need a pilot that knows what its deck is trying to do.
 * - **human playtest** — the above plus a final balance conclusion.
 *
 * Three rules are structural rather than conventional:
 *
 * - `AGENT_CLASS_CLAIMS` is a total `Record` over both vocabularies, so adding a
 *   class or a claim without deciding every pair is a compile error, and
 *   `agentClassGaps()` says the same at runtime for the JSON-driven paths.
 * - Claims are **monotone** along `AGENT_CLASSES`, which is ordered weakest
 *   first. That is asserted by a test rather than assumed by a fold, so a future
 *   class that is genuinely incomparable fails loudly instead of being averaged
 *   into a rank.
 * - A set of classes carries a claim only when **every** class in it does. A run
 *   flown by two classes produces one pooled win-rate column, and the pooled
 *   column is only as good as its weakest instrument — which is the whole of
 *   "never pool these as one skill distribution": report them apart, and cite the
 *   pooled number only for what all of them support.
 */

/**
 * Bumped when a *classification* changes — a class gaining or losing a claim —
 * so a manifest's citations can be read against the registry that made them.
 *
 * - 1 — M05.4, the first registry.
 */
export const AGENT_CLASS_REGISTRY_VERSION = 1;

/** Ordered weakest first. The order is the report's order, and nothing else. */
export const AGENT_CLASSES = [
  'random_legal',
  'generic_heuristic',
  'archetype_aware',
  'human_playtest',
] as const;
export const agentClassSchema = z.enum(AGENT_CLASSES);
export type AgentClass = z.infer<typeof agentClassSchema>;

/**
 * What a run can be cited *for*.
 *
 * Deliberately phrased as evidence rather than as capability: `control` is not
 * "the pilot plays counterspells", it is "this run may be cited about reactive
 * interaction". A claim with no flag pointing at it today is still worth naming,
 * because the vocabulary is what a future analysis has to classify itself
 * against.
 */
export const EVIDENCE_CLAIMS = [
  /** The run itself: how many matches ran, failed, ended abnormally. */
  'run_integrity',
  /** Every action taken was one the engine offered. */
  'legality',
  /** Matches end rather than running forever. */
  'termination',
  /** Repeated states and no-progress cycles are discovered. */
  'loop_freedom',
  /** Engine errors are discovered. */
  'crash_freedom',
  /**
   * A difference the *rules* produce rather than the play — seat order being the
   * only one today. Uniform random play is an unbiased probe of it, which is why
   * `random_legal` carries this and carries nothing else about outcomes.
   */
  'structural_asymmetry',
  /** Approximate quality of play, on mechanics the valuation prices. */
  'play_quality',
  /** Two cards being worth more together than apart. */
  'synergy',
  /** Sacrifice and cost-payment decisions being made well enough to judge. */
  'sacrifice',
  /** Reactive interaction: counters, removal timing, answers held. */
  'control',
  /** Multi-card sequences assembled on purpose. */
  'combo',
  /** A balance conclusion fit to change the cards on. */
  'final_balance',
] as const;
export const evidenceClaimSchema = z.enum(EVIDENCE_CLAIMS);
export type EvidenceClaim = z.infer<typeof evidenceClaimSchema>;

/** One line per claim, for the report. Total, so a new claim needs a sentence. */
export const EVIDENCE_CLAIM_QUESTIONS: Readonly<Record<EvidenceClaim, string>> = Object.freeze({
  run_integrity: 'How did this run itself behave?',
  legality: 'Did every seat only ever take an action the engine offered?',
  termination: 'Do matches end?',
  loop_freedom: 'Do matches avoid no-progress cycles?',
  crash_freedom: 'Does the engine survive what these decks do?',
  structural_asymmetry: 'Do the rules favour a seat regardless of how it is played?',
  play_quality: 'How did these cards perform when somebody tried to use them?',
  synergy: 'Are these two cards worth more together?',
  sacrifice: 'Are sacrifice and cost decisions being made well enough to judge the cards?',
  control: 'Is reactive interaction being played well enough to judge the cards?',
  combo: 'Is a multi-card sequence being assembled on purpose?',
  final_balance: 'Should the cards change?',
});

export interface AgentClassDefinition {
  readonly id: AgentClass;
  readonly label: string;
  /** What the class *is*, in one sentence a report can print. */
  readonly summary: string;
  /** Total over the claim vocabulary: every pair is decided. */
  readonly claims: Readonly<Record<EvidenceClaim, boolean>>;
}

/**
 * The registry.
 *
 * Read a column, not a row, to see the point: `synergy` is false for every class
 * a pilot in this software belongs to, so no run this build can produce is
 * evidence about synergy — however many matches it plays.
 */
export const AGENT_CLASS_REGISTRY: Readonly<Record<AgentClass, AgentClassDefinition>> =
  Object.freeze({
    random_legal: {
      id: 'random_legal',
      label: 'random-legal',
      summary:
        'Samples uniformly from whatever the engine offers. Evidence for legality, termination, ' +
        'loops, crashes and seat-order asymmetry; evidence for nothing about how good a card is.',
      claims: {
        run_integrity: true,
        legality: true,
        termination: true,
        loop_freedom: true,
        crash_freedom: true,
        structural_asymmetry: true,
        play_quality: false,
        synergy: false,
        sacrifice: false,
        control: false,
        combo: false,
        final_balance: false,
      },
    },
    generic_heuristic: {
      id: 'generic_heuristic',
      label: 'generic heuristic',
      summary:
        'Scores candidate actions with a transparent, deck-agnostic valuation. Approximate play ' +
        'quality on the mechanics that valuation prices, and nothing that needs a plan.',
      claims: {
        run_integrity: true,
        legality: true,
        termination: true,
        loop_freedom: true,
        crash_freedom: true,
        structural_asymmetry: true,
        play_quality: true,
        synergy: false,
        sacrifice: false,
        control: false,
        combo: false,
        final_balance: false,
      },
    },
    archetype_aware: {
      id: 'archetype_aware',
      label: 'archetype-aware',
      summary:
        'Plays a deck according to a declared plan, so a card kept for a later turn, a sacrifice ' +
        'paid on purpose and an answer held for the right threat are decisions rather than ' +
        'accidents. Required before synergy, sacrifice, control or combo evidence.',
      claims: {
        run_integrity: true,
        legality: true,
        termination: true,
        loop_freedom: true,
        crash_freedom: true,
        structural_asymmetry: true,
        play_quality: true,
        synergy: true,
        sacrifice: true,
        control: true,
        combo: true,
        final_balance: false,
      },
    },
    human_playtest: {
      id: 'human_playtest',
      label: 'human playtest',
      summary:
        'People playing the decks. The only class a final balance conclusion may rest on; every ' +
        'simulated class above is calibration for it.',
      claims: {
        run_integrity: true,
        legality: true,
        termination: true,
        loop_freedom: true,
        crash_freedom: true,
        structural_asymmetry: true,
        play_quality: true,
        synergy: true,
        sacrifice: true,
        control: true,
        combo: true,
        final_balance: true,
      },
    },
  });

export function agentClassDefinition(agentClass: AgentClass): AgentClassDefinition {
  return AGENT_CLASS_REGISTRY[agentClass];
}

export function agentClassSupports(agentClass: AgentClass, claim: EvidenceClaim): boolean {
  return AGENT_CLASS_REGISTRY[agentClass].claims[claim];
}

/** Every claim one class supports, in vocabulary order. */
export function claimsOf(agentClass: AgentClass): EvidenceClaim[] {
  return EVIDENCE_CLAIMS.filter((claim) => agentClassSupports(agentClass, claim));
}

/**
 * Does a *set* of classes carry a claim?
 *
 * Only when all of them do, and never when the set is empty. A run's headline
 * numbers pool every seat that played, so the pooled number inherits the weakest
 * instrument in the run; and a run with no recognised pilot has produced no
 * evidence this build can vouch for at all, which is a different statement from
 * "everything is fine".
 */
export function claimCarriedBy(classes: readonly AgentClass[], claim: EvidenceClaim): boolean {
  return classes.length > 0 && classes.every((agentClass) => agentClassSupports(agentClass, claim));
}

export function claimsCarriedBy(classes: readonly AgentClass[]): EvidenceClaim[] {
  return EVIDENCE_CLAIMS.filter((claim) => claimCarriedBy(classes, claim));
}

/** Which classes in the set are the reason a claim is not carried. */
export function classesBlocking(
  classes: readonly AgentClass[],
  claim: EvidenceClaim,
): AgentClass[] {
  return AGENT_CLASSES.filter(
    (agentClass) => classes.includes(agentClass) && !agentClassSupports(agentClass, claim),
  );
}

/**
 * Runtime twin of the type-level totality check.
 *
 * The `Record` types already fail a build that adds a class or a claim without
 * deciding every pair. This catches the other direction — an entry for a class
 * or claim the vocabulary no longer has — and covers callers that arrive with a
 * string. Returns the problems rather than throwing, so all of them are visible
 * at once.
 */
export function agentClassGaps(): string[] {
  const problems: string[] = [];
  const claims = new Set<string>(EVIDENCE_CLAIMS);
  const classes = new Set<string>(AGENT_CLASSES);

  for (const key of Object.keys(AGENT_CLASS_REGISTRY)) {
    if (!classes.has(key)) problems.push(`agent class "${key}" is classified but not in the list.`);
  }
  for (const key of Object.keys(EVIDENCE_CLAIM_QUESTIONS)) {
    if (!claims.has(key)) problems.push(`claim "${key}" has a question but is not in the list.`);
  }
  for (const agentClass of AGENT_CLASSES) {
    const definition = AGENT_CLASS_REGISTRY[agentClass];
    if (definition.id !== agentClass) {
      problems.push(`agent class "${agentClass}" is filed under the wrong key.`);
    }
    for (const key of Object.keys(definition.claims)) {
      if (!claims.has(key)) {
        problems.push(`agent class "${agentClass}" decides "${key}", which is not a claim.`);
      }
    }
    for (const claim of EVIDENCE_CLAIMS) {
      if (typeof definition.claims[claim] !== 'boolean') {
        problems.push(`agent class "${agentClass}" does not decide "${claim}".`);
      }
    }
  }
  return problems;
}

export function assertAgentClassRegistryComplete(): void {
  const problems = agentClassGaps();
  if (problems.length > 0) {
    throw new Error(`Agent class registry is out of date:\n- ${problems.join('\n- ')}`);
  }
}
