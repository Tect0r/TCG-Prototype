import { z } from 'zod';
import type { PilotSpec } from '@tcg/bot-interface';
import type { Environment } from '../environment.js';
import type { MatchLimits } from '../run-match.js';
import { runBatch, type BatchRetention } from '../run-batch.js';
import type { MatchSink } from '../reporting/match-store.js';
import { buildSchedule } from '../schedule.js';
import { normalizedEntropy, proportion, round } from '../analysis/stats.js';
import { isAbnormal, type MatchRecord } from '../telemetry/schema.js';
import { seededIndex } from '../seed.js';
import { simDeckSchema, type SimDeck } from './deck.js';
import { crossoverDecks, deckDistance, mutateDeck, type PackagePolicy } from './mutate.js';
import type { ResolvedPlan } from './plan.js';

/**
 * Evolutionary abuse search (CLAUDE.md §13.9).
 *
 * The point is *discovery*, not a champion. Three design choices follow from
 * that and are the reason this is not a plain hill climb on win rate:
 *
 * - **Multi-objective fitness.** Raw win rate against a fixed field rewards
 *   overfitting to that field. Fitness also counts how many distinct opponents a
 *   deck beats, how stable it is across seats, how novel it is, and how certain
 *   the estimate is — and it *penalises* decks that win through abnormal
 *   terminations, stalling or pilot failures.
 * - **A hall of fame.** Every generation is evaluated against an archive that
 *   keeps older strategies, so the population cannot forget the counter it beat
 *   three generations ago and then "rediscover" dominance against a field that
 *   no longer contains it.
 * - **Reported collapse.** Card entropy, Commander spread and mean deck distance
 *   are measured every generation. When diversity collapses that is a finding to
 *   print, never something to paper over by injecting unexplained randomness.
 */

/**
 * - 1 — the original checkpoint.
 * - 2 (M05.5) — every `SimDeck` in a checkpoint carries `construction`: how the
 *   deck was built and how much of its plan it still holds. A refusal rather
 *   than a migration, because a v1 checkpoint never recorded where its decks
 *   came from and defaulting them to `unconstrained` would silently relabel a
 *   resumed planned search as an unplanned one.
 */
export const SEARCH_CHECKPOINT_VERSION = 2;

export const fitnessSchema = z.strictObject({
  deckHash: z.string(),
  /** Weighted total. Ranking only; the components are what a reader should read. */
  score: z.number(),
  winRate: z.number(),
  winRateLow: z.number(),
  winRateHigh: z.number(),
  matches: z.number().int().min(0),
  /** Share of distinct opponents this deck beat more often than it lost. */
  opponentBreadth: z.number(),
  /** Worst win rate across seat orientations: how seat-dependent the deck is. */
  seatRobustness: z.number(),
  /** Mean card distance to the archive: how novel the deck is. */
  novelty: z.number(),
  /** Penalty applied for abnormal terminations, stalling and pilot failures. */
  penalty: z.number(),
  penaltyReasons: z.array(z.string()),
});
export type Fitness = z.infer<typeof fitnessSchema>;

export const generationReportSchema = z.strictObject({
  generation: z.number().int().min(0),
  evaluated: z.number().int().min(0),
  matches: z.number().int().min(0),
  abnormalMatches: z.number().int().min(0),
  best: fitnessSchema.nullable(),
  meanScore: z.number(),
  /** Diversity, reported whether or not it looks healthy. */
  cardEntropy: z.number(),
  commanderCount: z.number().int().min(0),
  meanPairwiseDistance: z.number(),
  archiveSize: z.number().int().min(0),
  notes: z.array(z.string()),
});
export type GenerationReport = z.infer<typeof generationReportSchema>;

export const searchCheckpointSchema = z.strictObject({
  schemaVersion: z.literal(SEARCH_CHECKPOINT_VERSION),
  experimentId: z.string(),
  environmentHash: z.string(),
  /** The last generation that was fully evaluated. */
  generation: z.number().int().min(0),
  /** The decks evaluated at `generation`, so a reader can see what was measured. */
  population: z.array(simDeckSchema),
  /**
   * The decks the *next* generation will evaluate — already bred.
   *
   * Resuming has to continue from here rather than re-breeding from
   * `population`: breeding consumes the generation's seed path, so re-running it
   * would silently produce a different lineage than the uninterrupted run.
   */
  nextPopulation: z.array(simDeckSchema),
  archive: z.array(simDeckSchema),
  fitness: z.array(fitnessSchema),
  history: z.array(generationReportSchema),
});
export type SearchCheckpoint = z.infer<typeof searchCheckpointSchema>;

