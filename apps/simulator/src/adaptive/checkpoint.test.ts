import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { makeDeck, type SimDeck } from '@tcg/deck-generator';
import {
  adaptiveRevisionSeedPath,
  makeAdaptiveRevision,
  type AdaptiveRevision,
} from './revision.js';
import { adaptiveGenerationRecordSchema, type AdaptiveGenerationRecord } from './generate.js';
import {
  adaptiveCheckpointLineageSchema,
  adaptiveCheckpointSchema,
  assertValidAdaptiveCheckpoint,
  parseAdaptiveCheckpoint,
  type AdaptiveCheckpoint,
} from './checkpoint.js';

/**
 * M08.18A: the strict checkpoint contract — active revisions, lineage,
 * spent budget, reference field and next seed path all present and
 * round-tripping, including a valid partial-block checkpoint (a generated
 * but not yet decided `pendingGeneration`). Nothing here resumes a run or
 * reads a match store; that is M08.18B's job.
 */

function deck(commanderId: string, guardQuantity = 1): SimDeck {
  return makeDeck({
    commanderId,
    cards: [
      { cardId: 'prototype_scout', quantity: 2 },
      { cardId: 'prototype_guard', quantity: guardQuantity },
    ],
  });
}

function root(experimentId: string, commanderId: string): AdaptiveRevision {
  return makeAdaptiveRevision({
    experimentId,
    parentRevisionId: null,
    generation: 0,
    block: 0,
    opponentRevisionId: null,
    construction: 'root',
    seedPath: adaptiveRevisionSeedPath('checkpoint-fixture-seed', experimentId, 0, 0),
    deck: deck(commanderId),
  });
}

function child(parent: AdaptiveRevision, opponentRevisionId: string): AdaptiveRevision {
  return makeAdaptiveRevision({
    experimentId: parent.experimentId,
    parentRevisionId: parent.revisionId,
    generation: parent.generation + 1,
    block: parent.block + 1,
    opponentRevisionId,
    construction: 'swap',
    swaps: [{ cardOut: 'prototype_guard', cardIn: 'prototype_scout' }],
    seedPath: adaptiveRevisionSeedPath(
      'checkpoint-fixture-seed',
      parent.experimentId,
      parent.generation + 1,
      parent.block + 1,
    ),
    deck: deck(parent.deck.commanderId, parent.deck.cards.length + 1),
  });
}

function baseCheckpoint(overrides: Partial<AdaptiveCheckpoint> = {}): {
  checkpoint: AdaptiveCheckpoint;
  incumbentRoot: AdaptiveRevision;
  opponentRoot: AdaptiveRevision;
} {
  const incumbentRoot = root('my-adaptive-run', 'prototype_commander_blue');
  const opponentRoot = root('my-adaptive-run', 'prototype_commander_red');
  const checkpoint: AdaptiveCheckpoint = {
    schemaVersion: 2,
    experimentId: 'my-adaptive-run',
    configHash: 'a-config-hash',
    lineages: {
      incumbent: { activeRevisionId: incumbentRoot.revisionId, revisions: [incumbentRoot] },
      opponent: { activeRevisionId: opponentRoot.revisionId, revisions: [opponentRoot] },
    },
    gamesSpent: 0,
    referenceField: [],
    pendingGeneration: null,
    nextGeneration: 1,
    nextBlock: 0,
    nextSeedPath: adaptiveRevisionSeedPath('checkpoint-fixture-seed', 'my-adaptive-run', 1, 0),
    ...overrides,
  };
  return { checkpoint, incumbentRoot, opponentRoot };
}

function pendingGenerationFor(
  incumbentRoot: AdaptiveRevision,
  opponentRoot: AdaptiveRevision,
): AdaptiveGenerationRecord {
  const candidate = child(incumbentRoot, opponentRoot.revisionId);
  return adaptiveGenerationRecordSchema.parse({
    generation: 1,
    block: 0,
    informationPolicy: 'public_observation',
    incumbentRevisionId: incumbentRoot.revisionId,
    opponentRevisionId: opponentRoot.revisionId,
    candidates: [candidate],
    rejected: [],
  });
}

