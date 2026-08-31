import { describe, expect, it } from 'vitest';

import {
  ARTIFACT_FORMATS,
  ARTIFACT_MEDIA_TYPES,
  MAX_ARTIFACT_BYTES,
  RESULT_ARTIFACTS,
  RESULT_ARTIFACT_NAMES,
  resultArtifactListingSchema,
  resultArtifactSchema,
  suggestedArtifactFilename,
} from './artifacts.js';
import { looksLikeFilesystemPath } from './errors.js';

const IDENTITY = {
  experimentId: 'precon-standard',
  kind: 'batch' as const,
  seed: 'precon-standard|r1',
  configHash: 'abcdef0123456789',
  environments: [
    {
      environmentId: 'wave_1',
      hashes: {
        mechanicsHash: '2222222222222222',
        pilotInputHash: '3333333333333333',
        presentationHash: '4444444444444444',
        fullContentHash: '1111111111111111',
      },
    },
  ],
  manifestSchemaVersion: 8,
  softwareCommit: '900390d',
};

function artifact(overrides: Record<string, unknown> = {}) {
  return resultArtifactSchema.safeParse({
    jobId: 'job_fixture0001',
    artifact: 'report',
    filename: 'report.md',
    suggestedFilename: 'precon-standard-job_fixture0001-report.md',
    format: 'markdown',
    mediaType: 'text/markdown',
    byteLength: 12,
    content: '# A report\n',
    identity: IDENTITY,
    readAt: '2026-08-31T10:00:00.000Z',
    ...overrides,
  });
}

describe('the downloadable documents', () => {
  it('names every one of them, and each is a file name rather than a location', () => {
    expect(RESULT_ARTIFACT_NAMES.length).toBeGreaterThan(0);
    for (const name of RESULT_ARTIFACT_NAMES) {
      const definition = RESULT_ARTIFACTS[name];
      expect(definition.name).toBe(name);
      expect(looksLikeFilesystemPath(definition.filename)).toBe(false);
      expect(definition.label.length).toBeGreaterThan(0);
      expect(definition.summary.length).toBeGreaterThan(0);
    }
  });

  it('offers all three formats the milestone asks for, and nothing else', () => {
    const used = new Set(RESULT_ARTIFACT_NAMES.map((name) => RESULT_ARTIFACTS[name].format));
    expect([...used].sort()).toEqual([...ARTIFACT_FORMATS].sort());
  });

  it('gives every format a media type, so a saved file opens in the right thing', () => {
    for (const format of ARTIFACT_FORMATS) {
      expect(ARTIFACT_MEDIA_TYPES[format]).toMatch(/^[a-z]+\/[a-z+-]+$/);
    }
  });

  it('never names two documents the same file', () => {
    const filenames = RESULT_ARTIFACT_NAMES.map((name) => RESULT_ARTIFACTS[name].filename);
    expect(new Set(filenames).size).toBe(filenames.length);
  });

  it('offers no raw match stream, replay or checkpoint', () => {
    // Deliberate, and stated in `artifacts.ts`: an unbounded append-only stream
    // does not belong in a JSON envelope, and a directory would need a second way
    // to name something inside a run.
    const filenames = RESULT_ARTIFACT_NAMES.map((name) => RESULT_ARTIFACTS[name].filename);
    expect(filenames).not.toContain('matches.jsonl');
    expect(filenames).not.toContain('matches.header.json');
    for (const filename of filenames) {
      expect(filename).not.toMatch(/replays|checkpoints|environments/);
    }
  });
});

describe('one artifact on the wire', () => {
  it('round-trips a document the run wrote', () => {
    const parsed = artifact();
    expect(parsed.success).toBe(true);
    expect(parsed.data?.content).toBe('# A report\n');
  });

  it('refuses a media type that does not match the format it declares', () => {
    expect(artifact({ mediaType: 'text/csv' }).success).toBe(false);
  });

  it('refuses a file name that is not the one its definition fixes', () => {
    expect(artifact({ filename: 'summary.json' }).success).toBe(false);
  });

  it('refuses a document larger than this service will send', () => {
    expect(artifact({ content: 'x'.repeat(MAX_ARTIFACT_BYTES + 1) }).success).toBe(false);
  });

  it('carries the provenance with the file rather than only beside it', () => {
    const parsed = artifact();
    expect(parsed.data?.identity.seed).toBe('precon-standard|r1');
    expect(parsed.data?.identity.environments[0]?.hashes.fullContentHash).toBe('1111111111111111');
  });

  it('has nowhere to put a directory or a root identifier', () => {
    expect(artifact({ location: { rootId: 'default', directory: 'runs/x' } }).success).toBe(false);
  });
});

describe('what one run has', () => {
  it('reports every document, present or not, so absence is distinguishable from omission', () => {
    const listing = resultArtifactListingSchema.safeParse({
      jobId: 'job_fixture0001',
      identity: IDENTITY,
      artifacts: RESULT_ARTIFACT_NAMES.map((name) => ({
        artifact: name,
        format: RESULT_ARTIFACTS[name].format,
        present: name === 'summary',
        byteLength: name === 'summary' ? 400 : null,
        tooLarge: false,
      })),
      readAt: '2026-08-31T10:00:00.000Z',
    });
    expect(listing.success).toBe(true);
    expect(listing.data?.artifacts).toHaveLength(RESULT_ARTIFACT_NAMES.length);
  });

  it('refuses a listing that leaves a document out', () => {
    const listing = resultArtifactListingSchema.safeParse({
      jobId: 'job_fixture0001',
      identity: IDENTITY,
      artifacts: [
        { artifact: 'summary', format: 'json', present: true, byteLength: 4, tooLarge: false },
      ],
      readAt: '2026-08-31T10:00:00.000Z',
    });
    expect(listing.success).toBe(false);
  });
});

describe('the name a saved copy carries', () => {
  it('names the experiment, the job and the file, and is not a path', () => {
    const name = suggestedArtifactFilename('precon-standard', 'job_fixture0001', 'card_usage');
    expect(name).toBe('precon-standard-job_fixture0001-card-usage.csv');
    expect(looksLikeFilesystemPath(name)).toBe(false);
  });
});
