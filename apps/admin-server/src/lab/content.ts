import { contentCatalogSchema, type ContentCatalog } from '@tcg/admin-contracts';
import { pilotCatalog, preconsForEnvironment } from '@tcg/simulator';

import { PRESET_FORMAT_ID, presetEnvironment, scrubRefusal } from './expand.js';

/**
 * What a builder may offer, read from the format rather than held here.
 *
 * The whole module is a projection. `preconsForEnvironment` and `pilotCatalog`
 * are `@tcg/simulator`'s — the same layer that resolves a precon when a run
 * starts and the same registry a report reads a pilot's agent class out of — so
 * a precon this answer marks playable is a precon `resolveDeckSource` accepts,
 * by construction rather than by agreement.
 *
 * ## Why it is resolved per request and never cached
 *
 * The milestone requires *validation against current content and format at
 * submission time*, and a cached list is a list that was current once. Resolving
 * the environment costs a content load; a builder screen asks for this when it
 * opens, which is exactly the moment "current" has to mean now. A cache would
 * also make the answer disagree with the refusal `enqueue-preset` gives from the
 * same content, which is the disagreement the whole design avoids.
 *
 * ## What is taken out on the way through
 *
 * A refusal from the simulator is the authoritative sentence and is reused, with
 * anything path-shaped removed first (ADR 0023 §5) — the same treatment
 * `expandPreset` applies to the refusals it forwards. Nothing else is rewritten:
 * a screen that paraphrased "this environment bans `goblin_chieftain`" would be
 * a second author of a verdict it does not make.
 */
export function readContentCatalog(): ContentCatalog {
  // `presetEnvironment` rather than a second construction of the same format:
  // two environments spelled the same way that drift are a form offering a
  // precon the expansion then refuses.
  const environment = presetEnvironment();

  return contentCatalogSchema.parse({
    formatId: PRESET_FORMAT_ID,
    precons: preconsForEnvironment(environment).map((precon) => ({
      preconId: precon.preconId,
      name: precon.name,
      strategy: precon.strategy,
      commanderId: precon.commanderId,
      cardCount: precon.cardCount,
      refusals: precon.refusals.map((reason) => scrubRefusal(reason).slice(0, 400)),
    })),
    pilots: pilotCatalog().map((pilot) => ({
      pilotId: pilot.pilotId,
      agentClass: pilot.agentClass,
      playQualityEvidence: pilot.playQualityEvidence,
    })),
  });
}

/**
 * Which Commander each published precon plays, resolved the same way (M08.10).
 *
 * A projection over `readContentCatalog` rather than a second resolution, so the
 * mapping a result filter uses is the mapping a builder was offered. It is a map
 * rather than a list because its one caller answers *is this run's Commander one
 * of these* per job, and a linear scan per job over a per-listing constant is a
 * cost with no reason.
 *
 * A precon the format no longer publishes is simply absent, which is what lets a
 * Commander filter say *this run plays no Commander I can name* instead of
 * guessing one for content that has been withdrawn.
 */
export function preconCommanderIds(): ReadonlyMap<string, string> {
  return new Map(
    readContentCatalog().precons.map((precon) => [precon.preconId, precon.commanderId]),
  );
}
