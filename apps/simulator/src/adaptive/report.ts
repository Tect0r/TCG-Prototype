import { z } from 'zod';
import { proportion, type ProportionEstimate } from '../analysis/stats.js';
import { proportionSchema } from '../analysis/aggregate.js';
import {
  adaptiveBlockDecisionSchema,
  adaptiveBlockSideSchema,
  type AdaptiveBlockDecision,
  type AdaptiveBlockSide,
} from './block.js';
import { adaptiveObjectiveSchema, adaptiveScreeningTallySchema } from './evaluate.js';
import { adaptiveInformationPolicySchema, type AdaptiveInformationPolicy } from './config.js';
import {
  adaptiveSeriesTallySchema,
  tallyAdaptiveSeries,
  type AdaptiveCandidateEvidence,
  type AdaptivePromotionDecision,
} from './promote.js';
import {
  adaptiveCardSwapSchema,
  adaptiveRevisionSchema,
  type AdaptiveRevision,
} from './revision.js';
import { diffSwaps } from './generate.js';
import {
  activeAdaptiveRevisionOf,
  type AdaptiveCheckpoint,
  type AdaptiveCheckpointLineage,
} from './checkpoint.js';
import type { AdaptiveFrozenDecks, AdaptiveValidationOutcome } from './validate.js';

/**
 * Canonical adaptive reports (M08.18D).
 *
 * Everything up through `./run.ts` schedules, plays and decides; nothing
 * durable remembers *how* a run got to its final checkpoint. This file
 * defines the record kinds a caller accumulates while a run plays — one
 * `AdaptiveSeriesRecord` per decided block, one `AdaptiveScreeningRound` per
 * decided generation — and composes them, together with the checkpoint's own
 * lineages and an optional frozen-validation outcome, into one canonical
 * `AdaptiveResultPayload`: series score, revision history, candidate
 * screenings, final deck diff, reference-field performance and frozen
 * validation, kept on their own fields exactly the way the files that produce
 * them keep the underlying evidence separate (`./promote.ts`'s "series wins
 * versus screening evidence" note applies here too).
 *
 * `detectAdaptiveCycles` is the one piece of this file that looks across the
 * whole series rather than summarizing one record kind. It only ever *names*
 * blocks whose two lineages returned to a deck-hash pair they have already
 * played — never "healthy", "stuck" or "converged" language. CLAUDE.md is
 * explicit that an automated signal like this is evidence for review, not a
 * balance verdict, and this function's return type (a flat, ordered list of
 * observations) is built to make it hard for a caller to render it as one.
 *
 * `renderAdaptiveReport` is a plain-string Markdown view of a built
 * `AdaptiveResultPayload` — nothing in it computes anything the payload does
 * not already carry, matching `../reporting/report.ts`'s own "JSON is
 * authoritative; Markdown is a view of it" split.
 *
 * `informationPolicy` (M08.19D) is carried through from `AdaptiveConfig` onto
 * the payload itself, and `informationPolicyLabel` is the one wording this
 * app uses to state it unmistakably — every reader of this evidence, Markdown
 * or dashboard, uses the same words rather than inventing its own.
 */

/** One decided block, durable enough to reconstruct series score and cycle detection without replaying matches. */
export const adaptiveSeriesRecordSchema = z.strictObject({
  generation: z.number().int().min(0),
  block: z.number().int().min(0),
  incumbentRevisionId: z.string().min(1),
  opponentRevisionId: z.string().min(1),
  incumbentDeckHash: z.string().min(1),
  opponentDeckHash: z.string().min(1),
  decision: adaptiveBlockDecisionSchema,
});
export type AdaptiveSeriesRecord = z.infer<typeof adaptiveSeriesRecordSchema>;

