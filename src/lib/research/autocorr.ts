import { chiSquareSf, twoSidedP } from "./distributions.ts";
import { mean, quantile } from "./descriptive.ts";

/**
 * Serial-dependence estimators for return series.
 *
 * Two decisions shape this file.
 *
 * 1. Input is a list of gap-free blocks, not one array. Pairs are formed inside
 *    a block only, so a missing hour never manufactures a lag relation.
 * 2. Significance is judged with a heteroskedasticity-consistent standard
 *    error, not 1/sqrt(n). Crypto returns are a textbook martingale difference
 *    with wild conditional variance; the iid standard error rejects the null
 *    far too often and would hand us a dozen "discoveries" made of nothing but
 *    volatility clustering.
 */

export interface AutocorrResult {
  lag: number;
  /** Total observations across all blocks. */
  n: number;
  /** Pairs actually available at this lag. */
  pairs: number;
  rho: number;
  /** 1/sqrt(n) — valid only under iid, kept for comparison. */
  seIid: number;
  /** Robust to conditional heteroskedasticity. */
  seRobust: number;
  z: number;
  p: number;
  /** Share of next-bar variance explained: rho^2. */
  r2: number;
}

interface Accum {
  n: number;
  c0: number;
}

function pooledMean(blocks: readonly Float64Array[]): { m: number; n: number } {
  let s = 0;
  let n = 0;
  for (const b of blocks) {
    for (let i = 0; i < b.length; i++) s += b[i];
    n += b.length;
  }
  return { m: n > 0 ? s / n : Number.NaN, n };
}

function pooledC0(blocks: readonly Float64Array[], m: number): Accum {
  let s = 0;
  let n = 0;
  for (const b of blocks) {
    for (let i = 0; i < b.length; i++) {
      const d = b[i] - m;
      s += d * d;
    }
    n += b.length;
  }
  return { n, c0: n > 0 ? s / n : Number.NaN };
}

/** Sample autocorrelation at one lag with both iid and robust standard errors. */
export function autocorrAt(blocks: readonly Float64Array[], lag: number): AutocorrResult {
  const { m, n } = pooledMean(blocks);
  const { c0 } = pooledC0(blocks, m);
  let cross = 0;
  let fourth = 0;
  let pairs = 0;
  for (const b of blocks) {
    for (let i = lag; i < b.length; i++) {
      const a = b[i] - m;
      const c = b[i - lag] - m;
      cross += a * c;
      fourth += a * a * c * c;
      pairs++;
    }
  }
  const ck = cross / n;
  const rho = ck / c0;
  const tau = fourth / n / (c0 * c0);
  const seRobust = Math.sqrt(tau / n);
  const seIid = 1 / Math.sqrt(n);
  const z = rho / seRobust;
  return { lag, n, pairs, rho, seIid, seRobust, z, p: twoSidedP(z), r2: rho * rho };
}

export function autocorrProfile(blocks: readonly Float64Array[], lags: readonly number[]): AutocorrResult[] {
  return lags.map((lag) => autocorrAt(blocks, lag));
}

export interface LjungBox {
  lags: number;
  /** Classic statistic; over-rejects under heteroskedasticity. */
  q: number;
  pClassic: number;
  /** Sum of squared robust z-scores — the same idea with honest scaling. */
  qRobust: number;
  pRobust: number;
}

export function ljungBox(blocks: readonly Float64Array[], maxLag: number): LjungBox {
  const results = autocorrProfile(blocks, Array.from({ length: maxLag }, (_, i) => i + 1));
  const n = results[0]?.n ?? 0;
  let q = 0;
  let qRobust = 0;
  for (const r of results) {
    q += (r.rho * r.rho) / (n - r.lag);
    qRobust += r.z * r.z;
  }
  q *= n * (n + 2);
  return { lags: maxLag, q, pClassic: chiSquareSf(q, maxLag), qRobust, pRobust: chiSquareSf(qRobust, maxLag) };
}

/**
 * Newey-West standard error of a sample mean. Overlapping windows make plain
 * i.i.d. errors optimistic; the Bartlett kernel with `bandwidth` lags fixes the
 * part of that which comes from short-range dependence.
 */
export function neweyWestSE(x: ArrayLike<number>, bandwidth: number): number {
  const n = x.length;
  if (n < 2) return Number.NaN;
  const m = mean(x);
  let g0 = 0;
  for (let i = 0; i < n; i++) {
    const d = x[i] - m;
    g0 += d * d;
  }
  g0 /= n;
  let sum = g0;
  for (let j = 1; j <= Math.min(bandwidth, n - 1); j++) {
    let gj = 0;
    for (let i = j; i < n; i++) gj += (x[i] - m) * (x[i - j] - m);
    gj /= n;
    sum += 2 * (1 - j / (bandwidth + 1)) * gj;
  }
  return Math.sqrt(Math.max(sum, 0) / n);
}

