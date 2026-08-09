import {
  KEYWORD_REGISTRY,
  type CardFilter,
  type CardType,
  type NumericRange,
  type PlayerSelector,
  type TargetDefinition,
  type TargetSelector,
  type ZoneId,
} from '@tcg/card-data';
import { article, humanise, list, numberWord, plural, quantify } from './grammar.js';

/**
 * Structured targets, in plain language.
 *
 * Every phrase here mirrors what `rules-engine/targeting.ts` actually does with
 * the same selector. Where the engine widens `opponent` to "every living
 * opponent's zones" at a four-player table, the wording says so; where it asks
 * the controller to pick one, the wording says that instead. Guessing would put
 * game logic into presentation text, which is the one thing this system exists
 * to prevent.
 */

const ZONE_NAMES: Readonly<Record<ZoneId, string>> = {
  deck: 'deck',
  hand: 'hand',
  battlefield: 'battlefield',
  discard: 'discard pile',
  commander_zone: 'Commander zone',
  recovery: 'recovery zone',
  removed: 'removed-from-match zone',
};

const CARD_TYPE_NOUNS: Readonly<Record<CardType, string>> = {
  unit: 'unit',
  spell: 'spell',
  relic: 'relic',
  commander: 'Commander',
  token: 'token',
};

export function zoneName(zone: ZoneId): string {
  return ZONE_NAMES[zone];
}

function rangePhrase(label: string, range: NumericRange): string | null {
  const { min, max } = range;
  if (min !== undefined && max !== undefined) {
    return min === max ? `${label} exactly ${min}` : `${label} ${min} to ${max}`;
  }
  if (min !== undefined) return `${label} ${min} or more`;
  if (max !== undefined) return `${label} ${max} or less`;
  return null;
}

/**
 * The adjectives a filter adds, as noun-phrase fragments.
 *
 * Returned in two halves so the caller can build "a damaged enemy unit with
 * Venom" rather than a run-on list: `before` sits in front of the noun,
 * `after` trails it.
 */
export interface FilterPhrases {
  readonly before: readonly string[];
  readonly after: readonly string[];
  /** Noun to use instead of the generic one, when the filter names types. */
  readonly noun: string | null;
  /** The same noun in the plural. "unit or token" pluralises both halves. */
  readonly nounPlural: string | null;
}

export function filterPhrases(filter: CardFilter | undefined): FilterPhrases {
  if (!filter) return { before: [], after: [], noun: null, nounPlural: null };

  const before: string[] = [];
  const after: string[] = [];

  if (filter.damaged === true) before.push('damaged');
  if (filter.damaged === false) before.push('undamaged');
  if (filter.exhausted === true) before.push('exhausted');
  if (filter.exhausted === false) before.push('ready');
  if (filter.unique === true) before.push('unique');
  if (filter.unique === false) before.push('non-unique');
  if (filter.colors && filter.colors.length > 0) {
    before.push(list(filter.colors.map(humanise), 'or'));
  }

  // "unit or token" reads better as the noun itself than as an adjective.
  let noun: string | null = null;
  let nounPlural: string | null = null;
  if (filter.cardTypes && filter.cardTypes.length > 0) {
    const nouns = filter.cardTypes.map((type) => CARD_TYPE_NOUNS[type]);
    noun = list(nouns, 'or');
    // Each half is pluralised, so "unit or token" becomes "units or tokens"
    // rather than the wrong "unit or tokens".
    nounPlural = list(
      nouns.map((word) => `${word}s`),
      'or',
    );
  }

  if (filter.tags && filter.tags.length > 0) {
    after.push(`tagged ${list(filter.tags.map(humanise), 'or')}`);
  }
  if (filter.keywords && filter.keywords.length > 0) {
    after.push(
      `with ${list(
        filter.keywords.map((id) => KEYWORD_REGISTRY[id].name),
        'or',
      )}`,
    );
  }
  if (filter.cardIds && filter.cardIds.length > 0) {
    after.push(`named by the card (${list(filter.cardIds.map(humanise), 'or')})`);
  }
  for (const [label, range] of [
    ['costing', filter.cost],
    ['with attack', filter.attack],
    ['with health', filter.health],
  ] as const) {
    if (!range) continue;
    const phrase = rangePhrase(label, range);
    if (phrase) after.push(phrase);
  }

  return { before, after, noun, nounPlural };
}

