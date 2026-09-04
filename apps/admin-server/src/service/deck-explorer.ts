import {
  adminError,
  deckExplorerViewSchema,
  type AdaptiveExperimentId,
  type AdminError,
  type DeckExplorerRequest,
  type DeckExplorerRevision,
  type DeckExplorerView,
  type ResultRow,
} from '@tcg/admin-contracts';
import { err, isErr, ok, type Result } from '@tcg/shared';
import { filterLiveMatches, readLiveMatchEnvelopes } from '@tcg/simulator';

import { type ResolvedCatalogRoots } from '../catalog/roots.js';
import { AdaptiveResultReader } from './adaptive-results.js';

/**
 * M08.26B — the Deck Explorer read model: directory-in, pure, matching the
 * split `./adaptive-results.ts` and `./player-meta-results.ts` already draw.
 *
 * A deck's **identity** — Commander plus card list — is never generated or
 * assembled here. It is read off the one lowest-`matchId` live-match envelope
 * `filterLiveMatches` finds carrying the requested hash, exactly as
 * `deckFingerprint` guarantees (`@tcg/deck`): any two occurrences of the same
 * `deckHash` are byte-identical, so one observed seat is exact, not a sample.
 * "Lowest `matchId`" is a deterministic anchor for *this* narrow read only —
 * the general representative-match-selection framework is M08.26E's, not
 * reused or pre-empted here.
 *
 * A deck's **known revisions** are a cross-check against one named Adaptive
 * Counter experiment, reusing `AdaptiveResultReader.readTable`'s existing
 * `'revisions'` table (`./adaptive-results.ts`) rather than a second reader of
 * `adaptive-result.json`, per ADR 0023 §2. `knownRevisions` stays `null` when
 * no `adaptiveExperimentId` was named — nothing was checked — and becomes `[]`
 * only once a named experiment's table was read and held no matching row. If
 * the named experiment's run cannot be read at all, the whole request fails
 * rather than silently reporting either `null` or `[]` in its place
 * (`CLAUDE.md`'s "never silently invent unresolved rules").
 *
 * Everything the milestone also asks for — matches, matchup split, cluster,
 * separated AI/human evidence — is already answered by the existing
 * `player-meta-result-table` endpoint with `filter.deckHashes` narrowed to
 * one hash (`playerMetaFilterSchema`, M08.25A); none of it is restated here.
 */

const DECK_EXPLORER_REVISION_TABLE = 'revisions';

/**
 * `@tcg/simulator` does not re-export `LiveMatchEnvelope` itself (only the
 * functions that produce and filter it) — `apps/admin-server` must not depend
 * on `@tcg/match-telemetry` directly (`./player-meta-results.ts`'s own doc
 * comment), so the shape is derived from `readLiveMatchEnvelopes`'s own return
 * type rather than named from its owning package.
 */
type LiveMatchEnvelope = ReturnType<typeof readLiveMatchEnvelopes>['matches'][number];

/** The one live-match occurrence this deck's identity is read off, or `null` if none was found. */
function findDeckExplorerMatch(
  rootDirectory: string,
  deckHash: string,
): { readonly match: LiveMatchEnvelope; readonly seat: LiveMatchEnvelope['seats'][number] } | null {
  const { matches } = readLiveMatchEnvelopes(rootDirectory);
  const filtered = filterLiveMatches(matches, { deckHashes: [deckHash] });

  let chosen: LiveMatchEnvelope | null = null;
  for (const match of filtered) {
    if (chosen === null || match.matchId < chosen.matchId) chosen = match;
  }
  if (chosen === null) return null;

  const seat = chosen.seats.find((candidate) => candidate.deck.deckHash === deckHash);
  if (seat === undefined) return null;
  return { match: chosen, seat };
}

function readDeckExplorerIdentity(
  rootDirectory: string,
  deckHash: string,
): DeckExplorerView['identity'] {
  const found = findDeckExplorerMatch(rootDirectory, deckHash);
  if (found === null) return null;

  return {
    commanderId: found.seat.deck.commanderId,
    cards: found.seat.deck.cards.map((entry) => ({
      cardId: entry.cardId,
      quantity: entry.quantity,
    })),
    observedIn: {
      realm: 'live_match',
      source: found.match.source,
      contentVersion: found.match.provenance.contentVersion,
      rulesVersion: found.match.provenance.rulesVersion,
    },
  };
}

