import {
  PRESET_REGISTRY,
  adminError,
  adminSchemaErrors,
  adaptiveExpansionSchema,
  adaptiveWorkloadEstimateSchema,
  presetChoiceSchema,
  type AdaptiveExpansion,
  type AdaptiveWorkloadEstimate,
  type PresetChoiceInput,
} from '@tcg/admin-contracts';
import {
  ADAPTIVE_CONFIG_SCHEMA_VERSION,
  parseAdaptiveConfig,
  planAdaptiveBudget,
  resolveDeckSource,
  type AdaptiveConfig,
  type DeckSource,
  type Environment,
} from '@tcg/simulator';
import { z } from 'zod';

import {
  PresetRefused,
  presetEnvironment,
  presetEnvironmentConfig,
  scrubRefusal,
} from './expand.js';

/**
 * Validating and estimating an `adaptive_counter` choice, on its own door.
 *
 * `expandPreset` (`./expand.ts`) refuses `adaptive_counter` outright, exactly
 * as `PRESET_REGISTRY.adaptive_counter.limitations` already promises: it is
 * the single door onto `experimentConfigSchema`, and an adaptive run is not
 * one — `AdaptiveConfig` is deliberately its own schema
 * (`apps/simulator/src/adaptive/config.ts`'s own header). So this module is
 * a second, narrower door for the one preset that needs it: it validates a
 * choice into a real `AdaptiveConfig` via `parseAdaptiveConfig` — the same
 * "restated bounds, revalidated for real" pattern `preconBenchmarkSettingsSchema`
 * already documents — and prices it with `planAdaptiveBudget`, the simulator's
 * own budget arithmetic, never a formula written a second time here.
 *
 * Through M08.19 it scheduled nothing on purpose — M08.19A's own acceptance
 * was "restore every value and show workload before enqueueing", and wiring
 * a queued, executable adaptive run was deferred. M08.R3 is that later slice:
 * `estimateAdaptiveChoice`'s returned `config` is what `#enqueueAdaptive`
 * (`apps/admin-server/src/service/handlers.ts`) hands to
 * `CatalogStore.createAdaptiveJob`, unchanged from what this function already
 * validated and priced. This module still does not run anything itself —
 * `ExperimentRunner`'s execution loop is untouched — it only now hands its
 * answer to a caller that can queue it.
 */

function refuse(path: string, message: string): never {
  throw new PresetRefused([adminError('admin/schema', message, { path })]);
}

function requireDistinct(path: string, values: readonly string[], noun: string): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value))
      refuse(path, `${noun} "${value}" is listed twice, and a selection is a set.`);
    seen.add(value);
  }
}

/** Checks a Commander selection against the ones the environment actually has, mirroring `expand.ts`'s `requireCommanders`. */
function requireCommanders(environment: Environment, commanderIds: readonly string[]): void {
  const known = new Set(environment.commanders.map((card) => card.id));
  for (const [index, id] of commanderIds.entries()) {
    if (known.has(id)) continue;
    refuse(
      `selectedCommanderIds.${String(index)}`,
      `"${id}" is not a Commander in this format. Available: ${[...known].sort().join(', ')}.`,
    );
  }
}

export interface AdaptiveChoiceEstimate {
  readonly expansion: AdaptiveExpansion;
  readonly estimate: AdaptiveWorkloadEstimate;
  /**
   * The validated configuration this choice resolved to (M08.R3).
   *
   * `#estimateChoice` and `#saveChoice` need only `expansion`/`estimate`, but
   * `#enqueueAdaptive` needs the configuration itself to create a job from —
   * this is the same object `planAdaptiveBudget` already priced, not a second
   * validation of the choice.
   */
  readonly config: AdaptiveConfig;
}

/**
 * What an `adaptive_counter` choice validates to and would spend, answered
 * without scheduling it — the adaptive counterpart to `estimatePreset`.
 */
export function estimateAdaptiveChoice(input: PresetChoiceInput | unknown): AdaptiveChoiceEstimate {
  const parsed = presetChoiceSchema.safeParse(input);
  if (!parsed.success) throw new PresetRefused(adminSchemaErrors(parsed.error));
  const choice = parsed.data;
  if (choice.presetId !== 'adaptive_counter') {
    refuse('presetId', 'Not an Adaptive Counter Search choice.');
  }

  const definition = PRESET_REGISTRY.adaptive_counter;
  const environmentConfig = presetEnvironmentConfig();
  const environment = presetEnvironment();

  requireDistinct('startingPreconIds', choice.startingPreconIds, 'Precon');
  requireDistinct('selectedCommanderIds', choice.selectedCommanderIds, 'Commander');
  if (choice.selectedCommanderIds.length > 0) {
    requireCommanders(environment, choice.selectedCommanderIds);
  }

  const startingDecks: DeckSource = { kind: 'precon', preconIds: [...choice.startingPreconIds] };
  // Resolved for real, against the environment, the same precedent every
  // other preset's precon list follows (`estimate.ts`'s own header): a bad
  // precon ID is a refusal here, not a surprise a run in.
  try {
    resolveDeckSource(startingDecks, environment, choice.seed);
  } catch (cause) {
    refuse(
      'startingPreconIds',
      scrubRefusal(cause instanceof Error ? cause.message : String(cause)),
    );
  }

  let config;
  try {
    config = parseAdaptiveConfig({
      schemaVersion: ADAPTIVE_CONFIG_SCHEMA_VERSION,
      id: choice.experimentId,
      seed: choice.seed,
      environment: environmentConfig,
      startingDecks,
      commanderPolicy: choice.commanderPolicy,
      selectedCommanderIds: [...choice.selectedCommanderIds],
      informationPolicy: choice.informationPolicy,
      totalLearningBudget: choice.totalLearningBudget,
      blockSize: choice.blockSize,
      mirrorSeats: choice.mirrorSeats,
      candidateCount: choice.candidateCount,
      swapBound: choice.swapBound,
      rebuildTrigger: choice.rebuildTrigger,
      referenceFieldShare: choice.referenceFieldShare,
      finalValidationGames: choice.finalValidationGames,
    });
  } catch (cause) {
    if (cause instanceof z.ZodError) {
      throw new PresetRefused(
        adminSchemaErrors(cause).map((entry) => ({
          ...entry,
          message: scrubRefusal(entry.message),
        })),
      );
    }
    throw cause;
  }

  const budget = planAdaptiveBudget(config);
  const limitations = [...definition.limitations];

  return {
    expansion: adaptiveExpansionSchema.parse({
      presetId: 'adaptive_counter',
      testStyle: definition.testStyle,
      sourceClasses: [...definition.sourceClasses],
      limitations,
    }),
    estimate: adaptiveWorkloadEstimateSchema.parse({
      gamesPerBlock: budget.gamesPerBlock,
      blocksScheduled: budget.blocksScheduled,
      gamesScheduled: budget.gamesScheduled,
      gamesUnspent: budget.shortfall?.gamesUnspent ?? 0,
      shortfallReason: budget.shortfall?.reason ?? '',
      finalValidationGames: config.finalValidationGames,
      limitations,
    }),
    config,
  };
}
