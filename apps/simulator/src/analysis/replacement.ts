import { z } from 'zod';
import {
  isColorIdentityLegal,
  type CardDefinition,
  type CardId,
  type ColorId,
} from '@tcg/card-data';
import type { Environment } from '../environment.js';
import { checkDeck, makeDeck, type SimDeck } from '@tcg/deck-generator';
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

/** A card quantity that moved when a variant was built. */
export const variantCardChangeSchema = z.strictObject({
  cardId: z.string(),
  quantity: z.number().int().min(1),
});
export type VariantCardChange = z.infer<typeof variantCardChangeSchema>;

/**
 * Which direction the subject card moved.
 *
 * `removal` takes the subject *out* of a deck that runs it. `insertion` puts it
 * *into* a deck that does not, paying for the slots by removing comparable
 * cards. They are the two halves of the same question and are analysed with the
 * same paired estimator, but they cannot share a sign convention by accident:
 * the subject lives in the base deck in one and in the variant deck in the other
 * (CLAUDE.md §13.10, readiness §3 A1).
 */
export const VARIANT_DIRECTIONS = ['removal', 'insertion'] as const;
export const variantDirectionSchema = z.enum(VARIANT_DIRECTIONS);
export type VariantDirection = z.infer<typeof variantDirectionSchema>;

export const replacementVariantSchema = z.strictObject({
  baseDeckHash: z.string(),
  variantDeckHash: z.string(),
  subjectCardId: z.string(),
  /** `null` means the copies were removed and the deck refilled elsewhere. */
  replacementCardId: z.string().nullable(),
  copiesChanged: z.number().int().min(0),
  direction: variantDirectionSchema,
  /** Which arm actually contains the subject card. Derived from `direction`. */
  subjectPresentIn: z.enum(['base', 'variant']),
  /** Every card whose quantity went down, with the number of copies removed. */
  removedCards: z.array(variantCardChangeSchema),
  /** Every card whose quantity went up, with the number of copies added. */
  addedCards: z.array(variantCardChangeSchema),
  /** How the cards that paid for the change were chosen. */
  selectionMethod: z.string(),
  /** Whether the constructed deck passed normal deck validation. */
  legal: z.boolean(),
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

  const deltas = quantityDeltas(base.cards, variantDeck.cards);

  return {
    deck: variantDeck,
    variant: {
      baseDeckHash: base.hash,
      variantDeckHash: variantDeck.hash,
      subjectCardId,
      replacementCardId,
      copiesChanged: changed,
      direction: 'removal',
      subjectPresentIn: 'base',
      removedCards: deltas.removed,
      addedCards: deltas.added,
      selectionMethod:
        replacementCardId === null
          ? 'removal_refilled_round_robin_from_own_cards'
          : 'explicit_replacement_card',
      legal: true,
      confounds: confoundsOf(base, variantDeck, environment, subjectCardId, replacementCardId),
    },
    reasons: [],
  };
}

/** Every quantity that moved between two card lists, in stable ID order. */
function quantityDeltas(
  before: readonly { readonly cardId: CardId; readonly quantity: number }[],
  after: readonly { readonly cardId: CardId; readonly quantity: number }[],
): { removed: VariantCardChange[]; added: VariantCardChange[] } {
  const ids = [...new Set([...before, ...after].map((entry) => entry.cardId))].sort();
  const quantityIn = (
    list: readonly { readonly cardId: CardId; readonly quantity: number }[],
    cardId: CardId,
  ): number => list.find((entry) => entry.cardId === cardId)?.quantity ?? 0;

  const removed: VariantCardChange[] = [];
  const added: VariantCardChange[] = [];
  for (const cardId of ids) {
    const delta = quantityIn(after, cardId) - quantityIn(before, cardId);
    if (delta > 0) added.push({ cardId, quantity: delta });
    else if (delta < 0) removed.push({ cardId, quantity: -delta });
  }
  return { removed, added };
}

/* ------------------------------------------------------------------ insertion */

export interface RemovalCandidate {
  readonly cardId: CardId;
  /** Copies of it the base deck actually runs. */
  readonly available: number;
  /** Comparability to the inserted card. Higher is a better thing to cut. */
  readonly score: number;
}

/**
 * The base deck's own cards, ranked by how comparable they are to the card being
 * inserted.
 *
 * An insertion has to pay for its slots, and *which* slots it takes decides what
 * the experiment measures. Cutting two lands' worth of cheap blockers to fit an
 * expensive finisher changes the deck's curve and its plan, and the result then
 * describes that change rather than the inserted card. Ranking by shared type,
 * cost, role and tags keeps the cut as close to a like-for-like exchange as the
 * deck allows — and whatever is left over is reported as a confound rather than
 * hidden (readiness §3 A1).
 */
export function insertionRemovalCandidates(
  base: SimDeck,
  environment: Environment,
  insertedCardId: CardId,
): RemovalCandidate[] {
  const subject = environment.database.get(insertedCardId);

  return base.cards
    .filter((entry) => entry.cardId !== insertedCardId && entry.quantity > 0)
    .map((entry) => {
      const card = environment.database.get(entry.cardId);
      let score = 0;
      if (card && subject) {
        if (card.type === subject.type) score += 4;
        score -= Math.abs((card.cost ?? 0) - (subject.cost ?? 0));
        if (card.role !== undefined && card.role === subject.role) score += 3;
        if (card.powerClass === subject.powerClass) score += 2;
        score += card.tags.filter((tag) => subject.tags.includes(tag)).length;
        // A unique card is a singleton the deck cannot re-buy elsewhere, and
        // cutting one changes the deck's identity more than cutting a spare copy.
        if (card.unique) score -= 3;
      }
      return { cardId: entry.cardId, available: entry.quantity, score };
    })
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.cardId.localeCompare(right.cardId);
    });
}

