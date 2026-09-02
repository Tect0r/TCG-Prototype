import { join } from 'node:path';

import {
  ADAPTIVE_RESULT_TABLE_NAMES,
  adaptiveResultTableSchema,
  adaptiveRunSummarySchema,
  adminError,
  refuseForeignVersion,
  type AdaptiveResultTable,
  type AdaptiveResultTableName,
  type AdaptiveRunSummary,
  type AdminError,
  type PageRequest,
} from '@tcg/admin-contracts';
import { err, isErr, ok, type Result } from '@tcg/shared';
import {
  ADAPTIVE_CHECKPOINT_SCHEMA_VERSION,
  ADAPTIVE_RESULT_SCHEMA_VERSION,
  adaptiveCheckpointSchema,
  adaptiveResultSchema,
  type AdaptiveResult,
} from '@tcg/simulator';

import { readDocumentText } from '../catalog/files.js';
import { column, decodeRowCursor, encodeRowCursor, interval, spreadRate, type Proportion } from './results.js';
import type { ResultColumn, ResultRow } from '@tcg/admin-contracts';

/**
 * Reading an Adaptive Counter run, directory-keyed rather than job-keyed
 * (M08.19B).
 *
 * `./results.ts` is the pattern this restates for a run that has no `JobId`
 * to be read by yet: nothing here is cached, nothing is written back
 * anywhere, and every number a summary or table carries is read back out of
 * the run's own `adaptive-result.json` at the moment it is asked for (ADR
 * 0023 §3). The two documents this reads — `adaptive-checkpoint.json` and
 * `adaptive-result.json` — are read loosely (`adaptiveCheckpointSchema`/
 * `adaptiveResultSchema` already strip unknown fields the way every other
 * canonical document in this app does) and every outgoing answer is
 * re-validated by `@tcg/admin-contracts`'s own strict schema before it
 * leaves, exactly as `./results.ts` does for a batch, search or comparison
 * run.
 *
 * ## Checkpoint is state, not evidence
 *
 * `checkpoint.ts`'s own doc comment draws this line: a checkpoint is
 * "deliberately state, not evidence." A completed run's summary and tables
 * are therefore built **only** from `adaptive-result.json` — never from the
 * checkpoint, even when both are readable — so a number this service reports
 * as evidence never depends on whatever the checkpoint happened to hold at
 * read time. The checkpoint is opened for exactly one purpose: when there is
 * no readable result yet, its `gamesSpent`, `pendingGeneration` and lineage
 * lengths give a caller *why* there is nothing to read yet, as context on the
 * `admin/no_result` refusal rather than as a substitute result.
 */

const RESULT_DOCUMENT = 'adaptive-result.json' as const;
const CHECKPOINT_DOCUMENT = 'adaptive-checkpoint.json' as const;

/**
 * What this run's evidence may never be cited past.
 *
 * Fixed rather than sourced from a registry, because there is no `JobOrigin`
 * for a directory-keyed run yet — see `adaptive-results.ts`'s own note on why
 * `adaptiveRunSummarySchema.limitations` exists at all.
 */
const ADAPTIVE_RUN_LIMITATIONS: readonly string[] = [
  'This reading was not obtained through a queued job: it carries no calibration standing and no ' +
    'evidence-claim, because a directory-keyed run has neither yet.',
  'The series score reflects mirrored-block decisions only. A block with no decisive game is ' +
    'recorded as a no-decision and does not move it either way.',
  'Reference-field and frozen-validation standings are shown only when this run actually produced ' +
    'them. Their absence from these tables is not evidence of an even split.',
];

/* -------------------------------------------------------------- the reader */

interface OpenAdaptiveRun {
  readonly directory: string;
  readonly result: AdaptiveResult;
}

/** Reads a directory's headline Adaptive Counter reading, or the one refusal that covers every way there is not one. */
export async function readAdaptiveSummary(
  directory: string,
): Promise<Result<AdaptiveRunSummary, readonly AdminError[]>> {
  const open = await openAdaptiveRun(directory);
  if (isErr(open)) return open;
  const { result } = open.value;
  const tally = result.seriesTally;

  const value = {
    experimentId: result.experimentId,
    configHash: result.configHash,
    source: { document: RESULT_DOCUMENT, schemaVersion: result.schemaVersion },
    readings: [
      reading('seriesIncumbentWins', 'Series — incumbent side', tally.incumbentWins, 'count'),
      reading('seriesOpponentWins', 'Series — opponent side', tally.opponentWins, 'count'),
      reading('seriesTies', 'Series — ties', tally.ties, 'count'),
      reading('seriesNoDecisions', 'Series — no-decision blocks', tally.noDecisions, 'count'),
      reading('blocksDecided', 'Blocks decided', result.series.length, 'count'),
      reading('generationsScreened', 'Generations screened', result.screeningRounds.length, 'count'),
      reading(
        'incumbentRevisions',
        'Incumbent lineage length',
        result.lineages.incumbent.length,
        'count',
      ),
      reading('opponentRevisions', 'Opponent lineage length', result.lineages.opponent.length, 'count'),
      reading('repeatedStates', 'Repeated deck-hash pairs', result.cycles.length, 'count'),
    ],
    tables: ADAPTIVE_RESULT_TABLE_NAMES.map((table) => ({
      table,
      rows: buildAdaptiveTable(table, result).rows.length,
    })),
    limitations: ADAPTIVE_RUN_LIMITATIONS,
  };

  const validated = adaptiveRunSummarySchema.safeParse(value);
  if (!validated.success) return err([builtBadly('summary')]);
  return ok(validated.data);
}