/** Builds one series record from a decided block's two active revisions and its decision. */
export function makeAdaptiveSeriesRecord(input: {
  readonly generation: number;
  readonly block: number;
  readonly incumbent: Pick<AdaptiveRevision, 'revisionId' | 'deck'>;
  readonly opponent: Pick<AdaptiveRevision, 'revisionId' | 'deck'>;
  readonly decision: AdaptiveBlockDecision;
}): AdaptiveSeriesRecord {
  return adaptiveSeriesRecordSchema.parse({
    generation: input.generation,
    block: input.block,
    incumbentRevisionId: input.incumbent.revisionId,
    opponentRevisionId: input.opponent.revisionId,
    incumbentDeckHash: input.incumbent.deck.hash,
    opponentDeckHash: input.opponent.deck.hash,
    decision: input.decision,
  });
}

/** One screened candidate's evidence and promotion score, flattened for persistence. */
export const adaptiveCandidateResultSchema = z.strictObject({
  revisionId: z.string().min(1),
  objective: adaptiveObjectiveSchema,
  opponentTally: adaptiveScreeningTallySchema,
  /** `null` — not a zero tally — whenever this candidate's screening scheduled no reference-field games. */
  fieldTally: adaptiveScreeningTallySchema.nullable(),
  score: proportionSchema,
});
export type AdaptiveCandidateResult = z.infer<typeof adaptiveCandidateResultSchema>;

export const adaptiveScreeningDecisionSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('promoted'), revisionId: z.string().min(1) }),
  z.strictObject({ kind: z.literal('retained'), reason: z.string().min(1) }),
]);
export type AdaptiveScreeningDecision = z.infer<typeof adaptiveScreeningDecisionSchema>;

/** One decided generation's whole screening: every candidate's evidence plus the promotion (or retention) it produced. */
export const adaptiveScreeningRoundSchema = z.strictObject({
  generation: z.number().int().min(1),
  block: z.number().int().min(0),
  loserSide: adaptiveBlockSideSchema,
  opponentRevisionId: z.string().min(1),
  candidates: z.array(adaptiveCandidateResultSchema).max(64),
  decision: adaptiveScreeningDecisionSchema,
});
export type AdaptiveScreeningRound = z.infer<typeof adaptiveScreeningRoundSchema>;

export interface BuildAdaptiveScreeningRoundInput {
  readonly generation: number;
  readonly block: number;
  readonly loserSide: AdaptiveBlockSide;
  readonly opponentRevisionId: string;
  readonly evidence: readonly AdaptiveCandidateEvidence[];
  readonly score: (evidence: AdaptiveCandidateEvidence) => ProportionEstimate;
  /** `./promote.ts`'s `decideAdaptivePromotion` never returns `stale` to a strictly sequential caller — see `./run.ts`'s own invariant check. */
  readonly decision: Exclude<AdaptivePromotionDecision, { kind: 'stale' }>;
}

/** Builds one screening round from a generation's finished candidate evidence and its promotion decision. */
export function buildAdaptiveScreeningRound(
  input: BuildAdaptiveScreeningRoundInput,
): AdaptiveScreeningRound {
  return adaptiveScreeningRoundSchema.parse({
    generation: input.generation,
    block: input.block,
    loserSide: input.loserSide,
    opponentRevisionId: input.opponentRevisionId,
    candidates: input.evidence.map((evidence) => ({
      revisionId: evidence.candidate.revisionId,
      objective: evidence.screening.objective,
      opponentTally: evidence.tallies.opponent,
      fieldTally: evidence.tallies.field,
      score: input.score(evidence),
    })),
    decision:
      input.decision.kind === 'promoted'
        ? { kind: 'promoted', revisionId: input.decision.revision.revisionId }
        : { kind: 'retained', reason: input.decision.reason },
  });
}

/** One block whose two active decks exactly repeat an earlier block's — named, not judged. */
export const adaptiveCycleObservationSchema = z.strictObject({
  block: z.number().int().min(0),
  generation: z.number().int().min(0),
  repeatsBlock: z.number().int().min(0),
  incumbentDeckHash: z.string().min(1),
  opponentDeckHash: z.string().min(1),
});
export type AdaptiveCycleObservation = z.infer<typeof adaptiveCycleObservationSchema>;

/**
 * Descriptive only (M08.18D, CLAUDE.md "automated ... signals are evidence
 * for review, never an automatic balance verdict"): names every block whose
 * active `(incumbentDeckHash, opponentDeckHash)` pair exactly repeats an
 * earlier block's, in series order. This is never read as a verdict that the
 * meta is healthy, unhealthy, converged or stuck — only that the two
 * lineages returned to a configuration they have already played once before.
 */
