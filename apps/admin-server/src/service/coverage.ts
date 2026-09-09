import {
  CardDatabase,
  MECHANIC_SUPPORT_LIST,
  isColorIdentityLegal,
  mechanicKey,
  mechanicsUsedBy,
  type CardDefinition,
} from '@tcg/card-data';
import {
  NO_PLAYER_META_FILTER,
  PAGE_SIZE_MAX,
  adminError,
  catalogCoverageReportSchema,
  playerMetaCoverageReportSchema,
  type AdminError,
  type CatalogCardCoverage,
  type CatalogCoverageReport,
  type CatalogMechanicCoverage,
  type JobId,
  type PlayerMetaCardCoverage,
  type PlayerMetaCoverageReport,
  type PlayerMetaPartition,
  type ResultCell,
  type ResultRow,
} from '@tcg/admin-contracts';
import { err, isErr, ok, type Result } from '@tcg/shared';

import type { PlayerMetaResultReader } from './player-meta-results.js';
import type { ResultReader } from './results.js';

/**
 * M08.27C — computing the reports `packages/admin-contracts/src/coverage.ts`
 * transports. See that file's doc comment for the scope decisions this module
 * carries out rather than re-deciding: `target` deferred, the mechanic
 * vocabulary drawn from `@tcg/card-data`'s support registry, and the
 * catalog/player_meta split.
 *
 * ## Catalog domain
 *
 * The vocabulary is the run's own resolved environment
 * (`ResultReader.readResolvedEnvironment`) — `poolCardIds` for the six
 * card-level stages, `poolCardIds` plus `commanderCardIds` for the mechanic
 * tally, since a Commander can carry a mechanic no pool card does. `eligibility`
 * is computed independently of `cards` table rows, against every Commander the
 * environment names, because a card absent from every deck (M08.12's own gap)
 * is exactly the case this file exists to answer honestly rather than skip.
 *
 * `inclusion`/`draw`/`play`/`activation`/`trigger` read the `cards` table
 * (`ResultReader.readTable`) rather than the summary directly, the same way
 * `./comparison-deltas.ts` reads every catalog source — nothing here opens
 * `summary.json` a second, private way. A card with a row is guaranteed
 * `decksIncluding > 0` (M08.12's own seeding rule), so `inclusion` is `reached`
 * whenever a row exists at all; a card with no row is `not_reached` on all
 * five, never `unavailable` — the row's very absence *is* the measurement.
 *
 * A mechanic's `status` is coarser than a card's: no telemetry counter is
 * scoped to one mechanic ID, so this file can only ask "was any card carrying
 * this mechanic ever played this run" — `reached` when at least one user card
 * has a `cards` row, `not_reached` when every user card is rowless,
 * `unavailable` when `telemetry` support is `'none'` or no card in the
 * vocabulary carries the mechanic at all. This is a real limit, not an
 * oversight: it says a mechanic's *cards* were in play, not that the mechanic
 * itself fired, because no counter here counts that.
 *
 * ## Player Meta domain
 *
 * `observation` reads `PlayerMetaResultReader.readCardEvidence` —
 * `LiveCardEvidence`, already eligibility-aware per-Commander
 * (`aggregateLiveCardEvidence`, M08.24B). A card is `reached` when any
 * Commander this partition saw played actually included it (`status: 'played'`
 * for at least one `CommanderCardEvidence`); otherwise `not_reached`, whether
 * the reason is "never included" (`'held'`) or "off-colour everywhere"
 * (`'unusable'`) — both are genuine, measurable negatives, not data gaps.
 */

function numberCell(value: ResultCell | undefined): number {
  return typeof value === 'number' ? value : 0;
}

function stringCell(value: ResultCell | undefined): string {
  return typeof value === 'string' ? value : '';
}

function builtBadly(view: string, context: Readonly<Record<string, unknown>>): AdminError {
  return adminError(
    'admin/schema',
    'This service built a coverage report it could not validate against its own contract, so it was ' +
      'not sent. This is a defect in the build rather than a problem with the run.',
    { context: { ...context, view } },
  );
}

async function readAllCardRows(
  reader: ResultReader,
  jobId: JobId,
): Promise<Result<readonly ResultRow[], readonly AdminError[]>> {
  let cursor: string | null = null;
  const rows: ResultRow[] = [];
  for (;;) {
    const page = await reader.readTable(jobId, 'cards', { limit: PAGE_SIZE_MAX, cursor });
    if (isErr(page)) return page;
    rows.push(...page.value.rows);
    if (page.value.page.nextCursor === null) break;
    cursor = page.value.page.nextCursor;
  }
  return ok(rows);
}

