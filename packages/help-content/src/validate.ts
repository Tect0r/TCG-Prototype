import {
  CARD_ID_PATTERN,
  EFFECT_TYPES,
  KEYWORD_LIST,
  keywordDefinitionSchema,
  type CardDatabase,
  type CardDefinition,
  type EffectDefinition,
} from '@tcg/card-data';
import { DECKABLE_CARD_TYPES } from '@tcg/card-data';
import { error, warning, type Issue } from '@tcg/shared';
import { explainCard } from './explain/card.js';
import { RENDERED_EFFECT_TYPES } from './explain/effects.js';
import { GLOSSARY, glossarySchema } from './glossary.js';
import { EFFECT_REGISTRY } from './registries/effects.js';
import { TRIGGER_REGISTRY } from './registries/triggers.js';
import {
  DEFAULT_HELP_CONFIG,
  knownReferences,
  templateReferences,
  type HelpConfig,
} from './references.js';
import { RULEBOOK, RULEBOOK_SECTION_IDS, loadRulebook } from './rulebook/load.js';
import { rulebookSchema } from './rulebook/schema.js';

/**
 * One command that answers "is the content I just wrote coherent?".
 *
 * It goes further than schema parsing: schemas prove a card is well-formed,
 * this proves the card, the registries and the rulebook agree with each other.
 * The rule it enforces above all others is that no executable behaviour may
 * exist that the help system cannot describe — an effect with no renderer is a
 * hard error, because the alternative is a player being shown a vague sentence
 * that quietly omits what a card really does.
 */

export interface ValidateContentOptions {
  readonly database: CardDatabase;
  readonly config?: HelpConfig;
  /**
   * Filenames present in the artwork directory, e.g. `["goblin_scout.png"]`.
   * Omitted when the caller has no filesystem. Missing artwork is never an
   * error — there is a documented fallback — but a misnamed file is.
   */
  readonly artworkFiles?: readonly string[];
}

export interface ContentReport {
  readonly issues: readonly Issue[];
  readonly errors: readonly Issue[];
  readonly warnings: readonly Issue[];
  readonly ok: boolean;
  readonly counts: {
    readonly cards: number;
    readonly keywords: number;
    readonly glossaryEntries: number;
    readonly rulebookSections: number;
    readonly effectTypes: number;
  };
}

/** Every effect a card can ever resolve, with a path describing where it lives. */
function locatedEffects(
  card: CardDefinition,
): readonly { readonly effect: EffectDefinition; readonly path: string }[] {
  const located: { effect: EffectDefinition; path: string }[] = [];
  card.effects.forEach((effect, index) => located.push({ effect, path: `effects[${index}]` }));
  for (const ability of card.abilities) {
    ability.effects.forEach((effect, index) =>
      located.push({ effect, path: `abilities.${ability.id}.effects[${index}]` }),
    );
  }
  for (const ability of card.activatedAbilities) {
    ability.effects.forEach((effect, index) =>
      located.push({ effect, path: `activatedAbilities.${ability.id}.effects[${index}]` }),
    );
  }
  // A delayed body resolves later, but it resolves — so it is subject to every
  // check the other lists get, including "this effect type has no renderer".
  for (const ability of card.delayedAbilities) {
    ability.effects.forEach((effect, index) =>
      located.push({ effect, path: `delayedAbilities.${ability.id}.effects[${index}]` }),
    );
  }
  return located;
}

/** Reference tokens in curated card text must resolve, exactly like rulebook text. */
function checkTemplate(
  text: string,
  known: ReadonlySet<string>,
  path: string,
  context: Record<string, string>,
): Issue[] {
  return templateReferences(text)
    .filter((reference) => !known.has(reference))
    .map((reference) =>
      error(
        'content/unknown_reference',
        `${path} — unknown configuration reference "{${reference}}". Allowed references come from the shared match and deck configuration.`,
        { path, context: { ...context, reference } },
      ),
    );
}

