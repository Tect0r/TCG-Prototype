import { z } from 'zod';
import {
  isColorIdentityLegal,
  type CardDefinition,
  type CardId,
  type ColorId,
} from '@tcg/card-data';
import type { Environment } from '../environment.js';
import { checkDeck, makeDeck, type SimDeck } from '../deck-search/deck.js';
import type { MatchRecord } from '../telemetry/schema.js';
import { pairedBinary } from './paired.js';
import { cohensH, effectSizeLabel, proportion, round } from './stats.js';

/**
 * Controlled card replacement (CLAUDE.md §13.10).
 *
 * Card-level diagnosis leans on substitution rather than on correlation: take a
 * legal deck, change exactly one card, replay the *same* seeded games against
 * the *same* opponents, and measure what moved. Everything else about the deck,
 * the schedule and the pilots is held fixed by construction.
 *
 * The confound list is the important half. A substitution that changes the
 * deck's colour identity, its curve, or the synergy it was built around is not a
 * controlled experiment, and the result is reported with that stated rather than
 * suppressed or silently believed.
 */

export const replacementVariantSchema = z.strictObject({
  baseDeckHash: z.string(),
  variantDeckHash: z.string(),
  subjectCardId: z.string(),
  /** `null` means the copies were removed and the deck refilled elsewhere. */
  replacementCardId: z.string().nullable(),
  copiesChanged: z.number().int().min(0),
  confounds: z.array(z.string()),
});
export type ReplacementVariant = z.infer<typeof replacementVariantSchema>;

/**
 * Cards comparable enough for a substitution to mean something: same type, a
 * cost within one, and colour-legal in the same deck. Role, tags and power class
 * refine the ranking rather than gating it, so a genuinely unusual card still
 * gets *some* comparison rather than none.
 */
export function comparableCards(
  environment: Environment,
  subjectId: CardId,
  commanderColors: readonly ColorId[],
  limit = 6,
): CardDefinition[] {
  const subject = environment.database.get(subjectId);
  if (!subject) return [];

  const scored = environment.pool
    .filter((card) => card.id !== subjectId)
    .filter((card) => card.type === subject.type)
    .filter((card) => isColorIdentityLegal(card.colorIdentity, commanderColors))
    .filter((card) => Math.abs((card.cost ?? 0) - (subject.cost ?? 0)) <= 1)
    .map((card) => {
      let score = 0;
      if (card.role === subject.role) score += 3;
      if (card.powerClass === subject.powerClass) score += 2;
      score += card.tags.filter((tag) => subject.tags.includes(tag)).length;
      score -= Math.abs((card.cost ?? 0) - (subject.cost ?? 0));
      return { card, score };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.card.id.localeCompare(right.card.id);
    });

  return scored.slice(0, limit).map((entry) => entry.card);
}

export interface VariantResult {
  readonly deck: SimDeck | null;
  readonly variant: ReplacementVariant | null;
  readonly reasons: readonly string[];
}

/**
 * Builds "the same deck, but with `copies` of `subjectCardId` replaced".
 *
 * Returns `null` rather than a repaired deck when the swap would be illegal:
 * an experiment that quietly played a different deck than it claimed is worse
 * than an experiment that reported it could not run.
 */