export interface SignEdge {
  lag: number;
  /** Number of decisions the rule would have made. */
  trades: number;
  /** Mean gross log return per bar held, in basis points. */
  edgeBps: number;
  seBps: number;
  t: number;
  p: number;
  /** Share of bars where the previous move's sign repeated. */
  hitRate: number;
}

/**
 * Gross payoff of the crudest possible momentum rule: hold sign(r_{t-lag}) for
 * one bar. This is the translation layer between a correlation coefficient and
 * money — an autocorrelation is unitless, this is basis points per round trip,
 * directly comparable with the 11 bp taker fee.
 *
 * Set `contrarian` to measure the mean-reversion side instead.
 */
export function signEdge(blocks: readonly Float64Array[], lag: number, contrarian = false): SignEdge {
  // Counted first, then filled: a growing number[] over a million-bar series
  // costs hundreds of megabytes that a Float64Array does not.
  let count = 0;
  for (const b of blocks) {
    for (let i = lag; i < b.length; i++) if (b[i - lag] !== 0) count++;
  }
  const arr = new Float64Array(count);
  let hits = 0;
  let at = 0;
  for (const b of blocks) {
    for (let i = lag; i < b.length; i++) {
      const dir = Math.sign(b[i - lag]) * (contrarian ? -1 : 1);
      if (dir === 0) continue;
      const value = dir * b[i];
      arr[at++] = value;
      if (value > 0) hits++;
    }
  }
  const m = mean(arr);
  const se = neweyWestSE(arr, Math.max(1, lag));
  const t = m / se;
  return {
    lag,
    trades: arr.length,
    edgeBps: m * 1e4,
    seBps: se * 1e4,
    t,
    p: twoSidedP(t),
    hitRate: arr.length > 0 ? hits / arr.length : Number.NaN,
  };
}

export interface MagnitudeBucket {
  label: string;
  n: number;
  /** Mean size of the move being reacted to, basis points. */
  meanTriggerBps: number;
  /** Mean of -sign(r_{t-lag}) * r_t: positive means the move partly reverses. */
  reversalBps: number;
  seBps: number;
  t: number;
  p: number;
  /** Share of cases where the next bar went against the trigger. */
  hitRate: number;
}

/**
 * Reversal after a move, split by how big that move was.
 *
 * A single autocorrelation coefficient hides where the dependence lives. Under
 * fat tails a correlation of -0.02 can mean "everything reverts a little" or
 * "the largest one percent of bars snap back and the rest do nothing" — two
 * completely different markets, only one of which has moves big enough to pay a
 * fee. This splits the sample by |r_{t-lag}| and reports the payoff of fading
 * each bucket in basis points.
 *
 * The bucket edges are quantiles of the whole sample, so they carry a whisper
 * of look-ahead. It is a whisper: a threshold estimated on a million bars moves
 * by a fraction of a percent between halves, and no trading decision here
 * depends on it.
 */
export function reversalByMagnitude(blocks: readonly Float64Array[], bucketCount = 10, lag = 1): MagnitudeBucket[] {
  let pairs = 0;
  for (const b of blocks) pairs += Math.max(0, b.length - lag);

  const trigger = new Float64Array(pairs);
  const next = new Float64Array(pairs);
  let at = 0;
  for (const b of blocks) {
    for (let i = lag; i < b.length; i++) {
      trigger[at] = b[i - lag];
      next[at] = b[i];
      at++;
    }
  }

  const abs = new Float64Array(pairs);
  for (let i = 0; i < pairs; i++) abs[i] = Math.abs(trigger[i]);
  const cuts: number[] = [];
  for (let k = 1; k < bucketCount; k++) cuts.push(quantile(abs, k / bucketCount));

  const counts = new Int32Array(bucketCount);
  const index = new Int32Array(pairs);
  for (let i = 0; i < pairs; i++) {
    let k = 0;
    while (k < cuts.length && abs[i] > cuts[k]) k++;
    index[i] = k;
    counts[k]++;
  }

  const payoff = Array.from(counts, (c) => new Float64Array(c));
  const triggerSum = new Float64Array(bucketCount);
  const filled = new Int32Array(bucketCount);
  const hits = new Int32Array(bucketCount);
  for (let i = 0; i < pairs; i++) {
    const k = index[i];
    const dir = -Math.sign(trigger[i]);
    const value = dir * next[i];
    payoff[k][filled[k]++] = value;
    triggerSum[k] += abs[i];
    if (value > 0) hits[k]++;
  }

  return payoff.map((arr, k) => {
    const m = mean(arr);
    const se = neweyWestSE(arr, Math.max(1, lag));
    const t = m / se;
    return {
      label: `D${k + 1}`,
      n: arr.length,
      meanTriggerBps: (triggerSum[k] / Math.max(1, counts[k])) * 1e4,
      reversalBps: m * 1e4,
      seBps: se * 1e4,
      t,
      p: twoSidedP(t),
      hitRate: arr.length > 0 ? hits[k] / arr.length : Number.NaN,
    };
  });
}
