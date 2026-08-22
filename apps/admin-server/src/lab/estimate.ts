import {
  FORCED_INCLUSION_CAVEAT,
  combineBases,
  matchCountEstimateSchema,
  type DeckCount,
  type EstimateBasis,
  type EstimateStage,
  type ForcedInclusionFloor,
  type MatchCountEstimate,
  type PresetChoiceInput,
} from '@tcg/admin-contracts';
import {
  buildSchedule,
  matchesBetween,
  poolReportFor,
  resolveDeckSource,
  resolveEnvironment,
  type DeckSource,
  type Environment,
  type ExperimentConfig,
  type ScheduleDeck,
  type ScheduledMatch,
} from '@tcg/simulator';

import { PresetRefused, expandPreset, scrubRefusal, type ExpandedStage } from './expand.js';

/**
 * How much work a configuration schedules, counted through `buildSchedule`.
 *
 * ADR 0023 §2 is the whole design: *the match-count estimator M08.3 needs is
 * derived from `buildSchedule` — the function that produces the real schedule —
 * rather than from a formula written a second time next to it.* So this module
 * contains no arithmetic about tuples, rotations, pilot pairings or sampling. It
 * builds the schedule the run will build and counts what comes back, and where a
 * run filters its schedule down to the pairings it actually needs, it applies
 * `matchesBetween` — the same predicate, extracted in M08.3 so there is one of
 * it rather than three.
 *
 * ## Why placeholder decks are honest here
 *
 * A schedule's *shape* is a function of how many decks there are, not of which
 * cards are in them: `buildSchedule` reads exactly one field of a deck, its
 * hash, and uses it to derive seeds and a tuple identity. So counting a schedule
 * needs `n` distinct hashes and nothing else, which is why `ScheduleDeck` was
 * narrowed to that one field rather than the estimator inventing forty card IDs
 * per deck. The count is the real count; only the seeds differ, and no seed is
 * reported.
 *
 * The *number* of decks is a different question, and the honest answers to it
 * differ by source. Named precons are resolved for real, against the environment
 * the run will use, so a refused precon is a refusal here rather than a surprise
 * an hour in. A generated population is a request rather than a promise — the
 * generator can yield fewer decks than asked for — so it is an upper bound and
 * says so, and nothing here generates a population to find out, because a UI
 * estimate that spent a minute building two thousand decks would not be an
 * estimate.
 */

/* ------------------------------------------------------------- placeholders */

/**
 * `n` decks that are distinct and nothing else.
 *
 * Distinct because two decks with one hash would collapse into one tuple and
 * under-count; opaque because anything else would be a fiction that could be
 * mistaken for a deck. The prefix says what they are in any debugger.
 */
function placeholderDecks(count: number): ScheduleDeck[] {
  return Array.from({ length: Math.max(0, count) }, (_, index) => ({
    hash: `estimate-deck-${String(index).padStart(6, '0')}`,
  }));
}

/** Matches grouped by the orientation `buildSchedule` stamped on each one. */
function seatOrdersOf(
  schedule: readonly ScheduledMatch[],
  repeats: number,
): EstimateStage['seatOrders'] {
  const counts = new Map<number, number>();
  for (const match of schedule) {
    counts.set(match.orientation, (counts.get(match.orientation) ?? 0) + repeats);
  }
  return [...counts.entries()]
    .sort(([left], [right]) => left - right)
    .map(([orientation, matches]) => ({ orientation, matches }));
}

/* -------------------------------------------------------------- deck counts */

/**
 * How many decks a source puts on the table, and how sure that is.
 *
 * The one place the estimator touches content. `resolveDeckSource` is the
 * simulator's own resolution — the same call `runExperiment` makes — so a precon
 * that this environment refuses is refused here in the same words.
 */