export function buildReplacementVariant(
  base: SimDeck,
  environment: Environment,
  subjectCardId: CardId,
  replacementCardId: CardId | null,
  copies: number | 'all',
): VariantResult {
  const entry = base.cards.find((card) => card.cardId === subjectCardId);
  if (!entry) {
    return { deck: null, variant: null, reasons: [`"${base.id}" does not run ${subjectCardId}`] };
  }

  const changed = copies === 'all' ? entry.quantity : Math.min(copies, entry.quantity);
  const cards = base.cards
    .map((card) =>
      card.cardId === subjectCardId
        ? { cardId: card.cardId, quantity: card.quantity - changed }
        : { ...card },
    )
    .filter((card) => card.quantity > 0);

  if (replacementCardId !== null) {
    const limit = environment.database.get(replacementCardId)?.unique
      ? environment.deckFormat.uniqueCopyLimit
      : environment.deckFormat.copyLimit;
    const existing = cards.find((card) => card.cardId === replacementCardId);
    const after = (existing?.quantity ?? 0) + changed;
    if (after > limit) {
      return {
        deck: null,
        variant: null,
        reasons: [
          `replacing with ${replacementCardId} would need ${after} copies, over the limit of ${limit}`,
        ],
      };
    }
    if (existing) existing.quantity = after;
    else cards.push({ cardId: replacementCardId, quantity: changed });
  } else {
    // Pure removal would leave the deck short, which is illegal in every format
    // the prototype has — so "remove the card" has to mean "and play more of what
    // the deck already runs". §13.10 wants removal tested, and a variant that can
    // never be built would silently turn that experiment into no experiment.
    const refilled = refillFrom(cards, environment, changed, subjectCardId);
    if (refilled === null) {
      return {
        deck: null,
        variant: null,
        reasons: [
          `removing ${changed} copies of ${subjectCardId} leaves ${changed} slot(s) that the ` +
            `deck's remaining cards cannot legally fill`,
        ],
      };
    }
  }

  const variantDeck = makeDeck({
    commanderId: base.commanderId,
    cards,
    label: `${base.label} [-${changed} ${subjectCardId}${replacementCardId ? ` +${replacementCardId}` : ''}]`,
    origin: {
      kind: 'replacement',
      parentHashes: [base.hash],
      generation: 0,
      changes: [
        `-${changed} ${subjectCardId}`,
        ...(replacementCardId ? [`+${changed} ${replacementCardId}`] : []),
      ],
      mutationSeed: '',
    },
  });

  const legality = checkDeck(variantDeck, environment);
  if (!legality.legal) {
    return {
      deck: null,
      variant: null,
      reasons: legality.issues
        .filter((issue) => issue.severity === 'error')
        .map((issue) => issue.message),
    };
  }

  return {
    deck: variantDeck,
    variant: {
      baseDeckHash: base.hash,
      variantDeckHash: variantDeck.hash,
      subjectCardId,
      replacementCardId,
      copiesChanged: changed,
      confounds: confoundsOf(base, variantDeck, environment, subjectCardId, replacementCardId),
    },
    reasons: [],
  };
}

/**
 * Spreads freed slots over the deck's remaining cards, in stable ID order.
 *
 * Mutates `cards` and returns it, or `null` when the copy limits leave nowhere
 * to put them. Deterministic: the same deck always refills the same way.
 */
function refillFrom(
  cards: { cardId: CardId; quantity: number }[],
  environment: Environment,
  slots: number,
  removedCardId: CardId,
): { cardId: CardId; quantity: number }[] | null {
  const limitOf = (cardId: CardId): number =>
    environment.database.get(cardId)?.unique
      ? environment.deckFormat.uniqueCopyLimit
      : environment.deckFormat.copyLimit;

  let remaining = slots;
  // Round-robin over the deck's own cards, so the refill does not distort the
  // curve by piling every freed slot onto whichever card sorts first.
  const order = [...cards]
    .map((entry) => entry.cardId)
    .filter((cardId) => cardId !== removedCardId)
    .sort();
  let progress = true;
  while (remaining > 0 && progress) {
    progress = false;
    for (const cardId of order) {
      if (remaining === 0) break;
      const entry = cards.find((card) => card.cardId === cardId);
      if (!entry || entry.quantity >= limitOf(cardId)) continue;
      entry.quantity += 1;
      remaining -= 1;
      progress = true;
    }
  }
  return remaining === 0 ? cards : null;
}

/**
 * Reasons this substitution is not a clean controlled comparison.
 *
 * CLAUDE.md §13.10 forbids claiming a causal effect when the swap changes
 * legality, strategy identity, curve or required synergy without saying so.
 */
