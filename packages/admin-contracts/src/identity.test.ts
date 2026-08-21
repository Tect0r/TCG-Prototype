import { generateId } from '@tcg/shared';
import { describe, expect, it } from 'vitest';

import {
  BATCH_ID_PREFIX,
  EXPERIMENT_KINDS,
  EXPERIMENT_PURPOSES,
  JOB_ID_PREFIX,
  SOURCE_CLASSES,
  batchIdSchema,
  canonicalSourceClasses,
  contentHashSchema,
  entryTimestampsSchema,
  experimentKindSchema,
  experimentPurposeSchema,
  jobIdSchema,
  labelSchema,
  sourceClassesSchema,
  stageIdSchema,
  stageRefSchema,
  tagSchema,
  timestampSchema,
  type EntryTimestamps,
} from './identity.js';

const AT = (iso: string): string => new Date(iso).toISOString();

const TIMESTAMPS: EntryTimestamps = {
  createdAt: AT('2026-08-21T09:00:00.000Z'),
  updatedAt: AT('2026-08-21T09:30:00.000Z'),
  startedAt: null,
  completedAt: null,
};

describe('admin IDs', () => {
  it('accepts what `generateId` mints, which is what the store will use', () => {
    const jobId = generateId(JOB_ID_PREFIX, { now: () => 1_755_000_000_000, random: () => 0.5 });
    const batchId = generateId(BATCH_ID_PREFIX, {
      now: () => 1_755_000_000_000,
      random: () => 0.5,
    });
    expect(jobIdSchema.parse(jobId)).toBe(jobId);
    expect(batchIdSchema.parse(batchId)).toBe(batchId);
  });

  it('accepts a short hand-written fixture name', () => {
    expect(jobIdSchema.parse('job_fixture1')).toBe('job_fixture1');
    expect(batchIdSchema.parse('batch_smoke01')).toBe('batch_smoke01');
  });

  it('refuses the other kind of ID, so a batch ID cannot stand in for a job', () => {
    expect(jobIdSchema.safeParse('batch_fixture1').success).toBe(false);
    expect(batchIdSchema.safeParse('job_fixture1').success).toBe(false);
  });

  it('refuses every character a traversal would have to be built from', () => {
    // M08.2 uses these IDs as file names under the catalog root, so the alphabet
    // *is* the safety property.
    for (const body of ['../abcd', 'a/bcdef', 'a\\bcdef', 'ab.cdef', 'ab cdef', 'ab:cdef']) {
      expect(jobIdSchema.safeParse(`job_${body}`).success).toBe(false);
    }
  });

  it('refuses uppercase, which a case-insensitive filesystem would fold', () => {
    expect(jobIdSchema.safeParse('job_ABCDEF').success).toBe(false);
    expect(jobIdSchema.safeParse('JOB_abcdef').success).toBe(false);
  });

  it('refuses a body that is too short or too long, and accepts both bounds', () => {
    expect(jobIdSchema.safeParse('job_abcde').success).toBe(false);
    expect(jobIdSchema.parse('job_abcdef')).toBe('job_abcdef');
    expect(jobIdSchema.parse(`job_${'a'.repeat(40)}`)).toBe(`job_${'a'.repeat(40)}`);
    expect(jobIdSchema.safeParse(`job_${'a'.repeat(41)}`).success).toBe(false);
  });

  it('refuses an ID with no prefix at all, and an empty one', () => {
    expect(jobIdSchema.safeParse('abcdefghij').success).toBe(false);
    expect(jobIdSchema.safeParse('').success).toBe(false);
    expect(jobIdSchema.safeParse('job_').success).toBe(false);
  });
});

