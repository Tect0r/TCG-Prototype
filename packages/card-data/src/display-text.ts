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
  { pattern: /\breadies\b|\bready\b/i, effects: ['ready'] },
  { pattern: /\bcosts? \d+ (less|more)/i, effects: ['modify_cost'] },
  { pattern: /\bprevents? .*damage/i, effects: ['prevent_damage'] },
  { pattern: /[+-]\d+\s*\/\s*[+-]\d+/, effects: ['modify_stats'] },
];

function collectEffects(card: CardDefinition): EffectDefinition[] {
  return [
    ...card.effects,
    ...card.abilities.flatMap((ability) => ability.effects),
    ...card.activatedAbilities.flatMap((ability) => ability.effects),
  ];
}

/**
 * Effect types a card's continuous abilities cover. A static "+1/+1 to your
 * units" reads as a stat change in prose but is not an `EffectDefinition`, so
 * the linter has to know about it or it reports a false mismatch.
 */
function staticEffectTypes(card: CardDefinition): EffectType[] {
  // `reaction_discount` is deliberately not here: it is a static effect with no
  // `EffectDefinition` counterpart at all, so mapping it to one would invent a
  // vocabulary word the linter would then expect to find in the card's prose.
  return card.staticAbilities.flatMap((ability) =>
    ability.effect.type === 'reaction_discount' ? [] : [ability.effect.type],
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
  for (const ability of card.activatedAbilities) {
    for (const cost of ability.costs) {
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
    // A Reaction discount really is a cost reduction; it simply is not an
    // `EffectDefinition`, because it is derived from the board rather than
    // applied once. The prose is honest, so the linter should be too.
    if (ability.effect.type === 'reaction_discount') types.push('modify_cost');
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
  visit([card.effects, card.abilities, card.activatedAbilities, card.staticAbilities]);
  return found;
}

/** Keywords the card has printed, grants once, or grants continuously. */
function keywordsInPlay(card: CardDefinition, effects: readonly EffectDefinition[]): Set<string> {
  const keywords = new Set<string>(card.keywords);
  for (const effect of effects) {
    if (effect.type === 'grant_keyword') keywords.add(effect.keyword);
  }
  for (const ability of card.staticAbilities) {
    if (ability.effect.type === 'grant_keyword') keywords.add(ability.effect.keyword);
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

  // Keywords live in structured data; repeating their reminder text in prose
  // without granting the keyword is the other common drift.
  const granted = keywordsInPlay(card, effects);
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
  }

  return issues;
}