export interface InsertionOptions {
  /**
   * Cards the experiment insists are cut, in priority order. Anything not in the
   * deck, or short of copies, is an error rather than a silent substitution.
   */
  readonly removeCardIds?: readonly CardId[];
}

/**
 * Builds "the same deck, but now running `copies` of `subjectCardId`".
 *
 * This is the other half of the controlled experiment CLAUDE.md §13.10 asks for,
 * and the half that matters most for a build-around or a brand-new card: a card
 * no existing deck runs cannot be measured by taking it out of one. The deck size
 * is held fixed by removing the same number of copies from cards chosen for their
 * comparability, and every removed card is recorded on the variant.
 *
 * Like `buildReplacementVariant` it returns `null` rather than a repaired deck:
 * an insertion that quietly changed the Commander, exceeded a copy limit or
 * shrank the deck would be measuring something the report does not describe.
 */
export function buildInsertionVariant(
  base: SimDeck,
  environment: Environment,
  subjectCardId: CardId,
  copies: number | 'all',
  options: InsertionOptions = {},
): VariantResult {
  const subject = environment.database.get(subjectCardId);
  if (!subject) {
    return {
      deck: null,
      variant: null,
      reasons: [`${subjectCardId} is not defined in this environment`],
    };
  }
  if (!environment.pool.some((card) => card.id === subjectCardId)) {
    return {
      deck: null,
      variant: null,
      reasons: [`${subjectCardId} is not in this environment's playable pool`],
    };
  }

  const commander = environment.database.get(base.commanderId);
  if (commander && !isColorIdentityLegal(subject.colorIdentity, commander.colorIdentity)) {
    return {
      deck: null,
      variant: null,
      reasons: [
        `${subjectCardId} is not legal under "${base.id}"'s Commander colour identity ` +
          `(${commander.colorIdentity.join('/') || 'colourless'})`,
      ],
    };
  }

  const limit = subject.unique
    ? environment.deckFormat.uniqueCopyLimit
    : environment.deckFormat.copyLimit;
  const existing = base.cards.find((entry) => entry.cardId === subjectCardId)?.quantity ?? 0;
  const wanted = copies === 'all' ? limit - existing : copies;

  if (wanted <= 0) {
    return {
      deck: null,
      variant: null,
      reasons: [
        `"${base.id}" already runs ${existing} cop${existing === 1 ? 'y' : 'ies'} of ` +
          `${subjectCardId}, which is the limit of ${limit}`,
      ],
    };
  }
  if (existing + wanted > limit) {
    return {
      deck: null,
      variant: null,
      reasons: [
        `inserting ${wanted} copies of ${subjectCardId} would need ${existing + wanted}, ` +
          `over the limit of ${limit}`,
      ],
    };
  }

  const cards = base.cards.map((entry) => ({ ...entry }));
  const removalPlan = planRemovals(cards, environment, base, subjectCardId, wanted, options);
  if (removalPlan.reasons.length > 0) {
    return { deck: null, variant: null, reasons: removalPlan.reasons };
  }

  const subjectEntry = cards.find((entry) => entry.cardId === subjectCardId);
  if (subjectEntry) subjectEntry.quantity += wanted;
  else cards.push({ cardId: subjectCardId, quantity: wanted });

  const withStock = cards.filter((entry) => entry.quantity > 0);
  const removedLabel = removalPlan.removed
    .map((entry) => `-${entry.quantity} ${entry.cardId}`)
    .join(' ');

  const variantDeck = makeDeck({
    commanderId: base.commanderId,
    cards: withStock,
    label: `${base.label} [+${wanted} ${subjectCardId}]`,
    origin: {
      kind: 'replacement',
      parentHashes: [base.hash],
      generation: 0,
      changes: [
        `+${wanted} ${subjectCardId}`,
        ...removalPlan.removed.map((e) => `-${e.quantity} ${e.cardId}`),
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

  const deltas = quantityDeltas(base.cards, variantDeck.cards);

  return {
    deck: variantDeck,
    variant: {
      baseDeckHash: base.hash,
      variantDeckHash: variantDeck.hash,
      subjectCardId,
      replacementCardId: null,
      copiesChanged: wanted,
      direction: 'insertion',
      // The subject is only in the constructed deck, so the paired estimator has
      // to read the arms the other way round from a removal.
      subjectPresentIn: 'variant',
      removedCards: deltas.removed,
      addedCards: deltas.added,
      selectionMethod: removalPlan.method,
      legal: true,
      confounds: insertionConfoundsOf(
        base,
        environment,
        subject,
        removalPlan.removed,
        removedLabel,
      ),
    },
    reasons: [],
  };
}

interface RemovalPlan {
  readonly removed: readonly VariantCardChange[];
  readonly method: string;
  readonly reasons: readonly string[];
}

/**
 * Decides — and applies — which copies pay for an insertion.
 *
 * Explicit removals are honoured exactly, in the order given. Otherwise copies
 * are taken round-robin down the comparability ranking, so a two-copy insertion
 * shaves one copy off each of the two most comparable cards rather than deleting
 * whichever card happens to sort first.
 */
function planRemovals(
  cards: { cardId: CardId; quantity: number }[],
  environment: Environment,
  base: SimDeck,
  subjectCardId: CardId,
  needed: number,
  options: InsertionOptions,
): RemovalPlan {
  const removed = new Map<CardId, number>();
  const take = (cardId: CardId): boolean => {
    const entry = cards.find((card) => card.cardId === cardId);
    if (!entry || entry.quantity <= 0) return false;
    entry.quantity -= 1;
    removed.set(cardId, (removed.get(cardId) ?? 0) + 1);
    return true;
  };
  const asList = (): VariantCardChange[] =>
    [...removed.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([cardId, quantity]) => ({ cardId, quantity }));

  const explicit = options.removeCardIds ?? [];
  if (explicit.length > 0) {
    for (const cardId of explicit) {
      if (cardId === subjectCardId) {
        return {
          removed: [],
          method: 'explicit_removal_cards',
          reasons: [`${cardId} cannot pay for its own insertion`],
        };
      }
      if (!base.cards.some((entry) => entry.cardId === cardId)) {
        return {
          removed: [],
          method: 'explicit_removal_cards',
          reasons: [`"${base.id}" does not run ${cardId}, so it cannot pay for the insertion`],
        };
      }
    }
    let remaining = needed;
    let progress = true;
    while (remaining > 0 && progress) {
      progress = false;
      for (const cardId of explicit) {
        if (remaining === 0) break;
        if (!take(cardId)) continue;
        remaining -= 1;
        progress = true;
      }
    }
    if (remaining > 0) {
      return {
        removed: [],
        method: 'explicit_removal_cards',
        reasons: [
          `the declared removal cards (${explicit.join(', ')}) supply only ${needed - remaining} ` +
            `of the ${needed} slot(s) inserting ${subjectCardId} needs`,
        ],
      };
    }
    return { removed: asList(), method: 'explicit_removal_cards', reasons: [] };
  }

  const ranked = insertionRemovalCandidates(base, environment, subjectCardId);
  let remaining = needed;
  let progress = true;
  while (remaining > 0 && progress) {
    progress = false;
    for (const candidate of ranked) {
      if (remaining === 0) break;
      if (!take(candidate.cardId)) continue;
      remaining -= 1;
      progress = true;
    }
  }
  if (remaining > 0) {
    return {
      removed: [],
      method: 'comparable_cards_round_robin',
      reasons: [
        `no legal removal candidate: "${base.id}" has no other card left to cut for ` +
          `${remaining} of the ${needed} slot(s) inserting ${subjectCardId} needs`,
      ],
    };
  }
  return { removed: asList(), method: 'comparable_cards_round_robin', reasons: [] };
}

/**
 * Why an insertion is not a clean controlled comparison.
 *
 * The most important entry is the last one: a card inserted into a deck with no
 * support for it is a *stress test*, and a poor result is evidence about the
 * pairing, not about the card (readiness §3 A1).
 */
function insertionConfoundsOf(
  base: SimDeck,
  environment: Environment,
  subject: CardDefinition,
  removed: readonly VariantCardChange[],
  removedLabel: string,
): string[] {
  const confounds: string[] = [
    `the card was inserted rather than swapped in place: ${removedLabel || 'no copies'} ` +
      'were cut to hold the deck size, so the curve and card mix moved as well',
  ];

  for (const entry of removed) {
    const card = environment.database.get(entry.cardId);
    if (!card) continue;
    if ((card.cost ?? 0) !== (subject.cost ?? 0)) {
      confounds.push(
        `curve changed: ${entry.quantity} × ${entry.cardId} at ${card.cost} energy made room ` +
          `for ${subject.id} at ${subject.cost}`,
      );
    }
    if (card.type !== subject.type) {
      confounds.push(`card type changed: ${entry.quantity} × ${card.type} → ${subject.type}`);
    }
    if (card.role !== undefined && card.role !== subject.role) {
      confounds.push(
        `authored role changed: ${entry.cardId} (${card.role}) → ${subject.id} ` +
          `(${subject.role ?? 'none'})`,
      );
    }
  }

  // Build-around context. A payoff with none of its enablers in the deck is being
  // measured without the thing that makes it work, and the report has to say so
  // rather than let a low win rate read as "the card is weak".
  if (subject.tags.length > 0) {
    const supporters = base.cards.filter((entry) => {
      if (entry.cardId === subject.id) return false;
      const card = environment.database.get(entry.cardId);
      if (!card) return false;
      if (card.tags.some((tag) => subject.tags.includes(tag))) return true;
      const filters = JSON.stringify([card.effects, card.abilities, card.staticAbilities]);
      return subject.tags.some((tag) => filters.includes(`"${tag}"`));
    });
    if (supporters.length === 0) {
      confounds.push(
        `no card in "${base.id}" shares or references ${subject.tags.join('/')}: this is a ` +
          'stress/control experiment measuring the card without its support, not evidence that ' +
          'the card is weak',
      );
    }
  }
  if (subject.role === 'build_around' || subject.powerClass === 'centerpiece') {
    confounds.push(
      `${subject.id} is authored as ${subject.role === 'build_around' ? 'a build-around' : 'a centerpiece'}, ` +
        'so an insertion into a deck that was not designed for it measures the floor rather than the card',
    );
  }

  return confounds;
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
  /** `removal` or `insertion`. Decides which arm holds the subject card. */
  direction: variantDirectionSchema,
  /** Cards whose copies paid for the change, so the table can be reconciled. */
  removedCards: z.array(variantCardChangeSchema),
  addedCards: z.array(variantCardChangeSchema),
  selectionMethod: z.string(),
  /**
   * The subject card's paired contribution: the win rate of the arm that runs it
   * minus the win rate of the arm that does not.
   *
   * Stated this way so the sign reads the same for both directions — a large
   * positive impact always means "the deck did better with this card" — instead
   * of flipping meaning depending on how the variant happened to be built.
   */
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
 * `impact` is stated as with-subject minus without-subject so its sign reads
 * naturally in both directions: a large positive impact means the deck did
 * *worse* without the subject card, which is what makes a card worth a second
 * look, whether that was learned by taking the card out or by putting it in.
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

  // Which arm actually runs the card. A removal leaves it in the base deck; an
  // insertion puts it in the constructed one. Everything downstream is stated in
  // terms of "with" and "without" so neither direction can silently invert the
  // sign of the headline number (readiness §3 A1).
  const insertion = variant.direction === 'insertion';
  const withSubject = insertion ? changed : base;
  const withoutSubject = insertion ? base : changed;
  const withRate = insertion ? variantRate : baseRate;
  const withoutRate = insertion ? baseRate : variantRate;
  const h = cohensH(withRate.point, withoutRate.point);

  // `baselineWon` is the arm *without* the subject and `candidateWon` the arm
  // with it, so the paired delta comes out as with-minus-without and `impact`
  // keeps the sign convention documented above.
  const outcomes = [...withoutSubject.games]
    .filter(([key]) => withSubject.games.has(key))
    .map(([key, entry]) => ({
      key,
      baselineWon: entry.won,
      candidateWon: withSubject.games.get(key)?.won ?? false,
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
    direction: variant.direction,
    removedCards: variant.removedCards.map((entry) => ({ ...entry })),
    addedCards: variant.addedCards.map((entry) => ({ ...entry })),
    selectionMethod: variant.selectionMethod,
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
