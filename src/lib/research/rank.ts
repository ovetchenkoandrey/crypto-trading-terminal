/**
 * Ranks and rank correlation.
 *
 * Spearman rather than Pearson everywhere in the screening, and not out of
 * habit: crypto returns carry an excess kurtosis of 90 on BTC and 380 on ETH.
 * A Pearson correlation on that is a report about the four largest bars in the
 * sample wearing the costume of a summary statistic. Ranks put every
 * observation on the same footing, which is also what a trading rule does when
 * it sizes every signal the same.
 */

/** Average ranks, 1-based, ties share their mean rank. */
export function ranks(values: ArrayLike<number>): Float64Array {
  const n = values.length;
  const order = new Int32Array(n);
  for (let i = 0; i < n; i++) order[i] = i;
  const idx = Array.from(order).sort((a, b) => values[a] - values[b]);

  const out = new Float64Array(n);
  let i = 0;
  while (i < n) {
    let j = i;
    while (j + 1 < n && values[idx[j + 1]] === values[idx[i]]) j++;
    const shared = (i + j) / 2 + 1;
    for (let k = i; k <= j; k++) out[idx[k]] = shared;
    i = j + 1;
  }
  return out;
}

/** Standardises in place to mean 0, standard deviation 1. Returns false if degenerate. */
export function standardize(values: Float64Array): boolean {
  const n = values.length;
  if (n < 2) return false;
  let sum = 0;
  for (let i = 0; i < n; i++) sum += values[i];
  const m = sum / n;
  let sq = 0;
  for (let i = 0; i < n; i++) {
    const d = values[i] - m;
    values[i] = d;
    sq += d * d;
  }
  const sd = Math.sqrt(sq / n);
  if (!(sd > 0)) return false;
  for (let i = 0; i < n; i++) values[i] /= sd;
  return true;
}

export function pearson(x: ArrayLike<number>, y: ArrayLike<number>): number {
  const n = Math.min(x.length, y.length);
  if (n < 2) return Number.NaN;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += x[i];
    my += y[i];
  }
  mx /= n;
  my /= n;
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
  if (!(sxx > 0) || !(syy > 0)) return Number.NaN;
  return sxy / Math.sqrt(sxx * syy);
}

export function spearman(x: ArrayLike<number>, y: ArrayLike<number>): number {
  return pearson(ranks(x), ranks(y));
}

/**
 * Quantile bucket index per observation, 0..count-1, computed from the sample's
 * own ranks. Ties spread across a boundary land wherever their shared rank puts
 * them, which is the honest treatment for a feature with a mass point (a sign,
 * a direction flag) — such a feature simply produces fewer distinct buckets.
 */
export function quantileBucketIndex(values: ArrayLike<number>, count: number): Int32Array {
  const n = values.length;
  const out = new Int32Array(n);
  if (count < 2 || n === 0) return out;
  const r = ranks(values);
  for (let i = 0; i < n; i++) {
    const b = Math.floor(((r[i] - 0.5) / n) * count);
    out[i] = Math.min(count - 1, Math.max(0, b));
  }
  return out;
}
