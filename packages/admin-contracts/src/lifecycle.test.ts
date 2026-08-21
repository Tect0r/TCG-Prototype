import { describe, expect, it } from 'vitest';

import {
  BATCH_ACTIONS,
  BATCH_LIFECYCLE,
  BATCH_STATUSES,
  BATCH_TERMINAL_STATUSES,
  BATCH_TRANSITIONS,
  JOB_ACTIONS,
  JOB_LIFECYCLE,
  JOB_STATUSES,
  JOB_STATUSES_REQUIRING_START,
  JOB_TERMINAL_STATUSES,
  JOB_TRANSITIONS,
  NO_PROGRESS,
  applyBatchTransition,
  applyJobTransition,
  batchStatusSchema,
  batchTransition,
  isTerminalBatchStatus,
  isTerminalJobStatus,
  jobStatusSchema,
  jobTransition,
  legalBatchActions,
  legalJobActions,
  progressSchema,
  reachableStates,
  type BatchAction,
  type BatchStatus,
  type JobAction,
  type JobStatus,
  type LifecycleModel,
} from './lifecycle.js';

/**
 * The transition policy has one implementation, so these tests read it rather
 * than restating it. Every assertion below is either derived from
 * `JOB_LIFECYCLE`/`BATCH_LIFECYCLE` or is a deliberate hand-written expectation
 * about a *specific* row — and where it is the second, the row is one the
 * milestone argued about, so a silent edit to it should fail here.
 */

function crossProduct<S extends string, A extends string>(
  model: LifecycleModel<S, A>,
): { readonly from: S; readonly action: A }[] {
  return model.states.flatMap((from) => model.actions.map((action) => ({ from, action })));
}

describe('the job lifecycle', () => {
  it('starts queued, and every job status is a legal enum member', () => {
    expect(JOB_LIFECYCLE.initial).toBe('queued');
    for (const status of JOB_STATUSES) expect(jobStatusSchema.parse(status)).toBe(status);
  });

  it('accepts every legal transition the table declares', () => {
    expect(JOB_TRANSITIONS.length).toBeGreaterThan(0);
    for (const transition of JOB_TRANSITIONS) {
      const applied = applyJobTransition(transition.from, transition.action);
      expect(applied.ok).toBe(true);
      if (applied.ok) expect(applied.to).toBe(transition.to);
      expect(jobTransition(transition.from, transition.action)).toBe(transition.to);
    }
  });

  it('rejects every transition the table does not declare', () => {
    const legal = new Set(JOB_TRANSITIONS.map((t) => `${t.from}/${t.action}`));
    const illegal = crossProduct(JOB_LIFECYCLE).filter(
      ({ from, action }) => !legal.has(`${from}/${action}`),
    );
    // A model where everything is legal would pass the test above vacuously.
    expect(illegal.length).toBeGreaterThan(0);

    for (const { from, action } of illegal) {
      const applied = applyJobTransition(from, action);
      expect(applied.ok).toBe(false);
      if (applied.ok) continue;
      expect(applied.error.code).toBe('admin/illegal_transition');
      expect(applied.error.context).toMatchObject({ entry: 'job', from, action });
      expect(jobTransition(from, action)).toBeNull();
    }
  });

  it('names the actions that were available instead, so a refusal can explain itself', () => {
    const refused = applyJobTransition('queued', 'complete');
    expect(refused.ok).toBe(false);
    if (refused.ok) return;
    expect(refused.error.context?.available).toEqual(legalJobActions('queued'));
    expect(refused.error.message).toContain('`queued`');
  });

  it('says a terminal entry has finished rather than that it lacks a transition', () => {
    const finished = applyJobTransition('completed', 'pause');
    const merely = applyJobTransition('queued', 'pause');
    expect(finished.ok || merely.ok).toBe(false);
    if (finished.ok || merely.ok) return;
    expect(finished.error.message).toContain('has finished');
    expect(finished.error.context?.terminal).toBe(true);
    expect(merely.error.message).toContain('no `pause` transition');
    expect(merely.error.context?.terminal).toBe(false);
  });
});

describe('job terminal states', () => {
  it('names exactly the three a job finishes in', () => {
    expect([...JOB_TERMINAL_STATUSES]).toEqual(['completed', 'failed', 'cancelled']);
    for (const status of JOB_TERMINAL_STATUSES) expect(isTerminalJobStatus(status)).toBe(true);
  });

  it('lets nothing leave completed or cancelled', () => {
    for (const status of ['completed', 'cancelled'] as const) {
      expect(legalJobActions(status)).toEqual([]);
      for (const action of JOB_ACTIONS) expect(jobTransition(status, action)).toBeNull();
    }
  });

  it('lets a failed job be retried, which is the one declared exception', () => {
    // Terminal is declared rather than derived precisely so this row can exist.
    expect(isTerminalJobStatus('failed')).toBe(true);
    expect(legalJobActions('failed')).toEqual(['retry']);
    expect(jobTransition('failed', 'retry')).toBe('queued');
  });

  it('treats every non-terminal status as non-terminal', () => {
    for (const status of JOB_STATUSES) {
      if (JOB_TERMINAL_STATUSES.includes(status)) continue;
      expect(isTerminalJobStatus(status)).toBe(false);
    }
  });
});

