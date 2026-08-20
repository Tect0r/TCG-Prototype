import { archetypeDefinition } from '@tcg/card-data';
import {
  AUTOMATIC_STYLE_FALLBACK,
  botStyleDefinition,
  resolveAutomaticStyle,
  styleSettingIsAutomatic,
  type BotStyle,
  type BotStyleSetting,
} from '@tcg/bot-config';

/**
 * What a lobby prints about where a bot's style came from (M09.16).
 *
 * The wording lives here rather than in the panel for the reason
 * `bot-pacing-labels.ts` does: two screens print it — the host's form, and the
 * seat summary every player sees — and a second copy of the sentence is a second
 * chance for one of them to describe a rule the software does not follow.
 *
 * Nothing here decides anything. `resolveAutomaticStyle` in `@tcg/bot-config` is
 * the mapping, and the server's answer is the one that counts; these functions
 * only say what it did, or what it would do, in words.
 */

export function styleSettingLabel(setting: BotStyleSetting): string {
  return styleSettingIsAutomatic(setting) ? 'Automatic' : botStyleDefinition(setting).label;
}

/**
 * What the style control means, for one draft.
 *
 * Three cases, and they are three because the host can act on them differently.
 *
 * - A named style prints its own summary, exactly as it did before M09.16.
 * - Automatic **with a Commander in hand** prints the style that Commander's
 *   authored deck plan implies, and says which plan decided it — or names the
 *   fallback and why, when the format publishes no plan for it. The preview is
 *   the same `resolveAutomaticStyle` the server will run against the same
 *   format, so it is a prediction the server is bound to rather than a guess.
 * - Automatic with **no Commander yet** — an `autonomous_generated` seat, whose
 *   bot has not picked one — says the style is decided when the deck is built,
 *   because that is the truth and a preview here would be an invention.
 */
export function styleSettingNote(
  setting: BotStyleSetting,
  deck: { readonly commanderId: string | null; readonly formatId: string },
  commanderName: string | null,
): string {
  if (!styleSettingIsAutomatic(setting)) return botStyleDefinition(setting).summary;

  if (deck.commanderId === null) {
    return (
      'Automatic reads the Commander’s authored deck plan, and this bot has not picked one yet: ' +
      `its style is decided when the server builds the deck, and falls back to ` +
      `${botStyleDefinition(AUTOMATIC_STYLE_FALLBACK).label} if this format publishes no plan for ` +
      'the Commander it picks.'
    );
  }

  const resolution = resolveAutomaticStyle(deck);
  const style = botStyleDefinition(resolution.style);
  const commander = commanderName ?? deck.commanderId;
  if (resolution.archetypeId !== null) {
    // The archetype's own label out of `@tcg/card-data`'s registry, not a word
    // typed here: the taxonomy owns what it calls itself.
    const archetype = archetypeDefinition(resolution.archetypeId);
    return (
      `Automatic: ${commander}’s authored deck plan is ${archetype.label}, so this bot plays ` +
      `${style.label}. ${style.summary}`
    );
  }
  const because =
    resolution.reason === 'ambiguous'
      ? `this format publishes more than one deck plan for ${commander}, so its archetype is undetermined`
      : `this format publishes no authored deck plan for ${commander}`;
  return `Automatic falls back to ${style.label}, because ${because}. ${style.summary}`;
}

/**
 * The style a seat is flying, for the summary every player sees.
 *
 * An automatic seat is named as such rather than presented as a hand-picked one:
 * "Value (automatic)" is a different fact about the table from "Value", and the
 * seat view carries both members precisely so the lobby need not pretend
 * otherwise.
 */
export function seatStyleLabel(bot: {
  readonly style: BotStyle;
  readonly styleSetting: BotStyleSetting;
}): string {
  const label = botStyleDefinition(bot.style).label;
  return styleSettingIsAutomatic(bot.styleSetting) ? `${label} (automatic)` : label;
}
