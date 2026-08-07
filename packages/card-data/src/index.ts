export {
  CARD_SCHEMA_VERSION,
  CARD_ID_PATTERN,
  cardIdSchema,
  COLOR_IDS,
  colorIdSchema,
  colorIdentitySchema,
  CARD_TYPES,
  cardTypeSchema,
  ROLES,
  roleSchema,
  POWER_CLASSES,
  powerClassSchema,
  KEYWORD_IDS,
  keywordIdSchema,
  tagSchema,
  ZONE_IDS,
  zoneIdSchema,
  DECKABLE_CARD_TYPES,
  type CardId,
  type ColorId,
  type CardType,
  type Role,
  type PowerClass,
  type KeywordId,
  type Tag,
  type ZoneId,
} from './schema/primitives.js';

export {
  cardFilterSchema,
  controllerSchema,
  durationSchema,
  numericRangeSchema,
  playerSelectorSchema,
  selectionModeSchema,
  targetSelectorSchema,
  targetCountSchema,
  CONTROLLERS,
  DURATIONS,
  PLAYER_SELECTORS,
  SELECTION_MODES,
  type CardFilter,
  type Controller,
  type Duration,
  type NumericRange,
  type PlayerSelector,
  type SelectionMode,
  type TargetCount,
  type TargetSelector,
} from './schema/target.js';

export {
  effectDefinitionSchema,
  abilityDefinitionSchema,
  triggerIdSchema,
  EFFECT_TYPES,
  TRIGGER_IDS,
  type AbilityDefinition,
  type EffectDefinition,
  type EffectType,
  type TriggerId,
} from './schema/effect.js';

export {
  cardDefinitionSchema,
  cardSetSchema,
  type CardDefinition,
  type CardDefinitionInput,
  type CardSet,
  type CardSetInput,
} from './schema/card.js';

export { CardDatabase } from './database.js';
export { loadCardSets, zodIssuesToIssues, type LoadedCardData } from './loader.js';
export { BUNDLED_CARD_SETS, loadBundledCardData } from './default-set.js';
export { compareCards, isColorIdentityLegal, matchesQuery, type CardQuery } from './query.js';
export {
  artworkSources,
  cardArtUrl,
  fallbackArtUrl,
  nextArtworkSource,
  CARD_ART_ASPECT_RATIO,
  CARD_ART_WIDTH_PX,
  CARD_ART_HEIGHT_PX,
  DEFAULT_ART_BASE_URL,
  DEFAULT_FALLBACK_ART_URL,
  type ArtworkResolverOptions,
} from './artwork.js';
export { lintDisplayText } from './display-text.js';
export {
  COLOR_INFO,
  COLOR_LIST,
  NEUTRAL_INFO,
  KEYWORD_INFO,
  KEYWORD_LIST,
  ROLE_NAMES,
  ROLE_LIST,
  POWER_CLASS_NAMES,
  POWER_CLASS_LIST,
  type ColorInfo,
  type KeywordInfo,
} from './vocabulary.js';
