// Corrections for the fact that we looked at the data N times.
//
// Two independent tests live here, because they fail in different ways and
// agreeing is informative:
//
//  1. Deflated Sharpe Ratio (Bailey & Lopez de Prado, 2014). Parametric. Asks:
//     given that we tried N configurations whose Sharpes had spread V, how high
//     would the best one be expected to reach by luck alone? Then it asks
//     whether the realised Sharpe beats that expectation, correcting for the
//     skew and fat tails of the return series. Chosen over Bonferroni because
//     Bonferroni assumes independent trials, and a parameter grid is the
//     opposite of independent: bbPeriod 20 and bbPeriod 21 are nearly the same
//     strategy, so Bonferroni charges for hundreds of trials that carry almost
//     no extra chance of a fluke and rejects everything.
//
//  2. White's Reality Check (2000) with a stationary bootstrap (Politis &
//     Romano, 1994). Non-parametric. Resamples the return series in blocks —
//     the same block draw applied to every strategy, which preserves both the
//     autocorrelation inside a strategy and the correlation between strategies
//     — and asks how often the best-of-N mean return under the null (no edge)
//     reaches what we actually observed. This one needs no distributional
//     assumption and handles the grid's correlation structure by construction;
//     its cost is that it needs the return series of every trial, which the
//     optimizer has anyway.
//
// Both are computed on the out-of-sample daily returns. Running them on the
// in-sample series would be measuring the thing that was optimised.

export const EULER_MASCHERONI = 0.577_215_664_901_532_9;

/* ── normal distribution ──────────────────────────────────────────────────── */

export function normalCdf(x: number): number {
  if (!Number.isFinite(x)) return x > 0 ? 1 : 0;
  return 0.5 * erfc(-x / Math.SQRT2);
}

/** Abramowitz & Stegun 7.1.26-style complementary error function, ~1e-7 abs. */
function erfc(x: number): number {
  const z = Math.abs(x);
  const t = 1 / (1 + z / 2);
  const y =
    t *
    Math.exp(
      -z * z -
        1.26551223 +
        t *
          (1.00002368 +
            t *
              (0.37409196 +
                t *
                  (0.09678418 +
                    t *
                      (-0.18628806 +
                        t * (0.27886807 + t * (-1.13520398 + t * (1.48851587 + t * (-0.82215223 + t * 0.17087277)))))))),
    );
  return x >= 0 ? y : 2 - y;
}

