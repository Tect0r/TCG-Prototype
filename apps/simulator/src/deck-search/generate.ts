import { z } from 'zod';
import { isColorIdentityLegal, type CardDefinition, type CardId, type Role } from '@tcg/card-data';
import { nextInt, type RngState } from '@tcg/rules-engine';
import type { Environment } from '../environment.js';
import { rngFor } from '../seed.js';
import { checkDeck, deckSize, makeDeck, type SimDeck } from './deck.js';

/**
 * Legal random and stratified deck generation (CLAUDE.md §13.8).
 *
 * `validateDeck` is the final authority: nothing here "repairs" an illegal deck
 * quietly. Generation either produces something the deck builder would accept or
 * returns structured diagnostics saying why it could not.
 *
 * Stratification exists because an unweighted random draw over a small pool
 * collapses almost immediately onto whichever cards happen to be common: the
 * curve and role targets keep the initial population spread across recognisably
 * different strategies so the search has something to search.
 */

export const generatorConfigSchema = z.strictObject({
  /** Restrict generation to these Commanders. Empty means every legal one. */
  commanderIds: z.array(z.string()).default([]),
  /**
   * Target share of the deck by energy cost band. Normalised, then used as a
   * sampling weight — a soft target, not a constraint the generator will break
   * legality to hit.
   */
  curve: z
    .strictObject({
      cheap: z.number().min(0).default(0.4),
      mid: z.number().min(0).default(0.4),
      expensive: z.number().min(0).default(0.2),
    })
    .prefault({}),
  /** Highest cost counted as `cheap`; everything above `midTop` is `expensive`. */
  cheapTop: z.number().int().min(0).default(2),
  midTop: z.number().int().min(0).default(4),
  /** Relative sampling weight per authored role. Missing roles weigh 1. */
  roleWeights: z.record(z.string(), z.number().min(0)).default({}),
  /** Relative sampling weight per authored tag. Missing tags weigh 1. */
  tagWeights: z.record(z.string(), z.number().min(0)).default({}),
  /** Cards that must appear, with a quantity, when the Commander allows them. */
  requiredCards: z
    .array(z.strictObject({ cardId: z.string(), quantity: z.number().int().min(1) }))
    .default([]),
  /** Prefer decks containing at least this many units. Soft. */
  minUnits: z.number().int().min(0).default(8),
});
export type GeneratorConfig = z.infer<typeof generatorConfigSchema>;
export type GeneratorConfigInput = z.input<typeof generatorConfigSchema>;

export interface GenerationDiagnostic {
  readonly code: string;
  readonly message: string;
}

export interface GenerationResult {
  readonly deck: SimDeck | null;
  readonly diagnostics: readonly GenerationDiagnostic[];
}

type Band = 'cheap' | 'mid' | 'expensive';

function bandOf(card: CardDefinition, config: GeneratorConfig): Band {
  const cost = card.cost ?? 0;
  if (cost <= config.cheapTop) return 'cheap';
  if (cost <= config.midTop) return 'mid';
  return 'expensive';
}

function weightOf(card: CardDefinition, config: GeneratorConfig): number {
  const role = config.roleWeights[(card.role ?? 'support') as Role] ?? 1;
  const tag = card.tags.reduce((best, entry) => Math.max(best, config.tagWeights[entry] ?? 0), 0);
  const band = config.curve[bandOf(card, config)];
  return Math.max(0, role * (tag > 0 ? tag : 1) * (band > 0 ? band : 0.01));
}

/** Cards a Commander may legally run, in stable ID order. */
export function poolFor(environment: Environment, commander: CardDefinition): CardDefinition[] {
  return environment.pool
    .filter((card) => isColorIdentityLegal(card.colorIdentity, commander.colorIdentity))
    .sort((left, right) => left.id.localeCompare(right.id));
}

