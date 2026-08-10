import {
  KEYWORD_REGISTRY,
  type CardDatabase,
  type Duration,
  type EffectDefinition,
  type EffectType,
  type SignedValueExpression,
  type ValueExpression,
} from '@tcg/card-data';
import { humanise, numberWord, plural, quantify, sentence } from './grammar.js';
import { conditionClause, describeValue, nominalValue, valueIsFixed } from './values.js';
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
    case 'end_of_combat':
      return 'for that combat';
    case 'until_your_next_turn':
      // "Your" is the controller's, and the phrase has to name the *beginning*
      // of that turn: the modifier is gone before the Ready Step, so a player
      // reading it cannot expect one more turn of it.
      return 'until the beginning of your next turn';
    case 'while_source_present':
      return 'for as long as the source remains in play';
  }
}

function statChange(attack: SignedValueExpression, health: SignedValueExpression): string {
  const part = (value: SignedValueExpression, other: SignedValueExpression): string => {
    if (typeof value !== 'number') return `+${describeValue(value)}`;
    void other;
    return value >= 0 ? `+${value}` : String(value);
  };
  return `${part(attack, health)}/${part(health, attack)}`;
}

/** An amount as a phrase: a word for a printed number, a clause for a count. */
function amountPhrase(value: ValueExpression): string {
  return valueIsFixed(value) ? numberWord(nominalValue(value)) : describeValue(value);
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
    } ${valueIsFixed(effect.amount) ? quantify(nominalValue(effect.amount), 'card') : `${describeValue(effect.amount)} cards`}${conditionClause(effect.condition)}`,
    notes:
      !valueIsFixed(effect.amount) || nominalValue(effect.amount) > 1
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
      text: `${who} ${verb} ${valueIsFixed(effect.amount) ? quantify(nominalValue(effect.amount), 'card') : `${describeValue(effect.amount)} cards`} ${how}${conditionClause(effect.condition)}`,
      notes: ['a player holding fewer cards than that discards their whole hand'],
    };
  },

  deal_damage: (effect, options) => {
    const target = describeTarget(effect.target, options.sourceNoun);
    return {
      text: `deal ${amountPhrase(effect.amount)} damage to ${target}${conditionClause(effect.condition)}`,
      notes: targetNotes(effect.target),
    };
  },

  heal: (effect, options) => {
    const target = describeTarget(effect.target, options.sourceNoun);
    const isPlayerTarget = effect.target.kind === 'player' || effect.target.kind === 'players';
    return {
      text: isPlayerTarget
        ? `restore ${amountPhrase(effect.amount)} health to ${target}`
        : `heal ${target}, removing up to ${amountPhrase(effect.amount)} marked damage${
            targetIsPlural(effect.target) ? ' from each' : ''
          }`,
      notes: targetNotes(effect.target),
    };
  },

  modify_stats: (effect, options) => ({
    text: `give ${describeTarget(effect.target, options.sourceNoun)} ${statChange(
      effect.attack,
      effect.health,
    )} ${durationClause(effect.duration)}${conditionClause(effect.condition)}`,
    notes: [
      ...targetNotes(effect.target),
      ...(nominalValue(effect.health) < 0
        ? ['losing health can defeat an already-damaged unit in the next state-based check']
        : []),
      ...(effect.duration === 'end_of_turn' && nominalValue(effect.health) > 0
        ? ['when the bonus expires, a damaged unit may be defeated immediately']
        : []),
      ...(!valueIsFixed(effect.attack) || !valueIsFixed(effect.health)
        ? ['the amount is counted when the effect resolves, not when the card was played']
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
    const noun = `${stats.trim()} ${name} token`.trim();
    const howMany = valueIsFixed(effect.amount)
      ? quantify(nominalValue(effect.amount), noun)
      : `${describeValue(effect.amount)} ${noun}s`;
    return {
      text:
        (effect.controller === 'self' ? `create ${howMany}` : `${controller} creates ${howMany}`) +
        conditionClause(effect.condition),
      notes: [
        'tokens are always created — the battlefield has no size limit',
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
    const whose = effect.player === 'self' ? 'your' : 'their';
    const looksAtTop = effect.fromTop !== undefined;
    // Mirrors `effects.ts#search_zone`: a look-at-the-top effect counts as
    // public, because the cards were shown to the chooser. Wording it as a
    // hidden search would tell the player they may decline a choice the engine
    // will not let them decline.
    const publicToChooser =
      effect.zone === 'discard' || effect.zone === 'battlefield' || looksAtTop;
    const mandatory = !effect.upTo && publicToChooser;
    // "Look at the top three" and "search your whole deck" are the same
    // decision to the engine and completely different to a player, so the
    // sentence changes shape rather than gaining a clause.
    const opening = looksAtTop
      ? `${who} ${effect.player === 'self' ? 'look' : 'looks'} at the top ${numberWord(
          effect.fromTop as number,
        )} ${plural(effect.fromTop as number, 'card')} of ${whose} ${zoneName(effect.zone)} and ${
          effect.upTo ? 'may take ' : effect.player === 'self' ? 'take ' : 'takes '
        }${quantify(effect.amount, qualifiers, qualifiersPlural)}`
      : `${who} ${effect.player === 'self' ? 'search' : 'searches'} ${whose} ${zoneName(
          effect.zone,
        )} for ${effect.upTo ? 'up to ' : ''}${quantify(effect.amount, qualifiers, qualifiersPlural)}`;
    // Taking a card back to the zone it came from is not a move at all: the
    // engine reorders it to the bottom instead. "Putting it into your deck"
    // would describe a card that does nothing.
    const landing =
      effect.destination === effect.zone
        ? `on the bottom of ${whose} ${zoneName(effect.zone)}`
        : `into ${whose} ${zoneName(effect.destination)}`;
    return {
      text: `${opening}, ${effect.amount === 1 ? 'putting it' : 'putting them'} ${landing}`,
      notes: [
        ...(effect.reveal ? ['what is found is revealed to everyone'] : []),
        ...(effect.remainder === 'bottom'
          ? [
              'the cards that were looked at and not taken go to the bottom of the deck, in the order they were in — the deck is not shuffled',
            ]
          : effect.zone === 'deck'
            ? ['the deck is shuffled afterwards']
            : []),
        ...(looksAtTop
          ? ['only those cards are seen; the rest of the deck stays hidden even from you']
          : []),
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
    text: `prevent the next ${amountPhrase(effect.amount)} damage dealt to ${describeTarget(
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

  counter: (effect) => ({
    text:
      effect.unlessPays > 0
        ? `counter the card this answers unless its controller pays ${effect.unlessPays} additional Energy`
        : 'counter the card this answers',
    notes: [
      'a countered card has no effect and goes to its owner’s discard pile',
      'Energy and any additional costs already paid for the countered card are not refunded',
    ],
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
