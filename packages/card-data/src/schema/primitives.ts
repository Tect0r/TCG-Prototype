import { z } from 'zod';

/**
 * Card schema version. Bump when the card schema changes in a way that older
 * data files cannot satisfy, and add a loader migration at the same time.
 *
 * v2 (Phase 3) replaced the zone-only `TargetSelector` with a discriminated
 * `TargetDefinition`, replaced an activated ability's lone `energyCost` with a
 * structured `costs` array, and added `staticAbilities`.
 *
 * v3 (Precon Wave 1) renamed `swift` to `rush` and widened it to cover
 * `Exhaust this source` activation costs, added the `reaction` card type with
 * structured timing, and added the `barrier`, `overwhelm` and
 * `untargetable_by_opponents` keywords. `migrateCardSet` upgrades v1 and v2
 * data automatically, so older files keep loading.
 *
 * v4 (AI Spectator / rule adjustments) gave every triggered and activated
 * ability an explicit `activeZone`, and gave the `reaction` card type the
 * structured `reaction` timing block the engine keys its windows off. The zone
 * is explicit because the update forbids inferring it from the word "passive"
 * or from rules text — a Commander ability is battlefield-only unless its data
 * says otherwise. `migrateCardSet` fills both in.
 *
 * v5 (M07.9) added `entity_or_player` to the `TargetDefinition` union: one pool
 * holding both battlefield entities and players, restricted by the card schema
 * to a divided `deal_damage`.
 *
 * It is the first bump that reshapes nothing. M07.8 added the member and left
 * the version at 4 on the reasoning that an addition no old card uses cannot
 * change how an old card reads — which is true, and is not the question the
 * constant answers. `targetDefinitionSchema` is a discriminated union of strict
 * objects, so a build that understands at most v4 cannot read the new member at
 * all: it refuses `mass_offering` with "Invalid discriminator value", pointed at
 * a field, rather than with the one message this constant exists to produce.
 * Leaving both readings claiming v4 made a set's declared version stop
 * predicting whether a build could load it, which is the entire compatibility
 * boundary. Widening the target language is therefore a bump even though no
 * byte of an existing card moved.
 *
 * `migrateCardSet`'s v4 → v5 step is a version stamp and says so; there is no
 * data to reshape.
 */
export const CARD_SCHEMA_VERSION = 5;

/**
 * Permanent card identity: lowercase ASCII letters, digits and underscores.
 * Must never change after release (see CLAUDE.md §6).
 */
export const CARD_ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export const cardIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(
    CARD_ID_PATTERN,
    'Card IDs must be lowercase_english_snake_case (a-z, 0-9, _) and start with a letter.',
  );

export type CardId = z.infer<typeof cardIdSchema>;

/**
 * Provisional colour set. Placeholder identities only — no lore attached.
 * See docs/rules/open-decisions.md before renaming.
 */
export const COLOR_IDS = ['white', 'blue', 'black', 'red', 'green'] as const;
export const colorIdSchema = z.enum(COLOR_IDS);
export type ColorId = z.infer<typeof colorIdSchema>;

/** An empty colour identity means neutral/colourless: legal under any Commander. */
export const colorIdentitySchema = z
  .array(colorIdSchema)
  .max(COLOR_IDS.length)
  .refine((colors) => new Set(colors).size === colors.length, {
    message: 'Colour identity must not repeat a colour.',
  });

/**
 * `reaction` is a first-class card type rather than a flag on `spell`
 * (ruleset update §11). The deck builder filters on it, and the engine keys
 * timing-window legality off it, so it must not be inferable only from text.
 */
export const CARD_TYPES = ['unit', 'spell', 'reaction', 'relic', 'commander', 'token'] as const;
export const cardTypeSchema = z.enum(CARD_TYPES);
export type CardType = z.infer<typeof cardTypeSchema>;

/**
 * When a Reaction may be played. Bounded windows around the events the authored
 * cards name — deliberately not an open priority system (ruleset update §11).
 */
export const REACTION_WINDOWS = [
  'after_attackers_declared',
  'before_blockers_declared',
  'after_blockers_declared',
  'after_combat_damage',
  'after_combat',
  'when_opponent_plays_spell',
] as const;
export const reactionWindowSchema = z.enum(REACTION_WINDOWS);
export type ReactionWindow = z.infer<typeof reactionWindowSchema>;

export const ROLES = [
  'token',
  'attacker',
  'blocker',
  'support',
  'enabler',
  'payoff',
  'removal',
  'finisher',
  'build_around',
] as const;
export const roleSchema = z.enum(ROLES);
export type Role = z.infer<typeof roleSchema>;

/**
 * Intended mechanical impact, not player progression and not a card level.
 */
export const POWER_CLASSES = ['minor', 'standard', 'major', 'centerpiece'] as const;
export const powerClassSchema = z.enum(POWER_CLASSES);
export type PowerClass = z.infer<typeof powerClassSchema>;

/**
 * Provisional keyword vocabulary. Phase 1 only needs these to exist so cards
 * can be authored and filtered; execution arrives with the rules engine.
 */
export const KEYWORD_IDS = [
  /**
   * v3 renamed `swift` to `rush` and widened it: Rush also lets a Newly
   * Deployed Unit pay an `Exhaust this source` activation cost. The two are not
   * kept side by side — ruleset update §9 forbids exposing both names for one
   * behaviour, so `migrateCardSet` rewrites the old ID.
   */
  'rush',
  'guardian',
  'barrier',
  'overwhelm',
  'untargetable_by_opponents',
  'evasive',
  'armored',
  'siphon',
  'venom',
  'quick_strike',
  'resilient',
] as const;
export const keywordIdSchema = z.enum(KEYWORD_IDS);
export type KeywordId = z.infer<typeof keywordIdSchema>;

/**
 * How finished a set is, which decides how strictly its cards are validated.
 *
 * `development` fixtures may carry inert keywords and rough text; a `playtest`
 * or `active` set may not (readiness spec C4). The status lives on the set
 * manifest rather than on each card so a set is promoted in one edit.
 */
export const SET_STATUSES = ['development', 'draft', 'playtest', 'active', 'retired'] as const;
export const setStatusSchema = z.enum(SET_STATUSES);
export type SetStatus = z.infer<typeof setStatusSchema>;

/** Statuses whose cards must pass strict content validation with no warnings. */
export const STRICT_SET_STATUSES: readonly SetStatus[] = ['playtest', 'active'];

/** Free-form authoring tags (creature types, strategies). Lowercase snake_case. */
export const tagSchema = z
  .string()
  .min(1)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, 'Tags must be lowercase_snake_case.');
export type Tag = z.infer<typeof tagSchema>;

export const ZONE_IDS = [
  'deck',
  'hand',
  'battlefield',
  'discard',
  'commander_zone',
  'recovery',
  /**
   * Terminal. Cards owned by an eliminated player go here and never come back
   * (CLAUDE.md §12). Nothing may target it: it exists so a removed card is
   * still accounted for in replays and logs rather than vanishing.
   */
  'removed',
] as const;
export const zoneIdSchema = z.enum(ZONE_IDS);
export type ZoneId = z.infer<typeof zoneIdSchema>;

/** Zones an effect may legally name as a source or destination. */
export const TARGETABLE_ZONE_IDS: readonly ZoneId[] = [
  'deck',
  'hand',
  'battlefield',
  'discard',
  'commander_zone',
];

/** Card types that can be put into a deck list (Commanders are chosen separately). */
export const DECKABLE_CARD_TYPES: readonly CardType[] = ['unit', 'spell', 'reaction', 'relic'];