/**
 * Builds one legal deck for the given Commander, or explains why it could not.
 *
 * The draw is weighted but never unbounded: a card that has hit its copy limit
 * is removed from the pool rather than re-rolled, so the loop terminates even
 * when the legal pool is barely large enough to fill a deck.
 */
export function generateDeck(
  environment: Environment,
  seed: string,
  input: GeneratorConfigInput = {},
  options: { readonly label?: string; readonly commanderId?: CardId } = {},
): GenerationResult {
  const config = generatorConfigSchema.parse(input);
  const diagnostics: GenerationDiagnostic[] = [];
  let rng = rngFor(seed);

  const allowedCommanders = environment.commanders
    .filter(
      (card) =>
        (config.commanderIds.length === 0 || config.commanderIds.includes(card.id)) &&
        card.colorIdentity.length <= environment.deckFormat.maxCommanderColors,
    )
    .sort((left, right) => left.id.localeCompare(right.id));

  if (allowedCommanders.length === 0) {
    return {
      deck: null,
      diagnostics: [
        {
          code: 'sim/no_legal_commander',
          message: `Environment "${environment.id}" has no Commander matching the generator configuration.`,
        },
      ],
    };
  }

  const commander =
    (options.commanderId
      ? allowedCommanders.find((card) => card.id === options.commanderId)
      : undefined) ?? pick(allowedCommanders);
  if (options.commanderId && commander.id !== options.commanderId) {
    diagnostics.push({
      code: 'sim/commander_unavailable',
      message: `Commander "${options.commanderId}" is not legal here; used "${commander.id}" instead.`,
    });
  }

  const pool = poolFor(environment, commander);
  const capacity = pool.reduce(
    (sum, card) =>
      sum +
      (card.unique ? environment.deckFormat.uniqueCopyLimit : environment.deckFormat.copyLimit),
    0,
  );
  if (capacity < environment.deckFormat.deckSize) {
    return {
      deck: null,
      diagnostics: [
        {
          code: 'sim/pool_too_small',
          message:
            `"${commander.name}" can legally run at most ${capacity} cards, ` +
            `but the format needs ${environment.deckFormat.deckSize}.`,
        },
      ],
    };
  }

  const counts = new Map<CardId, number>();
  const limitOf = (card: CardDefinition): number =>
    card.unique ? environment.deckFormat.uniqueCopyLimit : environment.deckFormat.copyLimit;

  for (const required of config.requiredCards) {
    const card = pool.find((entry) => entry.id === required.cardId);
    if (!card) {
      diagnostics.push({
        code: 'sim/required_card_illegal',
        message: `Required card "${required.cardId}" is not legal under "${commander.name}"; skipped.`,
      });
      continue;
    }
    counts.set(card.id, Math.min(required.quantity, limitOf(card)));
  }

  const available = pool.filter((card) => (counts.get(card.id) ?? 0) < limitOf(card));
  const target = environment.deckFormat.deckSize;

  while (total(counts) < target) {
    const remaining = available.filter((card) => (counts.get(card.id) ?? 0) < limitOf(card));
    if (remaining.length === 0) {
      return {
        deck: null,
        diagnostics: [
          ...diagnostics,
          {
            code: 'sim/pool_exhausted',
            message: `Ran out of legal cards at ${total(counts)} of ${target}.`,
          },
        ],
      };
    }
    // Once units are scarce, bias hard toward them: a deck with no units is
    // legal but cannot attack or block, which is not a strategy worth searching.
    const unitsSoFar = countUnits(counts, pool);
    const candidates =
      unitsSoFar < config.minUnits && remaining.some((card) => card.type === 'unit')
        ? remaining.filter((card) => card.type === 'unit')
        : remaining;

    const chosen = weightedPick(candidates, config);
    counts.set(chosen.id, (counts.get(chosen.id) ?? 0) + 1);
  }

  const deck = makeDeck({
    commanderId: commander.id,
    cards: [...counts].map(([cardId, quantity]) => ({ cardId, quantity })),
    label: options.label ?? `${commander.name} ${seed.slice(-6)}`,
    origin: { kind: 'random', parentHashes: [], generation: 0, changes: [], mutationSeed: seed },
  });

  const legality = checkDeck(deck, environment);
  if (!legality.legal) {
    return {
      deck: null,
      diagnostics: [
        ...diagnostics,
        ...legality.issues
          .filter((issue) => issue.severity === 'error')
          .map((issue) => ({ code: issue.code, message: issue.message })),
      ],
    };
  }

  return { deck, diagnostics };

  function pick<T>(items: readonly T[]): T {
    const roll = nextInt(rng, items.length);
    rng = roll.state;
    return items[roll.value] as T;
  }

  function weightedPick(items: readonly CardDefinition[], cfg: GeneratorConfig): CardDefinition {
    // Integer roulette wheel so the draw is bit-for-bit reproducible.
    const scaled = items.map((card) => Math.max(1, Math.round(weightOf(card, cfg) * 1000)));
    const sum = scaled.reduce((acc, value) => acc + value, 0);
    const roll = nextInt(rng, sum);
    rng = roll.state;
    let ticket = roll.value;
    for (let index = 0; index < items.length; index += 1) {
      ticket -= scaled[index] ?? 0;
      if (ticket < 0) return items[index] as CardDefinition;
    }
    return items[items.length - 1] as CardDefinition;
  }
}

