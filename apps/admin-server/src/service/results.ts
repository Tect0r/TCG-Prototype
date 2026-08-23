import {
  PRESET_REGISTRY,
  adminError,
  resultSummarySchema,
  resultTableSchema,
  type AdminError,
  type CatalogJobDocument,
  type JobId,
  type PageRequest,
  type ResultColumn,
  type ResultRow,
  type ResultSummary,
  type ResultTable,
  type ResultTableName,
} from '@tcg/admin-contracts';
import { err, isErr, ok, type Result } from '@tcg/shared';
import { ABNORMAL_TERMINATIONS, experimentPaths } from '@tcg/simulator';
import { z } from 'zod';

import { readDocumentText } from '../catalog/files.js';
import { resolveResultLocation, type ResolvedCatalogRoots } from '../catalog/roots.js';
import type { CatalogStore } from '../catalog/store.js';
import { readRunIdentity } from '../run/manifest.js';

/**
 * Reading a finished run, out of the run's own directory, every time it is
 * asked for.
 *
 * ADR 0023 §3 is the design and it is short: *a catalog entry records the
 * resolved experiment directory and the manifest, config and content hashes that
 * identify the run; every number a result view shows is read back out of those
 * files. It never becomes a second copy of a run's evidence, because a second
 * copy is a thing that can disagree with the first.* So nothing here is cached,
 * nothing is written back into the catalog, and the catalog is consulted for
 * exactly two things: which job this is, and where its run was written.
 *
 * ## Read loosely, publish exactly
 *
 * `summary.json` is `@tcg/simulator`'s document and it grows — version 7 added
 * the calibration standing, version 6 the deck construction reading — so the
 * schemas below **strip** unknown fields rather than refusing them, exactly as
 * `run/manifest.ts` does and for the reason it gives: *a catalog that refused to
 * index a run because the summary had learned a new field would be refusing
 * evidence for being newer than the index.*
 *
 * What is not loose is what leaves the process. Every answer is re-parsed by
 * `resultSummarySchema` or `resultTableSchema` before it is returned, so a
 * projection that produced a row with a cell in no declared column, a
 * denominator that does not add up, or a limitation carrying a path is a failure
 * here rather than a wrong number on a screen.
 *
 * ## What this refuses to serve
 *
 * A summary with **no calibration standing**. The milestone's result rules list
 * evidence-claim and calibration standing among the things that must be visible
 * *before a reader may treat a number as evidence*, and a response with nowhere
 * to put it is a response that invites a view to show numbers without it. A run
 * written before `SUMMARY_SCHEMA_VERSION` 7 is therefore named as unreadable
 * rather than served with the field omitted — the same choice M07.9 made about a
 * card schema it could not interpret, pointing at an older build instead of a
 * newer one.
 */

/* ------------------------------------------------------- the documents read */

const proportionShape = z.object({
  point: z.number(),
  low: z.number(),
  high: z.number(),
  successes: z.number(),
  total: z.number(),
});
type Proportion = z.infer<typeof proportionShape>;

const runShape = z.object({
  matches: z.number(),
  usableMatches: z.number(),
  abnormalMatches: z.number(),
  abnormalShare: z.number(),
  terminations: z.record(z.string(), z.number()),
  draws: z.number(),
  turns: z.object({
    mean: z.number(),
    median: z.number(),
    p10: z.number(),
    p90: z.number(),
    max: z.number(),
  }),
  decisionsPerMatch: z.number(),
  botFailures: z.number(),
  seatWinRates: z.array(z.object({ seatIndex: z.number(), rate: proportionShape })),
  pilotWinRates: z.array(z.object({ pilotId: z.string(), rate: proportionShape })),
  agentClassWinRates: z.array(
    z.object({
      agentClass: z.string(),
      pilotIds: z.array(z.string()),
      rate: proportionShape,
    }),
  ),
  environments: z.array(z.string()),
});

const deckShape = z.object({
  deckId: z.string(),
  deckHash: z.string(),
  commanderId: z.string(),
  matches: z.number(),
  winRate: proportionShape,
  averageTurns: z.number(),
  averageDamageDealt: z.number(),
  averageDamageTaken: z.number(),
});

const matchupShape = z.object({
  deckHash: z.string(),
  opponentHash: z.string(),
  rate: proportionShape,
});

