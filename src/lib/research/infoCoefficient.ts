import type { Candle } from "../types.ts";
import { neweyWestSE } from "./autocorr.ts";
import { chiSquareSf, twoSidedP } from "./distributions.ts";
import { quantileBucketIndex, ranks, standardize } from "./rank.ts";

/**
 * Measuring a signal's predictive power without building a strategy around it.
 *
 * The information coefficient is the rank correlation between what a feature
 * says today and what the market does over the next h bars. It costs one pass
 * over the data instead of a backtest, it has no parameters to overfit, and it
 * answers the only question that matters before any of the strategy questions:
 * is there anything in this number at all.
 *
 * Two things are done carefully here.
 *
 * Overlapping horizons. A 96-bar forward return computed at every bar shares 95
 * bars with its neighbour, so the effective sample is a hundredth of the row
 * count and an i.i.d. standard error is off by an order of magnitude. Every
 * standard error below is Newey-West with a bandwidth tied to the horizon.
 *
 * Effect size in money. An IC of 0.02 on a million rows is significant at any
 * threshold you like and worth nothing. Alongside every coefficient sits the
 * top-minus-bottom quantile spread in basis points, which is directly
 * comparable with the 11 bp taker round trip.
 */

/** Newey-West bandwidth for an overlapping h-bar forward return. */
export function hacBandwidth(horizon: number): number {
  return Math.max(1, Math.floor(2 * Math.max(1, horizon)));
}

/**
 * Log return from the close of bar i to the close of bar i + horizon, NaN where
 * the window runs past the end or crosses a data gap.
 */
export function forwardReturns(bars: readonly Candle[], horizon: number, intervalSec: number): Float64Array {
  const n = bars.length;
  const out = new Float64Array(n).fill(Number.NaN);
  const h = Math.max(1, Math.floor(horizon));
  for (let i = 0; i + h < n; i++) {
    const from = bars[i];
    const to = bars[i + h];
    if (to.time - from.time !== intervalSec * h) continue;
    if (!(from.close > 0) || !(to.close > 0)) continue;
    out[i] = Math.log(to.close / from.close);
  }
  return out;
}

export interface AlignedPairs {
  x: Float64Array;
  y: Float64Array;
  /** Bar index each pair came from, kept for regime slicing. */
  index: Int32Array;
}

/** Drops every position where either series is missing, preserving time order. */
export function alignPairs(feature: readonly (number | null)[], forward: Float64Array): AlignedPairs {
  const n = Math.min(feature.length, forward.length);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const f = feature[i];
    if (f === null || !Number.isFinite(f) || !Number.isFinite(forward[i])) continue;
    count++;
  }
  const x = new Float64Array(count);
  const y = new Float64Array(count);
  const index = new Int32Array(count);
  let at = 0;
  for (let i = 0; i < n; i++) {
    const f = feature[i];
    if (f === null || !Number.isFinite(f) || !Number.isFinite(forward[i])) continue;
    x[at] = f;
    y[at] = forward[i];
    index[at] = i;
    at++;
  }
  return { x, y, index };
}

export interface IcResult {
  n: number;
  /** Spearman rank correlation of feature against forward return. */
  ic: number;
  /** Newey-West standard error of that correlation. */
  se: number;
  /** i.i.d. standard error, 1/sqrt(n) — kept only to show how wrong it is. */
  seIid: number;
  z: number;
  p: number;
  /** Pearson on raw values, for the contrast with the rank version. */
  icPearson: number;
}

/**
 * IC with a heteroskedasticity- and autocorrelation-consistent standard error.
 *
 * The correlation is written as the mean of the product of standardised ranks,
 * which turns "standard error of a correlation" into "standard error of a mean"
 * and lets Newey-West do the work. The scaling constants are treated as known;
 * their estimation error is second order at these sample sizes.
 */
