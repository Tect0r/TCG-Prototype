import { describe, expect, it } from 'vitest';

import {
  DECK_EXPLORER_MAX_CARD_ENTRIES,
  DECK_EXPLORER_MAX_REVISIONS,
  DECK_EXPLORER_REVISION_CONSTRUCTION_KINDS,
  DECK_EXPLORER_REVISION_SIDES,
  deckExplorerCardEntrySchema,
  deckExplorerIdentitySchema,
  deckExplorerRevisionSchema,
  deckExplorerViewSchema,
} from './deck-explorer.js';
import { deckExplorerRequestSchema } from './requests.js';

const VALID_DECK_HASH = '0123456789abcdef';
const VALID_CARD_ID = 'prototype_commander_blue';
const VALID_OBSERVED_IN = {
  realm: 'live_match' as const,
  source: 'human_ai' as const,
  contentVersion: 3,
  rulesVersion: '1.4.0',
};
const VALID_CARDS = [{ cardId: VALID_CARD_ID, quantity: 1 }];

const VALID_REVISION = {
  side: 'incumbent' as const,
  revisionId: 'rev_abc',
  parentRevisionId: null,
  generation: 0,
  block: 0,
  opponentRevisionId: null,
  construction: 'root' as const,
  swapCount: 0,
};

describe('restated literal values', () => {
  it('pins the construction kinds and sides restated from `apps/simulator`/`apps/admin-server`', () => {
    expect([...DECK_EXPLORER_REVISION_CONSTRUCTION_KINDS]).toEqual(['root', 'swap', 'rebuild']);
    expect([...DECK_EXPLORER_REVISION_SIDES]).toEqual(['incumbent', 'opponent']);
  });
});

describe('deckExplorerCardEntrySchema', () => {
  it('accepts a valid entry and refuses a zero or over-bound quantity', () => {
    expect(
      deckExplorerCardEntrySchema.safeParse({ cardId: VALID_CARD_ID, quantity: 1 }).success,
    ).toBe(true);
    expect(
      deckExplorerCardEntrySchema.safeParse({ cardId: VALID_CARD_ID, quantity: 0 }).success,
    ).toBe(false);
    expect(
      deckExplorerCardEntrySchema.safeParse({ cardId: VALID_CARD_ID, quantity: 100 }).success,
    ).toBe(false);
  });
});

describe('deckExplorerIdentitySchema', () => {
  it('accepts a well-formed identity', () => {
    expect(
      deckExplorerIdentitySchema.safeParse({
        commanderId: VALID_CARD_ID,
        cards: VALID_CARDS,
        observedIn: VALID_OBSERVED_IN,
      }).success,
    ).toBe(true);
  });

  it('refuses an empty card list and a list past DECK_EXPLORER_MAX_CARD_ENTRIES', () => {
    expect(
      deckExplorerIdentitySchema.safeParse({
        commanderId: VALID_CARD_ID,
        cards: [],
        observedIn: VALID_OBSERVED_IN,
      }).success,
    ).toBe(false);
    const tooMany = Array.from({ length: DECK_EXPLORER_MAX_CARD_ENTRIES + 1 }, (_, i) => ({
      cardId: `card_${String(i)}`,
      quantity: 1,
    }));
    expect(
      deckExplorerIdentitySchema.safeParse({
        commanderId: VALID_CARD_ID,
        cards: tooMany,
        observedIn: VALID_OBSERVED_IN,
      }).success,
    ).toBe(false);
  });

  it('refuses an experiment-realm evidence entry — identity is only ever observed in a live match', () => {
    expect(
      deckExplorerIdentitySchema.safeParse({
        commanderId: VALID_CARD_ID,
        cards: VALID_CARDS,
        observedIn: { realm: 'experiment', sourceClasses: ['ai'], environment: {} },
      }).success,
    ).toBe(false);
  });
});

describe('deckExplorerRevisionSchema', () => {
  it('accepts a root revision and a non-root revision', () => {
    expect(deckExplorerRevisionSchema.safeParse(VALID_REVISION).success).toBe(true);
    expect(
      deckExplorerRevisionSchema.safeParse({
        ...VALID_REVISION,
        revisionId: 'rev_child',
        parentRevisionId: 'rev_abc',
        generation: 1,
        opponentRevisionId: 'rev_opp',
        construction: 'swap',
        swapCount: 2,
      }).success,
    ).toBe(true);
  });

  it('refuses an unknown construction kind or side', () => {
    expect(
      deckExplorerRevisionSchema.safeParse({ ...VALID_REVISION, construction: 'mutation' }).success,
    ).toBe(false);
    expect(deckExplorerRevisionSchema.safeParse({ ...VALID_REVISION, side: 'field' }).success).toBe(
      false,
    );
  });
});

describe('deckExplorerRequestSchema', () => {
  it('defaults adaptiveExperimentId to null', () => {
    expect(deckExplorerRequestSchema.parse({ deckHash: VALID_DECK_HASH })).toEqual({
      deckHash: VALID_DECK_HASH,
      adaptiveExperimentId: null,
    });
  });

  it('accepts an explicit experiment id and refuses a malformed deck hash', () => {
    expect(
      deckExplorerRequestSchema.safeParse({
        deckHash: VALID_DECK_HASH,
        adaptiveExperimentId: 'exp-1',
      }).success,
    ).toBe(true);
    expect(deckExplorerRequestSchema.safeParse({ deckHash: 'NOT-HEX' }).success).toBe(false);
  });
});

describe('deckExplorerViewSchema', () => {
  it('accepts identity null with knownRevisions null — nothing observed, nothing checked', () => {
    expect(
      deckExplorerViewSchema.safeParse({
        deckHash: VALID_DECK_HASH,
        identity: null,
        knownRevisions: null,
      }).success,
    ).toBe(true);
  });

  it('distinguishes knownRevisions null (not checked) from [] (checked, found nothing)', () => {
    const notChecked = deckExplorerViewSchema.parse({
      deckHash: VALID_DECK_HASH,
      identity: null,
      knownRevisions: null,
    });
    const checkedEmpty = deckExplorerViewSchema.parse({
      deckHash: VALID_DECK_HASH,
      identity: null,
      knownRevisions: [],
    });
    expect(notChecked.knownRevisions).toBeNull();
    expect(checkedEmpty.knownRevisions).toEqual([]);
  });

  it('accepts a full view with identity and revisions present', () => {
    expect(
      deckExplorerViewSchema.safeParse({
        deckHash: VALID_DECK_HASH,
        identity: {
          commanderId: VALID_CARD_ID,
          cards: VALID_CARDS,
          observedIn: VALID_OBSERVED_IN,
        },
        knownRevisions: [VALID_REVISION],
      }).success,
    ).toBe(true);
  });

  it('refuses more revisions than DECK_EXPLORER_MAX_REVISIONS', () => {
    const many = Array.from({ length: DECK_EXPLORER_MAX_REVISIONS + 1 }, (_, i) => ({
      ...VALID_REVISION,
      revisionId: `rev_${String(i)}`,
    }));
    expect(
      deckExplorerViewSchema.safeParse({
        deckHash: VALID_DECK_HASH,
        identity: null,
        knownRevisions: many,
      }).success,
    ).toBe(false);
  });

  it('refuses an extra field', () => {
    expect(
      deckExplorerViewSchema.safeParse({
        deckHash: VALID_DECK_HASH,
        identity: null,
        knownRevisions: null,
        extra: true,
      }).success,
    ).toBe(false);
  });
});
