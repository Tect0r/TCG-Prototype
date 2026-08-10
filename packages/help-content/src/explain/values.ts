import {
  isFixedValue,
  type CardFilter,
  type ConditionDefinition,
  type CountQuery,
  type CountSubject,
  type SignedValueExpression,
  type ValueExpression,
} from '@tcg/card-data';

/**
 * Prose for counts, conditions and computed values (ruleset update §15).
 *
 * Kept apart from the effect renderers because all three appear in three
 * different places — inside an effect sentence, as an "if" clause on a trigger,
 * and in the pilot-facing support registry — and a card that says "for each
 * Goblin you control" in one and "per Goblin" in another reads like two
 * different rules.
 *
 * Nothing here is executable. It describes what the engine will do; the engine
 * never reads it back (CLAUDE.md §2).
 */

const NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
] as const;

function numberWord(value: number): string {
  return NUMBER_WORDS[value] ?? String(value);
}

/**
 * The noun a subject counts, singular and plural, plus the clause that pins it
 * to a moment in time.
 *
 * The clause is kept apart from the noun so ownership can sit between them:
 * "units you control defeated this turn" rather than the garbled "units
 * defeated this turn you control". It must never be dropped — "two Units
 * defeated" and "two Units defeated this turn" are different claims.
 */
const SUBJECT_NOUNS: Record<CountSubject, { one: string; many: string; clause?: string }> = {
  units: { one: 'unit', many: 'units' },
  attacking_units: { one: 'attacking unit', many: 'attacking units' },
  blocking_units: { one: 'blocking unit', many: 'blocking units' },
  cards_in_hand: { one: 'card', many: 'cards', clause: 'in hand' },
  units_defeated_this_turn: { one: 'unit', many: 'units', clause: 'defeated this turn' },
  units_sacrificed_this_turn: { one: 'unit', many: 'units', clause: 'sacrificed this turn' },
  units_deployed_this_turn: { one: 'unit', many: 'units', clause: 'deployed this turn' },
  tokens_created_this_turn: { one: 'token', many: 'tokens', clause: 'created this turn' },
  units_survived_as_blocker_this_turn: {
    one: 'unit',
    many: 'units',
    clause: 'that survived combat as a blocker this turn',
  },
};

/**
 * How each filter predicate reads inside a count.
 *
 * A total `Record<keyof CardFilter, …>`, so adding a predicate to the card
 * schema is a compile error here until it has words. It was not always: this
 * table replaced two hand-written `if` chains that between them dropped
 * `cardTypes`, `unique`, `newlyDeployed`, `attacking`, `blocking`, `anyOf` and
 * half of every numeric range — a card counting "units that survived combat as
 * blockers" read as counting *every* unit, which is a much stronger card.
 *
 * `before` sits in front of the subject noun, `after` trails it. Deliberately
 * separate from `selectors.ts#filterPhrases`, which words the same predicates
 * for a *target*: "friendly units tagged goblin" is a thing you point at, and
 * "goblin units you control" is a thing you count, and forcing one phrasing to
 * do both makes both read badly.
 */
type FilterPhraseTable = {
  readonly [K in keyof Required<CardFilter>]: (value: NonNullable<CardFilter[K]>) => {
    readonly before?: readonly string[];
    readonly after?: readonly string[];
  };
};

const rangeClause = (
  label: string,
  range: { min?: number | undefined; max?: number | undefined },
): string[] => {
  const parts: string[] = [];
  if (range.min !== undefined) parts.push(`${label} ${range.min} or more`);
  if (range.max !== undefined) parts.push(`${label} ${range.max} or less`);
  return parts;
};

const FILTER_PHRASES: FilterPhraseTable = {
  keywords: (value) => ({ before: [value.join(' or ')] }),
  tags: (value) => ({ before: [value.join(' or ')] }),
  colors: (value) => ({ before: [value.join(' or ')] }),
  cardTypes: (value) => ({ before: [value.join(' or ')] }),
  cardIds: (value) => ({ after: [`named by the card (${value.join(' or ')})`] }),
  exhausted: (value) => ({ before: [value ? 'exhausted' : 'ready'] }),
  damaged: (value) => ({ before: [value ? 'damaged' : 'undamaged'] }),
  unique: (value) => ({ before: [value ? 'unique' : 'non-unique'] }),
  // The negatives trail the noun: there is no adjective for "not newly
  // deployed" that does not invent jargon.
  newlyDeployed: (value) =>
    value ? { before: ['newly deployed'] } : { after: ['that did not arrive this turn'] },
  attacking: (value) => (value ? { before: ['attacking'] } : { after: ['that are not attacking'] }),
  blocking: (value) => (value ? { before: ['blocking'] } : { after: ['that are not blocking'] }),
  survivedAsBlocker: (value) => ({
    after: [
      value
        ? 'that survived combat as blockers since your previous turn'
        : 'that did not survive combat as blockers since your previous turn',
    ],
  }),
  cost: (value) => ({ after: rangeClause('costing', value) }),
  attack: (value) => ({ after: rangeClause('with ATK', value) }),
  health: (value) => ({ after: rangeClause('with health', value) }),
  anyOf: (value) => ({
    after: [
      `matching ${value
        .map((alternative) => describeFilterParts(alternative).join(' ') || 'anything')
        .join(' or ')}`,
    ],
  }),
};

