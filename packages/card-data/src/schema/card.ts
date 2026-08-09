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