export interface SearchOptions {
  readonly experimentId: string;
  readonly experimentSeed: string;
  /** Experiment kind stamped on every evaluation record. */
  readonly experimentKind: MatchRecord['experimentKind'];
  readonly configHash: string;
  /**
   * Arm prefix for this search. Every generation appends `:g<n>` to it, so a
   * comparison running two searched populations and a search running several
   * replicates all land in one `matches.jsonl` without colliding.
   */
  readonly armPrefix: string;
  /** Shared raw-record stream. `null` keeps this search in memory only. */
  readonly sink?: MatchSink | null;
  readonly replayDir?: string | null;
  readonly environment: Environment;
  readonly pilots: readonly PilotSpec[];
  readonly limits: MatchLimits;
  readonly retention: BatchRetention;
  readonly workers: number;
  readonly populationSize: number;
  readonly generations: number;
  readonly eliteCount: number;
  readonly mutationStrength: number;
  readonly crossoverShare: number;
  /**
   * The deck plan this search's population was seeded from, resolved once
   * (M05.5). `null` for an unplanned search, which is still the default: a
   * search that cannot leave its plan is not a search.
   */
  readonly plan?: ResolvedPlan | null;
  /** What breeding may do to the plan's packages. `none` unless configured. */
  readonly packagePolicy?: PackagePolicy;
  readonly opponentsPerEvaluation: number;
  readonly gamesPerOpponent: number;
  readonly archiveSize: number;
  readonly reevaluateElites: boolean;
  readonly outputDir: string | null;
  readonly checkpointEvery: number;
  readonly onGeneration?: (report: GenerationReport, checkpoint: SearchCheckpoint) => void;
}

export interface SearchResult {
  readonly population: readonly SimDeck[];
  readonly archive: readonly SimDeck[];
  readonly fitness: readonly Fitness[];
  readonly history: readonly GenerationReport[];
  readonly records: readonly MatchRecord[];
}

export async function runSearch(
  initialPopulation: readonly SimDeck[],
  options: SearchOptions,
  resumeFrom?: SearchCheckpoint,
): Promise<SearchResult> {
  let population: SimDeck[] = resumeFrom
    ? [...resumeFrom.nextPopulation]
    : dedupe([...initialPopulation]);
  let archive: SimDeck[] = resumeFrom ? [...resumeFrom.archive] : dedupe([...initialPopulation]);
  const history: GenerationReport[] = resumeFrom ? [...resumeFrom.history] : [];
  const allRecords: MatchRecord[] = [];
  let fitness: Fitness[] = resumeFrom ? [...resumeFrom.fitness] : [];

  const startAt = resumeFrom ? resumeFrom.generation + 1 : 0;

  for (let generation = startAt; generation < options.generations; generation += 1) {
    const contenders = population;
    const opponents = selectOpponents(archive, contenders, options, generation);

    // Every generation derives a fresh seed path, so a deck carried forward is
    // measured on games it has never seen — which is exactly what stops the
    // search from crowning a deck that got lucky once (CLAUDE.md §13.9 step 6).
    // Turning `reevaluateElites` off keeps the previous estimate instead, and
    // then those decks are not replayed at all.
    const previous = new Map(fitness.map((entry) => [entry.deckHash, entry] as const));
    const toEvaluate = options.reevaluateElites
      ? contenders
      : contenders.filter((deck) => !previous.has(deck.hash));

    const evaluation = await evaluate(toEvaluate, opponents, options, generation);
    allRecords.push(...evaluation.records);
    const fresh = scoreAll(toEvaluate, archive, evaluation.records, options);
    fitness = mergeFitness(contenders, fresh, previous);

    archive = updateArchive(archive, contenders, fitness, options.archiveSize);

    const report = describeGeneration(generation, contenders, fitness, evaluation.records, archive);
    history.push(report);

    const last = generation === options.generations - 1;
    // Breed before checkpointing, so the checkpoint holds everything the next
    // generation needs and a resumed run cannot diverge from an uninterrupted one.
    const next = last ? [...contenders] : breed(contenders, fitness, options, generation + 1);

    options.onGeneration?.(report, {
      schemaVersion: SEARCH_CHECKPOINT_VERSION,
      experimentId: options.experimentId,
      environmentHash: options.environment.hash,
      generation,
      population: [...contenders],
      nextPopulation: [...next],
      archive: [...archive],
      fitness: [...fitness],
      history: [...history],
    });

    if (last) break;
    population = next;
  }

  return { population, archive, fitness, history, records: allRecords };
}

