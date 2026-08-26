/**
 * Sample statistics over Float64Array windows.
 *
 * Everything here takes a typed array rather than Candle[] on purpose: the
 * study touches a million bars per symbol and every pass over an array of
 * objects costs a pointer chase per field.
 */

export interface Moments {
  n: number;
  mean: number;
  /** Sample variance, denominator n-1. */
  variance: number;
  stdev: number;
  skewness: number;
  /** Excess kurtosis: 0 for a normal sample. */
  kurtosis: number;
  min: number;
  max: number;
}

export function mean(x: ArrayLike<number>): number {
  const n = x.length;
  if (n === 0) return Number.NaN;
  let s = 0;
  for (let i = 0; i < n; i++) s += x[i];
  return s / n;
}

export function variance(x: ArrayLike<number>, knownMean?: number): number {
  const n = x.length;
  if (n < 2) return Number.NaN;
  const m = knownMean ?? mean(x);
  let s = 0;
  for (let i = 0; i < n; i++) {
    const d = x[i] - m;
    s += d * d;
  }
  return s / (n - 1);
}

export function stdev(x: ArrayLike<number>, knownMean?: number): number {
  return Math.sqrt(variance(x, knownMean));
}

export function moments(x: ArrayLike<number>): Moments {
  const n = x.length;
  if (n === 0) {
    return { n: 0, mean: NaN, variance: NaN, stdev: NaN, skewness: NaN, kurtosis: NaN, min: NaN, max: NaN };
  }
  const m = mean(x);
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < n; i++) {
    const d = x[i] - m;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
    if (x[i] < min) min = x[i];
    if (x[i] > max) max = x[i];
  }
  const varr = n > 1 ? m2 / (n - 1) : NaN;
  const sd = Math.sqrt(varr);
  const pop2 = m2 / n;
  return {
    n,
    mean: m,
    variance: varr,
    stdev: sd,
    skewness: pop2 > 0 ? m3 / n / Math.pow(pop2, 1.5) : NaN,
    kurtosis: pop2 > 0 ? m4 / n / (pop2 * pop2) - 3 : NaN,
    min,
    max,
  };
}

/** Linear-interpolated quantile of an already sorted ascending array. */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  if (n === 1) return sorted[0];
  const pos = (n - 1) * Math.min(1, Math.max(0, q));
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

/** Quantile of an unsorted sample. Copies, so the input is left alone. */
export function quantile(x: ArrayLike<number>, q: number): number {
  const copy = Float64Array.from(x as ArrayLike<number>);
  copy.sort();
  return quantileSorted(copy, q);
}

export function median(x: ArrayLike<number>): number {
  return quantile(x, 0.5);
}

/** Absolute values, in place-free form. */
export function absOf(x: ArrayLike<number>): Float64Array {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.abs(x[i]);
  return out;
}

/**
 * Clips the sample to its own [p, 1-p] quantiles.
 *
 * Crypto minute returns contain single bars of ten percent. Those bars are real
 * and matter for risk, but they also dominate every fourth moment in the study:
 * one of them can set the robust standard error of an autocorrelation all by
 * itself. Running an estimate both raw and winsorized answers "is this finding
 * a property of the series, or of two minutes in it".
 */
export function winsorize(x: ArrayLike<number>, p = 0.001): Float64Array {
  const lo = quantile(x, p);
  const hi = quantile(x, 1 - p);
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = Math.min(hi, Math.max(lo, x[i]));
  return out;
}

export function squareOf(x: ArrayLike<number>): Float64Array {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] * x[i];
  return out;
}

export interface MeanTest {
  n: number;
  mean: number;
  stdev: number;
  /** Standard error of the mean. */
  se: number;
  t: number;
  /** 95% confidence interval for the mean. */
  ciLow: number;
  ciHigh: number;
}

/**
 * One-sample test of mean = 0. Samples here are tens of thousands of bars at
 * minimum, so the normal quantile is used instead of Student's t — the
 * difference at n = 30 000 is in the fifth decimal.
 */
export function meanTest(x: ArrayLike<number>, z95 = 1.959963985): MeanTest {
  const n = x.length;
  const m = mean(x);
  const sd = stdev(x, m);
  const se = sd / Math.sqrt(n);
  return { n, mean: m, stdev: sd, se, t: m / se, ciLow: m - z95 * se, ciHigh: m + z95 * se };
}

export interface WelchTest {
  meanA: number;
  meanB: number;
  diff: number;
  se: number;
  t: number;
  nA: number;
  nB: number;
}

/** Welch two-sample test; unequal variances, which is always the case here. */
export function welchTest(a: ArrayLike<number>, b: ArrayLike<number>): WelchTest {
  const mA = mean(a);
  const mB = mean(b);
  const vA = variance(a, mA);
  const vB = variance(b, mB);
  const se = Math.sqrt(vA / a.length + vB / b.length);
  return { meanA: mA, meanB: mB, diff: mA - mB, se, t: (mA - mB) / se, nA: a.length, nB: b.length };
}

/** Pearson correlation. */
export function correlation(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return Number.NaN;
  let sx = 0;
  let sy = 0;
  for (let i = 0; i < n; i++) {
    sx += x[i];
    sy += y[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - mx;
    const dy = y[i] - my;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }
  return sxy / Math.sqrt(sxx * syy);
}

/** Spearman rank correlation; robust to the fat tails that dominate crypto. */
export function rankCorrelation(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const n = Math.min(x.length, y.length);
  return correlation(ranks(x, n), ranks(y, n));
}

function ranks(x: ArrayLike<number>, n: number): Float64Array {
  const idx = Array.from({ length: n }, (_, i) => i).sort((a, b) => x[a] - x[b]);
  const out = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && x[idx[j + 1]] === x[idx[i]]) j++;
    const avg = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]] = avg;
    i = j + 1;
  }
  return out;
}