/** Reads one bounded page of one Adaptive Counter result table. */
export async function readAdaptiveTable(
  directory: string,
  table: AdaptiveResultTableName,
  page: PageRequest,
): Promise<Result<AdaptiveResultTable, readonly AdminError[]>> {
  const open = await openAdaptiveRun(directory);
  if (isErr(open)) return open;

  let offset = 0;
  if (page.cursor !== null) {
    const decoded = decodeRowCursor(page.cursor);
    if (isErr(decoded)) return decoded;
    offset = decoded.value;
  }

  const built = buildAdaptiveTable(table, open.value.result);
  const rows = built.rows.slice(offset, offset + page.limit);
  const consumed = offset + rows.length;
  const value = {
    experimentId: open.value.result.experimentId,
    table,
    source: { document: RESULT_DOCUMENT, schemaVersion: open.value.result.schemaVersion },
    columns: built.columns,
    rows,
    page: {
      returned: rows.length,
      limit: page.limit,
      nextCursor: consumed < built.rows.length ? encodeRowCursor(consumed) : null,
      total: built.rows.length,
    },
  };

  const validated = adaptiveResultTableSchema.safeParse(value);
  if (!validated.success) return err([builtBadly(table)]);
  return ok(validated.data);
}

/**
 * The run's parsed `adaptive-result.json`, or the one refusal that covers
 * every way there is not one yet: nothing written, unreadable bytes, a
 * schema version this build does not own, or bytes this build's schema
 * refuses. The checkpoint is consulted only to explain *why*, never to stand
 * in for the result itself.
 */
async function openAdaptiveRun(
  directory: string,
): Promise<Result<OpenAdaptiveRun, readonly AdminError[]>> {
  const text = await readDocumentText(join(directory, RESULT_DOCUMENT));
  if (text === null) {
    return err([
      noAdaptiveResult(
        await checkpointContext(directory),
        'This experiment has produced no canonical result yet, so there is nothing to read.',
      ),
    ]);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return err([
      noAdaptiveResult(
        await checkpointContext(directory),
        'This experiment’s result document is not readable JSON.',
      ),
    ]);
  }

  const refusal = refuseForeignVersion(
    'adaptive result',
    declaredSchemaVersion(parsed),
    ADAPTIVE_RESULT_SCHEMA_VERSION,
    'schemaVersion',
  );
  if (refusal !== null) return err([refusal]);

  const validated = adaptiveResultSchema.safeParse(parsed);
  if (!validated.success) {
    return err([
      noAdaptiveResult(
        await checkpointContext(directory),
        'This experiment’s result document does not carry the fields a result view needs.',
      ),
    ]);
  }

  return ok({ directory, result: validated.data });
}

/**
 * Best-effort context for an `admin/no_result` refusal, read from
 * `adaptive-checkpoint.json`. Returns `null` on anything short of a fully
 * valid, correctly versioned checkpoint — a refusal with no context is
 * always safe to return; a refusal with misleading context is not.
 */
async function checkpointContext(
  directory: string,
): Promise<Readonly<Record<string, unknown>> | null> {
  const text = await readDocumentText(join(directory, CHECKPOINT_DOCUMENT));
  if (text === null) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }

  const refusal = refuseForeignVersion(
    'adaptive checkpoint',
    declaredSchemaVersion(parsed),
    ADAPTIVE_CHECKPOINT_SCHEMA_VERSION,
    'schemaVersion',
  );
  if (refusal !== null) return null;

  const checkpoint = adaptiveCheckpointSchema.safeParse(parsed);
  if (!checkpoint.success) return null;

  return {
    gamesSpent: checkpoint.data.gamesSpent,
    pendingGeneration: checkpoint.data.pendingGeneration !== null,
    incumbentRevisions: checkpoint.data.lineages.incumbent.revisions.length,
    opponentRevisions: checkpoint.data.lineages.opponent.revisions.length,
  };
}

function declaredSchemaVersion(parsed: unknown): unknown {
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>).schemaVersion
    : undefined;
}

/* ------------------------------------------------------------ the row builder */

