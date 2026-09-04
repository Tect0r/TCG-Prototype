import { describe, expect, it } from 'vitest';

import {
  CARD_EXPLORER_ELIGIBILITY_STATUSES,
  CARD_EXPLORER_MAX_CONTRIBUTING_DECKS,
  CARD_EXPLORER_MAX_CONTRIBUTING_MATCHES,
  CARD_EXPLORER_MAX_INCLUSIONS,
  CARD_EXPLORER_MAX_PARTNERS,
  CARD_EXPLORER_MAX_UNAVAILABLE_PARTITIONS,
  cardExplorerContributingDeckSchema,
  cardExplorerContributingMatchSchema,
  cardExplorerExperimentEvidenceSchema,
  cardExplorerInclusionSchema,
  cardExplorerPartnerSchema,
  cardExplorerUnavailablePartitionSchema,
  cardExplorerViewSchema,
} from './card-explorer.js';
import { cardExplorerRequestSchema } from './requests.js';

const VALID_CARD_ID = 'arcane_snare';
const VALID_LIVE_MATCH_EVIDENCE = {
  realm: 'live_match' as const,
  source: 'human_ai' as const,
  contentVersion: 5,
  rulesVersion: '1.0.0',
};
const VALID_EXPERIMENT_EVIDENCE_SOURCE = {
  realm: 'experiment' as const,
  sourceClasses: ['ai' as const],
  environment: {
    environmentId: 'baseline',
    hashes: {
      mechanicsHash: '1111111111111111',
      pilotInputHash: '2222222222222222',
      presentationHash: '3333333333333333',
      fullContentHash: '4444444444444444',
    },
  },
};
const VALID_JOB_ID = 'job_00000000000000000000000000000000';

const VALID_INCLUSION = {
  commanderId: 'chief_containment_scholar',
  status: 'played' as const,
  commanderMatches: 10,
  matchesIncluding: 5,
  inclusion: 0.5,
  uniqueDecks: 8,
  decksIncluding: 4,
  inclusionByUniqueDeck: 0.5,
  observedIn: VALID_LIVE_MATCH_EVIDENCE,
};

const VALID_PARTNER = {
  commanderId: 'chief_containment_scholar',
  partnerCardId: 'archive_acolyte',
  matchesIncludingBoth: 3,
  support: 0.3,
  decksIncludingBoth: 2,
  supportByUniqueDeck: 0.25,
  observedIn: VALID_LIVE_MATCH_EVIDENCE,
};

const VALID_UNAVAILABLE_PARTITION = {
  observedIn: VALID_LIVE_MATCH_EVIDENCE,
  reason: 'No card database was supplied for this content version.',
};

const VALID_CONTRIBUTING_DECK = {
  deckHash: '0123456789abcdef',
  commanderId: 'chief_containment_scholar',
  observedIn: VALID_LIVE_MATCH_EVIDENCE,
};

const VALID_CONTRIBUTING_MATCH = {
  matchId: 'match_a',
  deckHash: '0123456789abcdef',
  commanderId: 'chief_containment_scholar',
  observedIn: VALID_LIVE_MATCH_EVIDENCE,
};

describe('restated literal values', () => {
  it('pins the eligibility statuses restated from `apps/simulator`', () => {
    expect([...CARD_EXPLORER_ELIGIBILITY_STATUSES]).toEqual(['played', 'held', 'unusable']);
  });
});

