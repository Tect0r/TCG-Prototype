import type { ResolvedRulebook, ResolvedSection } from './load.js';

/**
 * Rulebook search.
 *
 * A plain substring scan over pre-flattened section text, ranked by where the
 * match landed. The rulebook is a few thousand words: an index would be more
 * machinery than the problem deserves, and this stays exact and predictable —
 * a player searching "venom" gets the keyword section, not a fuzzy guess.
 */

export interface SearchResult {
  readonly sectionId: string;
  readonly title: string;
  /** A window of text around the match, for showing under the result. */
  readonly snippet: string;
  /** Higher is better. Title matches outrank body matches. */
  readonly score: number;
}

const SNIPPET_RADIUS = 60;

function snippetAround(section: ResolvedSection, index: number): string {
  const text = section.searchText;
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + SNIPPET_RADIUS);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < text.length ? '…' : '';
  return `${prefix}${text.slice(start, end).trim()}${suffix}`;
}

export function searchRulebook(rulebook: ResolvedRulebook, query: string): readonly SearchResult[] {
  const needle = query.trim().toLowerCase();
  if (needle.length < 2) return [];

  const results: SearchResult[] = [];
  for (const section of rulebook.sections) {
    const inTitle = section.title.toLowerCase().includes(needle);
    const index = section.searchText.indexOf(needle);
    if (!inTitle && index === -1) continue;

    // Every occurrence adds a little, so the section that really is about the
    // term beats one that mentions it once in passing.
    const occurrences = section.searchText.split(needle).length - 1;
    results.push({
      sectionId: section.id,
      title: section.title,
      snippet: index === -1 ? '' : snippetAround(section, index),
      score: (inTitle ? 100 : 0) + occurrences,
    });
  }

  return results.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}
