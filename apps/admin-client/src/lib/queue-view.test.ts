import { describe, expect, it } from 'vitest';

import {
  BATCH_STATUSES,
  JOB_STATUSES,
  NO_ANNOTATIONS,
  NO_PROGRESS,
  OPERATOR_JOB_ACTIONS,
  catalogJobViewSchema,
  type CatalogJobView,
  type JobStatus,
  type Progress,
} from '@tcg/admin-contracts';

import {
  BATCH_STATUS_LEGEND,
  BATCH_STATUS_WORDING,
  JOB_ACTION_WORDING,
  JOB_STATUS_LEGEND,
  JOB_STATUS_WORDING,
  MIN_MATCHES_FOR_RATE,
  ORDER_IS_NOT_STATE,
  START_BATCH_CONFIRM,
  WITHDRAW_WORDING,
  formatDuration,
  matchProgressText,
  moveInOrder,
  remainingTime,
  stageText,
} from './queue-view.js';

/**
 * M08.9 — the wording, and the three refusals hidden inside it.
 *
 * The reason this module is separate from the component is that two of the
 * tranche's checklist items are claims about *totality* — every lifecycle state
 * named, remaining time shown only when it is honestly available — and totality
 * is a thing a test can walk an enumeration for. A component test can only prove
 * that the states it happened to render came out right.
 */

function jobWith(status: JobStatus, progress: Partial<Progress> = {}): CatalogJobView {
  return catalogJobViewSchema.parse({
    jobId: 'job_fixture01',
    batchId: 'batch_fixture1',
    label: 'Stage 1',
    status,
    purpose: 'exploration',
    sourceClasses: ['ai'],
    timestamps: {
      createdAt: '2026-08-31T09:00:00.000Z',
      updatedAt: '2026-08-31T09:00:00.000Z',
      startedAt: status === 'queued' ? null : '2026-08-31T09:00:00.000Z',
      completedAt: ['completed', 'failed', 'cancelled'].includes(status)
        ? '2026-08-31T09:00:00.000Z'
        : null,
    },
    annotations: NO_ANNOTATIONS,
    progress: { ...NO_PROGRESS, ...progress },
    spec: {
      experimentId: 'bench',
      kind: 'batch',
      seed: 'august',
      configHash: 'abcdef0123456789',
      configSchemaVersion: 1,
    },
    origin: { kind: 'direct' },
    execution: null,
    result: null,
    failure: null,
  });
}

/* ---------------------------------------------------------- every state */

describe('every lifecycle state is named', () => {
  it('gives each of the nine job states a label and a meaning', () => {
    for (const status of JOB_STATUSES) {
      const wording = JOB_STATUS_WORDING[status];
      expect(`${status}: ${wording.label}`).not.toBe(`${status}: `);
      expect(wording.meaning.length).toBeGreaterThan(20);
    }
    expect(JOB_STATUS_LEGEND).toHaveLength(JOB_STATUSES.length);
    expect(JOB_STATUS_LEGEND.map((entry) => entry.status)).toEqual([...JOB_STATUSES]);
  });

  it('gives each of the eight batch states a label and a meaning', () => {
    for (const status of BATCH_STATUSES) {
      expect(BATCH_STATUS_WORDING[status].meaning.length).toBeGreaterThan(20);
    }
    expect(BATCH_STATUS_LEGEND.map((entry) => entry.status)).toEqual([...BATCH_STATUSES]);
  });

  it('never prints a raw token, so a state added later cannot leak as an identifier', () => {
    for (const status of JOB_STATUSES) {
      expect(JOB_STATUS_WORDING[status].label).not.toBe(status);
    }
  });

  it('says of `completed` that it is not a verdict about the jobs inside it', () => {
    // `BATCH_STATUSES` is explicit that a batch of ten where two failed has not
    // failed, and a legend that dropped that would let an operator read a green
    // word as a result.
    expect(BATCH_STATUS_WORDING.completed.meaning).toContain('says nothing about whether');
  });
});

/* --------------------------------------------------------- confirmations */

describe('confirmations are proportional to what cannot be undone', () => {
  it('asks before cancel and before nothing else', () => {
    const asked = OPERATOR_JOB_ACTIONS.filter(
      (action) => JOB_ACTION_WORDING[action].confirm !== null,
    );
    expect(asked).toEqual(['cancel']);
  });

  it('states the consequence rather than asking whether the operator is sure', () => {
    expect(JOB_ACTION_WORDING.cancel.confirm).toContain('cannot be resumed');
    expect(WITHDRAW_WORDING.confirm).toContain('never run');
    expect(WITHDRAW_WORDING.confirm).toContain('nothing is deleted');
    expect(START_BATCH_CONFIRM).toContain('settles its order');
  });

  it('gives every operator verb a label, so no button can render a bare action name', () => {
    for (const action of OPERATOR_JOB_ACTIONS) {
      expect(JOB_ACTION_WORDING[action].label).not.toBe(action);
    }
  });
});

/* ------------------------------------------------------------- progress */

