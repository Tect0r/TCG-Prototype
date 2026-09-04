import {
  adminError,
  cardExplorerViewSchema,
  CARD_EXPLORER_MAX_CONTRIBUTING_DECKS,
  CARD_EXPLORER_MAX_CONTRIBUTING_MATCHES,
  PAGE_SIZE_MAX,
  type AdminError,
  type CardExplorerContributingDeck,
  type CardExplorerContributingMatch,
  type CardExplorerExperimentEvidence,
  type CardExplorerInclusion,
  type CardExplorerPartner,
  type CardExplorerRequest,
  type CardExplorerUnavailablePartition,
  type CardExplorerView,
  type JobId,
  type ResultRow,
} from '@tcg/admin-contracts';
import { err, isErr, ok, type Result } from '@tcg/shared';
import {
  aggregateLiveCardEvidence,
  currentLiveMatchCardDatabases,
  readLiveMatchEnvelopes,
  type LiveCardEvidence,
  type LiveMatchAggregatePartition,
} from '@tcg/simulator';

import { type ResolvedCatalogRoots } from '../catalog/roots.js';
import type { CatalogStore } from '../catalog/store.js';
import { ResultReader } from './results.js';

/**
 * M08.26C — the Card Explorer read model. See `card-explorer.ts`
 * (`@tcg/admin-contracts`) for the full design rationale — this file is the
 * thin execution of that design: read raw live-match envelopes and one
 * named job's `'cards'` table, reduce them to `CardExplorerView`, never a
 * second copy of `aggregateLiveCardEvidence`'s own arithmetic.
 */

type LiveMatchEnvelope = ReturnType<typeof readLiveMatchEnvelopes>['matches'][number];

function liveMatchEvidenceOfPartition(partition: LiveMatchAggregatePartition) {
  return {
    realm: 'live_match' as const,
    source: partition.source,
    contentVersion: partition.contentVersion,
    rulesVersion: partition.rulesVersion,
  };
}

function liveMatchEvidenceOfMatch(match: LiveMatchEnvelope) {
  return {
    realm: 'live_match' as const,
    source: match.source,
    contentVersion: match.provenance.contentVersion,
    rulesVersion: match.provenance.rulesVersion,
  };
}

function inclusionsAndPartnersOf(
  cardId: string,
  cardEvidence: readonly LiveCardEvidence[],
): {
  inclusions: CardExplorerInclusion[];
  partners: CardExplorerPartner[];
  unavailablePartitions: CardExplorerUnavailablePartition[];
} {
  const inclusions: CardExplorerInclusion[] = [];
  const partners: CardExplorerPartner[] = [];
  const unavailablePartitions: CardExplorerUnavailablePartition[] = [];

  for (const entry of cardEvidence) {
    const observedIn = liveMatchEvidenceOfPartition(entry.partition);

    if (entry.commanders === null) {
      unavailablePartitions.push({
        observedIn,
        reason: entry.unavailableReason ?? 'This partition has no card database for its content version.',
      });
      continue;
    }

    for (const commander of entry.commanders) {
      const card = commander.cards.find((candidate) => candidate.cardId === cardId);
      if (card !== undefined) {
        inclusions.push({
          commanderId: commander.commanderId,
          status: card.status,
          commanderMatches: commander.commanderMatches,
          matchesIncluding: card.matchesIncluding,
          inclusion: card.inclusion,
          uniqueDecks: commander.uniqueDecks,
          decksIncluding: card.decksIncluding,
          inclusionByUniqueDeck: card.inclusionByUniqueDeck,
          observedIn,
        });
      }

      for (const pair of commander.pairs) {
        if (pair.cardIdA !== cardId && pair.cardIdB !== cardId) continue;
        const partnerCardId = pair.cardIdA === cardId ? pair.cardIdB : pair.cardIdA;
        partners.push({
          commanderId: commander.commanderId,
          partnerCardId,
          matchesIncludingBoth: pair.matchesIncludingBoth,
          support: pair.support,
          decksIncludingBoth: pair.decksIncludingBoth,
          supportByUniqueDeck: pair.supportByUniqueDeck,
          observedIn,
        });
      }
    }
  }

  return { inclusions, partners, unavailablePartitions };
}

