import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { makeDeck } from '@tcg/deck-generator';
import {
  adaptiveRawRecordSchema,
  adaptiveResultSchema,
  parseAdaptiveRawRecord,
  parseAdaptiveResult,
} from './envelopes.js';
import type { AdaptiveCheckpoint, AdaptiveCheckpointLineage } from './checkpoint.js';
import {
  adaptiveRevisionSeedPath,
  makeAdaptiveRevision,
  type AdaptiveRevision,
} from './revision.js';
import { buildAdaptiveResult, type AdaptiveResultPayload } from './report.js';

/**
 * M08.16A: the envelopes' shared identity fields and version refusal.
 * `result` stayed empty at schemaVersion 1 through M08.16A-M08.18A and moved
 * to schemaVersion 2 in M08.18D when it grew the canonical report payload
 * defined in `./report.ts`. `raw` moved to schemaVersion 2 in M08.16C when it
 * grew a `generations` field and to schemaVersion 3 in M08.18D when it grew
 * `series` and `screeningRounds`. `checkpoint` moved to schemaVersion 2 in
 * M08.18A when it grew real resumable state, so it is checked on its own in
 * `./checkpoint.test.ts` rather than through a shared `describe.each` here.
 */

const EXPERIMENT_ID = 'envelope-test';

function identity() {
  return { experimentId: EXPERIMENT_ID, configHash: 'a-config-hash' };
}

function rootRevision(label: string): AdaptiveRevision {
  return makeAdaptiveRevision({
    experimentId: EXPERIMENT_ID,
    parentRevisionId: null,
    generation: 0,
    block: 0,
    opponentRevisionId: null,
    construction: 'root',
    seedPath: adaptiveRevisionSeedPath(`envelope-fixture-seed-${label}`, EXPERIMENT_ID, 0, 0),
    deck: makeDeck({
      id: label,
      label,
      commanderId: 'prototype_commander_blue',
      cards: [
        { cardId: 'prototype_scout', quantity: 2 },
        { cardId: 'prototype_guard', quantity: 2 },
      ],
    }),
  });
}

function lineageOf(revision: AdaptiveRevision): AdaptiveCheckpointLineage {
  return { activeRevisionId: revision.revisionId, revisions: [revision] };
}

/** A full, schema-valid result payload, built the same way `./run.ts` would compose one for an empty run. */
function validResultPayload(): AdaptiveResultPayload {
  const incumbentRoot = rootRevision('inc-root');
  const opponentRoot = rootRevision('opp-root');
  const checkpoint: AdaptiveCheckpoint = {
    schemaVersion: 2,
    experimentId: EXPERIMENT_ID,
    configHash: 'a-config-hash',
    lineages: {
      incumbent: lineageOf(incumbentRoot),
      opponent: lineageOf(opponentRoot),
    },
    gamesSpent: 0,
    referenceField: [],
    pendingGeneration: null,
    nextGeneration: 1,
    nextBlock: 1,
    nextSeedPath: adaptiveRevisionSeedPath('envelope-fixture-seed-next', EXPERIMENT_ID, 1, 1),
  };
  return buildAdaptiveResult({ checkpoint, series: [], screeningRounds: [], validation: null });
}

describe('result envelope', () => {
  it('accepts its full payload at schemaVersion 2', () => {
    const parsed = parseAdaptiveResult({
      schemaVersion: 2,
      ...identity(),
      ...validResultPayload(),
    });
    expect(parsed.cycles).toEqual([]);
    expect(parsed.validation).toBeNull();
  });

  it('refuses an unrecognized field', () => {
    expect(() =>
      adaptiveResultSchema.parse({
        schemaVersion: 2,
        ...identity(),
        ...validResultPayload(),
        stray: true,
      }),
    ).toThrow(ZodError);
  });

  it('refuses a missing experimentId or configHash', () => {
    expect(() =>
      adaptiveResultSchema.parse({ schemaVersion: 2, configHash: 'x', ...validResultPayload() }),
    ).toThrow(ZodError);
    expect(() =>
      adaptiveResultSchema.parse({ schemaVersion: 2, experimentId: 'x', ...validResultPayload() }),
    ).toThrow(ZodError);
  });

  it('refuses an experimentId outside the lowercase slug alphabet', () => {
    expect(() =>
      adaptiveResultSchema.parse({
        schemaVersion: 2,
        experimentId: 'Not Valid',
        configHash: 'x',
        ...validResultPayload(),
      }),
    ).toThrow(ZodError);
  });

  it('refuses a future schemaVersion with the readable message, not a shape error', () => {
    expect(() => parseAdaptiveResult({ schemaVersion: 3, ...identity() })).toThrow(/newer build/);
  });

  it('refuses a schemaVersion 1 record as an older build predating the canonical report payload', () => {
    expect(() => parseAdaptiveResult({ schemaVersion: 1, ...identity() })).toThrow(/older build/);
  });

  it('refuses a missing schemaVersion with the readable message', () => {
    expect(() => parseAdaptiveResult(identity())).toThrow(/does not declare/);
  });
});

describe('raw envelope', () => {
  it('accepts its identity fields at schemaVersion 3 and defaults generations, series and screeningRounds to empty', () => {
    const parsed = parseAdaptiveRawRecord({ schemaVersion: 3, ...identity() });
    expect(parsed.generations).toEqual([]);
    expect(parsed.series).toEqual([]);
    expect(parsed.screeningRounds).toEqual([]);
  });

  it('refuses an unrecognized field', () => {
    expect(() =>
      adaptiveRawRecordSchema.parse({ schemaVersion: 3, ...identity(), stray: true }),
    ).toThrow(ZodError);
  });

  it('refuses a missing experimentId or configHash', () => {
    expect(() => adaptiveRawRecordSchema.parse({ schemaVersion: 3, configHash: 'x' })).toThrow(
      ZodError,
    );
    expect(() => adaptiveRawRecordSchema.parse({ schemaVersion: 3, experimentId: 'x' })).toThrow(
      ZodError,
    );
  });

  it('refuses an experimentId outside the lowercase slug alphabet', () => {
    expect(() =>
      adaptiveRawRecordSchema.parse({
        schemaVersion: 3,
        experimentId: 'Not Valid',
        configHash: 'x',
      }),
    ).toThrow(ZodError);
  });

  it('refuses a future schemaVersion with the readable message, not a shape error', () => {
    expect(() => parseAdaptiveRawRecord({ schemaVersion: 4, ...identity() })).toThrow(
      /newer build/,
    );
  });

  it('refuses a schemaVersion 2 record as an older build predating series and screening records', () => {
    expect(() => parseAdaptiveRawRecord({ schemaVersion: 2, ...identity() })).toThrow(
      /older build/,
    );
  });

  it('refuses a missing schemaVersion with the readable message', () => {
    expect(() => parseAdaptiveRawRecord(identity())).toThrow(/does not declare/);
  });
});
