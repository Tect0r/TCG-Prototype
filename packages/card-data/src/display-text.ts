import { warning, type Issue } from '@tcg/shared';
import type { CardDefinition } from './schema/card.js';
import type { EffectDefinition, EffectType } from './schema/effect.js';
import { KEYWORD_INFO } from './vocabulary.js';

/**
 * `displayText` is presentation only. It is never executed and never parsed to
 * determine behaviour — but obvious drift between prose and structured effects
 * is a common authoring bug, so we lint for it and surface warnings.
 *
 * The check is deliberately one-directional and conservative: prose that
 * clearly names a mechanic must have a matching effect. Extra effects are not
 * flagged, because plenty of behaviour reads naturally without a keyword.
 */
const PROSE_MARKERS: ReadonlyArray<{ readonly pattern: RegExp; readonly effects: readonly EffectType[] }> = [
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
  return [...card.effects, ...card.abilities.flatMap((ability) => ability.effects)];
}

/** Warnings only — never blocks loading. */
export function lintDisplayText(card: CardDefinition): Issue[] {
  const issues: Issue[] = [];
  const effects = collectEffects(card);
  const effectTypes = new Set(effects.map((effect) => effect.type));
  const text = card.displayText;

  if (text === undefined) {
    if (effects.length > 0) {
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
  for (const info of Object.values(KEYWORD_INFO)) {
    const named = new RegExp(`\\b${info.name}\\b`, 'i').test(text);
    if (named && !card.keywords.includes(info.id) && !effectTypes.has('grant_keyword')) {
      issues.push(
        warning(
          'display_text/keyword_mismatch',
          `"${card.name}" mentions ${info.name} but does not have or grant that keyword.`,
          { path: 'displayText', context: { cardId: card.id, keyword: info.id } },
        ),
      );
    }
  }

  return issues;
}
