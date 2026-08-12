import { z } from 'zod';
import { KEYWORD_IDS, keywordIdSchema, type KeywordId } from './schema/primitives.js';
import { mechanicSupport } from './support.js';

/**
 * The one keyword registry.
 *
 * Every keyword name, tooltip, glossary entry, rulebook line and card
 * explanation reads from here. Nothing in the UI may hard-code a keyword name
 * or definition, and there is deliberately no second copy of this text in a
 * React component or a stylesheet.
 *
 * It lives in `card-data` because that package owns `KEYWORD_IDS` and sits
 * below everything else; `rules-engine` imports the `implemented` flag from
 * here rather than keeping its own copy, so the two can never disagree about
 * whether a keyword does anything.
 *
 * ## Definitions describe the engine, not another card game
 *
 * `fullDefinition` states what the rules engine does *today*. Where the engine
 * deliberately does nothing — because the behaviour is an unresolved design
 * decision (docs/open-questions.md Q4) — the definition says so plainly rather
 * than describing a plausible-sounding rule the game does not implement.
 * Telling a player that Guardian forces blocks when it does nothing at all is
 * worse than telling them it is unfinished.
 *
 * ## Configuration references
 *
 * Definition text may embed an allow-listed configuration reference in braces,
 * e.g. `{matchConfig.armoredReduction}`. `@tcg/help-content` resolves those
 * against the shared rules configuration, so a balance change to a provisional
 * number never leaves stale prose behind. Card data cannot depend on the rules
 * engine, which is exactly why the reference is stored unresolved.
 */

export const KEYWORD_REGISTRY_SCHEMA_VERSION = 1;

export const KEYWORD_CATEGORIES = ['combat', 'damage', 'timing', 'lifecycle'] as const;
export const keywordCategorySchema = z.enum(KEYWORD_CATEGORIES);
export type KeywordCategory = z.infer<typeof keywordCategorySchema>;

export const keywordDefinitionSchema = z.strictObject({
  schemaVersion: z.number().int().min(1).max(KEYWORD_REGISTRY_SCHEMA_VERSION),
  id: keywordIdSchema,
  name: z.string().min(1).max(40),
  category: keywordCategorySchema,
  /** One line. Shown on card frames and in tooltips. */
  shortDefinition: z.string().min(1).max(200),
  /** Exactly what the rules engine does today. Shown in the glossary. */
  fullDefinition: z.string().min(1).max(600),
  /**
   * False means the engine gives this keyword no mechanical effect. The keyword
   * is still authored on cards, filterable and rendered — it simply does
   * nothing, and players are told so.
   */
  implemented: z.boolean(),
  /** Rulebook section IDs. Validated to resolve by the content validator. */
  relatedRuleSections: z.array(z.string().min(1)).default([]),
  examples: z.array(z.string().min(1).max(300)).default([]),
});

export type KeywordDefinition = z.infer<typeof keywordDefinitionSchema>;

/**
 * The authored half of each entry: everything except whether the engine does
 * anything with it, which is derived below.
 */