/* ---------------------------------------------------------------- evaluation */

function selectOpponents(
  archive: readonly SimDeck[],
  population: readonly SimDeck[],
  options: SearchOptions,
  generation: number,
): SimDeck[] {
  const pool = dedupe([...archive, ...population]);
  const wanted = Math.min(options.opponentsPerEvaluation, Math.max(1, pool.length));
  // Deterministic rotating selection: derived from the generation, so the field
  // changes between generations without any use of a clock or a counter.
  const chosen: SimDeck[] = [];
  const used = new Set<string>();
  for (let index = 0; chosen.length < wanted && index < pool.length * 4; index += 1) {
    const pickIndex = seededIndex(
      `${options.experimentSeed}|opp:${generation}:${index}`,
      pool.length,
    );
    const deck = pool[pickIndex];
    if (!deck || used.has(deck.hash)) continue;
    used.add(deck.hash);
    chosen.push(deck);
  }
  return chosen;
}

async function evaluate(
  population: readonly SimDeck[],
  opponents: readonly SimDeck[],
  options: SearchOptions,
  generation: number,
): Promise<{ records: MatchRecord[] }> {
  const decks = dedupe([...population, ...opponents]);
  if (decks.length < 2) return { records: [] };

  const schedule = buildSchedule({
    experimentId: `${options.experimentId}:g${generation}`,
    experimentSeed: `${options.experimentSeed}|gen:${generation}`,
    environmentId: options.environment.id,
    decks,
    pilots: options.pilots,
    pilotPairing: 'mirror',
    playerCount: 2,
    gamesPerPairing: options.gamesPerOpponent,
    mirrorSeats: true,
    schedule: 'round_robin',
    sampledPairings: 10_000,
  });

  // Only contender-versus-opponent pairings matter. A full round robin over the
  // union would spend most of its time playing archive decks against each other,
  // which tells the search nothing about the candidates it is evaluating.
  const contenderHashes = new Set(population.map((deck) => deck.hash));
  const fieldHashes = new Set(opponents.map((deck) => deck.hash));
  const relevant = schedule.filter((match) => {
    const hashes = match.seats.map((seat) => decks[seat.deckIndex]?.hash ?? '');
    return (
      hashes.some((hash) => contenderHashes.has(hash)) &&
      hashes.some((hash) => fieldHashes.has(hash))
    );
  });

  const outcome = await runBatch({
    experimentId: `${options.experimentId}:g${generation}`,
    experimentKind: options.experimentKind,
    configHash: options.configHash,
    arm: `${options.armPrefix}:g${generation}`,
    environment: options.environment,
    decks,
    pilots: options.pilots,
    schedule: relevant,
    limits: options.limits,
    retention: options.retention,
    workers: options.workers,
    failFast: false,
    sink: options.sink ?? null,
    replayDir: options.replayDir ?? null,
  });

  return { records: [...outcome.records] };
}

/* ------------------------------------------------------------------ fitness */

function scoreAll(
  population: readonly SimDeck[],
  archive: readonly SimDeck[],
  records: readonly MatchRecord[],
  options: SearchOptions,
): Fitness[] {
  return [...population]
    .sort((left, right) => left.hash.localeCompare(right.hash))
    .map((deck) => scoreOne(deck, archive, records, options))
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.deckHash.localeCompare(right.deckHash);
    });
}

