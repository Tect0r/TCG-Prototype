import { z } from 'zod';
import {
  CARD_SCHEMA_VERSION,
  cardIdSchema,
  cardTypeSchema,
  colorIdentitySchema,
  keywordIdSchema,
  powerClassSchema,
  reactionWindowSchema,
  roleSchema,
  setStatusSchema,
  tagSchema,
} from './primitives.js';
import {
  abilityDefinitionSchema,
  activatedAbilityDefinitionSchema,
  additionalCostSchema,
  delayedAbilityDefinitionSchema,
  effectDefinitionSchema,
  staticAbilityDefinitionSchema,
  type EffectDefinition,
} from './effect.js';
import { cardFilterSchema, entitySelectorOf, type TargetSelector } from './target.js';
import {
  isPreviousTargetsValue,
  isStatValue,
  type SignedValueExpression,
  type ValueExpression,
} from './condition.js';

/**
 * When a Reaction may be played, as structured data.
 *
 * A list rather than a single window because several authored Reactions are
 * plain instants — "Return a Unit you control to your hand. Draw a card." names
 * no moment at all — and the honest encoding of that is "every window", not a
 * magic `any` value the engine would have to special-case.
 *
 * `subjectFilter` restricts what the Reaction may answer: it is matched against
 * the card the window is *about*, which today means the Spell that a
 * `when_opponent_plays_spell` window opened for. "Play when an opponent plays a
 * Spell costing 2 or less" is `{ cost: { max: 2 } }` and nothing else — the
 * restriction is timing, not a target, so it lives here rather than on the
 * counter instruction.
 */
export const reactionTimingSchema = z.strictObject({
  windows: z.array(reactionWindowSchema).min(1),
  subjectFilter: cardFilterSchema.optional(),
});
export type ReactionTiming = z.infer<typeof reactionTimingSchema>;

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

/**
 * Design metadata: what the card is *for*, as its designer described it.
 *
 * Never executed and never consulted by the rules engine. It exists so the
 * authored catalog's own vocabulary survives import (ruleset update §2), and so
 * deck generation, archetype grouping and simulator provenance have something
 * better than free-form tags to group on.
 *
 * Kept separate from `tags` on purpose: `tags` are **mechanical** — `CardFilter`
 * matches on them, so "Goblins you control" is a tag — while everything here is
 * pilot-and-analysis input only. Putting a faction name in `tags` would make it
 * targetable by a card filter, which is exactly wrong for a design label.
 */
export const cardDesignSchema = z.strictObject({
  /** Faction/archetype family, e.g. `goblin`, `control`. Design label, not a subtype. */
  faction: tagSchema.optional(),
  /** The designer's one-line statement of role, e.g. "Swarm Unit — Multiplier". */
  identity: z.string().min(1).max(120).optional(),
  /** Expected playtest strength. Not rarity, and not a progression tier. */
  power: z.enum(['low', 'medium', 'high']).optional(),
});
export type CardDesign = z.infer<typeof cardDesignSchema>;

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
  /** Design labels. Presentation and analysis only; never a game rule. */
  design: cardDesignSchema.optional(),
  /**
   * Effects resolved when the card is played: spell resolution, and unit/relic
   * deploy resolution. The single authoring form for deploy behaviour — there is
   * no `on_deploy` trigger (CLAUDE.md §17 Q1).
   */
  effects: z.array(effectDefinitionSchema).default([]),
  /**
   * "As an additional cost to play this, …" — paid when the card is played,
   * before it is queued, and never refunded (CLAUDE.md §4).
   *
   * Separate from `effects` because the timing is the mechanic: an additional
   * cost is spent before an opponent's Reaction window can answer the card, so
   * countering it still costs its controller the sacrifice. A first instruction
   * would resolve after that window closed and refund the whole thing.
   */
  additionalCosts: z.array(additionalCostSchema).max(4).default([]),
  /** Effects resolved when a non-deploy trigger fires while the card is in play. */
  abilities: z.array(abilityDefinitionSchema).default([]),
  /** Abilities the controller chooses to use, paying their costs first. */
  activatedAbilities: z.array(activatedAbilityDefinitionSchema).default([]),
  /** Continuous effects, recomputed from state rather than applied once. */
  staticAbilities: z.array(staticAbilityDefinitionSchema).default([]),
  /**
   * Delayed effects this card can set up, referenced by ID from a
   * `schedule_delayed` instruction (M02.1).
   *
   * Inert on their own: an entry nothing schedules never happens, which is why
   * an unreferenced one is rejected below rather than left as dead data.
   */
  delayedAbilities: z.array(delayedAbilityDefinitionSchema).max(4).default([]),
  /** Required on a `reaction`, and meaningless on anything else. */
  reaction: reactionTimingSchema.optional(),
  /**
   * Whether this card's printed behaviour is fully expressed in structured data.
   *
   * Ruleset update §1 forbids silently weakening or approximating a card whose
   * mechanic the schema cannot yet express — the only honest alternatives are to
   * extend the schema or to *report* the card as unsupported. This flag is that
   * report. An unsupported card still has real identity, stats and cost, so the
   * catalog stays complete and reviewable, but it is excluded from playable
   * formats and rejected outright in a `playtest`/`active` set.
   */
  implemented: z.boolean().default(true),
  /** Required when `implemented` is false: exactly which primitive is missing. */
  unsupportedReason: z.string().min(1).max(300).optional(),
  /** Presentation only. Never executed, never parsed for behaviour. */
  displayText: z.string().max(400).optional(),
  /** Optional curated help. Supplements generated explanations; never behaviour. */
  text: cardTextSchema.optional(),
});