interface BuiltTable {
  readonly columns: readonly ResultColumn[];
  readonly rows: readonly ResultRow[];
}

const ADAPTIVE_SIDES = ['incumbent', 'opponent'] as const;

/**
 * A table's shape and its rows, built together — one function per table for
 * the same reason `./results.ts`'s `buildTable` is: a column that is
 * declared and a cell that is produced sit next to each other, and the
 * contract's own refinement — *every cell belongs to a declared column* —
 * catches the pair drifting apart.
 *
 * Every table reads only `AdaptiveResultPayload`'s own fields
 * (`apps/simulator/src/adaptive/report.ts`); nothing here recomputes a
 * series score, a promotion score or a cycle — those stay owned by the
 * simulator, exactly as CLAUDE.md requires.
 */
function buildAdaptiveTable(table: AdaptiveResultTableName, result: AdaptiveResult): BuiltTable {
  switch (table) {
    case 'series':
      return {
        columns: [
          column('generation', 'Generation', 'count'),
          column('block', 'Block', 'count'),
          column('incumbentRevisionId', 'Incumbent revision', 'identifier'),
          column('opponentRevisionId', 'Opponent revision', 'identifier'),
          column('incumbentDeckHash', 'Incumbent deck', 'identifier'),
          column('opponentDeckHash', 'Opponent deck', 'identifier'),
          column('decisionKind', 'Decision', 'identifier'),
          column('decisionLoser', 'Loser', 'identifier'),
          column('decisionReason', 'No-decision reason', 'text'),
        ],
        rows: result.series.map((record) => ({
          generation: record.generation,
          block: record.block,
          incumbentRevisionId: record.incumbentRevisionId,
          opponentRevisionId: record.opponentRevisionId,
          incumbentDeckHash: record.incumbentDeckHash,
          opponentDeckHash: record.opponentDeckHash,
          decisionKind: record.decision.kind,
          decisionLoser: record.decision.kind === 'win' ? record.decision.loser : null,
          decisionReason: record.decision.kind === 'no_decision' ? record.decision.reason : null,
        })),
      };

    case 'revisions':
      return {
        columns: [
          column('side', 'Lineage', 'identifier'),
          column('revisionId', 'Revision', 'identifier'),
          column('parentRevisionId', 'Parent revision', 'identifier'),
          column('generation', 'Generation', 'count'),
          column('block', 'Block', 'count'),
          column('opponentRevisionId', 'Opponent revision', 'identifier'),
          column('construction', 'Construction', 'identifier'),
          column('swapCount', 'Swaps', 'count'),
          column('deckHash', 'Deck', 'identifier'),
          column('commanderId', 'Commander', 'identifier'),
        ],
        rows: ADAPTIVE_SIDES.flatMap((side) =>
          result.lineages[side].map((revision) => ({
            side,
            revisionId: revision.revisionId,
            parentRevisionId: revision.parentRevisionId,
            generation: revision.generation,
            block: revision.block,
            opponentRevisionId: revision.opponentRevisionId,
            construction: revision.construction,
            swapCount: revision.swaps.length,
            deckHash: revision.deck.hash,
            commanderId: revision.deck.commanderId,
          })),
        ),
      };

    case 'screening_candidates':
      return {
        columns: [
          column('generation', 'Generation', 'count'),
          column('block', 'Block', 'count'),
          column('loserSide', 'Losing lineage', 'identifier'),
          column('opponentRevisionId', 'Opponent revision', 'identifier'),
          column('revisionId', 'Candidate revision', 'identifier'),
          column('objective', 'Objective', 'identifier'),
          column('opponentTallyCandidateWins', 'Vs. opponent — candidate wins', 'count'),
          column('opponentTallyOpponentWins', 'Vs. opponent — opponent wins', 'count'),
          column('opponentTallyNoResult', 'Vs. opponent — no result', 'count'),
          column('fieldTallyCandidateWins', 'Vs. field — candidate wins', 'count'),
          column('fieldTallyOpponentWins', 'Vs. field — opponent wins', 'count'),
          column('fieldTallyNoResult', 'Vs. field — no result', 'count'),
          interval('score', 'Promotion score'),
          column('scoreGames', 'Promotion score games', 'count'),
          column('decisionKind', 'Round decision', 'identifier'),
          column('decisionRevisionId', 'Promoted revision', 'identifier'),
          column('decisionReason', 'Retention reason', 'text'),
        ],
        rows: result.screeningRounds.flatMap((round) =>
          round.candidates.map((candidate) => ({
            generation: round.generation,
            block: round.block,
            loserSide: round.loserSide,
            opponentRevisionId: round.opponentRevisionId,
            revisionId: candidate.revisionId,
            objective: candidate.objective,
            opponentTallyCandidateWins: candidate.opponentTally.candidateWins,
            opponentTallyOpponentWins: candidate.opponentTally.opponentWins,
            opponentTallyNoResult: candidate.opponentTally.noResult,
            fieldTallyCandidateWins: candidate.fieldTally?.candidateWins ?? null,
            fieldTallyOpponentWins: candidate.fieldTally?.opponentWins ?? null,
            fieldTallyNoResult: candidate.fieldTally?.noResult ?? null,
            ...spreadRate('score', candidate.score as Proportion),
            decisionKind: round.decision.kind,
            decisionRevisionId: round.decision.kind === 'promoted' ? round.decision.revisionId : null,
            decisionReason: round.decision.kind === 'retained' ? round.decision.reason : null,
          })),
        ),
      };

    case 'deck_diff':
      return {
        columns: [
          column('side', 'Lineage', 'identifier'),
          column('rootRevisionId', 'Root revision', 'identifier'),
          column('finalRevisionId', 'Final revision', 'identifier'),
          column('swapCount', 'Net swaps', 'count'),
          column('commanderChanged', 'Commander changed', 'flag'),
          column('swaps', 'Swaps', 'text'),
        ],
        rows: ADAPTIVE_SIDES.map((side) => {
          const diff = result.finalDeckDiff[side];
          return {
            side,
            rootRevisionId: diff.rootRevisionId,
            finalRevisionId: diff.finalRevisionId,
            swapCount: diff.swaps.length,
            commanderChanged: diff.commanderChanged,
            swaps: diff.swaps.map((swap) => `${swap.cardOut}→${swap.cardIn}`).join(', ').slice(0, 200),
          };
        }),
      };

    case 'cycles':
      return {
        columns: [
          column('block', 'Block', 'count'),
          column('generation', 'Generation', 'count'),
          column('repeatsBlock', 'Repeats block', 'count'),
          column('incumbentDeckHash', 'Incumbent deck', 'identifier'),
          column('opponentDeckHash', 'Opponent deck', 'identifier'),
        ],
        rows: result.cycles.map((cycle) => ({
          block: cycle.block,
          generation: cycle.generation,
          repeatsBlock: cycle.repeatsBlock,
          incumbentDeckHash: cycle.incumbentDeckHash,
          opponentDeckHash: cycle.opponentDeckHash,
        })),
      };

    case 'reference_field':
      return {
        columns: [
          interval('standing', 'Reference-field standing'),
          column('standingGames', 'Reference-field games', 'count'),
          column('gamesPlayed', 'Games played', 'count'),
          column('candidateWins', 'Candidate wins', 'count'),
          column('opponentWins', 'Opponent wins', 'count'),
          column('noResult', 'No result', 'count'),
        ],
        rows:
          result.referenceField === null
            ? []
            : [
                {
                  ...spreadRate('standing', result.referenceField.standing as Proportion),
                  gamesPlayed: result.referenceField.gamesPlayed,
                  candidateWins: result.referenceField.candidateWins,
                  opponentWins: result.referenceField.opponentWins,
                  noResult: result.referenceField.noResult,
                },
              ],
      };

    case 'validation':
      return {
        columns: [
          column('incumbentRevisionId', 'Incumbent revision', 'identifier'),
          column('opponentRevisionId', 'Opponent revision', 'identifier'),
          interval('standing', 'Standing'),
          column('standingGames', 'Games', 'count'),
          column('incumbentWins', 'Incumbent wins', 'count'),
          column('opponentWins', 'Opponent wins', 'count'),
          column('noResult', 'No result', 'count'),
        ],
        rows:
          result.validation === null
            ? []
            : [
                {
                  incumbentRevisionId: result.validation.incumbentRevisionId,
                  opponentRevisionId: result.validation.opponentRevisionId,
                  ...spreadRate('standing', result.validation.standing as Proportion),
                  incumbentWins: result.validation.incumbentWins,
                  opponentWins: result.validation.opponentWins,
                  noResult: result.validation.noResult,
                },
              ],
      };
  }
}

function reading(
  key: string,
  label: string,
  value: number,
  kind: ResultColumn['kind'],
): { key: string; label: string; value: number; kind: ResultColumn['kind'] } {
  return { key, label, value, kind };
}

function noAdaptiveResult(
  context: Readonly<Record<string, unknown>> | null,
  message: string,
): AdminError {
  return adminError('admin/no_result', message, context === null ? undefined : { context });
}

/**
 * The refusal for an answer this service built and could not validate — a
 * defect in the build rather than a problem with the run, reported the same
 * way `./results.ts`'s own `builtBadly` is.
 */
function builtBadly(what: string): AdminError {
  return adminError(
    'admin/schema',
    'This service built an Adaptive Counter result view it could not validate against its own ' +
      'contract, so it was not sent. This is a defect in the build rather than a problem with the run.',
    { context: { view: what } },
  );
}
