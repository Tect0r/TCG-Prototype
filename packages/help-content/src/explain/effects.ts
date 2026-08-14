import {
  isPreviousTargetsValue,
  KEYWORD_REGISTRY,
  type CardDatabase,
  type DelayedAbilityDefinition,
  type DelayedBoundary,
  type Duration,
  type EffectDefinition,
  type EffectType,
  type SignedValueExpression,
  type ValueExpression,
} from '@tcg/card-data';
import { TRIGGER_REGISTRY } from '../registries/triggers.js';
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
  /**
   * The card's own `delayedAbilities`, so a `schedule_delayed` instruction can
   * be spelled out rather than described as "sets something up".
   *
   * Supplied by the caller because a `schedule_delayed` names its body by ID —
   * the deliberate price of keeping the instruction union flat. Without it the
   * renderer says only what it can honestly say.
   */
  readonly delayedAbilities?: readonly DelayedAbilityDefinition[] | undefined;
  /**
   * What to call a `trigger_subject` target.
   *
   * Defaulted by `describeTarget` to "the card that triggered this", which is
   * right for a triggered ability and wrong inside a delayed clause, where the
   * subject was bound when the clause was set up and the trigger may never fire
   * at all.
   */
  readonly subjectNoun?: string | undefined;
}

/** A target as a noun phrase, with both of this card's nouns filled in. */
function targetPhrase(
  target: Parameters<typeof describeTarget>[0],
  options: ExplainOptions,
): string {
  return describeTarget(target, options.sourceNoun, options.subjectNoun);
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
    if (typeof value !== 'number') {
      // A derived amount carries its own sign, and `describeValue` words the
      // magnitude only — so "-1/-0 for each …" has to read as a minus here or
      // the card would be described as a buff.
      return `${value.sign === -1 ? '-' : '+'}${describeValue(value)}`;
    }
    void other;
    return value >= 0 ? `+${value}` : String(value);
  };
  return `${part(attack, health)}/${part(health, attack)}`;
}

/** An amount as a phrase: a word for a printed number, a clause for a count. */
function amountPhrase(value: ValueExpression): string {
  return valueIsFixed(value) ? numberWord(nominalValue(value)) : describeValue(value);
}

/**
 * Notes an amount needs on top of the sentence it appears in.
 *
 * Only `previous_targets` has one: it words as "that many", which is exactly
 * what the card says and is a dangling reference on its own, so the step that
 * uses it spells out what "that" was.
 */
function amountNotes(value: ValueExpression): string[] {
  return isPreviousTargetsValue(value)
    ? ['“that many” is however many cards the step before this one acted on']
    : [];
}

/** "…at the end of the turn" — when a delayed effect with no watch happens. */
function delayedBoundaryClause(boundary: DelayedBoundary): string {
  switch (boundary) {
    case 'end_of_turn':
      return 'at the end of the turn';
  }
}

/** "…this turn" — how long a delayed watch stays open. */
function delayedWindowClause(boundary: DelayedBoundary): string {
  switch (boundary) {
    case 'end_of_turn':
      return ' this turn';
  }
}

/**
 * What to call the card a delayed clause is about.
 *
 * "It" for a subject chosen by the instruction before, because that is exactly
 * the word the printed card uses and the player has just picked it. The source
 * gets its own noun so "this unit" does not turn into an unresolvable "it" on a
 * card that names two things.
 */