export function informationCoefficient(pairs: AlignedPairs, horizon: number): IcResult {
  const n = pairs.x.length;
  const empty: IcResult = {
    n,
    ic: Number.NaN,
    se: Number.NaN,
    seIid: Number.NaN,
    z: Number.NaN,
    p: Number.NaN,
    icPearson: Number.NaN,
  };
  if (n < 30) return empty;

  const u = ranks(pairs.x);
  const v = ranks(pairs.y);
  if (!standardize(u) || !standardize(v)) return empty;

  const prod = new Float64Array(n);
  for (let i = 0; i < n; i++) prod[i] = u[i] * v[i];
  let sum = 0;
  for (let i = 0; i < n; i++) sum += prod[i];
  const ic = sum / n;

  const se = neweyWestSE(prod, hacBandwidth(horizon));
  const z = ic / se;

  const rx = Float64Array.from(pairs.x);
  const ry = Float64Array.from(pairs.y);
  const pearsonOk = standardize(rx) && standardize(ry);
  let pear = 0;
  if (pearsonOk) {
    for (let i = 0; i < n; i++) pear += rx[i] * ry[i];
    pear /= n;
  }

  return {
    n,
    ic,
    se,
    seIid: 1 / Math.sqrt(n),
    z,
    p: twoSidedP(z),
    icPearson: pearsonOk ? pear : Number.NaN,
  };
}

export interface Bucket {
  index: number;
  n: number;
  /** Mean of the feature inside the bucket, raw units. */
  meanFeature: number;
  /** Mean forward return, basis points. */
  meanBps: number;
  seBps: number;
  t: number;
  /** Share of positive forward returns. */
  hitRate: number;
}

export interface BucketProfile {
  buckets: Bucket[];
  /** Top bucket minus bottom bucket, basis points — the long/short spread. */
  spreadBps: number;
  spreadSeBps: number;
  spreadT: number;
  spreadP: number;
  /** Spearman of bucket index against bucket mean: +1 is perfectly monotone up. */
  monotonicity: number;
  /** Steps that move in the direction of the overall spread, out of k-1. */
  monotoneSteps: number;
  /** Extremes minus middle, basis points. Large means a U or an inverted U. */
  curvatureBps: number;
  curvatureT: number;
  /** Chi-square of "all buckets share one mean". */
  chi2Equal: number;
  pEqual: number;
  /**
   * Chi-square of the residual after the best straight line through the quantile
   * means — a departure from a response that steps evenly from quantile to
   * quantile. It fires both on a U shape and on a monotone signal whose payoff
   * lives entirely in the outer buckets, which are different findings; read it
   * next to `monotonicity` and `curvatureBps` to tell them apart.
   */
  chi2Nonlinear: number;
  pNonlinear: number;
}

function bucketMeans(
  bucket: Int32Array,
  y: Float64Array,
  count: number,
  x: Float64Array,
  bandwidth: number,
): Bucket[] {
  const parts: number[][] = Array.from({ length: count }, () => []);
  const featureSum = new Float64Array(count);
  const hits = new Int32Array(count);
  for (let i = 0; i < y.length; i++) {
    const b = bucket[i];
    parts[b].push(y[i]);
    featureSum[b] += x[i];
    if (y[i] > 0) hits[b]++;
  }
  return parts.map((list, index) => {
    const arr = Float64Array.from(list);
    const n = arr.length;
    if (n === 0) {
      return { index, n, meanFeature: Number.NaN, meanBps: Number.NaN, seBps: Number.NaN, t: Number.NaN, hitRate: Number.NaN };
    }
    let sum = 0;
    for (let i = 0; i < n; i++) sum += arr[i];
    const m = sum / n;
    // Bucket members are scattered through time, so the overlap between two of
    // them is not adjacency in this array. Newey-West on the gathered series is
    // conservative-ish rather than exact; the spread test below is the one that
    // gets the careful treatment.
    const se = neweyWestSE(arr, bandwidth);
    return {
      index,
      n,
      meanFeature: featureSum[index] / n,
      meanBps: m * 1e4,
      seBps: se * 1e4,
      t: m / se,
      hitRate: hits[index] / n,
    };
  });
}

/**
 * Mean forward return per feature quantile.
 *
 * This is the part the information coefficient cannot do. A correlation of zero
 * is compatible with a feature whose extremes both predict a rise and whose
 * middle predicts a fall — a perfectly usable signal that the linear tools in
 * `market-stats.md` would have reported as nothing. The bucket profile shows the
 * shape, and the two chi-squares separate "no relation" from "a relation that is
 * not a straight line".
 */
