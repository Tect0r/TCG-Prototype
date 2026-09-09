import { describe, expect, it } from 'vitest';

import {
  comparisonDecisionSchema,
  decideCatalogEnvironmentComparison,
  decidePlayerMetaComparison,
} from './comparison.js';
import type { EnvironmentContentHashes } from './catalog.js';
import type { PlayerMetaPartition } from './player-meta-results.js';

/**
 * M08.27A — the comparison compatibility gate. Every check here exercises
 * one of the three verdicts against the real signal each domain has, not a
 * shape neither domain carries.
 */

function hashes(overrides: Partial<EnvironmentContentHashes> = {}): EnvironmentContentHashes {
  return {
    mechanicsHash: 'aaaaaaaa',
    pilotInputHash: 'bbbbbbbb',
    presentationHash: 'cccccccc',
    fullContentHash: 'dddddddd',
    ...overrides,
  };
}

function partition(overrides: Partial<PlayerMetaPartition> = {}): PlayerMetaPartition {
  return { source: 'human_human', contentVersion: 5, rulesVersion: '1.0.0', ...overrides };
}

describe('comparisonDecisionSchema', () => {
  it('accepts all three verdicts', () => {
    expect(comparisonDecisionSchema.safeParse({ kind: 'compatible', note: 'identical' }).success).toBe(
      true,
    );
    expect(comparisonDecisionSchema.safeParse({ kind: 'refused', reason: 'why' }).success).toBe(true);
    expect(
      comparisonDecisionSchema.safeParse({
        kind: 'deliberately_different',
        declaredChange: 'buffed card X',
        reason: 'content differs',
      }).success,
    ).toBe(true);
  });

  it('rejects an empty declared change', () => {
    expect(
      comparisonDecisionSchema.safeParse({
        kind: 'deliberately_different',
        declaredChange: '',
        reason: 'content differs',
      }).success,
    ).toBe(false);
  });
});

describe('decideCatalogEnvironmentComparison', () => {
  it('refuses byte-identical content', () => {
    const same = hashes();
    const decision = decideCatalogEnvironmentComparison(same, { ...same });
    expect(decision.kind).toBe('refused');
  });

  it('is compatible when only presentation differs', () => {
    const baseline = hashes();
    const candidate = hashes({ presentationHash: 'eeeeeeee', fullContentHash: 'ffffffff' });
    const decision = decideCatalogEnvironmentComparison(baseline, candidate);
    expect(decision.kind).toBe('compatible');
  });

  it('refuses a mechanics difference with no declared change', () => {
    const baseline = hashes();
    const candidate = hashes({ mechanicsHash: 'eeeeeeee', fullContentHash: 'ffffffff' });
    const decision = decideCatalogEnvironmentComparison(baseline, candidate);
    expect(decision.kind).toBe('refused');
  });

  it('is deliberately different when a mechanics change is declared', () => {
    const baseline = hashes();
    const candidate = hashes({ mechanicsHash: 'eeeeeeee', fullContentHash: 'ffffffff' });
    const decision = decideCatalogEnvironmentComparison(baseline, candidate, 'nerfed card Y cost');
    expect(decision.kind).toBe('deliberately_different');
    if (decision.kind === 'deliberately_different') {
      expect(decision.declaredChange).toBe('nerfed card Y cost');
    }
  });

  it('refuses a pilot-input-only difference with no declared change, even though full content moved', () => {
    const baseline = hashes();
    const candidate = hashes({ pilotInputHash: 'eeeeeeee' });
    const decision = decideCatalogEnvironmentComparison(baseline, candidate);
    expect(decision.kind).toBe('refused');
  });

  it('treats a blank declared change as absent', () => {
    const baseline = hashes();
    const candidate = hashes({ mechanicsHash: 'eeeeeeee', fullContentHash: 'ffffffff' });
    const decision = decideCatalogEnvironmentComparison(baseline, candidate, '   ');
    expect(decision.kind).toBe('refused');
  });
});

describe('decidePlayerMetaComparison', () => {
  it('refuses an identical partition', () => {
    const decision = decidePlayerMetaComparison(partition(), partition());
    expect(decision.kind).toBe('refused');
  });

  it('always refuses a cross-source pair, declared change or not', () => {
    const baseline = partition({ source: 'human_human' });
    const candidate = partition({ source: 'ai_ai' });
    const decision = decidePlayerMetaComparison(baseline, candidate, 'different population entirely');
    expect(decision.kind).toBe('refused');
  });

  it('refuses a rules-version difference with no declared change', () => {
    const baseline = partition();
    const candidate = partition({ rulesVersion: '1.1.0' });
    const decision = decidePlayerMetaComparison(baseline, candidate);
    expect(decision.kind).toBe('refused');
  });

  it('is deliberately different when a version difference is declared', () => {
    const baseline = partition();
    const candidate = partition({ rulesVersion: '1.1.0' });
    const decision = decidePlayerMetaComparison(baseline, candidate, 'card balance patch applied');
    expect(decision.kind).toBe('deliberately_different');
    if (decision.kind === 'deliberately_different') {
      expect(decision.declaredChange).toBe('card balance patch applied');
    }
  });

  it('is deliberately different when only contentVersion differs and it is declared', () => {
    const baseline = partition();
    const candidate = partition({ contentVersion: 6 });
    const decision = decidePlayerMetaComparison(baseline, candidate, 'card schema migration');
    expect(decision.kind).toBe('deliberately_different');
  });
});