export function detectAdaptiveCycles(
  series: readonly AdaptiveSeriesRecord[],
): readonly AdaptiveCycleObservation[] {
  const firstSeenAtBlock = new Map<string, number>();
  const observations: AdaptiveCycleObservation[] = [];
  for (const entry of series) {
    const key = `${entry.incumbentDeckHash}|${entry.opponentDeckHash}`;
    const seenAt = firstSeenAtBlock.get(key);
    if (seenAt === undefined) {
      firstSeenAtBlock.set(key, entry.block);
      continue;
    }
    observations.push({
      block: entry.block,
      generation: entry.generation,
      repeatsBlock: seenAt,
      incumbentDeckHash: entry.incumbentDeckHash,
      opponentDeckHash: entry.opponentDeckHash,
    });
  }
  return observations;
}

/** How every screened candidate collectively fared against the reference field, pooled across the whole run. */
export const adaptiveReferenceFieldStandingSchema = z.strictObject({
  gamesPlayed: z.number().int().min(1),
  candidateWins: z.number().int().min(0),
  opponentWins: z.number().int().min(0),
  noResult: z.number().int().min(0),
  standing: proportionSchema,
});
export type AdaptiveReferenceFieldStanding = z.infer<typeof adaptiveReferenceFieldStandingSchema>;

/**
 * Pools every screening round's `fieldTally` into one Wilson-interval
 * standing. `null` when no round ever scheduled a reference-field game — a
 * `pure_counter` run, or a `meta_aware` run whose reference field was always
 * empty (`./evaluate.ts`) — since a per-deck breakdown isn't tracked anywhere
 * this file can read, and this function does not fabricate one.
 */
export function summarizeAdaptiveReferenceField(
  screeningRounds: readonly AdaptiveScreeningRound[],
): AdaptiveReferenceFieldStanding | null {
  let candidateWins = 0;
  let opponentWins = 0;
  let noResult = 0;
  for (const round of screeningRounds) {
    for (const candidate of round.candidates) {
      if (!candidate.fieldTally) continue;
      candidateWins += candidate.fieldTally.candidateWins;
      opponentWins += candidate.fieldTally.opponentWins;
      noResult += candidate.fieldTally.noResult;
    }
  }
  const gamesPlayed = candidateWins + opponentWins + noResult;
  if (gamesPlayed === 0) return null;
  return adaptiveReferenceFieldStandingSchema.parse({
    gamesPlayed,
    candidateWins,
    opponentWins,
    noResult,
    standing: proportion(candidateWins, candidateWins + opponentWins),
  });
}

/** One lineage's net cards changed between its root and its current active revision. */
export const adaptiveDeckDiffSchema = z.strictObject({
  rootRevisionId: z.string().min(1),
  finalRevisionId: z.string().min(1),
  swaps: z.array(adaptiveCardSwapSchema),
  commanderChanged: z.boolean(),
});
export type AdaptiveDeckDiff = z.infer<typeof adaptiveDeckDiffSchema>;

/**
 * Diffs a lineage's root revision against its current active revision, reusing
 * `./generate.ts`'s own `diffSwaps` (the same "net cards changed, equal-size
 * decks" computation a candidate's own `swaps` field is built from) rather than
 * defining a second way to compare two decks.
 */
export function finalAdaptiveDeckDiff(lineage: AdaptiveCheckpointLineage): AdaptiveDeckDiff {
  const root = lineage.revisions[0];
  if (!root) {
    throw new Error('a lineage must hold at least its root revision to diff against.');
  }
  const final = activeAdaptiveRevisionOf(lineage);
  return adaptiveDeckDiffSchema.parse({
    rootRevisionId: root.revisionId,
    finalRevisionId: final.revisionId,
    swaps: diffSwaps(root.deck, final.deck),
    commanderChanged: root.deck.commanderId !== final.deck.commanderId,
  });
}

export const adaptiveResultLineagesSchema = z.strictObject({
  incumbent: z.array(adaptiveRevisionSchema).min(1),
  opponent: z.array(adaptiveRevisionSchema).min(1),
});

