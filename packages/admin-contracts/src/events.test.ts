import { describe, expect, it } from 'vitest';

import { NO_ANNOTATIONS } from './catalog.js';
import {
  JOB_EVENT_CAUSES,
  JOB_EVENT_KINDS,
  jobEventLogSchema,
  jobEventSchema,
  type JobEvent,
} from './events.js';
import { JOB_ACTIONS, JOB_STATUSES, JOB_TRANSITIONS } from './lifecycle.js';
import { JOB_EVENT_VERSION, refuseFutureVersion } from './version.js';

const JOB = 'job_aaaaaaaa11';
const BATCH = 'batch_bbbbbbbb22';
const AT = '2026-08-21T09:30:00.000Z';

const created: JobEvent = {
  eventVersion: JOB_EVENT_VERSION,
  jobId: JOB,
  at: AT,
  kind: 'created',
  batchId: BATCH,
  label: 'Precon smoke',
  purpose: 'exploration',
  sourceClasses: ['ai', 'precon'],
};

const transition: JobEvent = {
  eventVersion: JOB_EVENT_VERSION,
  jobId: JOB,
  at: AT,
  kind: 'transition',
  action: 'start',
  from: 'queued',
  to: 'running',
  cause: 'operator',
  failure: null,
};

const identity = {
  experimentId: 'precon-smoke',
  kind: 'batch' as const,
  seed: 'seed-1',
  configHash: 'abcdef0123456789',
  environments: [
    {
      environmentId: 'baseline',
      hashes: {
        mechanicsHash: 'aaaaaaaaaaaaaaaa',
        pilotInputHash: 'bbbbbbbbbbbbbbbb',
        presentationHash: 'cccccccccccccccc',
        fullContentHash: 'dddddddddddddddd',
      },
    },
  ],
  manifestSchemaVersion: 8,
  softwareCommit: '2b1a6ec',
};

describe('every event kind round-trips', () => {
  it('accepts each of the four kinds, and the union is total over them', () => {
    const samples: JobEvent[] = [
      created,
      transition,
      {
        eventVersion: JOB_EVENT_VERSION,
        jobId: JOB,
        at: AT,
        kind: 'annotated',
        annotations: { ...NO_ANNOTATIONS, tags: ['precon-smoke'], baseline: true },
      },
      { eventVersion: JOB_EVENT_VERSION, jobId: JOB, at: AT, kind: 'result_attached', identity },
    ];
    for (const sample of samples) {
      expect(jobEventSchema.parse(sample)).toEqual(sample);
    }
    expect(samples.map((sample) => sample.kind).sort()).toEqual([...JOB_EVENT_KINDS].sort());
  });

  it('survives the JSONL round trip a log is actually stored as', () => {
    // One line per record, each independently parseable: the property the
    // damaged-tail reader depends on.
    const line = JSON.stringify(transition);
    expect(line).not.toContain('\n');
    expect(jobEventSchema.parse(JSON.parse(line))).toEqual(transition);
  });
});

describe('an event is strict about what it is', () => {
  it('refuses an unknown field', () => {
    expect(jobEventSchema.safeParse({ ...transition, elapsedMs: 12 }).success).toBe(false);
  });

  it('refuses a kind the union does not declare', () => {
    expect(jobEventSchema.safeParse({ ...transition, kind: 'progress' }).success).toBe(false);
  });

  it('refuses a field belonging to another kind', () => {
    // A `created` line cannot smuggle a transition's action in beside it.
    expect(jobEventSchema.safeParse({ ...created, action: 'start' }).success).toBe(false);
  });

  it('refuses an identifier that is not a job ID, so a line names its own subject', () => {
    expect(jobEventSchema.safeParse({ ...transition, jobId: BATCH }).success).toBe(false);
  });

  it('refuses a timestamp that is not the sortable UTC form', () => {
    expect(jobEventSchema.safeParse({ ...transition, at: '2026-08-21T09:30:00Z' }).success).toBe(
      false,
    );
  });
});

