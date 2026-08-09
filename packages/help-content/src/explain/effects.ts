import {
  KEYWORD_REGISTRY,
  type CardDatabase,
  type Duration,
  type EffectDefinition,
  type EffectType,
} from '@tcg/card-data';
import { humanise, numberWord, plural, quantify, sentence } from './grammar.js';
import {
  describePlayerSelector,
  describeSelector,
  describeTarget,
  filterPhrases,
  playerSelectorIsPlural,
  targetIsPlural,
  targetNotes,
  zoneName,
} from './selectors.js';

/**
 * One executable effect, in plain language.
 *
 * The renderer table is a total `Record<EffectType, …>`: adding an effect type
 * to the card schema without adding a renderer here is a compile error. That is
 * the mechanism behind "unsupported mechanics fail validation instead of
 * degrading into a misleading generic sentence".
 *
 * Nothing here reads a card's `displayText`. Explanations are generated from
 * structured data only, in the order the engine resolves it.
 */

export interface EffectExplanation {
  readonly type: EffectType;
  /** The main sentence. */
  readonly text: string;
  /** Qualifications: optionality, who chooses, table-size caveats. */
  readonly notes: readonly string[];
}

export interface ExplainOptions {
  /** Resolves token names for `create_token`. Optional: falls back to the ID. */
  readonly database?: CardDatabase | undefined;
  /** What to call the card the text is printed on. */
  readonly sourceNoun?: string | undefined;
}

function durationClause(duration: Duration): string {
  switch (duration) {
    case 'permanent':
      return 'permanently';
    case 'end_of_turn':
      return 'until the end of the turn';
    case 'while_source_present':
      return 'for as long as the source remains in play';
  }
}

function statChange(attack: number, health: number): string {
  const sign = (value: number): string => (value >= 0 ? `+${value}` : String(value));
  return `${sign(attack)}/${sign(health)}`;
}

type Renderer<T extends EffectType> = (
  effect: Extract<EffectDefinition, { type: T }>,
  options: ExplainOptions,
) => { readonly text: string; readonly notes?: readonly string[] };

type RendererTable = { readonly [T in EffectType]: Renderer<T> };

