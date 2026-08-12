import { warning, type Issue } from '@tcg/shared';
import type { CardDefinition } from './schema/card.js';
import type { EffectDefinition, EffectType } from './schema/effect.js';
import { KEYWORD_LIST } from './keywords.js';

/**
 * `displayText` is presentation only. It is never executed and never parsed to
 * determine behaviour — but obvious drift between prose and structured effects
 * is a common authoring bug, so we lint for it and surface warnings.
 *
 * The check is deliberately one-directional and conservative: prose that
 * clearly names a mechanic must have a matching effect. Extra effects are not
 * flagged, because plenty of behaviour reads naturally without a keyword.
 */
const PROSE_MARKERS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly effects: readonly EffectType[];
}> = [
  { pattern: /\bdraws? (a|an|\d+|one|two|three) card/i, effects: ['draw', 'search_zone'] },
  { pattern: /\bdiscards? (a|an|\d+|one|two|three)/i, effects: ['discard'] },
  { pattern: /\bdeals? \d+ damage/i, effects: ['deal_damage'] },
  { pattern: /\bheals?\b/i, effects: ['heal'] },
  { pattern: /\bdestroys?\b/i, effects: ['destroy'] },
  { pattern: /\bsacrifices?\b/i, effects: ['sacrifice'] },
  { pattern: /\breturns? .*to (its|their|your) owner's hand/i, effects: ['return_to_hand'] },
  { pattern: /\bcreates? \w* ?\d* ?.*token/i, effects: ['create_token'] },
  { pattern: /\bexhausts?\b/i, effects: ['exhaust'] },
  // "does not Ready during its controller's next Ready Step" names the Ready
  // Step in order to *stop* one, so the prevention satisfies the marker exactly
  // as readying does. Both are the same mechanic seen from opposite sides.
  { pattern: /\breadies\b|\bready\b/i, effects: ['ready', 'skip_next_ready'] },
  { pattern: /\bcosts? \d+ (less|more)/i, effects: ['modify_cost'] },
  { pattern: /\bprevents? .*damage/i, effects: ['prevent_damage'] },
  { pattern: /[+-]\d+\s*\/\s*[+-]\d+/, effects: ['modify_stats'] },
];

/**
 * The other direction: a mechanic the card's structure really has, and the
 * words its printed text must contain for a player to know about it.
 *
 * `PROSE_MARKERS` above catches text that promises behaviour the card does not
 * have. This catches the opposite and more dangerous drift — behaviour the card
 * has that its text never mentions — which no amount of curation can excuse,
 * because the player is reading the card and the engine is not.
 *
 * Each pattern is a *vocabulary*, not a phrasing: it accepts every word the
 * catalogue actually uses for that mechanic, so a card is free to read
 * naturally. What it may not do is stay silent. Where a mechanic has no
 * player-visible vocabulary of its own — an `energy` cost, a `reorder_zone`
 * that is part of a look-at-the-top clause — it is deliberately absent from
 * this table rather than given a pattern that would match anything.
 */
const MECHANIC_MARKERS: Partial<Record<EffectType, RegExp>> = {
  draw: /\bdraws?\b/i,
  discard: /\bdiscards?\b/i,
  deal_damage: /\bdamage\b/i,
  heal: /\brestores?\b|\bheals?\b|\bHealth\b/i,
  destroy: /\bdestroys?\b|\bdefeats?\b/i,
  sacrifice: /\bsacrifices?\b/i,
  return_to_hand: /\breturns?\b/i,
  create_token: /\bcreates?\b/i,
  exhaust: /\bExhaust\w*\b/i,
  ready: /\bready\b|\breadies\b/i,
  counter: /\bcounters?\b/i,
  prevent_damage: /\bprevents?\b/i,
  modify_stats: /[+-]\d+|\bATK\b|\bHealth\b/i,
  modify_cost: /\bcosts?\b/i,
  // A card that moves something between zones has to say where it went, and
  // every printed phrasing of that names a zone, the game, or a direction.
  move_card: /\bremoves?\b|\breturns?\b|\bputs?\b|\bbattlefield\b|\bbottom\b|\bdeck\b/i,
  // Looking, searching, revealing and returning-from-a-pile are all one
  // instruction; the prose picks whichever verb the card is about.
  search_zone: /\blooks?\b|\bsearch\w*\b|\breveals?\b|\breturns?\b|\btop\b/i,
  // "at the end of the turn", "when it is defeated this turn": a delayed clause
  // is only readable if it says when it happens.
  schedule_delayed: /\bend of\b|\bthis turn\b/i,
  skip_next_ready: /\bready\b/i,
};

/** The same idea for the effects that only exist as continuous abilities. */
const STATIC_MECHANIC_MARKERS: Record<string, RegExp> = {
  cost_reduction: /\bcosts?\b/i,
  reaction_discount: /\bcosts?\b/i,
  replace_ready: /\bready\b/i,
};

function collectEffects(card: CardDefinition): EffectDefinition[] {
  return [
    ...card.effects,
    ...card.abilities.flatMap((ability) => ability.effects),
    ...card.activatedAbilities.flatMap((ability) => ability.effects),
    // A delayed body is behaviour the card really has, just later. Leaving it
    // out would report "create two Thrall Tokens at the end of the turn" as
    // prose with no matching effect — drift the card does not have.
    ...card.delayedAbilities.flatMap((ability) => ability.effects),
  ];
}

/**
 * Effect types a card's continuous abilities cover. A static "+1/+1 to your
 * units" reads as a stat change in prose but is not an `EffectDefinition`, so
 * the linter has to know about it or it reports a false mismatch.
 */
function staticEffectTypes(card: CardDefinition): EffectType[] {
  // `reaction_discount` and `cost_reduction` are deliberately not here: neither
  // has an `EffectDefinition` counterpart of the same name, so mapping one to
  // itself would invent a vocabulary word the linter would then expect to find
  // in the card's prose. Both really are cost changes, and both are declared as
  // `modify_cost` in `triggerEffectTypes` below.
  return card.staticAbilities.flatMap((ability) =>
    ability.effect.type === 'modify_stats' || ability.effect.type === 'grant_keyword'
      ? [ability.effect.type]
      : [],
  );
}

/**
 * Effect types covered by an activated ability's *costs*.
 *
 * "Pay 1 Energy and Exhaust — Sacrifice another Unit" reads as exhausting and
 * sacrificing, and it does both, but as costs paid before the ability is queued
 * rather than as effects. Without this the linter reports every activated
 * ability with a cost as text drift.
 */
function costEffectTypes(card: CardDefinition): EffectType[] {
  const types: EffectType[] = [];
  // A card's own "as an additional cost, sacrifice a Unit" reads exactly the
  // same way, and is paid at a different moment rather than by a different
  // mechanism — so it is covered here rather than in a second walk.
  const lists = [card.additionalCosts, ...card.activatedAbilities.map((ability) => ability.costs)];
  for (const costs of lists) {
    for (const cost of costs) {
      if (cost.type === 'exhaust_source') types.push('exhaust');
      else if (cost.type === 'sacrifice') types.push('sacrifice');
      else if (cost.type === 'discard') types.push('discard');
    }
  }
  return types;
}

/**
 * Effect types a card's *triggers and conditions* account for.
 *
 * "The first time you sacrifice a Unit each turn, draw a card" reads as if it
 * sacrifices something and does not: the sacrifice is the event it waits for,
 * not something it performs. Same for "if this Unit is Ready" — a question, not
 * a readying. Without this the linter reports every conditional and
 * event-scoped ability the new vocabulary makes possible as text drift, which
 * would drown the cards where prose and structure genuinely disagree.
 */
function triggerEffectTypes(card: CardDefinition): EffectType[] {
  const types: EffectType[] = [];

  for (const ability of card.abilities) {
    if (ability.trigger === 'on_sacrifice') types.push('sacrifice');
    if (ability.trigger === 'on_defeated') types.push('destroy');
    if (ability.trigger === 'on_tokens_created' || ability.trigger === 'on_deployed') {
      types.push('create_token');
    }
    if (ability.condition?.kind === 'source_state') {
      types.push(ability.condition.state === 'exhausted' ? 'exhaust' : 'ready');
    }
  }

  for (const effect of collectEffects(card)) {
    if (effect.condition?.kind === 'source_state') {
      types.push(effect.condition.state === 'exhausted' ? 'exhaust' : 'ready');
    }
  }

  for (const ability of card.staticAbilities) {
    // "While this Unit is Ready" is a gate on a continuous effect, not a
    // readying — the same reading the instruction-level gate above already gets.
    if (ability.sourceState !== undefined) {
      types.push(ability.sourceState === 'exhausted' ? 'exhaust' : 'ready');
    }
    // A Reaction discount and a self-scaling cost reduction really are cost
    // changes; they simply are not `EffectDefinition`s, because both are derived
    // from the board rather than applied once. The prose is honest, so the
    // linter should be too.
    if (ability.effect.type === 'reaction_discount' || ability.effect.type === 'cost_reduction') {
      types.push('modify_cost');
    }
    // A replacement really does exhaust a unit and really does stop one
    // readying; it simply does so by rewriting an event rather than by running
    // an instruction, so there is no `EffectDefinition` of that name to find.
    // The prose is honest about the mechanic, so the linter should be too.
    if (ability.effect.type === 'replace_arrival' && ability.effect.entersExhausted === true) {
      types.push('exhaust');
    }
    if (ability.effect.type === 'replace_ready') types.push('ready');
  }

  return types;
}

/**
 * Keywords a card names in a target filter rather than granting.
 *
 * "A friendly Guardian gains Barrier" mentions two keywords and grants only
 * one; the other is how the target is chosen. Both are legitimate references.
 */
function keywordsFiltered(card: CardDefinition): string[] {
  const found: string[] = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value !== 'object' || value === null) return;
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'keywords' && Array.isArray(entry)) found.push(...(entry as string[]));
      else visit(entry);
    }
  };
  visit([
    card.effects,
    card.abilities,
    card.activatedAbilities,
    card.staticAbilities,
    card.delayedAbilities,
  ]);
  return found;
}