const cardShape = z.object({
  definitionId: z.string(),
  decksIncluding: z.number(),
  seatMatches: z.number(),
  copiesPerDeck: z.number(),
  winRateWhenIncluded: proportionShape,
  winRateWhenAbsent: proportionShape,
  inclusionWinRateLift: z.number(),
  drawRate: z.number(),
  playsPerDraw: z.number(),
  gamesDrawnAndPlayedShare: z.number(),
  gamesDrawn: z.number(),
  activationsPerMatch: z.number(),
  averageEnergySpent: z.number(),
  deadInHandShare: z.number(),
  mechanicallyUnusableShare: z.number(),
  strategicallyUnusedShare: z.number(),
  removalRate: z.number(),
});

const calibrationShape = z.object({
  schemaVersion: z.number(),
  standing: z.string(),
  reasons: z.array(z.string()),
  promotionRequires: z.string(),
});

const summaryFileSchema = z.object({
  schemaVersion: z.number(),
  configHash: z.string(),
  aggregate: z.object({
    run: runShape,
    decks: z.array(deckShape),
    matchups: z.array(matchupShape),
    cards: z.array(cardShape),
  }),
  calibration: calibrationShape.nullish(),
});
type SummaryFile = z.infer<typeof summaryFileSchema>;

/** The manifest's per-run counts, which the aggregate does not hold. */
const manifestCountsSchema = z.object({
  failedMatches: z.number().optional(),
  resumedMatches: z.number().optional(),
});

/* ------------------------------------------------------------ the row builder */

/**
 * A table's shape and its rows, built together.
 *
 * One function per table rather than a switch inside the reader, so a column that
 * is declared and a cell that is produced sit next to each other. The schema's
 * refinement — *every cell in a result table belongs to a declared column* —
 * catches the pair drifting apart, and this is the arrangement that makes the
 * failure obvious when it does.
 */
interface BuiltTable {
  readonly columns: readonly ResultColumn[];
  readonly rows: readonly ResultRow[];
}

const column = (
  key: string,
  label: string,
  kind: ResultColumn['kind'],
  bounds: ResultColumn['bounds'] = null,
): ResultColumn => ({ key, label, kind, bounds });

const interval = (key: string, label: string): ResultColumn =>
  column(key, label, 'interval', { low: `${key}Low`, high: `${key}High` });

function spreadRate(key: string, rate: Proportion): ResultRow {
  return {
    [key]: rate.point,
    [`${key}Low`]: rate.low,
    [`${key}High`]: rate.high,
    [`${key}Games`]: rate.total,
  };
}

