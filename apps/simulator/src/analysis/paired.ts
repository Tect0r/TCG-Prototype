import { z } from 'zod';
import { digest } from '../hash.js';
import { cohensH, effectSizeLabel, mean, round, stdev, zFor, type Interval } from './stats.js';

/**
 * Paired analysis, resampling and multiplicity control (PHASE4_HARDENING §9).
 *
 * Replacement and baseline-versus-candidate experiments run on common random
 * numbers: the same deck pair, the same game index, the same shuffles, the same
 * pilot seeds. Analysing those outcomes as two independent samples throws that
 * design away and reports a wider, wronger interval than the experiment earned.
 * Everything in this module exists so the pairing survives into the numbers.
 *
 * **On determinism.** `stats.ts` is closed-form on purpose. The resampling here
 * is not a contradiction: every generator is seeded from a caller-supplied
 * string and no generator ever reads a clock, a counter or `Math.random()`. Two
 * runs of the analyser over the same records therefore produce byte-identical
 * intervals, which is the property that actually matters. A bootstrap is used
 * where the estimand is a contrast of several correlated groups and no honest
 * closed form exists — §9.2 requires the uncertainty of *every* contributing
 * cell to reach the interval, and a closed form over one cell cannot do that.
 */

/** Bump when a resampling procedure changes and old intervals stop reproducing. */
export const ANALYSIS_STATS_VERSION = 1;

/* --------------------------------------------------------------------- rng */

/**
 * xorshift128, seeded from a string digest.
 *
 * Deterministic, portable and dependency-free. The exact stream is part of the
 * analysis contract: changing it changes published intervals, so it is versioned
 * by `ANALYSIS_STATS_VERSION` rather than swapped silently.
 */
export function analysisRng(seed: string): () => number {
  const hex = digest(`stats:v${ANALYSIS_STATS_VERSION}|${seed}`, 32);
  let x = Number.parseInt(hex.slice(0, 8), 16) >>> 0 || 0x9e3779b9;
  let y = Number.parseInt(hex.slice(8, 16), 16) >>> 0 || 0x243f6a88;
  let z = Number.parseInt(hex.slice(16, 24), 16) >>> 0 || 0xb7e15162;
  let w = Number.parseInt(hex.slice(24, 32), 16) >>> 0 || 0x85a308d3;

  return () => {
    const t = x ^ (x << 11);
    x = y;
    y = z;
    z = w;
    w = (w ^ (w >>> 19) ^ (t ^ (t >>> 8))) >>> 0;
    return w / 0x1_0000_0000;
  };
}

/* --------------------------------------------------------------- bootstrap */

export interface BootstrapOptions {
  readonly seed: string;
  readonly iterations?: number;
  readonly confidence?: number;
}

/** Default resample count. Enough for a stable percentile at these sample sizes. */
export const DEFAULT_BOOTSTRAP_ITERATIONS = 2000;

export interface BootstrapResult extends Interval {
  readonly iterations: number;
  /** Resamples on which the statistic was undefined (an empty stratum, say). */
  readonly discarded: number;
}

/**
 * Percentile bootstrap over strata.
 *
 * Resampling happens *within* each stratum, so a contrast is never estimated
 * from a resample that dropped a whole pilot or seat. §9.2 asks for exactly this
 * where the data allows it; a caller with nothing to stratify on passes one
 * stratum and gets an ordinary bootstrap.
 */
export function stratifiedBootstrap<T>(
  strata: readonly (readonly T[])[],
  statistic: (resample: readonly T[][]) => number | null,
  options: BootstrapOptions,
): BootstrapResult {
  const iterations = options.iterations ?? DEFAULT_BOOTSTRAP_ITERATIONS;
  const confidence = options.confidence ?? 0.95;
  const random = analysisRng(options.seed);

  const point = statistic(strata.map((stratum) => [...stratum]));
  const samples: number[] = [];
  let discarded = 0;

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const resample = strata.map((stratum) => {
      const drawn: T[] = [];
      for (let index = 0; index < stratum.length; index += 1) {
        const pick = Math.min(stratum.length - 1, Math.floor(random() * stratum.length));
        drawn.push(stratum[pick] as T);
      }
      return drawn;
    });
    const value = statistic(resample);
    if (value === null || !Number.isFinite(value)) discarded += 1;
    else samples.push(value);
  }

  if (samples.length === 0 || point === null || !Number.isFinite(point)) {
    return { point: point ?? 0, low: Number.NaN, high: Number.NaN, iterations, discarded };
  }

  samples.sort((left, right) => left - right);
  const alpha = (1 - confidence) / 2;
  return {
    point,
    low: quantile(samples, alpha),
    high: quantile(samples, 1 - alpha),
    iterations,
    discarded,
  };
}