/** The frozen fresh-seed validation stage's standing, folded into the result payload — never into `seriesTally`. */
export const adaptiveValidationSummarySchema = z.strictObject({
  incumbentRevisionId: z.string().min(1),
  opponentRevisionId: z.string().min(1),
  incumbentWins: z.number().int().min(0),
  opponentWins: z.number().int().min(0),
  noResult: z.number().int().min(0),
  standing: proportionSchema,
});
export type AdaptiveValidationSummary = z.infer<typeof adaptiveValidationSummarySchema>;

export const adaptiveResultPayloadSchema = z.strictObject({
  /**
   * The run's `AdaptiveConfig.informationPolicy` (M08.19D), carried through
   * unchanged so a reader of this evidence can tell `public_observation` play
   * apart from `analysis_full_deck` play without re-deriving it from
   * `configHash`. CLAUDE.md's "analysis-mode information never leaks into
   * normal matches" is a rule about what a bot sees mid-match; this field is
   * the corresponding rule for a human reading the result afterward — every
   * screen this run's evidence reaches must label which policy produced it,
   * unmistakably, rather than let `analysis_full_deck` evidence pass for a
   * fair blind-deck result.
   */
  informationPolicy: adaptiveInformationPolicySchema,
  /** Every revision either lineage ever held, root first, in generation order — the full revision history. */
  lineages: adaptiveResultLineagesSchema,
  seriesTally: adaptiveSeriesTallySchema,
  series: z.array(adaptiveSeriesRecordSchema),
  screeningRounds: z.array(adaptiveScreeningRoundSchema),
  referenceField: adaptiveReferenceFieldStandingSchema.nullable(),
  finalDeckDiff: z.strictObject({
    incumbent: adaptiveDeckDiffSchema,
    opponent: adaptiveDeckDiffSchema,
  }),
  cycles: z.array(adaptiveCycleObservationSchema),
  /** `null` when the frozen validation stage has not been run yet against this checkpoint. */
  validation: adaptiveValidationSummarySchema.nullable(),
});
export type AdaptiveResultPayload = z.infer<typeof adaptiveResultPayloadSchema>;

export interface BuildAdaptiveResultInput {
  /** `AdaptiveConfig.informationPolicy` for the run this checkpoint belongs to — carried through unchanged, never inferred from `configHash`. */
  readonly informationPolicy: AdaptiveInformationPolicy;
  readonly checkpoint: AdaptiveCheckpoint;
  /** Every block this run decided, in series order — accumulated by the caller as `./run.ts` decides each one. */
  readonly series: readonly AdaptiveSeriesRecord[];
  /** Every generation this run screened and decided, in series order. */
  readonly screeningRounds: readonly AdaptiveScreeningRound[];
  /** `null` when `./run.ts`'s `runAdaptiveFinalValidation` has not been called yet for this checkpoint. */
  readonly validation: {
    readonly decks: AdaptiveFrozenDecks;
    readonly outcome: AdaptiveValidationOutcome;
    readonly standing: ProportionEstimate;
  } | null;
}

/**
 * Composes the canonical result payload from a checkpoint's own lineages plus
 * the series and screening evidence a caller accumulated while driving
 * `./run.ts`. Reads nothing this file cannot already see: `seriesTally` is
 * `./promote.ts`'s own `tallyAdaptiveSeries` over `series`, `cycles` is this
 * file's own `detectAdaptiveCycles` over the same `series`, and the deck diffs
 * and reference-field standing are derived the same way their own builders
 * above derive them from the checkpoint and `screeningRounds`.
 */