function buildTable(table: ResultTableName, summary: SummaryFile): BuiltTable {
  const { run, decks, matchups, cards } = summary.aggregate;
  switch (table) {
    case 'decks':
      return {
        columns: [
          column('deckId', 'Deck', 'identifier'),
          column('commanderId', 'Commander', 'identifier'),
          column('deckHash', 'Content address', 'identifier'),
          column('matches', 'Games', 'count'),
          interval('winRate', 'Win rate'),
          column('winRateGames', 'Win-rate games', 'count'),
          column('averageTurns', 'Average turns', 'number'),
          column('averageDamageDealt', 'Damage dealt', 'number'),
          column('averageDamageTaken', 'Damage taken', 'number'),
        ],
        rows: decks.map((deck) => ({
          deckId: deck.deckId,
          commanderId: deck.commanderId,
          deckHash: deck.deckHash,
          matches: deck.matches,
          ...spreadRate('winRate', deck.winRate),
          averageTurns: deck.averageTurns,
          averageDamageDealt: deck.averageDamageDealt,
          averageDamageTaken: deck.averageDamageTaken,
        })),
      };

    case 'matchups':
      return {
        columns: [
          column('deckHash', 'Deck', 'identifier'),
          column('opponentHash', 'Opponent', 'identifier'),
          interval('rate', 'Win rate'),
          column('rateGames', 'Games', 'count'),
        ],
        rows: matchups.map((matchup) => ({
          deckHash: matchup.deckHash,
          opponentHash: matchup.opponentHash,
          ...spreadRate('rate', matchup.rate),
        })),
      };

    case 'cards':
      return {
        columns: [
          column('definitionId', 'Card', 'identifier'),
          column('decksIncluding', 'Decks including', 'count'),
          column('seatMatches', 'Seat-matches', 'count'),
          column('copiesPerDeck', 'Copies per deck', 'number'),
          interval('winRateWhenIncluded', 'Win rate when included'),
          column('winRateWhenIncludedGames', 'Included games', 'count'),
          interval('winRateWhenAbsent', 'Win rate when absent'),
          column('winRateWhenAbsentGames', 'Absent games', 'count'),
          column('inclusionWinRateLift', 'Inclusion lift', 'number'),
          column('drawRate', 'Draw rate', 'proportion'),
          column('playsPerDraw', 'Plays per draw', 'number'),
          column('gamesDrawnAndPlayedShare', 'Drawn and played', 'proportion'),
          column('gamesDrawn', 'Games drawn', 'count'),
          column('activationsPerMatch', 'Activations per match', 'number'),
          column('averageEnergySpent', 'Energy spent', 'number'),
          column('deadInHandShare', 'Dead in hand', 'proportion'),
          column('mechanicallyUnusableShare', 'Mechanically unusable', 'proportion'),
          column('strategicallyUnusedShare', 'Strategically unused', 'proportion'),
          column('removalRate', 'Removed', 'proportion'),
        ],
        rows: cards.map((card) => ({
          definitionId: card.definitionId,
          decksIncluding: card.decksIncluding,
          seatMatches: card.seatMatches,
          copiesPerDeck: card.copiesPerDeck,
          ...spreadRate('winRateWhenIncluded', card.winRateWhenIncluded),
          ...spreadRate('winRateWhenAbsent', card.winRateWhenAbsent),
          inclusionWinRateLift: card.inclusionWinRateLift,
          drawRate: card.drawRate,
          playsPerDraw: card.playsPerDraw,
          gamesDrawnAndPlayedShare: card.gamesDrawnAndPlayedShare,
          gamesDrawn: card.gamesDrawn,
          activationsPerMatch: card.activationsPerMatch,
          averageEnergySpent: card.averageEnergySpent,
          deadInHandShare: card.deadInHandShare,
          mechanicallyUnusableShare: card.mechanicallyUnusableShare,
          strategicallyUnusedShare: card.strategicallyUnusedShare,
          removalRate: card.removalRate,
        })),
      };

    case 'seats':
      return {
        columns: [
          column('seatIndex', 'Seat', 'count'),
          interval('rate', 'Win rate'),
          column('rateGames', 'Games', 'count'),
        ],
        rows: run.seatWinRates.map((seat) => ({
          seatIndex: seat.seatIndex,
          ...spreadRate('rate', seat.rate),
        })),
      };

    case 'pilots':
      return {
        columns: [
          column('pilotId', 'Pilot', 'identifier'),
          interval('rate', 'Win rate'),
          column('rateGames', 'Games', 'count'),
        ],
        rows: run.pilotWinRates.map((pilot) => ({
          pilotId: pilot.pilotId,
          ...spreadRate('rate', pilot.rate),
        })),
      };

    case 'agent_classes':
      // Beside the pilot table and never merged into it (M05.4): `random_legal`
      // and a heuristic are two instruments rather than two skill levels, and one
      // table holding both kinds of row is the pooled skill distribution that
      // rule forbids.
      return {
        columns: [
          column('agentClass', 'Agent class', 'identifier'),
          column('pilots', 'Pilots', 'text'),
          interval('rate', 'Win rate'),
          column('rateGames', 'Games', 'count'),
        ],
        rows: run.agentClassWinRates.map((entry) => ({
          agentClass: entry.agentClass,
          pilots: entry.pilotIds.join(', ').slice(0, 200),
          ...spreadRate('rate', entry.rate),
        })),
      };

    case 'terminations':
      return {
        columns: [
          column('kind', 'Termination', 'identifier'),
          column('matches', 'Games', 'count'),
          column('abnormal', 'Excluded from statistics', 'flag'),
        ],
        rows: Object.entries(run.terminations)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([kind, matches]) => ({
            kind,
            matches,
            abnormal: (ABNORMAL_TERMINATIONS as readonly string[]).includes(kind),
          })),
      };
  }
}

/* ------------------------------------------------------------ the offset cursor */

/**
 * A position in a result table, as an opaque token.
 *
 * A row offset rather than the catalog's `createdAt`-then-ID position, because a
 * result table is a snapshot of an immutable file: nothing is inserted while it
 * is being paged, so an offset cannot skip or repeat a row the way it would over
 * a live listing. base64url for the reason `catalog/cursor.ts` gives — the
 * alphabet has no separator, so a continuation token cannot carry a path.
 */
export function encodeRowCursor(offset: number): string {
  return Buffer.from(JSON.stringify({ o: offset }), 'utf8').toString('base64url');
}

export function decodeRowCursor(token: string): Result<number, readonly AdminError[]> {
  const refusal = err([
    adminError(
      'admin/invalid_cursor',
      'This continuation token was not issued by this build, so the page it names could not be found. Ask for the first page again.',
      { path: 'page.cursor' },
    ),
  ]);
  try {
    const parsed = z
      .object({ o: z.number().int().min(0).max(10_000_000) })
      .safeParse(JSON.parse(Buffer.from(token, 'base64url').toString('utf8')));
    return parsed.success ? ok(parsed.data.o) : refusal;
  } catch {
    return refusal;
  }
}