describe('adaptiveCheckpointLineageSchema', () => {
  it('accepts a single-revision lineage whose active id is its own root', () => {
    const revision = root('my-adaptive-run', 'prototype_commander_blue');
    expect(() =>
      adaptiveCheckpointLineageSchema.parse({
        activeRevisionId: revision.revisionId,
        revisions: [revision],
      }),
    ).not.toThrow();
  });

  it('refuses a lineage whose active id is not among its own revisions', () => {
    const revision = root('my-adaptive-run', 'prototype_commander_blue');
    expect(() =>
      adaptiveCheckpointLineageSchema.parse({
        activeRevisionId: 'rev_not_present',
        revisions: [revision],
      }),
    ).toThrow(/own checkpointed revisions/);
  });

  it('refuses a lineage that does not start with its root', () => {
    const revisionRoot = root('my-adaptive-run', 'prototype_commander_blue');
    const revisionOne = child(revisionRoot, 'rev_opponent');
    expect(() =>
      adaptiveCheckpointLineageSchema.parse({
        activeRevisionId: revisionOne.revisionId,
        revisions: [revisionOne],
      }),
    ).toThrow(/must start with its root/);
  });

  it('refuses an empty revisions array', () => {
    expect(() =>
      adaptiveCheckpointLineageSchema.parse({ activeRevisionId: 'rev_x', revisions: [] }),
    ).toThrow(ZodError);
  });
});

describe('adaptiveCheckpointSchema: strict surface', () => {
  it('accepts a clean block-boundary checkpoint (no pending generation)', () => {
    const { checkpoint } = baseCheckpoint();
    expect(() => adaptiveCheckpointSchema.parse(checkpoint)).not.toThrow();
  });

  it('defaults referenceField to empty and requires the rest', () => {
    const { checkpoint } = baseCheckpoint();
    const { referenceField: _referenceField, ...withoutField } = checkpoint;
    const parsed = adaptiveCheckpointSchema.parse(withoutField);
    expect(parsed.referenceField).toEqual([]);
  });

  it('refuses an unrecognized top-level field', () => {
    const { checkpoint } = baseCheckpoint();
    expect(() => adaptiveCheckpointSchema.parse({ ...checkpoint, stray: true })).toThrow(ZodError);
  });

  it('refuses an unrecognized field inside a lineage side', () => {
    const { checkpoint } = baseCheckpoint();
    expect(() =>
      adaptiveCheckpointSchema.parse({
        ...checkpoint,
        lineages: {
          ...checkpoint.lineages,
          incumbent: { ...checkpoint.lineages.incumbent, stray: true },
        },
      }),
    ).toThrow(ZodError);
  });

  it('refuses a future schemaVersion with the readable message, not a shape error', () => {
    const { checkpoint } = baseCheckpoint({ schemaVersion: 3 as never });
    expect(() => parseAdaptiveCheckpoint(checkpoint)).toThrow(/newer build/);
  });

  it('refuses a schemaVersion 1 checkpoint as an older build predating resumable state', () => {
    const { checkpoint } = baseCheckpoint({ schemaVersion: 1 as never });
    expect(() => parseAdaptiveCheckpoint(checkpoint)).toThrow(/older build/);
  });

  it('refuses negative gamesSpent', () => {
    const { checkpoint } = baseCheckpoint({ gamesSpent: -1 });
    expect(() => adaptiveCheckpointSchema.parse(checkpoint)).toThrow(ZodError);
  });
});

