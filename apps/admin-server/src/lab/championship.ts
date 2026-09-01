import {
  adminError,
  canonicalSourceClasses,
  type AdminError,
  type BatchId,
  type JobOrigin,
} from '@tcg/admin-contracts';
import { err, isErr, ok } from '@tcg/shared';
import {
  deckDistance,
  experimentPaths,
  simDeckSchema,
  type EnvironmentConfigInput,
  type ExperimentConfig,
} from '@tcg/simulator';
import type { SimDeck } from '@tcg/simulator';
import { z } from 'zod';

import { readDocumentText } from '../catalog/files.js';
import { resolveResultLocation, type ResolvedCatalogRoots } from '../catalog/roots.js';
import type { CatalogResult, CatalogStore } from '../catalog/store.js';
import { PresetRefused, presetEnvironmentConfig, scrubRefusal, validated } from './expand.js';

/**
 * Turning a Commander Search's completed archives into a frozen finalist
 * championship (M08.15).
 *
 * `commander_search`'s own `deferredStages` entry names why this cannot be part
 * of `expandPreset`: the finalist field does not exist until the named searches
 * finish. This module is what exists once they have — a pure selection over the
 * decks those searches actually produced, and the ordinary `kind: 'batch'`
 * configuration that plays them. Nothing here runs a match, resolves an
 * environment or decides legality; every deck this selects has already been
 * through `checkDeck` inside the search that found it, and `validated` here is
 * the same admission gate every other preset expansion uses.
 */

/** The one rule this build selects finalists by, named so a second rule can be told apart. */
export const DIVERSITY_RULE = 'greedy_min_pairwise_deck_distance' as const;

/**
 * How many single-card swaps apart a finalist must be from every finalist
 * already chosen.
 *
 * Not configurable: `finalistsPerCommander` is the dial the milestone names as
 * "a configurable number", and it is a count. This is the rule's own threshold
 * for what "sufficiently distinct" means, and it stays one constant so two
 * championships scheduled from the same archive with the same count always
 * freeze the same finalists.
 */
export const MIN_FINALIST_DISTANCE = 4;

export interface FinalistSelection {
  readonly commanderId: string;
  readonly requested: number;
  readonly finalists: readonly SimDeck[];
  readonly minDistance: number;
}

/**
 * Greedily picks up to `requested` decks from `candidates`, each at least
 * `minDistance` away from every finalist already chosen.
 *
 * Deterministic rather than randomized: `candidates` is sorted by hash before
 * anything else happens, the first finalist is the first deck in that order,
 * and every later pick is the candidate with the **largest** minimum distance
 * to the finalists already chosen — ties broken by which one was reached first
 * in the sorted order, i.e. by hash. The same archive and the same count always
 * freeze the same finalists.
 *
 * Stops early, rather than filling the count with a deck that fails the
 * threshold, when no remaining candidate is far enough from every finalist
 * already chosen. `requested - finalists.length` is the shortfall a caller
 * records rather than silently rounds away.
 */
export function selectFinalists(
  commanderId: string,
  candidates: readonly SimDeck[],
  requested: number,
  minDistance: number = MIN_FINALIST_DISTANCE,
): FinalistSelection {
  const pool = [...candidates].sort((left, right) => left.hash.localeCompare(right.hash));
  const chosen: SimDeck[] = [];

  if (pool.length > 0 && requested > 0) chosen.push(pool[0] as SimDeck);

  while (chosen.length < requested) {
    let best: SimDeck | null = null;
    let bestDistance = -1;
    for (const candidate of pool) {
      if (chosen.some((deck) => deck.hash === candidate.hash)) continue;
      const nearest = Math.min(...chosen.map((deck) => deckDistance(deck, candidate)));
      if (nearest > bestDistance) {
        best = candidate;
        bestDistance = nearest;
      }
    }
    if (best === null || bestDistance < minDistance) break;
    chosen.push(best);
  }

  return { commanderId, requested, finalists: chosen, minDistance };
}

export interface ChampionshipDeckGroup {
  readonly commanderId: string;
  readonly decks: readonly SimDeck[];
}

/**
 * The ordinary batch configuration a fresh-seed mirrored championship is.
 *
 * Every finalist across every Commander plays every other in one round-robin
 * schedule with mirrored seat orders — the milestone's "opponent-Commander
 * matrix" is `aggregate()`'s own `commanderMatchups`, read off this run like any
 * other batch's, because a finalist's `commanderId` travels with it into an
 * inline deck exactly as `resolveDeckSource` already expects.
 */
