import { describe, expect, it } from 'vitest';

import {
  DIRECT_JOB_ORIGIN,
  JOB_EXECUTION_MODES,
  MAX_ENVIRONMENTS_PER_RUN,
  MAX_JOB_ATTEMPTS,
  MAX_JOBS_PER_BATCH,
  MAX_NOTE_LENGTH,
  MAX_TAGS,
  NO_ANNOTATIONS,
  RESULT_PATH_MAX_SEGMENTS,
  annotationsSchema,
  catalogBatchDocumentSchema,
  catalogBatchViewOf,
  catalogBatchViewSchema,
  catalogJobDocumentSchema,
  catalogJobViewOf,
  catalogJobViewSchema,
  environmentContentHashesSchema,
  experimentDirectorySchema,
  fullContentHashesOf,
  jobExecutionModeSchema,
  jobExecutionSchema,
  jobOriginSchema,
  jobSpecSchema,
  resultReferenceOf,
  resultReferenceSchema,
  resultRootIdSchema,
  runIdentitySchema,
  statusTimestampProblems,
  storedResultReferenceSchema,
  type CatalogJobDocument,
  type RunIdentity,
} from './catalog.js';
import type { EntryTimestamps } from './identity.js';
import { NO_PROGRESS, JOB_STATUSES, isTerminalJobStatus } from './lifecycle.js';
import { CATALOG_DOCUMENT_VERSION } from './version.js';

const HASHES = {
  mechanicsHash: '1111111111111111',
  pilotInputHash: '2222222222222222',
  presentationHash: '3333333333333333',
  fullContentHash: '4444444444444444',
};

const IDENTITY: RunIdentity = {
  experimentId: 'precon-smoke',
  kind: 'batch',
  seed: 'wave-1-smoke',
  configHash: '0123456789abcdef',
  environments: [{ environmentId: 'wave_one', hashes: HASHES }],
  manifestSchemaVersion: 8,
  softwareCommit: '0913dcc',
};

const LOCATION = { rootId: 'default', directory: 'results/precon-smoke' };

const SPEC = {
  experimentId: 'precon-smoke',
  kind: 'batch' as const,
  seed: 'wave-1-smoke',
  configHash: '0123456789abcdef',
  configSchemaVersion: 1,
};

const EXECUTION = {
  location: LOCATION,
  mode: 'in_process_workers' as const,
  workers: 2,
  attempts: 1,
  lastStartedAt: '2026-08-21T09:05:00.000Z',
  resumedMatches: 0,
};

const TIMESTAMPS: EntryTimestamps = {
  createdAt: '2026-08-21T09:00:00.000Z',
  updatedAt: '2026-08-21T09:30:00.000Z',
  startedAt: null,
  completedAt: null,
};

const JOB: CatalogJobDocument = {
  documentVersion: CATALOG_DOCUMENT_VERSION,
  jobId: 'job_fixture1',
  batchId: 'batch_fixture1',
  label: 'Precon smoke',
  spec: SPEC,
  origin: { kind: 'preset', presetId: 'precon_smoke', stageId: 'matches' },
  purpose: 'exploration',
  sourceClasses: ['ai', 'precon'],
  status: 'queued',
  progress: NO_PROGRESS,
  timestamps: TIMESTAMPS,
  annotations: NO_ANNOTATIONS,
  failure: null,
  execution: null,
  result: null,
};

const BATCH = {
  documentVersion: CATALOG_DOCUMENT_VERSION as typeof CATALOG_DOCUMENT_VERSION,
  batchId: 'batch_fixture1',
  label: 'Wave 1 smoke',
  status: 'draft' as const,
  timestamps: TIMESTAMPS,
  annotations: NO_ANNOTATIONS,
  jobIds: ['job_fixture1'],
};

