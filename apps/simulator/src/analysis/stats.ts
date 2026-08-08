/**
 * The small amount of statistics the analyser needs (CLAUDE.md §13.11).
 *
 * Everything here is deterministic and closed-form. No bootstrap, no sampling,
 * no randomness: two runs of the analyser over the same records must print the
 * same intervals, and a resampling method would quietly make that untrue.
 *
 * The intervals are Wilson score intervals rather than the normal approximation,
 * because a prototype experiment routinely produces rates near 0 or 1 at small
 * sample sizes — exactly where the textbook interval reports nonsense such as a
 * lower bound below zero.
 */

export interface Interval {
  readonly point: number;
  readonly low: number;
  readonly high: number;
}

export interface ProportionEstimate extends Interval {
  readonly successes: number;
  readonly total: number;
  /** Half-width of the interval: a single number for "how sure is this". */
  readonly margin: number;
}

/**
 * Inverse standard normal CDF (Acklam's rational approximation, |error| < 1e-9
 * over the range we use). Closed form, so it cannot vary between runs.
 */
export function zFor(confidence: number): number {
  const p = 1 - (1 - confidence) / 2;
  return probit(p);
}

function probit(p: number): number {
  if (p <= 0 || p >= 1) throw new Error(`probit expects p in (0, 1); received ${p}`);

  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;
  const high = 1 - low;

  const at = (values: readonly number[], index: number): number => values[index] as number;

  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((at(c, 0) * q + at(c, 1)) * q + at(c, 2)) * q + at(c, 3)) * q + at(c, 4)) * q +
        at(c, 5)) /
      ((((at(d, 0) * q + at(d, 1)) * q + at(d, 2)) * q + at(d, 3)) * q + 1)
    );
  }
  if (p > high) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -(
        ((((at(c, 0) * q + at(c, 1)) * q + at(c, 2)) * q + at(c, 3)) * q + at(c, 4)) * q +
        at(c, 5)
      ) /
      ((((at(d, 0) * q + at(d, 1)) * q + at(d, 2)) * q + at(d, 3)) * q + 1)
    );
  }
  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((at(a, 0) * r + at(a, 1)) * r + at(a, 2)) * r + at(a, 3)) * r + at(a, 4)) * r + at(a, 5)) *
      q) /
    (((((at(b, 0) * r + at(b, 1)) * r + at(b, 2)) * r + at(b, 3)) * r + at(b, 4)) * r + 1)
  );
}

/** Wilson score interval for a proportion. */
export function proportion(
  successes: number,
  total: number,
  confidence = 0.95,
): ProportionEstimate {
  if (total <= 0) {
    return { point: 0, low: 0, high: 1, successes, total, margin: 0.5 };
  }
  const z = zFor(confidence);
  const rate = successes / total;
  const denominator = 1 + (z * z) / total;
  const centre = (rate + (z * z) / (2 * total)) / denominator;
  const spread =
    (z * Math.sqrt((rate * (1 - rate)) / total + (z * z) / (4 * total * total))) / denominator;

  return {
    point: rate,
    low: Math.max(0, centre - spread),
    high: Math.min(1, centre + spread),
    successes,
    total,
    margin: spread,
  };
}

/**
 * Newcombe's hybrid-score interval for the difference of two proportions.
 *
 * Chosen over the naive normal approximation for the same reason as above: at
 * the sample sizes a prototype experiment actually reaches, the naive interval
 * regularly claims a difference is significant when it is not.
 */
export function proportionDifference(
  left: { readonly successes: number; readonly total: number },
  right: { readonly successes: number; readonly total: number },
  confidence = 0.95,
): Interval {
  const a = proportion(left.successes, left.total, confidence);
  const b = proportion(right.successes, right.total, confidence);
  const delta = a.point - b.point;
  return {
    point: delta,
    low: delta - Math.hypot(a.point - a.low, b.high - b.point),
    high: delta + Math.hypot(a.high - a.point, b.point - b.low),
  };
}

/** Cohen's h: effect size for a difference between two proportions. */
export function cohensH(left: number, right: number): number {
  const phi = (p: number): number => 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, p))));
  return phi(left) - phi(right);
}

/** Plain-language size band for a Cohen's h, so a report does not print a bare number. */
export function effectSizeLabel(h: number): 'negligible' | 'small' | 'medium' | 'large' {
  const magnitude = Math.abs(h);
  if (magnitude < 0.2) return 'negligible';
  if (magnitude < 0.5) return 'small';
  if (magnitude < 0.8) return 'medium';
  return 'large';
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function stdev(values: readonly number[]): number {
  if (values.length < 2) return 0;
  const average = mean(values);
  const variance =
    values.reduce((sum, value) => sum + (value - average) ** 2, 0) / (values.length - 1);
  return Math.sqrt(variance);
}

/** Normal-approximation confidence interval for a mean. */
export function meanInterval(values: readonly number[], confidence = 0.95): Interval {
  const point = mean(values);
  if (values.length < 2) return { point, low: point, high: point };
  const spread = (zFor(confidence) * stdev(values)) / Math.sqrt(values.length);
  return { point, low: point - spread, high: point + spread };
}

export function percentile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.round(fraction * (sorted.length - 1))),
  );
  return sorted[index] as number;
}

/**
 * Shannon entropy of a distribution, normalised to [0, 1].
 *
 * Used as the population-diversity measure in deck search: a collapsing
 * population has to be reported, not papered over (CLAUDE.md §13.9).
 */
export function normalizedEntropy(counts: readonly number[]): number {
  const total = counts.reduce((sum, value) => sum + value, 0);
  if (total <= 0 || counts.length <= 1) return 0;
  let entropy = 0;
  for (const count of counts) {
    if (count <= 0) continue;
    const p = count / total;
    entropy -= p * Math.log(p);
  }
  return entropy / Math.log(counts.length);
}

/** Rounds for display without pretending to precision the sample cannot support. */
export function round(value: number, places = 4): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
