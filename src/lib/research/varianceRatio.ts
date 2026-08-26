import { twoSidedP } from "./distributions.ts";

/**
 * Lo-MacKinlay variance ratio test.
 *
 * Under a random walk the variance of a q-period return is q times the variance
 * of a one-period return, so VR(q) = 1. Above 1 the series trends (returns
 * reinforce each other), below 1 it mean-reverts. The test aggregates the first
 * q-1 autocorrelations with triangular weights, which is why it sees structure
 * that no single lag shows.
 *
 * Both statistics are reported. The homoskedastic one is the textbook version
 * and is wrong for this data — it reads volatility clustering as evidence
 * against the random walk. The heteroskedasticity-consistent z* is the one to
 * quote; it rejects only for genuine serial correlation in the mean.
 */

export interface VarianceRatioResult {
  q: number;
  n: number;
  /** Overlapping q-period sums used. */
  windows: number;
  vr: number;
  /** VR - 1: positive means trending, negative means reverting. */
  excess: number;
  zHomoskedastic: number;
  pHomoskedastic: number;
  zHeteroskedastic: number;
  pHeteroskedastic: number;
  /** 95% interval for VR under the robust standard error. */
  ciLow: number;
  ciHigh: number;
}

function pooledStats(blocks: readonly Float64Array[]): { m: number; n: number; sumSq: number } {
  let s = 0;
  let n = 0;
  for (const b of blocks) {
    for (let i = 0; i < b.length; i++) s += b[i];
    n += b.length;
  }
  const m = n > 0 ? s / n : Number.NaN;
  let sumSq = 0;
  for (const b of blocks) {
    for (let i = 0; i < b.length; i++) {
      const d = b[i] - m;
      sumSq += d * d;
    }
  }
  return { m, n, sumSq };
}

/** delta_j from Lo-MacKinlay (1988), eq. 16 — the robust variance ingredient. */
function deltaAt(blocks: readonly Float64Array[], m: number, n: number, sumSq: number, j: number): number {
  let acc = 0;
  for (const b of blocks) {
    for (let i = j; i < b.length; i++) {
      const a = b[i] - m;
      const c = b[i - j] - m;
      acc += a * a * c * c;
    }
  }
  return (n * acc) / (sumSq * sumSq);
}

export function varianceRatio(blocks: readonly Float64Array[], q: number, z95 = 1.959963985): VarianceRatioResult {
  if (q < 2) throw new Error(`variance ratio needs q >= 2, got ${q}`);
  const { m, n, sumSq } = pooledStats(blocks);
  const varA = sumSq / (n - 1);

  let acc = 0;
  let windows = 0;
  for (const b of blocks) {
    if (b.length < q) continue;
    let running = 0;
    for (let i = 0; i < b.length; i++) {
      running += b[i];
      if (i >= q) running -= b[i - q];
      if (i >= q - 1) {
        const d = running - q * m;
        acc += d * d;
        windows++;
      }
    }
  }
  const norm = q * windows * (1 - q / n);
  const varC = acc / norm;
  const vr = varC / varA;

  const phi = (2 * (2 * q - 1) * (q - 1)) / (3 * q);
  const zHomo = (Math.sqrt(n) * (vr - 1)) / Math.sqrt(phi);

  let theta = 0;
  for (let j = 1; j < q; j++) {
    const w = (2 * (q - j)) / q;
    theta += w * w * deltaAt(blocks, m, n, sumSq, j);
  }
  const seRobust = Math.sqrt(theta / n);
  const zHet = (vr - 1) / seRobust;

  return {
    q,
    n,
    windows,
    vr,
    excess: vr - 1,
    zHomoskedastic: zHomo,
    pHomoskedastic: twoSidedP(zHomo),
    zHeteroskedastic: zHet,
    pHeteroskedastic: twoSidedP(zHet),
    ciLow: vr - z95 * seRobust,
    ciHigh: vr + z95 * seRobust,
  };
}

export function varianceRatioProfile(blocks: readonly Float64Array[], qs: readonly number[]): VarianceRatioResult[] {
  return qs.map((q) => varianceRatio(blocks, q));
}