describe('what a job will run, and where it ran', () => {
  it('is on the document from creation, so a queued job already has a kind', () => {
    // M08.2 recorded the cost of not having this: `a queued job has no kind to
    // filter on`, because the only place a kind appeared was inside a result.
    const parsed = catalogJobDocumentSchema.parse(JOB);
    expect(parsed.status).toBe('queued');
    expect(parsed.result).toBeNull();
    expect(parsed.spec.kind).toBe('batch');
  });

  it('refuses a job with no spec at all', () => {
    const { spec: _spec, ...without } = JOB;
    expect(catalogJobDocumentSchema.safeParse(without).success).toBe(false);
  });

  it('holds the run\u2019s address and never the configuration itself', () => {
    // The configuration is `experimentConfigSchema`'s, and restating it here
    // would be the second copy of the experiment schema M08 forbids.
    expect(Object.keys(jobSpecSchema.parse(SPEC)).sort()).toEqual([
      'configHash',
      'configSchemaVersion',
      'experimentId',
      'kind',
      'seed',
    ]);
  });

  it('refuses a spec whose config hash is not a hash', () => {
    expect(jobSpecSchema.safeParse({ ...SPEC, configHash: 'not a hash' }).success).toBe(false);
    expect(jobSpecSchema.safeParse({ ...SPEC, experimentId: 'Precon Smoke' }).success).toBe(false);
    expect(jobSpecSchema.safeParse({ ...SPEC, unexpected: true }).success).toBe(false);
  });

  it('records the directory a job owns on the document and never on the view', () => {
    const document = catalogJobDocumentSchema.parse({ ...JOB, execution: EXECUTION });
    expect(document.execution?.location).toEqual(LOCATION);

    const view = catalogJobViewOf(document);
    expect(catalogJobViewSchema.parse(view)).toEqual(view);
    expect(JSON.stringify(view)).not.toContain('rootId');
    expect(JSON.stringify(view)).not.toContain('precon-smoke/');
    expect(view.execution).toEqual({
      mode: 'in_process_workers',
      workers: 2,
      attempts: 1,
      lastStartedAt: '2026-08-21T09:05:00.000Z',
      resumedMatches: 0,
    });
  });

  it('has one execution mode, and it is the one that has no argument vector', () => {
    expect(JOB_EXECUTION_MODES).toEqual(['in_process_workers']);
    expect(jobExecutionModeSchema.safeParse('shell').success).toBe(false);
  });

  it('refuses an attempt count below one or past the bound', () => {
    expect(jobExecutionSchema.safeParse({ ...EXECUTION, attempts: 0 }).success).toBe(false);
    expect(
      jobExecutionSchema.safeParse({ ...EXECUTION, attempts: MAX_JOB_ATTEMPTS + 1 }).success,
    ).toBe(false);
    expect(jobExecutionSchema.safeParse({ ...EXECUTION, resumedMatches: -1 }).success).toBe(false);
  });

  it('cannot carry a directory that escapes its root', () => {
    expect(
      jobExecutionSchema.safeParse({
        ...EXECUTION,
        location: { rootId: 'default', directory: '../elsewhere' },
      }).success,
    ).toBe(false);
  });
});

const started = (status: CatalogJobDocument['status']): CatalogJobDocument => ({
  ...JOB,
  status,
  timestamps: {
    ...TIMESTAMPS,
    startedAt: '2026-08-21T09:05:00.000Z',
    completedAt: isTerminalJobStatus(status) ? '2026-08-21T09:25:00.000Z' : null,
  },
});

/* ------------------------------------------------------- result references */

