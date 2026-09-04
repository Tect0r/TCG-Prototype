import {
  adminError,
  playerMetaResultTableSchema,
  playerMetaRunSummarySchema,
  PLAYER_META_RESULT_TABLE_NAMES,
  type AdminError,
  type PageRequest,
  type PlayerMetaFilter,
  type PlayerMetaResultTable,
  type PlayerMetaResultTableName,
  type PlayerMetaRunSummary,
  type ResultColumn,
  type ResultRow,
} from '@tcg/admin-contracts';
import { err, isErr, ok, type Result } from '@tcg/shared';
import {
  aggregateLiveCardEvidence,
  aggregateLiveMatches,
  aggregateLiveMatchSurrenders,
  currentLiveMatchCardDatabases,
  filterLiveMatches,
  readLiveMatchEnvelopes,
  readLiveMatchPreActionCaptures,
  type LiveCardEvidence,
  type LiveMatchAggregate,
  type LiveMatchAggregatePartition,
  type LiveMatchSurrenderAggregate,
} from '@tcg/simulator';

import { type ResolvedCatalogRoots } from '../catalog/roots.js';
import {
  column,
  decodeRowCursor,
  encodeRowCursor,
  interval,
  spreadRate,
  type Proportion,
} from './results.js';

/**
 * M08.25B — the Player Meta read model: directory-in, pure, no HTTP address
 * and no client UI, matching the split M08.19A/B drew for the Adaptive
 * Counter reader (`./adaptive-results.ts`'s own doc comment).
 *
 * Unlike an Adaptive Counter run, there is no single canonical result
 * document to open: a Player Meta root directory holds one subdirectory per
 * live match (`LiveMatchFileStore`), and `@tcg/simulator`'s
 * `readLiveMatchEnvelopes` (M08.25B) is the tolerant reader that turns it
 * into `LiveMatchEnvelope[]` plus a skipped-match report. Everything past
 * that point — filtering (`filterLiveMatches`, M08.25A), card-database
 * resolution (`currentLiveMatchCardDatabases`) and aggregation
 * (`aggregateLiveMatches`, `aggregateLiveCardEvidence`, M08.24) — is
 * `@tcg/simulator`'s own, never recomputed here, per ADR 0023 §2.
 *
 * `playerMetaFilterSchema`'s `PlayerMetaFilter` (`@tcg/admin-contracts`) is
 * assignable to `@tcg/simulator`'s `LiveMatchFilter` without translation by
 * design (`live-match-filter.ts`'s own doc comment): both restate the same
 * five field names over the same primitive types.
 *
 * A table spans every partition a filtered query found rather than being
 * scoped to one: every row carries its own `source`/`contentVersion`/
 * `rulesVersion` columns (`PARTITION_COLUMNS`), so a caller sees every
 * source label a query matched in one page rather than making one request
 * per partition. Nothing here pools a rate or a count across a partition
 * boundary — only the table's row list spans partitions, never the
 * arithmetic behind any single row.
 */

const PARTITION_COLUMNS: readonly ResultColumn[] = [
  column('source', 'Source', 'identifier'),
  column('contentVersion', 'Content version', 'count'),
  column('rulesVersion', 'Rules version', 'identifier'),
];

function partitionCells(partition: LiveMatchAggregatePartition): ResultRow {
  return {
    source: partition.source,
    contentVersion: partition.contentVersion,
    rulesVersion: partition.rulesVersion,
  };
}

/**
 * `spreadRate`, but a zero-observation side reads `null` rather than the
 * fabricated `{point: 0, low: 0, high: 1}` a zero-total `ProportionEstimate`
 * carries (the same M08.12 reasoning `./results.ts`'s own
 * `spreadRateOrInsufficient` states; not imported because it is module-
 * private there).
 */
function spreadRateOrInsufficient(key: string, rate: Proportion): ResultRow {
  if (rate.total === 0) {
    return { [key]: null, [`${key}Low`]: null, [`${key}High`]: null, [`${key}Games`]: 0 };
  }
  return spreadRate(key, rate);
}