export function buildChampionshipConfig(inputs: {
  readonly experimentId: string;
  readonly seed: string;
  readonly pilots: readonly { readonly id: string }[];
  readonly gamesPerPairing: number;
  readonly environment: EnvironmentConfigInput;
  readonly groups: readonly ChampionshipDeckGroup[];
}): ExperimentConfig {
  const decks = inputs.groups.flatMap((group) =>
    group.decks.map((deck) => ({
      id: deck.id,
      label: deck.label,
      commanderId: deck.commanderId,
      cards: deck.cards.map((entry) => ({ cardId: entry.cardId, quantity: entry.quantity })),
    })),
  );

  return validated(
    {
      schemaVersion: 1,
      id: inputs.experimentId,
      seed: inputs.seed,
      playerCount: 2,
      pilots: inputs.pilots,
      pilotPairing: 'mirror',
      kind: 'batch',
      label: 'Commander Search finalist championship',
      environment: inputs.environment,
      decks: { kind: 'inline', decks },
      schedule: 'round_robin',
      gamesPerPairing: inputs.gamesPerPairing,
      mirrorSeats: true,
      retention: { replaySampleRate: 50, keepLogs: false, keepDecisions: false },
    },
    'championship',
  );
}

/* -------------------------------------------------------------- scheduling */

interface ChampionshipFinalistOrigin {
  readonly commanderId: string;
  readonly requested: number;
  readonly selected: number;
  readonly diversityRule: typeof DIVERSITY_RULE;
  readonly minDistance: number;
}

export interface ScheduleChampionshipInput {
  readonly batchId: BatchId;
  readonly finalistsPerCommander: number;
  readonly gamesPerPairing: number;
  readonly seed: string;
}

export interface ScheduledChampionship {
  readonly batchId: BatchId;
}

/** `jobOriginSchema`'s own bound on `commander_championship.finalists`, restated so the scheduler can refuse before building a job the origin schema would then refuse. */
const MAX_CHAMPIONSHIP_COMMANDERS = 16;

/** A refusal keyed the same way every other builder refusal is: a field, and a readable reason. */
function refuse(code: 'admin/schema' | 'admin/no_result', message: string): AdminError[] {
  return [adminError(code, scrubRefusal(message), { path: 'batchId' })];
}

/**
 * Turns a completed `commander_search` batch into a scheduled finalist
 * championship.
 *
 * The one piece of I/O `championship.ts`'s pure functions above cannot do:
 * reading each search job's own `decks.json` back out of its canonical
 * directory, exactly the way `ResultReader` reads `summary.json` — resolved
 * from the catalog's stored reference, never trusted, re-parsed on the way in.
 * Everything it decides — which decks are finalists, what the championship's
 * configuration is — is delegated to `selectFinalists` and
 * `buildChampionshipConfig`; this class only supplies them their inputs and
 * writes down what they returned.
 */
export class ChampionshipScheduler {
  readonly #store: CatalogStore;
  readonly #roots: ResolvedCatalogRoots;

  constructor(options: { readonly store: CatalogStore; readonly roots: ResolvedCatalogRoots }) {
    this.#store = options.store;
    this.#roots = options.roots;
  }