describe('content identity', () => {
  it('keeps the four addresses apart rather than flattening them into one', () => {
    // M01.3 split the address by the question it answers; a catalog that
    // recombined them would re-create the failure that split caused.
    expect(environmentContentHashesSchema.parse(HASHES)).toEqual(HASHES);
    expect(Object.keys(HASHES).sort()).toEqual([
      'fullContentHash',
      'mechanicsHash',
      'pilotInputHash',
      'presentationHash',
    ]);
  });

  it('refuses a run with no environment, and one with a duplicate', () => {
    expect(runIdentitySchema.safeParse({ ...IDENTITY, environments: [] }).success).toBe(false);
    expect(
      runIdentitySchema.safeParse({
        ...IDENTITY,
        environments: [IDENTITY.environments[0], IDENTITY.environments[0]],
      }).success,
    ).toBe(false);
  });

  it('records both arms of a comparison run rather than privileging one', () => {
    const compared = {
      ...IDENTITY,
      kind: 'comparison' as const,
      environments: [
        { environmentId: 'before', hashes: HASHES },
        { environmentId: 'after', hashes: { ...HASHES, fullContentHash: '5555555555555555' } },
      ],
    };
    const parsed = runIdentitySchema.parse(compared);
    expect(fullContentHashesOf(parsed)).toEqual(['4444444444444444', '5555555555555555']);
  });

  it('reports each distinct content address once, in a stable order', () => {
    const twice = {
      ...IDENTITY,
      environments: [
        { environmentId: 'b_seat', hashes: HASHES },
        { environmentId: 'a_seat', hashes: HASHES },
      ],
    };
    expect(fullContentHashesOf(runIdentitySchema.parse(twice))).toEqual(['4444444444444444']);
  });

  it('bounds the environment list', () => {
    const many = Array.from({ length: MAX_ENVIRONMENTS_PER_RUN + 1 }, (_, i) => ({
      environmentId: `env_${String(i)}`,
      hashes: HASHES,
    }));
    expect(runIdentitySchema.safeParse({ ...IDENTITY, environments: many }).success).toBe(false);
  });

  it('round-trips a run identity through JSON', () => {
    expect(runIdentitySchema.parse(JSON.parse(JSON.stringify(IDENTITY)))).toEqual(IDENTITY);
  });

  it('records the manifest version rather than owning it', () => {
    // The number moves when `@tcg/simulator` moves it. A catalog written today
    // has to stay able to say "this run was written by a build whose manifests
    // were version 8".
    expect(
      runIdentitySchema.parse({ ...IDENTITY, manifestSchemaVersion: 99 }).manifestSchemaVersion,
    ).toBe(99);
    expect(runIdentitySchema.safeParse({ ...IDENTITY, manifestSchemaVersion: 0 }).success).toBe(
      false,
    );
  });

  it('accepts a run whose software commit could not be detected', () => {
    expect(
      runIdentitySchema.parse({ ...IDENTITY, softwareCommit: null }).softwareCommit,
    ).toBeNull();
    expect(runIdentitySchema.safeParse({ ...IDENTITY, softwareCommit: 'HEAD' }).success).toBe(
      false,
    );
  });

  it('refuses a malformed experiment ID, seed or config hash', () => {
    expect(runIdentitySchema.safeParse({ ...IDENTITY, experimentId: 'Precon Smoke' }).success).toBe(
      false,
    );
    expect(runIdentitySchema.safeParse({ ...IDENTITY, seed: '' }).success).toBe(false);
    expect(runIdentitySchema.safeParse({ ...IDENTITY, configHash: 'nothex!!' }).success).toBe(
      false,
    );
  });

  it('refuses an unknown field, including a result somebody tried to cache', () => {
    expect(runIdentitySchema.safeParse({ ...IDENTITY, winRate: 0.51 }).success).toBe(false);
    expect(runIdentitySchema.safeParse({ ...IDENTITY, matchesPlayed: 512 }).success).toBe(false);
  });
});

describe('the result location never leaves the server', () => {
  it('names a root by identifier, which means nothing without configuration', () => {
    expect(resultRootIdSchema.parse('default')).toBe('default');
    expect(resultRootIdSchema.safeParse('/var/results').success).toBe(false);
    expect(resultRootIdSchema.safeParse('C:\\results').success).toBe(false);
  });

  it('accepts a plain relative directory', () => {
    expect(experimentDirectorySchema.parse('results/precon-smoke')).toBe('results/precon-smoke');
  });

  it('refuses every spelling of a traversal or an absolute path', () => {
    for (const wrong of [
      '../escape',
      'results/../../etc',
      '/var/results',
      'C:\\results',
      'results\\run',
      './results',
      '',
    ]) {
      expect(experimentDirectorySchema.safeParse(wrong).success).toBe(false);
    }
  });

  it('bounds the depth, at the constant and one past it', () => {
    const deep = Array.from({ length: RESULT_PATH_MAX_SEGMENTS }, (_, i) => `d${String(i)}`);
    expect(experimentDirectorySchema.safeParse(deep.join('/')).success).toBe(true);
    expect(experimentDirectorySchema.safeParse([...deep, 'more'].join('/')).success).toBe(false);
  });

  it('round-trips a stored reference, which holds identity and location together', () => {
    const stored = { identity: IDENTITY, location: LOCATION };
    expect(storedResultReferenceSchema.parse(stored)).toEqual(stored);
  });
});

