import { describe, expect, it } from 'vitest';

import {
  EXPLORER_KINDS,
  EXPLORER_MATCH_ID_MAX,
  MAX_EXPLORER_REFS,
  cardExplorerRefSchema,
  deckExplorerRefSchema,
  experimentExplorerEvidenceSchema,
  explorerEvidenceSourceSchema,
  explorerMatchIdSchema,
  explorerRefSchema,
  explorerRefsSchema,
  liveMatchExplorerEvidenceSchema,
  matchExplorerRefSchema,
} from './explorers.js';

const VALID_DECK_HASH = '0123456789abcdef';
const VALID_CARD_ID = 'prototype_commander_blue';
const VALID_MATCH_ID = 'match_0000000001';
const VALID_ENVIRONMENT = {
  environmentId: 'baseline',
  hashes: {
    mechanicsHash: 'abcdef01',
    pilotInputHash: 'abcdef02',
    presentationHash: 'abcdef03',
    fullContentHash: 'abcdef04',
  },
};

describe('restated literal values', () => {
  it('pins the match id bound this build restates from `@tcg/match-telemetry`', () => {
    expect(EXPLORER_MATCH_ID_MAX).toBe(128);
  });
});

describe('explorerKindSchema / EXPLORER_KINDS', () => {
  it('names exactly the three explorers the milestone scopes', () => {
    expect([...EXPLORER_KINDS]).toEqual(['deck', 'card', 'match']);
  });
});

describe('explorerMatchIdSchema', () => {
  it('accepts a plausible match id', () => {
    expect(explorerMatchIdSchema.safeParse(VALID_MATCH_ID).success).toBe(true);
  });

  it('refuses an empty string and a string past the bound', () => {
    expect(explorerMatchIdSchema.safeParse('').success).toBe(false);
    expect(explorerMatchIdSchema.safeParse('m'.repeat(EXPLORER_MATCH_ID_MAX + 1)).success).toBe(
      false,
    );
  });
});

describe('the per-kind refs', () => {
  it('deckExplorerRefSchema accepts a valid deck hash and refuses an extra field', () => {
    expect(
      deckExplorerRefSchema.safeParse({ kind: 'deck', deckHash: VALID_DECK_HASH }).success,
    ).toBe(true);
    expect(
      deckExplorerRefSchema.safeParse({
        kind: 'deck',
        deckHash: VALID_DECK_HASH,
        extra: true,
      }).success,
    ).toBe(false);
  });

  it('cardExplorerRefSchema accepts a valid card id', () => {
    expect(cardExplorerRefSchema.safeParse({ kind: 'card', cardId: VALID_CARD_ID }).success).toBe(
      true,
    );
  });

  it('matchExplorerRefSchema accepts a valid match id', () => {
    expect(
      matchExplorerRefSchema.safeParse({ kind: 'match', matchId: VALID_MATCH_ID }).success,
    ).toBe(true);
  });
});

describe('explorerRefSchema', () => {
  it('discriminates on `kind` and round-trips each member', () => {
    expect(explorerRefSchema.parse({ kind: 'deck', deckHash: VALID_DECK_HASH })).toEqual({
      kind: 'deck',
      deckHash: VALID_DECK_HASH,
    });
    expect(explorerRefSchema.parse({ kind: 'card', cardId: VALID_CARD_ID })).toEqual({
      kind: 'card',
      cardId: VALID_CARD_ID,
    });
    expect(explorerRefSchema.parse({ kind: 'match', matchId: VALID_MATCH_ID })).toEqual({
      kind: 'match',
      matchId: VALID_MATCH_ID,
    });
  });

  it('refuses a kind that is a card field on a deck ref, or an unknown kind', () => {
    expect(explorerRefSchema.safeParse({ kind: 'deck', cardId: VALID_CARD_ID }).success).toBe(
      false,
    );
    expect(
      explorerRefSchema.safeParse({ kind: 'commander', commanderId: VALID_CARD_ID }).success,
    ).toBe(false);
  });
});

describe('explorerRefsSchema', () => {
  it('accepts up to MAX_EXPLORER_REFS refs and refuses one more', () => {
    const many = Array.from({ length: MAX_EXPLORER_REFS + 1 }, (_, i) => ({
      kind: 'match' as const,
      matchId: `match_${String(i).padStart(10, '0')}`,
    }));
    expect(explorerRefsSchema.safeParse(many).success).toBe(false);
    expect(explorerRefsSchema.safeParse(many.slice(0, MAX_EXPLORER_REFS)).success).toBe(true);
  });

  it('accepts a mix of the three kinds side by side', () => {
    const mixed = [
      { kind: 'deck', deckHash: VALID_DECK_HASH },
      { kind: 'card', cardId: VALID_CARD_ID },
      { kind: 'match', matchId: VALID_MATCH_ID },
    ];
    expect(explorerRefsSchema.safeParse(mixed).success).toBe(true);
  });
});

describe('explorerEvidenceSourceSchema', () => {
  it('accepts a live-match realm entry', () => {
    const parsed = explorerEvidenceSourceSchema.safeParse({
      realm: 'live_match',
      source: 'human_ai',
      contentVersion: 3,
      rulesVersion: '1.4.0',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an experiment realm entry', () => {
    const parsed = explorerEvidenceSourceSchema.safeParse({
      realm: 'experiment',
      sourceClasses: ['ai'],
      environment: VALID_ENVIRONMENT,
    });
    expect(parsed.success).toBe(true);
  });

  it('refuses a live-match entry carrying an experiment field, and vice versa', () => {
    expect(
      explorerEvidenceSourceSchema.safeParse({
        realm: 'live_match',
        source: 'human_ai',
        contentVersion: 3,
        rulesVersion: '1.4.0',
        sourceClasses: ['ai'],
      }).success,
    ).toBe(false);
    expect(
      explorerEvidenceSourceSchema.safeParse({
        realm: 'experiment',
        sourceClasses: ['ai'],
        environment: VALID_ENVIRONMENT,
        source: 'human_ai',
      }).success,
    ).toBe(false);
  });

  it('refuses an experiment entry with an empty source classification', () => {
    expect(
      experimentExplorerEvidenceSchema.safeParse({
        realm: 'experiment',
        sourceClasses: [],
        environment: VALID_ENVIRONMENT,
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown realm', () => {
    expect(explorerEvidenceSourceSchema.safeParse({ realm: 'search_index' } as never).success).toBe(
      false,
    );
  });
});

describe('liveMatchExplorerEvidenceSchema', () => {
  it('round-trips through JSON unchanged', () => {
    const value = {
      realm: 'live_match' as const,
      source: 'ai_ai' as const,
      contentVersion: 1,
      rulesVersion: 'r1',
    };
    expect(liveMatchExplorerEvidenceSchema.parse(JSON.parse(JSON.stringify(value)))).toEqual(value);
  });
});