  async schedule(input: ScheduleChampionshipInput): Promise<CatalogResult<ScheduledChampionship>> {
    const jobs = await this.#store.readBatchJobs(input.batchId);
    if (isErr(jobs)) return jobs;

    const searches = jobs.value.filter(
      (job) => job.origin.kind === 'preset' && job.origin.presetId === 'commander_search',
    );
    if (searches.length === 0) {
      return err(
        refuse(
          'admin/schema',
          `Batch "${input.batchId}" has no Commander Search jobs to freeze a championship from.`,
        ),
      );
    }

    const unfinished = searches.filter((job) => job.status !== 'completed');
    if (unfinished.length > 0) {
      return err(
        refuse(
          'admin/no_result',
          `${String(unfinished.length)} of ${String(searches.length)} Commander Search job(s) in ` +
            `batch "${input.batchId}" have not completed yet: ` +
            `${unfinished.map((job) => job.label).join(', ')}.`,
        ),
      );
    }

    // Read every search's own configuration first — cheap, and enough to refuse
    // before touching a single deck archive: which Commander each job names,
    // and the pilots it was searched under. `commander_search` never enqueues
    // two jobs for one Commander (M08.13's `requireDistinct`), but nothing stops
    // an operator filling one draft batch from two separate `commander_search`
    // submissions, and a second submission is under no obligation to have named
    // the same pilots as the first. A championship playing half its finalists
    // under a pilot set they were never searched under would be a silent
    // decision this scheduler made rather than one the milestone's "seat and
    // pilot split" reading can be trusted against.
    const commanderIds: string[] = [];
    let pilots: readonly { readonly id: string }[] | null = null;
    for (const job of searches) {
      const config = await this.#store.readJobConfig(job.jobId);
      if (isErr(config)) return config;
      if (config.value.kind !== 'search') {
        return err(refuse('admin/schema', `Job "${job.jobId}" is not a Commander Search job.`));
      }
      const commanderId = config.value.generator.commanderIds[0];
      if (commanderId === undefined) {
        return err(refuse('admin/schema', `Job "${job.jobId}" names no Commander.`));
      }
      commanderIds.push(commanderId);

      const jobPilotIds = [...config.value.pilots.map((pilot) => pilot.id)].sort();
      if (pilots === null) {
        pilots = config.value.pilots;
      } else {
        const expected = [...pilots.map((pilot) => pilot.id)].sort();
        if (JSON.stringify(jobPilotIds) !== JSON.stringify(expected)) {
          return err(
            refuse(
              'admin/schema',
              `Batch "${input.batchId}" holds Commander Search jobs searched under different ` +
                `pilots (${expected.join(', ')} versus ${jobPilotIds.join(', ')}), so a single ` +
                'championship cannot say which pilots its seat/pilot split describes.',
            ),
          );
        }
      }
    }

    const distinctCommanderIds = new Set(commanderIds);
    if (distinctCommanderIds.size > MAX_CHAMPIONSHIP_COMMANDERS) {
      return err(
        refuse(
          'admin/schema',
          `Batch "${input.batchId}" names ${String(distinctCommanderIds.size)} Commanders, above ` +
            `the ${String(MAX_CHAMPIONSHIP_COMMANDERS)} a single championship can record finalists for.`,
        ),
      );
    }

    const decksByCommander = new Map<string, SimDeck[]>();

    for (const job of searches) {
      const config = await this.#store.readJobConfig(job.jobId);
      if (isErr(config)) return config;
      if (config.value.kind !== 'search') {
        return err(refuse('admin/schema', `Job "${job.jobId}" is not a Commander Search job.`));
      }

      const commanderId = config.value.generator.commanderIds[0];
      if (commanderId === undefined) {
        return err(refuse('admin/schema', `Job "${job.jobId}" names no Commander.`));
      }

      const reference = job.result;
      if (reference === null) {
        return err(
          refuse('admin/no_result', `Job "${job.jobId}" has completed but produced no result.`),
        );
      }

      const directory = await resolveResultLocation(this.#roots, reference.location);
      if (isErr(directory)) return directory;

      const text = await readDocumentText(experimentPaths(directory.value).decks);
      if (text === null) {
        return err(
          refuse(
            'admin/no_result',
            `Job "${job.jobId}"'s run has no deck archive to select finalists from.`,
          ),
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        return err(
          refuse('admin/no_result', `Job "${job.jobId}"'s deck archive is not readable JSON.`),
        );
      }
      const decks = z.array(simDeckSchema).safeParse(parsed);
      if (!decks.success) {
        return err(
          refuse(
            'admin/no_result',
            `Job "${job.jobId}"'s deck archive does not carry the shape a finalist selection needs.`,
          ),
        );
      }

      const candidates = decksByCommander.get(commanderId) ?? [];
      candidates.push(...decks.data.filter((deck) => deck.commanderId === commanderId));
      decksByCommander.set(commanderId, candidates);
    }

    const groups: ChampionshipDeckGroup[] = [];
    const finalistOrigins: ChampionshipFinalistOrigin[] = [];

    for (const [commanderId, candidates] of decksByCommander) {
      const selection = selectFinalists(commanderId, candidates, input.finalistsPerCommander);
      if (selection.finalists.length === 0) {
        return err(
          refuse(
            'admin/no_result',
            `Commander "${commanderId}"'s search produced no deck to freeze as a finalist.`,
          ),
        );
      }
      groups.push({ commanderId, decks: selection.finalists });
      finalistOrigins.push({
        commanderId,
        requested: selection.requested,
        selected: selection.finalists.length,
        diversityRule: DIVERSITY_RULE,
        minDistance: selection.minDistance,
      });
    }

    // A round-robin needs two seats. A single Commander whose archive froze
    // exactly one finalist would otherwise build and schedule a batch that
    // fails at start (`requireDecks`, deep inside `runExperiment`) rather than
    // at the moment this scheduler already knows it cannot produce a match.
    const totalFinalists = groups.reduce((sum, group) => sum + group.decks.length, 0);
    if (totalFinalists < 2) {
      return err(
        refuse(
          'admin/schema',
          `This selection freezes only ${String(totalFinalists)} finalist deck(s) in total, and a ` +
            'mirrored round-robin needs at least two.',
        ),
      );
    }

    let config: ExperimentConfig;
    try {
      config = buildChampionshipConfig({
        experimentId: 'championship',
        seed: input.seed,
        pilots: pilots ?? [],
        gamesPerPairing: input.gamesPerPairing,
        environment: presetEnvironmentConfig(),
        groups,
      });
    } catch (cause) {
      if (cause instanceof PresetRefused) return err(cause.errors);
      throw cause;
    }

    const origin: JobOrigin = {
      kind: 'commander_championship',
      sourceBatchId: input.batchId,
      finalists: finalistOrigins,
    };

    const batch = await this.#store.createBatch({
      label: `Commander Search finalist championship (from ${input.batchId})`.slice(0, 120),
    });
    if (isErr(batch)) return batch;

    const created = await this.#store.createJob({
      batchId: batch.value.batchId,
      label: 'Frozen finalist championship',
      purpose: 'validation',
      sourceClasses: canonicalSourceClasses(['ai', 'search']),
      config,
      origin,
    });
    if (isErr(created)) return created;

    return ok({ batchId: batch.value.batchId });
  }
}