/** Card types that carry a combat statline. */
const STATTED_TYPES = new Set(['unit', 'commander', 'token']);

/** Card types the ordinary play-from-hand path handles, additional costs and all. */
const PLAYED_FROM_HAND = new Set(['unit', 'spell', 'relic']);

/**
 * Every effect list on a card, with the path each one lives at.
 *
 * "If you do" is a fact about an instruction's position in *its own* list, and a
 * card has four of them. Walking them together is what keeps the check honest
 * when an author writes the clause inside an activated ability rather than in
 * the card's top-level text.
 */
function effectLists(
  card: Pick<CardDefinition, 'effects' | 'abilities' | 'activatedAbilities' | 'delayedAbilities'>,
): { path: (string | number)[]; effects: readonly EffectDefinition[] }[] {
  return [
    { path: ['effects'], effects: card.effects },
    ...card.abilities.map((ability, index) => ({
      path: ['abilities', index, 'effects'],
      effects: ability.effects,
    })),
    ...card.activatedAbilities.map((ability, index) => ({
      path: ['activatedAbilities', index, 'effects'],
      effects: ability.effects,
    })),
    // A delayed body is an ordinary instruction list that happens to resolve
    // later, so "if you do" and the `while_source_present` rule below mean
    // exactly what they mean anywhere else and are checked the same way.
    ...card.delayedAbilities.map((ability, index) => ({
      path: ['delayedAbilities', index, 'effects'],
      effects: ability.effects,
    })),
  ];
}

/**
 * Every `ValueExpression` field an instruction carries, with its field name.
 *
 * Hand-maintained rather than derived, because the schema mixes two kinds of
 * "amount": `ValueExpression` fields the board can decide, and the plain
 * `z.number()` fields on `search_zone`, `reorder_zone`, `modify_cost` and
 * `counter`, which are printed constants. Only the first kind can carry a
 * derived value, so only the first kind is listed here. A new value-bearing
 * instruction has to be added, or its derived values go unchecked.
 */
function valueFieldsOf(
  effect: EffectDefinition,
): { field: string; value: ValueExpression | SignedValueExpression }[] {
  switch (effect.type) {
    case 'draw':
    case 'discard':
    case 'create_token':
    case 'deal_damage':
    case 'heal':
    case 'prevent_damage':
      return [{ field: 'amount', value: effect.amount }];
    case 'modify_stats':
      return [
        { field: 'attack', value: effect.attack },
        { field: 'health', value: effect.health },
      ];
    default:
      return [];
  }
}