function scoreOne(
  deck: SimDeck,
  archive: readonly SimDeck[],
  records: readonly MatchRecord[],
  options: SearchOptions,
): Fitness {
  let wins = 0;
  let total = 0;
  let abnormal = 0;
  let failures = 0;
  let longMatches = 0;
  const byOpponent = new Map<string, { wins: number; total: number }>();
  const bySeat = new Map<number, { wins: number; total: number }>();

  for (const record of records) {
    const seat = record.seats.find((entry) => entry.deckHash === deck.hash);
    if (!seat) continue;
    if (isAbnormal(record.termination)) {
      abnormal += 1;
      continue;
    }
    total += 1;
    if (seat.won) wins += 1;
    failures += record.botFailures.length;
    if (record.turns > options.limits.maxTurns * 0.5) longMatches += 1;

    for (const other of record.seats) {
      if (other.playerId === seat.playerId) continue;
      const tally = byOpponent.get(other.deckHash) ?? { wins: 0, total: 0 };
      tally.total += 1;
      if (seat.won) tally.wins += 1;
      byOpponent.set(other.deckHash, tally);
    }
    const seatTally = bySeat.get(seat.seatIndex) ?? { wins: 0, total: 0 };
    seatTally.total += 1;
    if (seat.won) seatTally.wins += 1;
    bySeat.set(seat.seatIndex, seatTally);
  }

  const rate = proportion(wins, total);
  const beaten = [...byOpponent.values()].filter((tally) => tally.wins * 2 > tally.total).length;
  const breadth = byOpponent.size === 0 ? 0 : beaten / byOpponent.size;
  const seatRates = [...bySeat.values()].map((tally) =>
    tally.total === 0 ? 0 : tally.wins / tally.total,
  );
  const seatRobustness = seatRates.length === 0 ? 0 : Math.min(...seatRates);

  const novelty =
    archive.length === 0
      ? 1
      : Math.min(
          1,
          archive.reduce((sum, other) => sum + deckDistance(deck, other), 0) /
            (archive.length * Math.max(1, options.environment.deckFormat.deckSize)),
        );

  const penaltyReasons: string[] = [];
  let penalty = 0;
  const played = total + abnormal;
  if (played > 0 && abnormal / played > 0.05) {
    penalty += 0.3 * (abnormal / played);
    penaltyReasons.push(`${abnormal} of ${played} evaluation matches ended abnormally`);
  }
  if (failures > 0) {
    penalty += 0.2;
    penaltyReasons.push(`${failures} pilot failure(s) occurred while evaluating this deck`);
  }
  if (total > 0 && longMatches / total > 0.3) {
    penalty += 0.2 * (longMatches / total);
    penaltyReasons.push(`${longMatches} of ${total} matches ran past half the turn limit`);
  }
  // Performance enters the score as the *lower bound* of the interval, not the
  // point estimate. Six wins from six games and nine from ten are both "90%+"
  // to a point estimate, and the first will out-rank the second on luck alone;
  // ranking on the lower bound makes a confident result beat a lucky one, which
  // is the whole reason uncertainty is tracked (CLAUDE.md §13.9, §13.11).
  const score = rate.low * 1.0 + breadth * 0.35 + seatRobustness * 0.2 + novelty * 0.15 - penalty;

  return {
    deckHash: deck.hash,
    score: round(score, 4),
    winRate: round(rate.point, 4),
    winRateLow: round(rate.low, 4),
    winRateHigh: round(rate.high, 4),
    matches: total,
    opponentBreadth: round(breadth, 4),
    seatRobustness: round(seatRobustness, 4),
    novelty: round(novelty, 4),
    penalty: round(penalty, 4),
    penaltyReasons,
  };
}

/* -------------------------------------------------------------- hall of fame */

/**
 * Keeps strong decks *and* the decks that beat them.
 *
 * Half the archive is the best by score; the other half is chosen for distance
 * from what is already in it. Without that second half the archive converges on
 * one strategy and stops being an opponent field at all (CLAUDE.md §13.9).
 */