function delayedSubjectNoun(
  ability: DelayedAbilityDefinition,
  sourceNoun: string | undefined,
): string {
  switch (ability.subject) {
    case 'source':
      return sourceNoun ?? 'this card';
    case 'previous_target':
      return 'it';
    case undefined:
      return sourceNoun ?? 'this card';
  }
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
    } ${valueIsFixed(effect.amount) ? quantify(nominalValue(effect.amount), 'card') : `${describeValue(effect.amount)} cards`}`,
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
      text: `${who} ${verb} ${valueIsFixed(effect.amount) ? quantify(nominalValue(effect.amount), 'card') : `${describeValue(effect.amount)} cards`} ${how}`,
      notes: ['a player holding fewer cards than that discards their whole hand'],
    };
  },

  deal_damage: (effect, options) => {
    const target = targetPhrase(effect.target, options);
    // A divided total is one number split across a set, so it is worded as a
    // division rather than as an amount each recipient takes. Reusing "deal N
    // damage to all enemy units" would describe a card five times as strong.
    if (effect.divided === true) {
      return {
        text: `divide ${amountPhrase(effect.amount)} damage among ${target} as you choose`,
        notes: [
          ...amountNotes(effect.amount),
          'every point has to go somewhere legal, and a target takes its whole share as one hit',
          // Only worth saying when a player is actually in the pool, and worth
          // saying plainly then: a share aimed at a seat is player damage, which
          // is a different thing from damaging anything that seat controls.
          ...(effect.target.kind === 'entity_or_player'
            ? ['a share aimed at a player comes off their Health, not off anything they control']
            : []),
          'damage with nowhere to go is lost',
        ],
      };
    }
    return {
      text: `deal ${amountPhrase(effect.amount)} damage to ${target}`,
      notes: [...amountNotes(effect.amount), ...targetNotes(effect.target)],
    };
  },

  heal: (effect, options) => {
    const target = targetPhrase(effect.target, options);
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
    text: `give ${targetPhrase(effect.target, options)} ${statChange(
      effect.attack,
      effect.health,
    )} ${durationClause(effect.duration)}`,
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
    text: `give ${targetPhrase(effect.target, options)} ${
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
    text: `remove ${KEYWORD_REGISTRY[effect.keyword].name} from ${targetPhrase(effect.target, options)} ${durationClause(effect.duration)}`,
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
      text: effect.controller === 'self' ? `create ${howMany}` : `${controller} creates ${howMany}`,
      notes: [
        'tokens are always created — the battlefield has no size limit',
        ...(definition && definition.effects.length > 0
          ? ['the token resolves its own deploy effects as it arrives']
          : []),
      ],
    };
  },

  destroy: (effect, options) => ({
    text: `defeat ${targetPhrase(effect.target, options)}, whatever ${
      targetIsPlural(effect.target) ? 'their' : 'its'
    } remaining health`,
    notes: targetNotes(effect.target),
  }),

  sacrifice: (effect, options) => ({
    text: `sacrifice ${targetPhrase(effect.target, options)}`,
    notes: [
      ...targetNotes(effect.target),
      'a sacrificed unit counts as defeated as well as sacrificed',
    ],
  }),

  return_to_hand: (effect, options) => ({
    text: `return ${targetPhrase(effect.target, options)} to ${
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
    text: `prevent the next ${amountPhrase(effect.amount)} damage dealt to ${targetPhrase(effect.target, options)} ${durationClause(effect.duration)}`,
    notes: [...targetNotes(effect.target), 'stacked shields are spent oldest first'],
  }),

  exhaust: (effect, options) => ({
    text: `exhaust ${targetPhrase(effect.target, options)}`,
    notes: targetNotes(effect.target),
  }),

  skip_next_ready: (effect, options) => ({
    text: `stop ${targetPhrase(effect.target, options)} readying during ${
      targetIsPlural(effect.target) ? 'their' : 'its'
    } controller’s next Ready Step`,
    notes: [
      ...targetNotes(effect.target),
      'only the Ready Step is stopped: an effect that readies it still works',
      'it is used up by that one Ready Step, whether or not the unit was Exhausted',
      'a unit that leaves the battlefield first loses this entirely',
    ],
  }),

  ready: (effect, options) => ({
    text: `ready ${targetPhrase(effect.target, options)}`,
    notes: [...targetNotes(effect.target), 'readying does not clear Newly Deployed on its own'],
  }),

  move_card: (effect, options) => {
    const subject = targetPhrase(effect.target, options);
    // The two destinations that are not really "a move" in a player's head get
    // said the way the cards say them. Everything else keeps the generic
    // wording, which is honest for a zone whose name is the whole story.
    if (effect.toZone === 'removed') {
      return {
        text: `remove ${subject} from the game`,
        notes: [
          ...targetNotes(effect.target),
          'a card removed from the game is gone for good: nothing may target it and no effect returns it',
        ],
      };
    }
    if (effect.toZone === 'battlefield') {
      return {
        text: `put ${subject} onto the battlefield${effect.entersExhausted ? ' Exhausted' : ''}`,
        notes: [
          ...targetNotes(effect.target),
          // Both halves matter to a player deciding whether it is worth it, and
          // both are engine behaviour rather than card text: an arrival is not
          // a deployment (rule adjustment §7) and every arrival is Newly
          // Deployed (ruleset update §9).
          'it arrives Newly Deployed, so it cannot attack or pay an Exhaust cost until your next Ready Step',
          'this is not a deployment: abilities that watch for a Unit entering the battlefield see it, abilities that watch for one being deployed do not',
        ],
      };
    }
    return {
      text: `move ${subject} to ${
        effect.toZone === 'hand' ? 'its owner’s' : 'the'
      } ${zoneName(effect.toZone)}`,
      notes: targetNotes(effect.target),
    };
  },

  schedule_delayed: (effect, options) => {
    const ability = options.delayedAbilities?.find((entry) => entry.id === effect.delayedAbilityId);
    // Nothing to look up. Said plainly rather than guessed at: a sentence
    // invented here would be the one thing the help layer must never produce.
    if (!ability) {
      return {
        text: 'set up a delayed effect',
        notes: ['the delayed instructions are printed on this card'],
      };
    }

    const subjectNoun = delayedSubjectNoun(ability, options.sourceNoun);
    const when =
      ability.trigger === undefined
        ? delayedBoundaryClause(ability.boundary)
        : `when ${TRIGGER_REGISTRY[ability.trigger].event(subjectNoun)}${delayedWindowClause(
            ability.boundary,
          )}`;
    const body = ability.effects
      .map((nested) => explainEffect(nested, { ...options, subjectNoun }).text)
      // Each nested step comes back as a finished sentence. Undo exactly what
      // `sentence` did to it — the capital and the full stop — so the steps read
      // as clauses hanging off the timing phrase, the way the printed card
      // writes them, instead of "At the end of the turn, Return this unit.".
      .map((text) => text.replace(/\.$/, ''))
      .map((text) => (text.length > 0 ? text[0]!.toLowerCase() + text.slice(1) : text))
      .join(', then ');

    return {
      text: `${when}, ${body}`,
      notes: [
        ...(ability.trigger === undefined
          ? []
          : ['if that never happens, the delayed effect simply ends with the turn']),
        ...(ability.subject === undefined
          ? []
          : [
              'the card it is about is fixed when this resolves; if that card moves to a different zone first, the delayed effect is dropped',
            ]),
      ],
    };
  },

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
/** Sentence subjects that are somebody other than the player being asked. */
const THIRD_PARTY_SUBJECT = /^(each |all |your opponent|the opponent)/i;

/**
 * Says "you may" about an already-rendered instruction.
 *
 * Applied once here rather than threaded through twenty renderers — the same
 * reason `optional` is a field on the gate rather than a wrapper effect. The
 * modal has to attach to the sentence's subject, and the renderers produce
 * three shapes:
 *
 *  - **"you draw one card"** — the subject is already there, so the modal slots
 *    in behind it rather than in front of it.
 *  - **"deal three damage to a unit"** — imperative, and the modal goes in
 *    front.
 *  - **"each opponent discards a card"** — a third party. "You may each
 *    opponent discards" is not English, so the decision is stated after the
 *    sentence instead of in front of it.
 */
function optionalPhrase(text: string): string {
  if (/^you\s/i.test(text)) return `you may ${text.slice(4)}`;
  if (THIRD_PARTY_SUBJECT.test(text)) return `${text}, if you choose to`;
  return `you may ${text}`;
}

export function explainEffect(
  effect: EffectDefinition,
  options: ExplainOptions = {},
): EffectExplanation {
  const render = RENDERERS[effect.type] as Renderer<EffectType>;
  const result = render(effect, options);
  // Both gates are applied here rather than by each renderer. `condition` used
  // to be a renderer's own business and only five of the nineteen remembered
  // it, so fourteen effect types were quietly dropping their "if" from the
  // generated prose — a card that reads as unconditional and is not.
  const phrased = effect.optional ? optionalPhrase(result.text) : result.text;
  return {
    type: effect.type,
    text: sentence(`${phrased}${conditionClause(effect.condition)}`),
    notes: result.notes ?? [],
  };
}

/** Effect types that currently have a renderer. Used by content validation. */
export const RENDERED_EFFECT_TYPES: readonly EffectType[] = Object.keys(RENDERERS) as EffectType[];

export { describeSelector };