export function bucketProfile(pairs: AlignedPairs, count: number, horizon: number): BucketProfile {
  const bandwidth = hacBandwidth(horizon);
  const bucket = quantileBucketIndex(pairs.x, count);
  const buckets = bucketMeans(bucket, pairs.y, count, pairs.x, bandwidth);

  // The spread is measured as one series so its standard error accounts for the
  // overlap directly: +1 in the top bucket, -1 in the bottom, 0 elsewhere,
  // rescaled by the share of rows that carry a weight.
  const top = count - 1;
  const weight = new Float64Array(pairs.y.length);
  let topN = 0;
  let botN = 0;
  for (let i = 0; i < pairs.y.length; i++) {
    if (bucket[i] === top) topN++;
    else if (bucket[i] === 0) botN++;
  }
  let spread = Number.NaN;
  let spreadSe = Number.NaN;
  if (topN > 0 && botN > 0) {
    const n = pairs.y.length;
    for (let i = 0; i < n; i++) {
      if (bucket[i] === top) weight[i] = (pairs.y[i] * n) / topN;
      else if (bucket[i] === 0) weight[i] = (-pairs.y[i] * n) / botN;
    }
    let sum = 0;
    for (let i = 0; i < n; i++) sum += weight[i];
    spread = sum / n;
    spreadSe = neweyWestSE(weight, bandwidth);
  }

  const defined = buckets.filter((b) => Number.isFinite(b.meanBps));
  const idx = defined.map((b) => b.index);
  const means = defined.map((b) => b.meanBps);
  const ses = defined.map((b) => b.seBps);

  let monotoneSteps = 0;
  const dir = Math.sign(spread || 0);
  for (let i = 1; i < means.length; i++) if (Math.sign(means[i] - means[i - 1]) === dir && dir !== 0) monotoneSteps++;

  const mid = defined[Math.floor(defined.length / 2)];
  const lo = defined[0];
  const hi = defined[defined.length - 1];
  let curvature = Number.NaN;
  let curvatureT = Number.NaN;
  if (lo && hi && mid && defined.length >= 3) {
    curvature = (lo.meanBps + hi.meanBps) / 2 - mid.meanBps;
    const se = Math.sqrt((lo.seBps ** 2 + hi.seBps ** 2) / 4 + mid.seBps ** 2);
    curvatureT = curvature / se;
  }

  // Weighted chi-squares: buckets are disjoint samples, so their means are
  // independent enough to add up.
  let wSum = 0;
  let wyPooled = 0;
  for (let i = 0; i < means.length; i++) {
    const w = 1 / (ses[i] * ses[i]);
    if (!Number.isFinite(w)) continue;
    wSum += w;
    wyPooled += w * means[i];
  }
  const pooled = wyPooled / wSum;
  let chi2Equal = 0;
  for (let i = 0; i < means.length; i++) {
    const w = 1 / (ses[i] * ses[i]);
    if (!Number.isFinite(w)) continue;
    chi2Equal += w * (means[i] - pooled) ** 2;
  }

  let sw = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < means.length; i++) {
    const w = 1 / (ses[i] * ses[i]);
    if (!Number.isFinite(w)) continue;
    sw += w;
    sx += w * idx[i];
    sy += w * means[i];
    sxx += w * idx[i] * idx[i];
    sxy += w * idx[i] * means[i];
  }
  const det = sw * sxx - sx * sx;
  let chi2Nonlinear = Number.NaN;
  const dfNonlinear = Math.max(1, means.length - 2);
  if (det !== 0) {
    const slope = (sw * sxy - sx * sy) / det;
    const intercept = (sy - slope * sx) / sw;
    chi2Nonlinear = 0;
    for (let i = 0; i < means.length; i++) {
      const w = 1 / (ses[i] * ses[i]);
      if (!Number.isFinite(w)) continue;
      chi2Nonlinear += w * (means[i] - (intercept + slope * idx[i])) ** 2;
    }
  }

  const rankIdx = Float64Array.from(idx);
  const rankMeans = Float64Array.from(means);
  let monotonicity = Number.NaN;
  if (means.length >= 3) {
    const a = ranks(rankIdx);
    const b = ranks(rankMeans);
    let ma = 0;
    let mb = 0;
    for (let i = 0; i < a.length; i++) {
      ma += a[i];
      mb += b[i];
    }
    ma /= a.length;
    mb /= b.length;
    let cov = 0;
    let va = 0;
    let vb = 0;
    for (let i = 0; i < a.length; i++) {
      cov += (a[i] - ma) * (b[i] - mb);
      va += (a[i] - ma) ** 2;
      vb += (b[i] - mb) ** 2;
    }
    monotonicity = va > 0 && vb > 0 ? cov / Math.sqrt(va * vb) : Number.NaN;
  }

  const spreadT = spread / spreadSe;
  return {
    buckets,
    spreadBps: spread * 1e4,
    spreadSeBps: spreadSe * 1e4,
    spreadT,
    spreadP: twoSidedP(spreadT),
    monotonicity,
    monotoneSteps,
    curvatureBps: curvature,
    curvatureT,
    chi2Equal,
    pEqual: chiSquareSf(chi2Equal, Math.max(1, means.length - 1)),
    chi2Nonlinear,
    pNonlinear: chiSquareSf(chi2Nonlinear, dfNonlinear),
  };
}

