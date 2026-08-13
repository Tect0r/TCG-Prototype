import {
  AGENT_CLASSES,
  AGENT_CLASSES_WITHOUT_PILOTS,
  AGENT_CLASS_REGISTRY,
  AGENT_CLASS_REGISTRY_VERSION,
  EVIDENCE_CLAIMS,
  agentClassOf,
  claimCarriedBy,
  classesBlocking,
  type AgentClass,
  type EvidenceClaim,
} from '@tcg/bot-interface';

/**
 * What class of agent flew this run, and therefore what it may be cited for
 * (M05.4).
 *
 * The mechanic support analysis next door answers "were these cards something a
 * pilot could play". This answers the other half: "was whoever played them the
 * kind of agent whose results mean the thing this report is about to say". They
 * are independent — a run of fully supported cards flown by `random_legal` is
 * still not evidence about play — and they are kept in separate blocks for that
 * reason rather than folded into one "quality" number.
 *
 * Like the support analysis this is a projection, not an opinion: every level
 * here is read off `@tcg/bot-interface`'s agent class registry and the pilot IDs
 * the run was configured with.
 */

/** Schema of the `agentClasses` block in the manifest and the summary. */
export const AGENT_CLASS_ANALYSIS_VERSION = 1;

export interface PilotClassification {
  readonly pilotId: string;
  /** `null` for an ID this build does not know — a record from another version. */
  readonly agentClass: AgentClass | null;
}

export interface DeclinedClaim {
  readonly claim: EvidenceClaim;
  /** The classes in this run that cannot carry it. Empty when the cause is below. */
  readonly blockedBy: readonly AgentClass[];
  /** Set when the cause is a pilot this build cannot classify, or no pilot at all. */
  readonly unclassifiedPilots: boolean;
}

export interface AgentClassAnalysis {
  readonly schemaVersion: number;
  readonly registryVersion: number;
  /** Every configured pilot with the class it belongs to, sorted by ID. */
  readonly pilots: readonly PilotClassification[];
  /** The distinct classes that flew, in the registry's published order. */
  readonly classes: readonly AgentClass[];
  readonly unclassifiedPilotIds: readonly string[];
  /**
   * More than one class flew, so the run's pooled columns mix instruments.
   * Reported, and never smoothed: the outcome section prints a row per class.
   */
  readonly mixed: boolean;
  readonly carried: readonly EvidenceClaim[];
  readonly declined: readonly DeclinedClaim[];
  /**
   * Classes no pilot in this *build* implements, whatever this run configured.
   * The reason a whole family of claims is unavailable rather than merely unmade.
   */
  readonly classesWithoutPilots: readonly AgentClass[];
}

/** What the flag layer needs, projected out of a full analysis. */
export interface AgentEvidence {
  readonly classes: readonly AgentClass[];
  readonly unclassifiedPilotIds: readonly string[];
}

export function agentEvidenceOf(analysis: AgentClassAnalysis): AgentEvidence {
  return { classes: analysis.classes, unclassifiedPilotIds: analysis.unclassifiedPilotIds };
}

export function analyzeAgentClasses(inputs: {
  readonly pilotIds: readonly string[];
}): AgentClassAnalysis {
  const pilotIds = [...new Set(inputs.pilotIds)].sort();
  const pilots = pilotIds.map((pilotId) => ({ pilotId, agentClass: agentClassOf(pilotId) }));

  const unclassifiedPilotIds = pilots
    .filter((pilot) => pilot.agentClass === null)
    .map((pilot) => pilot.pilotId);

  const flown = new Set(
    pilots
      .map((pilot) => pilot.agentClass)
      .filter((agentClass): agentClass is AgentClass => agentClass !== null),
  );
  const classes = AGENT_CLASSES.filter((agentClass) => flown.has(agentClass));

  // An unclassified pilot cannot be vouched for at all, so the run carries
  // nothing while one is present. That is deliberately harsher than treating it
  // as random-legal: this build does not know what it did.
  const usable = unclassifiedPilotIds.length === 0 ? classes : [];

  const carried = EVIDENCE_CLAIMS.filter((claim) => claimCarriedBy(usable, claim));
  const declined = EVIDENCE_CLAIMS.filter((claim) => !carried.includes(claim)).map((claim) => ({
    claim,
    blockedBy: classesBlocking(classes, claim),
    unclassifiedPilots: unclassifiedPilotIds.length > 0 || classes.length === 0,
  }));

  return {
    schemaVersion: AGENT_CLASS_ANALYSIS_VERSION,
    registryVersion: AGENT_CLASS_REGISTRY_VERSION,
    pilots,
    classes,
    unclassifiedPilotIds,
    mixed: classes.length > 1,
    carried,
    declined,
    classesWithoutPilots: AGENT_CLASSES_WITHOUT_PILOTS,
  };
}

/** The registry's own sentence for a class, for the report. */
export function describeAgentClass(agentClass: AgentClass): string {
  return AGENT_CLASS_REGISTRY[agentClass].summary;
}

export function agentClassLabel(agentClass: AgentClass): string {
  return AGENT_CLASS_REGISTRY[agentClass].label;
}