/**
 * The zone query an instruction points at, when it has one.
 *
 * `source`, `trigger_subject`, `blocked_by_source`, `previous_target` and the
 * two player kinds all name a set nobody picks from, so there is no selector to
 * validate — which is exactly why the checks below skip them rather than
 * guessing at a shape. `entity_or_player` does carry one, and it is the same
 * shape meaning the same thing, so it is validated by every rule below.
 */
function selectorOf(effect: EffectDefinition): TargetSelector | null {
  if (!('target' in effect)) return null;
  return entitySelectorOf(effect.target);
}

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

  // Tokens are created by effects and are never paid for.
  //
  // A Commander's cost is nullable, and the two cases mean different things.
  // A printed cost makes it *deployable*: playing it moves the Commander from
  // the Commander zone onto the battlefield (ruleset update §10, ADR 0016).
  // `null` is the older model — a Commander that stays in its zone and can
  // never be deployed. Keeping both is what lets the `prototype_core` fixtures
  // go on meaning exactly what they meant, without inventing costs for them.
  if (card.type === 'token') {
    if (card.cost !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['cost'],
        message: 'A token is created by an effect and must have cost null.',
      });
    }
  } else if (card.cost === null && card.type !== 'commander') {
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

  // An unsupported card is allowed to be behaviourally empty — that is the
  // point of the flag — but it must say precisely what is missing, so the gap is
  // an inventory item rather than a mystery.
  if (!card.implemented && card.unsupportedReason === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['unsupportedReason'],
      message:
        'A card marked `implemented: false` must state which mechanic or primitive it is waiting on.',
    });
  }
  if (card.implemented && card.unsupportedReason !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['unsupportedReason'],
      message: 'Remove `unsupportedReason` once the card is implemented.',
    });
  }

  if (
    card.implemented &&
    (card.type === 'spell' || card.type === 'reaction') &&
    card.effects.length === 0
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['effects'],
      message: `An implemented ${card.type} must define at least one effect.`,
    });
  }

  // A Reaction with no timing is a card the engine could never legally offer:
  // every window it may be played in is data, never inferred from "Play when …"
  // in the rules text (rule adjustment §5).
  if (card.type === 'reaction' && card.implemented && card.reaction === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['reaction'],
      message: 'A Reaction must declare the timing window(s) it may be played in.',
    });
  }
  if (card.type !== 'reaction' && card.reaction !== undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['reaction'],
      message: `A ${card.type} is not played inside a Reaction window; remove \`reaction\`.`,
    });
  }

  // Countering is a Reaction's privilege. The only counterable card is the one
  // whose window the Reaction was played in, and no other card type is ever
  // played inside a window — so a `counter` anywhere else could never resolve.
  if (card.type !== 'reaction') {
    card.effects.forEach((effect, index) => {
      if (effect.type !== 'counter') return;
      ctx.addIssue({
        code: 'custom',
        path: ['effects', index, 'type'],
        message: 'Only a Reaction can counter; nothing else is played inside a Reaction window.',
      });
    });
  }

  // Reactions resolve and leave play exactly as spells do.
  if (card.type === 'reaction' && card.abilities.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['abilities'],
      message: 'Reactions resolve and leave play; use `effects` instead of triggered abilities.',
    });
  }
  if (card.type === 'reaction' && card.staticAbilities.length > 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['staticAbilities'],
      message: 'Reactions resolve and leave play; they cannot carry a continuous effect.',
    });
  }

  // `while_source_present` needs a source that persists. A spell or reaction
  // moves to its owner's discard the moment it finishes resolving, so a
  // modifier bound to it would expire in the same breath it was applied — the
  // card would read as a lasting buff and behave as nothing at all.
  //
  // Rejected rather than silently reinterpreted as `permanent`: guessing which
  // one the author meant is exactly the "silently approximate a card" failure
  // ruleset update §1 forbids. Units, tokens, relics and Commanders can all
  // sustain it; a triggered or activated ability on any of them can too, since
  // the card is still in play.
  if (card.type === 'spell' || card.type === 'reaction') {
    // A delayed body resolves later still, so a source-bound modifier written
    // there is even more obviously dead than one written in the spell itself.
    const sourceBoundLists = [
      { path: ['effects'] as (string | number)[], effects: card.effects },
      ...card.delayedAbilities.map((ability, index) => ({
        path: ['delayedAbilities', index, 'effects'] as (string | number)[],
        effects: ability.effects,
      })),
    ];
    for (const list of sourceBoundLists) {
      list.effects.forEach((effect, index) => {
        if (!('duration' in effect) || effect.duration !== 'while_source_present') return;
        ctx.addIssue({
          code: 'custom',
          path: [...list.path, index, 'duration'],
          message: `A ${card.type} leaves play as it resolves, so it cannot sustain a \`while_source_present\` modifier. Use \`end_of_turn\` or \`permanent\`.`,
        });
      });
    }
  }

  // "If you do" needs a preceding instruction to be about. At index 0 there is
  // none, so the gate could never be satisfied and the instruction would be
  // dead text — the silent approximation ruleset update §1 forbids. Rejected
  // rather than reinterpreted, because the author meant one of two different
  // cards and the schema may not pick.
  for (const list of effectLists(card)) {
    list.effects.forEach((effect, index) => {
      if (effect.condition?.kind !== 'previous_step' || index > 0) return;
      ctx.addIssue({
        code: 'custom',
        path: [...list.path, index, 'condition'],
        message:
          'An "if you do" condition refers to the instruction before it; the first instruction has none.',
      });
    });
  }

  // "… to the battlefield Exhausted" describes an arrival on the battlefield.
  // Anywhere else there is nothing to exhaust — a card in a hand, a deck, a
  // discard pile or out of the game has no readiness at all — so the flag would
  // be a printed detail the engine drops (M02.2).
  for (const list of effectLists(card)) {
    list.effects.forEach((effect, index) => {
      if (effect.type !== 'move_card') return;
      if (!effect.entersExhausted || effect.toZone === 'battlefield') return;
      ctx.addIssue({
        code: 'custom',
        path: [...list.path, index, 'entersExhausted'],
        message:
          'Only a card arriving on the battlefield can arrive Exhausted; nothing in another zone is Ready or Exhausted.',
      });
    });
  }

  // "Gains Health equal to **its** ATK" reads the statline of the card the
  // instruction is acting on, so there has to be one, and it has to be a card.
  // An instruction with no target at all, or one aimed at a player, would leave
  // "it" pointing at nothing and the value would quietly resolve to zero — a
  // card that reads as a scaling effect and behaves as none (M02.3).
  for (const list of effectLists(card)) {
    list.effects.forEach((effect, index) => {
      for (const { field, value } of valueFieldsOf(effect)) {
        if (!isStatValue(value) || value.of !== 'effect_target') continue;
        const path = [...list.path, index, field, 'of'];
        if (!('target' in effect)) {
          ctx.addIssue({
            code: 'custom',
            path,
            message: `A \`${effect.type}\` instruction has no target, so a value read from "effect_target" refers to nothing. Use "source" or "trigger_subject".`,
          });
          continue;
        }
        if (effect.target.kind === 'player' || effect.target.kind === 'players') {
          ctx.addIssue({
            code: 'custom',
            path,
            message:
              'A player has no ATK or Health of its own, so a value read from "effect_target" cannot be resolved. Player health is not a statline.',
          });
        }
      }
    });
  }

  // "For each Unit sacrificed" counts what the instruction before this one
  // resolved with, exactly as an "if you do" condition and a `previous_target`
  // subject do — and at index 0 there is none, so the amount would silently be
  // zero and the instruction would be dead text (M02.5).
  for (const list of effectLists(card)) {
    list.effects.forEach((effect, index) => {
      if (index > 0) return;
      for (const { field, value } of valueFieldsOf(effect)) {
        if (!isPreviousTargetsValue(value)) continue;
        ctx.addIssue({
          code: 'custom',
          path: [...list.path, index, field, 'kind'],
          message:
            'A "previous_targets" amount counts what the instruction before it acted on; the first instruction has none.',
        });
      }
    });
  }

  // "An enemy Unit **or** an opponent" is one pool spanning two namespaces, and
  // only an allocation knows how to draw from it: a divided total already
  // decides which members of its pool it touches, so adding players costs
  // nothing there. A single-target choice spanning both is a different
  // interaction that nothing prints and nothing tests, and shipping it untested
  // is what this rejection prevents (M07.8).
  for (const list of effectLists(card)) {
    list.effects.forEach((effect, index) => {
      if (!('target' in effect) || effect.target.kind !== 'entity_or_player') return;
      if (effect.type === 'deal_damage' && effect.divided === true) return;
      ctx.addIssue({
        code: 'custom',
        path: [...list.path, index, 'target', 'kind'],
        message:
          'A pool of entities and players is only allocatable by a divided total; use "entity_or_player" on a `deal_damage` with `divided: true`, or point at one or the other.',
      });
    });
  }

  // Divided damage splits a total across targets the *allocation* names, so the
  // selector underneath it has to be the unrestricted pool that allocation
  // picks from. A fixed `count`, or a selection nobody makes, describes a
  // pre-selection the division never performs — a printed clause the engine
  // would have to quietly reinterpret (M02.5).
  for (const list of effectLists(card)) {
    list.effects.forEach((effect, index) => {
      if (effect.type !== 'deal_damage' || effect.divided !== true) return;
      const path = [...list.path, index, 'divided'];
      const selector = selectorOf(effect);
      if (selector === null) {
        ctx.addIssue({
          code: 'custom',
          path,
          message:
            'Divided damage needs a set of entity targets to divide between; a player or a fixed subject takes the whole amount.',
        });
        return;
      }
      if (selector.selection !== 'player_choice') {
        ctx.addIssue({
          code: 'custom',
          path,
          message: 'Divided damage is allocated by a player; set `selection` to "player_choice".',
        });
      }
      if (selector.count !== 'all') {
        ctx.addIssue({
          code: 'custom',
          path,
          message:
            'The allocation decides which targets are hit, so the selector is the pool it draws from; set `count` to "all".',
        });
      }
      // One player splits one total. "Each player divides N damage" is a
      // different card that nothing prints, and composing the two primitives
      // untested is exactly the untested rule ruleset update §18 rules out.
      if (selector.chooser === 'each_opponent' || selector.chooser === 'all_players') {
        ctx.addIssue({
          code: 'custom',
          path,
          message: 'A divided total is allocated by one player; `chooser` cannot name several.',
        });
      }
      // The total is read once, before anything is targeted, so there is no
      // "it" for a statline to be read off. Left alone it would resolve to a
      // silent zero and the card would deal no damage at all.
      if (isStatValue(effect.amount) && effect.amount.of === 'effect_target') {
        ctx.addIssue({
          code: 'custom',
          path: [...list.path, index, 'amount', 'of'],
          message:
            'A divided total is read before any target is chosen, so it cannot come from "effect_target". Use "source" or "trigger_subject".',
        });
      }
    });
  }

  // A plural chooser is only ever read when somebody is being asked. Setting one
  // beside a `random` or `automatic` selection prints "each player chooses" on a
  // card where nobody chooses anything (M02.5).
  for (const list of effectLists(card)) {
    list.effects.forEach((effect, index) => {
      const selector = selectorOf(effect);
      if (selector === null) return;
      if (selector.chooser !== 'each_opponent' && selector.chooser !== 'all_players') return;
      if (selector.selection === 'player_choice') return;
      ctx.addIssue({
        code: 'custom',
        path: [...list.path, index, 'target', 'selector', 'chooser'],
        message: `A "${selector.chooser}" chooser only means anything when \`selection\` is "player_choice"; nobody is asked for a ${selector.selection} selection.`,
      });
    });
  }

  // Only the cards the ordinary play-from-hand path handles may print one.
  // A token is created by an effect and a Commander is deployed through its own
  // path, so neither has a moment at which a cost list would be read; a
  // Reaction is played inside a window, where pausing to pick a sacrifice would
  // interleave a second choice with priority passing. Rejected rather than
  // ignored — a printed cost the engine skips is a card that lies.
  if (card.additionalCosts.length > 0 && !PLAYED_FROM_HAND.has(card.type)) {
    ctx.addIssue({
      code: 'custom',
      path: ['additionalCosts'],
      message: `A ${card.type} is not played through the ordinary play-from-hand path, so it cannot carry an additional cost.`,
    });
  }

  // A delayed effect is only ever set up by a `schedule_delayed` naming it, so
  // the two sides have to agree. A dangling reference would be an instruction
  // that silently does nothing; an unreferenced entry would be a delayed clause
  // printed on a card that can never happen. Both are the "silently approximate
  // a card" failure ruleset update §1 forbids, so both are rejected.
  const delayedIds = new Set<string>();
  card.delayedAbilities.forEach((ability, index) => {
    if (delayedIds.has(ability.id)) {
      ctx.addIssue({
        code: 'custom',
        path: ['delayedAbilities', index, 'id'],
        message: `Delayed ability IDs must be unique within a card; "${ability.id}" is used twice.`,
      });
    }
    delayedIds.add(ability.id);

    // A watch has to have something to watch. The trigger names an event about
    // a card, and without a bound subject there is no card for it to be about.
    if (ability.trigger !== undefined && ability.subject === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['delayedAbilities', index, 'subject'],
        message:
          'A delayed ability that waits for a trigger must name the subject the event has to be about.',
      });
    }

    ability.effects.forEach((effect, effectIndex) => {
      // One level, always. Nesting would turn a bounded piece of bookkeeping
      // into a chain whose length is a property of the card data.
      if (effect.type === 'schedule_delayed') {
        ctx.addIssue({
          code: 'custom',
          path: ['delayedAbilities', index, 'effects', effectIndex, 'type'],
          message: 'A delayed ability cannot schedule another delayed ability.',
        });
      }
      if (effect.type === 'counter') {
        ctx.addIssue({
          code: 'custom',
          path: ['delayedAbilities', index, 'effects', effectIndex, 'type'],
          message: 'Countering happens inside a Reaction window, which no delayed effect is in.',
        });
      }
    });
  });

  const scheduled = new Set<string>();
  for (const list of effectLists(card)) {
    list.effects.forEach((effect, index) => {
      if (effect.type !== 'schedule_delayed') return;
      scheduled.add(effect.delayedAbilityId);

      const ability = card.delayedAbilities.find((entry) => entry.id === effect.delayedAbilityId);
      if (!ability) {
        ctx.addIssue({
          code: 'custom',
          path: [...list.path, index, 'delayedAbilityId'],
          message: `No \`delayedAbilities\` entry with id "${effect.delayedAbilityId}" on this card.`,
        });
        return;
      }

      // `previous_target` reads the instruction before this one, exactly as an
      // "if you do" condition does — and at index 0 there is none, so the
      // delayed effect could never find a subject and would never be scheduled.
      if (ability.subject === 'previous_target' && index === 0) {
        ctx.addIssue({
          code: 'custom',
          path: [...list.path, index, 'delayedAbilityId'],
          message: `"${ability.id}" points at the target of the instruction before it; the first instruction has none.`,
        });
      }
    });
  }

  card.delayedAbilities.forEach((ability, index) => {
    if (scheduled.has(ability.id)) return;
    ctx.addIssue({
      code: 'custom',
      path: ['delayedAbilities', index, 'id'],
      message: `Nothing on this card schedules "${ability.id}"; add a \`schedule_delayed\` instruction or remove it.`,
    });
  });

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
  'design',
  'effects',
  'additionalCosts',
  'abilities',
  'activatedAbilities',
  'staticAbilities',
  'delayedAbilities',
  'reaction',
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

export const setIdSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, 'Set IDs must be lowercase_snake_case.');

export const cardSetSchema = z.strictObject({
  schemaVersion: z.number().int().min(1).max(CARD_SCHEMA_VERSION),
  setId: setIdSchema,
  name: z.string().min(1).max(80),
  /** Decides how strictly the set's cards are validated. See `SET_STATUSES`. */
  status: setStatusSchema.default('development'),
  description: z.string().min(1).max(400).optional(),
  cards: z.array(cardDefinitionSchema).min(1),
});

export type CardSet = z.infer<typeof cardSetSchema>;
export type CardSetInput = z.input<typeof cardSetSchema>;