describe('the client-visible reference has nothing to strip', () => {
  it('carries identity and no location at all', () => {
    const view = resultReferenceOf({ identity: IDENTITY, location: LOCATION });
    expect(view).toEqual({ identity: IDENTITY });
    expect(JSON.stringify(view)).not.toContain('default');
    expect(JSON.stringify(view)).not.toContain('results/');
  });

  it('refuses a location added back by hand', () => {
    // Privacy that is a type cannot be forgotten: a future tranche that wants a
    // location has to widen this schema deliberately.
    expect(
      resultReferenceSchema.safeParse({ identity: IDENTITY, location: LOCATION }).success,
    ).toBe(false);
  });

  it('round-trips through JSON unchanged', () => {
    const view = resultReferenceOf({ identity: IDENTITY, location: LOCATION });
    expect(resultReferenceSchema.parse(JSON.parse(JSON.stringify(view)))).toEqual(view);
  });
});

/* ------------------------------------------------------------- annotations */

describe('annotations', () => {
  it('round-trips the empty set a job starts with', () => {
    expect(annotationsSchema.parse(NO_ANNOTATIONS)).toEqual(NO_ANNOTATIONS);
  });

  it('carries exactly tags, a note and a baseline mark', () => {
    expect(Object.keys(NO_ANNOTATIONS).sort()).toEqual(['baseline', 'note', 'tags']);
  });

  it('accepts a tagged baseline with a note', () => {
    const annotated = {
      tags: ['wave-1', 'precon-smoke'],
      note: 'Pinned before the patch.',
      baseline: true,
    };
    expect(annotationsSchema.parse(annotated)).toEqual(annotated);
  });

  it('refuses duplicate tags and more than the bound', () => {
    expect(
      annotationsSchema.safeParse({ ...NO_ANNOTATIONS, tags: ['a-tag', 'a-tag'] }).success,
    ).toBe(false);
    const many = Array.from({ length: MAX_TAGS + 1 }, (_, i) => `tag-${String(i)}`);
    expect(annotationsSchema.safeParse({ ...NO_ANNOTATIONS, tags: many }).success).toBe(false);
  });

  it('bounds the note', () => {
    expect(
      annotationsSchema.safeParse({ ...NO_ANNOTATIONS, note: 'x'.repeat(MAX_NOTE_LENGTH) }).success,
    ).toBe(true);
    expect(
      annotationsSchema.safeParse({ ...NO_ANNOTATIONS, note: 'x'.repeat(MAX_NOTE_LENGTH + 1) })
        .success,
    ).toBe(false);
  });

  it('refuses an unknown annotation', () => {
    expect(annotationsSchema.safeParse({ ...NO_ANNOTATIONS, verdict: 'overpowered' }).success).toBe(
      false,
    );
  });
});

/* ------------------------------------------------ status/timestamp agreement */

