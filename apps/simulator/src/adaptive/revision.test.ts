import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import { makeDeck, type SimDeck } from '@tcg/deck-generator';
import {
  adaptiveRevisionSchema,
  adaptiveRevisionSeedPath,
  assertAdaptiveLineage,
  makeAdaptiveRevision,
  parseAdaptiveRevision,
  type AdaptiveRevision,
} from './revision.js';

/**
 * M08.16B: revision identity, immutability, round trip and Commander-locked
 * versus open lineage — proved without generating or evaluating a candidate.
 * Every deck below is hand-built with `makeDeck`; nothing here calls M08.16C's
 * (not yet written) candidate generator.
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

function root(
  overrides: Partial<Parameters<typeof makeAdaptiveRevision>[0]> = {},
): AdaptiveRevision {
  return makeAdaptiveRevision({
    experimentId: 'my-adaptive-run',
    parentRevisionId: null,
    generation: 0,
    block: 0,
    opponentRevisionId: null,
    construction: 'root',
    seedPath: adaptiveRevisionSeedPath('adaptive-fixture-seed', 'my-adaptive-run', 0, 0),
    deck: deck('prototype_commander_blue'),
    ...overrides,
  });
}

describe('adaptiveRevisionSchema: strict surface', () => {
  it('accepts a root revision and defaults swaps to empty', () => {
    const revision = root();
    expect(revision.swaps).toEqual([]);
    expect(revision.parentRevisionId).toBeNull();
    expect(revision.opponentRevisionId).toBeNull();
  });

  it('refuses an unrecognized top-level field', () => {
    expect(() => adaptiveRevisionSchema.parse({ ...root(), stray: true })).toThrow(ZodError);
  });

  it('refuses an unrecognized field inside a swap', () => {
    expect(() =>
      adaptiveRevisionSchema.parse({
        ...root({ construction: 'swap' }),
        swaps: [{ cardOut: 'prototype_guard', cardIn: 'prototype_scout', stray: true }],
      }),
    ).toThrow(ZodError);
  });
});

describe('adaptiveRevisionSchema: root shape', () => {
  it('refuses a root revision with a non-null opponentRevisionId', () => {
    expect(() =>
      adaptiveRevisionSchema.parse({ ...root(), opponentRevisionId: 'rev_something' }),
    ).toThrow(ZodError);
  });

  it('refuses a root revision with a non-zero generation', () => {
    expect(() => adaptiveRevisionSchema.parse({ ...root(), generation: 1 })).toThrow(ZodError);
  });

  it('refuses a root revision whose construction is not "root"', () => {
    expect(() => adaptiveRevisionSchema.parse({ ...root(), construction: 'swap' })).toThrow(
      ZodError,
    );
  });

  it('refuses a root revision that carries swaps', () => {
    expect(() =>
      adaptiveRevisionSchema.parse({
        ...root(),
        swaps: [{ cardOut: 'prototype_guard', cardIn: 'prototype_scout' }],
      }),
    ).toThrow(ZodError);
  });
});

describe('adaptiveRevisionSchema: non-root shape', () => {
  const base = root();

  it('refuses construction "root" once a parent is named', () => {
    expect(() =>
      adaptiveRevisionSchema.parse({
        ...base,
        parentRevisionId: base.revisionId,
        opponentRevisionId: 'rev_opponent',
        generation: 1,
      }),
    ).toThrow(ZodError);
  });

  it('requires an opponentRevisionId once a parent is named', () => {
    expect(() =>
      adaptiveRevisionSchema.parse({
        ...base,
        parentRevisionId: base.revisionId,
        opponentRevisionId: null,
        generation: 1,
        construction: 'swap',
        swaps: [{ cardOut: 'prototype_guard', cardIn: 'prototype_scout' }],
      }),
    ).toThrow(ZodError);
  });

  it('requires at least one swap for a "swap" revision', () => {
    expect(() =>
      adaptiveRevisionSchema.parse({
        ...base,
        parentRevisionId: base.revisionId,
        opponentRevisionId: 'rev_opponent',
        generation: 1,
        construction: 'swap',
        swaps: [],
      }),
    ).toThrow(ZodError);
  });

  it('refuses swaps on a "rebuild" revision', () => {
    expect(() =>
      adaptiveRevisionSchema.parse({
        ...base,
        parentRevisionId: base.revisionId,
        opponentRevisionId: 'rev_opponent',
        generation: 1,
        construction: 'rebuild',
        swaps: [{ cardOut: 'prototype_guard', cardIn: 'prototype_scout' }],
      }),
    ).toThrow(ZodError);
  });

  it('accepts a well-formed swap revision', () => {
    expect(() =>
      adaptiveRevisionSchema.parse({
        ...base,
        parentRevisionId: base.revisionId,
        opponentRevisionId: 'rev_opponent',
        generation: 1,
        construction: 'swap',
        swaps: [{ cardOut: 'prototype_guard', cardIn: 'prototype_scout' }],
      }),
    ).not.toThrow();
  });

  it('accepts a well-formed rebuild revision', () => {
    expect(() =>
      adaptiveRevisionSchema.parse({
        ...base,
        parentRevisionId: base.revisionId,
        opponentRevisionId: 'rev_opponent',
        generation: 1,
        construction: 'rebuild',
        swaps: [],
      }),
    ).not.toThrow();
  });
});

describe('makeAdaptiveRevision: content-derived immutability', () => {
  it('gives identical content the same revisionId', () => {
    const a = root();
    const b = root();
    expect(a.revisionId).toBe(b.revisionId);
  });

  it('changes the revisionId when the deck changes', () => {
    const a = root();
    const b = root({ deck: deck('prototype_commander_blue', 2) });
    expect(a.revisionId).not.toBe(b.revisionId);
  });

  it('changes the revisionId when the block changes', () => {
    const a = root();
    const b = root({ block: 1 });
    expect(a.revisionId).not.toBe(b.revisionId);
  });

  it('changes the revisionId when the seed path changes', () => {
    const a = root();
    const b = root({ seedPath: adaptiveRevisionSeedPath('other-seed', 'my-adaptive-run', 0, 0) });
    expect(a.revisionId).not.toBe(b.revisionId);
  });

  it('changes the revisionId when a swap child differs only by which cards were swapped', () => {
    const parent = root();
    const swapOne = makeAdaptiveRevision({
      experimentId: 'my-adaptive-run',
      parentRevisionId: parent.revisionId,
      generation: 1,
      block: 1,
      opponentRevisionId: 'rev_opponent',
      construction: 'swap',
      swaps: [{ cardOut: 'prototype_guard', cardIn: 'prototype_scout' }],
      seedPath: adaptiveRevisionSeedPath('adaptive-fixture-seed', 'my-adaptive-run', 1, 1),
      deck: deck('prototype_commander_blue', 2),
    });
    const swapTwo = makeAdaptiveRevision({
      experimentId: 'my-adaptive-run',
      parentRevisionId: parent.revisionId,
      generation: 1,
      block: 1,
      opponentRevisionId: 'rev_opponent',
      construction: 'swap',
      swaps: [{ cardOut: 'prototype_scout', cardIn: 'prototype_guard' }],
      seedPath: adaptiveRevisionSeedPath('adaptive-fixture-seed', 'my-adaptive-run', 1, 1),
      deck: deck('prototype_commander_blue', 2),
    });
    expect(swapOne.revisionId).not.toBe(swapTwo.revisionId);
  });
});

describe('adaptiveRevisionSchema: round trip', () => {
  it('parses back to a deeply equal revision through JSON serialization', () => {
    const revision = root();
    const roundTripped = parseAdaptiveRevision(JSON.parse(JSON.stringify(revision)));
    expect(roundTripped).toEqual(revision);
  });
});

describe('assertAdaptiveLineage', () => {
  function child(
    parent: AdaptiveRevision,
    overrides: Partial<Parameters<typeof makeAdaptiveRevision>[0]> = {},
  ): AdaptiveRevision {
    return makeAdaptiveRevision({
      experimentId: 'my-adaptive-run',
      parentRevisionId: parent.revisionId,
      generation: parent.generation + 1,
      block: parent.block + 1,
      opponentRevisionId: 'rev_opponent',
      construction: 'swap',
      swaps: [{ cardOut: 'prototype_guard', cardIn: 'prototype_scout' }],
      seedPath: adaptiveRevisionSeedPath(
        'adaptive-fixture-seed',
        'my-adaptive-run',
        parent.generation + 1,
        parent.block + 1,
      ),
      deck: deck('prototype_commander_blue', parent.deck.cards.length + 1),
      ...overrides,
    });
  }

  it('accepts a valid straight-chain lineage', () => {
    const revisionRoot = root();
    const revisionOne = child(revisionRoot);
    const revisionTwo = child(revisionOne);
    expect(() =>
      assertAdaptiveLineage('locked', [revisionRoot, revisionOne, revisionTwo]),
    ).not.toThrow();
  });

  it('refuses an empty lineage', () => {
    expect(() => assertAdaptiveLineage('locked', [])).toThrow(/cannot be empty/);
  });

  it('refuses a lineage whose first entry is not the root', () => {
    const revisionRoot = root();
    const revisionOne = child(revisionRoot);
    expect(() => assertAdaptiveLineage('locked', [revisionOne])).toThrow(/must be the root/);
  });

  it('refuses a revision naming a parent outside the lineage', () => {
    const revisionRoot = root();
    const stray = child(root({ block: 9 }));
    expect(() => assertAdaptiveLineage('locked', [revisionRoot, stray])).toThrow(
      /not earlier in this lineage/,
    );
  });

  it('refuses a generation that does not advance by exactly one', () => {
    const revisionRoot = root();
    const skipped = child(revisionRoot, { generation: 2 });
    expect(() => assertAdaptiveLineage('locked', [revisionRoot, skipped])).toThrow(
      /not one more than its parent/,
    );
  });

  it('refuses a repeated revision in the same lineage', () => {
    const revisionRoot = root();
    const revisionOne = child(revisionRoot);
    expect(() => assertAdaptiveLineage('locked', [revisionRoot, revisionOne, revisionOne])).toThrow(
      /more than once/,
    );
  });

  it('refuses a Commander change under a locked policy', () => {
    const revisionRoot = root();
    const changedCommander = child(revisionRoot, { deck: deck('prototype_commander_red') });
    expect(() => assertAdaptiveLineage('locked', [revisionRoot, changedCommander])).toThrow(
      /locked Commander policy/,
    );
  });

  it('allows a Commander change under an open policy', () => {
    const revisionRoot = root();
    const changedCommander = child(revisionRoot, { deck: deck('prototype_commander_red') });
    expect(() => assertAdaptiveLineage('open', [revisionRoot, changedCommander])).not.toThrow();
  });

  it('allows a Commander change under a selected policy', () => {
    const revisionRoot = root();
    const changedCommander = child(revisionRoot, { deck: deck('prototype_commander_red') });
    expect(() => assertAdaptiveLineage('selected', [revisionRoot, changedCommander])).not.toThrow();
  });
});
