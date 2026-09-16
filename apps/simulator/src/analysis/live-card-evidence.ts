import { isColorIdentityLegal, type CardDatabase } from '@tcg/card-data';
import type { LiveMatchEnvelope } from '@tcg/match-telemetry';

import {
  cardDatabaseUnavailableReason,
  partitionLiveMatches,
  type LiveMatchAggregatePartition,
} from './live-match-aggregate.js';
import { round } from './stats.js';

/**
 * M08.24B — eligibility-aware card evidence over live matches.
 *
 * Lives beside `./live-match-aggregate.ts` (M08.24A) and shares its own
 * partitioning (`partitionLiveMatches`), so the two views can never disagree
 * about what counts as one `(source, contentVersion, rulesVersion)` bucket.
 * Pure, in-memory reduction over `readonly LiveMatchEnvelope[]` — no file
 * enumeration, no config root, no HTTP address — following M08.24A's own
 * "computation now, execution-shaped wiring later" split.
 *
 * A card's Commander legality (`@tcg/card-data`'s `isColorIdentityLegal`) is
 * checked against every Commander a partition actually saw played, over that
 * Commander's *entire* deckable pool (`CardDatabase.deckable()`) — not merely
 * the cards some deck happened to include. That is the whole point of this
 * slice: a card that is off-colour for a Commander is **structurally**
 * unavailable to it, which is a fact about the card and the Commander, not a
 * fact about what testers chose. Reporting it as "0% included" would silently
 * misdescribe an impossibility as a rejection, so `status: 'unusable'` and a
 * `null` inclusion rate are reported instead — a legal card nobody ever
 * included is `'held'`, and a legal card at least one seat included is
 * `'played'`; only those two are ever compared against each other as
 * selection evidence.
 *
 * M08.24C — honest weighting and denominators. Every inclusion/support count
 * below is reported twice: match-weighted (`matchesIncluding`/`support`, one
 * seat-appearance is one observation — a repeatedly-grinded deck dominates
 * this) and unique-deck-weighted (`decksIncluding`/`supportByUniqueDeck`, one
 * distinct built deck is one observation, counted once no matter how many
 * matches it played). There is deliberately no player-weighted count, for
 * the same "no stable cross-match player identity" reason
 * `./live-match-aggregate.ts` documents. Decks are assumed already
 * legal-built (the deck builder and match creation both validate Commander
 * colour identity before a match can start), so this module does not
 * special-case a deck that manages to include a structurally unusable card.
 */

export type CardEligibilityStatus = 'played' | 'held' | 'unusable';

export interface CardEligibilityEntry {
  readonly cardId: string;
  readonly status: CardEligibilityStatus;
  /** Seat-appearances under this Commander whose deck included the card. Always 0 for `'unusable'` under normal play. */
  readonly matchesIncluding: number;
  /**
   * `matchesIncluding / commanderMatches`, rounded. `null` exactly when
   * `status` is `'unusable'` — a structurally ineligible card has no honest
   * selection rate to report, so this is never `0` for one, per this
   * module's own "never treat structural ineligibility as non-selection"
   * requirement.
   */
  readonly inclusion: number | null;
  /** Distinct decks under this Commander that included the card. Always 0 for `'unusable'` under normal play. */
  readonly decksIncluding: number;
  /** `decksIncluding / uniqueDecks`, rounded. `null` under the same `'unusable'` rule as `inclusion`. */
  readonly inclusionByUniqueDeck: number | null;
}

export interface CardPairEntry {
  readonly cardIdA: string;
  readonly cardIdB: string;
  /** Seat-appearances under this Commander whose deck included both cards. Always > 0 — pairs that never co-occurred are not reported. */
  readonly matchesIncludingBoth: number;
  /** `matchesIncludingBoth / commanderMatches`, rounded. */
  readonly support: number;
  /** Distinct decks under this Commander that included both cards. Always > 0, same reporting rule as `matchesIncludingBoth`. */
  readonly decksIncludingBoth: number;
  /** `decksIncludingBoth / uniqueDecks`, rounded. */
  readonly supportByUniqueDeck: number;
}

export interface CommanderCardEvidence {
  readonly commanderId: string;
  /** Seat-appearances of this Commander in this partition — the match-weighted denominator for every card and pair below. */
  readonly commanderMatches: number;
  /** Distinct decks built for this Commander in this partition — the unique-deck-weighted denominator for every card and pair below. */
  readonly uniqueDecks: number;
  /** Every card in this Commander's deckable pool (`CardDatabase.deckable()`), sorted by `cardId`. */
  readonly cards: readonly CardEligibilityEntry[];
  /** Only pairs that actually co-occurred in at least one seat's deck, sorted by `cardIdA` then `cardIdB`. */
  readonly pairs: readonly CardPairEntry[];
}

export interface LiveCardEvidence {
  readonly partition: LiveMatchAggregatePartition;
  /** One entry per Commander this partition actually saw played, sorted by `commanderId`. `null` exactly when no database was supplied for this partition's `contentVersion`. */
  readonly commanders: readonly CommanderCardEvidence[] | null;
  readonly unavailableReason: string | null;
}

export interface LiveCardEvidenceOptions {
  /** Same map `aggregateLiveMatches` takes: a card database per `provenance.contentVersion`. */
  readonly cardDatabasesByContentVersion?: ReadonlyMap<number, CardDatabase>;
}

