import {
  AGENT_CLASSES,
  AGENT_CLASS_REGISTRY_VERSION,
  agentClassSupports,
  claimCarriedBy,
  type AgentClass,
  type EvidenceClaim,
} from '@tcg/bot-interface';
import type { AgentClassAnalysis } from './agent-classes.js';

/**
 * Whether this run's results are calibration or a balance conclusion (M05.6).
 *
 * The last of the four "is this evidence" readings, and the one that frames the
 * other three. `mechanicSupport` says whether the cards could be played,
 * `agentClasses` says whether the player was trying, `deckConstruction` says
 * whether anybody designed the decks — and this says what the whole document is
 * *for*. A batch of a hundred thousand matches flown by a perfectly tuned
 * heuristic is still calibration: it tells you where to look, and a person
 * decides what to change.
 *
 * The standing is **derived and not configurable**, which is the point. It is
 * `claimCarriedBy(classes, 'final_balance')` and nothing else, so the only way
 * to produce a run that is not calibration is to fly it with a class of agent
 * that carries a final balance conclusion — and this build has no such pilot.
 * An operator cannot promote a run by editing an experiment file, because the
 * label is not a field in one.
 */

/** Schema of the `calibration` block in the manifest and the summary. */
export const CALIBRATION_ANALYSIS_VERSION = 1;

/**
 * The two standings.
 *
 * Deliberately not a scale. There is no "nearly balance": either the run was
 * flown by something entitled to conclude, or it is an instrument reading.
 */
export const EVIDENCE_STANDINGS = ['calibration', 'balance'] as const;
export type EvidenceStanding = (typeof EVIDENCE_STANDINGS)[number];

/** The claim a balance conclusion rests on. Named, so the link is inspectable. */
export const BALANCE_CLAIM: EvidenceClaim = 'final_balance';

export interface CalibrationStanding {
  readonly schemaVersion: number;
  /** The agent class taxonomy the standing was decided against. */
  readonly registryVersion: number;
  readonly standing: EvidenceStanding;
  /**
   * Why the run stands where it does. Never empty for `calibration`: a label
   * without a reason is an adjective, and this one has to be actionable.
   */
  readonly reasons: readonly string[];
  readonly claim: EvidenceClaim;
  /** The classes that carry the claim at all, whether or not they flew here. */
  readonly claimCarriedBy: readonly AgentClass[];
  /** The classes that actually flew, in the registry's published order. */
  readonly classesFlown: readonly AgentClass[];
  /**
   * Which of the required classes were missing from this run.
   *
   * Separate from `reasons` because it is the machine-readable half: a later
   * build that ships a human-playtest pilot can ask this field whether a run
   * would have been promoted, without parsing an English sentence.
   */
  readonly classesMissing: readonly AgentClass[];
  /**
   * What would have to change for the results to stop being calibration.
   *
   * One sentence, printed in the report. It is a statement about the software
   * rather than about this run — the same sentence for every batch this build
   * can produce — which is exactly why it belongs in every batch.
   */
  readonly promotionRequires: string;
}

/** Every class whose claims include a final balance conclusion. */
export function classesCarryingBalance(): AgentClass[] {
  return AGENT_CLASSES.filter((agentClass) => agentClassSupports(agentClass, BALANCE_CLAIM));
}

export function analyzeCalibration(inputs: {
  readonly agentClasses: AgentClassAnalysis;
}): CalibrationStanding {
  const { classes, unclassifiedPilotIds } = inputs.agentClasses;
  const carriers = classesCarryingBalance();
  const missing = carriers.filter((agentClass) => !classes.includes(agentClass));

  // The same rule the flag downgrades use, applied to the one claim that is
  // about the document rather than about a row in it.
  const carried = unclassifiedPilotIds.length === 0 && claimCarriedBy(classes, BALANCE_CLAIM);

  const reasons: string[] = [];
  if (!carried) {
    if (unclassifiedPilotIds.length > 0) {
      reasons.push(
        `this build cannot classify the pilot(s) ${unclassifiedPilotIds.join(', ')}, so it can ` +
          'vouch for nothing they did.',
      );
    }
    if (classes.length === 0) {
      reasons.push('no recognised agent class flew this run.');
    }
    for (const agentClass of classes) {
      if (agentClassSupports(agentClass, BALANCE_CLAIM)) continue;
      reasons.push(`\`${agentClass}\` does not carry \`${BALANCE_CLAIM}\`.`);
    }
    reasons.push(
      'Simulated play is where a balance question comes from, not where it is answered: these ' +
        'results say which cards and matchups are worth a person’s attention.',
    );
  }

  return {
    schemaVersion: CALIBRATION_ANALYSIS_VERSION,
    registryVersion: AGENT_CLASS_REGISTRY_VERSION,
    standing: carried ? 'balance' : 'calibration',
    reasons,
    claim: BALANCE_CLAIM,
    claimCarriedBy: carriers,
    classesFlown: classes,
    classesMissing: missing,
    promotionRequires:
      `A run stops being calibration only when every class that flew it carries ` +
      `\`${BALANCE_CLAIM}\` — today that is ${carriers.join(', ') || 'no class at all'} — and no ` +
      'pilot in this build belongs to one. There is no configuration setting that changes this ' +
      'label.',
  };
}