const PLAYER_META_RUN_LIMITATIONS: readonly string[] = [
  'Popularity is reported two ways: match-weighted (`matches`) counts every seat-appearance, so one ' +
    'deck replayed many times can dominate it, while unique-deck-weighted (`uniqueDecks`) counts each ' +
    'built deck once regardless of how often it was replayed. There is no third, player-weighted ' +
    'count — a live-match record carries no stable cross-match player identity.',
  'Win rate, duration and termination-origin figures are match-weighted only and count decisive ' +
    'matches — a match with no recorded outcome (for example an unrecordable abandonment) is excluded ' +
    'from every rate here even though it is still counted as a selection.',
  'Cluster and eligible-card tables are empty for any partition whose matches span more than one game ' +
    'format, or name a format this build does not have bundled — a card database could not be ' +
    'resolved for that partition, so nothing here fabricates cluster or eligibility evidence for it.',
  'Surrender tables come only from matches that ended in an explicit concede or a leave-triggered ' +
    'concession — a timed-out or otherwise abandoned match produces no pre-action capture and ' +
    'contributes no evidence to these tables. State and exposure figures describe what a surrendering ' +
    'player was structurally facing (phase, combat, an open Reaction window or pending choice) and which ' +
    'events or cards were present in their retained window; they name exposure and proximity, never a ' +
    'cause, and must not be read as one.',
];

/* -------------------------------------------------------------- the reader */

interface OpenPlayerMeta {
  readonly aggregates: readonly LiveMatchAggregate[];
  readonly cardEvidence: readonly LiveCardEvidence[];
  readonly surrenders: readonly LiveMatchSurrenderAggregate[];
  readonly recordsRead: number;
  readonly recordsSkipped: number;
}

function openPlayerMeta(rootDirectory: string, filter: PlayerMetaFilter): OpenPlayerMeta {
  const read = readLiveMatchEnvelopes(rootDirectory);
  const matches = filterLiveMatches(read.matches, filter);
  const databases = currentLiveMatchCardDatabases(matches);
  const captures = readLiveMatchPreActionCaptures(rootDirectory).captures;

  return {
    aggregates: aggregateLiveMatches(matches, { cardDatabasesByContentVersion: databases }),
    cardEvidence: aggregateLiveCardEvidence(matches, { cardDatabasesByContentVersion: databases }),
    surrenders: aggregateLiveMatchSurrenders(captures, matches).aggregates,
    recordsRead: matches.length,
    recordsSkipped: read.skipped.length,
  };
}

/** Reads a Player Meta root directory's headline reading for a filtered query. */
export function readPlayerMetaSummary(
  rootDirectory: string,
  filter: PlayerMetaFilter,
): Result<PlayerMetaRunSummary, readonly AdminError[]> {
  const open = openPlayerMeta(rootDirectory, filter);

  const value = {
    source: { recordsRead: open.recordsRead, recordsSkipped: open.recordsSkipped },
    partitions: open.aggregates.map((aggregate) => ({
      partition: aggregate.partition,
      matches: aggregate.matches,
      uniqueDecks: aggregate.uniqueDecks,
      decisiveMatches: aggregate.decisiveMatches,
    })),
    tables: PLAYER_META_RESULT_TABLE_NAMES.map((table) => ({
      table,
      rows: buildPlayerMetaTable(table, open.aggregates, open.cardEvidence, open.surrenders).rows
        .length,
    })),
    limitations: PLAYER_META_RUN_LIMITATIONS,
  };

  const validated = playerMetaRunSummarySchema.safeParse(value);
  if (!validated.success) return err([builtBadly('summary')]);
  return ok(validated.data);
}