/**
 * Every mechanic the card actually *performs*, as opposed to reacts to.
 *
 * Deliberately narrower than `effectTypes` in `lintDisplayText`: a trigger's
 * own event ("the first time you sacrifice a Unit") is a condition, not a
 * sacrifice this card carries out, so requiring the word would be requiring the
 * card to describe somebody else's action. A cost *is* included — "Pay 1 Energy
 * and Exhaust" is printed on the card and is as visible as any instruction.
 */
function performedMechanics(
  card: CardDefinition,
  effects: readonly EffectDefinition[],
): Set<string> {
  const performed = new Set<string>([
    ...effects.map((effect) => effect.type),
    ...costEffectTypes(card),
    ...staticEffectTypes(card),
  ]);
  for (const ability of card.staticAbilities) {
    const effect = ability.effect;
    if (effect.type in STATIC_MECHANIC_MARKERS) performed.add(effect.type);
    // A rewrite that Exhausts an arrival really does Exhaust it; the keyword
    // half is covered by the keyword check below.
    if (effect.type === 'replace_arrival' && effect.entersExhausted === true) {
      performed.add('exhaust');
    }
  }
  return performed;
}

/** Keywords the card has printed, grants once, or grants continuously. */
function keywordsInPlay(card: CardDefinition, effects: readonly EffectDefinition[]): Set<string> {
  const keywords = new Set<string>(card.keywords);
  for (const effect of effects) {
    if (effect.type === 'grant_keyword') keywords.add(effect.keyword);
  }
  for (const ability of card.staticAbilities) {
    if (ability.effect.type === 'grant_keyword') keywords.add(ability.effect.keyword);
    // A keyword handed out as part of an arrival is granted just as surely as
    // one handed out by an instruction.
    if (ability.effect.type === 'replace_arrival' && ability.effect.grantKeyword !== undefined) {
      keywords.add(ability.effect.grantKeyword);
    }
  }
  return keywords;
}

