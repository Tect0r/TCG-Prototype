import { z } from 'zod';
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
 * Pilots that make no attempt to play well (M05.1).
 *
 * `random_legal` samples uniformly from whatever the engine offers. It is
 * genuine evidence for legality, termination, loops and crashes, and it is not
 * evidence for anything about balance — so a run flown entirely by pilots named
 * here has its review flags downgraded to `insufficient_data` rather than
 * printed as though somebody had tried to win.
 *
 * Deliberately a list of the pilots that *are* legality-only rather than a
 * taxonomy of the ones that are not: the four honest agent classes, and what
 * each one may be cited for, are M05.4's subject. This is the single distinction
 * M05.1 needs and nothing more.
 */
export const LEGAL_ONLY_PILOT_IDS: readonly PilotId[] = ['random_legal'];

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