/** Reads one bounded page of one Player Meta result table for a filtered query. */
export function readPlayerMetaTable(
  rootDirectory: string,
  table: PlayerMetaResultTableName,
  filter: PlayerMetaFilter,
  page: PageRequest,
): Result<PlayerMetaResultTable, readonly AdminError[]> {
  const open = openPlayerMeta(rootDirectory, filter);

  let offset = 0;
  if (page.cursor !== null) {
    const decoded = decodeRowCursor(page.cursor);
    if (isErr(decoded)) return decoded;
    offset = decoded.value;
  }

  const built = buildPlayerMetaTable(table, open.aggregates, open.cardEvidence, open.surrenders);
  const rows = built.rows.slice(offset, offset + page.limit);
  const consumed = offset + rows.length;
  const value = {
    table,
    source: { recordsRead: open.recordsRead, recordsSkipped: open.recordsSkipped },
    columns: built.columns,
    rows,
    page: {
      returned: rows.length,
      limit: page.limit,
      nextCursor: consumed < built.rows.length ? encodeRowCursor(consumed) : null,
      total: built.rows.length,
    },
  };

  const validated = playerMetaResultTableSchema.safeParse(value);
  if (!validated.success) return err([builtBadly(table)]);
  return ok(validated.data);
}

/* ------------------------------------------------------------ the row builder */

interface BuiltTable {
  readonly columns: readonly ResultColumn[];
  readonly rows: readonly ResultRow[];
}

/**
 * A table's shape and its rows, built together — one function per table for
 * the same reason `./adaptive-results.ts`'s `buildAdaptiveTable` is: a
 * column that is declared and a cell that is produced sit next to each
 * other, and the contract's own refinement — *every cell belongs to a
 * declared column* — catches the pair drifting apart.
 */
