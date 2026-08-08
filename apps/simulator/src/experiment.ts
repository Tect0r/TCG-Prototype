import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PilotSpec } from '@tcg/bot-interface';
import type {
  BatchConfig,
  ComparisonConfig,
  ExperimentConfig,
  ReplacementConfig,
  SearchConfig,
} from './config.js';
import { diffEnvironments, resolveEnvironment, type Environment } from './environment.js';
import { resolveDeckSource } from './deck-source.js';
import { buildSchedule } from './schedule.js';
import { runBatch, type BatchProgress } from './run-batch.js';
import { runSearch, type GenerationReport, type SearchCheckpoint } from './deck-search/evolve.js';
import { generatePopulation } from './deck-search/generate.js';
import { aggregate, type Aggregate } from './analysis/aggregate.js';
import { clusterDecks, type ClusteringResult } from './analysis/clusters.js';
import { cardPairs, type CardPair } from './analysis/pairs.js';
import {
  buildReplacementVariant,
  comparableCards,
  replacementImpact,
  type ReplacementImpact,
} from './analysis/replacement.js';
import { compareEnvironments, type ComparisonReport } from './analysis/compare.js';
import { computeFlags, type Flag } from './analysis/flags.js';
import { renderReport } from './reporting/report.js';
import { experimentPaths, ensureDir, writeCsv, writeJson } from './reporting/sinks.js';
import { SEED_DERIVATION_VERSION } from './seed.js';
import { TELEMETRY_SCHEMA_VERSION, type MatchRecord } from './telemetry/schema.js';
import type { SimDeck } from './deck-search/deck.js';
import { HASH_VERSION } from './hash.js';