/** Warnings only — never blocks loading. */
export function lintDisplayText(card: CardDefinition): Issue[] {
  const issues: Issue[] = [];

  // A card already reported as unimplemented is *expected* to read richer than
  // it behaves — that is what the flag says. Repeating it as text drift would
  // bury the cards where prose and structure genuinely disagree.
  if (!card.implemented) return issues;

  const effects = collectEffects(card);
  const effectTypes = new Set<string>([
    ...effects.map((effect) => effect.type),
    ...staticEffectTypes(card),
    ...costEffectTypes(card),
    ...triggerEffectTypes(card),
  ]);
  const text = card.displayText;

  if (text === undefined) {
    if (effects.length > 0 || card.staticAbilities.length > 0) {
      issues.push(
        warning(
          'display_text/missing',
          `"${card.name}" has structured effects but no displayText for players to read.`,
          { path: 'displayText', context: { cardId: card.id } },
        ),
      );
    }
    return issues;
  }

  for (const marker of PROSE_MARKERS) {
    if (!marker.pattern.test(text)) continue;
    if (marker.effects.some((type) => effectTypes.has(type))) continue;
    issues.push(
      warning(
        'display_text/effect_mismatch',
        `"${card.name}" reads as if it has a ${marker.effects[0]} effect, but no such effect is defined.`,
        {
          path: 'displayText',
          context: { cardId: card.id, expectedEffects: marker.effects },
        },
      ),
    );
  }

  // The other direction, mechanic by mechanic: behaviour the card really
  // performs must appear in the words a player reads.
  for (const mechanic of performedMechanics(card, effects)) {
    const marker = MECHANIC_MARKERS[mechanic as EffectType] ?? STATIC_MECHANIC_MARKERS[mechanic];
    if (!marker || marker.test(text)) continue;
    issues.push(
      warning(
        'display_text/unstated_effect',
        `"${card.name}" has a ${mechanic} effect that its displayText never mentions.`,
        { path: 'displayText', context: { cardId: card.id, effectType: mechanic } },
      ),
    );
  }

  // Keywords live in structured data; repeating their reminder text in prose
  // without granting the keyword is the other common drift.
  const inPlay = keywordsInPlay(card, effects);
  const granted = new Set(inPlay);
  for (const filtered of keywordsFiltered(card)) granted.add(filtered);
  for (const keyword of KEYWORD_LIST) {
    const named = new RegExp(`\\b${keyword.name}\\b`, 'i').test(text);
    if (named && !granted.has(keyword.id)) {
      issues.push(
        warning(
          'display_text/keyword_mismatch',
          `"${card.name}" mentions ${keyword.name} but does not have or grant that keyword.`,
          { path: 'displayText', context: { cardId: card.id, keyword: keyword.id } },
        ),
      );
    }
    // A keyword the card carries or hands out and never names is the reverse
    // drift: the player has no way to learn it is there. A keyword only used to
    // *choose* a target is excluded — naming it is optional phrasing.
    if (!named && inPlay.has(keyword.id)) {
      issues.push(
        warning(
          'display_text/unstated_keyword',
          `"${card.name}" has or grants ${keyword.name} but its displayText never says so.`,
          { path: 'displayText', context: { cardId: card.id, keyword: keyword.id } },
        ),
      );
    }
  }

  return issues;
}
