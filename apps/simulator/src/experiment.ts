import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { perturbPilot, type PilotSpec } from '@tcg/bot-interface';
import type {
  BatchConfig,
  ComparisonConfig,
  ExperimentConfig,
  ReplacementConfig,
  RobustnessConfig,
  SearchConfig,
} from './config.js';
import {
  checkDeclaredChanges,
  diffEnvironments,
  resolveEnvironment,
  type DeclaredDiffCheck,
  type Environment,
} from './environment.js';
import { freezeEnvironment, serializeSnapshot, snapshotFileName } from './resolved-environment.js';
import { resolveDeckSource, type ResolvedPrecon } from './deck-source.js';
import { buildMatchupMatrix, matchupMatrixRows, type MatchupMatrix } from './matchup-matrix.js';
import { buildSchedule } from './schedule.js';
import { runBatch, type BatchProgress } from './run-batch.js';
import { runSearch, type GenerationReport, type SearchCheckpoint } from './deck-search/evolve.js';
import { generatePopulation } from './deck-search/generate.js';
import { aggregate, type Aggregate } from './analysis/aggregate.js';
import { aggregateBoard, type BoardAggregate } from './analysis/board.js';
import { clusterDecks, type ClusteringResult } from './analysis/clusters.js';
import { cardPairs, type CardPair } from './analysis/pairs.js';
import { analyzeInclusion, type InclusionAnalysis } from './analysis/inclusion.js';
import { opponentFieldSensitivity, type OpponentSensitivity } from './analysis/sensitivity.js';
import { counterBreadth, type CounterBreadth } from './analysis/counters.js';
import {
  analyzeDisplacement,
  type Displacement,
  type DisplacementReplicate,
} from './analysis/displacement.js';
import { analyzeRobustness, type RobustnessReport } from './analysis/robustness.js';
import { describeMultiplicity, type Multiplicity } from './analysis/paired.js';
import {
  buildInsertionVariant,
  buildReplacementVariant,
  comparableCards,
  replacementImpact,
  type ReplacementImpact,
  type ReplacementVariant,
} from './analysis/replacement.js';
import { compareEnvironments, type ComparisonReport } from './analysis/compare.js';
import { computeFlags, type Flag, type SupportLimits } from './analysis/flags.js';
import { analyzeMechanicSupport, supportLimitsOf } from './analysis/support.js';
import { analyzeAgentClasses, agentEvidenceOf } from './analysis/agent-classes.js';
import { REPORT_SCHEMA_VERSION, renderReport } from './reporting/report.js';
import { experimentPaths, ensureDir, writeCsv, writeJson } from './reporting/sinks.js';
import { MatchStore } from './reporting/match-store.js';
import { SEED_DERIVATION_VERSION } from './seed.js';
import { TELEMETRY_SCHEMA_VERSION, isAbnormal, type MatchRecord } from './telemetry/schema.js';
import {
  assertSharedPopulation,
  freezeReferencePopulation,
  type ReferencePopulation,
} from './reference-population.js';
import type { SimDeck } from './deck-search/deck.js';
import { HASH_VERSION, digestOf } from './hash.js';
import { ANALYSIS_STATS_VERSION } from './analysis/paired.js';

/**
 * Runs a whole experiment and writes its directory (CLAUDE.md §13.13).
 *
 * The directory is the deliverable: `manifest.json` and `config.json` say what
 * was run, `matches.jsonl` holds the raw records every derived number is
 * computed from, the CSVs are for eyeballing, and `report.md` is the written
 * interpretation. Deleting `summary.json` and `report.md` and re-deriving them
 * from `matches.jsonl` must reproduce them exactly.
 *
 * Every experiment kind — batch, replacement, search, comparison and
 * robustness — opens exactly one `MatchStore` and streams into it, so all five
 * are equally resumable and none of them accumulates a whole run in memory just
 * to write a final array (PHASE4_HARDENING §7).
 */

export interface RunExperimentOptions {
  readonly configPath?: string;
  readonly outputDir?: string;
  readonly workers?: number;
  readonly resume?: boolean;
  readonly softwareCommit?: string | null;
  readonly onProgress?: (progress: BatchProgress) => void;
  readonly onGeneration?: (report: GenerationReport) => void;
}

export interface ExperimentOutcome {
  readonly outputDir: string;
  readonly records: readonly MatchRecord[];
  readonly aggregate: Aggregate;
  /** The batch's unlimited-board reading, over every record (M04.3). */
  readonly board: BoardAggregate;
  readonly clustering: ClusteringResult;
  readonly inclusion: InclusionAnalysis;
  readonly pairs: readonly CardPair[];
  readonly replacements: readonly ReplacementImpact[];
  readonly sensitivity: readonly OpponentSensitivity[];
  readonly displacement: readonly Displacement[];
  readonly counters: CounterBreadth | null;
  readonly robustness: RobustnessReport | null;
  /** The ordered matchup matrix, when the batch asked for one (M03.4). */
  readonly matchupMatrix: MatchupMatrix | null;
  readonly flags: readonly Flag[];
  readonly comparison: ComparisonReport | null;
  readonly searchHistory: readonly GenerationReport[];
  readonly referencePopulation: ReferencePopulation | null;
  readonly report: string;
  readonly resumedMatches: number;
  readonly elapsedMs: number;
}