function confoundsOf(
  base: SimDeck,
  variant: SimDeck,
  environment: Environment,
  subjectCardId: CardId,
  replacementCardId: CardId | null,
): string[] {
  const confounds: string[] = [];
  const subject = environment.database.get(subjectCardId);
  const replacement = replacementCardId ? environment.database.get(replacementCardId) : undefined;

  if (replacement && subject) {
    if ((replacement.cost ?? 0) !== (subject.cost ?? 0)) {
      confounds.push(
        `curve changed: ${subjectCardId} costs ${subject.cost}, ${replacementCardId} costs ${replacement.cost}`,
      );
    }
    if (replacement.type !== subject.type) {
      confounds.push(`card type changed: ${subject.type} → ${replacement.type}`);
    }
    if (replacement.role !== subject.role) {
      confounds.push(
        `authored role changed: ${subject.role ?? 'none'} → ${replacement.role ?? 'none'}`,
      );
    }
    const sharedTags = replacement.tags.filter((tag) => subject.tags.includes(tag));
    if (subject.tags.length > 0 && sharedTags.length === 0) {
      confounds.push(
        `no shared tags: any deck synergy keyed on ${subject.tags.join('/')} is also removed`,
      );
    }
    if (replacement.colorIdentity.join('/') !== subject.colorIdentity.join('/')) {
      confounds.push('colour identity of the swapped card differs');
    }
  }

  if (replacementCardId === null) {
    confounds.push(
      'the card was removed rather than swapped: the freed slots were refilled with more of the ' +
        "deck's own cards, so the curve and card mix moved as well",
    );
  }

  // Does any other card in the deck explicitly reference the subject's tags?
  if (subject && subject.tags.length > 0) {
    const dependents = variant.cards.filter((entry) => {
      const card = environment.database.get(entry.cardId);
      if (!card) return false;
      const filters = JSON.stringify([card.effects, card.abilities, card.staticAbilities]);
      return subject.tags.some((tag) => filters.includes(`"${tag}"`));
    });
    if (dependents.length > 0) {
      confounds.push(
        `${dependents.length} remaining card(s) filter on ${subject.tags.join('/')}, so support was left stranded`,
      );
    }
  }

  if (base.commanderId !== variant.commanderId) confounds.push('Commander changed');

  return confounds;
}

export const replacementImpactSchema = z.strictObject({
  subjectCardId: z.string(),
  replacementCardId: z.string().nullable(),
  baseDeckHash: z.string(),
  variantDeckHash: z.string(),
  baseMatches: z.number().int().min(0),
  variantMatches: z.number().int().min(0),
  baseWinRate: z.number(),
  variantWinRate: z.number(),
  /** Base minus variant: positive means removing the subject made things worse. */
  impact: z.number(),
  low: z.number(),
  high: z.number(),
  effectSize: z.number(),
  effectSizeLabel: z.string(),
  pairedGames: z.number().int().min(0),
  /**
   * The full paired estimate: discordant counts, exclusions with reasons, and
   * the interval the headline numbers are taken from (PHASE4_HARDENING §9.1).
   */
  paired: z.unknown(),
  confounds: z.array(z.string()),
  /** Set when the sample is too small for the comparison to mean anything. */
  insufficientData: z.boolean(),
});
export type ReplacementImpact = z.infer<typeof replacementImpactSchema>;

/**
 * Measures what a substitution did, given the two record sets.
 *
 * `impact` is stated as base minus variant so its sign reads naturally: a large
 * positive impact means the deck did *worse* without the subject card, which is
 * the direction that makes a card worth a second look.
 *
 * The estimate is **paired** (PHASE4_HARDENING §9.1). The schedule masks the two
 * arms when deriving seeds precisely so that "deck A" and "deck A with one card
 * swapped" play the same opponents on the same shuffles; analysing the result as
 * two independent samples would discard that design and report a wider interval
 * than the experiment paid for. Games without a partner in the other arm are
 * excluded from the paired estimate, counted, and reported with the reason.
 */