function buildPlayerMetaTable(
  table: PlayerMetaResultTableName,
  aggregates: readonly LiveMatchAggregate[],
  cardEvidence: readonly LiveCardEvidence[],
  surrenders: readonly LiveMatchSurrenderAggregate[],
): BuiltTable {
  switch (table) {
    case 'commanders':
      return {
        columns: [
          ...PARTITION_COLUMNS,
          column('commanderId', 'Commander', 'identifier'),
          column('matches', 'Matches', 'count'),
          column('uniqueDecks', 'Unique decks', 'count'),
          interval('winRate', 'Win rate'),
          column('winRateGames', 'Win-rate games', 'count'),
        ],
        rows: aggregates.flatMap((aggregate) =>
          aggregate.commanderSelection.map((entry) => ({
            ...partitionCells(aggregate.partition),
            commanderId: entry.commanderId,
            matches: entry.matches,
            uniqueDecks: entry.uniqueDecks,
            ...spreadRateOrInsufficient('winRate', entry.winRate),
          })),
        ),
      };

    case 'decks':
      return {
        columns: [
          ...PARTITION_COLUMNS,
          column('deckHash', 'Deck', 'identifier'),
          column('commanderId', 'Commander', 'identifier'),
          column('matches', 'Matches', 'count'),
          interval('winRate', 'Win rate'),
          column('winRateGames', 'Win-rate games', 'count'),
        ],
        rows: aggregates.flatMap((aggregate) =>
          aggregate.deckUsage.map((entry) => ({
            ...partitionCells(aggregate.partition),
            deckHash: entry.deckHash,
            commanderId: entry.commanderId,
            matches: entry.matches,
            ...spreadRateOrInsufficient('winRate', entry.winRate),
          })),
        ),
      };

    case 'deck_matchups':
      return {
        columns: [
          ...PARTITION_COLUMNS,
          column('deckHash', 'Deck', 'identifier'),
          column('opponentDeckHash', 'Opponent deck', 'identifier'),
          interval('winRate', 'Win rate'),
          column('winRateGames', 'Win-rate games', 'count'),
        ],
        rows: aggregates.flatMap((aggregate) =>
          aggregate.deckMatchups.map((entry) => ({
            ...partitionCells(aggregate.partition),
            deckHash: entry.deckHash,
            opponentDeckHash: entry.opponentDeckHash,
            ...spreadRateOrInsufficient('winRate', entry.winRate),
          })),
        ),
      };

    case 'clusters':
      return {
        columns: [
          ...PARTITION_COLUMNS,
          column('clusterId', 'Cluster', 'identifier'),
          column('label', 'Label', 'text'),
          column('deckCount', 'Decks in cluster', 'count'),
          column('deckHashes', 'Decks', 'text'),
          column('matches', 'Matches', 'count'),
          interval('winRate', 'Win rate'),
          column('winRateGames', 'Win-rate games', 'count'),
        ],
        rows: aggregates.flatMap((aggregate) =>
          (aggregate.clusters?.clusters ?? []).map((cluster) => ({
            ...partitionCells(aggregate.partition),
            clusterId: cluster.id,
            label: cluster.label,
            deckCount: cluster.deckHashes.length,
            deckHashes: cluster.deckHashes.join(', ').slice(0, 200),
            matches: cluster.matches,
            ...spreadRateOrInsufficient('winRate', cluster.winRate),
          })),
        ),
      };

    case 'cluster_matchups':
      return {
        columns: [
          ...PARTITION_COLUMNS,
          column('clusterId', 'Cluster', 'identifier'),
          column('opponentClusterId', 'Opponent cluster', 'identifier'),
          interval('winRate', 'Win rate'),
          column('winRateGames', 'Win-rate games', 'count'),
        ],
        rows: aggregates.flatMap((aggregate) =>
          (aggregate.clusters?.matchups ?? []).map((matchup) => ({
            ...partitionCells(aggregate.partition),
            clusterId: matchup.clusterId,
            opponentClusterId: matchup.opponentClusterId,
            ...spreadRateOrInsufficient('winRate', matchup.rate),
          })),
        ),
      };

    case 'cards':
      return {
        columns: [
          ...PARTITION_COLUMNS,
          column('commanderId', 'Commander', 'identifier'),
          column('cardId', 'Card', 'identifier'),
          column('status', 'Status', 'identifier'),
          column('matchesIncluding', 'Matches including', 'count'),
          column('inclusion', 'Inclusion rate', 'proportion'),
          column('decksIncluding', 'Decks including', 'count'),
          column('inclusionByUniqueDeck', 'Inclusion rate (unique decks)', 'proportion'),
        ],
        rows: cardEvidence.flatMap((evidence) =>
          (evidence.commanders ?? []).flatMap((commander) =>
            commander.cards.map((card) => ({
              ...partitionCells(evidence.partition),
              commanderId: commander.commanderId,
              cardId: card.cardId,
              status: card.status,
              matchesIncluding: card.matchesIncluding,
              inclusion: card.inclusion,
              decksIncluding: card.decksIncluding,
              inclusionByUniqueDeck: card.inclusionByUniqueDeck,
            })),
          ),
        ),
      };

    case 'pairs':
      return {
        columns: [
          ...PARTITION_COLUMNS,
          column('commanderId', 'Commander', 'identifier'),
          column('cardIdA', 'Card A', 'identifier'),
          column('cardIdB', 'Card B', 'identifier'),
          column('matchesIncludingBoth', 'Matches including both', 'count'),
          column('support', 'Support', 'proportion'),
          column('decksIncludingBoth', 'Decks including both', 'count'),
          column('supportByUniqueDeck', 'Support (unique decks)', 'proportion'),
        ],
        rows: cardEvidence.flatMap((evidence) =>
          (evidence.commanders ?? []).flatMap((commander) =>
            commander.pairs.map((pair) => ({
              ...partitionCells(evidence.partition),
              commanderId: commander.commanderId,
              cardIdA: pair.cardIdA,
              cardIdB: pair.cardIdB,
              matchesIncludingBoth: pair.matchesIncludingBoth,
              support: pair.support,
              decksIncludingBoth: pair.decksIncludingBoth,
              supportByUniqueDeck: pair.supportByUniqueDeck,
            })),
          ),
        ),
      };

    case 'duration':
      return {
        columns: [
          ...PARTITION_COLUMNS,
          column('decisiveMatches', 'Decisive matches', 'count'),
          column('meanFinalTurn', 'Mean final turn', 'number'),
          column('medianFinalTurn', 'Median final turn', 'number'),
          column('p10FinalTurn', 'P10 final turn', 'number'),
          column('p90FinalTurn', 'P90 final turn', 'number'),
          column('maxFinalTurn', 'Max final turn', 'number'),
        ],
        rows: aggregates.map((aggregate) => ({
          ...partitionCells(aggregate.partition),
          decisiveMatches: aggregate.duration.decisiveMatches,
          meanFinalTurn: aggregate.duration.meanFinalTurn,
          medianFinalTurn: aggregate.duration.medianFinalTurn,
          p10FinalTurn: aggregate.duration.p10FinalTurn,
          p90FinalTurn: aggregate.duration.p90FinalTurn,
          maxFinalTurn: aggregate.duration.maxFinalTurn,
        })),
      };

    case 'terminations':
      return {
        columns: [
          ...PARTITION_COLUMNS,
          column('origin', 'Termination origin', 'identifier'),
          column('matches', 'Matches', 'count'),
        ],
        rows: aggregates.flatMap((aggregate) =>
          aggregate.terminationOrigins.map((entry) => ({
            ...partitionCells(aggregate.partition),
            origin: entry.origin,
            matches: entry.matches,
          })),
        ),
      };

    case 'surrender_turns':
      return {
        columns: [
          ...PARTITION_COLUMNS,
          column('turn', 'Turn', 'number'),
          column('surrenders', 'Surrenders', 'count'),
        ],
        rows: surrenders.flatMap((aggregate) =>
          aggregate.turns.map((entry) => ({
            ...partitionCells(aggregate.partition),
            turn: entry.turn,
            surrenders: entry.surrenders,
          })),
        ),
      };

    case 'surrender_phases':
      return {
        columns: [
          ...PARTITION_COLUMNS,
          column('phase', 'Phase', 'identifier'),
          column('surrenders', 'Surrenders', 'count'),
        ],
        rows: surrenders.flatMap((aggregate) =>
          aggregate.phases.map((entry) => ({
            ...partitionCells(aggregate.partition),
            phase: entry.phase,
            surrenders: entry.surrenders,
          })),
        ),
      };

    case 'surrender_state':
      return {
        columns: [
          ...PARTITION_COLUMNS,
          column('total', 'Surrenders', 'count'),
          column('inCombat', 'In combat', 'count'),
          column('reactionWindowOpen', 'Reaction window open', 'count'),
          column('pendingChoiceOpen', 'Pending choice open', 'count'),
          column('pendingChoiceTypes', 'Pending choice types', 'text'),
        ],
        rows: surrenders.map((aggregate) => ({
          ...partitionCells(aggregate.partition),
          total: aggregate.state.total,
          inCombat: aggregate.state.inCombat,
          reactionWindowOpen: aggregate.state.reactionWindowOpen,
          pendingChoiceOpen: aggregate.state.pendingChoiceOpen,
          pendingChoiceTypes: aggregate.state.pendingChoiceTypes
            .map((entry) => `${entry.choiceType}:${String(entry.surrenders)}`)
            .join(', ')
            .slice(0, 200),
        })),
      };

    case 'surrender_exposure_cards':
      return {
        columns: surrenderExposureColumns('Card'),
        rows: surrenders.flatMap((aggregate) =>
          aggregate.exposure.recentCards.map((entry) => surrenderExposureRow(aggregate, entry)),
        ),
      };

    case 'surrender_exposure_events':
      return {
        columns: surrenderExposureColumns('Event type'),
        rows: surrenders.flatMap((aggregate) =>
          aggregate.exposure.recentEventTypes.map((entry) =>
            surrenderExposureRow(aggregate, entry),
          ),
        ),
      };
  }
}

