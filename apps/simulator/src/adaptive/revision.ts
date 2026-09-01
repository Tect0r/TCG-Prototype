import { z } from 'zod';
import { cardIdSchema } from '@tcg/card-data';
import { simDeckSchema, type SimDeck } from '@tcg/deck-generator';
import { digestOf } from '../hash.js';
import { adaptiveExperimentIdSchema } from './config.js';

/**
 * Immutable deck revision lineage (M08.16B).
 *
 * A revision is either the root of a lineage (the starting deck, straight from
 * `startingDecks`) or the previous revision plus one bounded change, produced
 * after that previous revision lost a mirrored evaluation block. Nothing here
 * generates that change — M08.16C's candidate generator is the only place a
 * swap or rebuild is actually chosen. This file only defines what a revision
 * *is*, content-addressed the same way `deckHash` addresses a deck
 * (`packages/deck-generator/src/hash.ts`), so identity, round trip and
 * lineage can all be proved before there is anything to evaluate.
 *
 * `revisionId` is a hash of every other field (`makeAdaptiveRevision`), never
 * supplied directly, for the same reason `SimDeck.hash` is computed rather
 * than authored: two revisions with identical lineage, swaps and resulting
 * deck are the same revision, and any change to any of those fields — not
 * just to the deck's cards — has to change the ID.
 */

export const ADAPTIVE_REVISION_CONSTRUCTION_KINDS = ['root', 'swap', 'rebuild'] as const;
export const adaptiveRevisionConstructionKindSchema = z.enum(ADAPTIVE_REVISION_CONSTRUCTION_KINDS);
export type AdaptiveRevisionConstructionKind = z.infer<typeof adaptiveRevisionConstructionKindSchema>;

/** One card swapped out for one card swapped in. Empty for `root` and `rebuild`. */
export const adaptiveCardSwapSchema = z.strictObject({
  cardOut: cardIdSchema,
  cardIn: cardIdSchema,
});
export type AdaptiveCardSwap = z.infer<typeof adaptiveCardSwapSchema>;

export const adaptiveRevisionSchema = z
  .strictObject({
    /** Content-derived; see `makeAdaptiveRevision`. Never authored by hand. */
    revisionId: z.string().min(1),
    experimentId: adaptiveExperimentIdSchema,
    /** `null` only for the lineage root. */
    parentRevisionId: z.string().min(1).nullable(),
    /** 0 for the root; a child is always exactly one more than its parent's. */
    generation: z.number().int().min(0),
    /** The evaluation block this revision was produced at. */
    block: z.number().int().min(0),
    /**
     * The revision this one was evaluated against when its parent lost and
     * this revision was produced in response. `null` only for the root, which
     * has not been evaluated against anything yet.
     */
    opponentRevisionId: z.string().min(1).nullable(),
    construction: adaptiveRevisionConstructionKindSchema,
    /** The exact cards changed. Non-empty only for `swap`. */
    swaps: z.array(adaptiveCardSwapSchema).max(40).default([]),
    /**
     * The deterministic seed-derivation path this revision's construction
     * used, in the `experiment|adaptive:id|gen:0000|block:0000` style
     * `../seed.ts` uses for every other derived seed (CLAUDE.md §13.4). See
     * `adaptiveRevisionSeedPath`.
     */
    seedPath: z.string().min(1),
    /** The deck this revision names. Content-addressed independently via `deck.hash`. */
    deck: simDeckSchema,
  })
  .refine(
    (revision) =>
      revision.parentRevisionId === null
        ? revision.construction === 'root' &&
          revision.generation === 0 &&
          revision.swaps.length === 0 &&
          revision.opponentRevisionId === null
        : revision.construction !== 'root',
    {
      message:
        'A revision with no parent must be the lineage root (construction "root", generation 0, ' +
        'no swaps, no opponent); a revision with a parent cannot be "root".',
      path: ['construction'],
    },
  )
  .refine(
    (revision) => revision.parentRevisionId === null || revision.opponentRevisionId !== null,
    {
      message: 'A non-root revision must name the opponent revision it was produced in response to.',
      path: ['opponentRevisionId'],
    },
  )
  .refine(
    (revision) =>
      revision.construction === 'swap'
        ? revision.swaps.length >= 1
        : revision.construction !== 'rebuild' || revision.swaps.length === 0,
    {
      message:
        'A "swap" revision must record at least one card swap; a "rebuild" revision must record none.',
      path: ['swaps'],
    },
  );
export type AdaptiveRevision = z.infer<typeof adaptiveRevisionSchema>;
export type AdaptiveRevisionInput = z.input<typeof adaptiveRevisionSchema>;