/** One run's whole card and mechanic vocabulary, across every stage this build can genuinely measure. */
export async function computeCatalogCoverage(
  reader: ResultReader,
  jobId: JobId,
): Promise<Result<CatalogCoverageReport, readonly AdminError[]>> {
  const environment = await reader.readResolvedEnvironment(jobId);
  if (isErr(environment)) {
    const report: CatalogCoverageReport = {
      identity: { domain: 'catalog', jobId },
      cards: [],
      mechanics: [],
      unavailableReason:
        'This run has no readable resolved environment snapshot, so its whole card and mechanic ' +
        `vocabulary could not be measured: ${environment.error.map((problem) => problem.message).join(' ')}`,
    };
    const validated = catalogCoverageReportSchema.safeParse(report);
    if (!validated.success) return err([builtBadly('catalog_coverage', { jobId })]);
    return ok(validated.data);
  }

  const rows = await readAllCardRows(reader, jobId);
  if (isErr(rows)) return rows;

  const database = new CardDatabase(environment.value.cards);
  const commanders = environment.value.commanderCardIds
    .map((id) => database.get(id))
    .filter((card): card is CardDefinition => card !== undefined);
  const rowsById = new Map(rows.value.map((row) => [stringCell(row.definitionId), row] as const));

  const cards: CatalogCardCoverage[] = [];
  const playedCardIds = new Set<string>();
  for (const cardId of environment.value.poolCardIds) {
    const card = database.get(cardId);
    if (card === undefined) continue;

    const row = rowsById.get(cardId);
    const reached = row !== undefined;
    if (reached) playedCardIds.add(cardId);

    const eligible = commanders.some((commander) =>
      isColorIdentityLegal(card.colorIdentity, commander.colorIdentity),
    );

    cards.push({
      cardId,
      eligibility: eligible ? 'reached' : 'not_reached',
      inclusion: reached ? 'reached' : 'not_reached',
      draw: reached && numberCell(row?.gamesDrawn) > 0 ? 'reached' : 'not_reached',
      play: reached && numberCell(row?.playsPerDraw) > 0 ? 'reached' : 'not_reached',
      activation: reached && numberCell(row?.activationsPerMatch) > 0 ? 'reached' : 'not_reached',
      trigger: reached && numberCell(row?.averageTriggers) > 0 ? 'reached' : 'not_reached',
      unavailableReasons: {},
    });
  }

  const vocabularyCards = [...environment.value.poolCardIds, ...environment.value.commanderCardIds]
    .map((id) => database.get(id))
    .filter((card): card is CardDefinition => card !== undefined);

  const usageCounts = new Map<string, number>();
  const usersByMechanic = new Map<string, Set<string>>();
  for (const card of vocabularyCards) {
    for (const ref of mechanicsUsedBy(card)) {
      const key = mechanicKey(ref);
      usageCounts.set(key, (usageCounts.get(key) ?? 0) + 1);
      const users = usersByMechanic.get(key) ?? new Set<string>();
      users.add(card.id);
      usersByMechanic.set(key, users);
    }
  }

  const mechanics: CatalogMechanicCoverage[] = MECHANIC_SUPPORT_LIST.map(
    (entry): CatalogMechanicCoverage => {
      const key = mechanicKey(entry);
      const cardsUsing = usageCounts.get(key) ?? 0;

      if (entry.telemetry === 'none') {
        return {
          kind: entry.kind,
          id: entry.id,
          mechanicKey: key,
          cardsUsing,
          status: 'unavailable',
          unavailableReason: `No telemetry counter observes this mechanic (${entry.where}).`,
        };
      }
      if (cardsUsing === 0) {
        return {
          kind: entry.kind,
          id: entry.id,
          mechanicKey: key,
          cardsUsing,
          status: 'unavailable',
          unavailableReason:
            "No card in this run's vocabulary uses this mechanic, so there is nothing to observe.",
        };
      }

      const users = usersByMechanic.get(key) ?? new Set<string>();
      const played = [...users].some((cardId) => playedCardIds.has(cardId));
      return {
        kind: entry.kind,
        id: entry.id,
        mechanicKey: key,
        cardsUsing,
        status: played ? 'reached' : 'not_reached',
        unavailableReason: null,
      };
    },
  );

  const report: CatalogCoverageReport = {
    identity: { domain: 'catalog', jobId },
    cards,
    mechanics,
    unavailableReason: null,
  };
  const validated = catalogCoverageReportSchema.safeParse(report);
  if (!validated.success) return err([builtBadly('catalog_coverage', { jobId })]);
  return ok(validated.data);
}

/** One Player Meta partition's card observation coverage. */
export function computePlayerMetaCoverage(
  reader: PlayerMetaResultReader,
  partition: PlayerMetaPartition,
): Result<PlayerMetaCoverageReport, readonly AdminError[]> {
  const filter = {
    ...NO_PLAYER_META_FILTER,
    sources: [partition.source],
    contentVersions: [partition.contentVersion],
  };
  const evidence = reader.readCardEvidence(filter);
  if (isErr(evidence)) return evidence;

  const entry = evidence.value.find(
    (item) =>
      item.partition.source === partition.source &&
      item.partition.contentVersion === partition.contentVersion &&
      item.partition.rulesVersion === partition.rulesVersion,
  );

  if (entry === undefined || entry.commanders === null) {
    const report: PlayerMetaCoverageReport = {
      identity: { domain: 'player_meta', partition },
      cards: [],
      unavailableReason:
        entry?.unavailableReason ??
        'No live match in this Player Meta root matches this partition, so there is nothing to measure.',
    };
    return validatePlayerMeta(report);
  }

  const reachedByCard = new Map<string, boolean>();
  for (const commander of entry.commanders) {
    for (const cardEntry of commander.cards) {
      const already = reachedByCard.get(cardEntry.cardId) ?? false;
      reachedByCard.set(cardEntry.cardId, already || cardEntry.status === 'played');
    }
  }

  const cards: PlayerMetaCardCoverage[] = [...reachedByCard.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([cardId, reached]) => ({
      cardId,
      observation: reached ? 'reached' : 'not_reached',
      unavailableReason: null,
    }));

  return validatePlayerMeta({
    identity: { domain: 'player_meta', partition },
    cards,
    unavailableReason: null,
  });
}

function validatePlayerMeta(
  report: PlayerMetaCoverageReport,
): Result<PlayerMetaCoverageReport, readonly AdminError[]> {
  const validated = playerMetaCoverageReportSchema.safeParse(report);
  if (!validated.success) return err([builtBadly('player_meta_coverage', {})]);
  return ok(validated.data);
}