function surrenderExposureColumns(keyLabel: string): readonly ResultColumn[] {
  return [
    ...PARTITION_COLUMNS,
    column('key', keyLabel, 'identifier'),
    column('exposures', 'Exposures', 'count'),
    interval('exposureRate', 'Exposure rate'),
    column('exposureRateGames', 'Surrenders', 'count'),
    column('eventsAgoMean', 'Events ago (mean)', 'number'),
    column('actionsAgoMean', 'Actions ago (mean)', 'number'),
    column('turnsAgoMean', 'Turns ago (mean)', 'number'),
    column('roundsAgoMean', 'Rounds ago (mean)', 'number'),
  ];
}

/**
 * One exposure row — never a whole-match population rate, per
 * `SurrenderProximityEntry`'s own doc comment. `exposureRate` is Wilson-bounded
 * over this partition's own surrenders, so it is never zero-observation the
 * way `spreadRateOrInsufficient`'s guard exists for; a card or event type
 * only appears here because at least one surrender was exposed to it.
 */
function surrenderExposureRow(
  aggregate: LiveMatchSurrenderAggregate,
  entry: LiveMatchSurrenderAggregate['exposure']['recentCards'][number],
): ResultRow {
  return {
    ...partitionCells(aggregate.partition),
    key: entry.key,
    exposures: entry.exposures,
    ...spreadRate('exposureRate', entry.exposureRate),
    eventsAgoMean: entry.eventsAgo.mean,
    actionsAgoMean: entry.actionsAgo.mean,
    turnsAgoMean: entry.turnsAgo.mean,
    roundsAgoMean: entry.roundsAgo.mean,
  };
}

