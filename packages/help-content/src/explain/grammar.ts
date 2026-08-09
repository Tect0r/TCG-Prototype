/**
 * Small, deterministic English helpers for generated rules text.
 *
 * Deliberately dumb: a fixed number-word table and explicit plural forms rather
 * than any inflection library. Generated text must be identical on every run
 * and reviewable by eye, and card amounts are bounded by the schema.
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

/** Small numbers read better as words; large ones as digits. */
export function numberWord(value: number): string {
  const word = NUMBER_WORDS[value];
  return word ?? String(value);
}

export function plural(count: number, singular: string, pluralForm?: string): string {
  return count === 1 ? singular : (pluralForm ?? `${singular}s`);
}

/** "one card" / "three cards" / "all cards". */
export function quantify(count: number | 'all', singular: string, pluralForm?: string): string {
  if (count === 'all') return `all ${pluralForm ?? `${singular}s`}`;
  return `${numberWord(count)} ${plural(count, singular, pluralForm)}`;
}

export function capitalise(text: string): string {
  return text.length === 0 ? text : text[0]!.toUpperCase() + text.slice(1);
}

/** Ends a clause with a full stop, without doubling existing punctuation. */
export function sentence(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length === 0) return trimmed;
  return /[.!?]$/.test(trimmed) ? capitalise(trimmed) : `${capitalise(trimmed)}.`;
}

/** "a, b and c" — the Oxford comma is omitted deliberately for readability. */
export function list(parts: readonly string[], conjunction = 'and'): string {
  if (parts.length === 0) return '';
  if (parts.length === 1) return parts[0]!;
  return `${parts.slice(0, -1).join(', ')} ${conjunction} ${parts[parts.length - 1]!}`;
}

export function article(word: string): string {
  return /^[aeiou]/i.test(word) ? 'an' : 'a';
}

/** Turns a snake_case identifier into readable words. */
export function humanise(id: string): string {
  return id.replace(/_/g, ' ');
}