function quantile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1))),
  );
  return sorted[index] as number;
}

/* ------------------------------------------------------------ paired binary */

export const pairedBinarySchema = z.strictObject({
  /** Pairs where both arms produced a usable outcome. */
  pairs: z.number().int().min(0),
  /** Pairs that could not be matched or were incomplete, and why. */
  excludedPairs: z.number().int().min(0),
  exclusionReasons: z.record(z.string(), z.number().int().min(0)),
  baselineWinShare: z.number(),
  candidateWinShare: z.number(),
  /** Candidate minus baseline, over complete pairs only. */
  delta: z.number(),
  /** Pairs the candidate won and the baseline lost. */
  candidateOnlyWins: z.number().int().min(0),
  /** Pairs the baseline won and the candidate lost. */
  baselineOnlyWins: z.number().int().min(0),
  concordantPairs: z.number().int().min(0),
  low: z.number(),
  high: z.number(),
  effectSize: z.number(),
  effectSizeLabel: z.string(),
  /** Set when there are too few complete pairs for the interval to mean much. */
  insufficientEvidence: z.boolean(),
  method: z.string(),
});
export type PairedBinary = z.infer<typeof pairedBinarySchema>;

export interface PairedOutcome {
  /** Whatever the pairing key was: opponent, game index, seat. Diagnostic only. */
  readonly key: string;
  readonly baselineWon: boolean;
  readonly candidateWon: boolean;
  /** Stratum label — pilot, seat, opponent field. Empty means one stratum. */
  readonly stratum?: string;
}

export interface PairedBinaryOptions {
  readonly seed: string;
  readonly confidence?: number;
  readonly minPairs?: number;
  readonly iterations?: number;
  readonly excluded?: Readonly<Record<string, number>>;
}

/**
 * Paired difference of two binary outcomes measured on the same experimental
 * units (PHASE4_HARDENING §9.1).
 *
 * The interval comes from a stratified bootstrap over *pairs*, which keeps the
 * within-pair correlation that makes the paired design worth running. The
 * discordant counts are reported alongside because they are the whole sample the
 * difference is actually estimated from: 200 pairs with two discordant ones
 * carry about as much information as two coin flips, and a reader deserves to
 * see that rather than infer it from a wide interval.
 */
export function pairedBinary(
  outcomes: readonly PairedOutcome[],
  options: PairedBinaryOptions,
): PairedBinary {
  const minPairs = options.minPairs ?? 20;
  const exclusionReasons: Record<string, number> = { ...(options.excluded ?? {}) };
  const excludedPairs = Object.values(exclusionReasons).reduce((sum, value) => sum + value, 0);

  const sorted = [...outcomes].sort((left, right) => left.key.localeCompare(right.key));
  const pairs = sorted.length;

  const baselineWins = sorted.filter((entry) => entry.baselineWon).length;
  const candidateWins = sorted.filter((entry) => entry.candidateWon).length;
  const candidateOnlyWins = sorted.filter(
    (entry) => entry.candidateWon && !entry.baselineWon,
  ).length;
  const baselineOnlyWins = sorted.filter(
    (entry) => entry.baselineWon && !entry.candidateWon,
  ).length;

  const baselineShare = pairs === 0 ? 0 : baselineWins / pairs;
  const candidateShare = pairs === 0 ? 0 : candidateWins / pairs;
  const delta = candidateShare - baselineShare;
  const h = cohensH(candidateShare, baselineShare);

  const strata = groupByStratum(sorted);
  const interval =
    pairs === 0
      ? { low: Number.NaN, high: Number.NaN }
      : stratifiedBootstrap(
          strata,
          (resample) => {
            const flat = resample.flat();
            if (flat.length === 0) return null;
            const base = flat.filter((entry) => entry.baselineWon).length / flat.length;
            const cand = flat.filter((entry) => entry.candidateWon).length / flat.length;
            return cand - base;
          },
          {
            seed: options.seed,
            ...(options.iterations === undefined ? {} : { iterations: options.iterations }),
            ...(options.confidence === undefined ? {} : { confidence: options.confidence }),
          },
        );

  return {
    pairs,
    excludedPairs,
    exclusionReasons,
    baselineWinShare: round(baselineShare),
    candidateWinShare: round(candidateShare),
    delta: round(delta),
    candidateOnlyWins,
    baselineOnlyWins,
    concordantPairs: pairs - candidateOnlyWins - baselineOnlyWins,
    low: round(interval.low),
    high: round(interval.high),
    effectSize: round(h),
    effectSizeLabel: effectSizeLabel(h),
    insufficientEvidence: pairs < minPairs,
    method: 'stratified paired percentile bootstrap',
  };
}