/**
 * Builds a revision, computing its content-derived `revisionId`.
 *
 * `deck.hash` stands in for the full deck below rather than the deck object
 * itself: `SimDeck.hash` already changes whenever the deck's cards or
 * Commander do (`deckHash`), so hashing it again here is exactly as sensitive
 * to deck content as hashing the deck would be, without hashing `origin` and
 * `construction` twice.
 */
export function makeAdaptiveRevision(input: {
  readonly experimentId: string;
  readonly parentRevisionId: string | null;
  readonly generation: number;
  readonly block: number;
  readonly opponentRevisionId: string | null;
  readonly construction: AdaptiveRevisionConstructionKind;
  readonly swaps?: readonly AdaptiveCardSwap[];
  readonly seedPath: string;
  readonly deck: SimDeck;
}): AdaptiveRevision {
  const swaps = input.swaps ?? [];
  const revisionId = `rev_${digestOf({
    experimentId: input.experimentId,
    parentRevisionId: input.parentRevisionId,
    generation: input.generation,
    block: input.block,
    opponentRevisionId: input.opponentRevisionId,
    construction: input.construction,
    swaps,
    seedPath: input.seedPath,
    deckHash: input.deck.hash,
  })}`;
  return adaptiveRevisionSchema.parse({
    revisionId,
    experimentId: input.experimentId,
    parentRevisionId: input.parentRevisionId,
    generation: input.generation,
    block: input.block,
    opponentRevisionId: input.opponentRevisionId,
    construction: input.construction,
    swaps,
    seedPath: input.seedPath,
    deck: input.deck,
  });
}

/**
 * The seed-derivation path a revision's own construction should use, in the
 * same pipe-joined, zero-padded style `../seed.ts` uses throughout
 * (CLAUDE.md §13.4). M08.16C's generator expands this into an actual seed
 * with `seedFromPath`; this file only names the path so it can be recorded on
 * the revision before there is a generator to consume it.
 */
export function adaptiveRevisionSeedPath(
  experimentSeed: string,
  experimentId: string,
  generation: number,
  block: number,
): string {
  return (
    `${experimentSeed}|adaptive:${experimentId}` +
    `|gen:${String(generation).padStart(4, '0')}|block:${String(block).padStart(4, '0')}`
  );
}

/** Parses a revision, refusing anything the strict schema and refinements above reject. */
export function parseAdaptiveRevision(input: unknown): AdaptiveRevision {
  return adaptiveRevisionSchema.parse(input);
}

/**
 * Validates one lineage — a root followed by its descendants, in generation
 * order — against a Commander policy.
 *
 * `locked` requires every revision to keep the root's Commander, since a
 * locked run never has a candidate generator free to change it. `selected`
 * and `open` both allow a revision to change Commander, because a revision
 * that changed nothing else with the freedom to do so is not a schema
 * violation this function is positioned to judge.
 *
 * A plain array rather than a tree: the M08.16 default policy retains only
 * the previous successful revision per lineage, so a run's history is a
 * straight chain, not a branching structure, and there is nothing here to
 * evaluate that would produce siblings.
 */
export function assertAdaptiveLineage(
  commanderPolicy: 'locked' | 'selected' | 'open',
  lineage: readonly AdaptiveRevision[],
): void {
  const [root, ...descendants] = lineage;
  if (!root) {
    throw new Error('An adaptive lineage cannot be empty.');
  }
  if (root.parentRevisionId !== null) {
    throw new Error('The first revision in a lineage must be the root (parentRevisionId null).');
  }
  const seen = new Map<string, AdaptiveRevision>([[root.revisionId, root]]);
  for (const revision of descendants) {
    if (seen.has(revision.revisionId)) {
      throw new Error(`Revision ${revision.revisionId} appears more than once in this lineage.`);
    }
    const parent = revision.parentRevisionId !== null ? seen.get(revision.parentRevisionId) : undefined;
    if (!parent) {
      throw new Error(
        `Revision ${revision.revisionId} names a parent that is not earlier in this lineage.`,
      );
    }
    if (revision.generation !== parent.generation + 1) {
      throw new Error(
        `Revision ${revision.revisionId} has generation ${String(revision.generation)}, ` +
          `not one more than its parent's ${String(parent.generation)}.`,
      );
    }
    if (commanderPolicy === 'locked' && revision.deck.commanderId !== root.deck.commanderId) {
      throw new Error(
        `Revision ${revision.revisionId} changes Commander from ${root.deck.commanderId} to ` +
          `${revision.deck.commanderId} under a locked Commander policy.`,
      );
    }
    seen.set(revision.revisionId, revision);
  }
}