function validateRegistries(known: ReadonlySet<string>): Issue[] {
  const issues: Issue[] = [];

  // Every effect the engine can execute must be documented and renderable.
  for (const type of EFFECT_TYPES) {
    if (!RENDERED_EFFECT_TYPES.includes(type)) {
      issues.push(
        error(
          'content/missing_effect_renderer',
          `Effect type "${type}" has no explanation renderer. Add one in help-content/src/explain/effects.ts before shipping a card that uses it.`,
          { path: `effectRegistry.${type}`, context: { effectType: type } },
        ),
      );
    }
    if (EFFECT_REGISTRY[type] === undefined) {
      issues.push(
        error(
          'content/missing_effect_metadata',
          `Effect type "${type}" is missing from the effect registry.`,
          { path: `effectRegistry.${type}`, context: { effectType: type } },
        ),
      );
    }
  }

  const seenKeywordIds = new Set<string>();
  for (const keyword of KEYWORD_LIST) {
    const parsed = keywordDefinitionSchema.safeParse(keyword);
    if (!parsed.success) {
      for (const problem of parsed.error.issues) {
        issues.push(
          error('content/keyword_schema', `Keyword "${keyword.id}" — ${problem.message}`, {
            path: `keywords.${keyword.id}.${problem.path.join('.')}`,
          }),
        );
      }
    }
    if (seenKeywordIds.has(keyword.id)) {
      issues.push(
        error('content/duplicate_keyword_id', `Keyword ID "${keyword.id}" is defined twice.`, {
          path: `keywords.${keyword.id}`,
        }),
      );
    }
    seenKeywordIds.add(keyword.id);

    for (const field of ['shortDefinition', 'fullDefinition'] as const) {
      issues.push(
        ...checkTemplate(keyword[field], known, `keywords.${keyword.id}.${field}`, {
          keyword: keyword.id,
        }),
      );
    }
    for (const sectionId of keyword.relatedRuleSections) {
      if (!RULEBOOK_SECTION_IDS.includes(sectionId)) {
        issues.push(
          error(
            'content/unknown_section',
            `Keyword "${keyword.id}" links to rulebook section "${sectionId}", which does not exist.`,
            { path: `keywords.${keyword.id}.relatedRuleSections`, context: { sectionId } },
          ),
        );
      }
    }
  }

  for (const [trigger, info] of Object.entries(TRIGGER_REGISTRY)) {
    if (info.clause.trim().length === 0 || info.description.trim().length === 0) {
      issues.push(
        error(
          'content/incomplete_trigger_metadata',
          `Trigger "${trigger}" is missing its clause or description.`,
          { path: `triggerRegistry.${trigger}` },
        ),
      );
    }
  }

  return issues;
}

function validateGlossary(known: ReadonlySet<string>): Issue[] {
  const issues: Issue[] = [];
  const parsed = glossarySchema.safeParse(GLOSSARY);
  if (!parsed.success) {
    for (const problem of parsed.error.issues) {
      issues.push(
        error('content/glossary_schema', problem.message, {
          path: `glossary.${problem.path.join('.')}`,
        }),
      );
    }
    return issues;
  }

  const ids = new Set<string>();
  for (const entry of GLOSSARY.entries) {
    if (ids.has(entry.id)) {
      issues.push(
        error('content/duplicate_glossary_id', `Glossary ID "${entry.id}" is defined twice.`, {
          path: `glossary.${entry.id}`,
        }),
      );
    }
    ids.add(entry.id);
    issues.push(
      ...checkTemplate(entry.definition, known, `glossary.${entry.id}.definition`, {
        glossaryId: entry.id,
      }),
    );
  }

  for (const entry of GLOSSARY.entries) {
    for (const other of entry.seeAlso) {
      if (!ids.has(other)) {
        issues.push(
          error(
            'content/unknown_glossary_link',
            `Glossary entry "${entry.id}" links to "${other}", which does not exist.`,
            { path: `glossary.${entry.id}.seeAlso`, context: { target: other } },
          ),
        );
      }
    }
    for (const sectionId of entry.relatedRuleSections) {
      if (!RULEBOOK_SECTION_IDS.includes(sectionId)) {
        issues.push(
          error(
            'content/unknown_section',
            `Glossary entry "${entry.id}" links to rulebook section "${sectionId}", which does not exist.`,
            { path: `glossary.${entry.id}.relatedRuleSections`, context: { sectionId } },
          ),
        );
      }
    }
  }

  return issues;
}

/** Sections the rulebook must contain for the book to be usable at all. */
const REQUIRED_SECTIONS: readonly string[] = [
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
  // M09.18. A player can put an AI opponent in any free seat, and the book has
  // to be able to answer what that opponent can see, how it is configured and
  // what the timing dial does — none of which any other section covers, and all
  // of which a player will otherwise guess at.
  'ai_opponents',
  'choices_and_targets',
  'keywords',
  'glossary',
  'example_first_turn',
  'edge_cases',
];