export function buildAdaptiveResult(input: BuildAdaptiveResultInput): AdaptiveResultPayload {
  const { checkpoint, series, screeningRounds, validation, informationPolicy } = input;
  return adaptiveResultPayloadSchema.parse({
    informationPolicy,
    lineages: {
      incumbent: checkpoint.lineages.incumbent.revisions,
      opponent: checkpoint.lineages.opponent.revisions,
    },
    seriesTally: tallyAdaptiveSeries(series),
    series,
    screeningRounds,
    referenceField: summarizeAdaptiveReferenceField(screeningRounds),
    finalDeckDiff: {
      incumbent: finalAdaptiveDeckDiff(checkpoint.lineages.incumbent),
      opponent: finalAdaptiveDeckDiff(checkpoint.lineages.opponent),
    },
    cycles: detectAdaptiveCycles(series),
    validation:
      validation === null
        ? null
        : {
            incumbentRevisionId: validation.decks.incumbent.revisionId,
            opponentRevisionId: validation.decks.opponent.revisionId,
            incumbentWins: validation.outcome.incumbentWins,
            opponentWins: validation.outcome.opponentWins,
            noResult: validation.outcome.noResult,
            standing: validation.standing,
          },
  });
}

/* ---------------------------------------------------------------- rendering */

export type AdaptiveReportInput = AdaptiveResultPayload & {
  readonly experimentId: string;
  readonly configHash: string;
};

function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`;
}

function wilson(estimate: ProportionEstimate): string {
  return `${estimate.successes}/${estimate.total} (${pct(estimate.point)}, 95% low ${pct(estimate.low)})`;
}

function shortId(id: string): string {
  return id.length <= 16 ? id : `${id.slice(0, 16)}…`;
}

/**
 * The one-line, unmistakable label every render of this report leads with
 * (M08.19D): which information policy produced every game this evidence
 * summarizes, worded so `analysis_full_deck` cannot be mistaken for a fair
 * blind-deck result.
 */
export function informationPolicyLabel(policy: AdaptiveInformationPolicy): string {
  return policy === 'analysis_full_deck'
    ? '**Full-information analysis.** Every pilot in this run saw its opponent\'s exact decklist. ' +
        'This is not evidence of how these decks would play under a normal match\'s hidden information.'
    : '**Public observation.** Every pilot in this run saw only what a normal match\'s observation ' +
        'boundary allows.';
}

function section(lines: string[], block: readonly string[]): void {
  if (block.length === 0) return;
  lines.push(...block);
  lines.push('');
}

function seriesSection(result: AdaptiveReportInput): string[] {
  const tally = result.seriesTally;
  const lines = [
    '## Series score',
    '',
    'Cumulative decisive-block wins, series order. *Observation.*',
    '',
  ];
  lines.push(
    `- incumbent side: ${String(tally.incumbentWins)}`,
    `- opponent side: ${String(tally.opponentWins)}`,
    `- ties: ${String(tally.ties)}`,
    `- no-decision blocks: ${String(tally.noDecisions)}`,
  );
  return lines;
}

function revisionHistorySection(result: AdaptiveReportInput): string[] {
  const lines = ['## Revision history', ''];
  for (const side of ['incumbent', 'opponent'] as const) {
    lines.push(
      `### ${side}`,
      '',
      '| generation | block | construction | swaps | revision |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const revision of result.lineages[side]) {
      lines.push(
        `| ${String(revision.generation)} | ${String(revision.block)} | ${revision.construction} | ` +
          `${String(revision.swaps.length)} | ${shortId(revision.revisionId)} |`,
      );
    }
    lines.push('');
  }
  return lines;
}

function screeningSection(result: AdaptiveReportInput): string[] {
  const lines = ['## Candidate screenings', ''];
  if (result.screeningRounds.length === 0) {
    lines.push('No generation was screened in this run.', '');
    return lines;
  }
  for (const round of result.screeningRounds) {
    lines.push(
      `### Generation ${String(round.generation)}, block ${String(round.block)} (${round.loserSide} lineage adapting)`,
      '',
      round.decision.kind === 'promoted'
        ? `Decision: promoted ${shortId(round.decision.revisionId)}.`
        : `Decision: retained the incumbent — ${round.decision.reason}`,
      '',
      '| candidate | objective | vs. opponent | vs. field | score (95% low) |',
      '| --- | --- | --- | --- | --- |',
    );
    for (const candidate of round.candidates) {
      const opponent = `${candidate.opponentTally.candidateWins}-${candidate.opponentTally.opponentWins}-${candidate.opponentTally.noResult}`;
      const field = candidate.fieldTally
        ? `${candidate.fieldTally.candidateWins}-${candidate.fieldTally.opponentWins}-${candidate.fieldTally.noResult}`
        : '—';
      lines.push(
        `| ${shortId(candidate.revisionId)} | ${candidate.objective} | ${opponent} | ${field} | ${wilson(candidate.score)} |`,
      );
    }
    lines.push('');
  }
  return lines;
}

