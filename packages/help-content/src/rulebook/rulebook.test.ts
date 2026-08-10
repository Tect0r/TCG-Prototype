import { describe, expect, it } from 'vitest';
import { KEYWORD_LIST } from '@tcg/card-data';
import { DEFAULT_RULES_CONFIG } from '@tcg/rules-engine';
import { GLOSSARY } from '../glossary.js';
import { DEFAULT_HELP_CONFIG, type HelpConfig } from '../references.js';
import { RULEBOOK_SECTION_IDS, loadRulebook } from './load.js';
import { searchRulebook } from './search.js';

const rulebook = loadRulebook();

/** Every text fragment a section renders, flattened. */
function textOf(sectionId: string): string {
  const section = rulebook.sections.find((entry) => entry.id === sectionId);
  if (!section) throw new Error(`No section "${sectionId}"`);
  return section.searchText;
}

describe('rulebook content', () => {
  it('contains every section the game needs explained', () => {
    const required = [
      'objective',
      'setup',
      'deck_building',
      'card_anatomy',
      'card_types',
      'energy',
      'turn_structure',
      'playing_cards',
      'combat',
      'damage_and_defeat',
      'commander',
      'multiplayer',
      'choices_and_targets',
      'keywords',
      'glossary',
      'example_first_turn',
      'edge_cases',
    ];
    for (const id of required) {
      expect(RULEBOOK_SECTION_IDS, id).toContain(id);
    }
  });

  it('renders sections in a defined order', () => {
    const ids = rulebook.sections.map((section) => section.id);
    expect(ids[0]).toBe('objective');
    expect(ids[ids.length - 1]).toBe('edge_cases');
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('leaves no unresolved reference anywhere in the book', () => {
    for (const section of rulebook.sections) {
      expect(section.searchText, section.id).not.toMatch(/\{[a-zA-Z]/);
    }
    expect(rulebook.intro).not.toMatch(/\{[a-zA-Z]/);
  });

  it('shows live configuration values, not copied numbers', () => {
    const objective = rulebook.sections.find((section) => section.id === 'objective');
    const starting = objective?.blocks.find(
      (block) => block.type === 'configValue' && block.label === 'Starting health',
    );
    expect(starting).toMatchObject({ value: String(DEFAULT_RULES_CONFIG.startingHealth) });
  });

  it('follows a changed configuration everywhere it is quoted', () => {
    const houseRules: HelpConfig = {
      ...DEFAULT_HELP_CONFIG,
      matchConfig: { ...DEFAULT_HELP_CONFIG.matchConfig, startingHealth: 45, relicSlots: 9 },
      deckRules: { ...DEFAULT_HELP_CONFIG.deckRules, deckSize: 60 },
    };
    const modified = loadRulebook(houseRules);

    const objective = modified.sections.find((section) => section.id === 'objective');
    expect(
      objective?.blocks.find((block) => block.type === 'configValue' && block.value === '45'),
    ).toBeDefined();

    const deckBuilding = modified.sections.find((section) => section.id === 'deck_building');
    expect(deckBuilding?.searchText).toContain('60');

    // The glossary quotes the relic limit in prose, through the same reference
    // mechanism. (It used to quote the unit-slot count; there are no slots to
    // quote now — ruleset update §7.)
    const glossary = modified.sections.find((section) => section.id === 'glossary');
    expect(glossary?.searchText).toContain('control up to 9');
  });

  it('builds the keyword index from the shared registry', () => {
    const section = rulebook.sections.find((entry) => entry.id === 'keywords');
    const index = section?.blocks.find((block) => block.type === 'keywordIndex');
    expect(index).toBeDefined();
    if (index?.type !== 'keywordIndex') throw new Error('expected a keyword index');

    expect(index.keywords.map((keyword) => keyword.id)).toEqual(
      KEYWORD_LIST.map((keyword) => keyword.id),
    );
    // Armored quotes a configured number, resolved from the live config.
    const armored = index.keywords.find((keyword) => keyword.id === 'armored');
    expect(armored?.shortDefinition).toContain(String(DEFAULT_RULES_CONFIG.armoredReduction));
    expect(armored?.shortDefinition).not.toMatch(/\{/);
  });

  it('tells players plainly which keywords do nothing yet', () => {
    const section = rulebook.sections.find((entry) => entry.id === 'keywords');
    const index = section?.blocks.find((block) => block.type === 'keywordIndex');
    if (index?.type !== 'keywordIndex') throw new Error('expected a keyword index');

    for (const keyword of index.keywords.filter((entry) => !entry.implemented)) {
      expect(keyword.shortDefinition, keyword.id).toMatch(/not implemented|no effect/i);
    }
  });

  it('builds the glossary index from the shared glossary', () => {
    const section = rulebook.sections.find((entry) => entry.id === 'glossary');
    const index = section?.blocks.find((block) => block.type === 'glossaryIndex');
    if (index?.type !== 'glossaryIndex') throw new Error('expected a glossary index');
    expect(index.entries.length).toBe(GLOSSARY.entries.length);
  });

  it('lists the turn phases from the engine state machine', () => {
    const section = rulebook.sections.find((entry) => entry.id === 'turn_structure');
    const index = section?.blocks.find((block) => block.type === 'phaseList');
    if (index?.type !== 'phaseList') throw new Error('expected a phase list');

    expect(index.phases.map((phase) => phase.id)).toEqual([
      'turn_start',
      'draw',
      'main_1',
      'declare_attackers',
      'assign_blockers',
      'resolve_combat',
      'main_2',
      'turn_end',
    ]);
    for (const phase of index.phases) {
      expect(phase.name, phase.id).not.toBe(phase.id);
      expect(phase.description.length, phase.id).toBeGreaterThan(0);
    }
  });

  it('describes only rules the engine implements', () => {
    // Commanders are never deployed, and the book says so instead of inventing
    // Commander combat.
    expect(textOf('commander')).toMatch(/never deployed|do not fight/i);
    // Blocking is restricted to the attacked player.
    expect(textOf('combat')).toMatch(/only the player being attacked/i);
  });
});

describe('rulebook search', () => {
  it('finds a section by its title', () => {
    const results = searchRulebook(rulebook, 'energy');
    expect(results[0]?.sectionId).toBe('energy');
  });

  it('finds a keyword defined only inside the keyword index', () => {
    const results = searchRulebook(rulebook, 'venom');
    expect(results.map((result) => result.sectionId)).toContain('keywords');
  });

  it('finds a glossary term', () => {
    const results = searchRulebook(rulebook, 'summoning sickness');
    expect(results.length).toBeGreaterThan(0);
  });

  it('returns a snippet with the match in it', () => {
    const [first] = searchRulebook(rulebook, 'mulligan');
    expect(first?.snippet.length ?? 0).toBeGreaterThan(0);
  });

  it('ignores queries that are too short to be useful', () => {
    expect(searchRulebook(rulebook, 'a')).toEqual([]);
    expect(searchRulebook(rulebook, '  ')).toEqual([]);
  });

  it('returns nothing rather than guessing when there is no match', () => {
    expect(searchRulebook(rulebook, 'planeswalker')).toEqual([]);
  });
});