describe('a status and its instants agree', () => {
  it('requires a completion instant of every terminal status and of no other', () => {
    for (const status of JOB_STATUSES) {
      const withNone = statusTimestampProblems(status, {
        ...TIMESTAMPS,
        startedAt: '2026-08-21T09:05:00.000Z',
      });
      const withOne = statusTimestampProblems(status, {
        ...TIMESTAMPS,
        startedAt: '2026-08-21T09:05:00.000Z',
        completedAt: '2026-08-21T09:25:00.000Z',
      });
      if (isTerminalJobStatus(status)) {
        expect(withNone.join(' ')).toContain('must record `completedAt`');
        expect(withOne).toEqual([]);
      } else {
        expect(withNone).toEqual([]);
        expect(withOne.join(' ')).toContain('must be null');
      }
    }
  });

  it('requires a start instant of every status unreachable without starting', () => {
    for (const status of ['running', 'completed', 'failed'] as const) {
      expect(statusTimestampProblems(status, TIMESTAMPS).join(' ')).toContain(
        '`startedAt` is required',
      );
    }
  });

  it('lets a job cancelled straight out of the queue have never started', () => {
    expect(
      statusTimestampProblems('cancelled', {
        ...TIMESTAMPS,
        completedAt: '2026-08-21T09:25:00.000Z',
      }),
    ).toEqual([]);
  });

  it('makes a retried job clear its completion instant', () => {
    // `failed → queued` is only a legal document once `completedAt` is null, so
    // a retried job cannot sit in the queue still claiming it finished.
    const stillClaiming = statusTimestampProblems('queued', {
      ...TIMESTAMPS,
      completedAt: '2026-08-21T09:25:00.000Z',
    });
    expect(stillClaiming.join(' ')).toContain('must be null');
  });
});

/* --------------------------------------------------------- job documents */

describe('a catalog job document', () => {
  it('round-trips through JSON', () => {
    expect(catalogJobDocumentSchema.parse(JSON.parse(JSON.stringify(JOB)))).toEqual(JOB);
  });

  it('round-trips a completed job holding a result reference', () => {
    const completed: CatalogJobDocument = {
      ...started('completed'),
      progress: { ...NO_PROGRESS, completedMatches: 256, scheduledMatches: 256 },
      result: { identity: IDENTITY, location: LOCATION },
    };
    expect(catalogJobDocumentSchema.parse(JSON.parse(JSON.stringify(completed)))).toEqual(
      completed,
    );
  });

  it('round-trips a failed job holding its structured diagnostics', () => {
    const failed: CatalogJobDocument = {
      ...started('failed'),
      failure: {
        severity: 'error',
        code: 'admin/schema',
        message: 'The configuration named a format this build does not have.',
        path: 'config.environment.formatId',
        context: { rootId: 'default' },
      },
    };
    expect(catalogJobDocumentSchema.parse(failed)).toEqual(failed);
  });

  it('refuses a failure whose context carries a credential', () => {
    expect(
      catalogJobDocumentSchema.safeParse({
        ...started('failed'),
        failure: {
          severity: 'error',
          code: 'admin/schema',
          message: 'x',
          context: { adminToken: 'sk-live' },
        },
      }).success,
    ).toBe(false);
  });

  it('stamps the document version, and refuses one from the future', () => {
    expect(catalogJobDocumentSchema.parse(JOB).documentVersion).toBe(CATALOG_DOCUMENT_VERSION);
    expect(
      catalogJobDocumentSchema.safeParse({
        ...JOB,
        documentVersion: CATALOG_DOCUMENT_VERSION + 1,
      }).success,
    ).toBe(false);
    const { documentVersion: _omitted, ...withoutVersion } = JOB;
    expect(catalogJobDocumentSchema.safeParse(withoutVersion).success).toBe(false);
  });

  it('applies the status/timestamp rule at the document boundary', () => {
    expect(catalogJobDocumentSchema.safeParse({ ...JOB, status: 'completed' }).success).toBe(false);
    expect(catalogJobDocumentSchema.safeParse(started('completed')).success).toBe(true);
  });

  it('refuses an unknown field, including a copied result', () => {
    expect(catalogJobDocumentSchema.safeParse({ ...JOB, winner: 'seat_1' }).success).toBe(false);
    expect(catalogJobDocumentSchema.safeParse({ ...JOB, summary: {} }).success).toBe(false);
  });

  it('refuses a malformed ID, purpose or classification', () => {
    expect(catalogJobDocumentSchema.safeParse({ ...JOB, jobId: 'batch_fixture1' }).success).toBe(
      false,
    );
    expect(catalogJobDocumentSchema.safeParse({ ...JOB, purpose: 'discovery' }).success).toBe(
      false,
    );
    expect(catalogJobDocumentSchema.safeParse({ ...JOB, sourceClasses: [] }).success).toBe(false);
    expect(
      catalogJobDocumentSchema.safeParse({ ...JOB, sourceClasses: ['precon', 'ai'] }).success,
    ).toBe(false);
  });
});

