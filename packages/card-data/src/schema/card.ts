import { z } from 'zod';
import {
  CARD_SCHEMA_VERSION,
  cardIdSchema,
  cardTypeSchema,
  colorIdentitySchema,
  keywordIdSchema,
  powerClassSchema,
  roleSchema,
  tagSchema,
} from './primitives.js';
import {
  abilityDefinitionSchema,
  activatedAbilityDefinitionSchema,
  effectDefinitionSchema,
  staticAbilityDefinitionSchema,
} from './effect.js';

const uniqueArray = <T extends z.ZodTypeAny>(item: T, label: string) =>
  z.array(item).refine((values) => new Set(values).size === values.length, {
    message: `${label} must not contain duplicates.`,
  });

/**
 * Optional player-help metadata. Presentation only, exactly like `displayText`:
 * none of it is ever executed, parsed for behaviour, or consulted by the engine.
 *
 * There is deliberately no `rules` field here. `displayText` is the canonical
 * rules text and remains the only place it is written, so a card can never have
 * two competing "official" texts.
 *
 * Nothing in this object is required. A card with no curated help still gets a
 * complete explanation, generated from its structured effects — curated text
 * supplements the generated explanation, it never replaces the mechanism.
 */
const cardTextSchema = z.strictObject({
  /** One-sentence beginner explanation. Replaces the generated summary. */
  summary: z.string().min(1).max(300).optional(),
  /**
   * Clarifications for complex steps, index-aligned with the card's top-level
   * `effects`. Shown *beside* the generated step, never instead of it, so a
   * stale clarification cannot hide what the card really does.
   */
  effectExplanations: z.array(z.string().min(1).max(300)).max(20).optional(),
  /** Edge cases worth showing to players. */
  notes: z.array(z.string().min(1).max(400)).max(10).optional(),
  /** Non-rules flavour text. */
  flavor: z.string().min(1).max(300).optional(),
});
export type CardText = z.infer<typeof cardTextSchema>;

const baseCardSchema = z.strictObject({
  schemaVersion: z.number().int().min(1),
  id: cardIdSchema,
  name: z.string().min(1).max(80),
  type: cardTypeSchema,
  colorIdentity: colorIdentitySchema,
  /** `null` means the card is never paid for from hand (Commanders, tokens). */
  cost: z.number().int().min(0).max(20).nullable(),
  attack: z.number().int().min(0).max(99).optional(),
  health: z.number().int().min(1).max(99).optional(),
  /** Unique cards are limited to a single copy per deck. */
  unique: z.boolean().default(false),
  /** Non-collectible cards exist in the database but cannot be chosen in the deck builder. */
  collectible: z.boolean().default(true),
  tags: uniqueArray(tagSchema, 'tags').default([]),
  keywords: uniqueArray(keywordIdSchema, 'keywords').default([]),
  role: roleSchema.optional(),
  powerClass: powerClassSchema.optional(),
  /**
   * Effects resolved when the card is played: spell resolution, and unit/relic
   * deploy resolution. The single authoring form for deploy behaviour — there is
   * no `on_deploy` trigger (CLAUDE.md §17 Q1).
   */
  effects: z.array(effectDefinitionSchema).default([]),
  /** Effects resolved when a non-deploy trigger fires while the card is in play. */
  abilities: z.array(abilityDefinitionSchema).default([]),
  /** Abilities the controller chooses to use, paying their costs first. */
  activatedAbilities: z.array(activatedAbilityDefinitionSchema).default([]),
  /** Continuous effects, recomputed from state rather than applied once. */
  staticAbilities: z.array(staticAbilityDefinitionSchema).default([]),
  /** Presentation only. Never executed, never parsed for behaviour. */
  displayText: z.string().max(400).optional(),
  /** Optional curated help. Supplements generated explanations; never behaviour. */
  text: cardTextSchema.optional(),
});

/** Card types that carry a combat statline. */
const STATTED_TYPES = new Set(['unit', 'commander', 'token']);