export function deckCountFor(
  source: DeckSource,
  environment: Environment,
  seed: string,
): DeckCount {
  switch (source.kind) {
    case 'precon': {
      const resolved = resolveDeckSource(source, environment, `${seed}|decks`);
      return {
        count: resolved.decks.length,
        source: 'resolved_precons',
        basis: 'exact',
        rejected: resolved.rejected.map((entry) =>
          scrubRefusal(`${entry.id}: ${entry.reasons.join('; ')}`).slice(0, 200),
        ),
      };
    }
    case 'inline': {
      const resolved = resolveDeckSource(source, environment, `${seed}|decks`);
      return {
        count: resolved.decks.length,
        source: 'resolved_inline',
        basis: 'exact',
        rejected: resolved.rejected.map((entry) =>
          scrubRefusal(`${entry.id}: ${entry.reasons.join('; ')}`).slice(0, 200),
        ),
      };
    }
    case 'generated':
      // Deliberately not generated. The yield can fall short of the request when
      // the pool refuses a draw, and building two thousand decks to find out
      // would make an estimate cost more than a smoke run.
      return {
        count: source.count,
        source: 'requested_generation',
        basis: 'upper_bound',
        rejected: [],
      };
    case 'files':
      // ADR 0023 §5: a request names identifiers, so the admin surface has no
      // directory to resolve these against. A configuration that arrived by
      // another route can still be estimated, as a bound on what its files hold.
      return {
        count: source.paths.length,
        source: 'declared_files',
        basis: 'upper_bound',
        rejected: [],
      };
    default: {
      const never: never = source;
      throw new Error(`Unknown deck source: ${JSON.stringify(never)}`);
    }
  }
}

/** The reason text a non-exact deck count gives the stage that depends on it. */
const DECK_COUNT_REASONS: Readonly<Record<DeckCount['source'], string>> = Object.freeze({
  resolved_precons: '',
  resolved_inline: '',
  requested_generation:
    'The population is generated at run time and can come out smaller than requested when ' +
    'the legal pool refuses a draw, so fewer decks means fewer pairings.',
  declared_files:
    'The deck files are not resolvable from the admin surface, so this counts every path the ' +
    'configuration names and cannot know how many of them hold a legal deck.',
  search_population:
    'The opponent field is drawn from an archive that overlaps the current population, so ' +
    'some of the pairings this counts collapse into one deck playing itself.',
});

/* ------------------------------------------------------- forced inclusion */

/**
 * The forced-inclusion floor for every Commander a configuration can seat.
 *
 * Read from `poolReportFor`, which owns the arithmetic. Two Commanders are
 * reported once: the floor is a property of a Commander and a format, not of how
 * many decks happen to run it.
 */
export function forcedInclusionFor(
  environment: Environment,
  commanderIds: readonly string[],
): ForcedInclusionFloor[] {
  const byId = new Map(environment.commanders.map((card) => [card.id, card] as const));
  const seen = new Set<string>();
  const floors: ForcedInclusionFloor[] = [];
  for (const id of commanderIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const commander = byId.get(id);
    if (!commander) continue;
    floors.push({ ...poolReportFor(environment, commander) });
  }
  return floors.sort((left, right) => left.commanderId.localeCompare(right.commanderId));
}

/** Which Commanders a configuration can put on the table, resolved rather than guessed. */
function commandersOf(config: ExperimentConfig, environment: Environment): string[] {
  const fromSource = (source: DeckSource | undefined): string[] => {
    if (source === undefined) return [];
    if (source.kind === 'inline') return source.decks.map((deck) => deck.commanderId);
    if (source.kind === 'precon') {
      return resolveDeckSource(source, environment, `${config.seed}|decks`).decks.map(
        (deck) => deck.commanderId,
      );
    }
    if (source.kind === 'generated') return [...source.generator.commanderIds];
    return [];
  };

  switch (config.kind) {
    case 'batch':
    case 'robustness':
      return fromSource(config.decks);
    case 'search':
      // An unconstrained search chooses its own Commanders, and every legal one
      // is a Commander it can choose — which is the honest set to show a floor for.
      return config.generator.commanderIds.length > 0
        ? [...config.generator.commanderIds]
        : environment.commanders.map((card) => card.id);
    case 'comparison':
      return fromSource(config.referenceDecks);
    case 'replacement':
      return [...fromSource(config.baseDecks), ...fromSource(config.opponentDecks)];
    default: {
      const never: never = config;
      throw new Error(`Unknown experiment kind: ${JSON.stringify(never)}`);
    }
  }
}

/* ------------------------------------------------------------ stage counts */

interface StageIdentity {
  readonly stageId: string;
  readonly label: string;
  readonly purpose: EstimateStage['purpose'];
}

/**
 * One evaluation round of a search, counted the way `evaluate` builds it.
 *
 * Every argument here comes from the search configuration, and the schedule is
 * built with the same pairing mode, seat mirroring and games-per-opponent the
 * real generation uses. What makes it a bound rather than a count is the deck
 * *set*: the opponent field is selected from an archive that overlaps the
 * population, so the real generation sometimes has fewer distinct decks than
 * this counts. It never has more.
 */