/** Reads one `'revisions'` row into the restated shape, coercing permissively — `deckExplorerViewSchema` is the safety net. */
function revisionOf(row: ResultRow): DeckExplorerRevision {
  return {
    side: row.side === 'opponent' ? 'opponent' : 'incumbent',
    revisionId: String(row.revisionId ?? ''),
    parentRevisionId:
      row.parentRevisionId === null || row.parentRevisionId === undefined
        ? null
        : String(row.parentRevisionId),
    generation: Number(row.generation ?? 0),
    block: Number(row.block ?? 0),
    opponentRevisionId:
      row.opponentRevisionId === null || row.opponentRevisionId === undefined
        ? null
        : String(row.opponentRevisionId),
    construction:
      row.construction === 'swap' ? 'swap' : row.construction === 'rebuild' ? 'rebuild' : 'root',
    swapCount: Number(row.swapCount ?? 0),
  };
}

/** Pages the named experiment's `'revisions'` table, collecting rows for `deckHash`. Fails the whole request if the run cannot be read. */
async function findKnownRevisions(
  adaptive: AdaptiveResultReader,
  experimentId: AdaptiveExperimentId,
  deckHash: string,
): Promise<Result<DeckExplorerRevision[], readonly AdminError[]>> {
  const found: DeckExplorerRevision[] = [];
  let cursor: string | null = null;

  for (;;) {
    const page = await adaptive.readTable(experimentId, DECK_EXPLORER_REVISION_TABLE, {
      limit: 200,
      cursor,
    });
    if (isErr(page)) return page;

    for (const row of page.value.rows) {
      if (typeof row.deckHash === 'string' && row.deckHash === deckHash)
        found.push(revisionOf(row));
    }

    cursor = page.value.page.nextCursor;
    if (cursor === null) break;
  }

  return ok(found);
}

async function readDeckExplorerView(
  rootDirectory: string,
  adaptive: AdaptiveResultReader,
  request: DeckExplorerRequest,
): Promise<Result<DeckExplorerView, readonly AdminError[]>> {
  const identity = readDeckExplorerIdentity(rootDirectory, request.deckHash);

  let knownRevisions: DeckExplorerView['knownRevisions'] = null;
  if (request.adaptiveExperimentId !== null) {
    const revisions = await findKnownRevisions(
      adaptive,
      request.adaptiveExperimentId,
      request.deckHash,
    );
    if (isErr(revisions)) return revisions;
    knownRevisions = revisions.value;
  }

  const parsed = deckExplorerViewSchema.safeParse({
    deckHash: request.deckHash,
    identity,
    knownRevisions,
  });
  if (!parsed.success) return err([builtBadly('deck-explorer-view')]);
  return ok(parsed.data);
}

/* ---------------------------------------------------------- the HTTP reader */

export interface DeckExplorerReaderOptions {
  readonly roots: ResolvedCatalogRoots;
  readonly resultRootId: string;
}

/**
 * The thin HTTP-facing layer for M08.26B's `deck-explorer-view` address,
 * reading live-match identity out of the server's one configured default
 * result root (the same root `PlayerMetaResultReader` reads, resolved the
 * same way, for the same reason: a deck's identity has neither a `JobId` nor
 * an `experimentId`-shaped sub-path) and, when a caller names one, revision
 * lineage out of an `AdaptiveResultReader` over that same named experiment.
 */
export class DeckExplorerReader {
  readonly #roots: ResolvedCatalogRoots;
  readonly #resultRootId: string;
  readonly #adaptive: AdaptiveResultReader;

  constructor(options: DeckExplorerReaderOptions) {
    this.#roots = options.roots;
    this.#resultRootId = options.resultRootId;
    this.#adaptive = new AdaptiveResultReader(options);
  }

  async readView(
    request: DeckExplorerRequest,
  ): Promise<Result<DeckExplorerView, readonly AdminError[]>> {
    const directory = this.#resolve();
    if (isErr(directory)) return directory;
    return readDeckExplorerView(directory.value, this.#adaptive, request);
  }

  #resolve(): Result<string, readonly AdminError[]> {
    const configured = this.#roots.resultRoots.get(this.#resultRootId);
    if (configured === undefined) {
      return err([
        adminError(
          'admin/unsafe_result_reference',
          `No result root named \`${this.#resultRootId}\` is configured, so the Deck Explorer cannot be read.`,
          { path: 'resultRootId', context: { rootId: this.#resultRootId } },
        ),
      ]);
    }
    return ok(configured);
  }
}

function builtBadly(what: string): AdminError {
  return adminError(
    'admin/schema',
    'This service built a Deck Explorer view it could not validate against its own contract, ' +
      'so it was not sent. This is a defect in the build rather than a problem with the underlying matches.',
    { context: { view: what } },
  );
}