describe('a transition line names a move this build could make', () => {
  it('accepts every declared transition in the job table', () => {
    for (const row of JOB_TRANSITIONS) {
      const parsed = jobEventSchema.safeParse({
        ...transition,
        action: row.action,
        from: row.from,
        to: row.to,
      });
      expect(`${row.action}: ${String(parsed.success)}`).toBe(`${row.action}: true`);
    }
  });

  it('names every action and every state the lifecycle declares', () => {
    // The vocabularies are shared rather than restated, so a state added to the
    // lifecycle is loggable the moment it exists.
    for (const action of JOB_ACTIONS) {
      expect(jobEventSchema.safeParse({ ...transition, action }).success).toBe(true);
    }
    for (const status of JOB_STATUSES) {
      expect(jobEventSchema.safeParse({ ...transition, to: status }).success).toBe(true);
    }
  });

  it('records both endpoints, so a line written by another build is read rather than re-derived', () => {
    // `to` is not recomputed from `from` and `action`: the table belongs to the
    // build that wrote the line, not to the build reading it.
    const older = {
      ...transition,
      action: 'cancel' as const,
      from: 'running' as const,
      to: 'cancelled' as const,
    };
    expect(
      jobEventSchema.parse(older).kind === 'transition' && jobEventSchema.parse(older),
    ).toBeTruthy();
  });

  it('carries the diagnostics of a failure on the line that failed', () => {
    const failed = jobEventSchema.parse({
      ...transition,
      action: 'fail',
      from: 'running',
      to: 'failed',
      cause: 'runner',
      failure: {
        severity: 'error',
        code: 'admin/schema',
        message: 'The configuration no longer matches current content.',
      },
    });
    expect(failed.kind === 'transition' && failed.failure?.code).toBe('admin/schema');
  });

  it('refuses a failure whose context would leak a path or a credential', () => {
    // The admin error schema is reused rather than restated, so the context
    // rules that keep a token out of a response also keep one out of the log.
    for (const context of [{ adminToken: 'hunter2' }, { outputRoot: 'D:/results/run-1' }]) {
      expect(
        jobEventSchema.safeParse({
          ...transition,
          action: 'fail',
          to: 'failed',
          failure: { severity: 'error', code: 'admin/schema', message: 'no', context },
        }).success,
      ).toBe(false);
    }
  });
});

describe('the causes stay separable', () => {
  it('accepts each declared cause', () => {
    for (const cause of JOB_EVENT_CAUSES) {
      expect(jobEventSchema.safeParse({ ...transition, cause }).success).toBe(true);
    }
  });

  it('refuses an undeclared one', () => {
    expect(jobEventSchema.safeParse({ ...transition, cause: 'automatic' }).success).toBe(false);
  });

  it('lets a recovery interrupt be told from an operator cancel of the same job', () => {
    const recovered = jobEventSchema.parse({
      ...transition,
      action: 'interrupt',
      from: 'running',
      to: 'interrupted',
      cause: 'recovery',
    });
    const cancelled = jobEventSchema.parse({
      ...transition,
      action: 'cancel',
      from: 'running',
      to: 'cancelling',
      cause: 'operator',
    });
    expect(recovered).not.toEqual(cancelled);
  });
});

describe('a result line carries identity and nothing resolvable', () => {
  it('accepts the run identity', () => {
    const parsed = jobEventSchema.parse({
      eventVersion: JOB_EVENT_VERSION,
      jobId: JOB,
      at: AT,
      kind: 'result_attached',
      identity,
    });
    expect(parsed.kind === 'result_attached' && parsed.identity.experimentId).toBe('precon-smoke');
  });

  it('has nowhere to put a configured root or a directory', () => {
    const attached = {
      eventVersion: JOB_EVENT_VERSION,
      jobId: JOB,
      at: AT,
      kind: 'result_attached',
      identity,
    };
    expect(
      jobEventSchema.safeParse({
        ...attached,
        location: { rootId: 'default', directory: 'run-1' },
      }).success,
    ).toBe(false);
    expect(JSON.stringify(jobEventSchema.parse(attached))).not.toContain('rootId');
  });
});

describe('a log reports what it could not read', () => {
  it('carries the good lines and the damaged ones side by side', () => {
    const log = jobEventLogSchema.parse({
      jobId: JOB,
      events: [created, transition],
      skipped: [{ line: 3, reason: 'unparseable JSON (likely a truncated tail)' }],
    });
    expect(log.events).toHaveLength(2);
    expect(log.skipped[0]?.line).toBe(3);
  });

  it('is a legal shape when nothing was skipped and when nothing was read', () => {
    expect(jobEventLogSchema.safeParse({ jobId: JOB, events: [], skipped: [] }).success).toBe(true);
  });

  it('refuses a skipped entry with no reason, so a drop is never silent', () => {
    expect(
      jobEventLogSchema.safeParse({ jobId: JOB, events: [], skipped: [{ line: 1, reason: '' }] })
        .success,
    ).toBe(false);
  });
});

describe('a line from a newer build is refused readably', () => {
  it('fails the literal version at the schema', () => {
    expect(
      jobEventSchema.safeParse({ ...transition, eventVersion: JOB_EVENT_VERSION + 1 }).success,
    ).toBe(false);
  });

  it('gets the repository’s newer-build sentence from its own version domain', () => {
    const refusal = refuseFutureVersion('jobEvent', JOB_EVENT_VERSION + 1, 'eventVersion');
    expect(refusal?.code).toBe('admin/unsupported_version');
    expect(refusal?.message).toContain('admin job event version');
    expect(refusal?.message).toContain('Update the application.');
  });
});
