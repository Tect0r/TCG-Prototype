import { describe, expect, it } from 'vitest';

import {
  comparisonAnnotationDocumentSchema,
  comparisonAnnotationListSchema,
  comparisonAnnotationViewOf,
  type ComparisonAnnotationDocument,
} from './comparison-annotations.js';

/**
 * M08.27E — additive annotations, the schema layer.
 *
 * Nothing here writes a file; `apps/admin-server/src/catalog/comparison-annotations.test.ts`
 * covers the store. This suite only checks the shape: a document round-trips,
 * a refused decision cannot appear in it at all, and the view drops the
 * storage version the way `savedChoiceViewOf` does.
 */

function document(
  overrides: Partial<ComparisonAnnotationDocument> = {},
): ComparisonAnnotationDocument {
  return {
    documentVersion: 1,
    annotationId: 'cmpnote_aaaaaa',
    identity: {
      domain: 'catalog',
      baselineJobId: 'job_baseline1',
      candidateJobId: 'job_candidat1',
    },
    decision: { kind: 'compatible', note: 'presentation only' },
    note: 'Confirmed with the balance team before shipping.',
    createdAt: '2026-09-10T09:00:00.000Z',
    ...overrides,
  };
}

describe('comparisonAnnotationDocumentSchema', () => {
  it('accepts a document annotating a compatible catalog comparison', () => {
    expect(comparisonAnnotationDocumentSchema.safeParse(document()).success).toBe(true);
  });

  it('accepts a document annotating a deliberately-different Player Meta comparison', () => {
    const parsed = comparisonAnnotationDocumentSchema.safeParse(
      document({
        identity: {
          domain: 'player_meta',
          baseline: { source: 'human_human', contentVersion: 5, rulesVersion: '1.0.0' },
          candidate: { source: 'human_human', contentVersion: 6, rulesVersion: '1.0.0' },
        },
        decision: {
          kind: 'deliberately_different',
          declaredChange: 'card schema migration',
          reason: 'content version differs',
        },
      }),
    );
    expect(parsed.success).toBe(true);
  });

  it('rejects a refused decision: the shape does not exist in this schema', () => {
    const withRefused = {
      ...document(),
      decision: { kind: 'refused', reason: 'nothing to compare' },
    };
    expect(comparisonAnnotationDocumentSchema.safeParse(withRefused).success).toBe(false);
  });

  it('rejects an empty note', () => {
    expect(comparisonAnnotationDocumentSchema.safeParse(document({ note: '' })).success).toBe(
      false,
    );
  });

  it('rejects an unstamped document version', () => {
    expect(
      comparisonAnnotationDocumentSchema.safeParse(document({ documentVersion: 99 as 1 })).success,
    ).toBe(false);
  });
});

describe('comparisonAnnotationViewOf', () => {
  it('drops the storage version and keeps everything else', () => {
    const stored = document();
    const view = comparisonAnnotationViewOf(stored);
    expect(view).toEqual({
      annotationId: stored.annotationId,
      identity: stored.identity,
      decision: stored.decision,
      note: stored.note,
      createdAt: stored.createdAt,
    });
    expect(view).not.toHaveProperty('documentVersion');
  });
});

describe('comparisonAnnotationListSchema', () => {
  it('accepts an empty list with a default unreadable count', () => {
    const parsed = comparisonAnnotationListSchema.safeParse({ items: [], total: 0 });
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.unreadable).toBe(0);
  });

  it('accepts a list of views built from documents', () => {
    const view = comparisonAnnotationViewOf(document());
    const parsed = comparisonAnnotationListSchema.safeParse({
      items: [view],
      total: 1,
      unreadable: 0,
    });
    expect(parsed.success).toBe(true);
  });
});
