import { describe, expect, it } from 'vitest';
import { BOT_STYLES, BOT_STYLE_REGISTRY, type BotStyle } from '@tcg/bot-config';
import { PILOT_AGENT_CLASSES, PILOT_IDS, agentClassOf, type PilotId } from './registry.js';

/**
 * The one seam between the bot configuration contract and the pilots (M09.1).
 *
 * `@tcg/bot-config` deliberately does not depend on this package: a client that
 * has to validate a bot seat view should not drag three decision procedures onto
 * itself to do it. The cost of that choice is that `BotStyleDefinition.pilotId`
 * is a plain string over there, and this file is what stops it drifting into a
 * name no pilot answers to.
 *
 * The check runs in this direction — configuration is the lower layer, pilots
 * are the higher one — so the dependency and the test point the same way.
 */

describe('bot styles and the pilots behind them', () => {
  it('names a real pilot for every style', () => {
    const known = new Set<string>(PILOT_IDS);
    for (const style of BOT_STYLES) {
      expect(known.has(BOT_STYLE_REGISTRY[style].pilotId)).toBe(true);
    }
  });

  it('uses only heuristic pilots, so a style is a preference and not a skill level', () => {
    // Styles are one instrument pointed at three weight vectors. If a style ever
    // named a pilot from another agent class, choosing between styles would
    // become choosing between instruments — the pooled skill axis M05.4 refuses.
    for (const style of BOT_STYLES) {
      expect(agentClassOf(BOT_STYLE_REGISTRY[style].pilotId)).toBe('generic_heuristic');
    }
  });

  it('offers every heuristic pilot as a style, and no others', () => {
    const heuristicPilots = PILOT_IDS.filter(
      (id: PilotId) => PILOT_AGENT_CLASSES[id] === 'generic_heuristic',
    );
    const styledPilots = BOT_STYLES.map((style: BotStyle) => BOT_STYLE_REGISTRY[style].pilotId);
    expect([...styledPilots].sort()).toEqual([...heuristicPilots].sort());
  });

  it('does not offer the legality probe as a style', () => {
    const styledPilots = new Set(BOT_STYLES.map((style) => BOT_STYLE_REGISTRY[style].pilotId));
    expect(styledPilots.has('random_legal')).toBe(false);
  });
});