function deckDiffSection(result: AdaptiveReportInput): string[] {
  const lines = [
    '## Final deck diff',
    '',
    'Root revision versus the currently active revision. *Observation.*',
    '',
  ];
  for (const side of ['incumbent', 'opponent'] as const) {
    const diff = result.finalDeckDiff[side];
    lines.push(`### ${side}`, '');
    if (diff.swaps.length === 0 && !diff.commanderChanged) {
      lines.push('No net change from the root revision.', '');
      continue;
    }
    if (diff.commanderChanged) lines.push('Commander changed from the root revision.', '');
    for (const swap of diff.swaps) lines.push(`- ${swap.cardOut} → ${swap.cardIn}`);
    lines.push('');
  }
  return lines;
}

function referenceFieldSection(result: AdaptiveReportInput): string[] {
  const lines = ['## Reference-field performance', ''];
  if (!result.referenceField) {
    lines.push('No reference-field games were played in this run.', '');
    return lines;
  }
  const field = result.referenceField;
  lines.push(
    `Every screened candidate, pooled: ${wilson(field.standing)} over ${String(field.gamesPlayed)} game(s) ` +
      `(${String(field.noResult)} without a counted result). *Observation.*`,
    '',
  );
  return lines;
}

function validationSection(result: AdaptiveReportInput): string[] {
  const lines = [
    '## Frozen validation',
    '',
    'Fresh-seed, mirrored games between the two final decks — kept separate from the series score above.',
    '',
  ];
  if (!result.validation) {
    lines.push('The frozen validation stage has not been run for this checkpoint.', '');
    return lines;
  }
  const validation = result.validation;
  lines.push(
    `incumbent ${shortId(validation.incumbentRevisionId)} vs. opponent ${shortId(validation.opponentRevisionId)}: ` +
      `${String(validation.incumbentWins)}-${String(validation.opponentWins)} ` +
      `(${String(validation.noResult)} without a counted result). Standing: ${wilson(validation.standing)}. ` +
      '*Controlled comparison.*',
    '',
  );
  return lines;
}

function cyclesSection(result: AdaptiveReportInput): string[] {
  const lines = [
    '## Repeated states',
    '',
    "Blocks whose two active decks exactly repeat an earlier block's, named in series order. This is a " +
      'descriptive observation only — it is never a verdict that the meta is healthy, stuck or converged.',
    '',
  ];
  if (result.cycles.length === 0) {
    lines.push("No block repeated an earlier block's deck pair.", '');
    return lines;
  }
  lines.push('| block | repeats block | generation |', '| --- | --- | --- |');
  for (const cycle of result.cycles) {
    lines.push(
      `| ${String(cycle.block)} | ${String(cycle.repeatsBlock)} | ${String(cycle.generation)} |`,
    );
  }
  lines.push('');
  return lines;
}

/**
 * Renders a built `AdaptiveResultPayload` (plus the identity fields the
 * envelope wraps it in) as Markdown. The JSON payload is authoritative; this
 * is a view of it, not a second source of truth — every number here is read
 * directly off `result`, never recomputed.
 */
export function renderAdaptiveReport(result: AdaptiveReportInput): string {
  const lines: string[] = [
    `# Adaptive Counter report — ${result.experimentId}`,
    '',
    `configHash: \`${result.configHash}\``,
    '',
    informationPolicyLabel(result.informationPolicy),
    '',
  ];
  section(lines, seriesSection(result));
  section(lines, revisionHistorySection(result));
  section(lines, screeningSection(result));
  section(lines, deckDiffSection(result));
  section(lines, referenceFieldSection(result));
  section(lines, validationSection(result));
  section(lines, cyclesSection(result));
  return lines.join('\n').replace(/\n+$/, '\n');
}
