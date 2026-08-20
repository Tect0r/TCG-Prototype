import { describe, expect, it } from 'vitest';
import { ARCHETYPE_IDS, deckPlansForFormat, type ArchetypeId } from '@tcg/card-data';
import {
  ARCHETYPE_STYLE_MAP,
  AUTOMATIC_STYLE,
  AUTOMATIC_STYLE_FALLBACK,
  AUTOMATIC_STYLE_REASONS,
  BOT_STYLES,
  BOT_STYLE_SETTINGS,
  botStyleRegistryGaps,
  botStyleSchema,
  botStyleSettingSchema,
  resolveAutomaticStyle,
  resolveStyleSetting,
  styleSettingIsAutomatic,
  type BotStyle,
} from './style.js';

/**
 * The style vocabulary, and automatic style (M09.1, M09.16).
 *
 * The claims under test are the ones M09.16's checklist makes: automatic is
 * **deterministic**, comes from **structured data**, and has a **named
 * fallback** — and, underneath all three, that it is not a fourth style but a
 * setting that always resolves to one of the three.
 *
 * The mapping is exercised against the real Wave 1 deck plans rather than a
 * fixture, because the thing that could break it is content moving: a plan
 * changing its `archetypeId`, or a Commander losing its plan, should fail here
 * rather than quietly change what "Automatic" means at somebody's table.
 */

const FORMAT = 'precon_wave_1';

/** Every Commander Wave 1 publishes a plan for, and what the plan claims. */
const WAVE_1: readonly (readonly [string, ArchetypeId, BotStyle])[] = [
  ['bastion_commander', 'defensive_attrition', 'defensive'],
  ['chief_containment_scholar', 'reactive_control', 'value'],
  ['goblin_warboss', 'token_swarm', 'aggressive'],
  ['grave_matriarch', 'sacrifice_value', 'value'],
];

describe('the style vocabulary', () => {
  it('is complete, and offers automatic beside the three styles', () => {
    expect(botStyleRegistryGaps()).toEqual([]);
    expect(BOT_STYLES).toEqual(['aggressive', 'defensive', 'value']);
    // Automatic first, because it is the option that needs no opinion; the
    // three styles keep their own order behind it.
    expect(BOT_STYLE_SETTINGS).toEqual(['automatic', ...BOT_STYLES]);
  });

  it('keeps a setting and a style different types', () => {
    // The distinction the whole tranche rests on: a bot flies a style, and a
    // host sets a setting. A resolved style can never be `automatic`, which is
    // why the two schemas are not one.
    expect(botStyleSettingSchema.safeParse(AUTOMATIC_STYLE).success).toBe(true);
    expect(botStyleSchema.safeParse(AUTOMATIC_STYLE).success).toBe(false);
    expect(styleSettingIsAutomatic(AUTOMATIC_STYLE)).toBe(true);
    for (const style of BOT_STYLES) expect(styleSettingIsAutomatic(style)).toBe(false);
  });

  it('maps every archetype the taxonomy has to a real style', () => {
    // Total by construction — the `Record` type fails a build that forgets one —
    // and total at runtime too, for the callers that arrive with a string.
    expect(Object.keys(ARCHETYPE_STYLE_MAP).sort()).toEqual([...ARCHETYPE_IDS].sort());
    for (const archetypeId of ARCHETYPE_IDS) {
      expect(BOT_STYLES).toContain(ARCHETYPE_STYLE_MAP[archetypeId]);
    }
    expect(BOT_STYLES).toContain(AUTOMATIC_STYLE_FALLBACK);
  });
});

describe('automatic style', () => {
  it.each(WAVE_1)(
    '%s resolves through its authored plan rather than anything printed on a card',
    (commanderId, archetypeId, style) => {
      const resolution = resolveAutomaticStyle({ commanderId, formatId: FORMAT });
      expect(resolution).toEqual({ style, archetypeId, reason: 'archetype' });

      // And the answer really did come from the plan: the archetype it reports
      // is the one the content file claims, not a coincidence of the style.
      const plan = deckPlansForFormat(FORMAT).find((entry) => entry.commanderId === commanderId);
      expect(plan?.archetypeId).toBe(archetypeId);
    },
  );

  it('is deterministic: the same Commander answers the same way every time', () => {
    for (const [commanderId] of WAVE_1) {
      const first = resolveAutomaticStyle({ commanderId, formatId: FORMAT });
      const second = resolveAutomaticStyle({ commanderId, formatId: FORMAT });
      expect(second).toEqual(first);
    }
  });

  it('falls back by name when the format publishes no plan for the Commander', () => {
    const resolution = resolveAutomaticStyle({
      commanderId: 'no_such_commander',
      formatId: FORMAT,
    });
    expect(resolution).toEqual({
      style: AUTOMATIC_STYLE_FALLBACK,
      archetypeId: null,
      reason: 'no_plan',
    });
    // A deck with no Commander at all has nothing to classify and takes the
    // same route rather than throwing at a lobby.
    expect(resolveAutomaticStyle({ commanderId: null, formatId: FORMAT }).reason).toBe('no_plan');
  });

  it('is format-scoped: a plan from another format is not evidence about this table', () => {
    // `development` publishes no plans, so the very Commander Wave 1 classifies
    // is unclassified there. A mapping that read the whole bundle would answer
    // `aggressive` here, which is the pool leak every lookup in this repository
    // is scoped to prevent.
    expect(deckPlansForFormat('development')).toEqual([]);
    expect(
      resolveAutomaticStyle({ commanderId: 'goblin_warboss', formatId: 'development' }),
    ).toEqual({ style: AUTOMATIC_STYLE_FALLBACK, archetypeId: null, reason: 'no_plan' });
  });

  it('names every way it can land, and no others', () => {
    // A closed set, so a screen explaining the choice can be total over it.
    expect([...AUTOMATIC_STYLE_REASONS]).toEqual(['chosen', 'archetype', 'no_plan', 'ambiguous']);
  });

  it('leaves a style the host named alone', () => {
    for (const style of BOT_STYLES) {
      expect(
        resolveStyleSetting(style, { commanderId: 'goblin_warboss', formatId: FORMAT }),
      ).toEqual({ style, archetypeId: null, reason: 'chosen' });
    }
    // And automatic goes the other way, through the mapping, from the same call.
    expect(
      resolveStyleSetting(AUTOMATIC_STYLE, { commanderId: 'goblin_warboss', formatId: FORMAT })
        .style,
    ).toBe('aggressive');
  });
});
