/**
 * Player help and content: the rulebook, the shared registries, and the one
 * service that turns structured card data into plain language.
 *
 * Everything here is presentation. It reads validated game data and renders it;
 * it never decides a rule, and nothing in the engine, server or simulator
 * depends on it.
 */

export {
  DEFAULT_HELP_CONFIG,
  PHASE_DESCRIPTIONS,
  PHASE_NAMES,
  TURN_PHASES,
  knownReferences,
  resolveReferences,
  resolveTemplate,
  templateReferences,
  type HelpConfig,
  type ReferenceValue,
  type ResolvedReference,
} from './references.js';

export {
  EFFECT_CATEGORIES,
  EFFECT_LIST,
  EFFECT_REGISTRY,
  type EffectCategory,
  type EffectTypeInfo,
} from './registries/effects.js';

export {
  DEPLOY_TRIGGER,
  TRIGGER_LIST,
  TRIGGER_REGISTRY,
  type TriggerInfo,
} from './registries/triggers.js';

export {
  GLOSSARY,
  GLOSSARY_ENTRIES,
  GLOSSARY_SCHEMA_VERSION,
  glossaryEntry,
  glossaryEntrySchema,
  glossarySchema,
  type Glossary,
  type GlossaryEntry,
} from './glossary.js';

export {
  explainCard,
  type CardExplanation,
  type ExplainCardOptions,
  type ExplanationSection,
  type ExplanationSectionKind,
  type ExplanationStep,
} from './explain/card.js';

export {
  explainEffect,
  RENDERED_EFFECT_TYPES,
  type EffectExplanation,
  type ExplainOptions,
} from './explain/effects.js';

export {
  describePlayerSelector,
  describeSelector,
  describeTarget,
  zoneName,
} from './explain/selectors.js';

export {
  RULEBOOK,
  RULEBOOK_SECTION_IDS,
  loadRulebook,
  resolvedGlossary,
  resolvedKeywords,
  type ResolvedBlock,
  type ResolvedKeyword,
  type ResolvedPhase,
  type ResolvedRulebook,
  type ResolvedSection,
} from './rulebook/load.js';

export {
  RULEBOOK_SCHEMA_VERSION,
  rulebookBlockSchema,
  rulebookSchema,
  rulebookSectionSchema,
  type Rulebook,
  type RulebookBlock,
  type RulebookBlockType,
  type RulebookSection,
} from './rulebook/schema.js';

export { searchRulebook, type SearchResult } from './rulebook/search.js';

export { contextMessages, publicCardContext, type PublicCardContext } from './context.js';

export { validateContent, type ContentReport, type ValidateContentOptions } from './validate.js';