export function detectSoftwareCommit(): string | null {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Identity of the normalized configuration.
 *
 * Everything that changes what an experiment *is* feeds in; nothing that only
 * changes where or how fast it runs does. That is what lets `--workers 8` resume
 * a run started with `--workers 1` while a changed seed or threshold is refused.
 */
export function configHashOf(config: ExperimentConfig): string {
  const {
    workers: _workers,
    output: _output,
    ...semantic
  } = config as ExperimentConfig & {
    workers: number;
    output: string;
  };
  return digestOf({
    version: 1,
    telemetry: TELEMETRY_SCHEMA_VERSION,
    seeds: SEED_DERIVATION_VERSION,
    hashes: HASH_VERSION,
    stats: ANALYSIS_STATS_VERSION,
    config: semantic,
  });
}

export async function runExperiment(
  config: ExperimentConfig,
  options: RunExperimentOptions = {},
): Promise<ExperimentOutcome> {
  switch (config.kind) {
    case 'batch':
      return runBatchExperiment(config, options);
    case 'replacement':
      return runReplacementExperiment(config, options);
    case 'search':
      return runSearchExperiment(config, options);
    case 'comparison':
      return runComparisonExperiment(config, options);
    case 'robustness':
      return runRobustnessExperiment(config, options);
    default: {
      const never: never = config;
      throw new Error(`Unknown experiment kind: ${JSON.stringify(never)}`);
    }
  }
}

/** Opens the one raw-record stream this experiment writes into. */
function openStore(
  config: ExperimentConfig,
  outputDir: string,
  options: RunExperimentOptions,
): MatchStore {
  return new MatchStore(outputDir, {
    experimentId: config.id,
    experimentKind: config.kind,
    configHash: configHashOf(config),
    ...(options.resume === undefined ? {} : { resume: options.resume }),
  });
}

/* ------------------------------------------------------------------- batch */

async function runBatchExperiment(
  config: BatchConfig,
  options: RunExperimentOptions,
): Promise<ExperimentOutcome> {
  const started = Date.now();
  const environment = resolveEnvironment(config.environment);
  const outputDir = options.outputDir ?? join(config.output, config.id);
  const workers = options.workers ?? config.workers;
  const store = openStore(config, outputDir, options);

  const resolved = resolveDeckSource(
    config.decks,
    environment,
    `${config.seed}|decks`,
    options.configPath ? dirOf(options.configPath) : '.',
  );
  requireDecks(resolved.decks, config.playerCount, resolved.rejected);

  const schedule = buildSchedule({
    experimentId: config.id,
    experimentSeed: config.seed,
    environmentId: environment.id,
    decks: resolved.decks,
    pilots: config.pilots,
    pilotPairing: config.pilotPairing,
    playerCount: config.playerCount,
    gamesPerPairing: config.gamesPerPairing,
    mirrorSeats: config.mirrorSeats,
    schedule: config.schedule,
    sampledPairings: config.sampledPairings,
    // The matrix is the one schedule that seats a deck against itself: its
    // diagonal is four of the sixteen ordered pairs, not a rounding error (M03.4).
    includeMirrorMatchups: config.orderedMatchupMatrix,
  });

  const batch = await runBatch({
    experimentId: config.id,
    experimentKind: 'batch',
    configHash: configHashOf(config),
    arm: null,
    environment,
    decks: resolved.decks,
    pilots: config.pilots,
    schedule,
    limits: config.limits,
    retention: config.retention,
    workers,
    failFast: config.failFast,
    softwareCommit: options.softwareCommit ?? detectSoftwareCommit(),
    sink: store,
    replayDir: join(outputDir, 'replays'),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  return finish({
    config,
    outputDir,
    store,
    environments: [environment],
    decks: resolved.decks,
    precons: resolved.precons,
    replacements: [],
    comparison: null,
    searchHistory: [],
    workers,
    elapsedMs: Date.now() - started,
    failedMatches: batch.failures.length,
    ...(config.orderedMatchupMatrix ? { orderedMatchupMatrix: true } : {}),
    extraLimitations: [
      ...(config.orderedMatchupMatrix
        ? [
            'The ordered matchup matrix is a smoke and robustness artifact: it shows that every ' +
              'ordered pair of these decks terminates cleanly, and says nothing about which deck ' +
              'is stronger. Balance conclusions wait for M05.',
          ]
        : []),
      ...resolved.rejected.map(
        (entry) => `Deck "${entry.id}" was rejected as illegal: ${entry.reasons.join('; ')}`,
      ),
      ...batch.failures.map((entry) => `Match ${entry.matchId} failed to run: ${entry.message}`),
    ],
  });
}

/* ------------------------------------------------------------- replacement */

async function runReplacementExperiment(
  config: ReplacementConfig,
  options: RunExperimentOptions,
): Promise<ExperimentOutcome> {
  const started = Date.now();
  const environment = resolveEnvironment(config.environment);
  const outputDir = options.outputDir ?? join(config.output, config.id);
  const workers = options.workers ?? config.workers;
  const configDir = options.configPath ? dirOf(options.configPath) : '.';
  const store = openStore(config, outputDir, options);

  const baseSource = resolveDeckSource(
    config.baseDecks,
    environment,
    `${config.seed}|base`,
    configDir,
  );
  const opponentSource = resolveDeckSource(
    config.opponentDecks,
    environment,
    `${config.seed}|opponents`,
    configDir,
  );
  requireDecks(baseSource.decks, 1, baseSource.rejected);
  requireDecks(opponentSource.decks, 1, opponentSource.rejected);

  const notes: string[] = [];
  const variants: { deck: SimDeck; variant: ReplacementVariant }[] = [];

  for (const base of baseSource.decks) {
    if (!base.cards.some((entry) => entry.cardId === config.subjectCardId)) {
      if (!config.includeInsertion) continue;
      // A card no deck runs cannot be measured by taking it out of one. The
      // insertion arm is the other half of the controlled experiment: put the
      // card in, pay for the slots with comparable cards, and replay the same
      // seeded games (CLAUDE.md §13.10, readiness §3 A1).
      const inserted = buildInsertionVariant(
        base,
        environment,
        config.subjectCardId,
        config.insertionCopies,
        config.insertionRemoveCardIds.length > 0
          ? { removeCardIds: config.insertionRemoveCardIds }
          : {},
      );
      if (!inserted.deck || !inserted.variant) {
        notes.push(
          `Could not insert ${config.subjectCardId} into "${base.id}": ${inserted.reasons.join('; ')}`,
        );
        continue;
      }
      variants.push({ deck: inserted.deck, variant: inserted.variant });
      continue;
    }
    const commander = environment.database.get(base.commanderId);
    const candidates =
      config.candidateCardIds.length > 0
        ? config.candidateCardIds
        : comparableCards(environment, config.subjectCardId, commander?.colorIdentity ?? []).map(
            (card) => card.id,
          );

    const targets: (string | null)[] = candidates.length > 0 ? [...candidates] : [null];
    for (const replacement of targets) {
      const built = buildReplacementVariant(
        base,
        environment,
        config.subjectCardId,
        replacement,
        config.copies,
      );
      if (!built.deck || !built.variant) {
        notes.push(
          `Could not build "${base.id}" with ${config.subjectCardId} → ${replacement ?? 'nothing'}: ${built.reasons.join('; ')}`,
        );
        continue;
      }
      variants.push({ deck: built.deck, variant: built.variant });
    }
  }

  if (variants.length === 0) {
    throw new Error(
      `No legal replacement variant could be built for "${config.subjectCardId}". ` +
        `Reasons: ${notes.join(' | ') || 'no base deck runs the card'}`,
    );
  }

  // Both arms play the same opponents on the same seed paths, so the only thing
  // that differs between them is the swapped card (CLAUDE.md §13.10).
  const armDecks = [
    ...baseSource.decks,
    ...variants.map((entry) => entry.deck),
    ...opponentSource.decks,
  ];
  const uniqueDecks = dedupeDecks(armDecks);
  const armSeedHashes = [
    ...baseSource.decks.map((deck) => deck.hash),
    ...variants.map((entry) => entry.deck.hash),
  ];

  const schedule = buildSchedule({
    experimentId: config.id,
    experimentSeed: config.seed,
    environmentId: environment.id,
    decks: uniqueDecks,
    pilots: config.pilots,
    pilotPairing: config.pilotPairing,
    playerCount: config.playerCount,
    gamesPerPairing: config.gamesPerPairing,
    mirrorSeats: config.mirrorSeats,
    schedule: 'round_robin',
    sampledPairings: 100_000,
    // Both arms play the same shuffles against the same opponents.
    seedIgnoreDeckHashes: armSeedHashes,
  });

  // Only the pairings we actually need: a subject or variant deck against an
  // opponent-field deck. Everything else would be sampling noise paid for twice.
  const opponentHashes = new Set(opponentSource.decks.map((deck) => deck.hash));
  const armHashes = new Set([
    ...baseSource.decks.map((deck) => deck.hash),
    ...variants.map((entry) => entry.deck.hash),
  ]);
  const relevant = schedule.filter((match) => {
    const hashes = match.seats.map((seat) => uniqueDecks[seat.deckIndex]?.hash ?? '');
    return (
      hashes.some((hash) => armHashes.has(hash)) && hashes.some((hash) => opponentHashes.has(hash))
    );
  });

  const batch = await runBatch({
    experimentId: config.id,
    experimentKind: 'replacement',
    configHash: configHashOf(config),
    arm: null,
    environment,
    decks: uniqueDecks,
    pilots: config.pilots,
    schedule: relevant,
    limits: config.limits,
    retention: config.retention,
    workers,
    failFast: config.failFast,
    softwareCommit: options.softwareCommit ?? detectSoftwareCommit(),
    sink: store,
    replayDir: join(outputDir, 'replays'),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  const records = store.all();
  const impacts = variants.map((entry) =>
    replacementImpact(entry.variant, records, records, {
      confidence: config.analysis.confidence,
      minMatches: config.analysis.minMatchesPerCard,
      minPairs: config.analysis.minPairedGames,
      iterations: config.analysis.bootstrapIterations,
      seed: `${config.seed}|replacement`,
    }),
  );

  // Card-level counter evidence, but only when the experiment actually declared
  // what the substitutions are supposed to answer (PHASE4_HARDENING §10.2).
  const targetHashes = opponentSource.decks
    .filter(
      (deck) =>
        config.counterTargetDeckIds.includes(deck.id) ||
        config.counterTargetDeckIds.includes(deck.label),
    )
    .map((deck) => deck.hash);

  if (config.counterTargetDeckIds.length > 0 && targetHashes.length === 0) {
    notes.push(
      `None of the declared counter targets (${config.counterTargetDeckIds.join(', ')}) matched an ` +
        'opponent deck ID or label, so counter breadth is reported as unavailable.',
    );
  }

  return finish({
    config,
    outputDir,
    store,
    environments: [environment],
    decks: uniqueDecks,
    precons: [...baseSource.precons, ...opponentSource.precons],
    replacements: impacts,
    comparison: null,
    searchHistory: [],
    workers,
    elapsedMs: Date.now() - started,
    failedMatches: batch.failures.length,
    extraLimitations: [
      ...notes,
      ...batch.failures.map((entry) => `Match ${entry.matchId} failed to run: ${entry.message}`),
    ],
    counterTargets: targetHashes,
    counterVariants: variants.map((entry) => entry.variant),
  });
}

/* ------------------------------------------------------------------ search */

async function runSearchExperiment(
  config: SearchConfig,
  options: RunExperimentOptions,
): Promise<ExperimentOutcome> {
  const started = Date.now();
  const environment = resolveEnvironment(config.environment);
  const outputDir = options.outputDir ?? join(config.output, config.id);
  const workers = options.workers ?? config.workers;
  const paths = experimentPaths(outputDir);
  const store = openStore(config, outputDir, options);
  ensureDir(paths.checkpoints);

  const seedSource = config.seedDecks
    ? resolveDeckSource(
        config.seedDecks,
        environment,
        `${config.seed}|seed-decks`,
        options.configPath ? dirOf(options.configPath) : '.',
      )
    : null;
  const seeded = seedSource?.decks ?? [];

  const history: GenerationReport[] = [];
  const replicateResults: DisplacementReplicate[] = [];
  const allDecks: SimDeck[] = [];
  const diagnostics: string[] = [];

  // Independent replicates, each on its own seed family. One evolutionary run is
  // one sample of a stochastic process; replicates are what make the difference
  // between "this card disappeared" and "this card disappears" (§11).
  for (let replicate = 0; replicate < config.replicates; replicate += 1) {
    const label = `r${replicate}`;
    const replicateSeed = `${config.seed}|replicate:${replicate}`;

    const generated = generatePopulation(
      environment,
      `${replicateSeed}|population`,
      Math.max(0, config.populationSize - seeded.length),
      config.generator,
    );
    diagnostics.push(...generated.diagnostics.map((entry) => `${entry.code}: ${entry.message}`));

    const population = dedupeDecks([...seeded, ...generated.decks]);
    requireDecks(population, 2, []);

    const search = await runSearch(population, {
      experimentId: config.replicates > 1 ? `${config.id}:${label}` : config.id,
      experimentSeed: replicateSeed,
      experimentKind: 'search',
      configHash: configHashOf(config),
      armPrefix: `search:${label}`,
      sink: store,
      replayDir: join(outputDir, 'replays'),
      environment,
      pilots: config.pilots,
      limits: config.limits,
      retention: config.retention,
      workers,
      populationSize: config.populationSize,
      generations: config.generations,
      eliteCount: config.eliteCount,
      mutationStrength: config.mutationStrength,
      crossoverShare: config.crossoverShare,
      opponentsPerEvaluation: config.opponentsPerEvaluation,
      gamesPerOpponent: config.gamesPerOpponent,
      archiveSize: config.archiveSize,
      reevaluateElites: config.reevaluateElites,
      outputDir,
      checkpointEvery: config.checkpointEvery,
      onGeneration: (report: GenerationReport, checkpoint: SearchCheckpoint) => {
        history.push(report);
        options.onGeneration?.(report);
        if (report.generation % config.checkpointEvery === 0) {
          writeJson(
            join(
              paths.checkpoints,
              `${label}-generation-${String(report.generation).padStart(3, '0')}.json`,
            ),
            checkpoint,
          );
        }
      },
    });

    replicateResults.push({ label, decks: [...search.archive] });
    allDecks.push(...search.population, ...search.archive);
  }

  return finish({
    config,
    outputDir,
    store,
    environments: [environment],
    decks: dedupeDecks(allDecks),
    precons: seedSource?.precons ?? [],
    replacements: [],
    comparison: null,
    searchHistory: history,
    workers,
    elapsedMs: Date.now() - started,
    extraLimitations: [
      'Search results describe what the pilots could exploit, not what a human could. ' +
        'A discovered deck is a lead to investigate, never a conclusion.',
      ...(config.replicates < config.analysis.minDisplacementReplicates
        ? [
            `This search ran ${config.replicates} replicate(s). Displacement and obsolescence ` +
              `claims need ${config.analysis.minDisplacementReplicates}; below that, a change in ` +
              'inclusion cannot be told apart from the search’s own run-to-run variance.',
          ]
        : []),
      ...diagnostics,
    ],
    searchReplicates: replicateResults,
  });
}

/* -------------------------------------------------------------- comparison */

async function runComparisonExperiment(
  config: ComparisonConfig,
  options: RunExperimentOptions,
): Promise<ExperimentOutcome> {
  const started = Date.now();
  const baseline = resolveEnvironment(config.baseline);
  const candidate = resolveEnvironment(config.candidate);
  const outputDir = options.outputDir ?? join(config.output, config.id);
  const workers = options.workers ?? config.workers;
  const configDir = options.configPath ? dirOf(options.configPath) : '.';
  const commit = options.softwareCommit ?? detectSoftwareCommit();
  const hash = configHashOf(config);
  const store = openStore(config, outputDir, options);

  const diff = diffEnvironments(baseline, candidate);

  // Gate the whole run on the declaration *before* spending any CPU. An
  // experiment whose flagship claim is unverifiable is worse than no experiment:
  // it produces a plausible report about a change that did not happen (§4).
  const declaredCheck = checkDeclaredChanges(diff, config.declaredChanges);
  if (!declaredCheck.ok) {
    throw new Error(
      `The comparison "${config.id}" does not measure what it declares:\n` +
        declaredCheck.errors.map((message) => `  - ${message}`).join('\n') +
        '\n\nFix `declaredChanges` or the candidate environment so the declaration and the ' +
        'resolved card pools agree.',
    );
  }

  // One population, resolved once, replayed in both environments (§6).
  const population = freezeReferencePopulation({
    source: config.referenceDecks,
    baseline,
    candidate,
    seed: `${config.seed}|reference`,
    configDir,
  });
  writeJson(experimentPaths(outputDir).referencePopulation, population);

  const notes: string[] = [
    ...declaredCheck.warnings.map((message) => `**Undeclared environment difference:** ${message}`),
    ...population.excluded.map(
      (entry) =>
        `Reference deck "${entry.deckId}" was excluded for being illegal in "${entry.environmentId}": ` +
        `${entry.reasons.join('; ')}`,
    ),
  ];

  let failedMatches = 0;

  const runReference = async (
    environment: Environment,
    arm: 'baseline' | 'candidate',
  ): Promise<readonly MatchRecord[]> => {
    if (population.decks.length < config.playerCount) {
      notes.push(
        `Only ${population.decks.length} reference deck(s) are legal in both environments, below ` +
          `the ${config.playerCount} needed for a match. The reference comparison was skipped ` +
          'entirely — note that this is skipped for *both* arms, so the two remain comparable.',
      );
      return [];
    }

    const schedule = buildSchedule({
      experimentId: config.id,
      experimentSeed: config.seed,
      environmentId: environment.id,
      decks: population.decks,
      pilots: config.pilots,
      pilotPairing: config.pilotPairing,
      playerCount: config.playerCount,
      gamesPerPairing: config.gamesPerPairing,
      mirrorSeats: config.mirrorSeats,
      schedule: 'round_robin',
      sampledPairings: 100_000,
      // Common random numbers: the seed path deliberately drops the environment,
      // so the same deck pair and game index gets the same shuffle in both runs.
      pairedSeeds: true,
    });

    const batch = await runBatch({
      experimentId: config.id,
      experimentKind: 'comparison',
      configHash: hash,
      arm,
      environment,
      decks: population.decks,
      pilots: config.pilots,
      schedule,
      limits: config.limits,
      retention: config.retention,
      workers,
      failFast: config.failFast,
      softwareCommit: commit,
      sink: store,
      replayDir: join(outputDir, 'replays'),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    failedMatches += batch.failures.length;
    for (const failure of batch.failures) {
      notes.push(`Match ${failure.matchId} (${arm}) failed to run: ${failure.message}`);
    }
    return batch.records;
  };

  await runReference(baseline, 'baseline');
  await runReference(candidate, 'candidate');

  const baselineRecords = store.arm('baseline');
  const candidateRecords = store.arm('candidate');

  // Both arms were driven from `population`; this checks the invariant held
  // rather than assuming it (§6 step 6).
  assertSharedPopulation(
    populationOf(baselineRecords, population),
    populationOf(candidateRecords, population),
    `Comparison "${config.id}"`,
  );

  let baselineSearch: SimDeck[] | undefined;
  let candidateSearch: SimDeck[] | undefined;
  let baselineScores: Map<string, number> | undefined;
  let candidateScores: Map<string, number> | undefined;
  const searchHistory: GenerationReport[] = [];
  const baselineReplicates: DisplacementReplicate[] = [];
  const candidateReplicates: DisplacementReplicate[] = [];

  if (config.searchBothEnvironments) {
    for (const [environment, label] of [
      [baseline, 'baseline'],
      [candidate, 'candidate'],
    ] as const) {
      const archives: SimDeck[] = [];
      for (let replicate = 0; replicate < config.search.replicates; replicate += 1) {
        const replicateSeed = `${config.seed}|search:${label}:${replicate}`;
        const generated = generatePopulation(
          environment,
          `${replicateSeed}|population`,
          config.search.populationSize,
          config.search.generator,
        );
        if (generated.decks.length < 2) continue;

        const result = await runSearch(generated.decks, {
          experimentId: `${config.id}:${label}:r${replicate}`,
          experimentSeed: replicateSeed,
          experimentKind: 'comparison',
          configHash: hash,
          armPrefix: `search:${label}:r${replicate}`,
          sink: store,
          replayDir: join(outputDir, 'replays'),
          environment,
          pilots: config.pilots,
          limits: config.limits,
          retention: config.retention,
          workers,
          populationSize: config.search.populationSize,
          generations: config.search.generations,
          eliteCount: config.search.eliteCount,
          mutationStrength: config.search.mutationStrength,
          crossoverShare: config.search.crossoverShare,
          opponentsPerEvaluation: config.search.opponentsPerEvaluation,
          gamesPerOpponent: config.search.gamesPerOpponent,
          archiveSize: config.search.archiveSize,
          reevaluateElites: true,
          outputDir: null,
          checkpointEvery: 1,
          onGeneration: (report) => {
            searchHistory.push(report);
          },
        });

        const replicateLabel = `${label}-r${replicate}`;
        const bucket = label === 'baseline' ? baselineReplicates : candidateReplicates;
        bucket.push({ label: replicateLabel, decks: [...result.archive] });
        archives.push(...result.archive);

        const scores = new Map(
          result.fitness.map((entry) => [entry.deckHash, entry.score] as const),
        );
        if (label === 'baseline') {
          baselineScores = new Map([...(baselineScores ?? []), ...scores]);
        } else {
          candidateScores = new Map([...(candidateScores ?? []), ...scores]);
        }
      }
      if (label === 'baseline') baselineSearch = dedupeDecks(archives);
      else candidateSearch = dedupeDecks(archives);
    }
  }

  const displacement =
    baselineReplicates.length > 0 && candidateReplicates.length > 0
      ? analyzeDisplacement({
          baseline: baselineReplicates,
          candidate: candidateReplicates,
          changedCardIds: [...diff.cardsAdded, ...diff.cardsChanged.map((entry) => entry.cardId)],
          candidatePoolCardIds: candidate.pool.map((card) => card.id),
          settings: config.analysis,
        })
      : [];

  const comparison = compareEnvironments({
    diff,
    declaredDiffCheck: declaredCheck,
    referencePopulationHash: population.hash,
    referenceDecksExcluded: population.excluded,
    baselineRecords,
    candidateRecords,
    ...(baselineSearch ? { baselineSearchDecks: baselineSearch } : {}),
    ...(candidateSearch ? { candidateSearchDecks: candidateSearch } : {}),
    ...(baselineScores ? { baselineSearchScores: baselineScores } : {}),
    ...(candidateScores ? { candidateSearchScores: candidateScores } : {}),
    confidence: config.analysis.confidence,
    minMatches: config.analysis.minMatchesPerDeck,
    minPairs: config.analysis.minPairedGames,
    bootstrapIterations: config.analysis.bootstrapIterations,
    seed: `${config.seed}|compare`,
    displacement,
  });

  return finish({
    config,
    outputDir,
    store,
    environments: [baseline, candidate],
    decks: dedupeDecks([
      ...population.decks,
      ...(candidateSearch ?? []),
      ...(baselineSearch ?? []),
    ]),
    precons: population.precons,
    replacements: [],
    comparison,
    searchHistory,
    diff,
    declaredCheck,
    workers,
    elapsedMs: Date.now() - started,
    failedMatches,
    extraLimitations: notes,
    referencePopulation: population,
    displacement,
  });
}

/** The population identity the records actually exercised. */
function populationOf(records: readonly MatchRecord[], population: ReferencePopulation): string {
  if (records.length === 0) return population.hash;
  const hashes = new Set<string>();
  for (const record of records) for (const seat of record.seats) hashes.add(seat.deckHash);
  const known = new Set(population.decks.map((deck) => deck.hash));
  // Only decks belonging to the frozen population count; a record from a
  // searched arm is a different question and is filtered out by its arm label
  // before this point.
  return [...hashes].every((hash) => known.has(hash)) ? population.hash : 'divergent';
}

/* -------------------------------------------------------------- robustness */

async function runRobustnessExperiment(
  config: RobustnessConfig,
  options: RunExperimentOptions,
): Promise<ExperimentOutcome> {
  const started = Date.now();
  const environment = resolveEnvironment(config.environment);
  const outputDir = options.outputDir ?? join(config.output, config.id);
  const workers = options.workers ?? config.workers;
  const hash = configHashOf(config);
  const store = openStore(config, outputDir, options);

  const resolved = resolveDeckSource(
    config.decks,
    environment,
    `${config.seed}|decks`,
    options.configPath ? dirOf(options.configPath) : '.',
  );
  requireDecks(resolved.decks, config.playerCount, resolved.rejected);

  // `published` is always the reference arm, whether or not it was listed.
  const profiles = [...new Set(['published', ...config.profiles])];

  const arms: { profileId: string; records: readonly MatchRecord[] }[] = [];
  const armNotes: string[] = [];
  let failedMatches = 0;
  for (const profileId of profiles) {
    const pilots: PilotSpec[] = config.pilots.map((pilot) => perturbPilot(pilot, profileId));

    // Identical schedule shape and identical seed path in every arm: the seed
    // deliberately does not depend on the profile, so every profile plays the
    // same shuffles and a difference between arms is the pilots and nothing else.
    const schedule = buildSchedule({
      experimentId: config.id,
      experimentSeed: config.seed,
      environmentId: environment.id,
      decks: resolved.decks,
      pilots,
      pilotPairing: config.pilotPairing,
      playerCount: config.playerCount,
      gamesPerPairing: config.gamesPerPairing,
      mirrorSeats: config.mirrorSeats,
      schedule: config.schedule,
      sampledPairings: config.sampledPairings,
      pairedSeeds: true,
    });

    const batch = await runBatch({
      experimentId: `${config.id}:${profileId}`,
      experimentKind: 'robustness',
      configHash: hash,
      arm: `profile:${profileId}`,
      environment,
      decks: resolved.decks,
      pilots,
      schedule,
      limits: config.limits,
      retention: config.retention,
      workers,
      failFast: config.failFast,
      softwareCommit: options.softwareCommit ?? detectSoftwareCommit(),
      sink: store,
      replayDir: join(outputDir, 'replays'),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    failedMatches += batch.failures.length;
    for (const failure of batch.failures) {
      armNotes.push(
        `Match ${failure.matchId} (profile ${profileId}) failed to run: ${failure.message}`,
      );
    }
    arms.push({ profileId, records: store.arm(`profile:${profileId}`) });
  }

  // Each profile is analysed on its own records. Pooling them would average away
  // the disagreement the experiment exists to find (§10.3).
  // The same limits every profile is judged under, so the profiles stay
  // comparable and no arm claims a review signal the run's support cannot
  // carry (M05.1).
  const profileSupport = supportLimitsOf(
    analyzeMechanicSupport({
      decks: resolved.decks,
      database: environment.database,
      pilotIds: config.pilots.map((pilot: PilotSpec) => pilot.id),
    }),
  );
  // Likewise for the agent class: perturbing a heuristic's weights changes how
  // it plays, never what class of agent it is, so every arm is judged under one
  // set of claim limits (M05.4).
  const profileAgents = agentEvidenceOf(
    analyzeAgentClasses({ pilotIds: config.pilots.map((pilot: PilotSpec) => pilot.id) }),
  );

  const perProfile = arms.map((arm) => {
    const agg = aggregate(arm.records, { confidence: config.analysis.confidence });
    const clustering = clusterDecks(resolved.decks, environment.database, arm.records, {
      confidence: config.analysis.confidence,
    });
    const inclusion = analyzeInclusion(resolved.decks, clustering, arm.records, config.analysis);
    return {
      profileId: arm.profileId,
      aggregate: agg,
      clustering,
      flags: computeFlags({
        aggregate: agg,
        clustering,
        pairs: [],
        replacements: [],
        settings: config.analysis,
        inclusion,
        support: profileSupport,
        agentEvidence: profileAgents,
        deckCount: resolved.decks.length,
      }),
    };
  });

  const robustness = analyzeRobustness(perProfile, config.analysis);

  return finish({
    config,
    outputDir,
    store,
    environments: [environment],
    decks: resolved.decks,
    precons: resolved.precons,
    replacements: [],
    comparison: null,
    searchHistory: [],
    workers,
    elapsedMs: Date.now() - started,
    failedMatches,
    extraLimitations: [
      'Headline statistics come from the `published` profile alone. The other profiles are ' +
        'analysed separately in the robustness section and are never pooled into one population, ' +
        'because a merged population would average away the disagreement being measured.',
      ...resolved.rejected.map(
        (entry) => `Deck "${entry.id}" was rejected as illegal: ${entry.reasons.join('; ')}`,
      ),
      ...armNotes,
    ],
    robustness,
    /** The reference arm alone, for the headline statistics. */
    primaryArm: 'profile:published',
  });
}

/* ---------------------------------------------------------------- finishing */

interface FinishInputs {
  readonly config: ExperimentConfig;
  readonly outputDir: string;
  readonly store: MatchStore;
  readonly environments: readonly Environment[];
  readonly decks: readonly SimDeck[];
  /** Precons the deck sources named by ID. Empty when none did. */
  readonly precons: readonly ResolvedPrecon[];
  readonly replacements: readonly ReplacementImpact[];
  readonly comparison: ComparisonReport | null;
  readonly searchHistory: readonly GenerationReport[];
  readonly workers: number;
  readonly elapsedMs: number;
  /** Matches whose runner threw outright and produced no record at all. */
  readonly failedMatches?: number;
  readonly extraLimitations?: readonly string[];
  readonly diff?: ReturnType<typeof diffEnvironments>;
  readonly declaredCheck?: DeclaredDiffCheck;
  readonly referencePopulation?: ReferencePopulation;
  readonly displacement?: readonly Displacement[];
  readonly searchReplicates?: readonly DisplacementReplicate[];
  readonly robustness?: RobustnessReport;
  readonly counterTargets?: readonly string[];
  readonly counterVariants?: readonly ReplacementVariant[];
  /** Restrict the headline statistics to one arm. Used by robustness runs. */
  readonly primaryArm?: string;
  /** Build and write the ordered matchup matrix from this run's records (M03.4). */
  readonly orderedMatchupMatrix?: boolean;
}

function finish(inputs: FinishInputs): ExperimentOutcome {
  const { config } = inputs;
  const paths = experimentPaths(inputs.outputDir);
  const primary = inputs.environments[0];
  if (!primary) throw new Error('An experiment needs at least one environment.');

  // Freeze every environment the run used, content-addressed (readiness §9 G1).
  // `config.json` alone is only a recipe: it resolves against whatever card data
  // the checkout happens to hold, so an experiment kept for six months would
  // silently re-resolve to edited cards while still carrying its original hashes.
  // The snapshots are the record. Computed here so the manifest and the report
  // can name the files they are about to sit beside.
  const snapshots = inputs.environments.map((environment) => freezeEnvironment(environment));
  const snapshotPaths = snapshots.map((snapshot) => `environments/${snapshotFileName(snapshot)}`);

  const allRecords = inputs.store.all();
  const records =
    inputs.primaryArm === undefined ? allRecords : inputs.store.arm(inputs.primaryArm);

  const settings = config.analysis;
  const agg = aggregate(records, { confidence: settings.confidence });
  // Over `allRecords`, unlike every other analysis here: a match that hit the
  // turn limit is the strongest stall candidate in a batch and usually holds its
  // widest board, so excluding abnormal matches would bias the one question board
  // telemetry exists to answer (M04.3). The report says which population it is.
  const boardAggregate = aggregateBoard(allRecords);
  const clustering = clusterDecks(inputs.decks, primary.database, records, {
    confidence: settings.confidence,
  });
  const inclusion = analyzeInclusion(inputs.decks, clustering, records, settings);
  const pairs = cardPairs(records, {
    minSupport: settings.minPairSupport,
    minCellSupport: settings.minPairCellSupport,
    confidence: settings.confidence,
    iterations: settings.bootstrapIterations,
    seed: `${config.seed}|pairs`,
  });
  const sensitivity = opponentFieldSensitivity({ records, clustering, settings });

  const counters =
    inputs.counterTargets && inputs.counterTargets.length > 0
      ? counterBreadth({
          records,
          clustering,
          settings,
          seed: `${config.seed}|counters`,
          targetDeckHashes: inputs.counterTargets,
          targetLabel: 'the declared counter target',
          ...(inputs.counterVariants ? { variants: inputs.counterVariants } : {}),
        })
      : null;

  // A search experiment's own replicates feed the same displacement analysis a
  // comparison uses; with one replicate it correctly returns insufficient evidence.
  const displacement =
    inputs.displacement ??
    (inputs.searchReplicates && inputs.searchReplicates.length > 1
      ? analyzeDisplacement({
          baseline: [inputs.searchReplicates[0] as DisplacementReplicate],
          candidate: inputs.searchReplicates.slice(1),
          changedCardIds: [],
          candidatePoolCardIds: primary.pool.map((card) => card.id),
          settings,
        })
      : []);

  // Derived from the mechanic support registry and the decks that actually
  // played, so a report can state what its own evidence is worth before it
  // states anything else (M05.1).
  const mechanicSupport = analyzeMechanicSupport({
    decks: inputs.decks,
    database: primary.database,
    pilotIds: config.pilots.map((pilot: PilotSpec) => pilot.id),
  });
  const supportLimits: SupportLimits = {
    legalOnlyPilots: mechanicSupport.legalOnlyPilots,
    pilotBlindCards: mechanicSupport.pilotBlindCards,
    telemetryBlindCards: mechanicSupport.telemetryBlindCards,
  };

  // What class of agent flew it, and therefore which of the flags below this run
  // is entitled to make at all (M05.4). Independent of the support reading
  // above: supported cards played by a random pilot are still not evidence
  // about play.
  const agentClasses = analyzeAgentClasses({
    pilotIds: config.pilots.map((pilot: PilotSpec) => pilot.id),
  });

  const flags = computeFlags({
    aggregate: agg,
    clustering,
    pairs,
    replacements: inputs.replacements,
    settings,
    inclusion,
    sensitivity,
    support: supportLimits,
    agentEvidence: agentEvidenceOf(agentClasses),
    deckCount: inputs.decks.length,
    ...(displacement.length > 0 ? { displacement } : {}),
    ...(counters ? { counters } : {}),
  });

  // How wide the scan was, so a reader can weigh a long flag list correctly (§9.3).
  const multiplicity: Multiplicity = describeMultiplicity(
    agg.cards.length + pairs.length + clustering.clusters.length,
    flags.filter((flag) => flag.level === 'review_recommended').length,
    1 - settings.confidence,
  );

  // Pilot versions come from the records rather than the config, so the report
  // names the pilot that actually played rather than the one that was requested.
  const pilotVersions = new Map<string, string>();
  for (const record of allRecords) {
    for (const seat of record.seats) {
      if (!pilotVersions.has(seat.pilotId)) pilotVersions.set(seat.pilotId, seat.pilotVersion);
    }
  }
  const reportPilots = [...new Set(config.pilots.map((pilot: PilotSpec) => pilot.id))]
    .sort()
    .map((id) => ({ id, version: pilotVersions.get(id) ?? 'not recorded' }));

  const abnormalMatches = allRecords
    .filter((record) => isAbnormal(record.termination))
    .map((record) => ({
      matchId: record.matchId,
      termination: record.termination,
      replayPath: record.replayPath ?? null,
    }));

  // Sorted by ID so the manifest and the report are byte-stable however the
  // deck sources happened to be ordered.
  const precons = [...inputs.precons].sort((left, right) =>
    left.preconId.localeCompare(right.preconId),
  );

  // Built from the same records every other number here comes from, and from
  // `allRecords` rather than the primary arm, so an abnormal match still appears
  // in the cell it belongs to instead of vanishing from the grid (M03.4).
  const matchupMatrix = inputs.orderedMatchupMatrix
    ? buildMatchupMatrix({
        experimentId: config.id,
        seed: config.seed,
        configHash: configHashOf(config),
        environmentId: primary.id,
        environmentHash: primary.hash,
        // The *construction* format the precons were reviewed against, which is
        // what a precon ID is only meaningful under. The pool the environment
        // resolved is pinned separately by its hash and its frozen snapshot.
        formatId: primary.deckFormat.formatId,
        decks: inputs.decks,
        precons,
        records: allRecords,
      })
    : null;

  const report = renderReport({
    title: config.label || `${config.kind} experiment "${config.id}"`,
    experimentId: config.id,
    kind: config.kind,
    seed: config.seed,
    configHash: configHashOf(config),
    softwareCommit: records[0]?.softwareCommit ?? null,
    rulesVersion: primary.rulesConfig.version,
    seedDerivationVersion: SEED_DERIVATION_VERSION,
    telemetrySchemaVersion: TELEMETRY_SCHEMA_VERSION,
    analysisStatsVersion: ANALYSIS_STATS_VERSION,
    environmentSummaries: inputs.environments.map((environment, index) => ({
      id: environment.id,
      hash: environment.hash,
      cardPoolHash: environment.cardPoolHash,
      hashes: environment.hashes,
      label: environment.label,
      snapshotPath: snapshotPaths[index] ?? null,
    })),
    settings,
    aggregate: agg,
    board: boardAggregate,
    mechanicSupport,
    agentClasses,
    clustering,
    inclusion,
    pairs,
    replacements: inputs.replacements,
    sensitivity,
    displacement,
    multiplicity,
    flags,
    matchesPath: 'matches.jsonl',
    resumedMatches: inputs.store.resumedCount,
    recoveredLines: inputs.store.recovered.length,
    failedMatches: inputs.failedMatches ?? 0,
    abnormalMatches,
    ...(inputs.counterVariants || counters ? { counters } : {}),
    ...(inputs.robustness ? { robustness: inputs.robustness } : {}),
    ...(matchupMatrix ? { matchupMatrix } : {}),
    ...(inputs.diff ? { diff: inputs.diff } : {}),
    ...(inputs.declaredCheck ? { declaredCheck: inputs.declaredCheck } : {}),
    ...(inputs.referencePopulation ? { referencePopulation: inputs.referencePopulation } : {}),
    ...(inputs.comparison ? { comparison: inputs.comparison } : {}),
    searchHistory: inputs.searchHistory,
    deckCount: inputs.decks.length,
    precons,
    pilots: reportPilots,
    wallClockMs: inputs.elapsedMs,
    workers: inputs.workers,
    ...(inputs.extraLimitations ? { extraLimitations: inputs.extraLimitations } : {}),
  });

  ensureDir(paths.root);
  writeJson(paths.config, config);

  ensureDir(paths.environments);
  for (const snapshot of snapshots) {
    // Canonical serialization, so a snapshot's file name and its bytes agree:
    // two runs that resolved the same content produce the same file.
    writeFileText(
      join(paths.environments, snapshotFileName(snapshot)),
      serializeSnapshot(snapshot),
    );
  }
  const primarySnapshot = snapshots[0];
  if (primarySnapshot) writeJson(paths.resolvedEnvironment, primarySnapshot);

  writeJson(paths.manifest, {
    // 4 (M03.4): an ordered-matchup-matrix run records the artifact beside the
    // hashes, including whether it was complete and whether every cell
    // terminated cleanly. Absent for every other run.
    //
    // 5 (M05.1): every manifest carries `mechanicSupport` — the weakest engine,
    // help, pilot and telemetry support reached by each deck that played, the
    // mechanics responsible, and whether the pilots were legality-only. A v4
    // manifest cannot be migrated to it: the reading was never taken, and the
    // registry it is taken against did not exist.
    //
    // 6 (M05.4): every manifest carries `agentClasses` — the honest agent class
    // of every pilot that flew, and claim by claim what the run may and may not
    // be cited for. Not migratable from v5 for the same reason: the taxonomy did
    // not exist, and a v5 manifest's pilot list cannot be read against it
    // without assuming today's classification held then.
    schemaVersion: 6,
    experimentId: config.id,
    kind: config.kind,
    seed: config.seed,
    configHash: configHashOf(config),
    seedDerivationVersion: SEED_DERIVATION_VERSION,
    hashVersion: HASH_VERSION,
    telemetrySchemaVersion: TELEMETRY_SCHEMA_VERSION,
    analysisStatsVersion: ANALYSIS_STATS_VERSION,
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    rulesVersion: primary.rulesConfig.version,
    softwareCommit: records[0]?.softwareCommit ?? null,
    environments: inputs.environments.map((environment, index) => ({
      id: environment.id,
      label: environment.label,
      hash: environment.hash,
      cardPoolHash: environment.cardPoolHash,
      // All four, because each answers a different question and a reader
      // checking one guarantee should not have to recompute the others (§9 G3).
      hashes: environment.hashes,
      poolSize: environment.pool.length,
      commanders: environment.commanders.length,
      formatId: environment.formatId,
      sets: environment.sets,
      snapshotPath: snapshotPaths[index] ?? null,
    })),
    ...(inputs.referencePopulation
      ? {
          referencePopulationHash: inputs.referencePopulation.hash,
          referenceDecksKept: inputs.referencePopulation.decks.length,
          referenceDecksExcluded: inputs.referencePopulation.excluded.length,
        }
      : {}),
    deckHashes: inputs.decks.map((deck) => deck.hash).sort(),
    /**
     * Precons the run was configured from, by permanent ID (M03.3).
     *
     * The IDs alone would not be reproducible — a shipped precon can be
     * re-authored — so each one is recorded beside the hash of the deck it
     * actually resolved to, and the environment hashes above pin the card
     * definitions those IDs named on the day the run happened.
     */
    precons,
    /**
     * What the mechanics these decks are built from let this run claim (M05.1).
     *
     * Derived from `@tcg/card-data`'s mechanic support registry and the decks
     * that actually played, never from a card's own `implemented` flag, so a
     * reader can tell "the pilots played this badly" from "no pilot values this
     * at all" without opening the report. `registryVersion` pins the
     * classification the reading was taken against.
     */
    mechanicSupport,
    /**
     * What class of agent flew this run, and what it may be cited for (M05.4).
     *
     * Beside `mechanicSupport` because the two are independent halves of "is
     * this evidence": one is about the cards, one is about the player.
     * `registryVersion` pins the taxonomy the citation was made against, and
     * `pilots` records the classification of each pilot at the time rather than
     * leaving it to be re-derived from an ID by a later build.
     */
    agentClasses,
    /**
     * The ordered matchup matrix this run produced, when it was asked for (M03.4).
     *
     * The counts are here rather than only in the artifact so that "every
     * ordered pair ran and terminated cleanly" is a claim the manifest itself
     * either makes or declines to make.
     */
    ...(matchupMatrix
      ? {
          matchupMatrix: {
            path: 'matchup-matrix.json',
            schemaVersion: matchupMatrix.schemaVersion,
            expectedCells: matchupMatrix.expectedCells,
            playedCells: matchupMatrix.playedCells,
            complete: matchupMatrix.complete,
            missing: matchupMatrix.missing,
            games: matchupMatrix.games,
            cleanGames: matchupMatrix.cleanGames,
            invariantFailures: matchupMatrix.invariantFailures.length,
          },
        }
      : {}),
    rawRecordPath: 'matches.jsonl',
    matches: allRecords.length,
    abnormalMatches: inputs.store.abnormalCount,
    abnormalMatchIds: abnormalMatches.map((entry) => entry.matchId),
    failedMatches: inputs.failedMatches ?? 0,
    resumedMatches: inputs.store.resumedCount,
    recoveredLines: inputs.store.recovered,
    /** Execution settings. Non-semantic: they cannot change any result. */
    execution: { workers: inputs.workers, elapsedMs: inputs.elapsedMs },
    pilots: config.pilots,
  });
  writeJson(paths.decks, inputs.decks);
  writeJson(paths.summary, {
    // 3 (M04.3): the batch's unlimited-board reading, so the report's board
    // section is a view of the JSON like every other section rather than the only
    // place those numbers exist.
    //
    // 4 (M05.1): the mechanic support reading, for the same reason — the
    // report's support section is a view of this, and a flag downgraded for
    // missing support can be traced back to the mechanic that caused it.
    //
    // 5 (M05.4): the agent class reading, and `aggregate.run.agentClassWinRates`
    // beside the pilot rates, so the per-class outcome the report prints has a
    // machine-readable original and is never re-derived by averaging.
    schemaVersion: 5,
    configHash: configHashOf(config),
    thresholds: settings,
    aggregate: agg,
    board: boardAggregate,
    mechanicSupport,
    agentClasses,
    clusters: clustering.clusters,
    clusterMatchups: clustering.matchups,
    inclusion,
    pairs,
    replacements: inputs.replacements,
    sensitivity,
    displacement,
    counters,
    robustness: inputs.robustness ?? null,
    comparison: inputs.comparison,
    searchHistory: inputs.searchHistory,
    multiplicity,
    flags,
  });

  if (matchupMatrix) {
    writeJson(paths.matchupMatrix, matchupMatrix);
    writeCsv(paths.matchupMatrixCsv, matchupMatrixRows(matchupMatrix), [
      { header: 'first_seat_deck', value: (row) => row.firstSeatDeckId },
      { header: 'second_seat_deck', value: (row) => row.secondSeatDeckId },
      { header: 'mirror', value: (row) => row.mirror },
      { header: 'match_id', value: (row) => row.matchId },
      { header: 'game_index', value: (row) => row.gameIndex },
      { header: 'orientation', value: (row) => row.orientation },
      { header: 'starting_player', value: (row) => row.startingPlayerId },
      { header: 'seed_path', value: (row) => row.seedPath },
      { header: 'match_seed', value: (row) => row.matchSeed },
      { header: 'winner_deck', value: (row) => row.winnerDeckId },
      { header: 'winner_seat_index', value: (row) => row.winnerSeatIndex },
      { header: 'termination', value: (row) => row.termination },
      { header: 'outcome', value: (row) => row.outcome },
      { header: 'turns', value: (row) => row.turns },
      { header: 'invariant_failures', value: (row) => row.invariantFailures },
      { header: 'replay_path', value: (row) => row.replayPath },
      // The unlimited board, per cell (M04.3): a pairing that consistently
      // stalls or consistently produces a sixty-attacker combat is visible here
      // and nowhere else, because every ordered pair appears exactly once.
      { header: 'peak_units', value: (row) => row.peakUnits },
      { header: 'peak_token_stack', value: (row) => row.peakTokenStack },
      { header: 'longest_turn_actions', value: (row) => row.longestTurnActions },
      { header: 'largest_combat_attackers', value: (row) => row.largestCombatAttackers },
      { header: 'busiest_turn_triggers', value: (row) => row.busiestTurnTriggers },
      { header: 'stall_classification', value: (row) => row.stallClassification },
      { header: 'stall_streak', value: (row) => row.stallStreak },
    ]);
  }

  writeCsv(paths.cardUsage, agg.cards, [
    { header: 'card_id', value: (row) => row.definitionId },
    { header: 'decks_including', value: (row) => row.decksIncluding },
    { header: 'seat_matches', value: (row) => row.seatMatches },
    { header: 'copies_per_deck', value: (row) => row.copiesPerDeck },
    { header: 'win_rate_included', value: (row) => row.winRateWhenIncluded.point },
    { header: 'win_rate_absent', value: (row) => row.winRateWhenAbsent.point },
    { header: 'inclusion_lift', value: (row) => row.inclusionWinRateLift },
    { header: 'draw_rate', value: (row) => row.drawRate },
    { header: 'plays_per_draw', value: (row) => row.playsPerDraw },
    { header: 'drawn_copy_play_conversion', value: (row) => row.drawnCopyPlayConversion },
    { header: 'games_drawn_and_played_share', value: (row) => row.gamesDrawnAndPlayedShare },
    { header: 'games_drawn', value: (row) => row.gamesDrawn },
    { header: 'dead_in_hand_share', value: (row) => row.deadInHandShare },
    { header: 'mechanically_unusable_share', value: (row) => row.mechanicallyUnusableShare },
    { header: 'strategically_unused_share', value: (row) => row.strategicallyUnusedShare },
    { header: 'dead_unseen', value: (row) => row.deadHand.unseen ?? 0 },
    { header: 'dead_never_affordable', value: (row) => row.deadHand.never_affordable ?? 0 },
    { header: 'dead_no_capacity', value: (row) => row.deadHand.no_capacity ?? 0 },
    { header: 'dead_no_legal_target', value: (row) => row.deadHand.no_legal_target ?? 0 },
    { header: 'dead_no_legal_window', value: (row) => row.deadHand.no_legal_window ?? 0 },
    { header: 'dead_legal_but_unchosen', value: (row) => row.deadHand.legal_but_unchosen ?? 0 },
    { header: 'dead_held_at_end', value: (row) => row.deadHand.held_at_end ?? 0 },
    { header: 'avg_damage_players', value: (row) => row.averageDamageToPlayers },
    { header: 'avg_damage_units', value: (row) => row.averageDamageToUnits },
    { header: 'avg_healing', value: (row) => row.averageHealing },
    { header: 'avg_cards_drawn_by', value: (row) => row.averageCardsDrawnBy },
    { header: 'avg_tokens', value: (row) => row.averageTokensCreated },
    { header: 'avg_triggers', value: (row) => row.averageTriggers },
    { header: 'avg_turns_on_board', value: (row) => row.averageTurnsOnBattlefield },
    { header: 'removal_rate', value: (row) => row.removalRate },
  ]);

  writeCsv(paths.cardPairs, pairs, [
    { header: 'card_a', value: (row) => row.cardA },
    { header: 'card_b', value: (row) => row.cardB },
    { header: 'support_both', value: (row) => row.support },
    { header: 'support_a_only', value: (row) => row.supportAOnly },
    { header: 'support_b_only', value: (row) => row.supportBOnly },
    { header: 'support_neither', value: (row) => row.supportNeither },
    { header: 'win_rate_together', value: (row) => row.winRateTogether },
    { header: 'win_rate_a_only', value: (row) => row.winRateAOnly },
    { header: 'win_rate_b_only', value: (row) => row.winRateBOnly },
    { header: 'win_rate_neither', value: (row) => row.winRateNeither },
    { header: 'interaction', value: (row) => row.interaction },
    { header: 'low', value: (row) => (Number.isFinite(row.low) ? row.low : null) },
    { header: 'high', value: (row) => (Number.isFinite(row.high) ? row.high : null) },
    { header: 'lift_over_best_single', value: (row) => row.liftOverBestSingle },
    { header: 'effect_size', value: (row) => row.effectSize },
    { header: 'effect_size_label', value: (row) => row.effectSizeLabel },
    { header: 'insufficient_evidence', value: (row) => row.insufficientEvidence },
    { header: 'sparse_cells', value: (row) => row.sparseCells.join(' ') },
  ]);

  // The §5 evidence requirement: the qualifying clusters and their individual
  // inclusion values, in a form a reader can check against `summary.json`.
  const inclusionRows = inclusion.cards.flatMap((card) =>
    card.perCluster.map((entry) => ({ card, entry })),
  );
  writeCsv(paths.clusterInclusion, inclusionRows, [
    { header: 'card_id', value: (row) => row.card.definitionId },
    { header: 'cluster_id', value: (row) => row.entry.clusterId },
    { header: 'cluster_label', value: (row) => row.entry.clusterLabel },
    { header: 'decks_in_cluster', value: (row) => row.entry.decksInCluster },
    { header: 'decks_including', value: (row) => row.entry.decksIncluding },
    { header: 'cluster_inclusion', value: (row) => row.entry.inclusion },
    { header: 'observations', value: (row) => row.entry.observations },
    { header: 'cluster_eligible', value: (row) => row.entry.eligible },
    { header: 'ineligible_reason', value: (row) => row.entry.ineligibleReason },
    { header: 'covered', value: (row) => row.entry.covered },
    { header: 'card_cross_cluster_share', value: (row) => row.card.crossClusterShare },
    { header: 'card_deck_inclusion_share', value: (row) => row.card.deckInclusionShare },
    { header: 'card_qualifies', value: (row) => row.card.qualifies },
  ]);

  const errors = allRecords
    .filter((record) => record.diagnostics.length > 0 || record.botFailures.length > 0)
    .flatMap((record) => [
      ...record.diagnostics.map((message) => ({
        matchId: record.matchId,
        arm: record.arm ?? '',
        termination: record.termination,
        kind: 'diagnostic',
        message,
        replayPath: record.replayPath ?? '',
      })),
      ...record.botFailures.map((failure) => ({
        matchId: record.matchId,
        arm: record.arm ?? '',
        termination: record.termination,
        kind: `bot_${failure.kind}`,
        message: `${failure.botId} (${failure.playerId}): ${failure.message}`,
        replayPath: record.replayPath ?? '',
      })),
    ]);
  writeCsv(paths.errors, errors, [
    { header: 'match_id', value: (row) => row.matchId },
    { header: 'arm', value: (row) => row.arm },
    { header: 'termination', value: (row) => row.termination },
    { header: 'kind', value: (row) => row.kind },
    { header: 'message', value: (row) => row.message },
    { header: 'replay_path', value: (row) => row.replayPath },
  ]);

  writeFileText(paths.report, report);
  inputs.store.flush();

  return {
    outputDir: inputs.outputDir,
    records: allRecords,
    aggregate: agg,
    board: boardAggregate,
    clustering,
    inclusion,
    pairs,
    replacements: inputs.replacements,
    sensitivity,
    displacement,
    counters,
    robustness: inputs.robustness ?? null,
    matchupMatrix,
    flags,
    comparison: inputs.comparison,
    searchHistory: inputs.searchHistory,
    referencePopulation: inputs.referencePopulation ?? null,
    report,
    resumedMatches: inputs.store.resumedCount,
    elapsedMs: inputs.elapsedMs,
  };
}

/* ------------------------------------------------------------------ helpers */

function dedupeDecks(decks: readonly SimDeck[]): SimDeck[] {
  const byHash = new Map<string, SimDeck>();
  for (const deck of decks) if (!byHash.has(deck.hash)) byHash.set(deck.hash, deck);
  return [...byHash.values()].sort((left, right) => left.hash.localeCompare(right.hash));
}

function requireDecks(
  decks: readonly SimDeck[],
  needed: number,
  rejected: readonly { readonly id: string; readonly reasons: readonly string[] }[],
): void {
  if (decks.length >= needed) return;
  const detail = rejected.map((entry) => `"${entry.id}": ${entry.reasons.join('; ')}`).join(' | ');
  throw new Error(
    `The experiment needs at least ${needed} legal deck(s) but resolved ${decks.length}.` +
      (detail ? ` Rejected decks — ${detail}` : ''),
  );
}

function dirOf(path: string): string {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index < 0 ? '.' : path.slice(0, index);
}

function writeFileText(path: string, text: string): void {
  ensureDir(dirOf(path));
  writeFileSync(path, text, 'utf8');
}
