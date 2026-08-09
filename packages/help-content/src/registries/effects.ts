import { EFFECT_TYPES, type EffectType } from '@tcg/card-data';

/**
 * Documentation metadata for each executable effect type.
 *
 * This registry is **not** a scripting layer and it is never consulted to
 * decide what an effect does. The rules engine remains the only authority on
 * behaviour; this describes each effect type for players and for authors.
 *
 * It is typed as a total `Record<EffectType, …>`, so adding an effect type to
 * the card schema without documenting it here is a type error, not a card that
 * silently renders as "does something".
 */

export const EFFECT_CATEGORIES = [
  'cards',
  'damage',
  'stats',
  'board',
  'resources',
  'zones',
] as const;
export type EffectCategory = (typeof EFFECT_CATEGORIES)[number];

export interface EffectTypeInfo {
  readonly type: EffectType;
  /** Short label, e.g. for grouping in an index. */
  readonly label: string;
  /** One sentence describing the effect family, independent of any one card. */
  readonly description: string;
  readonly category: EffectCategory;
  /** Fields an author fills in. Documentation only. */
  readonly parameters: readonly string[];
  /**
   * When this effect can pause resolution for a player choice, described in
   * terms of the effect's own fields. `null` means it never pauses.
   */
  readonly pausesForChoiceWhen: string | null;
}

export const EFFECT_REGISTRY: Readonly<Record<EffectType, EffectTypeInfo>> = Object.freeze({
  draw: {
    type: 'draw',
    label: 'Draw',
    description: 'A player draws cards from the top of their deck, one at a time.',
    category: 'cards',
    parameters: ['player', 'amount'],
    pausesForChoiceWhen: 'player is "opponent" and more than one opponent is alive',
  },
  discard: {
    type: 'discard',
    label: 'Discard',
    description: 'A player puts cards from their hand into their discard pile.',
    category: 'cards',
    parameters: ['player', 'amount', 'selection'],
    pausesForChoiceWhen: 'selection is "player_choice" and the discarding hand is not empty',
  },
  deal_damage: {
    type: 'deal_damage',
    label: 'Deal damage',
    description: 'Marks damage on units or subtracts health from players.',
    category: 'damage',
    parameters: ['target', 'amount'],
    pausesForChoiceWhen: 'the target is chosen by a player',
  },
  heal: {
    type: 'heal',
    label: 'Heal',
    description: 'Removes marked damage from units, or restores health to players.',
    category: 'damage',
    parameters: ['target', 'amount'],
    pausesForChoiceWhen: 'the target is chosen by a player',
  },
  modify_stats: {
    type: 'modify_stats',
    label: 'Modify stats',
    description: "Changes a unit's attack and health, permanently or until end of turn.",
    category: 'stats',
    parameters: ['target', 'attack', 'health', 'duration'],
    pausesForChoiceWhen: 'the target is chosen by a player',
  },
  grant_keyword: {
    type: 'grant_keyword',
    label: 'Grant keyword',
    description: 'Gives a unit a keyword it does not have printed on it.',
    category: 'stats',
    parameters: ['target', 'keyword', 'duration'],
    pausesForChoiceWhen: 'the target is chosen by a player',
  },
  remove_keyword: {
    type: 'remove_keyword',
    label: 'Remove keyword',
    description: 'Takes a keyword away from a unit.',
    category: 'stats',
    parameters: ['target', 'keyword', 'duration'],
    pausesForChoiceWhen: 'the target is chosen by a player',
  },
  create_token: {
    type: 'create_token',
    label: 'Create token',
    description:
      'Puts newly created units onto the battlefield. Tokens need a free unit slot and are not created at all when the battlefield is full.',
    category: 'board',
    parameters: ['tokenCardId', 'amount', 'controller'],
    pausesForChoiceWhen: 'controller is "opponent" and more than one opponent is alive',
  },
  destroy: {
    type: 'destroy',
    label: 'Destroy',
    description: 'Defeats a unit outright, regardless of its remaining health.',
    category: 'board',
    parameters: ['target'],
    pausesForChoiceWhen: 'the target is chosen by a player',
  },
  sacrifice: {
    type: 'sacrifice',
    label: 'Sacrifice',
    description:
      'Defeats a unit its controller chooses to give up. A sacrificed unit counts as defeated as well as sacrificed.',
    category: 'board',
    parameters: ['target'],
    pausesForChoiceWhen: 'the target is chosen by a player',
  },
  return_to_hand: {
    type: 'return_to_hand',
    label: 'Return to hand',
    description: "Moves a card back to its owner's hand, leaving play.",
    category: 'zones',
    parameters: ['target'],
    pausesForChoiceWhen: 'the target is chosen by a player',
  },
  search_zone: {
    type: 'search_zone',
    label: 'Search',
    description:
      'Looks through a zone for cards matching a filter and moves what is found somewhere else. Searching your deck shuffles it afterwards.',
    category: 'zones',
    parameters: ['player', 'zone', 'filter', 'amount', 'destination', 'reveal', 'upTo'],
    pausesForChoiceWhen: 'the zone contains at least one matching card',
  },
  reorder_zone: {
    type: 'reorder_zone',
    label: 'Reorder',
    description: 'Puts the top cards of a zone into an order of the player’s choosing.',
    category: 'zones',
    parameters: ['player', 'zone', 'amount'],
    pausesForChoiceWhen: 'at least two cards are in the window being reordered',
  },
  modify_cost: {
    type: 'modify_cost',
    label: 'Modify cost',
    description: 'Makes matching cards cheaper or more expensive for a player to play.',
    category: 'resources',
    parameters: ['player', 'filter', 'delta', 'duration'],
    pausesForChoiceWhen: 'player is "opponent" and more than one opponent is alive',
  },
  prevent_damage: {
    type: 'prevent_damage',
    label: 'Prevent damage',
    description:
      'Places a shield that absorbs a fixed amount of incoming damage. Shields are spent oldest first.',
    category: 'damage',
    parameters: ['target', 'amount', 'duration'],
    pausesForChoiceWhen: 'the target is chosen by a player',
  },
  exhaust: {
    type: 'exhaust',
    label: 'Exhaust',
    description: 'Turns a unit sideways so it cannot attack until it readies.',
    category: 'board',
    parameters: ['target'],
    pausesForChoiceWhen: 'the target is chosen by a player',
  },
  ready: {
    type: 'ready',
    label: 'Ready',
    description: 'Readies an exhausted unit so it can attack again.',
    category: 'board',
    parameters: ['target'],
    pausesForChoiceWhen: 'the target is chosen by a player',
  },
  move_card: {
    type: 'move_card',
    label: 'Move card',
    description: 'Moves a card from wherever it is into a named zone.',
    category: 'zones',
    parameters: ['target', 'toZone'],
    pausesForChoiceWhen: 'the target is chosen by a player',
  },
});

export const EFFECT_LIST: readonly EffectTypeInfo[] = EFFECT_TYPES.map(
  (type) => EFFECT_REGISTRY[type],
);
