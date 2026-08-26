import { mean, quantile } from "./descriptive.ts";
import { forecastSplit, type SplitForecast } from "./regression.ts";
import type { ReturnSeries } from "./series.ts";

/**
 * Volatility, as opposed to direction.
 *
 * Direction and magnitude are separate questions and the data answers them very
 * differently. Everything here is about the second one: how much of tomorrow's
 * range is knowable from today's, and whether the market sits in regimes that
 * persist long enough to be worth conditioning on.
 */

export interface RealizedVol {
  /** Period start, UTC seconds. */
  time: Float64Array;
  /** sqrt of the sum of squared returns inside the period. */
  vol: Float64Array;
  /** Returns that went into each period. */
  count: Int32Array;
}

/** Realized volatility per calendar period, built from finer returns. */
export function realizedVol(series: ReturnSeries, periodSec: number, minCount = 1): RealizedVol {
  const sums = new Map<number, { sq: number; n: number }>();
  for (let i = 0; i < series.value.length; i++) {
    const slot = Math.floor(series.time[i] / periodSec) * periodSec;
    const cur = sums.get(slot);
    const r = series.value[i];
    if (cur) {
      cur.sq += r * r;
      cur.n++;
    } else {
      sums.set(slot, { sq: r * r, n: 1 });
    }
  }
  const keys = Array.from(sums.keys())
    .filter((k) => (sums.get(k) as { n: number }).n >= minCount)
    .sort((a, b) => a - b);
  const time = new Float64Array(keys.length);
  const vol = new Float64Array(keys.length);
  const count = new Int32Array(keys.length);
  for (let i = 0; i < keys.length; i++) {
    const cur = sums.get(keys[i])!;
    time[i] = keys[i];
    vol[i] = Math.sqrt(cur.sq);
    count[i] = cur.n;
  }
  return { time, vol, count };
}

export interface HarForecast extends SplitForecast {
  periods: number;
  /** Lookback lengths actually used, in periods. */
  lags: [number, number, number];
}

/**
 * HAR forecast of log volatility: yesterday, last week, last month.
 *
 * Log scale because volatility is roughly lognormal and the raw series is
 * dominated by a handful of crash days that would otherwise set every
 * coefficient by themselves.
 */
export function harForecast(vol: ArrayLike<number>, lags: [number, number, number] = [1, 5, 22], trainFraction = 0.7): HarForecast {
  const n = vol.length;
  const logVol = new Float64Array(n);
  for (let i = 0; i < n; i++) logVol[i] = Math.log(Math.max(vol[i], 1e-12));

  const start = Math.max(...lags);
  const rows = n - start;
  const y = new Float64Array(rows);
  const x1 = new Float64Array(rows);
  const x2 = new Float64Array(rows);
  const x3 = new Float64Array(rows);
  for (let i = start; i < n; i++) {
    const r = i - start;
    y[r] = logVol[i];
    x1[r] = windowMean(logVol, i - lags[0], i);
    x2[r] = windowMean(logVol, i - lags[1], i);
    x3[r] = windowMean(logVol, i - lags[2], i);
  }
  return { ...forecastSplit(y, [x1, x2, x3], trainFraction), periods: rows, lags };
}

function windowMean(x: ArrayLike<number>, from: number, to: number): number {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i];
  return s / (to - from);
}

export interface RegimeAnalysis {
  /** Cut points between terciles, in the units of the input. */
  cuts: number[];
  /** transitions[i][j] = P(next period in regime j | this period in regime i). */
  transitions: number[][];
  /** Diagonal of the matrix — how sticky each regime is. */
  persistence: number[];
  /** Unconditional share of each regime; the benchmark persistence must beat. */
  base: number[];
  counts: number[][];
  /** Standard error of each persistence estimate under a binomial model. */
  persistenceSe: number[];
}

/**
 * Splits a volatility series into `k` equal-frequency regimes and measures how
 * often each one repeats. Persistence far above the unconditional share is what
 * "volatility clusters" means in a number.
 */
export function regimeTransitions(vol: ArrayLike<number>, k = 3): RegimeAnalysis {
  const cuts: number[] = [];
  for (let i = 1; i < k; i++) cuts.push(quantile(vol, i / k));
  const label = (v: number): number => {
    let idx = 0;
    while (idx < cuts.length && v > cuts[idx]) idx++;
    return idx;
  };
  const counts: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const base = new Array(k).fill(0);
  for (let i = 0; i < vol.length; i++) base[label(vol[i])]++;
  for (let i = 1; i < vol.length; i++) counts[label(vol[i - 1])][label(vol[i])]++;

  const transitions = counts.map((row) => {
    const total = row.reduce((a, b) => a + b, 0);
    return row.map((c) => (total > 0 ? c / total : Number.NaN));
  });
  const persistence = transitions.map((row, i) => row[i]);
  const persistenceSe = counts.map((row, i) => {
    const total = row.reduce((a, b) => a + b, 0);
    const p = transitions[i][i];
    return total > 0 ? Math.sqrt((p * (1 - p)) / total) : Number.NaN;
  });
  const n = vol.length;
  return { cuts, transitions, persistence, base: base.map((c) => c / n), counts, persistenceSe };
}

/**
 * Mean absolute return in the period after a high-volatility one versus after a
 * low-volatility one. The direct "does knowing today's vol change tomorrow's
 * expected range" answer, in the units a position sizer would use.
 */
export function volConditionalMeanAbs(vol: ArrayLike<number>, nextAbs: ArrayLike<number>, k = 3): number[] {
  const cuts: number[] = [];
  for (let i = 1; i < k; i++) cuts.push(quantile(vol, i / k));
  const buckets: number[][] = Array.from({ length: k }, () => []);
  for (let i = 0; i + 1 < vol.length; i++) {
    let idx = 0;
    while (idx < cuts.length && vol[i] > cuts[idx]) idx++;
    buckets[idx].push(nextAbs[i + 1]);
  }
  return buckets.map((b) => mean(Float64Array.from(b)));
}