function searchRoundSchedule(options: {
  readonly experimentId: string;
  readonly seed: string;
  readonly environmentId: string;
  readonly populationSize: number;
  readonly opponentsPerEvaluation: number;
  readonly gamesPerOpponent: number;
  readonly pilots: ExperimentConfig['pilots'];
}): ScheduledMatch[] {
  const contenders = placeholderDecks(options.populationSize);
  const opponents = placeholderDecks(options.opponentsPerEvaluation).map((deck) => ({
    hash: `opponent-${deck.hash}`,
  }));
  const decks = [...contenders, ...opponents];
  if (decks.length < 2) return [];

  const schedule = buildSchedule({
    experimentId: options.experimentId,
    experimentSeed: options.seed,
    environmentId: options.environmentId,
    decks,
    pilots: options.pilots,
    pilotPairing: 'mirror',
    playerCount: 2,
    gamesPerPairing: options.gamesPerOpponent,
    mirrorSeats: true,
    schedule: 'round_robin',
    sampledPairings: 10_000,
  });
  return matchesBetween(
    schedule,
    decks,
    new Set(contenders.map((deck) => deck.hash)),
    new Set(opponents.map((deck) => deck.hash)),
  );
}

function stageOf(
  identity: StageIdentity,
  kind: EstimateStage['kind'],
  schedule: readonly ScheduledMatch[],
  options: {
    readonly repeats: number;
    readonly decks: DeckCount;
    readonly gamesPerSeatOrder: number;
    readonly pilotTuples: number;
    readonly basis: EstimateBasis;
    readonly reason: string;
  },
): EstimateStage {
  const seatOrders = seatOrdersOf(schedule, options.repeats);
  return {
    ...identity,
    kind,
    matches: schedule.length * options.repeats,
    basis: options.basis,
    reason: options.reason,
    seatOrders,
    gamesPerSeatOrder: options.gamesPerSeatOrder,
    decks: options.decks,
    pilotTuples: options.pilotTuples,
    repeats: options.repeats,
  };
}

/** How many pilot tuples a schedule has, read off the schedule rather than computed. */
function pilotTupleCount(schedule: readonly ScheduledMatch[]): number {
  return new Set(schedule.map((match) => match.variantKey)).size;
}

/* ------------------------------------------------------ the config estimate */

/**
 * The stages one experiment configuration schedules.
 *
 * Exported because M08.3's acceptance is about *configurations*, not only about
 * presets: a hand-authored config estimated here has to produce the number the
 * run produces, and the test that proves it calls this and `buildSchedule` side
 * by side.
 */