/* -------------------------------------------------------------- the reader */

export interface ResultReaderOptions {
  readonly store: CatalogStore;
  readonly roots: ResolvedCatalogRoots;
}

interface OpenRun {
  readonly job: CatalogJobDocument;
  readonly directory: string;
  readonly summary: SummaryFile;
}

export class ResultReader {
  readonly #store: CatalogStore;
  readonly #roots: ResolvedCatalogRoots;

  constructor(options: ResultReaderOptions) {
    this.#store = options.store;
    this.#roots = options.roots;
  }

  async readSummary(jobId: JobId): Promise<Result<ResultSummary, readonly AdminError[]>> {
    const open = await this.#open(jobId);
    if (isErr(open)) return open;
    const { job, directory, summary } = open.value;

    // The identity is re-read from the manifest rather than taken from the
    // catalog entry, which is the whole of ADR 0023 §3 as a call graph: the entry
    // says which run this is, and the run says what it was.
    const identity = await readRunIdentity(directory, { jobId });
    if (isErr(identity)) return err(identity.error);

    const stored = job.result?.identity;
    if (stored !== undefined && stored.configHash !== identity.value.configHash) {
      return err([
        noResult(
          jobId,
          'The directory this job indexes no longer declares the run it was recorded with, so nothing was read from it.',
        ),
      ]);
    }

    const calibration = summary.calibration ?? null;
    if (calibration === null) {
      return err([
        noResult(
          jobId,
          'This run was written before the calibration standing existed, and a result may not be shown without one. It was left where it is rather than served with the field omitted.',
        ),
      ]);
    }

    const counts = await this.#readManifestCounts(directory);
    const run = summary.aggregate.run;

    const abnormalByKind: Record<string, number> = {};
    for (const [kind, count] of Object.entries(run.terminations)) {
      if ((ABNORMAL_TERMINATIONS as readonly string[]).includes(kind)) abnormalByKind[kind] = count;
    }

    const value = {
      jobId,
      kind: job.spec.kind,
      configHash: job.spec.configHash,
      identity: identity.value,
      source: { document: 'summary.json' as const, schemaVersion: summary.schemaVersion },
      denominators: {
        matches: run.matches,
        usableMatches: run.usableMatches,
        abnormalMatches: run.abnormalMatches,
        failedMatches: counts.failedMatches,
        resumedMatches: counts.resumedMatches,
        abnormalByKind,
      },
      evidence: {
        standing: calibration.standing,
        reasons: calibration.reasons.slice(0, 16),
        promotionRequires: calibration.promotionRequires,
        analysisVersion: calibration.schemaVersion,
      },
      readings: [
        reading('matches', 'Games played', run.matches, 'count'),
        reading('usableMatches', 'Games in the statistics', run.usableMatches, 'count'),
        reading('abnormalMatches', 'Games excluded', run.abnormalMatches, 'count'),
        reading('abnormalShare', 'Excluded share', run.abnormalShare, 'proportion'),
        reading('draws', 'Draws', run.draws, 'count'),
        reading('turnsMean', 'Turns, mean', run.turns.mean, 'number'),
        reading('turnsMedian', 'Turns, median', run.turns.median, 'number'),
        reading('turnsP10', 'Turns, 10th percentile', run.turns.p10, 'number'),
        reading('turnsP90', 'Turns, 90th percentile', run.turns.p90, 'number'),
        reading('turnsMax', 'Turns, longest', run.turns.max, 'number'),
        reading('decisionsPerMatch', 'Decisions per game', run.decisionsPerMatch, 'number'),
        reading('botFailures', 'Pilot failures', run.botFailures, 'count'),
        reading('environments', 'Environments', run.environments.length, 'count'),
      ],
      tables: rowCounts(summary),
      // The preset's published limitations, reached through the job's own
      // `origin`. `presets.ts` gives the reason they live in the registry rather
      // than being written by a result screen — *a limitation that is authored at
      // the point of display is one that can be forgotten at the point of
      // display* — and `jobOriginSchema` is what makes the link durable rather
      // than a tag somebody can tidy away. A `direct` job has none, which is
      // truthful: a hand-assembled configuration made no claim to caveat.
      limitations:
        job.origin.kind === 'preset' ? [...PRESET_REGISTRY[job.origin.presetId].limitations] : [],
    };

    const validated = resultSummarySchema.safeParse(value);
    if (!validated.success) return err([builtBadly(jobId, 'summary')]);
    return ok(validated.data);
  }

