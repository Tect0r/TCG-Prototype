import {
  ARCHETYPE_IDS,
  PACKAGE_ROLES,
  type ArchetypeId,
  type DeckPlan,
  type PackageRole,
} from './schema/deck-plan.js';

/**
 * The archetype registry (M05.5).
 *
 * An archetype is what a deck is *trying to do*, named once so that four
 * separate systems can agree about it: the authored deck plans, the generator
 * that seeds a population from one, the mutation operator that protects or
 * replaces its packages, and the report that says which decks in a run were
 * built to a plan and which were not.
 *
 * The shape follows the two registries M05 already added, for the same reason
 * they have it:
 *
 * - `ARCHETYPE_REGISTRY` is a total `Record` over `ARCHETYPE_IDS`, and
 *   `requiredRoles` is checked against `PACKAGE_ROLES`, so adding an archetype
 *   or a package role without deciding what it means is a compile error;
 *   `archetypeGaps()` is the runtime twin for the JSON-driven paths, which is
 *   every path here — a deck plan arrives as content.
 * - `ARCHETYPE_REGISTRY_VERSION` pins the taxonomy a run's citations were made
 *   against, so a manifest recording "these decks were built to `token_swarm`"
 *   can be read later against the definition that was in force.
 *
 * What this registry deliberately does **not** contain: any card ID. An
 * archetype is a strategy, and the cards that express it are a deck plan's
 * business — that is what keeps the vocabulary stable when the card pool moves.
 */

/**
 * Bumped when a *classification* changes: an archetype gaining or losing a
 * required role, or the vocabulary itself changing.
 *
 * - 1 — M05.5, the first registry.
 */
export const ARCHETYPE_REGISTRY_VERSION = 1;

export interface ArchetypeDefinition {
  readonly id: ArchetypeId;
  readonly label: string;
  /** What the archetype is, in one sentence a report can print. */
  readonly summary: string;
  /**
   * The package roles a plan for this archetype must supply.
   *
   * Enforced by the content build, and the reason a plan cannot claim an
   * archetype while omitting the thing that makes it one: a `token_swarm` plan
   * without a payoff package is a pile of Tokens, and calling it `token_swarm`
   * would make the label mean nothing to the search that reads it.
   */
  readonly requiredRoles: readonly PackageRole[];
  /**
   * The claim this archetype makes about how its deck wants to be *played*,
   * for the report. Not executable: no pilot in this build is archetype-aware,
   * and M05.4's registry is what says so.
   */
  readonly pilotNote: string;
}

export const ARCHETYPE_REGISTRY: Readonly<Record<ArchetypeId, ArchetypeDefinition>> = Object.freeze(
  {
    token_swarm: {
      id: 'token_swarm',
      label: 'token swarm',
      summary:
        'Produce more bodies than the opponent can answer individually, then convert board width ' +
        'into damage with effects that scale on the number of Units.',
      requiredRoles: ['engine', 'payoff', 'curve'],
      pilotNote:
        'Wants to hold a wide-board payoff until the board is wide, which a valuation that prices ' +
        'each card alone cannot express.',
    },
    defensive_attrition: {
      id: 'defensive_attrition',
      label: 'defensive attrition',
      summary:
        'Trade profitably on defence, keep the blockers that survive, and turn a formation that ' +
        'the opponent could not break into a counterattack.',
      requiredRoles: ['defense', 'payoff', 'consistency'],
      pilotNote:
        'Wants to decline attacks it could make, which reads as passivity to a pilot that scores ' +
        'an attack by its damage.',
    },
    sacrifice_value: {
      id: 'sacrifice_value',
      label: 'sacrifice value',
      summary:
        'Treat expendable Units as a renewable resource: pair outlets with effects that pay on a ' +
        'defeat, recur the fodder, and win on the accumulated drain.',
      requiredRoles: ['engine', 'payoff', 'interaction'],
      pilotNote:
        'Wants to pay costs it is not forced to pay, which a valuation that prices a sacrifice as ' +
        'a loss will never choose.',
    },
    reactive_control: {
      id: 'reactive_control',
      label: 'reactive control',
      summary:
        'Survive the early turns, answer what has to be answered and hold Energy for Reactions, ' +
        'then win late on accumulated card advantage.',
      requiredRoles: ['interaction', 'defense', 'consistency'],
      pilotNote:
        'Wants to spend a turn doing nothing so that an answer is available on the opponent’s ' +
        'turn, which a pilot that maximises each turn in isolation cannot represent.',
    },
  },
);

export function archetypeDefinition(archetypeId: ArchetypeId): ArchetypeDefinition {
  return ARCHETYPE_REGISTRY[archetypeId];
}

/** Roles a plan for this archetype must supply, in vocabulary order. */
export function requiredRolesOf(archetypeId: ArchetypeId): readonly PackageRole[] {
  return PACKAGE_ROLES.filter((role) =>
    ARCHETYPE_REGISTRY[archetypeId].requiredRoles.includes(role),
  );
}

/** The required roles a plan does not supply. Empty means the plan is complete. */
export function missingRolesOf(plan: DeckPlan): PackageRole[] {
  const present = new Set(plan.packages.map((entry) => entry.role));
  return requiredRolesOf(plan.archetypeId).filter((role) => !present.has(role));
}

/**
 * Runtime twin of the type-level totality check.
 *
 * The `Record` type already fails a build that adds an archetype without
 * defining it. This catches the other direction — a definition for an archetype
 * the vocabulary no longer has, a `requiredRoles` entry that is not a package
 * role, a definition filed under the wrong key — and covers the callers that
 * arrive with a string, which for a content-authored plan is all of them.
 */
export function archetypeGaps(): string[] {
  const problems: string[] = [];
  const known = new Set<string>(ARCHETYPE_IDS);
  const roles = new Set<string>(PACKAGE_ROLES);

  for (const key of Object.keys(ARCHETYPE_REGISTRY)) {
    if (!known.has(key)) problems.push(`archetype "${key}" is defined but not in the list.`);
  }
  for (const archetypeId of ARCHETYPE_IDS) {
    const definition = ARCHETYPE_REGISTRY[archetypeId];
    if (definition.id !== archetypeId) {
      problems.push(`archetype "${archetypeId}" is filed under the wrong key.`);
    }
    if (definition.requiredRoles.length === 0) {
      problems.push(
        `archetype "${archetypeId}" requires no package role, so it constrains nothing.`,
      );
    }
    for (const role of definition.requiredRoles) {
      if (!roles.has(role)) {
        problems.push(
          `archetype "${archetypeId}" requires "${role}", which is not a package role.`,
        );
      }
    }
  }
  return problems;
}

export function assertArchetypeRegistryComplete(): void {
  const problems = archetypeGaps();
  if (problems.length > 0) {
    throw new Error(`Archetype registry is out of date:\n- ${problems.join('\n- ')}`);
  }
}