export function updateArchive(
  archive: readonly SimDeck[],
  population: readonly SimDeck[],
  fitness: readonly Fitness[],
  limit: number,
): SimDeck[] {
  const byHash = new Map<string, SimDeck>();
  for (const deck of [...archive, ...population]) byHash.set(deck.hash, deck);
  const scores = new Map(fitness.map((entry) => [entry.deckHash, entry.score]));

  const candidates = [...byHash.values()].sort((left, right) => {
    const delta = (scores.get(right.hash) ?? 0) - (scores.get(left.hash) ?? 0);
    if (delta !== 0) return delta;
    return left.hash.localeCompare(right.hash);
  });

  const kept: SimDeck[] = candidates.slice(0, Math.ceil(limit / 2));
  const remaining = candidates.slice(kept.length);

  while (kept.length < limit && remaining.length > 0) {
    let bestIndex = 0;
    let bestDistance = -1;
    remaining.forEach((deck, index) => {
      const distance = kept.reduce(
        (nearest, other) => Math.min(nearest, deckDistance(deck, other)),
        Infinity,
      );
      if (distance > bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    });
    const [chosen] = remaining.splice(bestIndex, 1);
    if (chosen) kept.push(chosen);
  }

  return kept.sort((left, right) => left.hash.localeCompare(right.hash));
}

/* ------------------------------------------------------------------ breeding */

function breed(
  population: readonly SimDeck[],
  fitness: readonly Fitness[],
  options: SearchOptions,
  generation: number,
): SimDeck[] {
  const ranked = [...fitness]
    .map((entry) => population.find((deck) => deck.hash === entry.deckHash))
    .filter((deck): deck is SimDeck => deck !== undefined);

  const elites = ranked.slice(0, Math.min(options.eliteCount, ranked.length));
  const next: SimDeck[] = [...elites];
  const seen = new Set(next.map((deck) => deck.hash));

  const parents = ranked.length > 0 ? ranked : [...population];
  const crossoverCount = Math.round(
    (options.populationSize - elites.length) * options.crossoverShare,
  );

  let attempt = 0;
  while (next.length < options.populationSize && attempt < options.populationSize * 20) {
    const seed = `${options.experimentSeed}|breed:${generation}:${attempt}`;
    attempt += 1;
    if (parents.length === 0) break;

    const parentIndex = seededIndex(`${seed}|p1`, parents.length);
    const parent = parents[parentIndex];
    if (!parent) continue;

    const wantCrossover = next.length - elites.length < crossoverCount && parents.length > 1;
    const produced = wantCrossover
      ? crossoverDecks(
          parent,
          parents[seededIndex(`${seed}|p2`, parents.length)] ?? parent,
          options.environment,
          seed,
          generation,
          options.plan ?? null,
        )
      : mutateDeck(parent, options.environment, seed, {
          strength: options.mutationStrength,
          generation,
          plan: options.plan ?? null,
          packagePolicy: options.packagePolicy ?? 'none',
        });

    const child = produced.deck;
    if (!child || seen.has(child.hash)) continue;
    seen.add(child.hash);
    next.push(child);
  }

  return next;
}

/* ----------------------------------------------------------------- reporting */

function describeGeneration(
  generation: number,
  population: readonly SimDeck[],
  fitness: readonly Fitness[],
  records: readonly MatchRecord[],
  archive: readonly SimDeck[],
): GenerationReport {
  const cardCounts = new Map<string, number>();
  for (const deck of population) {
    for (const entry of deck.cards) {
      cardCounts.set(entry.cardId, (cardCounts.get(entry.cardId) ?? 0) + entry.quantity);
    }
  }
  const commanders = new Set(population.map((deck) => deck.commanderId));

  let distanceSum = 0;
  let pairs = 0;
  for (let i = 0; i < population.length; i += 1) {
    for (let j = i + 1; j < population.length; j += 1) {
      distanceSum += deckDistance(population[i] as SimDeck, population[j] as SimDeck);
      pairs += 1;
    }
  }

  const entropy = normalizedEntropy([...cardCounts.values()]);
  const notes: string[] = [];
  if (entropy < 0.6) {
    notes.push(
      `card entropy is ${round(entropy, 3)}: the population is concentrating on a narrow set of cards`,
    );
  }
  if (commanders.size <= 1 && population.length > 1) {
    notes.push('every deck in the population now shares one Commander');
  }
  const abnormal = records.filter((record) => isAbnormal(record.termination)).length;
  if (abnormal > 0) {
    notes.push(`${abnormal} evaluation match(es) ended abnormally and were excluded from fitness`);
  }

  return {
    generation,
    evaluated: population.length,
    matches: records.length,
    abnormalMatches: abnormal,
    best: fitness[0] ?? null,
    meanScore:
      fitness.length === 0
        ? 0
        : round(fitness.reduce((sum, entry) => sum + entry.score, 0) / fitness.length, 4),
    cardEntropy: round(entropy, 4),
    commanderCount: commanders.size,
    meanPairwiseDistance: pairs === 0 ? 0 : round(distanceSum / pairs, 2),
    archiveSize: archive.length,
    notes,
  };
}

/** Fresh estimates where they exist, carried-forward ones otherwise. */
function mergeFitness(
  contenders: readonly SimDeck[],
  fresh: readonly Fitness[],
  previous: ReadonlyMap<string, Fitness>,
): Fitness[] {
  const byHash = new Map(fresh.map((entry) => [entry.deckHash, entry] as const));
  return contenders
    .map((deck) => byHash.get(deck.hash) ?? previous.get(deck.hash))
    .filter((entry): entry is Fitness => entry !== undefined)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      return left.deckHash.localeCompare(right.deckHash);
    });
}

function dedupe(decks: readonly SimDeck[]): SimDeck[] {
  const byHash = new Map<string, SimDeck>();
  for (const deck of decks) if (!byHash.has(deck.hash)) byHash.set(deck.hash, deck);
  return [...byHash.values()].sort((left, right) => left.hash.localeCompare(right.hash));
}
