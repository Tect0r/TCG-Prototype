import {
  PRESET_REGISTRY,
  adminError,
  resultSummarySchema,
  resultTableSchema,
  type AdminError,
  type CatalogJobDocument,
  type JobId,
  type JobOrigin,
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
 * `summary.json` is `@tcg/simulator`'s document and it grows — version 8 added
 * eligibility-aware card denominators and the forced-inclusion floor, version 7
 * added the calibration standing, version 6 the deck construction reading — so
 * the schemas below **strip** unknown fields rather than refusing them, exactly as
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
  /**
   * M08.12 fields. `.nullish()` — never `.nullable()` alone — because a run
   * written before `SUMMARY_SCHEMA_VERSION` 8 never recorded eligibility at
   * all: reading it loosely and reporting `null` ("not measured") is the same
   * choice `calibration` above already made for the same reason.
   */
  eligibleDecks: z.number().nullish(),
  inclusionAmongEligibleShare: z.number().nullish(),
  seatMatches: z.number(),
  copiesPerDeck: z.number(),
  winRateWhenIncluded: proportionShape,
  winRateWhenAbsent: proportionShape,
  /**
   * `null` is `insufficient_data` (M08.12): the contrast this run reported no
   * observations for, never a fabricated point difference.
   */
  inclusionWinRateLift: z.number().nullable(),
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

/**
 * M08.13/M08.14 fields, read loosely for the same reason `calibration` is: a
 * run written before `SUMMARY_SCHEMA_VERSION` 9 has no `aggregate.commanders`
 * at all, so `.default([])` rather than `.nullish()` — an old run reads as
 * "no Commander evidence" rather than refusing the whole summary, which is
 * consistent with the M08.12 precedent above (a defect there is refusing a
 * *field*, never the document).
 */
const commanderShape = z.object({
  commanderId: z.string(),
  matches: z.number(),
  winRate: proportionShape,
  bySeat: z.array(z.object({ seatIndex: z.number(), rate: proportionShape })),
  byPilot: z.array(z.object({ pilotId: z.string(), rate: proportionShape })),
  byAgentClass: z.array(
    z.object({ agentClass: z.string(), pilotIds: z.array(z.string()), rate: proportionShape }),
  ),
  turns: z.object({
    mean: z.number(),
    median: z.number(),
    p10: z.number(),
    p90: z.number(),
    max: z.number(),
  }),
  endReasons: z.record(z.string(), z.number()),
  decks: z.number(),
  deckDiversity: z.number(),
  topDeckFitness: z.number().nullable(),
  medianDeckFitness: z.number().nullable(),
  populationSurvivalShare: z.number().nullable(),
  archiveSurvivalShare: z.number().nullable(),
});

const commanderMatchupShape = z.object({
  commanderId: z.string(),
  opponentCommanderId: z.string(),
  rate: proportionShape,
});

/**
 * `commanderShares` is `.default([])` rather than `.nullish()`: a run written
 * before `SUMMARY_SCHEMA_VERSION` 10 has a `searchHistory` entry with no such
 * field, and reading it as "no Commander recorded for this generation" is the
 * honest reading — there is nothing to backfill, only a forward computation
 * from a checkpoint an old run never wrote (see `experiment.ts`'s v10 note).
 */
const generationReportShape = z.object({
  generation: z.number(),
  /**
   * `searchHistory` concatenates every independent replicate's own generation
   * sequence one after another (`experiment.ts`'s `SearchHistoryEntry`), so
   * without this a run's two replicates' generation 0 would read as one
   * trajectory and their Commander shares would sum to 2, not 1, on what looks
   * like a single generation. `.nullish()` for a run written before this field
   * existed — there is nothing to backfill, only a forward computation this
   * build cannot make for a run it did not itself run.
   */
  replicate: z.number().int().min(0).nullish(),
  evaluated: z.number(),
  matches: z.number(),
  abnormalMatches: z.number(),
  best: z.object({ score: z.number(), winRate: z.number() }).nullable(),
  meanScore: z.number(),
  cardEntropy: z.number(),
  commanderCount: z.number(),
  commanderShares: z.array(z.object({ commanderId: z.string(), share: z.number() })).default([]),
  meanPairwiseDistance: z.number(),
  archiveSize: z.number(),
});

const summaryFileSchema = z.object({
  schemaVersion: z.number(),
  configHash: z.string(),
  aggregate: z.object({
    run: runShape,
    decks: z.array(deckShape),
    matchups: z.array(matchupShape),
    cards: z.array(cardShape),
    commanders: z.array(commanderShape).default([]),
    commanderMatchups: z.array(commanderMatchupShape).default([]),
  }),
  calibration: calibrationShape.nullish(),
  searchHistory: z.array(generationReportShape).default([]),
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

/**
 * `spreadRate`, but a zero-observation side reads `null` rather than the
 * fabricated `{ point: 0, low: 0, high: 1 }` `proportion(0, 0)` returns
 * (M08.12): `report.md` already prints "insufficient data" for the same cell,
 * and a table that kept publishing a number here would disagree with its own
 * markdown about the one thing this tranche exists to fix.
 */
function spreadRateOrInsufficient(key: string, rate: Proportion): ResultRow {
  if (rate.total === 0) {
    return { [key]: null, [`${key}Low`]: null, [`${key}High`]: null, [`${key}Games`]: 0 };
  }
  return spreadRate(key, rate);
}

function buildTable(table: ResultTableName, summary: SummaryFile): BuiltTable {
  const { run, decks, matchups, cards, commanders, commanderMatchups } = summary.aggregate;
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
          // `null` on both — read "not measured" — for a run written before
          // the eligibility reading existed (M08.12).
          column('eligibleDecks', 'Eligible decks', 'count'),
          column('inclusionAmongEligibleShare', 'Inclusion among eligible', 'proportion'),
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
          eligibleDecks: card.eligibleDecks ?? null,
          inclusionAmongEligibleShare: card.inclusionAmongEligibleShare ?? null,
          seatMatches: card.seatMatches,
          copiesPerDeck: card.copiesPerDeck,
          ...spreadRateOrInsufficient('winRateWhenIncluded', card.winRateWhenIncluded),
          ...spreadRateOrInsufficient('winRateWhenAbsent', card.winRateWhenAbsent),
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

    case 'commanders':
      return {
        columns: [
          column('commanderId', 'Commander', 'identifier'),
          column('matches', 'Games', 'count'),
          interval('winRate', 'Win rate'),
          column('winRateGames', 'Win-rate games', 'count'),
          column('decks', 'Distinct decks', 'count'),
          column('deckDiversity', 'Deck diversity', 'number'),
          column('topDeckFitness', 'Top deck fitness', 'number'),
          column('medianDeckFitness', 'Median deck fitness', 'number'),
          column('populationSurvivalShare', 'Population survival share', 'proportion'),
          column('archiveSurvivalShare', 'Archive survival share', 'proportion'),
        ],
        rows: commanders.map((commander) => ({
          commanderId: commander.commanderId,
          matches: commander.matches,
          ...spreadRate('winRate', commander.winRate),
          decks: commander.decks,
          deckDiversity: commander.deckDiversity,
          topDeckFitness: commander.topDeckFitness,
          medianDeckFitness: commander.medianDeckFitness,
          populationSurvivalShare: commander.populationSurvivalShare,
          archiveSurvivalShare: commander.archiveSurvivalShare,
        })),
      };

    case 'commander_matchups':
      return {
        columns: [
          column('commanderId', 'Commander', 'identifier'),
          column('opponentCommanderId', 'Opponent', 'identifier'),
          interval('rate', 'Win rate'),
          column('rateGames', 'Games', 'count'),
        ],
        rows: commanderMatchups.map((matchup) => ({
          commanderId: matchup.commanderId,
          opponentCommanderId: matchup.opponentCommanderId,
          ...spreadRate('rate', matchup.rate),
        })),
      };

    case 'commander_generations':
      return {
        columns: [
          column('generation', 'Generation', 'count'),
          // `null` on a run written before `replicate` existed — never `0`,
          // which would misreport "first of several" (see the field's own
          // comment on `generationReportShape`).
          column('replicate', 'Replicate', 'count'),
          column('commanderId', 'Commander', 'identifier'),
          column('share', 'Share of population', 'proportion'),
        ],
        rows: summary.searchHistory.flatMap((entry) =>
          entry.commanderShares.map((share) => ({
            generation: entry.generation,
            replicate: entry.replicate ?? null,
            commanderId: share.commanderId,
            share: share.share,
          })),
        ),
      };

    case 'search_generations':
      return {
        columns: [
          column('generation', 'Generation', 'count'),
          column('replicate', 'Replicate', 'count'),
          column('evaluated', 'Decks evaluated', 'count'),
          column('matches', 'Games', 'count'),
          column('abnormalMatches', 'Games excluded', 'count'),
          column('bestScore', 'Best score', 'number'),
          column('meanScore', 'Mean score', 'number'),
          column('cardEntropy', 'Card entropy', 'number'),
          column('commanderCount', 'Distinct Commanders', 'count'),
          column('meanPairwiseDistance', 'Mean pairwise distance', 'number'),
          column('archiveSize', 'Archive size', 'count'),
        ],
        rows: summary.searchHistory.map((entry) => ({
          generation: entry.generation,
          replicate: entry.replicate ?? null,
          evaluated: entry.evaluated,
          matches: entry.matches,
          abnormalMatches: entry.abnormalMatches,
          bestScore: entry.best?.score ?? null,
          meanScore: entry.meanScore,
          cardEntropy: entry.cardEntropy,
          commanderCount: entry.commanderCount,
          meanPairwiseDistance: entry.meanPairwiseDistance,
          archiveSize: entry.archiveSize,
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
      limitations: limitationsOf(job.origin),
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
    'commanders',
    'commander_matchups',
    'commander_generations',
    'search_generations',
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
 * What a run's own origin says it may not be cited for.
 *
 * A preset's limitations live in `PRESET_REGISTRY`, for the reason above this
 * function's one call site gives. A frozen championship (M08.15) is not a
 * preset stage — its `deferredStages` entry says exactly why `expandPreset`
 * could never produce it — so its limitation is written here instead, once,
 * rather than at the point of display.
 */
function limitationsOf(origin: JobOrigin): string[] {
  switch (origin.kind) {
    case 'preset':
      return [...PRESET_REGISTRY[origin.presetId].limitations];
    case 'commander_championship':
      return [
        'Finalists were frozen before this run started: this round measures them exactly as ' +
          'selected, on fresh seeds, and never re-optimizes or replaces one that loses.',
        'A Commander whose search fell short of the requested finalist count is represented by ' +
          'fewer decks here than the others — recorded on the job as a shortfall, not silently ' +
          'evened out.',
        'Finalists were chosen for distinctness from each other, from the search’s final ' +
          'population and archive together, and not ranked by search performance — "finalist" ' +
          'means sufficiently distinct, not strongest.',
        'This run carries its finalists as an inline deck list, so its own deck-construction ' +
          'reading shows "hand authored" for every one of them. That is an artifact of freezing ' +
          'a fixed list, not a fact about how these decks were built — each was found by search, ' +
          'and its real construction and lineage are in the source search job’s own decks.json, ' +
          'findable by the deck hash this run carries unchanged.',
      ];
    case 'direct':
      return [];
  }
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