export interface ConditionalIc {
  label: string;
  ic: IcResult;
}

export interface InteractionResult {
  regimes: ConditionalIc[];
  /** Largest gap between two regime ICs, in standard errors of that gap. */
  maxDiffZ: number;
  maxDiffLabel: string;
  /** Chi-square of "the IC is the same in every regime". */
  chi2: number;
  p: number;
}

/**
 * The same IC computed inside each regime, plus a test that the regimes differ.
 *
 * This is the direct answer to "does the feature only work when volatility is
 * high". A feature with a zero unconditional IC and a large positive one in the
 * top volatility tercile is exactly the nonlinear dependence the autocorrelation
 * study was structurally unable to see.
 */
export function conditionalIc(
  pairs: AlignedPairs,
  regimeOf: (barIndex: number) => number,
  labels: readonly string[],
  horizon: number,
): InteractionResult {
  const groups: { x: number[]; y: number[] }[] = labels.map(() => ({ x: [], y: [] }));
  for (let i = 0; i < pairs.x.length; i++) {
    const r = regimeOf(pairs.index[i]);
    if (r < 0 || r >= labels.length) continue;
    groups[r].x.push(pairs.x[i]);
    groups[r].y.push(pairs.y[i]);
  }

  const regimes = groups.map((g, i) => ({
    label: labels[i],
    ic: informationCoefficient(
      { x: Float64Array.from(g.x), y: Float64Array.from(g.y), index: new Int32Array(g.x.length) },
      horizon,
    ),
  }));

  let maxDiffZ = 0;
  let maxDiffLabel = "";
  for (let a = 0; a < regimes.length; a++) {
    for (let b = a + 1; b < regimes.length; b++) {
      const ia = regimes[a].ic;
      const ib = regimes[b].ic;
      if (!Number.isFinite(ia.ic) || !Number.isFinite(ib.ic)) continue;
      const z = (ia.ic - ib.ic) / Math.sqrt(ia.se * ia.se + ib.se * ib.se);
      if (Math.abs(z) > Math.abs(maxDiffZ)) {
        maxDiffZ = z;
        maxDiffLabel = `${regimes[a].label} vs ${regimes[b].label}`;
      }
    }
  }

  let sw = 0;
  let swy = 0;
  for (const r of regimes) {
    if (!Number.isFinite(r.ic.ic) || !(r.ic.se > 0)) continue;
    const w = 1 / (r.ic.se * r.ic.se);
    sw += w;
    swy += w * r.ic.ic;
  }
  const pooled = swy / sw;
  let chi2 = 0;
  let df = 0;
  for (const r of regimes) {
    if (!Number.isFinite(r.ic.ic) || !(r.ic.se > 0)) continue;
    const w = 1 / (r.ic.se * r.ic.se);
    chi2 += w * (r.ic.ic - pooled) ** 2;
    df++;
  }
  df = Math.max(1, df - 1);

  return { regimes, maxDiffZ, maxDiffLabel, chi2, p: chiSquareSf(chi2, df) };
}

export interface PairCell {
  row: number;
  col: number;
  n: number;
  meanBps: number;
  seBps: number;
}

export interface PairGrid {
  size: number;
  cells: PairCell[];
  /** Best cell minus worst cell, basis points. */
  spreadBps: number;
  /** Chi-square of the residual after row and column effects — the interaction. */
  chi2Interaction: number;
  pInteraction: number;
  /** Largest cell residual against the additive prediction, in standard errors. */
  maxCellZ: number;
  maxCellLabel: string;
}

/**
 * Two features crossed into a grid, tested for interaction.
 *
 * The additive model (row effect plus column effect) is what you get for free
 * from the two features separately. Anything the grid does beyond that is the
 * combination carrying information neither feature has on its own — which is
 * the only reason to prefer a pair over the better of the two.
 */