/** Every phrase a filter contributes, in the table's declaration order. */
function describeFilterParts(filter: CardFilter): string[] {
  const before: string[] = [];
  const after: string[] = [];
  for (const [key, describe] of Object.entries(FILTER_PHRASES)) {
    const value = filter[key as keyof CardFilter];
    if (value === undefined) continue;
    const phrases = (describe as (input: unknown) => { before?: string[]; after?: string[] })(
      value,
    );
    before.push(...(phrases.before ?? []));
    after.push(...(phrases.after ?? []));
  }
  return [...before, ...after];
}

/** The adjectives a card filter contributes, in a stable reading order. */
function filterWords(filter: CardFilter | undefined): string {
  if (!filter) return '';
  const parts: string[] = [];
  for (const [key, describe] of Object.entries(FILTER_PHRASES)) {
    const value = filter[key as keyof CardFilter];
    if (value === undefined) continue;
    parts.push(...((describe as (input: unknown) => { before?: string[] })(value).before ?? []));
  }
  return parts.length > 0 ? `${parts.join(' ')} ` : '';
}

/** The trailing qualifiers a filter contributes, after the noun. */
function filterClauses(filter: CardFilter | undefined): string {
  if (!filter) return '';
  const parts: string[] = [];
  for (const [key, describe] of Object.entries(FILTER_PHRASES)) {
    const value = filter[key as keyof CardFilter];
    if (value === undefined) continue;
    parts.push(...((describe as (input: unknown) => { after?: string[] })(value).after ?? []));
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

function ownership(query: CountQuery): string {
  switch (query.controller) {
    case 'self':
      return ' you control';
    case 'opponent':
      return ' an opponent controls';
    default:
      return '';
  }
}

/** "other Goblins you control", "units you control defeated this turn". */
export function describeCount(query: CountQuery, plural = true): string {
  const noun = SUBJECT_NOUNS[query.subject];
  const other = query.excludeSource ? 'other ' : '';
  const head = `${other}${filterWords(query.filter)}${plural ? noun.many : noun.one}`;
  // Ownership binds tightest to the noun; the subject's own time clause and the
  // filter's qualifiers trail it, in that order.
  return [head + ownership(query), noun.clause, filterClauses(query.filter).trim()]
    .filter((part) => part !== undefined && part !== '')
    .join(' ');
}

/** "three", "the number of Goblins you control", "one for every three Goblins". */
export function describeValue(value: ValueExpression | SignedValueExpression): string {
  if (typeof value === 'number') return numberWord(Math.abs(value));

  const counted = describeCount(value.count);
  const base =
    value.per === 1
      ? `the number of ${counted}`
      : `one for every ${numberWord(value.per)} ${counted}`;

  const extras: string[] = [];
  if (value.plus > 0) extras.push(`plus ${numberWord(value.plus)}`);
  if (value.plus < 0) extras.push(`minus ${numberWord(-value.plus)}`);
  if (value.maximum !== undefined) extras.push(`to a maximum of ${numberWord(value.maximum)}`);
  if (value.minimum > 0) extras.push(`to a minimum of ${numberWord(value.minimum)}`);

  return extras.length > 0 ? `${base}, ${extras.join(', ')}` : base;
}

/** True when the value is a plain printed number, for callers that branch. */
export function valueIsFixed(value: ValueExpression): boolean {
  return isFixedValue(value);
}

/**
 * The number to show when prose needs one and the value is dynamic.
 *
 * Zero rather than a guess: an inspector that printed an invented number would
 * be lying about the board, and every caller here pairs it with the descriptive
 * form anyway.
 */
export function nominalValue(value: ValueExpression | SignedValueExpression): number {
  return typeof value === 'number' ? value : 0;
}

/** "at least two friendly units were defeated this turn", "this card is ready". */
export function describeCondition(condition: ConditionDefinition): string {
  if (condition.kind === 'active_turn') {
    return condition.expected ? 'it is your turn' : "it is an opponent's turn";
  }

  if (condition.kind === 'source_state') {
    const state =
      condition.state === 'newly_deployed' ? 'arrived this turn' : `is ${condition.state}`;
    return condition.expected
      ? `this card ${state}`
      : `this card ${state.replace('is ', 'is not ')}`;
  }

  const counted = describeCount(condition.count, condition.value !== 1);
  switch (condition.comparison) {
    case 'at_least':
      return `there ${condition.value === 1 ? 'is' : 'are'} at least ${numberWord(
        condition.value,
      )} ${counted}`;
    case 'at_most':
      return `there ${condition.value === 1 ? 'is' : 'are'} at most ${numberWord(
        condition.value,
      )} ${counted}`;
    default:
      return `there ${condition.value === 1 ? 'is' : 'are'} exactly ${numberWord(
        condition.value,
      )} ${counted}`;
  }
}

/** The "if …" clause a gated instruction or trigger carries, or nothing. */
export function conditionClause(condition: ConditionDefinition | undefined): string {
  return condition ? `, but only if ${describeCondition(condition)}` : '';
}