function validateRulebook(known: ReadonlySet<string>, config: HelpConfig): Issue[] {
  const issues: Issue[] = [];

  const parsed = rulebookSchema.safeParse(RULEBOOK);
  if (!parsed.success) {
    for (const problem of parsed.error.issues) {
      issues.push(
        error('content/rulebook_schema', problem.message, {
          path: `rulebook.${problem.path.join('.')}`,
        }),
      );
    }
    return issues;
  }

  const ids = new Set<string>();
  const orders = new Map<number, string>();
  for (const section of RULEBOOK.sections) {
    const path = `rulebook.sections.${section.id}`;
    if (ids.has(section.id)) {
      issues.push(
        error('content/duplicate_section_id', `Rulebook section "${section.id}" appears twice.`, {
          path,
        }),
      );
    }
    ids.add(section.id);

    const clash = orders.get(section.order);
    if (clash !== undefined) {
      issues.push(
        error(
          'content/ambiguous_section_order',
          `Rulebook sections "${clash}" and "${section.id}" both have order ${section.order}, so their order on screen is not defined by the content.`,
          { path: `${path}.order`, context: { order: section.order } },
        ),
      );
    }
    orders.set(section.order, section.id);

    for (const [index, block] of section.blocks.entries()) {
      const blockPath = `${path}.blocks[${index}]`;

      if (block.type === 'configValue' && !known.has(block.source)) {
        issues.push(
          error(
            'content/unknown_reference',
            `${blockPath}.source — "${block.source}" is not an allow-listed configuration reference.`,
            { path: `${blockPath}.source`, context: { reference: block.source } },
          ),
        );
      }

      const texts: string[] = [];
      if ('text' in block && typeof block.text === 'string') texts.push(block.text);
      if ('title' in block && typeof block.title === 'string') texts.push(block.title);
      if ('label' in block && typeof block.label === 'string') texts.push(block.label);
      if ('items' in block) texts.push(...block.items);
      if ('steps' in block) texts.push(...block.steps);
      for (const text of texts) {
        issues.push(...checkTemplate(text, known, blockPath, { sectionId: section.id }));
      }
    }
  }

  for (const required of REQUIRED_SECTIONS) {
    if (!ids.has(required)) {
      issues.push(
        error(
          'content/missing_required_section',
          `The rulebook is missing the required section "${required}".`,
          { path: 'rulebook.sections', context: { sectionId: required } },
        ),
      );
    }
  }

  // Resolving the whole book proves every block type has a resolver and that
  // nothing throws on real content.
  const resolved = loadRulebook(config);
  for (const section of resolved.sections) {
    if (section.blocks.length === 0) {
      issues.push(
        warning('content/empty_section', `Rulebook section "${section.id}" renders nothing.`, {
          path: `rulebook.sections.${section.id}`,
        }),
      );
    }
  }

  return issues;
}

