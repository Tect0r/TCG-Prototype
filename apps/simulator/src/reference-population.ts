import { z } from 'zod';
import type { DeckSource } from './config.js';
import type { Environment } from './environment.js';
import { resolveDeckSource } from './deck-source.js';
import { checkDeck, simDeckSchema, type SimDeck } from './deck-search/deck.js';
import { digestOf } from './hash.js';

/**
 * The frozen reference population a comparison replays in both environments
 * (PHASE4_HARDENING §6).
 *
 * The defect this fixes: the comparison used to call `resolveDeckSource` once
 * per environment. With a `generated` source that means the baseline and the
 * candidate each generated their *own* population — from different card pools,
 * so different decks — and the resulting "same decks, unchanged, in both
 * environments" comparison was not that at all. Any deck-level delta it reported
 * mixed the rules change together with two different decklists, and there was no
 * way to tell the two apart afterwards.
 *
 * The contract now:
 *
 * 1. Resolve or load the population **exactly once**, against the baseline.
 * 2. Hash every deck by normalized Commander and quantities (already `SimDeck`'s
 *    canonical hash) and hash the sorted set into a population hash.
 * 3. Validate every deck against **both** pools.
 * 4. Keep only decks legal in both; report the rest with their exact reasons.
 * 5. Never repair, mutate or regenerate a deck for one side.
 * 6. Record the population hash in both result sets, and fail the comparison if
 *    they ever differ.
 *
 * A card added by the candidate cannot appear in this population by
 * construction — no reference deck could have contained a card that did not
 * exist. That is not a gap: it is why §6 also requires a *separate* discovery
 * population, and why the report keeps the two answers apart. Reference impact
 * says what the change did to the decks people already play; discovery impact
 * says what the change made newly possible.
 */

export const REFERENCE_POPULATION_VERSION = 1;

export const excludedDeckSchema = z.strictObject({
  deckId: z.string(),
  deckHash: z.string(),
  /** Which environment rejected it. Both are checked, so both can appear. */
  environmentId: z.string(),
  reasons: z.array(z.string()),
});
export type ExcludedDeck = z.infer<typeof excludedDeckSchema>;

export const referencePopulationSchema = z.strictObject({
  schemaVersion: z.literal(REFERENCE_POPULATION_VERSION),
  policy: z.literal('shared_legal_reference_population'),
  /** Content hash of the decks that survived, in canonical order. */
  hash: z.string(),
  /** Content hash of the population as resolved, before legality filtering. */
  resolvedHash: z.string(),
  /** Environment the population was resolved against. Always the baseline. */
  resolvedAgainst: z.string(),
  decks: z.array(simDeckSchema),
  excluded: z.array(excludedDeckSchema),
});
export type ReferencePopulation = z.infer<typeof referencePopulationSchema>;

export interface FreezeInputs {
  readonly source: DeckSource;
  readonly baseline: Environment;
  readonly candidate: Environment;
  readonly seed: string;
  readonly configDir: string;
}

export function freezeReferencePopulation(inputs: FreezeInputs): ReferencePopulation {
  // Resolved once, against the baseline, deliberately. Generating separately per
  // environment is the bug; resolving against the candidate instead would just
  // move the bias to the other side.
  const resolved = resolveDeckSource(inputs.source, inputs.baseline, inputs.seed, inputs.configDir);

  const excluded: ExcludedDeck[] = resolved.rejected.map((entry) => ({
    deckId: entry.id,
    deckHash: '',
    environmentId: inputs.baseline.id,
    reasons: [...entry.reasons],
  }));

  const kept: SimDeck[] = [];
  for (const deck of resolved.decks) {
    const inCandidate = checkDeck(deck, inputs.candidate);
    if (inCandidate.legal) {
      kept.push(deck);
      continue;
    }
    excluded.push({
      deckId: deck.id,
      deckHash: deck.hash,
      environmentId: inputs.candidate.id,
      reasons: inCandidate.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => `${issue.code}: ${issue.message}`),
    });
  }

  const decks = [...kept].sort((left, right) => left.hash.localeCompare(right.hash));

  return {
    schemaVersion: REFERENCE_POPULATION_VERSION,
    policy: 'shared_legal_reference_population',
    hash: populationHash(decks),
    resolvedHash: populationHash(resolved.decks),
    resolvedAgainst: inputs.baseline.id,
    decks,
    excluded: excluded.sort(
      (left, right) =>
        left.environmentId.localeCompare(right.environmentId) ||
        left.deckId.localeCompare(right.deckId),
    ),
  };
}

/**
 * Content hash of a set of decks, independent of the order they arrive in.
 *
 * Built from the decks' own canonical hashes, so it changes exactly when a
 * Commander or a quantity changes and never when an entry order does.
 */
export function populationHash(decks: readonly SimDeck[]): string {
  return digestOf({
    version: REFERENCE_POPULATION_VERSION,
    decks: [...decks].map((deck) => deck.hash).sort(),
  });
}

/**
 * Guards the invariant at the point it could still be violated.
 *
 * Both arms are driven from one frozen population, so a mismatch here means a
 * programming error rather than a configuration one — which is precisely why it
 * must throw loudly instead of being reported as a limitation and averaged in.
 */
export function assertSharedPopulation(
  baselineHash: string,
  candidateHash: string,
  context: string,
): void {
  if (baselineHash === candidateHash) return;
  throw new Error(
    `${context}: the baseline and candidate runs used different reference populations ` +
      `(${baselineHash} vs ${candidateHash}). A comparison across two populations cannot ` +
      'attribute a difference to the environment change, so it is refused rather than reported.',
  );
}
