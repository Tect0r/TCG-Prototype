import { createRandomLegalPilot } from './random-legal.js';
import { checkActionOffered } from './validate.js';
import type { RngState, RulesConfig } from '@tcg/rules-engine';
import type { BotDecision, BotFailure, BotObservation, BotPolicy } from './types.js';

/**
 * Runs one pilot decision with the isolation the simulator needs.
 *
 * A pilot that throws, that returns an action the engine would reject, or that
 * runs past its decision budget must not take the batch with it: the failure is
 * recorded and a deterministic random-legal decision is substituted, so the
 * match still ends in a classifiable state and the incident survives in the
 * result (CLAUDE.md §13.3, §13.5). It is never silently folded into the
 * ordinary decision statistics.
 */

const FALLBACK = createRandomLegalPilot();

export interface PilotRunOptions {
  readonly config: RulesConfig;
  /** Hard cap on decisions this seat may make in one match. */
  readonly decisionBudget: number;
}

export interface PilotRunResult {
  readonly decision: BotDecision;
  readonly failure: BotFailure | null;
  /** True when the substituted random-legal decision was used. */
  readonly usedFallback: boolean;
}

export async function decideSafely(
  policy: BotPolicy,
  observation: BotObservation,
  rng: RngState,
  options: PilotRunOptions,
): Promise<PilotRunResult> {
  const seat = observation.legal.playerId;

  const fallbackWith = (kind: BotFailure['kind'], message: string): PilotRunResult => {
    const decision = FALLBACK.decide(observation, rng);
    if (decision instanceof Promise) {
      throw new Error('The fallback pilot must be synchronous.');
    }
    return {
      decision,
      failure: {
        kind,
        botId: policy.id,
        playerId: seat,
        decisionIndex: observation.decisionIndex,
        message,
      },
      usedFallback: true,
    };
  };

  if (observation.decisionIndex >= options.decisionBudget) {
    return fallbackWith(
      'budget_exceeded',
      `pilot exceeded its ${options.decisionBudget}-decision budget`,
    );
  }

  let decision: BotDecision;
  try {
    decision = await policy.decide(observation, rng);
  } catch (error) {
    return fallbackWith('threw', error instanceof Error ? error.message : String(error));
  }

  if (!decision || typeof decision.action?.type !== 'string') {
    return fallbackWith('no_action', 'pilot returned no action');
  }

  const check = checkActionOffered(observation.legal, decision.action, options.config);
  if (!check.ok) {
    return fallbackWith('illegal_action', `${decision.action.type}: ${check.reason}`);
  }

  return { decision, failure: null, usedFallback: false };
}