describe('a catalog job view', () => {
  it('drops the document version and the stored location, and nothing else', () => {
    const document: CatalogJobDocument = {
      ...started('completed'),
      result: { identity: IDENTITY, location: LOCATION },
    };
    const view = catalogJobViewOf(document);
    expect(catalogJobViewSchema.parse(view)).toEqual(view);
    expect(view.result).toEqual({ identity: IDENTITY });
    expect(view.jobId).toBe(document.jobId);
    expect(view.annotations).toEqual(document.annotations);
    expect(view.progress).toEqual(document.progress);
  });

  it('carries no server path anywhere in its serialization', () => {
    const view = catalogJobViewOf({
      ...started('completed'),
      result: { identity: IDENTITY, location: LOCATION },
    });
    const json = JSON.stringify(view);
    expect(json).not.toContain('rootId');
    expect(json).not.toContain('directory');
    expect(json).not.toContain('results/precon-smoke');
  });

  it('refuses a document version or a location put back by hand', () => {
    const view = catalogJobViewOf(JOB);
    expect(
      catalogJobViewSchema.safeParse({ ...view, documentVersion: CATALOG_DOCUMENT_VERSION })
        .success,
    ).toBe(false);
    expect(
      catalogJobViewSchema.safeParse({
        ...view,
        result: { identity: IDENTITY, location: LOCATION },
      }).success,
    ).toBe(false);
  });

  it('applies the same status/timestamp rule the document does', () => {
    const view = catalogJobViewOf(JOB);
    expect(catalogJobViewSchema.safeParse({ ...view, status: 'completed' }).success).toBe(false);
  });
});

/* -------------------------------------------------------- batch documents */

describe('a catalog batch document', () => {
  it('round-trips through JSON', () => {
    expect(catalogBatchDocumentSchema.parse(JSON.parse(JSON.stringify(BATCH)))).toEqual(BATCH);
  });

  it('holds ordered membership by reference, and keeps the administrator\u2019s order', () => {
    const ordered = { ...BATCH, jobIds: ['job_third1', 'job_first1', 'job_secnd1'] };
    expect(catalogBatchDocumentSchema.parse(ordered).jobIds).toEqual(ordered.jobIds);
  });

  it('accepts an empty batch, which is what `draft` starts as', () => {
    expect(catalogBatchDocumentSchema.parse({ ...BATCH, jobIds: [] }).jobIds).toEqual([]);
  });

  it('refuses a job listed twice, and more jobs than the bound', () => {
    expect(
      catalogBatchDocumentSchema.safeParse({ ...BATCH, jobIds: ['job_fixture1', 'job_fixture1'] })
        .success,
    ).toBe(false);
    const many = Array.from(
      { length: MAX_JOBS_PER_BATCH + 1 },
      (_, i) => `job_${String(i).padStart(6, '0')}`,
    );
    expect(catalogBatchDocumentSchema.safeParse({ ...BATCH, jobIds: many }).success).toBe(false);
  });

  it('embeds no job document, so a job can be written without its siblings', () => {
    expect(catalogBatchDocumentSchema.safeParse({ ...BATCH, jobs: [JOB] } as never).success).toBe(
      false,
    );
  });

  it('takes a batch status and refuses a job one', () => {
    expect(catalogBatchDocumentSchema.parse({ ...BATCH, status: 'cancelling' }).status).toBe(
      'cancelling',
    );
    expect(catalogBatchDocumentSchema.safeParse({ ...BATCH, status: 'interrupted' }).success).toBe(
      false,
    );
    expect(catalogBatchDocumentSchema.safeParse({ ...BATCH, status: 'failed' }).success).toBe(
      false,
    );
  });

  it('has no progress and no result of its own, because a batch plays nothing', () => {
    expect(catalogBatchDocumentSchema.safeParse({ ...BATCH, progress: NO_PROGRESS }).success).toBe(
      false,
    );
    expect(catalogBatchDocumentSchema.safeParse({ ...BATCH, result: null }).success).toBe(false);
  });

  it('refuses a document version from the future', () => {
    expect(
      catalogBatchDocumentSchema.safeParse({
        ...BATCH,
        documentVersion: CATALOG_DOCUMENT_VERSION + 1,
      }).success,
    ).toBe(false);
  });
});

