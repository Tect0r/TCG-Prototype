import {
  NO_PLAYER_META_FILTER,
  type DeckExplorerRevisionConstructionKind,
  type DeckExplorerRevisionSide,
  type LiveMatchDeckHash,
  type PlayerMetaFilterInput,
  type PlayerMetaResultTableName,
} from '@tcg/admin-contracts';

/**
 * M08.26B — the Deck Explorer panel's pure helpers, mirroring the split
 * `adaptive-view.ts` and `player-meta-view.ts` already draw between
 * formatting/derivation and the component that renders it.
 *
 * `DECK_EXPLORER_EVIDENCE_TABLES` names the four Player Meta tables this
 * panel reuses rather than restates for matches, matchup split, cluster and
 * separated AI/human evidence (`deck-explorer.ts`'s own doc comment on why
 * those four words are not a gap the contract fills): every cell, drill-down
 * and truncation note for them is already `player-meta-view.ts`'s, reached
 * through the existing `playerMetaResultTable` address with
 * `deckExplorerEvidenceFilter` narrowing it to one hash — this file adds
 * nothing that duplicates it.
 */

/** The four Player Meta tables the Deck Explorer reuses, in the fixed order the panel shows them. */
export const DECK_EXPLORER_EVIDENCE_TABLES: readonly PlayerMetaResultTableName[] = [
  'decks',
  'deck_matchups',
  'clusters',
  'cluster_matchups',
];

export const DECK_EXPLORER_EVIDENCE_TABLE_LABELS: Readonly<
  Partial<Record<PlayerMetaResultTableName, string>>
> = {
  decks: 'This deck',
  deck_matchups: 'Matchup split',
  clusters: 'Cluster',
  cluster_matchups: 'Cluster matchups',
};

/** The Player Meta filter that narrows any of the four evidence tables to exactly this one deck hash. */
export function deckExplorerEvidenceFilter(deckHash: LiveMatchDeckHash): PlayerMetaFilterInput {
  return { ...NO_PLAYER_META_FILTER, deckHashes: [deckHash] };
}

const CONSTRUCTION_LABELS: Readonly<Record<DeckExplorerRevisionConstructionKind, string>> = {
  root: 'Root',
  swap: 'Swap',
  rebuild: 'Rebuild',
};

/** A revision's construction kind, in words. */
export function deckExplorerConstructionLabel(kind: DeckExplorerRevisionConstructionKind): string {
  return CONSTRUCTION_LABELS[kind];
}

const SIDE_LABELS: Readonly<Record<DeckExplorerRevisionSide, string>> = {
  incumbent: 'Incumbent',
  opponent: 'Opponent',
};

/** A revision's side, in words. */
export function deckExplorerSideLabel(side: DeckExplorerRevisionSide): string {
  return SIDE_LABELS[side];
}
