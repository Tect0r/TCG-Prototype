import { describe, expect, it } from 'vitest';

import { NO_PLAYER_META_FILTER } from '@tcg/admin-contracts';

import {
  DECK_EXPLORER_EVIDENCE_TABLES,
  deckExplorerConstructionLabel,
  deckExplorerEvidenceFilter,
  deckExplorerSideLabel,
} from './deck-explorer-view.js';

describe('DECK_EXPLORER_EVIDENCE_TABLES', () => {
  it('names exactly the four Player Meta tables the milestone asks the Deck Explorer to reuse', () => {
    expect(DECK_EXPLORER_EVIDENCE_TABLES).toEqual([
      'decks',
      'deck_matchups',
      'clusters',
      'cluster_matchups',
    ]);
  });
});

describe('deckExplorerEvidenceFilter', () => {
  it('narrows the Player Meta filter to exactly the one deck hash, unfiltered otherwise', () => {
    expect(deckExplorerEvidenceFilter('0123456789abcdef')).toEqual({
      ...NO_PLAYER_META_FILTER,
      deckHashes: ['0123456789abcdef'],
    });
  });
});

describe('deckExplorerConstructionLabel', () => {
  it('labels every construction kind in words', () => {
    expect(deckExplorerConstructionLabel('root')).toBe('Root');
    expect(deckExplorerConstructionLabel('swap')).toBe('Swap');
    expect(deckExplorerConstructionLabel('rebuild')).toBe('Rebuild');
  });
});

describe('deckExplorerSideLabel', () => {
  it('labels both revision sides in words', () => {
    expect(deckExplorerSideLabel('incumbent')).toBe('Incumbent');
    expect(deckExplorerSideLabel('opponent')).toBe('Opponent');
  });
});
