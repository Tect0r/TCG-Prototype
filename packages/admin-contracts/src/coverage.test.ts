import { describe, expect, it } from 'vitest';

import {
  catalogCardCoverageSchema,
  catalogCoverageReportSchema,
  catalogMechanicCoverageSchema,
  coverageIdentitySchema,
  playerMetaCardCoverageSchema,
  playerMetaCoverageReportSchema,
} from './coverage.js';
import { catalogCoverageRequestSchema, playerMetaCoverageRequestSchema } from './requests.js';
import type { PlayerMetaPartition } from './player-meta-results.js';

function partition(overrides: Partial<PlayerMetaPartition> = {}): PlayerMetaPartition {
  return { source: 'human_human', contentVersion: 5, rulesVersion: '1.0.0', ...overrides };
}

describe('coverageIdentitySchema', () => {
  it('accepts a catalog identity', () => {
    const result = coverageIdentitySchema.safeParse({
      domain: 'catalog',
      jobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(result.success).toBe(true);
  });

  it('accepts a Player Meta identity', () => {
    const result = coverageIdentitySchema.safeParse({
      domain: 'player_meta',
      partition: partition(),
    });
    expect(result.success).toBe(true);
  });

  it('rejects a catalog identity carrying a partition', () => {
    const result = coverageIdentitySchema.safeParse({
      domain: 'catalog',
      jobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      partition: partition(),
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown domain', () => {
    const result = coverageIdentitySchema.safeParse({ domain: 'live', jobId: 'job_a' });
    expect(result.success).toBe(false);
  });
});

describe('catalogCardCoverageSchema', () => {
  function card(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      cardId: 'card_forest',
      eligibility: 'reached',
      inclusion: 'reached',
      draw: 'reached',
      play: 'not_reached',
      activation: 'unavailable',
      trigger: 'not_reached',
      unavailableReasons: { activation: 'no data' },
      ...overrides,
    };
  }

  it('accepts a fully reached/not_reached/unavailable mix with a matching sparse reasons map', () => {
    expect(catalogCardCoverageSchema.safeParse(card()).success).toBe(true);
  });

  it('accepts an empty unavailableReasons map when nothing is unavailable', () => {
    const result = catalogCardCoverageSchema.safeParse(
      card({ activation: 'reached', unavailableReasons: {} }),
    );
    expect(result.success).toBe(true);
  });

  it('rejects an unknown status value', () => {
    const result = catalogCardCoverageSchema.safeParse(card({ draw: 'skipped' }));
    expect(result.success).toBe(false);
  });

  it('rejects an unknown extra field', () => {
    const result = catalogCardCoverageSchema.safeParse(card({ target: 'reached' }));
    expect(result.success).toBe(false);
  });
});

describe('catalogMechanicCoverageSchema', () => {
  it('accepts a reached mechanic with cards using it', () => {
    const result = catalogMechanicCoverageSchema.safeParse({
      kind: 'keyword',
      id: 'flying',
      mechanicKey: 'keyword:flying',
      cardsUsing: 3,
      status: 'reached',
      unavailableReason: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an unavailable mechanic with zero cards using it', () => {
    const result = catalogMechanicCoverageSchema.safeParse({
      kind: 'cost',
      id: 'exhaust',
      mechanicKey: 'cost:exhaust',
      cardsUsing: 0,
      status: 'unavailable',
      unavailableReason: "No card in this run's vocabulary uses this mechanic.",
    });
    expect(result.success).toBe(true);
  });

  it('rejects a negative cardsUsing count', () => {
    const result = catalogMechanicCoverageSchema.safeParse({
      kind: 'cost',
      id: 'exhaust',
      mechanicKey: 'cost:exhaust',
      cardsUsing: -1,
      status: 'unavailable',
      unavailableReason: 'why',
    });
    expect(result.success).toBe(false);
  });
});

describe('catalogCoverageReportSchema', () => {
  it('accepts a populated report with a null unavailableReason', () => {
    const result = catalogCoverageReportSchema.safeParse({
      identity: { domain: 'catalog', jobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      cards: [],
      mechanics: [],
      unavailableReason: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts an unavailable report with empty cards and mechanics', () => {
    const result = catalogCoverageReportSchema.safeParse({
      identity: { domain: 'catalog', jobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      cards: [],
      mechanics: [],
      unavailableReason: 'no resolved environment',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a Player Meta identity', () => {
    const result = catalogCoverageReportSchema.safeParse({
      identity: { domain: 'player_meta', partition: partition() },
      cards: [],
      mechanics: [],
      unavailableReason: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('playerMetaCardCoverageSchema and playerMetaCoverageReportSchema', () => {
  it('accepts a reached card observation', () => {
    const result = playerMetaCardCoverageSchema.safeParse({
      cardId: 'card_forest',
      observation: 'reached',
      unavailableReason: null,
    });
    expect(result.success).toBe(true);
  });

  it('accepts a populated player_meta report', () => {
    const result = playerMetaCoverageReportSchema.safeParse({
      identity: { domain: 'player_meta', partition: partition() },
      cards: [{ cardId: 'card_forest', observation: 'not_reached', unavailableReason: null }],
      unavailableReason: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects a catalog identity', () => {
    const result = playerMetaCoverageReportSchema.safeParse({
      identity: { domain: 'catalog', jobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
      cards: [],
      unavailableReason: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('catalogCoverageRequestSchema', () => {
  it('accepts a bare jobId', () => {
    const result = catalogCoverageRequestSchema.safeParse({
      jobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a request with no jobId', () => {
    expect(catalogCoverageRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an extra field', () => {
    const result = catalogCoverageRequestSchema.safeParse({
      jobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      path: '/etc/passwd',
    });
    expect(result.success).toBe(false);
  });
});

describe('playerMetaCoverageRequestSchema', () => {
  it('accepts an exact partition', () => {
    const result = playerMetaCoverageRequestSchema.safeParse({ partition: partition() });
    expect(result.success).toBe(true);
  });

  it('rejects a request with no partition', () => {
    expect(playerMetaCoverageRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects an extra field', () => {
    const result = playerMetaCoverageRequestSchema.safeParse({
      partition: partition(),
      filter: {},
    });
    expect(result.success).toBe(false);
  });
});