const AUTHORED_KEYWORDS: Readonly<Record<KeywordId, Omit<KeywordDefinition, 'implemented'>>> = {
  rush: {
    schemaVersion: 1,
    id: 'rush',
    name: 'Rush',
    category: 'timing',
    shortDefinition: 'Can attack and use its Exhaust abilities the turn it is deployed.',
    fullDefinition:
      'A Newly Deployed unit normally cannot attack, and cannot pay an "Exhaust this unit" activation cost. Rush lifts both restrictions on the turn it arrives. Rush does not ready an already-exhausted unit.',
    relatedRuleSections: ['playing_cards', 'combat'],
    examples: [
      'Deploy a Rush unit on turn four and attack with it immediately.',
      'A Newly Deployed unit with Rush can pay "Exhaust: create a token" the turn it arrives.',
    ],
  },
  guardian: {
    schemaVersion: 1,
    id: 'guardian',
    name: 'Guardian',
    category: 'combat',
    shortDefinition: 'Attackers cannot be left unblocked while you have a Guardian able to block.',
    fullDefinition:
      'While the defending player controls a ready Guardian that could legally block an attacker, that attacker may not be left unblocked. The defender still chooses which legal Guardian blocks it. Guardian does not let one unit block more than one attacker: with more attackers than ready Guardians, each Guardian covers one attack and the rest may be blocked normally or left unblocked.',
    relatedRuleSections: ['combat'],
    examples: [
      'You attack with two units into one ready Guardian. One attack must be blocked by it; the other may go through.',
    ],
  },
  barrier: {
    schemaVersion: 1,
    id: 'barrier',
    name: 'Barrier',
    category: 'damage',
    shortDefinition: 'Prevents the next damage dealt to this unit, then goes away.',
    fullDefinition:
      'The next damage event that would deal damage to this unit is prevented entirely, and Barrier is then removed. A zero-damage event does not consume it. Multiple instances of Barrier do not stack — a unit either has it or does not.',
    relatedRuleSections: ['damage_and_defeat'],
    examples: [
      'A 2/2 with Barrier blocks a 5/5, takes no damage, and loses Barrier. The next hit kills it.',
    ],
  },
  overwhelm: {
    schemaVersion: 1,
    id: 'overwhelm',
    name: 'Overwhelm',
    category: 'combat',
    shortDefinition: 'Excess combat damage carries through to the defending player.',
    fullDefinition:
      "When this unit is blocked, damage equal to the blocker's current health is assigned to the blocker and the rest is dealt to the defending player. Barrier on the blocker prevents only the damage assigned to the blocker; the overflow still reaches the player.",
    relatedRuleSections: ['combat', 'damage_and_defeat'],
    examples: ['A 7/7 with Overwhelm blocked by a 2/2 deals 2 to the blocker and 5 to the player.'],
  },
  untargetable_by_opponents: {
    schemaVersion: 1,
    id: 'untargetable_by_opponents',
    name: 'Untargetable by opponents',
    category: 'lifecycle',
    shortDefinition: 'Opponents cannot choose this unit as a target.',
    fullDefinition:
      'An opposing player may not choose this unit as the target of a card or ability. It can still be affected by effects that do not target — "every unit", sweepers, combat damage — and its own controller may still target it.',
    relatedRuleSections: ['playing_cards'],
    examples: [
      'A unit made untargetable cannot be picked by enemy removal, but still takes damage from "deal 2 damage to every unit".',
    ],
  },
  evasive: {
    schemaVersion: 1,
    id: 'evasive',
    name: 'Evasive',
    category: 'combat',
    shortDefinition: 'Cannot be blocked.',
    fullDefinition:
      'While this unit is attacking, the defending player may not assign any blocker to it. Its damage always reaches the defending player.',
    relatedRuleSections: ['combat'],
    examples: ['An Evasive 2/2 deals 2 damage to the defending player every turn it attacks.'],
  },
  armored: {
    schemaVersion: 1,
    id: 'armored',
    name: 'Armored',
    category: 'damage',
    shortDefinition:
      'Reduces each instance of damage dealt to it by {matchConfig.armoredReduction}.',
    fullDefinition:
      'Every separate instance of damage dealt to this unit is reduced by {matchConfig.armoredReduction}, to a minimum of zero. The reduction applies per instance, not once per turn, and is applied before any damage-prevention effect on the unit.',
    relatedRuleSections: ['damage_and_defeat'],
    examples: [
      'Two separate 1-damage hits on an Armored unit both reduce to zero; a single 2-damage hit reduces to 1.',
    ],
  },
  siphon: {
    schemaVersion: 1,
    id: 'siphon',
    name: 'Siphon',
    category: 'damage',
    shortDefinition: 'Combat damage this unit deals heals its controller by the same amount.',
    fullDefinition:
      'Whenever this unit deals combat damage — to a player or to a blocking or blocked unit — its controller heals that much health. Only combat damage siphons; damage this unit deals through a card effect does not. Player healing has no maximum, so it can take you above your starting health.',
    relatedRuleSections: ['combat', 'damage_and_defeat'],
    examples: ['A Siphon 3/3 that attacks unblocked deals 3 damage and heals you 3.'],
  },
  venom: {
    schemaVersion: 1,
    id: 'venom',
    name: 'Venom',
    category: 'damage',
    shortDefinition: 'Any damage this unit deals to another unit is lethal to it.',
    fullDefinition:
      'Any non-zero damage this unit deals to another unit defeats that unit in the next state-based check, no matter how much health it has left. This applies to combat damage and to damage dealt by this unit through a card effect. It has no effect on damage dealt to players.',
    relatedRuleSections: ['damage_and_defeat'],
    examples: ['A Venom 1/1 that blocks a 6/6 defeats it, taking 6 damage in return.'],
  },
  quick_strike: {
    schemaVersion: 1,
    id: 'quick_strike',
    name: 'Quick Strike',
    category: 'combat',
    shortDefinition: 'Deals its combat damage before units without Quick Strike.',
    fullDefinition:
      'Combat damage is dealt in two steps. Units with Quick Strike deal their damage in the first step; every other unit deals damage in the second. Defeats are resolved between the steps, so a unit defeated by Quick Strike damage never deals its own combat damage.',
    relatedRuleSections: ['combat'],
    examples: [
      'A Quick Strike 3/2 blocked by a 2/3 defeats the blocker in the first step and takes no damage back.',
    ],
  },
  resilient: {
    schemaVersion: 1,
    id: 'resilient',
    name: 'Resilient',
    category: 'lifecycle',
    shortDefinition: 'No effect yet — this keyword is not implemented.',
    fullDefinition:
      'Resilient currently does nothing. The candidate readings — clearing marked damage at end of turn, or surviving lethal damage once per turn — differ sharply in power and both interact with the rule that damage persists between turns, so the engine deliberately implements neither until the decision is made.',
    relatedRuleSections: ['damage_and_defeat'],
    examples: [],
  },
};

