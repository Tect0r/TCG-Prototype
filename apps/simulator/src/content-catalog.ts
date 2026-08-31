import { PILOT_AGENT_CLASSES, PILOT_IDS, agentClassSupports } from '@tcg/bot-interface';
import { preconsForFormat } from '@tcg/card-data';

import { resolveDeckSource } from './deck-source.js';
import type { Environment } from './environment.js';

/**
 * What a *chooser* may pick from: the precons one environment publishes and can
 * actually play, and the pilots that can fly them.
 *
 * This module exists because of a boundary rather than because the simulator
 * needed it. `apps/admin-server` is forbidden — structurally, by its own
 * boundary suite — from importing `@tcg/card-data`, `@tcg/bot-interface`,
 * `@tcg/deck` or `@tcg/deck-generator`: reaching past the simulator into any of
 * them would be the admin layer acquiring an opinion about content, deck
 * legality or what a pilot is. A builder screen still has to offer a list of
 * precons, and the honest way to get one is to ask the layer that already
 * decides which precons a run may name.
 *
 * ## Playability is asked, never asserted
 *
 * `resolveDeckSource` is the *same call* `runExperiment` makes, and a precon it
 * refuses is a precon an experiment naming it would stop on. So each published
 * precon is resolved on its own here, and what comes back is either nothing to
 * say or the environment's own refusal in the environment's own words. A second
 * legality rule written next to this one would be a list that offers a precon
 * the run then rejects, or hides one the run would have accepted.
 *
 * One precon at a time rather than all of them in one call, deliberately:
 * `resolvePrecons` throws on the first bad ID, so a single call would report one
 * refusal and leave every later precon unexamined — including the good ones.
 *
 * ## Nothing here is format-scoped by accident
 *
 * `preconsForFormat` takes the environment's own `deckFormat.formatId`, which is
 * the same value `resolvePrecons` names when it refuses an unknown ID. There is
 * no path through this module that reaches `BUNDLED_PRECONS`, so a caller cannot
 * obtain a pool the format does not publish.
 */

/** A precon one environment publishes, and whether that environment can play it. */
export interface PublishedPrecon {
  readonly preconId: string;
  readonly name: string;
  /** The precon's authored one-line strategy, as content states it. */
  readonly strategy: string;
  readonly formatId: string;
  readonly commanderId: string;
  /** Cards in the deck, excluding the Commander. */
  readonly cardCount: number;
  /**
   * Why this environment refuses it, in the environment's own words. Empty when
   * it does not.
   */
  readonly refusals: readonly string[];
}

/**
 * The precons this environment publishes, in content order, each with its
 * verdict.
 *
 * A refused precon is **listed and marked** rather than dropped. A chooser that
 * silently omitted one could not tell "this format has three precons" from "this
 * format has four and one of them is broken", and the second is a content
 * finding somebody should see.
 */
export function preconsForEnvironment(environment: Environment): readonly PublishedPrecon[] {
  return preconsForFormat(environment.deckFormat.formatId).map((precon) => ({
    preconId: precon.id,
    name: precon.name,
    strategy: precon.strategy,
    formatId: precon.formatId,
    commanderId: precon.commanderId,
    cardCount: precon.cardIds.length,
    refusals: refusalsFor(precon.id, environment),
  }));
}

function refusalsFor(preconId: string, environment: Environment): readonly string[] {
  try {
    resolveDeckSource(
      { kind: 'precon', preconIds: [preconId] },
      environment,
      `catalog|${preconId}`,
    );
    return [];
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause);
    // The refusal is multi-line — `resolvePrecons` lists one issue per line — and
    // each line is a fact on its own. Splitting keeps them separately renderable
    // instead of forcing every reader to re-parse one paragraph.
    return message
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }
}

/** A pilot this build ships, and what a run it flies may be cited for. */
export interface PublishedPilot {
  readonly pilotId: string;
  readonly agentClass: string;
  /**
   * Whether the pilot's agent class supports a play-quality claim (M05.4).
   *
   * The field a chooser needs and the one it would otherwise invent: a selection
   * containing only pilots for which this is `false` produces engine evidence
   * and no balance evidence at all, and a screen that offered the four pilots as
   * interchangeable would be hiding that.
   */
  readonly playQualityEvidence: boolean;
}

/**
 * Every pilot the registry publishes, in registry order.
 *
 * Derived from `PILOT_IDS` and `PILOT_AGENT_CLASSES` rather than listed, so a
 * pilot added to the registry appears here without this file being edited — and
 * `agentClassSupports` is the same predicate `LEGAL_ONLY_PILOT_IDS` is a view
 * of, so a chooser and a report cannot disagree about what a pilot's evidence
 * is worth.
 */
export function pilotCatalog(): readonly PublishedPilot[] {
  return PILOT_IDS.map((pilotId) => ({
    pilotId,
    agentClass: PILOT_AGENT_CLASSES[pilotId],
    playQualityEvidence: agentClassSupports(PILOT_AGENT_CLASSES[pilotId], 'play_quality'),
  }));
}