export function estimateConfig(
  config: ExperimentConfig,
  identity: StageIdentity,
  environment: Environment,
): EstimateStage[] {
  switch (config.kind) {
    case 'batch': {
      const decks = deckCountFor(config.decks, environment, config.seed);
      const schedule = buildSchedule({
        experimentId: config.id,
        experimentSeed: config.seed,
        environmentId: environment.id,
        decks: placeholderDecks(decks.count),
        pilots: config.pilots,
        pilotPairing: config.pilotPairing,
        playerCount: config.playerCount,
        gamesPerPairing: config.gamesPerPairing,
        mirrorSeats: config.mirrorSeats,
        schedule: config.schedule,
        sampledPairings: config.sampledPairings,
        includeMirrorMatchups: config.orderedMatchupMatrix,
      });
      return [
        stageOf(identity, 'batch', schedule, {
          repeats: 1,
          decks,
          gamesPerSeatOrder: config.gamesPerPairing,
          pilotTuples: pilotTupleCount(schedule),
          basis: decks.basis,
          reason: DECK_COUNT_REASONS[decks.source],
        }),
      ];
    }

    case 'robustness': {
      const decks = deckCountFor(config.decks, environment, config.seed);
      // `published` is always an arm, whether or not the configuration lists it,
      // and every arm plays the identical schedule on the identical seeds.
      const profiles = [...new Set(['published', ...config.profiles])];
      const schedule = buildSchedule({
        experimentId: config.id,
        experimentSeed: config.seed,
        environmentId: environment.id,
        decks: placeholderDecks(decks.count),
        pilots: config.pilots,
        pilotPairing: config.pilotPairing,
        playerCount: config.playerCount,
        gamesPerPairing: config.gamesPerPairing,
        mirrorSeats: config.mirrorSeats,
        schedule: config.schedule,
        sampledPairings: config.sampledPairings,
        pairedSeeds: true,
      });
      return [
        stageOf(
          {
            ...identity,
            label: `${identity.label} — ${String(profiles.length)} profiles`,
          },
          'robustness',
          schedule,
          {
            repeats: profiles.length,
            decks,
            gamesPerSeatOrder: config.gamesPerPairing,
            pilotTuples: pilotTupleCount(schedule),
            basis: decks.basis,
            reason: DECK_COUNT_REASONS[decks.source],
          },
        ),
      ];
    }

    case 'search': {
      const decks: DeckCount = {
        count: config.populationSize + config.opponentsPerEvaluation,
        source: 'search_population',
        basis: 'upper_bound',
        rejected: [],
      };
      const schedule = searchRoundSchedule({
        experimentId: config.id,
        seed: config.seed,
        environmentId: environment.id,
        populationSize: config.populationSize,
        opponentsPerEvaluation: config.opponentsPerEvaluation,
        gamesPerOpponent: config.gamesPerOpponent,
        pilots: config.pilots,
      });
      return [
        stageOf(
          {
            ...identity,
            label:
              `${identity.label} — ${String(config.replicates)} replicate(s) × ` +
              `${String(config.generations)} generations`,
          },
          'search',
          schedule,
          {
            repeats: config.replicates * config.generations,
            decks,
            gamesPerSeatOrder: config.gamesPerOpponent,
            pilotTuples: pilotTupleCount(schedule),
            basis: 'upper_bound',
            reason: DECK_COUNT_REASONS.search_population,
          },
        ),
      ];
    }

    case 'comparison': {
      const decks = deckCountFor(config.referenceDecks, environment, config.seed);
      // The reference population is the decks legal in *both* environments, and
      // the candidate's legality cannot be known without resolving it, so the
      // baseline's count is an upper bound on the shared one.
      const referenceSchedule = buildSchedule({
        experimentId: config.id,
        experimentSeed: config.seed,
        environmentId: environment.id,
        decks: placeholderDecks(decks.count),
        pilots: config.pilots,
        pilotPairing: config.pilotPairing,
        playerCount: config.playerCount,
        gamesPerPairing: config.gamesPerPairing,
        mirrorSeats: config.mirrorSeats,
        schedule: 'round_robin',
        sampledPairings: 100_000,
        pairedSeeds: true,
      });
      const stages: EstimateStage[] = [
        stageOf(
          {
            ...identity,
            stageId: `${identity.stageId}-reference`,
            label: `${identity.label} — reference decks in both environments`,
          },
          'comparison',
          referenceSchedule,
          {
            // One arm per environment: baseline and candidate.
            repeats: 2,
            decks,
            gamesPerSeatOrder: config.gamesPerPairing,
            pilotTuples: pilotTupleCount(referenceSchedule),
            basis: 'upper_bound',
            reason:
              'The reference population is the decks legal in both environments, and a deck ' +
              'the candidate refuses is dropped from both arms so they stay comparable.',
          },
        ),
      ];

      if (config.searchBothEnvironments) {
        const searchSchedule = searchRoundSchedule({
          experimentId: config.id,
          seed: config.seed,
          environmentId: environment.id,
          populationSize: config.search.populationSize,
          opponentsPerEvaluation: config.search.opponentsPerEvaluation,
          gamesPerOpponent: config.search.gamesPerOpponent,
          pilots: config.pilots,
        });
        stages.push(
          stageOf(
            {
              ...identity,
              stageId: `${identity.stageId}-search`,
              label:
                `${identity.label} — independent search in both environments, ` +
                `${String(config.search.replicates)} replicate(s) × ${String(config.search.generations)} generations`,
            },
            'comparison',
            searchSchedule,
            {
              // Two environments × replicates × generations.
              repeats: 2 * config.search.replicates * config.search.generations,
              decks: {
                count: config.search.populationSize + config.search.opponentsPerEvaluation,
                source: 'search_population',
                basis: 'upper_bound',
                rejected: [],
              },
              gamesPerSeatOrder: config.search.gamesPerOpponent,
              pilotTuples: pilotTupleCount(searchSchedule),
              basis: 'upper_bound',
              reason: DECK_COUNT_REASONS.search_population,
            },
          ),
        );
      }
      return stages;
    }

    case 'replacement': {
      const base = deckCountFor(config.baseDecks, environment, config.seed);
      const opponents = deckCountFor(config.opponentDecks, environment, config.seed);
      // No variants are counted at all. How many a replacement builds depends on
      // which comparable cards the builder finds and which base decks run the
      // subject, and every variant it does build adds matches — so what is
      // counted here is the arms against the field with no variants, which is a
      // floor rather than a target.
      const decks = [
        ...placeholderDecks(base.count),
        ...placeholderDecks(opponents.count).map((deck) => ({ hash: `opponent-${deck.hash}` })),
      ];
      const schedule =
        decks.length < config.playerCount
          ? []
          : matchesBetween(
              buildSchedule({
                experimentId: config.id,
                experimentSeed: config.seed,
                environmentId: environment.id,
                decks,
                pilots: config.pilots,
                pilotPairing: config.pilotPairing,
                playerCount: config.playerCount,
                gamesPerPairing: config.gamesPerPairing,
                mirrorSeats: config.mirrorSeats,
                schedule: 'round_robin',
                sampledPairings: 100_000,
              }),
              decks,
              new Set(placeholderDecks(base.count).map((deck) => deck.hash)),
              new Set(placeholderDecks(opponents.count).map((deck) => `opponent-${deck.hash}`)),
            );
      return [
        stageOf(identity, 'replacement', schedule, {
          repeats: 1,
          decks: {
            count: base.count + opponents.count,
            source: base.source,
            basis: 'at_least',
            rejected: [...base.rejected, ...opponents.rejected],
          },
          gamesPerSeatOrder: config.gamesPerPairing,
          pilotTuples: pilotTupleCount(schedule),
          basis: 'at_least',
          reason:
            'How many replacement variants exist depends on which comparable cards the builder ' +
            'finds and which base decks run the subject card. Each variant adds matches, so ' +
            'this counts the arms against the opponent field and nothing else.',
        }),
      ];
    }

    default: {
      const never: never = config;
      throw new Error(`Unknown experiment kind: ${JSON.stringify(never)}`);
    }
  }
}

