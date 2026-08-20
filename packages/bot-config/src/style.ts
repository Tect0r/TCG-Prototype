import { z } from 'zod';
import { deckPlansForFormat, type ArchetypeId } from '@tcg/card-data';

/**
 * Bot style (M09.1) — what a bot *prefers*, and nothing about how well it plays.
 *
 * The second of the four independent axes
 * ([ADR 0024](../../../docs/architecture/0024-live-bot-seats.md) §5). Each style
 * names one of the shipped heuristic weight vectors in `@tcg/bot-interface`, and
 * the correspondence is enforced by a test over there rather than trusted here —
 * this package deliberately does not depend on the pilots, so that a wire
 * contract never drags a decision procedure onto a client with it.
 *
 * `random_legal` is **not** a style. It is a legality probe with no preferences,
 * belongs to the `random_legal` agent class, and would read as "an even easier
 * Easy" if it were offered beside the three below — which is exactly the pooled
 * skill axis this milestone refuses to build.
 *
 * `automatic` is **not** a fourth style. It is a *setting* a host may choose
 * instead of a style, and it resolves to one of the three below before anything
 * plays: see `BOT_STYLE_SETTINGS` and `resolveAutomaticStyle` at the foot of this
 * file. A bot always flies a named style; automatic only decides which.
 */

/** Ordered as the lobby lists them. Each maps to one published weight vector. */
export const BOT_STYLES = ['aggressive', 'defensive', 'value'] as const;
export const botStyleSchema = z.enum(BOT_STYLES);
export type BotStyle = z.infer<typeof botStyleSchema>;

export interface BotStyleDefinition {
  readonly id: BotStyle;
  readonly label: string;
  /** One sentence a lobby can print beside the control. */
  readonly summary: string;
  /**
   * The `PilotId` in `@tcg/bot-interface` whose weight vector this style is.
   * A string rather than the imported union, because the dependency runs the
   * other way; `bot-config.test.ts` in that package proves every value here is a
   * real heuristic pilot.
   */
  readonly pilotId: string;
}

export const BOT_STYLE_REGISTRY: Readonly<Record<BotStyle, BotStyleDefinition>> = Object.freeze({
  aggressive: {
    id: 'aggressive',
    label: 'Aggressive',
    summary: 'Prices damage and pressure above board safety.',
    pilotId: 'aggressive',
  },
  defensive: {
    id: 'defensive',
    label: 'Defensive',
    summary: 'Prices its own survival and blockers above racing.',
    pilotId: 'defensive',
  },
  value: {
    id: 'value',
    label: 'Value',
    summary: 'Prices card advantage and board value above either.',
    pilotId: 'value',
  },
});

export function botStyleDefinition(style: BotStyle): BotStyleDefinition {
  return BOT_STYLE_REGISTRY[style];
}

/* -------------------------------------------------- automatic style (M09.16) */

/**
 * What a host may set the style control to: one of the three styles, or
 * `automatic`.
 *
 * A separate vocabulary from `BOT_STYLES` rather than a widened one, because the
 * two are asked at different moments. A *setting* is what the host chose and can
 * be `automatic`; a *style* is what a bot actually flies and never can. Keeping
 * them apart is what lets `BotSeatConfig` record both — `styleSetting: 'automatic'`
 * beside `style: 'defensive'` — so a seat can say which style it is flying **and**
 * that nobody picked it by hand.
 */
export const BOT_STYLE_SETTINGS = ['automatic', ...BOT_STYLES] as const;
export const botStyleSettingSchema = z.enum(BOT_STYLE_SETTINGS);
export type BotStyleSetting = z.infer<typeof botStyleSettingSchema>;

/** The one setting that is not itself a style. Named, so nothing spells it. */
export const AUTOMATIC_STYLE = 'automatic' as const;

/**
 * A type predicate rather than a boolean, so that ruling automatic out *is* how
 * a caller obtains a `BotStyle`. Nothing has to cast a setting to a style.
 */
export function styleSettingIsAutomatic(
  setting: BotStyleSetting,
): setting is typeof AUTOMATIC_STYLE {
  return setting === AUTOMATIC_STYLE;
}

/**
 * The style an archetype implies.
 *
 * **The whole of the automatic mapping**, and deliberately a total `Record` over
 * `ArchetypeId`: a fifth archetype cannot be added to `@tcg/card-data` without
 * somebody deciding here what a bot built to it should prefer, which is a compile
 * error rather than a silent slide into the fallback.
 *
 * Each entry is the archetype's own stated payoff matched against the style
 * summary that prices it, and nothing else — no card ID, no display text, no
 * count of what happens to be in a list. That is what makes the mapping
 * deterministic and stable while the card pool moves.
 *
 * - `token_swarm` converts board width into damage, which is `aggressive`
 *   pricing damage and pressure above board safety.
 * - `defensive_attrition` keeps the blockers that survive, which is `defensive`
 *   pricing its own survival and blockers above racing.
 * - `sacrifice_value` wins on accumulated drain from expendable bodies, which is
 *   `value` pricing card advantage and board value.
 * - `reactive_control` also wins on accumulated card advantage, which is the same
 *   `value` claim; it is not `defensive`, because surviving is how it gets there
 *   rather than what it is for.
 */
export const ARCHETYPE_STYLE_MAP: Readonly<Record<ArchetypeId, BotStyle>> = Object.freeze({
  token_swarm: 'aggressive',
  defensive_attrition: 'defensive',
  sacrifice_value: 'value',
  reactive_control: 'value',
});