describe('adaptiveCheckpointSchema: pending generation and partial-block state', () => {
  it('accepts a valid partial-block checkpoint: candidates generated, decision pending', () => {
    const { checkpoint, incumbentRoot, opponentRoot } = baseCheckpoint();
    const pendingGeneration = pendingGenerationFor(incumbentRoot, opponentRoot);
    const partial: AdaptiveCheckpoint = { ...checkpoint, pendingGeneration };
    expect(() => adaptiveCheckpointSchema.parse(partial)).not.toThrow();
    const parsed = parseAdaptiveCheckpoint(partial);
    expect(parsed.pendingGeneration?.candidates).toHaveLength(1);
  });

  it('refuses a pendingGeneration whose generation/block do not match nextGeneration/nextBlock', () => {
    const { checkpoint, incumbentRoot, opponentRoot } = baseCheckpoint({ nextBlock: 5 });
    const pendingGeneration = pendingGenerationFor(incumbentRoot, opponentRoot);
    expect(() =>
      adaptiveCheckpointSchema.parse({ ...checkpoint, nextBlock: 5, pendingGeneration }),
    ).toThrow(/own `nextGeneration`\/`nextBlock`/);
  });

  it('refuses a pendingGeneration naming a revision that is not one of the two currently active', () => {
    const { checkpoint, incumbentRoot, opponentRoot } = baseCheckpoint();
    const pendingGeneration = {
      ...pendingGenerationFor(incumbentRoot, opponentRoot),
      opponentRevisionId: 'rev_someone_else',
    };
    expect(() => adaptiveCheckpointSchema.parse({ ...checkpoint, pendingGeneration })).toThrow(
      /two currently active revisions/,
    );
  });

  it('accepts pendingGeneration when the opponent side is the one that generated candidates', () => {
    // Either side can have lost its last block and generated candidates
    // (block.ts: "either side ... can adapt next"); the pairing check must
    // not assume it is always the `incumbent`-keyed lineage.
    const { checkpoint, incumbentRoot, opponentRoot } = baseCheckpoint();
    const candidate = child(opponentRoot, incumbentRoot.revisionId);
    const pendingGeneration = adaptiveGenerationRecordSchema.parse({
      generation: 1,
      block: 0,
      informationPolicy: 'public_observation',
      incumbentRevisionId: opponentRoot.revisionId,
      opponentRevisionId: incumbentRoot.revisionId,
      candidates: [candidate],
      rejected: [],
    });
    expect(() =>
      adaptiveCheckpointSchema.parse({ ...checkpoint, pendingGeneration }),
    ).not.toThrow();
  });
});

describe('assertValidAdaptiveCheckpoint', () => {
  it('accepts both lineages under a locked Commander policy', () => {
    const { checkpoint } = baseCheckpoint();
    expect(() => assertValidAdaptiveCheckpoint('locked', checkpoint)).not.toThrow();
  });

  it('rejects a lineage that changed Commander under a locked policy', () => {
    const incumbentRoot = root('my-adaptive-run', 'prototype_commander_blue');
    const opponentRoot = root('my-adaptive-run', 'prototype_commander_red');
    const changedCommander = makeAdaptiveRevision({
      experimentId: 'my-adaptive-run',
      parentRevisionId: incumbentRoot.revisionId,
      generation: 1,
      block: 1,
      opponentRevisionId: opponentRoot.revisionId,
      construction: 'rebuild',
      seedPath: adaptiveRevisionSeedPath('checkpoint-fixture-seed', 'my-adaptive-run', 1, 1),
      deck: deck('prototype_commander_green'),
    });
    const { checkpoint } = baseCheckpoint({
      lineages: {
        incumbent: {
          activeRevisionId: changedCommander.revisionId,
          revisions: [incumbentRoot, changedCommander],
        },
        opponent: { activeRevisionId: opponentRoot.revisionId, revisions: [opponentRoot] },
      },
    });
    expect(() => assertValidAdaptiveCheckpoint('locked', checkpoint)).toThrow(
      /locked Commander policy/,
    );
  });
});