export const cardDefinitionSchema = baseCardSchema.superRefine((card, ctx) => {
  const needsStats = STATTED_TYPES.has(card.type);

  if (needsStats) {
    if (card.attack === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['attack'],
        message: `A ${card.type} must define attack.`,
      });
    }
    if (card.health === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['health'],
        message: `A ${card.type} must define health.`,
      });
    }
  } else {
    if (card.attack !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['attack'],
        message: `A ${card.type} must not define attack.`,
      });
    }
    if (card.health !== undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['health'],
        message: `A ${card.type} must not define health.`,
      });
    }
  }

  if (card.type === 'commander' || card.type === 'token') {
    if (card.cost !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['cost'],
        message: `A ${card.type} is never paid for from hand and must have cost null.`,
      });
    }
  } else if (card.cost === null) {
    ctx.addIssue({
      code: 'custom',
      path: ['cost'],
      message: `A ${card.type} must define an energy cost.`,
    });
  }

  if (card.type === 'commander' && card.colorIdentity.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['colorIdentity'],
      message: 'A Commander must have at least one colour in its colour identity.',
    });
  }

  if (card.type === 'token' && card.collectible) {
    ctx.addIssue({
      code: 'custom',
      path: ['collectible'],
      message: 'Tokens are created by effects and must not be collectible.',
    });
  }

  // Spells leave play as they resolve, so a trigger would never fire.
  if (card.type === 'spell' && card.abilities.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['abilities'],
      message: 'Spells resolve and leave play; use `effects` instead of triggered abilities.',
    });
  }

  if (card.type === 'spell' && card.staticAbilities.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['staticAbilities'],
      message: 'Spells resolve and leave play; they cannot carry a continuous effect.',
    });
  }

  if (card.type === 'spell' && card.effects.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['effects'],
      message: 'A spell must define at least one effect.',
    });
  }

  // Curated step clarifications are index-aligned with `effects`. More of them
  // than there are steps means the card was edited and the prose was not — the
  // exact drift this metadata is supposed to be safe from.
  const explanations = card.text?.effectExplanations;
  if (explanations !== undefined && explanations.length > card.effects.length) {
    ctx.addIssue({
      code: 'custom',
      path: ['text', 'effectExplanations'],
      message: `${explanations.length} effect explanations were written for ${card.effects.length} effect(s). Each entry clarifies the effect at the same index.`,
    });
  }
});

export type CardDefinition = z.infer<typeof cardDefinitionSchema>;
/** Card shape before schema defaults are applied — what authors write in JSON. */
export type CardDefinitionInput = z.input<typeof cardDefinitionSchema>;

/**
 * Fields a card *patch* may change.
 *
 * A deliberate allow-list rather than a partial of the whole card. `id` and
 * `type` are excluded because changing either produces a different card wearing
 * the old one's identity, and every deck hash, record and replay downstream
 * would then be quietly wrong about what was played. `schemaVersion` is excluded
 * because a patch is not a migration.
 */
export const PATCHABLE_CARD_FIELDS = [
  'name',
  'colorIdentity',
  'cost',
  'attack',
  'health',
  'unique',
  'collectible',
  'tags',
  'keywords',
  'role',
  'powerClass',
  'effects',
  'abilities',
  'activatedAbilities',
  'staticAbilities',
  'displayText',
  'text',
] as const;
export type PatchableCardField = (typeof PATCHABLE_CARD_FIELDS)[number];

/**
 * The body of a card patch: any subset of the patchable fields.
 *
 * Deliberately **not** `baseCardSchema.pick(…).partial()`, which is the obvious
 * construction and the wrong one. `.partial()` makes a field optional but leaves
 * its `.default()` in place, and a default fires when the key is absent — so
 * every patch would arrive carrying `tags: []`, `keywords: []` and `effects: []`
 * whether or not it mentioned them, and `{ "cost": 3 }` would silently delete the
 * card's rules text along with its cost. A default exists to fill a field an
 * author left out of a whole card; a patch omitting a field is saying that field
 * does not move. Stripping the default is what makes those two mean different
 * things.
 */
const patchableCardShape = Object.fromEntries(
  PATCHABLE_CARD_FIELDS.map((field) => {
    const base: z.ZodType = baseCardSchema.shape[field];
    const stripped = base instanceof z.ZodDefault ? (base.unwrap() as z.ZodType) : base;
    return [field, stripped instanceof z.ZodOptional ? stripped : stripped.optional()];
  }),
) as { [K in PatchableCardField]: z.ZodOptional<z.ZodType<CardDefinition[K]>> };

export const cardPatchBodySchema = z.strictObject(patchableCardShape);
export type CardPatchBody = z.input<typeof cardPatchBodySchema>;

/**
 * Applies a patch to a resolved card and re-validates the result.
 *
 * Re-validating is the point: a patch that sets a Commander's cost or gives a
 * spell a triggered ability must fail here, exactly as it would if an author had
 * written the whole card that way. Returns the parse result rather than throwing
 * so the caller can attach the environment and card the patch came from.
 *
 * A patch can only change fields it names. Removing a field entirely is not a
 * balance edit and is not expressible here — supply the whole definition through
 * `cardOverrides` instead.
 */
export function applyCardPatch(
  card: CardDefinition,
  patch: CardPatchBody,
): ReturnType<typeof cardDefinitionSchema.safeParse> {
  const merged: Record<string, unknown> = { ...card };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    merged[key] = value;
  }
  return cardDefinitionSchema.safeParse(merged);
}

export const cardSetSchema = z.strictObject({
  schemaVersion: z.number().int().min(1).max(CARD_SCHEMA_VERSION),
  setId: z
    .string()
    .min(1)
    .max(40)
    .regex(/^[a-z][a-z0-9_]*$/, 'Set IDs must be lowercase_snake_case.'),
  name: z.string().min(1).max(80),
  cards: z.array(cardDefinitionSchema).min(1),
});

export type CardSet = z.infer<typeof cardSetSchema>;
export type CardSetInput = z.input<typeof cardSetSchema>;