  async readTable(
    jobId: JobId,
    table: ResultTableName,
    page: PageRequest,
  ): Promise<Result<ResultTable, readonly AdminError[]>> {
    const open = await this.#open(jobId);
    if (isErr(open)) return open;

    let offset = 0;
    if (page.cursor !== null) {
      const decoded = decodeRowCursor(page.cursor);
      if (isErr(decoded)) return decoded;
      offset = decoded.value;
    }

    const built = buildTable(table, open.value.summary);
    const rows = built.rows.slice(offset, offset + page.limit);
    const consumed = offset + rows.length;
    const value = {
      jobId,
      table,
      source: {
        document: 'summary.json' as const,
        schemaVersion: open.value.summary.schemaVersion,
      },
      columns: built.columns,
      rows,
      page: {
        returned: rows.length,
        limit: page.limit,
        nextCursor: consumed < built.rows.length ? encodeRowCursor(consumed) : null,
        total: built.rows.length,
      },
    };

    const validated = resultTableSchema.safeParse(value);
    if (!validated.success) return err([builtBadly(jobId, table)]);
    return ok(validated.data);
  }

  /**
   * The job, its resolved directory and its summary — or the one refusal that
   * covers every way there is not one.
   *
   * The location is re-resolved against the configured root on every request
   * rather than trusted from the document (ADR 0023 §5). It is the same
   * `resolveResultLocation` the runner uses, so a symlink that appeared under the
   * result root after a run finished is refused here exactly as it would have
   * been before the run started.
   */
  async #open(jobId: JobId): Promise<Result<OpenRun, readonly AdminError[]>> {
    const job = await this.#store.readJob(jobId);
    if (isErr(job)) return err(job.error);

    const reference = job.value.result;
    if (reference === null) {
      return err([
        noResult(
          jobId,
          'This job has produced no canonical result yet, so there is nothing to read.',
        ),
      ]);
    }

    const directory = await resolveResultLocation(this.#roots, reference.location);
    if (isErr(directory)) return err(directory.error);

    const text = await readDocumentText(experimentPaths(directory.value).summary);
    if (text === null) {
      return err([
        noResult(
          jobId,
          'The run this job indexes has no summary document, so there is nothing to read from it. Its raw records are still where the run left them.',
        ),
      ]);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return err([
        noResult(jobId, 'The run this job indexes has a summary that is not readable JSON.'),
      ]);
    }

    const summary = summaryFileSchema.safeParse(parsed);
    if (!summary.success) {
      return err([
        noResult(
          jobId,
          'The run this job indexes has a summary that does not carry the readings a result view needs.',
        ),
      ]);
    }

    return ok({ job: job.value, directory: directory.value, summary: summary.data });
  }

  async #readManifestCounts(
    directory: string,
  ): Promise<{ failedMatches: number; resumedMatches: number }> {
    const text = await readDocumentText(experimentPaths(directory).manifest);
    if (text === null) return { failedMatches: 0, resumedMatches: 0 };
    try {
      const parsed = manifestCountsSchema.safeParse(JSON.parse(text));
      if (!parsed.success) return { failedMatches: 0, resumedMatches: 0 };
      return {
        failedMatches: parsed.data.failedMatches ?? 0,
        resumedMatches: parsed.data.resumedMatches ?? 0,
      };
    } catch {
      return { failedMatches: 0, resumedMatches: 0 };
    }
  }
}

function rowCounts(summary: SummaryFile): { table: ResultTableName; rows: number }[] {
  const names: ResultTableName[] = [
    'decks',
    'matchups',
    'cards',
    'seats',
    'pilots',
    'agent_classes',
    'terminations',
  ];
  return names.map((table) => ({ table, rows: buildTable(table, summary).rows.length }));
}

function reading(
  key: string,
  label: string,
  value: number,
  kind: ResultColumn['kind'],
): { key: string; label: string; value: number; kind: ResultColumn['kind'] } {
  return { key, label, value, kind };
}

function noResult(jobId: JobId, message: string): AdminError {
  return adminError('admin/no_result', message, { context: { jobId } });
}

/**
 * The refusal for an answer this service built and could not validate.
 *
 * A defect rather than a data problem, and it is reported as one: the message
 * says the projection is wrong rather than blaming the run, and nothing about
 * the failing field travels, because the field names in a broken projection are
 * the least useful and most leaky thing to send.
 */
function builtBadly(jobId: JobId, what: string): AdminError {
  return adminError(
    'admin/schema',
    'This service built a result view it could not validate against its own contract, so it was not sent. This is a defect in the build rather than a problem with the run.',
    { context: { jobId, view: what } },
  );
}