describe('recovery', () => {
  it('never lets interrupted work become completed', () => {
    // The milestone's sharpest requirement: recovering `running` work as
    // `completed` is the lie M08.2 exists to prevent.
    expect(jobTransition('interrupted', 'complete')).toBeNull();
    expect(legalJobActions('interrupted')).toEqual(['resume', 'cancel']);
  });

  it('interrupts all three in-flight states and no settled one', () => {
    const interruptible = JOB_STATUSES.filter((s) => jobTransition(s, 'interrupt') !== null);
    expect(interruptible).toEqual(['running', 'pausing', 'cancelling']);
    for (const status of interruptible)
      expect(jobTransition(status, 'interrupt')).toBe('interrupted');
    for (const settled of ['queued', 'paused'] as const) {
      expect(jobTransition(settled, 'interrupt')).toBeNull();
    }
  });

  it('does not infer that a cancellation completed across a restart', () => {
    expect(jobTransition('cancelling', 'interrupt')).toBe('interrupted');
    // The operator's intent survives as an action they may take again.
    expect(jobTransition('interrupted', 'cancel')).toBe('cancelled');
  });

  it('resumes into the queue rather than into a worker it has not been given', () => {
    expect(jobTransition('paused', 'resume')).toBe('queued');
    expect(jobTransition('interrupted', 'resume')).toBe('queued');
    // `start` is the only thing that begins work, which is what bounds M08.5.
    const intoRunning = JOB_TRANSITIONS.filter((t) => t.to === 'running');
    expect(intoRunning.map((t) => t.action)).toEqual(['start']);
  });
});

describe('states that require a start instant', () => {
  it('is derived from the table rather than listed by hand', () => {
    const withoutStarting = new Set(reachableStates(JOB_LIFECYCLE, 'start'));
    for (const status of JOB_STATUSES) {
      expect(JOB_STATUSES_REQUIRING_START.includes(status)).toBe(!withoutStarting.has(status));
    }
  });

  it('excludes a job cancelled straight out of the queue, and includes a finished one', () => {
    expect(JOB_STATUSES_REQUIRING_START).not.toContain('cancelled');
    expect(JOB_STATUSES_REQUIRING_START).not.toContain('queued');
    expect(JOB_STATUSES_REQUIRING_START).toContain('completed');
    expect(JOB_STATUSES_REQUIRING_START).toContain('failed');
  });
});

describe('the batch lifecycle', () => {
  it('starts in draft, which the job lifecycle has no counterpart for', () => {
    expect(BATCH_LIFECYCLE.initial).toBe('draft');
    expect(BATCH_STATUSES).toContain('draft');
    expect(JOB_STATUSES as readonly string[]).not.toContain('draft');
    for (const status of BATCH_STATUSES) expect(batchStatusSchema.parse(status)).toBe(status);
  });

  it('accepts every legal transition and rejects every other pair', () => {
    for (const transition of BATCH_TRANSITIONS) {
      expect(batchTransition(transition.from, transition.action)).toBe(transition.to);
    }
    const legal = new Set(BATCH_TRANSITIONS.map((t) => `${t.from}/${t.action}`));
    const illegal = crossProduct(BATCH_LIFECYCLE).filter(
      ({ from, action }) => !legal.has(`${from}/${action}`),
    );
    expect(illegal.length).toBeGreaterThan(0);
    for (const { from, action } of illegal) {
      const applied = applyBatchTransition(from, action);
      expect(applied.ok).toBe(false);
      if (!applied.ok)
        expect(applied.error.context).toMatchObject({ entry: 'batch', from, action });
    }
  });

  it('makes membership editable in exactly one state', () => {
    // `enqueue` is what ends editing, so M08.9's reordering controls have one
    // state to be legal in.
    const enqueues = BATCH_TRANSITIONS.filter((t) => t.action === 'enqueue');
    expect(enqueues).toEqual([{ action: 'enqueue', from: 'draft', to: 'queued' }]);
  });

  it('has two terminal states and no retry, because retrying is a job move', () => {
    expect([...BATCH_TERMINAL_STATUSES]).toEqual(['completed', 'cancelled']);
    for (const status of BATCH_TERMINAL_STATUSES) {
      expect(isTerminalBatchStatus(status)).toBe(true);
      expect(legalBatchActions(status)).toEqual([]);
    }
    expect(BATCH_ACTIONS as readonly string[]).not.toContain('retry');
  });
});