/**
 * Runs a whole experiment and writes its directory (CLAUDE.md §13.13).
 *
 * The directory is the deliverable: `manifest.json` and `config.json` say what
 * was run, `matches.jsonl` holds the raw records every derived number is
 * computed from, the CSVs are for eyeballing, and `report.md` is the written
 * interpretation. Deleting `summary.json` and `report.md` and re-deriving them
 * from `matches.jsonl` must reproduce them exactly.
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
  readonly clustering: ClusteringResult;
  readonly pairs: readonly CardPair[];
  readonly replacements: readonly ReplacementImpact[];
  readonly flags: readonly Flag[];
  readonly comparison: ComparisonReport | null;
  readonly searchHistory: readonly GenerationReport[];
  readonly report: string;
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
    default: {
      const never: never = config;
      throw new Error(`Unknown experiment kind: ${JSON.stringify(never)}`);
    }
  }
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
  });

  const batch = await runBatch({
    experimentId: config.id,
    environment,
    decks: resolved.decks,
    pilots: config.pilots,
    schedule,
    limits: config.limits,
    retention: config.retention,
    workers,
    failFast: config.failFast,
    softwareCommit: options.softwareCommit ?? detectSoftwareCommit(),
    outputDir,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  return finish({
    config,
    outputDir,
    environments: [environment],
    decks: resolved.decks,
    records: batch.records,
    replacements: [],
    comparison: null,
    searchHistory: [],
    workers,
    elapsedMs: Date.now() - started,
    extraLimitations: [
      ...resolved.rejected.map(
        (entry) => `Deck "${entry.id}" was rejected as illegal: ${entry.reasons.join('; ')}`,
      ),
      ...batch.failures.map((entry) => `Match ${entry.matchId} failed to run: ${entry.message}`),
      ...batch.recovered.map(
        (entry) => `Recovered from a damaged record on line ${entry.line}: ${entry.reason}`,
      ),
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
  const variants: {
    deck: SimDeck;
    variant: NonNullable<ReturnType<typeof buildReplacementVariant>['variant']>;
  }[] = [];

  for (const base of baseSource.decks) {
    if (!base.cards.some((entry) => entry.cardId === config.subjectCardId)) {
      if (!config.includeInsertion) continue;
      notes.push(
        `"${base.id}" does not run ${config.subjectCardId}; it is used as an insertion control only.`,
      );
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
    environment,
    decks: uniqueDecks,
    pilots: config.pilots,
    schedule: relevant,
    limits: config.limits,
    retention: config.retention,
    workers,
    failFast: config.failFast,
    softwareCommit: options.softwareCommit ?? detectSoftwareCommit(),
    outputDir,
    ...(options.resume === undefined ? {} : { resume: options.resume }),
    ...(options.onProgress ? { onProgress: options.onProgress } : {}),
  });

  const impacts = variants.map((entry) =>
    replacementImpact(entry.variant, batch.records, batch.records, {
      confidence: config.analysis.confidence,
      minMatches: config.analysis.minMatchesPerCard,
    }),
  );

  return finish({
    config,
    outputDir,
    environments: [environment],
    decks: uniqueDecks,
    records: batch.records,
    replacements: impacts,
    comparison: null,
    searchHistory: [],
    workers,
    elapsedMs: Date.now() - started,
    extraLimitations: notes,
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
  ensureDir(paths.checkpoints);

  const seeded = config.seedDecks
    ? resolveDeckSource(
        config.seedDecks,
        environment,
        `${config.seed}|seed-decks`,
        options.configPath ? dirOf(options.configPath) : '.',
      ).decks
    : [];

  const generated = generatePopulation(
    environment,
    `${config.seed}|population`,
    Math.max(0, config.populationSize - seeded.length),
    config.generator,
  );

  const population = dedupeDecks([...seeded, ...generated.decks]);
  requireDecks(population, 2, []);

  const history: GenerationReport[] = [];
  const search = await runSearch(population, {
    experimentId: config.id,
    experimentSeed: config.seed,
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
          join(paths.checkpoints, `generation-${String(report.generation).padStart(3, '0')}.json`),
          checkpoint,
        );
      }
    },
  });

  return finish({
    config,
    outputDir,
    environments: [environment],
    decks: dedupeDecks([...search.population, ...search.archive]),
    records: search.records,
    replacements: [],
    comparison: null,
    searchHistory: history,
    workers,
    elapsedMs: Date.now() - started,
    extraLimitations: [
      'Search results describe what the pilots could exploit, not what a human could. ' +
        'A discovered deck is a lead to investigate, never a conclusion.',
      ...generated.diagnostics.map((entry) => `${entry.code}: ${entry.message}`),
    ],
    streamRecords: true,
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

  const diff = diffEnvironments(baseline, candidate);

  const runReference = async (
    environment: Environment,
    suffix: string,
  ): Promise<{ records: readonly MatchRecord[]; decks: readonly SimDeck[]; notes: string[] }> => {
    const resolved = resolveDeckSource(
      config.referenceDecks,
      environment,
      `${config.seed}|reference`,
      configDir,
    );
    const notes = resolved.rejected.map(
      (entry) =>
        `Reference deck "${entry.id}" is illegal in "${environment.id}": ${entry.reasons.join('; ')}`,
    );
    if (resolved.decks.length < config.playerCount) {
      notes.push(
        `Only ${resolved.decks.length} reference deck(s) are legal in "${environment.id}"; ` +
          'the reference comparison for that environment was skipped.',
      );
      return { records: [], decks: resolved.decks, notes };
    }

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
      schedule: 'round_robin',
      sampledPairings: 100_000,
      // Common random numbers: the seed path deliberately drops the environment,
      // so the same deck pair and game index gets the same shuffle in both runs.
      pairedSeeds: true,
    });

    const batch = await runBatch({
      experimentId: config.id,
      environment,
      decks: resolved.decks,
      pilots: config.pilots,
      schedule,
      limits: config.limits,
      retention: config.retention,
      workers,
      failFast: config.failFast,
      softwareCommit: commit,
      outputDir: join(outputDir, suffix),
      ...(options.onProgress ? { onProgress: options.onProgress } : {}),
    });
    return { records: batch.records, decks: resolved.decks, notes };
  };

  const baselineRun = await runReference(baseline, 'baseline');
  const candidateRun = await runReference(candidate, 'candidate');

  let baselineSearch: SimDeck[] | undefined;
  let candidateSearch: SimDeck[] | undefined;
  let baselineScores: Map<string, number> | undefined;
  let candidateScores: Map<string, number> | undefined;
  const searchRecords: MatchRecord[] = [];
  const searchHistory: GenerationReport[] = [];

  if (config.searchBothEnvironments) {
    for (const [environment, label] of [
      [baseline, 'baseline'],
      [candidate, 'candidate'],
    ] as const) {
      const population = generatePopulation(
        environment,
        `${config.seed}|search:${label}`,
        config.search.populationSize,
        config.search.generator,
      );
      if (population.decks.length < 2) continue;

      const result = await runSearch(population.decks, {
        experimentId: `${config.id}:${label}`,
        experimentSeed: `${config.seed}|search:${label}`,
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
          searchHistory.push({ ...report, generation: report.generation });
        },
      });

      searchRecords.push(...result.records);
      const scores = new Map(result.fitness.map((entry) => [entry.deckHash, entry.score] as const));
      if (label === 'baseline') {
        baselineSearch = [...result.archive];
        baselineScores = scores;
      } else {
        candidateSearch = [...result.archive];
        candidateScores = scores;
      }
    }
  }

  const comparison = compareEnvironments({
    diff,
    baselineRecords: baselineRun.records,
    candidateRecords: candidateRun.records,
    ...(baselineSearch ? { baselineSearchDecks: baselineSearch } : {}),
    ...(candidateSearch ? { candidateSearchDecks: candidateSearch } : {}),
    ...(baselineScores ? { baselineSearchScores: baselineScores } : {}),
    ...(candidateScores ? { candidateSearchScores: candidateScores } : {}),
    confidence: config.analysis.confidence,
    minMatches: config.analysis.minMatchesPerDeck,
  });

  return finish({
    config,
    outputDir,
    environments: [baseline, candidate],
    decks: dedupeDecks([
      ...candidateRun.decks,
      ...baselineRun.decks,
      ...(candidateSearch ?? []),
      ...(baselineSearch ?? []),
    ]),
    records: [...candidateRun.records, ...baselineRun.records, ...searchRecords],
    replacements: [],
    comparison,
    searchHistory,
    diff,
    workers,
    elapsedMs: Date.now() - started,
    extraLimitations: [...baselineRun.notes, ...candidateRun.notes],
    candidateCardIds: [...diff.cardsAdded, ...diff.cardsChanged.map((entry) => entry.cardId)],
    ...(baselineSearch ? { baselineDecks: baselineSearch } : {}),
    ...(candidateSearch ? { candidateDecks: candidateSearch } : {}),
    streamRecords: true,
  });
}

/* ---------------------------------------------------------------- finishing */

