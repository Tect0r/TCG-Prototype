import { z } from 'zod';
import {
  AGENT_CLASSES,
  agentClassSupports,
  type AgentClass,
  type EvidenceClaim,
} from './agent-class.js';
import { createAggressivePilot, AGGRESSIVE_WEIGHTS } from './aggressive.js';
import { createDefensivePilot, DEFENSIVE_WEIGHTS } from './defensive.js';
import { createValuePilot, VALUE_WEIGHTS } from './value.js';
import { createRandomLegalPilot, randomLegalConfigSchema } from './random-legal.js';
import { botWeightsSchema, DEFAULT_WEIGHTS, type BotWeights } from './scoring.js';
import type { BotPolicy } from './types.js';

/**
 * Naming a pilot in an experiment configuration.
 *
 * Every built-in pilot is addressable by a stable string plus an optional weight
 * override, so an experiment file fully determines the pilots it ran and a
 * result can be reproduced from the manifest alone (CLAUDE.md §13.3).
 */

export const PILOT_IDS = ['random_legal', 'aggressive', 'defensive', 'value'] as const;
export const pilotIdSchema = z.enum(PILOT_IDS);
export type PilotId = z.infer<typeof pilotIdSchema>;

export const pilotSpecSchema = z.strictObject({
  id: pilotIdSchema,
  /** Heuristic weight overrides. Ignored by `random_legal`. */
  weights: botWeightsSchema.partial().default({}),
  /** Configuration for `random_legal`. Ignored by the heuristic pilots. */
  randomConfig: randomLegalConfigSchema.partial().default({}),
});
export type PilotSpec = z.infer<typeof pilotSpecSchema>;
export type PilotSpecInput = z.input<typeof pilotSpecSchema>;

/**
 * Which honest agent class each built-in pilot belongs to (M05.4).
 *
 * Total over `PILOT_IDS`, so a new pilot cannot be added without deciding what a
 * run it flies may be cited for — which is the whole point of the taxonomy. The
 * three heuristic pilots differ in their weight vectors and not in their class:
 * `aggressive` and `defensive` are the same instrument pointed at different
 * things, and calling one of them a better player than the other would be
 * exactly the pooled skill axis M05.4 exists to refuse.
 *
 * No built-in pilot is `archetype_aware` (M05.5's subject) or `human_playtest`,
 * and `AGENT_CLASSES_WITHOUT_PILOTS` says so out loud rather than leaving the
 * absence to be inferred from this table.
 */
export const PILOT_AGENT_CLASSES: Readonly<Record<PilotId, AgentClass>> = Object.freeze({
  random_legal: 'random_legal',
  aggressive: 'generic_heuristic',
  defensive: 'generic_heuristic',
  value: 'generic_heuristic',
});

/** `null` for an ID this build does not know — a record from another version. */
export function agentClassOf(pilotId: string): AgentClass | null {
  return Object.prototype.hasOwnProperty.call(PILOT_AGENT_CLASSES, pilotId)
    ? PILOT_AGENT_CLASSES[pilotId as PilotId]
    : null;
}

export function pilotsInAgentClass(agentClass: AgentClass): PilotId[] {
  return PILOT_IDS.filter((id) => PILOT_AGENT_CLASSES[id] === agentClass);
}

/**
 * Classes this software cannot currently produce evidence for.
 *
 * A report reads this to say "no pilot here is archetype-aware, so nothing in
 * this run is synergy evidence" as a fact about the build rather than as an
 * omission a reader has to notice.
 */
export const AGENT_CLASSES_WITHOUT_PILOTS: readonly AgentClass[] = AGENT_CLASSES.filter(
  (agentClass) => pilotsInAgentClass(agentClass).length === 0,
);

/**
 * Pilots that make no attempt to play well (M05.1).
 *
 * `random_legal` samples uniformly from whatever the engine offers. It is
 * genuine evidence for legality, termination, loops and crashes, and it is not
 * evidence for anything about balance — so a run flown entirely by pilots named
 * here has its review flags downgraded to `insufficient_data` rather than
 * printed as though somebody had tried to win.
 *
 * Since M05.4 this is a *view* of `PILOT_AGENT_CLASSES` — the pilots whose class
 * cannot carry a claim about play quality — rather than a second list beside it,
 * so the M05.1 downgrade and the M05.4 taxonomy cannot disagree about a pilot.
 */
export const LEGAL_ONLY_PILOT_IDS: readonly PilotId[] = PILOT_IDS.filter(
  (id) => !agentClassSupports(PILOT_AGENT_CLASSES[id], 'play_quality' satisfies EvidenceClaim),
);

/** The published weight vector for a heuristic pilot, before any override. */
export const PILOT_BASE_WEIGHTS: Readonly<Record<PilotId, BotWeights>> = Object.freeze({
  random_legal: DEFAULT_WEIGHTS,
  aggressive: AGGRESSIVE_WEIGHTS,
  defensive: DEFENSIVE_WEIGHTS,
  value: VALUE_WEIGHTS,
});

export function createPilot(input: PilotSpecInput): BotPolicy {
  const spec = pilotSpecSchema.parse(input);
  switch (spec.id) {
    case 'random_legal':
      return createRandomLegalPilot(spec.randomConfig);
    case 'aggressive':
      return createAggressivePilot(spec.weights);
    case 'defensive':
      return createDefensivePilot(spec.weights);
    case 'value':
      return createValuePilot(spec.weights);
    default: {
      const never: never = spec.id;
      throw new Error(`Unknown pilot "${String(never)}".`);
    }
  }
}