describe('batch and job stay distinguishable', () => {
  it('gives a batch no failure and no interruption of its own', () => {
    // A batch of ten jobs where two failed has not failed; rolling its members'
    // outcomes into one word would destroy the distinction the result rules
    // require every view to show.
    expect(BATCH_STATUSES as readonly string[]).not.toContain('failed');
    expect(BATCH_STATUSES as readonly string[]).not.toContain('interrupted');
    expect(BATCH_ACTIONS as readonly string[]).not.toContain('fail');
    expect(BATCH_ACTIONS as readonly string[]).not.toContain('interrupt');
  });

  it('keeps the two enums from being the same list spelled twice', () => {
    expect([...BATCH_STATUSES].sort()).not.toEqual([...JOB_STATUSES].sort());
    expect([...BATCH_ACTIONS].sort()).not.toEqual([...JOB_ACTIONS].sort());
  });

  it('refuses a job status where a batch status belongs, and the reverse', () => {
    expect(batchStatusSchema.safeParse('interrupted' satisfies JobStatus).success).toBe(false);
    expect(jobStatusSchema.safeParse('draft' satisfies BatchStatus).success).toBe(false);
  });

  it('will not apply a batch action to a job', () => {
    const applied = applyJobTransition('draft' as JobStatus, 'enqueue' as unknown as JobAction);
    expect(applied.ok).toBe(false);
  });

  it('will not apply a job action to a batch', () => {
    const applied = applyBatchTransition('running', 'fail' as unknown as BatchAction);
    expect(applied.ok).toBe(false);
  });
});

describe('the tables themselves', () => {
  it('declare no state that cannot be reached', () => {
    expect(reachableStates(JOB_LIFECYCLE).sort()).toEqual([...JOB_STATUSES].sort());
    expect(reachableStates(BATCH_LIFECYCLE).sort()).toEqual([...BATCH_STATUSES].sort());
  });

  it('declare no action that appears in no row', () => {
    for (const model of [JOB_LIFECYCLE, BATCH_LIFECYCLE] as const) {
      const used = new Set<string>(model.transitions.map((t) => t.action));
      expect([...model.actions].filter((action) => !used.has(action))).toEqual([]);
    }
  });

  it('hold no duplicate row, so one state and action never lead two ways', () => {
    for (const model of [JOB_LIFECYCLE, BATCH_LIFECYCLE] as const) {
      const keys = model.transitions.map((t) => `${t.from}/${t.action}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  });

  it('name every terminal state as a real state of the model', () => {
    for (const model of [JOB_LIFECYCLE, BATCH_LIFECYCLE] as const) {
      for (const status of model.terminal) {
        expect(model.states as readonly string[]).toContain(status);
      }
    }
  });
});

describe('progress', () => {
  it('round-trips the no-progress value a job starts with', () => {
    expect(progressSchema.parse(NO_PROGRESS)).toEqual(NO_PROGRESS);
  });

  it('accepts an exact schedule and a completed count inside it', () => {
    const progress = {
      ...NO_PROGRESS,
      completedMatches: 128,
      scheduledMatches: 256,
      elapsedMs: 4_000,
    };
    expect(progressSchema.parse(progress)).toEqual(progress);
  });

  it('refuses more completed matches than an exact schedule holds', () => {
    const over = { ...NO_PROGRESS, completedMatches: 5, scheduledMatches: 4 };
    expect(progressSchema.safeParse(over).success).toBe(false);
    // The same figures are legal when the total is declared a bound.
    expect(progressSchema.safeParse({ ...over, scheduledIsBound: true }).success).toBe(true);
  });

  it('refuses a bound with no figure to bound', () => {
    expect(progressSchema.safeParse({ ...NO_PROGRESS, scheduledIsBound: true }).success).toBe(
      false,
    );
  });

  it('refuses negative counts and a fractional match', () => {
    expect(progressSchema.safeParse({ ...NO_PROGRESS, completedMatches: -1 }).success).toBe(false);
    expect(progressSchema.safeParse({ ...NO_PROGRESS, completedMatches: 1.5 }).success).toBe(false);
    expect(progressSchema.safeParse({ ...NO_PROGRESS, elapsedMs: -1 }).success).toBe(false);
  });

  it('accepts a stage reference, and refuses an ordinal outside its count', () => {
    const staged = { ...NO_PROGRESS, stage: { stageId: 'finalists', ordinal: 1, total: 2 } };
    expect(progressSchema.parse(staged)).toEqual(staged);
    expect(
      progressSchema.safeParse({ ...staged, stage: { stageId: 'finalists', ordinal: 2, total: 2 } })
        .success,
    ).toBe(false);
  });

  it('lets an adaptive job report a stage whose total it does not know', () => {
    const open = { ...NO_PROGRESS, stage: { stageId: 'block', ordinal: 7, total: null } };
    expect(progressSchema.parse(open)).toEqual(open);
  });

  it('refuses an unknown field', () => {
    expect(progressSchema.safeParse({ ...NO_PROGRESS, percent: 50 }).success).toBe(false);
  });

  it('models neither a percentage nor a remaining-time estimate', () => {
    // Both are derivable where they are defined and dishonest where they are
    // not, and M08.9's rule is that remaining time is shown only when it is
    // honestly available.
    expect(Object.keys(NO_PROGRESS).sort()).toEqual([
      'completedMatches',
      'elapsedMs',
      'scheduledIsBound',
      'scheduledMatches',
      'stage',
    ]);
  });
});