/* ------------------------------------------------------------- the answers */

/** Assembles stages, floors and limitations into one validated estimate. */
function assemble(
  stages: readonly EstimateStage[],
  forcedInclusion: readonly ForcedInclusionFloor[],
  limitations: readonly string[],
): MatchCountEstimate {
  const notes = [...limitations];
  if (forcedInclusion.some((floor) => floor.forcedInclusionFloor > 0)) {
    notes.push(FORCED_INCLUSION_CAVEAT);
  }
  return matchCountEstimateSchema.parse({
    totalMatches: stages.reduce((sum, stage) => sum + stage.matches, 0),
    basis: combineBases(stages.map((stage) => stage.basis)),
    stages,
    forcedInclusion,
    limitations: [...new Set(notes)],
  });
}

/**
 * What one already-validated configuration schedules, on its own.
 *
 * The entry point for a configuration that did not come from a preset — the one
 * M08.4 will hold a job against, and the one the equivalence tests drive.
 */
export function estimateExperiment(config: ExperimentConfig): MatchCountEstimate {
  const environment = resolveEnvironment(
    config.kind === 'comparison' ? config.baseline : config.environment,
  );
  const stages = estimateConfig(
    config,
    { stageId: 'matches', label: config.label || config.id, purpose: 'exploration' },
    environment,
  );
  return assemble(stages, forcedInclusionFor(environment, commandersOf(config, environment)), []);
}

export interface PresetEstimate {
  readonly expansion: ReturnType<typeof expandPreset>['expansion'];
  readonly estimate: MatchCountEstimate;
  /** The validated configurations, kept server-side for the tranche that runs them. */
  readonly stages: readonly ExpandedStage[];
}

/**
 * What a preset choice schedules: expand it, then count what it expanded into.
 *
 * One call rather than two, because an estimate of an expansion nobody validated
 * is an estimate of a run that might never start — and `expandPreset` throwing
 * `PresetRefused` is what makes that impossible rather than unlikely.
 */
export function estimatePreset(input: PresetChoiceInput | unknown): PresetEstimate {
  const expanded = expandPreset(input);
  const stages: EstimateStage[] = [];
  const commanders: string[] = [];

  for (const stage of expanded.stages) {
    const environment = resolveEnvironment(
      stage.config.kind === 'comparison' ? stage.config.baseline : stage.config.environment,
    );
    stages.push(
      ...estimateConfig(
        stage.config,
        { stageId: stage.stageId, label: stage.label, purpose: stage.purpose },
        environment,
      ),
    );
    commanders.push(...commandersOf(stage.config, environment));
  }

  const limitations = [...expanded.expansion.limitations];
  for (const deferred of expanded.expansion.deferredStages) {
    limitations.push(`"${deferred.label}" is not scheduled: ${deferred.reason}`);
  }

  return {
    expansion: expanded.expansion,
    estimate: assemble(stages, forcedInclusionFor(expanded.environment, commanders), limitations),
    stages: expanded.stages,
  };
}

export { PresetRefused };