/** Whose cards a selector may reach, as an adjective. */
function controllerAdjective(controller: TargetSelector['controller']): string | null {
  switch (controller) {
    case 'self':
      return 'friendly';
    case 'opponent':
      return 'enemy';
    case 'any':
      return null;
  }
}

/**
 * A selector as a noun phrase: "two damaged enemy units on the battlefield".
 *
 * `defaultNoun` is what to call the things when the filter does not name a card
 * type — "unit" on the battlefield, "card" everywhere else.
 */
export function describeSelector(selector: TargetSelector): string {
  const phrases = filterPhrases(selector.filter);
  const defaultNoun = selector.zone === 'battlefield' ? 'unit' : 'card';
  const noun = phrases.noun ?? defaultNoun;
  const nounPlural = phrases.nounPlural ?? plural(2, defaultNoun);

  const adjectives = [controllerAdjective(selector.controller), ...phrases.before].filter(
    (value): value is string => value !== null,
  );
  const prefix = adjectives.length > 0 ? `${adjectives.join(' ')} ` : '';

  const head =
    selector.count === 'all'
      ? `all ${prefix}${nounPlural}`
      : quantify(selector.count, `${prefix}${noun}`, `${prefix}${nounPlural}`);

  const parts = [head.replace(/\s+/g, ' '), ...phrases.after];

  // The zone is worth naming whenever it is not the obvious one.
  if (selector.zone !== 'battlefield') {
    const owner = selector.controller === 'self' ? 'your' : 'the owner’s';
    parts.push(`in ${owner} ${zoneName(selector.zone)}`);
  }
  if (selector.excludeSource) parts.push('other than this card');

  return parts.join(' ');
}

/** How the target is picked, as a trailing clause, or null when it is obvious. */
export function describeSelection(selector: TargetSelector): string | null {
  switch (selector.selection) {
    case 'player_choice':
      return selector.chooser === 'self'
        ? 'you choose which'
        : `${describePlayerSelector(selector.chooser)} chooses which`;
    case 'random':
      return 'chosen at random';
    case 'automatic':
      return selector.count === 'all' ? null : 'chosen automatically, in board order';
  }
}

/** Which players an effect's `player` field names, from the controller's view. */
export function describePlayerSelector(selector: PlayerSelector): string {
  switch (selector) {
    case 'self':
      return 'you';
    case 'opponent':
      return 'an opponent you choose';
    case 'each_opponent':
      return 'each opponent';
    case 'all_players':
      return 'every player';
  }
}

/** Subject-verb agreement for the phrases above. */
export function playerSelectorIsPlural(selector: PlayerSelector): boolean {
  return selector === 'each_opponent' || selector === 'all_players';
}

/**
 * A whole target definition as a noun phrase.
 *
 * `sourceNoun` names the card the text is printed on, so a unit reads "this
 * unit" and a relic reads "this relic".
 */
export function describeTarget(target: TargetDefinition, sourceNoun = 'this card'): string {
  switch (target.kind) {
    case 'source':
      return sourceNoun;
    case 'entity':
      return describeSelector(target.selector);
    case 'player':
      return target.relation === 'self' ? 'you' : 'an opponent you choose';
    case 'players':
      return target.relation === 'each_opponent' ? 'each opponent' : 'every player';
  }
}

/** True when the target phrase takes a plural verb. */
export function targetIsPlural(target: TargetDefinition): boolean {
  switch (target.kind) {
    case 'source':
      return false;
    case 'entity':
      return target.selector.count === 'all' || target.selector.count > 1;
    case 'player':
      return false;
    case 'players':
      return true;
  }
}

/** Extra sentences a target deserves: optionality, choosers, randomness. */
export function targetNotes(target: TargetDefinition): readonly string[] {
  if (target.kind !== 'entity') return [];
  const selector = target.selector;
  const notes: string[] = [];

  const selection = describeSelection(selector);
  if (selection !== null) notes.push(selection);
  if (selector.optional) {
    notes.push('this may resolve with no target at all');
  } else if (selector.count !== 'all') {
    notes.push(
      `${numberWord(selector.count)} legal ${plural(
        selector.count,
        'target',
      )} must exist for this to happen`,
    );
  }
  if (selector.controller === 'opponent') {
    notes.push('at a table of three or four, every living opponent’s cards are eligible');
  }
  return notes;
}

export { CARD_TYPE_NOUNS };
export { article };