describe('stage identity', () => {
  it('accepts an authored slug and refuses a minted-looking one', () => {
    expect(stageIdSchema.parse('finalists')).toBe('finalists');
    expect(stageIdSchema.parse('search-phase_2')).toBe('search-phase_2');
    expect(stageIdSchema.safeParse('Finalists').success).toBe(false);
    expect(stageIdSchema.safeParse('2nd-round').success).toBe(false);
    expect(stageIdSchema.safeParse('').success).toBe(false);
  });

  it('round-trips a stage reference', () => {
    const stage = { stageId: 'finalists', ordinal: 1, total: 3 };
    expect(stageRefSchema.parse(stage)).toEqual(stage);
  });

  it('refuses an ordinal at or past the declared count', () => {
    expect(stageRefSchema.safeParse({ stageId: 'a-stage', ordinal: 3, total: 3 }).success).toBe(
      false,
    );
    expect(stageRefSchema.safeParse({ stageId: 'a-stage', ordinal: -1, total: 3 }).success).toBe(
      false,
    );
  });

  it('accepts an unknown total, which is what an adaptive job has', () => {
    const open = { stageId: 'block', ordinal: 12, total: null };
    expect(stageRefSchema.parse(open)).toEqual(open);
  });

  it('refuses an unknown field', () => {
    expect(
      stageRefSchema.safeParse({ stageId: 'a-stage', ordinal: 0, total: 1, name: 'x' }).success,
    ).toBe(false);
  });
});

describe('timestamps', () => {
  it('accepts exactly what `toISOString` produces', () => {
    const now = new Date().toISOString();
    expect(timestampSchema.parse(now)).toBe(now);
  });

  it('refuses a local offset, so lexicographic order stays chronological order', () => {
    expect(timestampSchema.safeParse('2026-08-21T09:00:00.000+02:00').success).toBe(false);
    expect(timestampSchema.safeParse('2026-08-21T09:00:00Z').success).toBe(false);
    expect(timestampSchema.safeParse('2026-08-21T09:00:00.000000Z').success).toBe(false);
    expect(timestampSchema.safeParse('2026-08-21').success).toBe(false);
    expect(timestampSchema.safeParse('').success).toBe(false);
  });

  it('sorts lexicographically in the order it sorts chronologically', () => {
    const instants = [
      AT('2026-01-01T00:00:00.000Z'),
      AT('2026-08-21T09:00:00.000Z'),
      AT('2026-08-21T09:00:00.001Z'),
      AT('2026-12-31T23:59:59.999Z'),
    ];
    const shuffled = [instants[3], instants[1], instants[0], instants[2]] as string[];
    expect([...shuffled].sort()).toEqual(instants);
  });

  it('refuses a well-shaped string that is not a real instant', () => {
    expect(timestampSchema.safeParse('2026-13-45T99:00:00.000Z').success).toBe(false);
  });

  it('round-trips the four instants an entry records', () => {
    expect(entryTimestampsSchema.parse(TIMESTAMPS)).toEqual(TIMESTAMPS);
  });

  it('refuses an entry updated, started or completed before it was created', () => {
    const before = AT('2026-08-21T08:00:00.000Z');
    expect(entryTimestampsSchema.safeParse({ ...TIMESTAMPS, updatedAt: before }).success).toBe(
      false,
    );
    expect(entryTimestampsSchema.safeParse({ ...TIMESTAMPS, startedAt: before }).success).toBe(
      false,
    );
    expect(entryTimestampsSchema.safeParse({ ...TIMESTAMPS, completedAt: before }).success).toBe(
      false,
    );
  });

  it('refuses an entry that completed before it started', () => {
    expect(
      entryTimestampsSchema.safeParse({
        ...TIMESTAMPS,
        startedAt: AT('2026-08-21T09:20:00.000Z'),
        completedAt: AT('2026-08-21T09:10:00.000Z'),
      }).success,
    ).toBe(false);
  });

  it('accepts an instantaneous entry, where the readings are equal', () => {
    const instant = {
      createdAt: TIMESTAMPS.createdAt,
      updatedAt: TIMESTAMPS.createdAt,
      startedAt: TIMESTAMPS.createdAt,
      completedAt: TIMESTAMPS.createdAt,
    };
    expect(entryTimestampsSchema.parse(instant)).toEqual(instant);
  });

  it('refuses an unknown field', () => {
    expect(entryTimestampsSchema.safeParse({ ...TIMESTAMPS, deletedAt: null }).success).toBe(false);
  });
});

describe('experiment purpose', () => {
  it('is exactly the two words the locked interpretation keeps apart', () => {
    expect([...EXPERIMENT_PURPOSES]).toEqual(['exploration', 'validation']);
    for (const purpose of EXPERIMENT_PURPOSES) {
      expect(experimentPurposeSchema.parse(purpose)).toBe(purpose);
    }
  });

  it('refuses anything else, including a plausible third word', () => {
    for (const wrong of ['discovery', 'Exploration', '', 'final']) {
      expect(experimentPurposeSchema.safeParse(wrong).success).toBe(false);
    }
  });
});