/**
 * The style automatic falls back to when no archetype can be established.
 *
 * Named rather than implicit, and `value` rather than the first entry of
 * `BOT_STYLES`, because a fallback is a statement about *not knowing*: `value`
 * prices card advantage and board value, which is the least specific claim of
 * the three, where `aggressive` would be a wager about a deck nothing has
 * classified.
 */
export const AUTOMATIC_STYLE_FALLBACK: BotStyle = 'value';

/**
 * Why a setting landed on the style it did. A closed set, so a screen that
 * explains the choice can be total over it rather than ending in an `else`.
 *
 * `chosen` is the case where nothing was resolved at all — the host named the
 * style — and it is in the same vocabulary as the three automatic outcomes so
 * that one field answers "where did this style come from?" for every seat.
 */
export const AUTOMATIC_STYLE_REASONS = ['chosen', 'archetype', 'no_plan', 'ambiguous'] as const;
export type AutomaticStyleReason = (typeof AUTOMATIC_STYLE_REASONS)[number];

export interface AutomaticStyleResolution {
  readonly style: BotStyle;
  /** The archetype the style came from, and `null` whenever the fallback ran. */
  readonly archetypeId: ArchetypeId | null;
  readonly reason: AutomaticStyleReason;
}

/**
 * The style a Commander's authored deck plan implies, in one format.
 *
 * **Structured data only** (ADR 0024 §5, and CLAUDE.md's engineering
 * invariants): the route is Commander → the format's authored `DeckPlan` →
 * `archetypeId` → `ARCHETYPE_STYLE_MAP`. Nothing reads a card's rules text, its
 * name or a precon's `strategy` line, all three of which are display text.
 *
 * **Format-scoped**, for the reason every pool lookup in this repository is: a
 * plan is only meaningful under the construction rules its cards were checked
 * against, and a plan from another format saying `token_swarm` about a Commander
 * this format bans is not evidence about this table.
 *
 * The Commander is the key rather than the precon ID because it is the one
 * handle all four deck modes share — a generated deck has no precon, and a
 * saved deck has no plan — so one rule covers every mode instead of four.
 *
 * Two named ways to miss, and both fall back rather than throw: a format may
 * publish no plan for a Commander (`no_plan`), and two plans may name the same
 * Commander, in which case the archetype is genuinely undetermined and picking
 * the first would make the answer depend on file order (`ambiguous`).
 *
 * `commanderId` is nullable because `SavedDeck.commanderId` is. A deck that has
 * passed `validateDeck` in a Commander format always has one, so this is the
 * type being honest rather than a case a seated bot reaches; a deck with no
 * Commander has nothing to classify and takes the same `no_plan` fallback.
 */
export function resolveAutomaticStyle(input: {
  readonly commanderId: string | null;
  readonly formatId: string;
}): AutomaticStyleResolution {
  const matches =
    input.commanderId === null
      ? []
      : deckPlansForFormat(input.formatId).filter((plan) => plan.commanderId === input.commanderId);
  if (matches.length === 0) {
    return { style: AUTOMATIC_STYLE_FALLBACK, archetypeId: null, reason: 'no_plan' };
  }
  if (matches.length > 1) {
    return { style: AUTOMATIC_STYLE_FALLBACK, archetypeId: null, reason: 'ambiguous' };
  }
  const archetypeId = matches[0]!.archetypeId;
  return { style: ARCHETYPE_STYLE_MAP[archetypeId], archetypeId, reason: 'archetype' };
}

/**
 * The style a setting means, given the Commander the bot will actually lead.
 *
 * The single entry point every caller uses, so that "automatic resolves to X"
 * has one implementation on the server, in the lobby screen and in a test.
 */
export function resolveStyleSetting(
  setting: BotStyleSetting,
  deck: { readonly commanderId: string | null; readonly formatId: string },
): AutomaticStyleResolution {
  if (!styleSettingIsAutomatic(setting)) {
    return { style: setting, archetypeId: null, reason: 'chosen' };
  }
  return resolveAutomaticStyle(deck);
}

/** Same shape as `difficultyRegistryGaps()`, for the same reason. */
export function botStyleRegistryGaps(): string[] {
  const problems: string[] = [];
  const known = new Set<string>(BOT_STYLES);

  for (const key of Object.keys(BOT_STYLE_REGISTRY)) {
    if (!known.has(key)) problems.push(`style "${key}" is defined but not in the list.`);
  }
  for (const style of BOT_STYLES) {
    const definition = BOT_STYLE_REGISTRY[style];
    if (definition.id !== style) problems.push(`style "${style}" is filed under the wrong key.`);
    if (definition.pilotId.length === 0) problems.push(`style "${style}" names no pilot.`);
  }

  // The automatic mapping, checked at runtime for the same reason the registry
  // is: the `Record` type catches a missing archetype at build time, and this
  // catches an entry naming a style the vocabulary no longer has — and the
  // fallback doing the same, which would make every unclassified deck
  // unplayable rather than merely unclassified (M09.16).
  for (const [archetypeId, style] of Object.entries(ARCHETYPE_STYLE_MAP)) {
    if (!known.has(style)) {
      problems.push(`archetype "${archetypeId}" maps to unknown style "${style}".`);
    }
  }
  if (!known.has(AUTOMATIC_STYLE_FALLBACK)) {
    problems.push(`the automatic fallback names unknown style "${AUTOMATIC_STYLE_FALLBACK}".`);
  }
  if ((BOT_STYLE_SETTINGS as readonly string[]).includes(AUTOMATIC_STYLE) === false) {
    problems.push('the style settings do not offer automatic at all.');
  }
  for (const style of BOT_STYLES) {
    if (!(BOT_STYLE_SETTINGS as readonly string[]).includes(style)) {
      problems.push(`style "${style}" cannot be set, because it is not a style setting.`);
    }
  }
  return problems;
}
