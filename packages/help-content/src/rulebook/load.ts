import { KEYWORD_LIST, type KeywordDefinition } from '@tcg/card-data';
import { GLOSSARY_ENTRIES, type GlossaryEntry } from '../glossary.js';
import {
  DEFAULT_HELP_CONFIG,
  PHASE_DESCRIPTIONS,
  PHASE_NAMES,
  TURN_PHASES,
  resolveReferences,
  resolveTemplate,
  type HelpConfig,
} from '../references.js';
import rulebookData from '../data/rulebook.json' with { type: 'json' };
import { rulebookSchema, type Rulebook, type RulebookBlock } from './schema.js';

/**
 * Turns rulebook content into something a renderer can walk without knowing
 * anything about configuration, keywords or the glossary.
 *
 * Every reference is resolved here, once, against the configuration that was
 * passed in. A component never reaches back into the rules engine for a number,
 * so the rulebook and the match it describes cannot disagree.
 */

export interface ResolvedPhase {
  readonly id: string;
  readonly name: string;
  readonly description: string;
}

export type ResolvedBlock =
  | { readonly type: 'heading'; readonly text: string }
  | { readonly type: 'paragraph'; readonly text: string }
  | { readonly type: 'bulletList'; readonly items: readonly string[] }
  | { readonly type: 'numberedList'; readonly items: readonly string[] }
  | {
      readonly type: 'callout';
      readonly tone: 'info' | 'warning' | 'unresolved';
      readonly title: string | null;
      readonly text: string;
    }
  | { readonly type: 'example'; readonly title: string; readonly steps: readonly string[] }
  | { readonly type: 'configValue'; readonly label: string; readonly value: string }
  | { readonly type: 'phaseList'; readonly phases: readonly ResolvedPhase[] }
  | { readonly type: 'keywordIndex'; readonly keywords: readonly ResolvedKeyword[] }
  | { readonly type: 'glossaryIndex'; readonly entries: readonly GlossaryEntry[] };

/** A keyword with its configuration references already substituted. */
export interface ResolvedKeyword extends Omit<KeywordDefinition, never> {
  readonly shortDefinition: string;
  readonly fullDefinition: string;
}

export interface ResolvedSection {
  readonly id: string;
  readonly title: string;
  readonly blocks: readonly ResolvedBlock[];
  /** Everything in the section as one lowercase string, for search. */
  readonly searchText: string;
}

export interface ResolvedRulebook {
  readonly title: string;
  readonly intro: string;
  readonly sections: readonly ResolvedSection[];
}

/** The raw, validated rulebook content, before any reference is resolved. */
export const RULEBOOK: Rulebook = rulebookSchema.parse(rulebookData);

/** Keyword definitions with live values substituted into their text. */
export function resolvedKeywords(
  config: HelpConfig = DEFAULT_HELP_CONFIG,
): readonly ResolvedKeyword[] {
  return KEYWORD_LIST.map((keyword) => ({
    ...keyword,
    shortDefinition: resolveTemplate(keyword.shortDefinition, config),
    fullDefinition: resolveTemplate(keyword.fullDefinition, config),
  }));
}

/** Glossary entries with live values substituted into their definitions. */
export function resolvedGlossary(
  config: HelpConfig = DEFAULT_HELP_CONFIG,
): readonly GlossaryEntry[] {
  return GLOSSARY_ENTRIES.map((entry) => ({
    ...entry,
    definition: resolveTemplate(entry.definition, config),
  }));
}

function resolveBlock(block: RulebookBlock, config: HelpConfig): ResolvedBlock {
  const text = (value: string): string => resolveTemplate(value, config);

  switch (block.type) {
    case 'heading':
      return { type: 'heading', text: text(block.text) };
    case 'paragraph':
      return { type: 'paragraph', text: text(block.text) };
    case 'bulletList':
      return { type: 'bulletList', items: block.items.map(text) };
    case 'numberedList':
      return { type: 'numberedList', items: block.items.map(text) };
    case 'callout':
      return {
        type: 'callout',
        tone: block.tone,
        title: block.title === undefined ? null : text(block.title),
        text: text(block.text),
      };
    case 'example':
      return { type: 'example', title: text(block.title), steps: block.steps.map(text) };
    case 'configValue': {
      const resolved = resolveReferences(config).get(block.source);
      // Unknown references are rejected by content validation; if one still
      // reaches here it renders as the reference name rather than as a
      // confident wrong number.
      const value = resolved ? resolved.display : `{${block.source}}`;
      return {
        type: 'configValue',
        label: text(block.label),
        value: block.suffix === undefined ? value : `${value} ${text(block.suffix)}`,
      };
    }
    case 'phaseList':
      return {
        type: 'phaseList',
        phases: TURN_PHASES.map((phase) => ({
          id: phase,
          name: PHASE_NAMES[phase] ?? phase,
          description: PHASE_DESCRIPTIONS[phase] ?? '',
        })),
      };
    case 'keywordIndex':
      return { type: 'keywordIndex', keywords: resolvedKeywords(config) };
    case 'glossaryIndex':
      return { type: 'glossaryIndex', entries: resolvedGlossary(config) };
  }
}

/** Everything in a block that a search should be able to match. */
function blockText(block: ResolvedBlock): string {
  switch (block.type) {
    case 'heading':
    case 'paragraph':
      return block.text;
    case 'bulletList':
    case 'numberedList':
      return block.items.join(' ');
    case 'callout':
      return [block.title, block.text].filter(Boolean).join(' ');
    case 'example':
      return [block.title, ...block.steps].join(' ');
    case 'configValue':
      return `${block.label} ${block.value}`;
    case 'phaseList':
      return block.phases.map((phase) => `${phase.name} ${phase.description}`).join(' ');
    case 'keywordIndex':
      return block.keywords
        .map((keyword) => `${keyword.name} ${keyword.shortDefinition} ${keyword.fullDefinition}`)
        .join(' ');
    case 'glossaryIndex':
      return block.entries.map((entry) => `${entry.term} ${entry.definition}`).join(' ');
  }
}

export function loadRulebook(config: HelpConfig = DEFAULT_HELP_CONFIG): ResolvedRulebook {
  const sections = [...RULEBOOK.sections]
    .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
    .map((section): ResolvedSection => {
      const blocks = section.blocks.map((block) => resolveBlock(block, config));
      return {
        id: section.id,
        title: section.title,
        blocks,
        searchText: [section.title, ...section.searchTerms, ...blocks.map(blockText)]
          .join(' ')
          .toLowerCase(),
      };
    });

  return {
    title: RULEBOOK.title,
    intro: resolveTemplate(RULEBOOK.intro, config),
    sections,
  };
}

/** Every section ID that exists, for validating cross-references. */
export const RULEBOOK_SECTION_IDS: readonly string[] = RULEBOOK.sections.map(
  (section) => section.id,
);