describe('match counts are printed in whichever of the three honest forms they are in', () => {
  it('prints an exact total as a fraction of it', () => {
    expect(matchProgressText({ ...NO_PROGRESS, completedMatches: 24, scheduledMatches: 48 })).toBe(
      '24 of 48 matches committed.',
    );
  });

  it('says a bound is a bound rather than dividing by it', () => {
    const text = matchProgressText({
      ...NO_PROGRESS,
      completedMatches: 24,
      scheduledMatches: 48,
      scheduledIsBound: true,
    });
    expect(text).toContain('against a bound of 48');
    expect(text).not.toContain('24 of 48');
  });

  it('says so when there is no total at all', () => {
    expect(matchProgressText({ ...NO_PROGRESS, completedMatches: 3 })).toContain(
      'no scheduled total is recorded',
    );
  });

  it('names the stage a composite job is on, and stays silent when there is none', () => {
    expect(stageText(NO_PROGRESS)).toBeNull();
    expect(
      stageText({ ...NO_PROGRESS, stage: { stageId: 'finalists', ordinal: 1, total: 3 } }),
    ).toBe('Now on stage 2 of 3: finalists.');
    expect(
      stageText({ ...NO_PROGRESS, stage: { stageId: 'search', ordinal: 0, total: null } }),
    ).toBe('Now on stage 1: search.');
  });

  it('formats a duration without rounding away the number it is read for', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(90_000)).toBe('1m 30s');
    expect(formatDuration(3_720_000)).toBe('1h 2m');
  });
});

/* -------------------------------------------------------- remaining time */

describe('remaining time is shown only when it is honestly available', () => {
  const running = (progress: Partial<Progress>) => remainingTime(jobWith('running', progress));

  it('extrapolates from this run’s own measured pace when every condition holds', () => {
    const left = running({
      completedMatches: 20,
      scheduledMatches: 60,
      elapsedMs: 40_000,
    });
    expect(left.available).toBe(true);
    if (!left.available) return;
    // 2s per match measured, 40 matches to go.
    expect(left.text).toBe('1m 20s');
    expect(left.basis).toContain('2s per match');
    expect(left.basis).toContain('20 committed matches');
  });

  it('refuses for a job that is not running, and says which condition failed', () => {
    for (const status of JOB_STATUSES.filter((entry) => entry !== 'running')) {
      const left = remainingTime(
        jobWith(status, { completedMatches: 20, scheduledMatches: 60, elapsedMs: 40_000 }),
      );
      expect(`${status}: ${String(left.available)}`).toBe(`${status}: false`);
      if (left.available) continue;
      expect(left.reason).toContain('while a job is running');
    }
  });

  it('refuses when the scheduled total is a bound rather than an exact figure', () => {
    const left = running({
      completedMatches: 20,
      scheduledMatches: 60,
      scheduledIsBound: true,
      elapsedMs: 40_000,
    });
    expect(left.available).toBe(false);
    if (left.available) return;
    expect(left.reason).toContain('bound rather than an exact figure');
  });

  it('refuses when there is no total to count down to', () => {
    const left = running({ completedMatches: 20, elapsedMs: 40_000 });
    expect(left.available).toBe(false);
    if (left.available) return;
    expect(left.reason).toContain('nothing to count down to');
  });

  it('refuses a rate taken from too few matches, and names the number', () => {
    const left = running({
      completedMatches: MIN_MATCHES_FOR_RATE - 1,
      scheduledMatches: 60,
      elapsedMs: 40_000,
    });
    expect(left.available).toBe(false);
    if (left.available) return;
    expect(left.reason).toContain(String(MIN_MATCHES_FOR_RATE));
  });

  it('refuses when nothing has been timed yet', () => {
    const left = running({ completedMatches: 20, scheduledMatches: 60 });
    expect(left.available).toBe(false);
    if (left.available) return;
    expect(left.reason).toContain('No elapsed time');
  });

  it('refuses once the schedule is exhausted rather than counting down to zero', () => {
    const left = running({ completedMatches: 60, scheduledMatches: 60, elapsedMs: 40_000 });
    expect(left.available).toBe(false);
    if (left.available) return;
    expect(left.reason).toContain('settling');
  });
});

/* --------------------------------------------------------------- ordering */

describe('the ordering', () => {
  it('says out loud that order carries nothing between jobs', () => {
    expect(ORDER_IS_NOT_STATE).toContain('own seed family');
    expect(ORDER_IS_NOT_STATE).toContain('pools no evidence');
  });

  it('moves one entry and leaves the rest in their relative order', () => {
    expect(moveInOrder(['a', 'b', 'c', 'd'], 2, 0)).toEqual(['c', 'a', 'b', 'd']);
    expect(moveInOrder(['a', 'b', 'c', 'd'], 0, 3)).toEqual(['b', 'c', 'd', 'a']);
  });

  it('is a no-op for a move that goes nowhere or off either end', () => {
    const order = ['a', 'b', 'c'];
    expect(moveInOrder(order, 1, 1)).toEqual(order);
    expect(moveInOrder(order, 0, -1)).toEqual(order);
    expect(moveInOrder(order, 2, 3)).toEqual(order);
  });

  it('never loses or invents a member, whichever move is asked for', () => {
    const order = ['a', 'b', 'c', 'd', 'e'];
    for (let from = 0; from < order.length; from += 1) {
      for (let to = 0; to < order.length; to += 1) {
        const moved = moveInOrder(order, from, to);
        expect([...moved].sort()).toEqual([...order].sort());
      }
    }
  });
});
