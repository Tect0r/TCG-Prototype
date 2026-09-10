import { describe, expect, it } from 'vitest';

import { comparisonDeltaTableSchema } from './comparison-deltas.js';
import type { ComparisonDecision } from './comparison.js';
import type { PlayerMetaPartition } from './player-meta-results.js';

const compatible: ComparisonDecision = { kind: 'compatible', note: 'identical' };
const refused: ComparisonDecision = { kind: 'refused', reason: 'why' };
const deliberatelyDifferent: ComparisonDecision = {
  kind: 'deliberately_different',
  declaredChange: 'buffed card X',
  reason: 'content differs',
};

function partition(overrides: Partial<PlayerMetaPartition> = {}): PlayerMetaPartition {
  return { source: 'human_human', contentVersion: 5, rulesVersion: '1.0.0', ...overrides };
}

describe('comparisonDeltaTableSchema', () => {
  it('accepts a catalog delta table with a compatible decision and matching cells', () => {
    const result = comparisonDeltaTableSchema.safeParse({
      table: 'deck_matchups',
      identity: {
        domain: 'catalog',
        baselineJobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        candidateJobId: 'job_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      decision: compatible,
      columns: [{ key: 'deckHash', label: 'Deck', kind: 'identifier', bounds: null }],
      rows: [{ deckHash: 'abc' }],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a Player Meta delta table with a deliberately-different decision', () => {
    const result = comparisonDeltaTableSchema.safeParse({
      table: 'surrender_turns',
      identity: {
        domain: 'player_meta',
        baseline: partition(),
        candidate: partition({ rulesVersion: '1.1.0' }),
      },
      decision: deliberatelyDifferent,
      columns: [{ key: 'turn', label: 'Turn', kind: 'number', bounds: null }],
      rows: [{ turn: 4 }],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a catalog table paired with a Player Meta identity', () => {
    const result = comparisonDeltaTableSchema.safeParse({
      table: 'card_inclusion',
      identity: { domain: 'player_meta', baseline: partition(), candidate: partition() },
      decision: compatible,
      columns: [],
      rows: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a Player Meta table paired with a catalog identity', () => {
    const result = comparisonDeltaTableSchema.safeParse({
      table: 'surrender_state',
      identity: {
        domain: 'catalog',
        baselineJobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        candidateJobId: 'job_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      decision: compatible,
      columns: [],
      rows: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects a refused decision that still carries computed rows', () => {
    const result = comparisonDeltaTableSchema.safeParse({
      table: 'terminations',
      identity: {
        domain: 'catalog',
        baselineJobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        candidateJobId: 'job_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      decision: refused,
      columns: [{ key: 'kind', label: 'Termination', kind: 'identifier', bounds: null }],
      rows: [{ kind: 'timeout' }],
    });
    expect(result.success).toBe(false);
  });

  it('accepts a refused decision with an empty payload', () => {
    const result = comparisonDeltaTableSchema.safeParse({
      table: 'terminations',
      identity: {
        domain: 'catalog',
        baselineJobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        candidateJobId: 'job_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      decision: refused,
      columns: [],
      rows: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects a row cell with no declared column', () => {
    const result = comparisonDeltaTableSchema.safeParse({
      table: 'deck_family',
      identity: {
        domain: 'catalog',
        baselineJobId: 'job_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        candidateJobId: 'job_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
      decision: compatible,
      columns: [{ key: 'deckId', label: 'Deck', kind: 'identifier', bounds: null }],
      rows: [{ deckId: 'd1', presence: 'both' }],
    });
    expect(result.success).toBe(false);
  });
});