describe('source class', () => {
  it('uses exactly the six words the milestone requires to stay distinguishable', () => {
    expect([...SOURCE_CLASSES]).toEqual(['ai', 'human', 'mixed', 'precon', 'search', 'adaptive']);
  });

  it('round-trips a classification in canonical order', () => {
    const classes = ['ai', 'precon'] as const;
    expect(sourceClassesSchema.parse(classes)).toEqual([...classes]);
  });

  it('refuses an empty classification, because every entry has one', () => {
    expect(sourceClassesSchema.safeParse([]).success).toBe(false);
  });

  it('refuses duplicates', () => {
    expect(sourceClassesSchema.safeParse(['ai', 'ai']).success).toBe(false);
  });

  it('refuses a classification recorded in some other order', () => {
    // Two entries with the same classification must serialize to the same bytes.
    expect(sourceClassesSchema.safeParse(['precon', 'ai']).success).toBe(false);
    expect(canonicalSourceClasses(['precon', 'ai'])).toEqual(['ai', 'precon']);
  });

  it('canonicalises a list with duplicates and an unknown-free order', () => {
    expect(canonicalSourceClasses(['adaptive', 'search', 'search'])).toEqual([
      'search',
      'adaptive',
    ]);
    expect(sourceClassesSchema.parse(canonicalSourceClasses(['adaptive', 'search']))).toEqual([
      'search',
      'adaptive',
    ]);
  });

  it('refuses `mixed` beside either half it already means', () => {
    expect(sourceClassesSchema.safeParse(['ai', 'mixed']).success).toBe(false);
    expect(sourceClassesSchema.safeParse(['human', 'mixed']).success).toBe(false);
    // Beside a class that answers a different question it is legal.
    expect(sourceClassesSchema.safeParse(['mixed', 'precon']).success).toBe(true);
  });

  it('accepts a human match on a deck its player built, with no new word', () => {
    expect(sourceClassesSchema.parse(['human'])).toEqual(['human']);
  });

  it('accepts a precon benchmark flown by pilots, which is two claims at once', () => {
    expect(sourceClassesSchema.parse(['ai', 'precon'])).toEqual(['ai', 'precon']);
  });
});

describe('experiment kind', () => {
  it('names the five kinds `experimentConfigSchema` discriminates on', () => {
    expect([...EXPERIMENT_KINDS]).toEqual([
      'batch',
      'search',
      'comparison',
      'replacement',
      'robustness',
    ]);
    for (const kind of EXPERIMENT_KINDS) expect(experimentKindSchema.parse(kind)).toBe(kind);
  });

  it('refuses a kind the simulator does not have', () => {
    expect(experimentKindSchema.safeParse('adaptive').success).toBe(false);
    expect(experimentKindSchema.safeParse('tournament').success).toBe(false);
  });
});

describe('content hashes, labels and tags', () => {
  it('accepts a `digest` of the default length and of a longer one', () => {
    expect(contentHashSchema.parse('0123456789abcdef')).toBe('0123456789abcdef');
    expect(contentHashSchema.parse('a'.repeat(64))).toBe('a'.repeat(64));
  });

  it('refuses a hash that is not lowercase hexadecimal, or is out of range', () => {
    for (const wrong of ['0123456789ABCDEF', 'zzzzzzzzzzzzzzzz', '0123456', 'a'.repeat(65), '']) {
      expect(contentHashSchema.safeParse(wrong).success).toBe(false);
    }
  });

  it('lets a label be empty and bounds its length', () => {
    expect(labelSchema.parse('')).toBe('');
    expect(labelSchema.parse('Precon smoke')).toBe('Precon smoke');
    expect(labelSchema.safeParse('x'.repeat(121)).success).toBe(false);
  });

  it('accepts a readable tag and refuses one that is not', () => {
    expect(tagSchema.parse('precon-smoke')).toBe('precon-smoke');
    expect(tagSchema.parse('wave_1')).toBe('wave_1');
    for (const wrong of ['', 'Precon', '-leading', 'has space', 'x'.repeat(33), '../x']) {
      expect(tagSchema.safeParse(wrong).success).toBe(false);
    }
  });
});