describe('a catalog batch view', () => {
  it('drops the document version and nothing else', () => {
    const view = catalogBatchViewOf(BATCH);
    expect(catalogBatchViewSchema.parse(view)).toEqual(view);
    expect(view).not.toHaveProperty('documentVersion');
    expect(view.jobIds).toEqual(BATCH.jobIds);
  });
});

/* ------------------------------------------------ the authority boundary */

describe('the catalog references evidence and never owns it', () => {
  it('has no way to express deleting an experiment directory', () => {
    // Deleting a catalog entry must not mean deleting a run. The entry holds a
    // reference, and a reference is not ownership.
    const document = JSON.stringify(catalogJobDocumentSchema.parse(JOB));
    for (const verb of ['delete', 'remove', 'purge', 'unlink']) {
      expect(document.toLowerCase()).not.toContain(verb);
    }
  });

  it('lets a job exist with no result at all, which is a run that has none yet', () => {
    expect(catalogJobDocumentSchema.parse(JOB).result).toBeNull();
  });

  it('carries no field that could hold a result', () => {
    // Every number a result view shows is read back out of the canonical
    // artefacts. A copy is a thing that can disagree with the original.
    const fields = Object.keys(catalogJobDocumentSchema.parse(JOB));
    for (const banned of ['summary', 'matches', 'winRate', 'report', 'results', 'decks']) {
      expect(fields).not.toContain(banned);
    }
  });

  it('retains the hashes and canonical-run identity a reader needs to find the run', () => {
    const completed = catalogJobDocumentSchema.parse({
      ...started('completed'),
      result: { identity: IDENTITY, location: LOCATION },
    });
    expect(completed.result?.identity.configHash).toBe(IDENTITY.configHash);
    expect(completed.result?.identity.environments[0]?.hashes).toEqual(HASHES);
    expect(completed.result?.identity.experimentId).toBe('precon-smoke');
    expect(completed.result?.identity.seed).toBe('wave-1-smoke');
    expect(completed.result?.location).toEqual(LOCATION);
  });
});

describe('where a job came from (M08.6)', () => {
  it('names the preset and the stage a job was expanded from', () => {
    const parsed = jobOriginSchema.parse({
      kind: 'preset',
      presetId: 'precon_standard',
      stageId: 'matches',
    });
    expect(parsed).toEqual({ kind: 'preset', presetId: 'precon_standard', stageId: 'matches' });
  });

  it('says `direct` for a configuration that came from nowhere in particular', () => {
    expect(jobOriginSchema.parse(DIRECT_JOB_ORIGIN)).toEqual({ kind: 'direct' });
    expect(jobOriginSchema.safeParse({ kind: 'direct', presetId: 'precon_smoke' }).success).toBe(
      false,
    );
  });

  it('refuses a preset origin with no stage, so a limitation cannot be attached to nothing', () => {
    expect(jobOriginSchema.safeParse({ kind: 'preset', presetId: 'precon_smoke' }).success).toBe(
      false,
    );
    expect(
      jobOriginSchema.safeParse({ kind: 'preset', presetId: 'not_a_preset', stageId: 'matches' })
        .success,
    ).toBe(false);
  });

  it('is required on a job document, because an optional one is one a view must handle missing', () => {
    const { origin: _origin, ...withoutOrigin } = JOB;
    expect(catalogJobDocumentSchema.safeParse(withoutOrigin).success).toBe(false);
  });

  it('reaches the client, because a result view needs it to find the limitations', () => {
    expect(catalogJobViewOf(JOB).origin).toEqual(JOB.origin);
  });
});
