import { z } from 'zod';
import type { DifficultySelection } from '@tcg/bot-config';
import {
  AGENT_CLASSES,
  agentClassSupports,
  type AgentClass,
  type EvidenceClaim,
} from './agent-class.js';
import { createAggressivePilot, AGGRESSIVE_VERSION, AGGRESSIVE_WEIGHTS } from './aggressive.js';
import { createDefensivePilot, DEFENSIVE_VERSION, DEFENSIVE_WEIGHTS } from './defensive.js';
import { createHeuristicPilot } from './heuristic.js';
import { createValuePilot, VALUE_VERSION, VALUE_WEIGHTS } from './value.js';
import {
  createRandomLegalPilot,
  randomLegalConfigSchema,
  RANDOM_LEGAL_VERSION,
} from './random-legal.js';
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

/* --------------------------------------------------- style plus difficulty (M09.13) */

/**
 * The published version of each pilot's decision function.
 *
 * A table rather than four imports at the call site, and total over `PilotId`,
 * so a pilot cannot gain a version here and keep another one in its own file —
 * `registry.test.ts` checks each entry against the pilot it names.
 */
export const PILOT_VERSIONS: Readonly<Record<PilotId, string>> = Object.freeze({
  random_legal: RANDOM_LEGAL_VERSION,
  aggressive: AGGRESSIVE_VERSION,
  defensive: DEFENSIVE_VERSION,
  value: VALUE_VERSION,
});

/**
 * The pilots a difficulty can be applied to: the ones that are trying.
 *
 * Same derivation as `CALIBRATED_PILOT_IDS`, and for the same reason — a
 * *bounded degradation* of a pilot that is not trying is not a weaker player, it
 * is noise with a bound printed on it. `random_legal` is therefore not something
 * an Easy bot can be built from, which also keeps it out of reach of the lobby,
 * where it would read as "an even easier Easy" (see `style.ts`).
 */
export const STYLED_PILOT_IDS: readonly PilotId[] = PILOT_IDS.filter((id) =>
  agentClassSupports(PILOT_AGENT_CLASSES[id], 'play_quality' satisfies EvidenceClaim),
);

export interface StyledPilotOptions {
  /** The style's weight vector, by name. */
  readonly pilotId: PilotId;
  /** The difficulty's selection, from `@tcg/bot-config`'s registry. */
  readonly selection: DifficultySelection;
  readonly weights?: Partial<BotWeights>;
}

/**
 * One pilot from the two axes a live bot seat actually has.
 *
 * Deliberately a **second** entry point rather than a widened `PilotSpec`. An
 * experiment manifest names pilots, and a manifest that could also name a
 * difficulty would let a deliberately suboptimal run be filed under
 * `generic_heuristic` and cited for play quality — the pooled-skill mistake
 * M05.4 exists to refuse. Experiments and the calibration suite go through
 * `createPilot` and therefore always play the published heuristic; the live
 * lobby, which is where a person picks a difficulty, comes through here.
 *
 * The returned pilot keeps the **style's** `id` and `version`, because that is
 * what identifies the scorer, and carries the selection in `config`. Which
 * difficulty was flown, and which version of it, is recorded by the caller that
 * knows the difficulty's name.
 */
export function createStyledPilot(options: StyledPilotOptions): BotPolicy {
  const pilotId = pilotIdSchema.parse(options.pilotId);
  if (!STYLED_PILOT_IDS.includes(pilotId)) {
    throw new Error(
      `Pilot "${pilotId}" is not something a difficulty can be applied to: it makes no attempt to play well.`,
    );
  }
  const weights = botWeightsSchema.parse({
    ...PILOT_BASE_WEIGHTS[pilotId],
    ...(options.weights ?? {}),
  });
  return createHeuristicPilot({
    id: pilotId,
    version: PILOT_VERSIONS[pilotId],
    weights,
    selection: options.selection,
  });
}