function validateCards(options: ValidateContentOptions, known: ReadonlySet<string>): Issue[] {
  const issues: Issue[] = [];
  const cards = options.database.all();
  const seen = new Set<string>();

  for (const card of cards) {
    const where = `cards/${card.id}.json`;

    if (!CARD_ID_PATTERN.test(card.id)) {
      issues.push(
        error(
          'content/invalid_card_id',
          `${where}: id — "${card.id}" is not lowercase_snake_case. Card IDs are permanent and must match ${CARD_ID_PATTERN.source}.`,
          { path: `${where}: id`, context: { cardId: card.id } },
        ),
      );
    }
    if (seen.has(card.id)) {
      issues.push(
        error('content/duplicate_card_id', `${where}: id — "${card.id}" is defined twice.`, {
          path: `${where}: id`,
          context: { cardId: card.id },
        }),
      );
    }
    seen.add(card.id);

    for (const { effect, path } of locatedEffects(card)) {
      if (!RENDERED_EFFECT_TYPES.includes(effect.type)) {
        issues.push(
          error(
            'content/missing_effect_renderer',
            `${where}: ${path}.type — "${effect.type}" has no explanation renderer, so this card cannot be explained to a player.`,
            {
              path: `${where}: ${path}.type`,
              context: { cardId: card.id, effectType: effect.type },
            },
          ),
        );
      }
    }

    // Curated text must reference only things that resolve, and must not have
    // been left behind by an edit to the card's effects.
    const text = card.text;
    if (text) {
      for (const [field, value] of [
        ['summary', text.summary],
        ['flavor', text.flavor],
      ] as const) {
        if (value !== undefined) {
          issues.push(
            ...checkTemplate(value, known, `${where}: text.${field}`, { cardId: card.id }),
          );
        }
      }
      (text.notes ?? []).forEach((note, index) => {
        issues.push(
          ...checkTemplate(note, known, `${where}: text.notes[${index}]`, { cardId: card.id }),
        );
      });
      (text.effectExplanations ?? []).forEach((explanation, index) => {
        issues.push(
          ...checkTemplate(explanation, known, `${where}: text.effectExplanations[${index}]`, {
            cardId: card.id,
          }),
        );
        if (index >= card.effects.length) {
          issues.push(
            error(
              'content/stale_effect_explanation',
              `${where}: text.effectExplanations[${index}] — the card has only ${card.effects.length} effect(s), so this clarification describes a step that no longer exists.`,
              { path: `${where}: text.effectExplanations[${index}]`, context: { cardId: card.id } },
            ),
          );
        }
      });
    }

    // Generating the explanation is the real test: it exercises every renderer
    // against real data and proves nothing comes out blank.
    let explanation;
    try {
      explanation = explainCard(card, { database: options.database, config: options.config });
    } catch (cause) {
      issues.push(
        error(
          'content/explanation_failed',
          `${where}: generating an explanation threw — ${cause instanceof Error ? cause.message : String(cause)}`,
          { path: where, context: { cardId: card.id } },
        ),
      );
      continue;
    }

    if (explanation.summary.trim().length === 0) {
      issues.push(
        error('content/empty_explanation', `${where}: produced an empty summary.`, {
          path: where,
          context: { cardId: card.id },
        }),
      );
    }
    for (const section of explanation.sections) {
      for (const [index, step] of section.steps.entries()) {
        if (step.text.trim().length === 0) {
          issues.push(
            error(
              'content/empty_explanation',
              `${where}: ${section.id} step ${index} produced no text.`,
              { path: `${where}: ${section.id}`, context: { cardId: card.id } },
            ),
          );
        }
      }
    }

    const executable =
      card.effects.length +
      card.abilities.length +
      card.activatedAbilities.length +
      card.staticAbilities.length;
    if (executable > 0 && explanation.sections.length === 0) {
      issues.push(
        error(
          'content/unexplained_behaviour',
          `${where}: the card has executable behaviour but produced no explanation sections.`,
          { path: where, context: { cardId: card.id } },
        ),
      );
    }

    // A keyword the engine ignores is legal to print, but an author should know.
    for (const keyword of card.keywords) {
      const definition = KEYWORD_LIST.find((entry) => entry.id === keyword);
      if (definition && !definition.implemented) {
        issues.push(
          warning(
            'content/inert_keyword',
            `${where}: keywords — "${definition.name}" is printed on this card but the rules engine gives it no effect yet.`,
            { path: `${where}: keywords`, context: { cardId: card.id, keyword } },
          ),
        );
      }
    }

    // Deck legality: a collectible card a player could never put in a deck is
    // almost always an authoring mistake rather than a deliberate choice.
    if (card.collectible && !DECKABLE_CARD_TYPES.includes(card.type) && card.type !== 'commander') {
      issues.push(
        error(
          'content/undeckable_collectible',
          `${where}: type — a collectible card must be a type a deck can contain (${DECKABLE_CARD_TYPES.join(', ')}) or a commander.`,
          { path: `${where}: type`, context: { cardId: card.id, cardType: card.type } },
        ),
      );
    }
  }

  if (options.artworkFiles) {
    const cardIds = new Set(cards.map((card) => card.id));
    for (const file of options.artworkFiles) {
      const match = /^(.+)\.png$/.exec(file);
      if (!match) {
        issues.push(
          warning(
            'content/unexpected_artwork_file',
            `assets/card-art/${file} is not a .png and will never be used. Artwork is looked up as <card_id>.png.`,
            { path: `assets/card-art/${file}` },
          ),
        );
        continue;
      }
      const id = match[1] as string;
      if (!CARD_ID_PATTERN.test(id)) {
        issues.push(
          error(
            'content/invalid_artwork_name',
            `assets/card-art/${file} — artwork filenames must be a card ID in lowercase_snake_case followed by .png.`,
            { path: `assets/card-art/${file}` },
          ),
        );
      } else if (!cardIds.has(id)) {
        issues.push(
          warning(
            'content/orphan_artwork',
            `assets/card-art/${file} does not match any card ID, so it will never be shown.`,
            { path: `assets/card-art/${file}`, context: { cardId: id } },
          ),
        );
      }
    }
  }

  return issues;
}

export function validateContent(options: ValidateContentOptions): ContentReport {
  const config = options.config ?? DEFAULT_HELP_CONFIG;
  const known = new Set(knownReferences(config));

  const issues: Issue[] = [
    ...validateRegistries(known),
    ...validateGlossary(known),
    ...validateRulebook(known, config),
    ...validateCards({ ...options, config }, known),
  ];

  const errors = issues.filter((issue) => issue.severity === 'error');
  const warnings = issues.filter((issue) => issue.severity === 'warning');

  return {
    issues,
    errors,
    warnings,
    ok: errors.length === 0,
    counts: {
      cards: options.database.size,
      keywords: KEYWORD_LIST.length,
      glossaryEntries: GLOSSARY.entries.length,
      rulebookSections: RULEBOOK.sections.length,
      effectTypes: EFFECT_TYPES.length,
    },
  };
}