const RENDERERS: RendererTable = {
  draw: (effect) => ({
    text: `${describePlayerSelector(effect.player)} ${
      playerSelectorIsPlural(effect.player) ? 'draw' : effect.player === 'self' ? 'draw' : 'draws'
    } ${quantify(effect.amount, 'card')}`,
    notes:
      effect.amount > 1
        ? ['cards are drawn one at a time, so an empty deck ends the match mid-draw']
        : [],
  }),

  discard: (effect) => {
    const who = describePlayerSelector(effect.player);
    const self = effect.player === 'self';
    const verb = self || playerSelectorIsPlural(effect.player) ? 'discard' : 'discards';
    const whose = self ? 'your' : 'their';
    const how =
      effect.selection === 'player_choice'
        ? `of ${self ? 'your' : 'their'} choice`
        : effect.selection === 'random'
          ? 'at random'
          : `from the front of ${whose} hand`;
    return {
      text: `${who} ${verb} ${quantify(effect.amount, 'card')} ${how}`,
      notes: ['a player holding fewer cards than that discards their whole hand'],
    };
  },

  deal_damage: (effect, options) => {
    const target = describeTarget(effect.target, options.sourceNoun);
    return {
      text: `deal ${numberWord(effect.amount)} damage to ${target}`,
      notes: targetNotes(effect.target),
    };
  },

  heal: (effect, options) => {
    const target = describeTarget(effect.target, options.sourceNoun);
    const isPlayerTarget = effect.target.kind === 'player' || effect.target.kind === 'players';
    return {
      text: isPlayerTarget
        ? `restore ${numberWord(effect.amount)} health to ${target}`
        : `heal ${target}, removing up to ${numberWord(effect.amount)} marked damage${
            targetIsPlural(effect.target) ? ' from each' : ''
          }`,
      notes: targetNotes(effect.target),
    };
  },

  modify_stats: (effect, options) => ({
    text: `give ${describeTarget(effect.target, options.sourceNoun)} ${statChange(
      effect.attack,
      effect.health,
    )} ${durationClause(effect.duration)}`,
    notes: [
      ...targetNotes(effect.target),
      ...(effect.health < 0
        ? ['losing health can defeat an already-damaged unit in the next state-based check']
        : []),
      ...(effect.duration === 'end_of_turn' && effect.health > 0
        ? ['when the bonus expires, a damaged unit may be defeated immediately']
        : []),
    ],
  }),

  grant_keyword: (effect, options) => ({
    text: `give ${describeTarget(effect.target, options.sourceNoun)} ${
      KEYWORD_REGISTRY[effect.keyword].name
    } ${durationClause(effect.duration)}`,
    notes: [
      ...targetNotes(effect.target),
      ...(KEYWORD_REGISTRY[effect.keyword].implemented
        ? []
        : [`${KEYWORD_REGISTRY[effect.keyword].name} currently has no effect in the rules engine`]),
    ],
  }),

  remove_keyword: (effect, options) => ({
    text: `remove ${KEYWORD_REGISTRY[effect.keyword].name} from ${describeTarget(
      effect.target,
      options.sourceNoun,
    )} ${durationClause(effect.duration)}`,
    notes: targetNotes(effect.target),
  }),

  create_token: (effect, options) => {
    const definition = options.database?.get(effect.tokenCardId);
    const name = definition?.name ?? humanise(effect.tokenCardId);
    const stats =
      definition && definition.attack !== undefined && definition.health !== undefined
        ? ` ${definition.attack}/${definition.health}`
        : '';
    const controller = describePlayerSelector(effect.controller);
    return {
      text:
        effect.controller === 'self'
          ? `create ${quantify(effect.amount, `${stats.trim()} ${name} token`.trim())}`
          : `${controller} creates ${quantify(effect.amount, `${stats.trim()} ${name} token`.trim())}`,
      notes: [
        'a token with no free unit slot is not created at all',
        ...(definition && definition.effects.length > 0
          ? ['the token resolves its own deploy effects as it arrives']
          : []),
      ],
    };
  },

  destroy: (effect, options) => ({
    text: `defeat ${describeTarget(effect.target, options.sourceNoun)}, whatever ${
      targetIsPlural(effect.target) ? 'their' : 'its'
    } remaining health`,
    notes: targetNotes(effect.target),
  }),

  sacrifice: (effect, options) => ({
    text: `sacrifice ${describeTarget(effect.target, options.sourceNoun)}`,
    notes: [
      ...targetNotes(effect.target),
      'a sacrificed unit counts as defeated as well as sacrificed',
    ],
  }),

  return_to_hand: (effect, options) => ({
    text: `return ${describeTarget(effect.target, options.sourceNoun)} to ${
      targetIsPlural(effect.target) ? 'their owners’ hands' : 'its owner’s hand'
    }`,
    notes: targetNotes(effect.target),
  }),

  search_zone: (effect) => {
    const phrases = filterPhrases(effect.filter);
    const noun = phrases.noun ?? 'card';
    const qualifiers = [...phrases.before, noun, ...phrases.after].join(' ');
    const qualifiersPlural = [
      ...phrases.before,
      phrases.nounPlural ?? plural(2, noun),
      ...phrases.after,
    ].join(' ');
    const who = describePlayerSelector(effect.player);
    const mandatory = !effect.upTo && (effect.zone === 'discard' || effect.zone === 'battlefield');
    return {
      text: `${who} ${effect.player === 'self' ? 'search' : 'searches'} ${
        effect.player === 'self' ? 'your' : 'their'
      } ${zoneName(effect.zone)} for ${effect.upTo ? 'up to ' : ''}${quantify(
        effect.amount,
        qualifiers,
        qualifiersPlural,
      )} and ${effect.amount === 1 ? 'puts it' : 'puts them'} into ${
        effect.player === 'self' ? 'your' : 'their'
      } ${zoneName(effect.destination)}`,
      notes: [
        ...(effect.reveal ? ['what is found is revealed to everyone'] : []),
        ...(effect.zone === 'deck' ? ['the deck is shuffled afterwards'] : []),
        mandatory
          ? 'this zone is public, so a legal card must be taken if one exists'
          : 'searching a hidden zone may legally find nothing',
      ],
    };
  },

  reorder_zone: (effect) => ({
    text: `${describePlayerSelector(effect.player)} ${
      effect.player === 'self' ? 'put' : 'puts'
    } the top ${quantify(effect.amount, 'card')} of ${
      effect.player === 'self' ? 'your' : 'their'
    } ${zoneName(effect.zone)} back in any order`,
    notes: ['no cards change zones; only the order changes'],
  }),

  modify_cost: (effect) => {
    const phrases = filterPhrases(effect.filter);
    const noun = phrases.noun ?? 'card';
    const what = effect.filter
      ? [...phrases.before, phrases.nounPlural ?? plural(2, noun), ...phrases.after].join(' ')
      : 'cards';
    const cheaper = effect.delta < 0;
    return {
      text: `${what} cost ${numberWord(Math.abs(effect.delta))} ${
        cheaper ? 'less' : 'more'
      } energy for ${describePlayerSelector(effect.player)} ${durationClause(effect.duration)}`,
      notes: cheaper ? ['a cost can never be reduced below zero'] : [],
    };
  },

  prevent_damage: (effect, options) => ({
    text: `prevent the next ${numberWord(effect.amount)} damage dealt to ${describeTarget(
      effect.target,
      options.sourceNoun,
    )} ${durationClause(effect.duration)}`,
    notes: [...targetNotes(effect.target), 'stacked shields are spent oldest first'],
  }),

  exhaust: (effect, options) => ({
    text: `exhaust ${describeTarget(effect.target, options.sourceNoun)}`,
    notes: targetNotes(effect.target),
  }),

  ready: (effect, options) => ({
    text: `ready ${describeTarget(effect.target, options.sourceNoun)}`,
    notes: [
      ...targetNotes(effect.target),
      'readying does not remove summoning sickness on its own',
    ],
  }),

  move_card: (effect, options) => ({
    text: `move ${describeTarget(effect.target, options.sourceNoun)} to ${
      effect.toZone === 'hand' ? 'its owner’s' : 'the'
    } ${zoneName(effect.toZone)}`,
    notes: targetNotes(effect.target),
  }),
};

/**
 * Explains one effect. Total over the effect union by construction.
 *
 * Deliberately not a `switch` with a default branch: a default is exactly what
 * would let an unhandled effect type render as a plausible-sounding sentence.
 */
export function explainEffect(
  effect: EffectDefinition,
  options: ExplainOptions = {},
): EffectExplanation {
  const render = RENDERERS[effect.type] as Renderer<EffectType>;
  const result = render(effect, options);
  return {
    type: effect.type,
    text: sentence(result.text),
    notes: result.notes ?? [],
  };
}

/** Effect types that currently have a renderer. Used by content validation. */
export const RENDERED_EFFECT_TYPES: readonly EffectType[] = Object.keys(RENDERERS) as EffectType[];

export { describeSelector };