/** Acklam's inverse normal CDF, refined once by Halley's method. */
export function normalInv(p: number): number {
  if (!(p > 0) || !(p < 1)) return p <= 0 ? -Infinity : Infinity;
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const pLow = 0.02425;
  let x: number;
  if (p < pLow) {
    const q = Math.sqrt(-2 * Math.log(p));
    x = (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  } else if (p <= 1 - pLow) {
    const q = p - 0.5;
    const r = q * q;
    x = (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q /
      (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  } else {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    x = -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  const e = normalCdf(x) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}

/* ── moments ──────────────────────────────────────────────────────────────── */

export interface Moments {
  n: number;
  mean: number;
  /** Sample standard deviation (n-1). */
  stdev: number;
  /** Sample skewness. */
  skew: number;
  /** Raw kurtosis: 3 for a normal distribution, not excess kurtosis. */
  kurtosis: number;
}

export function moments(values: readonly number[]): Moments {
  const n = values.length;
  if (n === 0) return { n: 0, mean: 0, stdev: 0, skew: 0, kurtosis: 3 };
  const mean = values.reduce((s, v) => s + v, 0) / n;
  if (n < 2) return { n, mean, stdev: 0, skew: 0, kurtosis: 3 };

  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const v of values) {
    const d = v - mean;
    const d2 = d * d;
    m2 += d2;
    m3 += d2 * d;
    m4 += d2 * d2;
  }
  const varSample = m2 / (n - 1);
  const stdev = Math.sqrt(varSample);
  const varPop = m2 / n;
  const sd = Math.sqrt(varPop);
  return {
    n,
    mean,
    stdev,
    skew: sd > 0 ? m3 / n / (sd * sd * sd) : 0,
    kurtosis: sd > 0 ? m4 / n / (varPop * varPop) : 3,
  };
}

/** Sharpe of a return series in the units the series is sampled at. */
export function sharpeOf(values: readonly number[]): number {
  const m = moments(values);
  return m.stdev > 0 ? m.mean / m.stdev : 0;
}

/* ── probabilistic and deflated Sharpe ────────────────────────────────────── */

/**
 * Probability that the true Sharpe exceeds `benchmark`, given the observed
 * Sharpe, the sample length and the shape of the return distribution. Negative
 * skew and fat tails inflate a naive Sharpe; this is where that gets paid for.
 */
export function probabilisticSharpe(sharpe: number, benchmark: number, n: number, skew: number, kurtosis: number): number {
  if (!(n > 1) || !Number.isFinite(sharpe)) return 0;
  const denom = 1 - skew * sharpe + ((kurtosis - 1) / 4) * sharpe * sharpe;
  if (!(denom > 0)) return 0;
  return normalCdf(((sharpe - benchmark) * Math.sqrt(n - 1)) / Math.sqrt(denom));
}

/**
 * Expected maximum Sharpe over `trials` independent draws with variance
 * `sharpeVariance` — the height a peak reaches by luck alone. Gumbel
 * approximation from Bailey & Lopez de Prado.
 */
export function expectedMaxSharpe(trials: number, sharpeVariance: number): number {
  const n = Math.max(1, Math.floor(trials));
  const sd = Math.sqrt(Math.max(0, sharpeVariance));
  if (sd === 0) return 0;
  if (n === 1) return 0;
  const g = EULER_MASCHERONI;
  return sd * ((1 - g) * normalInv(1 - 1 / n) + g * normalInv(1 - 1 / (n * Math.E)));
}

export interface DeflatedSharpeInput {
  /** Sharpe of the candidate, per observation period (daily here). */
  sharpe: number;
  /** Number of return observations behind that Sharpe. */
  observations: number;
  skew: number;
  kurtosis: number;
  /** Sharpes of every configuration tried, same units. Their spread is the correction. */
  trialSharpes: readonly number[];
  /** Overrides the trial count when more configurations were tried than are in `trialSharpes`. */
  trials?: number;
}

export interface DeflatedSharpeResult {
  sharpe: number;
  trials: number;
  /** Variance of the trial Sharpes — the "how much did luck have to work with" term. */
  trialVariance: number;
  /** Sharpe the best of `trials` would be expected to reach with no edge at all. */
  threshold: number;
  /** P(true Sharpe > threshold). Above ~0.95 is the usual bar. */
  dsr: number;
  /** Same statistic against a zero benchmark, i.e. with no multiple-testing charge. */
  psrZero: number;
}

export function deflatedSharpe(input: DeflatedSharpeInput): DeflatedSharpeResult {
  const usable = input.trialSharpes.filter((s) => Number.isFinite(s));
  const trials = Math.max(1, Math.floor(input.trials ?? usable.length));
  const stats = moments(usable);
  const trialVariance = usable.length > 1 ? stats.stdev * stats.stdev : 0;
  const threshold = expectedMaxSharpe(trials, trialVariance);
  return {
    sharpe: input.sharpe,
    trials,
    trialVariance,
    threshold,
    dsr: probabilisticSharpe(input.sharpe, threshold, input.observations, input.skew, input.kurtosis),
    psrZero: probabilisticSharpe(input.sharpe, 0, input.observations, input.skew, input.kurtosis),
  };
}

/* ── deterministic RNG ────────────────────────────────────────────────────── */

/** mulberry32 — small, fast, and seeded, so a report can be reproduced exactly. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Politis-Romano stationary bootstrap. Blocks of geometric length keep the
 * autocorrelation of a daily equity curve intact; an i.i.d. bootstrap would
 * destroy it and make every strategy look more significant than it is.
 */
export function stationaryBootstrapIndices(n: number, meanBlock: number, rng: () => number): number[] {
  if (n <= 0) return [];
  const p = meanBlock > 1 ? 1 / meanBlock : 1;
  const out = new Array<number>(n);
  let idx = Math.floor(rng() * n) % n;
  for (let i = 0; i < n; i++) {
    if (i > 0) {
      if (rng() < p) idx = Math.floor(rng() * n) % n;
      else idx = (idx + 1) % n;
    }
    out[i] = idx;
  }
  return out;
}

export interface RealityCheckInput {
  /** One row per configuration tried, each the same length: its return series. */
  series: readonly (readonly number[])[];
  /**
   * An extra series to score against the same null — the walk-forward track,
   * which is not itself one of the grid rows but was produced by searching them.
   * It is deliberately kept out of the null distribution: the question is
   * whether it beats what searching this grid can produce from noise.
   */
  candidate?: readonly number[];
  samples?: number;
  /** Mean block length for the stationary bootstrap; defaults to n^(1/3). */
  blockLength?: number;
  seed?: number;
}

export interface RealityCheckResult {
  /** sqrt(n) * max mean return across configurations. */
  statistic: number;
  pValue: number;
  samples: number;
  blockLength: number;
  observations: number;
  strategies: number;
  /** Index of the configuration that produced the statistic. */
  bestIndex: number;
  /** sqrt(n) * mean return of the candidate series, when one was supplied. */
  candidateStatistic: number | null;
  /** Share of bootstrap draws where the best-of-grid under the null reached the candidate. */
  candidatePValue: number | null;
}

/**
 * White's Reality Check: the probability of seeing a best-of-N as good as ours
 * when no configuration has any edge. The null is imposed by re-centring each
 * bootstrap mean on the observed mean, and the same resampled index vector is
 * used for every configuration so that correlation across the grid is kept.
 */
export function realityCheck(input: RealityCheckInput): RealityCheckResult {
  const series = input.series.filter((s) => s.length > 0);
  const observations = series.length > 0 ? series[0].length : 0;
  const empty: RealityCheckResult = {
    statistic: 0,
    pValue: 1,
    samples: 0,
    blockLength: 0,
    observations,
    strategies: series.length,
    bestIndex: -1,
    candidateStatistic: null,
    candidatePValue: null,
  };
  if (series.length === 0 || observations < 2) return empty;
  if (series.some((s) => s.length !== observations)) throw new Error("realityCheck: every series must have the same length");
  const candidate = input.candidate && input.candidate.length === observations ? input.candidate : null;

  const samples = Math.max(1, Math.floor(input.samples ?? 2000));
  const blockLength = Math.max(1, input.blockLength ?? Math.max(2, Math.round(Math.cbrt(observations))));
  const rng = mulberry32(input.seed ?? 20260826);

  const means = series.map((s) => s.reduce((acc, v) => acc + v, 0) / observations);
  const root = Math.sqrt(observations);
  let statistic = -Infinity;
  let bestIndex = -1;
  for (let k = 0; k < means.length; k++) {
    const v = root * means[k];
    if (v > statistic) {
      statistic = v;
      bestIndex = k;
    }
  }

  const candidateStatistic = candidate
    ? root * (candidate.reduce((acc, v) => acc + v, 0) / observations)
    : null;

  let hits = 0;
  let candidateHits = 0;
  for (let b = 0; b < samples; b++) {
    const idx = stationaryBootstrapIndices(observations, blockLength, rng);
    let best = -Infinity;
    for (let k = 0; k < series.length; k++) {
      const s = series[k];
      let sum = 0;
      for (let i = 0; i < observations; i++) sum += s[idx[i]];
      const v = root * (sum / observations - means[k]);
      if (v > best) best = v;
    }
    if (best >= statistic) hits += 1;
    if (candidateStatistic !== null && best >= candidateStatistic) candidateHits += 1;
  }

  return {
    statistic,
    pValue: (hits + 1) / (samples + 1),
    samples,
    blockLength,
    observations,
    strategies: series.length,
    bestIndex,
    candidateStatistic,
    candidatePValue: candidateStatistic === null ? null : (candidateHits + 1) / (samples + 1),
  };
}
