import { z } from 'zod';
import type { CardId } from '@tcg/card-data';
import { checkDeck, generateDeck, type SimDeck } from '@tcg/deck-generator';
import type { Environment } from '../environment.js';
import { mutateDeck } from '../deck-search/mutate.js';
import { seedFromPath, seededIndex } from '../seed.js';
import type { AdaptiveConfig, AdaptiveInformationPolicy } from './config.js';
import { adaptiveInformationPolicySchema } from './config.js';
import {
  adaptiveCardSwapSchema,
  adaptiveRevisionSchema,
  adaptiveRevisionSeedPath,
  makeAdaptiveRevision,
  type AdaptiveCardSwap,
  type AdaptiveRevision,
} from './revision.js';

/**
 * Deterministic legal candidate generation (M08.16C).
 *
 * Given the revision that won its last mirrored evaluation block (the
 * "incumbent"), this produces up to `config.candidateCount` legal child
 * revisions — bounded swaps by default, or a from-scratch rebuild when the
 * caller says this block is one. Nothing here evaluates a candidate against
 * the incumbent or promotes one: that is M08.17's evaluation loop, which
 * decides whether a candidate wins, and — per the M08.16 default policy — that
 * the incumbent is *retained* rather than discarded when nothing beats it.
 * This file only has to make sure every candidate it hands that loop is legal,
 * reproducible from its seed, and within the configured swap bound; a
 * candidate that fails any of those three is dropped and recorded in
 * `rejected`, never silently repaired.
 *
 * The generator never reads the opponent's deck — only `opponentRevisionId`,
 * an identifier — so a candidate's content cannot depend on what the run's
 * `informationPolicy` lets a pilot see. `informationPolicy` is carried through
 * to `AdaptiveGenerationRecord` unchanged, so an `analysis_full_deck` run is
 * unmistakable in the record even though this generator does not yet act on
 * it (M08.16 exclusion: no candidate evaluation).
 */

export const ADAPTIVE_GENERATED_CONSTRUCTION_KINDS = ['swap', 'rebuild'] as const;
export const adaptiveGeneratedConstructionKindSchema = z.enum(
  ADAPTIVE_GENERATED_CONSTRUCTION_KINDS,
);
export type AdaptiveGeneratedConstructionKind = z.infer<
  typeof adaptiveGeneratedConstructionKindSchema
>;

export const adaptiveRejectedCandidateSchema = z.strictObject({
  /** Which candidate slot, 0-based, this rejection came from. */
  index: z.number().int().min(0),
  seedPath: z.string().min(1),
  construction: adaptiveGeneratedConstructionKindSchema,
  reasons: z.array(z.string().min(1)).min(1),
});
export type AdaptiveRejectedCandidate = z.infer<typeof adaptiveRejectedCandidateSchema>;

/** One generation event, additively widening the raw stream (`./envelopes.ts`). */
export const adaptiveGenerationRecordSchema = z.strictObject({
  generation: z.number().int().min(1),
  block: z.number().int().min(0),
  informationPolicy: adaptiveInformationPolicySchema,
  incumbentRevisionId: z.string().min(1),
  opponentRevisionId: z.string().min(1),
  candidates: z.array(adaptiveRevisionSchema).max(64),
  rejected: z.array(adaptiveRejectedCandidateSchema).max(256),
});
export type AdaptiveGenerationRecord = z.infer<typeof adaptiveGenerationRecordSchema>;

export interface GenerateAdaptiveCandidatesInput {
  readonly environment: Environment;
  readonly config: AdaptiveConfig;
  /** The revision this generation responds to — the last block's winner. */
  readonly incumbent: AdaptiveRevision;
  readonly opponentRevisionId: string;
  readonly block: number;
  /** True when this block's candidates should be deterministic rebuilds instead of swaps. */
  readonly rebuild: boolean;
}

/**
 * The net cards changed between two decks of equal size, as swap pairs.
 *
 * Deliberately computed from the *aggregate* card-count difference rather
 * than from any per-step log a mutator kept: several single-card swaps can
 * cancel along the way without changing what the deck ended up as, and a
 * revision's `swaps` field is a fact about the resulting deck, not about the
 * path a search took to reach it.
 */
function diffSwaps(before: SimDeck, after: SimDeck): AdaptiveCardSwap[] {
  const delta = new Map<CardId, number>();
  for (const entry of before.cards) {
    delta.set(entry.cardId, (delta.get(entry.cardId) ?? 0) + entry.quantity);
  }
  for (const entry of after.cards) {
    delta.set(entry.cardId, (delta.get(entry.cardId) ?? 0) - entry.quantity);
  }
  const removed: CardId[] = [];
  const added: CardId[] = [];
  for (const [cardId, count] of delta) {
    if (count > 0) for (let i = 0; i < count; i += 1) removed.push(cardId);
    if (count < 0) for (let i = 0; i < -count; i += 1) added.push(cardId);
  }
  removed.sort();
  added.sort();
  return removed.map((cardOut, i) => adaptiveCardSwapSchema.parse({ cardOut, cardIn: added[i] }));
}