export function replacementImpact(
  variant: ReplacementVariant,
  baseRecords: readonly MatchRecord[],
  variantRecords: readonly MatchRecord[],
  options: {
    readonly confidence?: number;
    readonly minMatches?: number;
    readonly minPairs?: number;
    readonly iterations?: number;
    readonly seed?: string;
  } = {},
): ReplacementImpact {
  const confidence = options.confidence ?? 0.95;
  const minMatches = options.minMatches ?? 30;

  const tally = (records: readonly MatchRecord[], deckHash: string) => {
    let wins = 0;
    let total = 0;
    const games = new Map<string, { won: boolean; stratum: string }>();
    for (const record of records) {
      for (const seat of record.seats) {
        if (seat.deckHash !== deckHash) continue;
        total += 1;
        if (seat.won) wins += 1;
        // Keyed on the *opponent* and the game index rather than on the deck
        // tuple: the base arm and the variant arm are different decks by
        // definition, so a key containing this deck could never match. The
        // schedule masks the arms when deriving seeds, so these two games really
        // did run on the same shuffles (CLAUDE.md §13.10).
        const opponents = record.seats
          .filter((other) => other.playerId !== seat.playerId)
          .map((other) => other.deckHash)
          .sort()
          .join(',');
        games.set(`${opponents}:${record.variantKey}:${record.gameIndex}:${seat.seatIndex}`, {
          won: seat.won,
          stratum: `${seat.pilotId}|${seat.seatIndex}`,
        });
      }
    }
    return { wins, total, games };
  };

  const base = tally(baseRecords, variant.baseDeckHash);
  const changed = tally(variantRecords, variant.variantDeckHash);

  const baseRate = proportion(base.wins, base.total, confidence);
  const variantRate = proportion(changed.wins, changed.total, confidence);
  const h = cohensH(baseRate.point, variantRate.point);

  // `baselineWon` is the *variant* arm and `candidateWon` is the base arm, so
  // the paired delta comes out as base minus variant and `impact` keeps the sign
  // convention documented above.
  const outcomes = [...changed.games]
    .filter(([key]) => base.games.has(key))
    .map(([key, entry]) => ({
      key,
      baselineWon: entry.won,
      candidateWon: base.games.get(key)?.won ?? false,
      stratum: entry.stratum,
    }));

  const unmatchedBase = base.games.size - outcomes.length;
  const unmatchedVariant = changed.games.size - outcomes.length;
  const excluded: Record<string, number> = {};
  if (unmatchedBase > 0) excluded.base_game_without_variant = unmatchedBase;
  if (unmatchedVariant > 0) excluded.variant_game_without_base = unmatchedVariant;

  const paired = pairedBinary(outcomes, {
    seed: `${options.seed ?? 'replacement'}|${variant.baseDeckHash}|${variant.variantDeckHash}`,
    confidence,
    minPairs: options.minPairs ?? 20,
    ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
    ...(Object.keys(excluded).length > 0 ? { excluded } : {}),
  });

  return {
    subjectCardId: variant.subjectCardId,
    replacementCardId: variant.replacementCardId,
    baseDeckHash: variant.baseDeckHash,
    variantDeckHash: variant.variantDeckHash,
    baseMatches: base.total,
    variantMatches: changed.total,
    baseWinRate: round(baseRate.point),
    variantWinRate: round(variantRate.point),
    impact: paired.delta,
    low: paired.low,
    high: paired.high,
    effectSize: round(h),
    effectSizeLabel: effectSizeLabel(h),
    pairedGames: paired.pairs,
    paired,
    confounds: [...variant.confounds],
    insufficientData:
      paired.insufficientEvidence || base.total < minMatches || changed.total < minMatches,
  };
}