interface FinishInputs {
  readonly config: ExperimentConfig;
  readonly outputDir: string;
  readonly environments: readonly Environment[];
  readonly decks: readonly SimDeck[];
  readonly records: readonly MatchRecord[];
  readonly replacements: readonly ReplacementImpact[];
  readonly comparison: ComparisonReport | null;
  readonly searchHistory: readonly GenerationReport[];
  readonly workers: number;
  readonly elapsedMs: number;
  readonly extraLimitations?: readonly string[];
  readonly diff?: ReturnType<typeof diffEnvironments>;
  readonly candidateCardIds?: readonly string[];
  readonly baselineDecks?: readonly SimDeck[];
  readonly candidateDecks?: readonly SimDeck[];
  /** Write `matches.jsonl` here rather than relying on the batch runner. */
  readonly streamRecords?: boolean;
}

function finish(inputs: FinishInputs): ExperimentOutcome {
  const { config } = inputs;
  const paths = experimentPaths(inputs.outputDir);
  const primary = inputs.environments[0];
  if (!primary) throw new Error('An experiment needs at least one environment.');

  const agg = aggregate(inputs.records, { confidence: config.analysis.confidence });
  const clustering = clusterDecks(inputs.decks, primary.database, inputs.records, {
    confidence: config.analysis.confidence,
  });
  const pairs = cardPairs(inputs.records, {
    minSupport: config.analysis.minPairSupport,
    confidence: config.analysis.confidence,
  });

  const flags = computeFlags({
    aggregate: agg,
    clustering,
    pairs,
    replacements: inputs.replacements,
    settings: config.analysis,
    ...(inputs.candidateCardIds ? { candidateCardIds: inputs.candidateCardIds } : {}),
    ...(inputs.baselineDecks ? { baselineInclusion: inclusionOf(inputs.baselineDecks) } : {}),
    ...(inputs.candidateDecks ? { candidateInclusion: inclusionOf(inputs.candidateDecks) } : {}),
  });

  const report = renderReport({
    title: config.label || `${config.kind} experiment "${config.id}"`,
    experimentId: config.id,
    kind: config.kind,
    seed: config.seed,
    softwareCommit: inputs.records[0]?.softwareCommit ?? null,
    rulesVersion: primary.rulesConfig.version,
    environmentSummaries: inputs.environments.map((environment) => ({
      id: environment.id,
      hash: environment.hash,
      label: environment.label,
    })),
    settings: config.analysis,
    aggregate: agg,
    clustering,
    pairs,
    replacements: inputs.replacements,
    flags,
    ...(inputs.diff ? { diff: inputs.diff } : {}),
    ...(inputs.comparison ? { comparison: inputs.comparison } : {}),
    searchHistory: inputs.searchHistory,
    deckCount: inputs.decks.length,
    pilotIds: config.pilots.map((pilot: PilotSpec) => pilot.id),
    wallClockMs: inputs.elapsedMs,
    workers: inputs.workers,
    ...(inputs.extraLimitations ? { extraLimitations: inputs.extraLimitations } : {}),
  });

  ensureDir(paths.root);
  writeJson(paths.config, config);
  writeJson(paths.manifest, {
    schemaVersion: 1,
    experimentId: config.id,
    kind: config.kind,
    seed: config.seed,
    seedDerivationVersion: SEED_DERIVATION_VERSION,
    hashVersion: HASH_VERSION,
    telemetrySchemaVersion: TELEMETRY_SCHEMA_VERSION,
    rulesVersion: primary.rulesConfig.version,
    softwareCommit: inputs.records[0]?.softwareCommit ?? null,
    environments: inputs.environments.map((environment) => ({
      id: environment.id,
      label: environment.label,
      hash: environment.hash,
      cardPoolHash: environment.cardPoolHash,
      poolSize: environment.pool.length,
      commanders: environment.commanders.length,
    })),
    deckHashes: inputs.decks.map((deck) => deck.hash).sort(),
    matches: inputs.records.length,
    workers: inputs.workers,
    elapsedMs: inputs.elapsedMs,
    pilots: config.pilots,
  });
  writeJson(paths.decks, inputs.decks);
  writeJson(paths.summary, {
    schemaVersion: 1,
    aggregate: agg,
    clusters: clustering.clusters,
    clusterMatchups: clustering.matchups,
    pairs,
    replacements: inputs.replacements,
    comparison: inputs.comparison,
    searchHistory: inputs.searchHistory,
    flags,
  });

  writeCsv(paths.cardUsage, agg.cards, [
    { header: 'card_id', value: (row) => row.definitionId },
    { header: 'decks_including', value: (row) => row.decksIncluding },
    { header: 'seat_matches', value: (row) => row.seatMatches },
    { header: 'copies_per_deck', value: (row) => row.copiesPerDeck },
    { header: 'win_rate_included', value: (row) => row.winRateWhenIncluded.point },
    { header: 'win_rate_absent', value: (row) => row.winRateWhenAbsent.point },
    { header: 'inclusion_lift', value: (row) => row.inclusionWinRateLift },
    { header: 'draw_rate', value: (row) => row.drawRate },
    { header: 'play_rate_per_drawn', value: (row) => row.playRatePerDrawn },
    { header: 'dead_in_hand_share', value: (row) => row.deadInHandShare },
    { header: 'dead_unseen', value: (row) => row.deadHand.unseen ?? 0 },
    { header: 'dead_never_affordable', value: (row) => row.deadHand.never_affordable ?? 0 },
    { header: 'dead_no_legal_window', value: (row) => row.deadHand.no_legal_window ?? 0 },
    { header: 'dead_legal_but_unchosen', value: (row) => row.deadHand.legal_but_unchosen ?? 0 },
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
    { header: 'support', value: (row) => row.support },
    { header: 'win_rate_together', value: (row) => row.winRateTogether },
    { header: 'win_rate_a_only', value: (row) => row.winRateAOnly },
    { header: 'win_rate_b_only', value: (row) => row.winRateBOnly },
    { header: 'lift', value: (row) => row.lift },
    { header: 'low', value: (row) => row.low },
    { header: 'high', value: (row) => row.high },
    { header: 'effect_size', value: (row) => row.effectSize },
    { header: 'effect_size_label', value: (row) => row.effectSizeLabel },
  ]);

  const errors = inputs.records
    .filter((record) => record.diagnostics.length > 0 || record.botFailures.length > 0)
    .flatMap((record) => [
      ...record.diagnostics.map((message) => ({
        matchId: record.matchId,
        termination: record.termination,
        kind: 'diagnostic',
        message,
        replayPath: record.replayPath ?? '',
      })),
      ...record.botFailures.map((failure) => ({
        matchId: record.matchId,
        termination: record.termination,
        kind: `bot_${failure.kind}`,
        message: `${failure.botId} (${failure.playerId}): ${failure.message}`,
        replayPath: record.replayPath ?? '',
      })),
    ]);
  writeCsv(paths.errors, errors, [
    { header: 'match_id', value: (row) => row.matchId },
    { header: 'termination', value: (row) => row.termination },
    { header: 'kind', value: (row) => row.kind },
    { header: 'message', value: (row) => row.message },
    { header: 'replay_path', value: (row) => row.replayPath },
  ]);

  if (inputs.streamRecords) {
    writeJson(join(paths.root, 'matches.json'), inputs.records);
  }

  writeFileText(paths.report, report);

  return {
    outputDir: inputs.outputDir,
    records: inputs.records,
    aggregate: agg,
    clustering,
    pairs,
    replacements: inputs.replacements,
    flags,
    comparison: inputs.comparison,
    searchHistory: inputs.searchHistory,
    report,
    elapsedMs: inputs.elapsedMs,
  };
}

/* ------------------------------------------------------------------ helpers */

function inclusionOf(decks: readonly SimDeck[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const deck of decks) {
    for (const entry of deck.cards) counts.set(entry.cardId, (counts.get(entry.cardId) ?? 0) + 1);
  }
  return counts;
}

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
