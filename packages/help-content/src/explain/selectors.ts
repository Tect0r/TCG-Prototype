import {
  isDistributedSelection,
  KEYWORD_REGISTRY,
  type CardFilter,
  type CardFilterAlternative,
  type CardType,
  type NumericRange,
  type PlayerSelector,
  type TargetDefinition,
  type TargetSelector,
  type TriggerScope,
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
  reaction: 'Reaction',
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
  if (filter.newlyDeployed === true) before.push('newly deployed');
  if (filter.attacking === true) before.push('attacking');
  if (filter.blocking === true) before.push('blocking');
  // The negatives go after the noun instead: "friendly units not currently
  // attacking" reads as English at any count, where an adjective form would
  // have to pick between "is not" and "are not".
  // Not an adjective in either direction: "survived combat as a blocker" is a
  // clause about what the unit did, and shortening it would lose the "as a
  // blocker" that is the whole condition.
  if (filter.survivedAsBlocker === true) {
    after.push('that survived combat as blockers since your previous turn');
  }
  if (filter.survivedAsBlocker === false) {
    after.push('that did not survive combat as blockers since your previous turn');
  }
  if (filter.newlyDeployed === false) after.push('not newly deployed');
  if (filter.attacking === false) after.push('not currently attacking');
  if (filter.blocking === false) after.push('not currently blocking');
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

  if (filter.anyOf && filter.anyOf.length > 0) {
    after.push(`matching ${list(filter.anyOf.map(alternativePhrase), 'or')}`);
  }

  return { before, after, noun, nounPlural };
}

/**
 * The thing a scoped trigger is watching: "another friendly goblin unit".
 *
 * A scope is not a target — nobody chooses it and nothing is pointed at — so it
 * gets its own phrase rather than reusing `describeSelector`. What it shares is
 * `filterPhrases`, so a Goblin filter reads the same here as anywhere else.
 *
 * `excludeSelfCaused` is deliberately not worded: it is a loop guard, not a
 * rule a player can observe, and spelling it out would put a sentence on the
 * card about something that never visibly happens.
 */
export function describeTriggerScope(scope: TriggerScope): string {
  const phrases = filterPhrases(scope.filter);
  const owner =
    scope.controller === 'self'
      ? 'friendly'
      : scope.controller === 'opponent'
        ? "an opponent's"
        : null;
  const head = [
    scope.excludeSource ? 'another' : null,
    owner,
    ...phrases.before,
    phrases.noun ?? 'unit',
  ]
    .filter((part): part is string => part !== null)
    .join(' ');
  // "another …" and "an opponent's …" are already determined; anything else
  // needs an article so the sentence reads "when a friendly unit is defeated".
  const determined = scope.excludeSource || scope.controller === 'opponent';
  const opener = determined ? head : `${article(head)} ${head}`;
  return [opener, ...phrases.after].join(' ');
}

/**
 * One `anyOf` alternative as a noun phrase: "a relic", "a unit with Guardian".
 *
 * Built by running the alternative back through `filterPhrases` itself. An
 * alternative cannot contain another `anyOf`, so the recursion is exactly one
 * level deep by construction, and every predicate is worded by the same code
 * that words it at the top level — a second description table would be free to
 * drift from the first.
 */
function alternativePhrase(alternative: CardFilterAlternative): string {
  const { before, after, noun } = filterPhrases(alternative);
  const head = [...before, noun ?? 'card'].join(' ');
  return [article(head), head, ...after].join(' ');
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

  // In an each-player selection the selector's `controller` is read relative to
  // whoever is being asked, so "friendly" and "enemy" — which are relative to
  // the caster — would name the wrong side for three seats out of four. The
  // ownership moves to a trailing clause below instead.
  const distributed = isDistributedSelection(selector);
  const adjectives = [
    distributed ? null : controllerAdjective(selector.controller),
    ...phrases.before,
  ].filter((value): value is string => value !== null);
  const prefix = adjectives.length > 0 ? `${adjectives.join(' ')} ` : '';

  const head =
    selector.count === 'all'
      ? `all ${prefix}${nounPlural}`
      : quantify(selector.count, `${prefix}${noun}`, `${prefix}${nounPlural}`);

  const parts = [head.replace(/\s+/g, ' '), ...phrases.after];

  if (distributed && selector.controller !== 'any') {
    // "each player" rather than `describePlayerSelector`'s "every player": the
    // phrase attaches to a per-seat count, and "one unit every player controls"
    // reads as one unit they all share.
    const who = selector.chooser === 'each_opponent' ? 'each opponent' : 'each player';
    parts.push(
      selector.controller === 'self'
        ? `controlled by ${who}`
        : `controlled by an opponent of ${who}`,
    );
  }

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
      // An each-player selection is worded as the simultaneous thing it is:
      // "every player chooses which" alone would let a reader assume the answers
      // are taken one at a time, which is the one thing it must not do.
      if (isDistributedSelection(selector)) {
        return `${describePlayerSelector(selector.chooser)} chooses separately, and nothing happens until every answer is in`;
      }
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
 *
 * `subjectNoun` names the card a `trigger_subject` points at. It has a default
 * because that is the honest phrase for an ordinary triggered ability, and it is
 * overridable because inside a delayed clause the subject was bound when the
 * clause was set up — "the card that triggered this" would be describing an
 * event that has not happened yet.
 */
export function describeTarget(
  target: TargetDefinition,
  sourceNoun = 'this card',
  subjectNoun = 'the card that triggered this',
): string {
  switch (target.kind) {
    case 'source':
      return sourceNoun;
    case 'trigger_subject':
      // Named by what it is rather than by a pronoun: "it" would be ambiguous
      // in a sentence that has already mentioned the card the ability is on.
      return subjectNoun;
    case 'blocked_by_source':
      return `each unit ${sourceNoun} is blocking`;
    case 'previous_target':
      // The word the card itself uses. The step before has just named the unit,
      // so a pronoun is unambiguous here in a way it never is for a trigger.
      return 'it';
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
    case 'trigger_subject':
      return false;
    case 'blocked_by_source':
      // "Each unit this is blocking" is a set: one blocker may face more than
      // one attacker as soon as the rules allow it, and the phrase reads plural
      // either way.
      return true;
    case 'previous_target':
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
  if (target.kind === 'blocked_by_source') {
    return ['nothing happens outside a combat this card is blocking in'];
  }
  if (target.kind !== 'entity') return [];
  const selector = target.selector;
  const notes: string[] = [];

  const selection = describeSelection(selector);
  if (selection !== null) notes.push(selection);
  if (isDistributedSelection(selector)) {
    // The "N legal targets must exist" note below is about the instruction as a
    // whole and would be wrong here: each seat answers for itself, so a seat
    // with nothing to name drops out and the rest still resolve.
    notes.push('a player with no legal choice is skipped, and everyone else still answers');
  } else if (selector.optional) {
    // An optional selector a player answers is "you may": declining by picking
    // nothing is the decision, and a note that only says the step "may resolve
    // with no target" describes an accident rather than a choice.
    notes.push(
      selector.selection === 'player_choice'
        ? 'picking nothing is a legal answer, and skips this step'
        : 'this may resolve with no target at all',
    );
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