function groupByStratum<T extends { readonly stratum?: string }>(items: readonly T[]): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = item.stratum ?? '';
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([, bucket]) => bucket);
}

/* -------------------------------------------------------- paired continuous */

export const pairedMeanSchema = z.strictObject({
  pairs: z.number().int().min(0),
  excludedPairs: z.number().int().min(0),
  baselineMean: z.number(),
  candidateMean: z.number(),
  /** Mean of the within-pair differences. Not the difference of the means. */
  meanDifference: z.number(),
  standardError: z.number(),
  low: z.number(),
  high: z.number(),
  insufficientEvidence: z.boolean(),
  method: z.string(),
});
export type PairedMean = z.infer<typeof pairedMeanSchema>;

/**
 * Paired difference for a continuous outcome such as match length.
 *
 * Closed form: the differences *are* the sample, so the ordinary interval over
 * them is already the paired one and no resampling is needed. Using an
 * independent-sample interval here would be the mistake §9.1 names.
 */
export function pairedMean(
  observations: readonly { readonly baseline: number; readonly candidate: number }[],
  options: { readonly confidence?: number; readonly minPairs?: number; readonly excluded?: number },
): PairedMean {
  const confidence = options.confidence ?? 0.95;
  const minPairs = options.minPairs ?? 20;
  const differences = observations.map((entry) => entry.candidate - entry.baseline);
  const point = mean(differences);
  const error = differences.length < 2 ? 0 : stdev(differences) / Math.sqrt(differences.length);
  const spread = zFor(confidence) * error;

  return {
    pairs: differences.length,
    excludedPairs: options.excluded ?? 0,
    baselineMean: round(mean(observations.map((entry) => entry.baseline)), 3),
    candidateMean: round(mean(observations.map((entry) => entry.candidate)), 3),
    meanDifference: round(point, 3),
    standardError: round(error, 4),
    low: round(point - spread, 3),
    high: round(point + spread, 3),
    insufficientEvidence: differences.length < minPairs,
    method: 'paired differences, normal interval',
  };
}

/* ------------------------------------------------------------- multiplicity */

export const multiplicitySchema = z.strictObject({
  /** How many cards, pairs or clusters were examined to produce the flags. */
  hypothesesExamined: z.number().int().min(0),
  /** Flags raised before any multiplicity adjustment. */
  rawFlags: z.number().int().min(0),
  /** Expected false positives if every hypothesis were null, at this threshold. */
  expectedFalsePositives: z.number(),
  note: z.string(),
});
export type Multiplicity = z.infer<typeof multiplicitySchema>;

/**
 * Benjamini–Hochberg step-up adjustment.
 *
 * Returns adjusted values in the *input order*. Unadjusted values are never
 * discarded by this function: §9.3 requires both to remain visible.
 */
export function benjaminiHochberg(pValues: readonly number[]): number[] {
  const indexed = pValues
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value - right.value);

  const count = indexed.length;
  const adjusted = new Array<number>(count).fill(1);
  let running = 1;

  for (let rank = count - 1; rank >= 0; rank -= 1) {
    const entry = indexed[rank];
    if (!entry) continue;
    running = Math.min(running, (entry.value * count) / (rank + 1));
    adjusted[entry.index] = Math.min(1, running);
  }

  return adjusted;
}

/**
 * How many independent review signals a scan of this size would raise by chance.
 *
 * Reported rather than used to suppress anything: the flags are review guidance,
 * and hiding one because a scan was wide would trade a false positive for a
 * false negative without telling the reader.
 */
export function describeMultiplicity(
  hypothesesExamined: number,
  rawFlags: number,
  falsePositiveRate: number,
): Multiplicity {
  const expected = round(hypothesesExamined * falsePositiveRate, 2);
  return {
    hypothesesExamined,
    rawFlags,
    expectedFalsePositives: expected,
    note:
      `${hypothesesExamined} subject(s) were examined to produce ${rawFlags} raw flag(s). ` +
      `At a ${round(falsePositiveRate * 100, 1)}% per-subject false-positive rate, roughly ` +
      `${expected} flag(s) of this many would be expected from noise alone. Treat the list as a ` +
      'ranked set of things to look at, not as a set of independent findings.',
  };
}