/** Aggregates eligibility-aware card and pair evidence into one entry per `(source, contentVersion, rulesVersion)` partition. */
export function aggregateLiveCardEvidence(
  matches: readonly LiveMatchEnvelope[],
  options: LiveCardEvidenceOptions = {},
): readonly LiveCardEvidence[] {
  const databases = options.cardDatabasesByContentVersion ?? new Map<number, CardDatabase>();

  return partitionLiveMatches(matches).map(({ partition, matches: group }) => {
    const database = databases.get(partition.contentVersion);
    if (database === undefined) {
      return {
        partition,
        commanders: null,
        unavailableReason: cardDatabaseUnavailableReason(
          partition.contentVersion,
          'card evidence for this partition was not computed.',
        ),
      };
    }
    return { partition, commanders: commanderEvidence(group, database), unavailableReason: null };
  });
}

function pairKey(cardIdA: string, cardIdB: string): string {
  return `${cardIdA} ${cardIdB}`;
}

function commanderEvidence(
  group: readonly LiveMatchEnvelope[],
  database: CardDatabase,
): readonly CommanderCardEvidence[] {
  const commanderMatches = new Map<string, number>();
  const commanderDeckHashes = new Map<string, Set<string>>();
  const inclusionByCommander = new Map<string, Map<string, number>>();
  const deckInclusionByCommander = new Map<string, Map<string, number>>();
  const pairsByCommander = new Map<string, Map<string, number>>();
  const deckPairsByCommander = new Map<string, Map<string, number>>();

  for (const match of group) {
    for (const seat of match.seats) {
      const commanderId = seat.deck.commanderId;
      commanderMatches.set(commanderId, (commanderMatches.get(commanderId) ?? 0) + 1);

      let deckHashes = commanderDeckHashes.get(commanderId);
      if (!deckHashes) {
        deckHashes = new Set();
        commanderDeckHashes.set(commanderId, deckHashes);
      }
      const isNewDeck = !deckHashes.has(seat.deck.deckHash);
      if (isNewDeck) deckHashes.add(seat.deck.deckHash);

      const cardIds = [...new Set(seat.deck.cards.map((entry) => entry.cardId))].sort();

      let inclusion = inclusionByCommander.get(commanderId);
      if (!inclusion) {
        inclusion = new Map();
        inclusionByCommander.set(commanderId, inclusion);
      }
      for (const cardId of cardIds) inclusion.set(cardId, (inclusion.get(cardId) ?? 0) + 1);

      let pairs = pairsByCommander.get(commanderId);
      if (!pairs) {
        pairs = new Map();
        pairsByCommander.set(commanderId, pairs);
      }
      for (let i = 0; i < cardIds.length; i += 1) {
        for (let j = i + 1; j < cardIds.length; j += 1) {
          const key = pairKey(cardIds[i] as string, cardIds[j] as string);
          pairs.set(key, (pairs.get(key) ?? 0) + 1);
        }
      }

      if (isNewDeck) {
        let deckInclusion = deckInclusionByCommander.get(commanderId);
        if (!deckInclusion) {
          deckInclusion = new Map();
          deckInclusionByCommander.set(commanderId, deckInclusion);
        }
        for (const cardId of cardIds)
          deckInclusion.set(cardId, (deckInclusion.get(cardId) ?? 0) + 1);

        let deckPairs = deckPairsByCommander.get(commanderId);
        if (!deckPairs) {
          deckPairs = new Map();
          deckPairsByCommander.set(commanderId, deckPairs);
        }
        for (let i = 0; i < cardIds.length; i += 1) {
          for (let j = i + 1; j < cardIds.length; j += 1) {
            const key = pairKey(cardIds[i] as string, cardIds[j] as string);
            deckPairs.set(key, (deckPairs.get(key) ?? 0) + 1);
          }
        }
      }
    }
  }

  const pool = database.deckable();

  return [...commanderMatches]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([commanderId, matches]): CommanderCardEvidence => {
      const commanderColorIdentity = database.get(commanderId)?.colorIdentity ?? [];
      const inclusion = inclusionByCommander.get(commanderId) ?? new Map<string, number>();
      const deckInclusion = deckInclusionByCommander.get(commanderId) ?? new Map<string, number>();
      const pairs = pairsByCommander.get(commanderId) ?? new Map<string, number>();
      const deckPairs = deckPairsByCommander.get(commanderId) ?? new Map<string, number>();
      const uniqueDecks = commanderDeckHashes.get(commanderId)?.size ?? 0;

      const cards: CardEligibilityEntry[] = pool
        .map((card) => {
          const eligible = isColorIdentityLegal(card.colorIdentity, commanderColorIdentity);
          const matchesIncluding = inclusion.get(card.id) ?? 0;
          const decksIncluding = deckInclusion.get(card.id) ?? 0;
          const status: CardEligibilityStatus = !eligible
            ? 'unusable'
            : matchesIncluding > 0
              ? 'played'
              : 'held';
          return {
            cardId: card.id,
            status,
            matchesIncluding,
            inclusion: eligible ? round(matchesIncluding / matches) : null,
            decksIncluding,
            inclusionByUniqueDeck: eligible ? round(decksIncluding / uniqueDecks) : null,
          };
        })
        .sort((left, right) => left.cardId.localeCompare(right.cardId));

      const pairEntries: CardPairEntry[] = [...pairs]
        .map(([key, matchesIncludingBoth]) => {
          const [cardIdA = '', cardIdB = ''] = key.split(' ');
          const decksIncludingBoth = deckPairs.get(key) ?? 0;
          return {
            cardIdA,
            cardIdB,
            matchesIncludingBoth,
            support: round(matchesIncludingBoth / matches),
            decksIncludingBoth,
            supportByUniqueDeck: round(decksIncludingBoth / uniqueDecks),
          };
        })
        .sort(
          (left, right) =>
            left.cardIdA.localeCompare(right.cardIdA) || left.cardIdB.localeCompare(right.cardIdB),
        );

      return { commanderId, commanderMatches: matches, uniqueDecks, cards, pairs: pairEntries };
    });
}