/**
 * The registry as it is read everywhere else, with `implemented` filled in from
 * the mechanic support registry rather than typed out beside each entry (M05.1).
 *
 * There used to be two claims about whether a keyword does anything — this flag
 * and the engine's own note — and they were kept in step by hand. Now there is
 * one: `support.ts` says `engine: 'full'` or `engine: 'none'`, and this is a
 * view of it. A keyword cannot be described to a player as working while the
 * registry the content build gates on says it is inert.
 */
export const KEYWORD_REGISTRY: Readonly<Record<KeywordId, KeywordDefinition>> = Object.freeze(
  Object.fromEntries(
    KEYWORD_IDS.map((id) => [
      id,
      {
        ...AUTHORED_KEYWORDS[id],
        implemented: mechanicSupport({ kind: 'keyword', id }).engine === 'full',
      },
    ]),
  ) as Record<KeywordId, KeywordDefinition>,
);

export const KEYWORD_LIST: readonly KeywordDefinition[] = KEYWORD_IDS.map(
  (id) => KEYWORD_REGISTRY[id],
);

/** Keywords the engine currently acts on. */
export const IMPLEMENTED_KEYWORDS: readonly KeywordId[] = KEYWORD_LIST.filter(
  (keyword) => keyword.implemented,
).map((keyword) => keyword.id);

/** Keywords that exist on cards but do nothing yet. */
export const UNIMPLEMENTED_KEYWORDS: readonly KeywordId[] = KEYWORD_LIST.filter(
  (keyword) => !keyword.implemented,
).map((keyword) => keyword.id);

export function keywordDefinition(id: KeywordId): KeywordDefinition {
  return KEYWORD_REGISTRY[id];
}