describe('cardExplorerInclusionSchema', () => {
  it('accepts a played inclusion and a null-rate unusable inclusion', () => {
    expect(cardExplorerInclusionSchema.safeParse(VALID_INCLUSION).success).toBe(true);
    expect(
      cardExplorerInclusionSchema.safeParse({
        ...VALID_INCLUSION,
        status: 'unusable',
        matchesIncluding: 0,
        inclusion: null,
        decksIncluding: 0,
        inclusionByUniqueDeck: null,
      }).success,
    ).toBe(true);
  });

  it('refuses an experiment-realm evidence entry — inclusion is only ever observed in a live match', () => {
    expect(
      cardExplorerInclusionSchema.safeParse({
        ...VALID_INCLUSION,
        observedIn: VALID_EXPERIMENT_EVIDENCE_SOURCE,
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown status', () => {
    expect(
      cardExplorerInclusionSchema.safeParse({ ...VALID_INCLUSION, status: 'banned' }).success,
    ).toBe(false);
  });
});

describe('cardExplorerPartnerSchema', () => {
  it('accepts a well-formed partner entry', () => {
    expect(cardExplorerPartnerSchema.safeParse(VALID_PARTNER).success).toBe(true);
  });
});

describe('cardExplorerUnavailablePartitionSchema', () => {
  it('accepts a well-formed entry and refuses an empty reason', () => {
    expect(
      cardExplorerUnavailablePartitionSchema.safeParse(VALID_UNAVAILABLE_PARTITION).success,
    ).toBe(true);
    expect(
      cardExplorerUnavailablePartitionSchema.safeParse({
        ...VALID_UNAVAILABLE_PARTITION,
        reason: '',
      }).success,
    ).toBe(false);
  });
});

describe('cardExplorerExperimentEvidenceSchema', () => {
  it('accepts row null (checked, not found) and a populated row', () => {
    expect(
      cardExplorerExperimentEvidenceSchema.safeParse({
        jobId: VALID_JOB_ID,
        row: null,
        observedIn: VALID_EXPERIMENT_EVIDENCE_SOURCE,
      }).success,
    ).toBe(true);
    expect(
      cardExplorerExperimentEvidenceSchema.safeParse({
        jobId: VALID_JOB_ID,
        row: { definitionId: VALID_CARD_ID, deadInHandShare: 0.1 },
        observedIn: VALID_EXPERIMENT_EVIDENCE_SOURCE,
      }).success,
    ).toBe(true);
  });

  it('refuses a live-match-realm evidence entry — experiment evidence is only ever traced to a job', () => {
    expect(
      cardExplorerExperimentEvidenceSchema.safeParse({
        jobId: VALID_JOB_ID,
        row: null,
        observedIn: VALID_LIVE_MATCH_EVIDENCE,
      }).success,
    ).toBe(false);
  });
});

describe('cardExplorerContributingDeckSchema / cardExplorerContributingMatchSchema', () => {
  it('accept well-formed entries', () => {
    expect(cardExplorerContributingDeckSchema.safeParse(VALID_CONTRIBUTING_DECK).success).toBe(
      true,
    );
    expect(cardExplorerContributingMatchSchema.safeParse(VALID_CONTRIBUTING_MATCH).success).toBe(
      true,
    );
  });
});

describe('cardExplorerRequestSchema', () => {
  it('defaults jobId to null', () => {
    expect(cardExplorerRequestSchema.parse({ cardId: VALID_CARD_ID })).toEqual({
      cardId: VALID_CARD_ID,
      jobId: null,
    });
  });

  it('accepts an explicit jobId and refuses an empty cardId', () => {
    expect(
      cardExplorerRequestSchema.safeParse({ cardId: VALID_CARD_ID, jobId: VALID_JOB_ID }).success,
    ).toBe(true);
    expect(cardExplorerRequestSchema.safeParse({ cardId: '' }).success).toBe(false);
  });
});

describe('cardExplorerViewSchema', () => {
  const emptyView = {
    cardId: VALID_CARD_ID,
    inclusions: [],
    partners: [],
    unavailablePartitions: [],
    experimentEvidence: null,
    contributingDecks: [],
    contributingMatches: [],
  };

  it('accepts an empty view — nothing observed, no job named', () => {
    expect(cardExplorerViewSchema.safeParse(emptyView).success).toBe(true);
  });

  it('distinguishes experimentEvidence null (no job named) from a present value with row null (checked, not found)', () => {
    const notChecked = cardExplorerViewSchema.parse(emptyView);
    const checkedEmpty = cardExplorerViewSchema.parse({
      ...emptyView,
      experimentEvidence: {
        jobId: VALID_JOB_ID,
        row: null,
        observedIn: VALID_EXPERIMENT_EVIDENCE_SOURCE,
      },
    });
    expect(notChecked.experimentEvidence).toBeNull();
    expect(checkedEmpty.experimentEvidence?.row).toBeNull();
  });

  it('accepts a full view with every field populated', () => {
    expect(
      cardExplorerViewSchema.safeParse({
        cardId: VALID_CARD_ID,
        inclusions: [VALID_INCLUSION],
        partners: [VALID_PARTNER],
        unavailablePartitions: [VALID_UNAVAILABLE_PARTITION],
        experimentEvidence: {
          jobId: VALID_JOB_ID,
          row: { definitionId: VALID_CARD_ID },
          observedIn: VALID_EXPERIMENT_EVIDENCE_SOURCE,
        },
        contributingDecks: [VALID_CONTRIBUTING_DECK],
        contributingMatches: [VALID_CONTRIBUTING_MATCH],
      }).success,
    ).toBe(true);
  });

  it('refuses more entries than each bound allows', () => {
    const manyInclusions = Array.from({ length: CARD_EXPLORER_MAX_INCLUSIONS + 1 }, () => VALID_INCLUSION);
    expect(
      cardExplorerViewSchema.safeParse({ ...emptyView, inclusions: manyInclusions }).success,
    ).toBe(false);

    const manyPartners = Array.from({ length: CARD_EXPLORER_MAX_PARTNERS + 1 }, () => VALID_PARTNER);
    expect(
      cardExplorerViewSchema.safeParse({ ...emptyView, partners: manyPartners }).success,
    ).toBe(false);

    const manyUnavailable = Array.from(
      { length: CARD_EXPLORER_MAX_UNAVAILABLE_PARTITIONS + 1 },
      () => VALID_UNAVAILABLE_PARTITION,
    );
    expect(
      cardExplorerViewSchema.safeParse({ ...emptyView, unavailablePartitions: manyUnavailable })
        .success,
    ).toBe(false);

    const manyDecks = Array.from(
      { length: CARD_EXPLORER_MAX_CONTRIBUTING_DECKS + 1 },
      () => VALID_CONTRIBUTING_DECK,
    );
    expect(
      cardExplorerViewSchema.safeParse({ ...emptyView, contributingDecks: manyDecks }).success,
    ).toBe(false);

    const manyMatches = Array.from(
      { length: CARD_EXPLORER_MAX_CONTRIBUTING_MATCHES + 1 },
      () => VALID_CONTRIBUTING_MATCH,
    );
    expect(
      cardExplorerViewSchema.safeParse({ ...emptyView, contributingMatches: manyMatches }).success,
    ).toBe(false);
  });

  it('refuses an extra field', () => {
    expect(cardExplorerViewSchema.safeParse({ ...emptyView, extra: true }).success).toBe(false);
  });
});