function total(counts: ReadonlyMap<CardId, number>): number {
  let sum = 0;
  for (const quantity of counts.values()) sum += quantity;
  return sum;
}

function countUnits(counts: ReadonlyMap<CardId, number>, pool: readonly CardDefinition[]): number {
  const units = new Set(pool.filter((card) => card.type === 'unit').map((card) => card.id));
  let sum = 0;
  for (const [cardId, quantity] of counts) if (units.has(cardId)) sum += quantity;
  return sum;
}

/**
 * A stratified starting population: every legal Commander is used before any is
 * used twice, and each slot gets its own derived seed.
 *
 * Without this, an unweighted random population over a small pool routinely
 * lands on one Commander and one cluster, and the search then reports that it
 * "converged" on a strategy it never had an alternative to (CLAUDE.md §13.8).
 */
export function generatePopulation(
  environment: Environment,
  seed: string,
  size: number,
  input: GeneratorConfigInput = {},
): { readonly decks: readonly SimDeck[]; readonly diagnostics: readonly GenerationDiagnostic[] } {
  const config = generatorConfigSchema.parse(input);
  const commanders =
    config.commanderIds.length > 0
      ? environment.commanders.filter((card) => config.commanderIds.includes(card.id))
      : [...environment.commanders];
  commanders.sort((left, right) => left.id.localeCompare(right.id));

  const decks: SimDeck[] = [];
  const diagnostics: GenerationDiagnostic[] = [];
  const seen = new Set<string>();

  for (let index = 0; decks.length < size && index < size * 8; index += 1) {
    const commander = commanders[index % Math.max(1, commanders.length)];
    const result = generateDeck(environment, `${seed}|deck:${index}`, input, {
      ...(commander ? { commanderId: commander.id } : {}),
      label: `pop_${String(decks.length).padStart(3, '0')}`,
    });
    diagnostics.push(...result.diagnostics);
    if (!result.deck) continue;
    // Deduplicate by canonical hash so the population is genuinely diverse.
    if (seen.has(result.deck.hash)) continue;
    seen.add(result.deck.hash);
    decks.push(result.deck);
  }

  if (decks.length < size) {
    diagnostics.push({
      code: 'sim/population_short',
      message: `Asked for ${size} distinct legal decks but only produced ${decks.length}.`,
    });
  }

  return { decks, diagnostics };
}

/** Convenience for tests and callers that only need the size to be right. */
export function isFullSize(deck: SimDeck, environment: Environment): boolean {
  return deckSize(deck) === environment.deckFormat.deckSize;
}

export type { RngState };