/**
 * The refusal for an answer this service built and could not validate — a
 * defect in the build rather than a problem with the underlying matches,
 * reported the same way `./adaptive-results.ts`'s own `builtBadly` is.
 */
function builtBadly(what: string): AdminError {
  return adminError(
    'admin/schema',
    'This service built a Player Meta result view it could not validate against its own contract, ' +
      'so it was not sent. This is a defect in the build rather than a problem with the underlying matches.',
    { context: { view: what } },
  );
}

/* ---------------------------------------------------------- the HTTP reader */

export interface PlayerMetaResultReaderOptions {
  readonly roots: ResolvedCatalogRoots;
  readonly resultRootId: string;
}

/**
 * The thin HTTP-facing layer for M08.25C's two addresses
 * (`player-meta-summary`, `player-meta-result-table`), reading `readPlayerMetaSummary`/
 * `readPlayerMetaTable` above out of the server's one configured default
 * result root — the same root `AdaptiveResultReader` (`./adaptive-results.ts`)
 * reads its runs under.
 *
 * A Player Meta read has neither a `JobId` nor an `experimentId`-shaped
 * sub-path: the whole configured root *is* the data (every live match a
 * `LiveMatchFileStore` has written there), narrowed only by
 * `playerMetaFilterSchema`. So this resolves `resultRootId` directly against
 * `ResolvedCatalogRoots.resultRoots` rather than through
 * `resolveResultLocation`, which requires a relative `directory` Player Meta
 * has no equivalent for. Per ADR 0023 §5, no request ever names that root —
 * it is a build-time server setting, never a client-supplied field.
 */
export class PlayerMetaResultReader {
  readonly #roots: ResolvedCatalogRoots;
  readonly #resultRootId: string;

  constructor(options: PlayerMetaResultReaderOptions) {
    this.#roots = options.roots;
    this.#resultRootId = options.resultRootId;
  }

  readSummary(filter: PlayerMetaFilter): Result<PlayerMetaRunSummary, readonly AdminError[]> {
    const directory = this.#resolve();
    if (isErr(directory)) return directory;
    return readPlayerMetaSummary(directory.value, filter);
  }

  readTable(
    table: PlayerMetaResultTableName,
    filter: PlayerMetaFilter,
    page: PageRequest,
  ): Result<PlayerMetaResultTable, readonly AdminError[]> {
    const directory = this.#resolve();
    if (isErr(directory)) return directory;
    return readPlayerMetaTable(directory.value, table, filter, page);
  }

  #resolve(): Result<string, readonly AdminError[]> {
    const configured = this.#roots.resultRoots.get(this.#resultRootId);
    if (configured === undefined) {
      return err([
        adminError(
          'admin/unsafe_result_reference',
          `No result root named \`${this.#resultRootId}\` is configured, so Player Meta cannot be read.`,
          { path: 'resultRootId', context: { rootId: this.#resultRootId } },
        ),
      ]);
    }
    return ok(configured);
  }
}