function contributingOf(
  cardId: string,
  matches: readonly LiveMatchEnvelope[],
): {
  contributingDecks: CardExplorerContributingDeck[];
  contributingMatches: CardExplorerContributingMatch[];
} {
  const sorted = [...matches].sort((left, right) => (left.matchId < right.matchId ? -1 : 1));

  const contributingMatches: CardExplorerContributingMatch[] = [];
  const contributingDecks: CardExplorerContributingDeck[] = [];
  const seenDecks = new Set<string>();

  for (const match of sorted) {
    for (const seat of match.seats) {
      if (!seat.deck.cards.some((entry) => entry.cardId === cardId)) continue;
      const observedIn = liveMatchEvidenceOfMatch(match);

      if (contributingMatches.length < CARD_EXPLORER_MAX_CONTRIBUTING_MATCHES) {
        contributingMatches.push({
          matchId: match.matchId,
          deckHash: seat.deck.deckHash,
          commanderId: seat.deck.commanderId,
          observedIn,
        });
      }

      if (
        !seenDecks.has(seat.deck.deckHash) &&
        contributingDecks.length < CARD_EXPLORER_MAX_CONTRIBUTING_DECKS
      ) {
        seenDecks.add(seat.deck.deckHash);
        contributingDecks.push({
          deckHash: seat.deck.deckHash,
          commanderId: seat.deck.commanderId,
          observedIn,
        });
      }
    }
  }

  return { contributingDecks, contributingMatches };
}

async function findExperimentEvidence(
  results: ResultReader,
  jobId: JobId,
  cardId: string,
): Promise<Result<CardExplorerExperimentEvidence, readonly AdminError[]>> {
  const provenance = await results.readProvenance(jobId);
  if (isErr(provenance)) return provenance;

  let row: ResultRow | null = null;
  let cursor: string | null = null;

  for (;;) {
    const page = await results.readTable(jobId, 'cards', { limit: PAGE_SIZE_MAX, cursor });
    if (isErr(page)) return page;

    const found = page.value.rows.find((candidate) => candidate.definitionId === cardId);
    if (found !== undefined) {
      row = found;
      break;
    }

    cursor = page.value.page.nextCursor;
    if (cursor === null) break;
  }

  return ok({
    jobId,
    row,
    observedIn: {
      realm: 'experiment',
      sourceClasses: [...provenance.value.sourceClasses],
      environment: provenance.value.environment,
    },
  });
}

async function readCardExplorerView(
  rootDirectory: string,
  results: ResultReader,
  request: CardExplorerRequest,
): Promise<Result<CardExplorerView, readonly AdminError[]>> {
  const read = readLiveMatchEnvelopes(rootDirectory);
  const databases = currentLiveMatchCardDatabases(read.matches);
  const cardEvidence = aggregateLiveCardEvidence(read.matches, {
    cardDatabasesByContentVersion: databases,
  });

  const { inclusions, partners, unavailablePartitions } = inclusionsAndPartnersOf(
    request.cardId,
    cardEvidence,
  );
  const { contributingDecks, contributingMatches } = contributingOf(request.cardId, read.matches);

  let experimentEvidence: CardExplorerExperimentEvidence | null = null;
  if (request.jobId !== null) {
    const found = await findExperimentEvidence(results, request.jobId, request.cardId);
    if (isErr(found)) return found;
    experimentEvidence = found.value;
  }

  const parsed = cardExplorerViewSchema.safeParse({
    cardId: request.cardId,
    inclusions,
    partners,
    unavailablePartitions,
    experimentEvidence,
    contributingDecks,
    contributingMatches,
  });
  if (!parsed.success) return err([builtBadly('card-explorer-view')]);
  return ok(parsed.data);
}

/* ---------------------------------------------------------- the HTTP reader */

export interface CardExplorerReaderOptions {
  readonly roots: ResolvedCatalogRoots;
  readonly resultRootId: string;
  readonly store: CatalogStore;
}

/**
 * The thin HTTP-facing layer for M08.26C's `card-explorer-view` address,
 * reading live-match evidence out of the server's one configured default
 * result root (the same root `PlayerMetaResultReader` and
 * `DeckExplorerReader` read, for the same reason: a card's eligible-inclusion
 * evidence has no `JobId` of its own) and, when a caller names one,
 * draw/play/dead-hand evidence out of a `ResultReader` over that named job.
 */
export class CardExplorerReader {
  readonly #roots: ResolvedCatalogRoots;
  readonly #resultRootId: string;
  readonly #results: ResultReader;

  constructor(options: CardExplorerReaderOptions) {
    this.#roots = options.roots;
    this.#resultRootId = options.resultRootId;
    this.#results = new ResultReader({ store: options.store, roots: options.roots });
  }

  async readView(
    request: CardExplorerRequest,
  ): Promise<Result<CardExplorerView, readonly AdminError[]>> {
    const directory = this.#resolve();
    if (isErr(directory)) return directory;
    return readCardExplorerView(directory.value, this.#results, request);
  }

  #resolve(): Result<string, readonly AdminError[]> {
    const configured = this.#roots.resultRoots.get(this.#resultRootId);
    if (configured === undefined) {
      return err([
        adminError(
          'admin/unsafe_result_reference',
          `No result root named \`${this.#resultRootId}\` is configured, so the Card Explorer cannot be read.`,
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
    'This service built a Card Explorer view it could not validate against its own contract, ' +
      'so it was not sent. This is a defect in the build rather than a problem with the underlying matches.',
    { context: { view: what } },
  );
}
