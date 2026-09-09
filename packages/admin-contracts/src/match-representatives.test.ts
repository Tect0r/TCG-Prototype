import { describe, expect, it } from 'vitest';

import {
  abnormalMatchEntrySchema,
  matchRepresentativesViewSchema,
  representativeMatchEntrySchema,
  representativeMatchSchema,
  REPRESENTATIVE_MATCH_ENTRY_COUNT,
  REPRESENTATIVE_MATCH_KINDS,
} from './match-representatives.js';
import { matchRepresentativesRequestSchema } from './requests.js';

const VALID_EVIDENCE = {
  realm: 'live_match' as const,
  source: 'human_ai' as const,
  contentVersion: 5,
  rulesVersion: '1.0.0',
};

const VALID_REF = { kind: 'match' as const, matchId: 'match_a' };

const VALID_REPRESENTATIVE = {
  kind: 'closest' as const,
  ref: VALID_REF,
  observedIn: VALID_EVIDENCE,
  reason: 'The winning and losing Commanders differ by only 1.0%.',
};

describe('restated literal values', () => {
  it('pins the seven representative kinds in the milestone line order', () => {
    expect([...REPRESENTATIVE_MATCH_KINDS]).toEqual([
      'closest',
      'largest_upset',
      'most_one_sided',
      'shortest',
      'longest',
      'pre_adaptation',
      'random_ordinary',
    ]);
    expect(REPRESENTATIVE_MATCH_ENTRY_COUNT).toBe(7);
  });
});

describe('representativeMatchSchema', () => {
  it('accepts a well-formed selection', () => {
    expect(representativeMatchSchema.safeParse(VALID_REPRESENTATIVE).success).toBe(true);
  });

  it('refuses an unknown kind and a reason past the bound', () => {
    expect(
      representativeMatchSchema.safeParse({ ...VALID_REPRESENTATIVE, kind: 'weirdest' }).success,
    ).toBe(false);
    expect(
      representativeMatchSchema.safeParse({ ...VALID_REPRESENTATIVE, reason: 'x'.repeat(401) })
        .success,
    ).toBe(false);
  });

  it('carries a match ref, never a deck or card ref', () => {
    expect(
      representativeMatchSchema.safeParse({
        ...VALID_REPRESENTATIVE,
        ref: { kind: 'deck', deckHash: '0123456789abcdef' },
      }).success,
    ).toBe(false);
  });
});

describe('representativeMatchEntrySchema', () => {
  it('accepts a populated entry and a null match (kind checked, none eligible)', () => {
    expect(
      representativeMatchEntrySchema.safeParse({ kind: 'closest', match: VALID_REPRESENTATIVE })
        .success,
    ).toBe(true);
    expect(representativeMatchEntrySchema.safeParse({ kind: 'closest', match: null }).success).toBe(
      true,
    );
  });
});

describe('abnormalMatchEntrySchema', () => {
  it('accepts a well-formed entry and refuses a reason past the bound', () => {
    const entry = { ref: VALID_REF, observedIn: VALID_EVIDENCE, reason: 'Terminated abnormally.' };
    expect(abnormalMatchEntrySchema.safeParse(entry).success).toBe(true);
    expect(abnormalMatchEntrySchema.safeParse({ ...entry, reason: 'x'.repeat(201) }).success).toBe(
      false,
    );
  });
});

describe('matchRepresentativesViewSchema', () => {
  const entries = REPRESENTATIVE_MATCH_KINDS.map((kind) => ({ kind, match: null }));

  it('accepts exactly seven entries, one per kind, and a null adaptiveExperimentId', () => {
    expect(
      matchRepresentativesViewSchema.safeParse({
        adaptiveExperimentId: null,
        representatives: entries,
        abnormalMatches: {
          items: [],
          page: { returned: 0, limit: 50, nextCursor: null, total: 0 },
        },
      }).success,
    ).toBe(true);
  });

  it('refuses fewer or more than seven representative entries', () => {
    expect(
      matchRepresentativesViewSchema.safeParse({
        adaptiveExperimentId: null,
        representatives: entries.slice(0, 6),
        abnormalMatches: {
          items: [],
          page: { returned: 0, limit: 50, nextCursor: null, total: 0 },
        },
      }).success,
    ).toBe(false);
  });

  it('pages abnormalMatches the same way every other explorer list does', () => {
    const abnormalEntry = {
      ref: VALID_REF,
      observedIn: VALID_EVIDENCE,
      reason: 'Terminated abnormally.',
    };
    expect(
      matchRepresentativesViewSchema.safeParse({
        adaptiveExperimentId: null,
        representatives: entries,
        abnormalMatches: {
          items: [abnormalEntry, abnormalEntry],
          page: { returned: 1, limit: 50, nextCursor: null, total: 2 },
        },
      }).success,
    ).toBe(false);
  });
});

describe('matchRepresentativesRequestSchema', () => {
  it('defaults filter, adaptiveExperimentId and page to their own empty forms', () => {
    expect(matchRepresentativesRequestSchema.parse({})).toEqual({
      filter: {
        contentVersions: [],
        sources: [],
        commanderIds: [],
        deckHashes: [],
        terminations: [],
      },
      adaptiveExperimentId: null,
      page: { limit: 50, cursor: null },
    });
  });

  it('accepts an explicit adaptiveExperimentId', () => {
    expect(
      matchRepresentativesRequestSchema.safeParse({ adaptiveExperimentId: 'goblin_counter' })
        .success,
    ).toBe(true);
  });
});
