import type { DeckSource, ExperimentConfig } from '@tcg/simulator';

/**
 * Which precons and Commanders a run is *configured* to play.
 *
 * M08.10 has to list and filter evidence by precon and by Commander, and there
 * were two places the answer could come from. It could come from the **results**
 * — `summary.json`'s deck rows carry a `commanderId` — or from the
 * **configuration**. This module is the second, and the reasons are the ones
 * `filters.ts` states:
 *
 * - A configuration exists from the moment a job is created. An operator
 *   narrowing to *the runs that play Goblin Swarm* means the ones set up to, and
 *   half of them may still be queued. A results-derived filter would silently
 *   answer a narrower question and would answer it as `false` for every run that
 *   has not finished — which is the same shape of defect as reading a zero
 *   observation as a zero rate.
 * - The configuration is the run's own document, read back from the catalog's
 *   copy of it. Nothing is indexed, copied or stamped onto a job document, so
 *   there is no second record of what a run plays that can disagree with the
 *   first and no `CATALOG_DOCUMENT_VERSION` move to migrate.
 *
 * ## What it can and cannot see
 *
 * A `precon` deck source names its precon IDs, and an `inline` one states a
 * `commanderId` per deck. A `generated` or `files` source names neither, and
 * this returns nothing for it — which is truthful rather than a gap: a generated
 * population plays no precon, and the Commander it ends up with is a **result**
 * of the draw rather than a selection. A search run is therefore found by kind,
 * by tag and by content hash, and the tranche that models a searched deck is the
 * one that can filter by the Commander it produced.
 *
 * The precon → Commander mapping is **not** made here. This module reads the
 * configuration and nothing else; resolving `precon_goblin_swarm` to
 * `goblin_warboss` is content, it belongs to `@tcg/simulator`, and the caller
 * passes in the map the content catalog already publishes. That keeps the one
 * expensive thing — loading and resolving an environment — under the caller's
 * control, done once per listing rather than once per job.
 */

export interface RunContentSelection {
  /** Precons the configuration names, in the order they were found, without repeats. */
  readonly preconIds: readonly string[];
  /** Commanders an inline deck states outright. Precon Commanders are added by the caller. */
  readonly inlineCommanderIds: readonly string[];
}

/** Every deck source one configuration holds, whatever kind of experiment it is. */
export function deckSourcesOf(config: ExperimentConfig): readonly DeckSource[] {
  const sources: DeckSource[] = [];
  for (const environment of environmentsOf(config)) {
    // Structural rather than a switch on `config.kind`: the five kinds hold
    // their deck sources under five different field names, and a switch here
    // would be a second place that has to be updated when the simulator adds a
    // sixth. Every field that *is* a deck source is a discriminated union with a
    // `kind` this recognises, and nothing else in a configuration is.
    for (const value of Object.values(environment)) {
      if (isDeckSource(value)) sources.push(value);
    }
  }
  return sources;
}

/**
 * The configuration's own sub-objects, including the experiment itself.
 *
 * A configuration holds deck sources directly (`decks`, `seedDecks`) and inside
 * nested blocks (`baseDecks`/`opponentDecks` on a replacement arm, `referenceDecks`
 * on a comparison). One level of nesting is enough for every shape the simulator
 * defines today, and a source it cannot see is a source this filter does not
 * claim to match — which is why the caller treats "no precon found" as "plays no
 * precon" rather than as "unknown".
 */
function environmentsOf(config: ExperimentConfig): readonly Record<string, unknown>[] {
  const blocks: Record<string, unknown>[] = [config as unknown as Record<string, unknown>];
  for (const value of Object.values(config as unknown as Record<string, unknown>)) {
    if (Array.isArray(value)) {
      for (const entry of value) {
        if (isPlainObject(entry)) blocks.push(entry);
      }
    } else if (isPlainObject(value) && !isDeckSource(value)) {
      blocks.push(value);
    }
  }
  return blocks;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isDeckSource(value: unknown): value is DeckSource {
  if (!isPlainObject(value)) return false;
  const kind = value['kind'];
  return kind === 'precon' || kind === 'inline' || kind === 'generated' || kind === 'files';
}

/** What one configuration selects, before any content is resolved. */
export function runContentOf(config: ExperimentConfig): RunContentSelection {
  const preconIds = new Set<string>();
  const inlineCommanderIds = new Set<string>();

  for (const source of deckSourcesOf(config)) {
    if (source.kind === 'precon') {
      for (const preconId of source.preconIds) preconIds.add(preconId);
    } else if (source.kind === 'inline') {
      for (const deck of source.decks) inlineCommanderIds.add(deck.commanderId);
    }
  }

  return { preconIds: [...preconIds], inlineCommanderIds: [...inlineCommanderIds] };
}

/**
 * Every Commander a configuration puts on the table, with precons resolved.
 *
 * `commanderOfPrecon` is the caller's map — the content catalog's, resolved once
 * per listing. A precon the map does not know contributes no Commander rather
 * than a guessed one: a precon that has been withdrawn since the run was
 * configured is a real state, and inventing a Commander for it would make a
 * filter answer a question about content that no longer exists.
 */
export function commanderIdsOf(
  selection: RunContentSelection,
  commanderOfPrecon: ReadonlyMap<string, string>,
): readonly string[] {
  const commanders = new Set<string>(selection.inlineCommanderIds);
  for (const preconId of selection.preconIds) {
    const commanderId = commanderOfPrecon.get(preconId);
    if (commanderId !== undefined) commanders.add(commanderId);
  }
  return [...commanders];
}

/**
 * Whether a run's selection satisfies a precon-or-Commander filter.
 *
 * OR within a field and AND across fields, which is the semantics
 * `catalogFilterSchema` states for every other member. Kept here rather than in
 * `jobMatchesFilter` because it is the only part of the filter that needs a
 * second document read, and the store applies it as a separate pass over what
 * the cheap predicates already narrowed.
 */
export function selectionMatches(
  selection: RunContentSelection,
  commanderIds: readonly string[],
  filter: { readonly preconIds: readonly string[]; readonly commanderIds: readonly string[] },
): boolean {
  if (
    filter.preconIds.length > 0 &&
    !selection.preconIds.some((preconId) => filter.preconIds.includes(preconId))
  ) {
    return false;
  }
  if (
    filter.commanderIds.length > 0 &&
    !commanderIds.some((commanderId) => filter.commanderIds.includes(commanderId))
  ) {
    return false;
  }
  return true;
}