export function pairGrid(
  xa: AlignedPairs,
  featureB: readonly (number | null)[],
  size: number,
  horizon: number,
): PairGrid {
  const n = xa.x.length;
  const bValues = new Float64Array(n);
  const keep = new Uint8Array(n);
  let kept = 0;
  for (let i = 0; i < n; i++) {
    const v = featureB[xa.index[i]];
    if (v === null || v === undefined || !Number.isFinite(v)) continue;
    bValues[i] = v;
    keep[i] = 1;
    kept++;
  }

  const xs = new Float64Array(kept);
  const bs = new Float64Array(kept);
  const ys = new Float64Array(kept);
  let at = 0;
  for (let i = 0; i < n; i++) {
    if (!keep[i]) continue;
    xs[at] = xa.x[i];
    bs[at] = bValues[i];
    ys[at] = xa.y[i];
    at++;
  }

  const rowIdx = quantileBucketIndex(xs, size);
  const colIdx = quantileBucketIndex(bs, size);
  const bandwidth = hacBandwidth(horizon);

  const lists: number[][][] = Array.from({ length: size }, () => Array.from({ length: size }, () => [] as number[]));
  for (let i = 0; i < kept; i++) lists[rowIdx[i]][colIdx[i]].push(ys[i]);

  const cells: PairCell[] = [];
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      const arr = Float64Array.from(lists[r][c]);
      if (arr.length === 0) {
        cells.push({ row: r, col: c, n: 0, meanBps: Number.NaN, seBps: Number.NaN });
        continue;
      }
      let sum = 0;
      for (let i = 0; i < arr.length; i++) sum += arr[i];
      const m = sum / arr.length;
      cells.push({ row: r, col: c, n: arr.length, meanBps: m * 1e4, seBps: neweyWestSE(arr, bandwidth) * 1e4 });
    }
  }

  const usable = cells.filter((c) => c.n > 0 && Number.isFinite(c.meanBps) && c.seBps > 0);
  let best = -Infinity;
  let worst = Infinity;
  for (const c of usable) {
    best = Math.max(best, c.meanBps);
    worst = Math.min(worst, c.meanBps);
  }

  // Weighted two-way additive fit, solved by a few sweeps rather than by
  // building a design matrix: the grid is 3x3 or 4x4 and the sweeps converge in
  // a handful of passes.
  const rowEff = new Float64Array(size);
  const colEff = new Float64Array(size);
  let grand = 0;
  let wTotal = 0;
  for (const c of usable) {
    const w = 1 / (c.seBps * c.seBps);
    grand += w * c.meanBps;
    wTotal += w;
  }
  grand /= wTotal;
  for (let sweep = 0; sweep < 50; sweep++) {
    for (let r = 0; r < size; r++) {
      let num = 0;
      let den = 0;
      for (const c of usable) {
        if (c.row !== r) continue;
        const w = 1 / (c.seBps * c.seBps);
        num += w * (c.meanBps - grand - colEff[c.col]);
        den += w;
      }
      rowEff[r] = den > 0 ? num / den : 0;
    }
    for (let k = 0; k < size; k++) {
      let num = 0;
      let den = 0;
      for (const c of usable) {
        if (c.col !== k) continue;
        const w = 1 / (c.seBps * c.seBps);
        num += w * (c.meanBps - grand - rowEff[c.row]);
        den += w;
      }
      colEff[k] = den > 0 ? num / den : 0;
    }
  }

  let chi2 = 0;
  let maxCellZ = 0;
  let maxCellLabel = "";
  for (const c of usable) {
    const w = 1 / (c.seBps * c.seBps);
    const resid = c.meanBps - (grand + rowEff[c.row] + colEff[c.col]);
    chi2 += w * resid * resid;
    const z = resid / c.seBps;
    if (Math.abs(z) > Math.abs(maxCellZ)) {
      maxCellZ = z;
      maxCellLabel = `r${c.row + 1}c${c.col + 1}`;
    }
  }
  const df = Math.max(1, (size - 1) * (size - 1));

  return {
    size,
    cells,
    spreadBps: best - worst,
    chi2Interaction: chi2,
    pInteraction: chiSquareSf(chi2, df),
    maxCellZ,
    maxCellLabel,
  };
}