function candidateSeedPath(
  config: AdaptiveConfig,
  generation: number,
  block: number,
  index: number,
): string {
  return (
    `${adaptiveRevisionSeedPath(config.seed, config.id, generation, block)}` +
    `|cand:${String(index).padStart(4, '0')}`
  );
}

function generateSwapCandidate(
  environment: Environment,
  config: AdaptiveConfig,
  incumbent: AdaptiveRevision,
  opponentRevisionId: string,
  generation: number,
  block: number,
  index: number,
): AdaptiveRevision | AdaptiveRejectedCandidate {
  const seedPath = candidateSeedPath(config, generation, block, index);
  const construction: AdaptiveGeneratedConstructionKind = 'swap';
  const range = config.swapBound.maxCards - config.swapBound.minCards + 1;
  const strength = config.swapBound.minCards + seededIndex(`${seedPath}|strength`, range);

  const result = mutateDeck(incumbent.deck, environment, seedFromPath(seedPath, 'm'), {
    strength,
    generation,
  });
  if (!result.deck) {
    return { index, seedPath, construction, reasons: [...result.reasons] };
  }

  const swaps = diffSwaps(incumbent.deck, result.deck);
  if (swaps.length < config.swapBound.minCards || swaps.length > config.swapBound.maxCards) {
    return {
      index,
      seedPath,
      construction,
      reasons: [
        `the net swap count ${String(swaps.length)} falls outside the configured bound ` +
          `[${String(config.swapBound.minCards)}, ${String(config.swapBound.maxCards)}]`,
      ],
    };
  }

  return makeAdaptiveRevision({
    experimentId: config.id,
    parentRevisionId: incumbent.revisionId,
    generation,
    block,
    opponentRevisionId,
    construction,
    swaps,
    seedPath,
    deck: result.deck,
  });
}

function generateRebuildCandidate(
  environment: Environment,
  config: AdaptiveConfig,
  incumbent: AdaptiveRevision,
  opponentRevisionId: string,
  generation: number,
  block: number,
  index: number,
): AdaptiveRevision | AdaptiveRejectedCandidate {
  const seedPath = candidateSeedPath(config, generation, block, index);
  const construction: AdaptiveGeneratedConstructionKind = 'rebuild';

  const result = generateDeck(
    environment,
    seedFromPath(seedPath, 'r'),
    {},
    {
      commanderId: incumbent.deck.commanderId,
      label: `${incumbent.deck.label} rebuild g${String(generation)}`,
    },
  );
  if (!result.deck) {
    return {
      index,
      seedPath,
      construction,
      reasons: result.diagnostics.map((diagnostic) => diagnostic.message),
    };
  }

  const legality = checkDeck(result.deck, environment);
  if (!legality.legal) {
    return {
      index,
      seedPath,
      construction,
      reasons: legality.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.message),
    };
  }

  if (result.deck.hash === incumbent.deck.hash) {
    return {
      index,
      seedPath,
      construction,
      reasons: ['the rebuild reproduced the incumbent deck'],
    };
  }

  return makeAdaptiveRevision({
    experimentId: config.id,
    parentRevisionId: incumbent.revisionId,
    generation,
    block,
    opponentRevisionId,
    construction,
    seedPath,
    deck: result.deck,
  });
}

/**
 * Generates this block's candidates deterministically: the same environment,
 * config, incumbent, opponent, block and `rebuild` flag always produce the
 * same candidates and the same rejections, in the same order.
 */
export function generateAdaptiveCandidates(
  input: GenerateAdaptiveCandidatesInput,
): AdaptiveGenerationRecord {
  const { environment, config, incumbent, opponentRevisionId, block, rebuild } = input;
  const generation = incumbent.generation + 1;
  const candidates: AdaptiveRevision[] = [];
  const rejected: AdaptiveRejectedCandidate[] = [];

  for (let index = 0; index < config.candidateCount; index += 1) {
    const outcome = rebuild
      ? generateRebuildCandidate(
          environment,
          config,
          incumbent,
          opponentRevisionId,
          generation,
          block,
          index,
        )
      : generateSwapCandidate(
          environment,
          config,
          incumbent,
          opponentRevisionId,
          generation,
          block,
          index,
        );
    if ('revisionId' in outcome) candidates.push(outcome);
    else rejected.push(outcome);
  }

  return adaptiveGenerationRecordSchema.parse({
    generation,
    block,
    informationPolicy: config.informationPolicy,
    incumbentRevisionId: incumbent.revisionId,
    opponentRevisionId,
    candidates,
    rejected,
  });
}

export type { AdaptiveInformationPolicy };
