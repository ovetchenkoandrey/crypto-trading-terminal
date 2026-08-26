import { mean } from "./descriptive.ts";
import { twoSidedP } from "./distributions.ts";

/**
 * Ordinary least squares with an intercept, small enough to stay simple: the
 * designs used here have at most a handful of regressors, so normal equations
 * plus Gaussian elimination beat anything cleverer.
 *
 * Standard errors are White (HC0). Financial residuals are heteroskedastic by
 * construction and the classical formula would understate them.
 */

export interface OlsFit {
  n: number;
  /** Intercept first, then one per column of X. */
  coef: number[];
  seHC0: number[];
  t: number[];
  p: number[];
  r2: number;
  adjR2: number;
  residualStdev: number;
}

function solve(a: number[][], b: number[]): number[] {
  const k = b.length;
  const m = a.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < k; col++) {
    let pivot = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(m[r][col]) > Math.abs(m[pivot][col])) pivot = r;
    if (Math.abs(m[pivot][col]) < 1e-14) throw new Error("singular design matrix");
    const swap = m[col];
    m[col] = m[pivot];
    m[pivot] = swap;
    const d = m[col][col];
    for (let c = col; c <= k; c++) m[col][c] /= d;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = m[r][col];
      if (f === 0) continue;
      for (let c = col; c <= k; c++) m[r][c] -= f * m[col][c];
    }
  }
  return m.map((row) => row[k]);
}

function invert(a: number[][]): number[][] {
  const k = a.length;
  const columns: number[][] = [];
  for (let i = 0; i < k; i++) {
    const e = new Array(k).fill(0);
    e[i] = 1;
    columns.push(
      solve(
        a.map((r) => [...r]),
        e,
      ),
    );
  }
  const out: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < k; i++) for (let j = 0; j < k; j++) out[j][i] = columns[i][j];
  return out;
}

/** Fits y on [1, X...]. `x` is column-major: one array per regressor. */
export function ols(y: ArrayLike<number>, x: readonly ArrayLike<number>[]): OlsFit {
  const n = y.length;
  const k = x.length + 1;
  const design = (i: number, j: number): number => (j === 0 ? 1 : x[j - 1][i]);

  const xtx: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  const xty: number[] = new Array(k).fill(0);
  for (let i = 0; i < n; i++) {
    for (let a = 0; a < k; a++) {
      const da = design(i, a);
      xty[a] += da * y[i];
      for (let b = a; b < k; b++) xtx[a][b] += da * design(i, b);
    }
  }
  for (let a = 0; a < k; a++) for (let b = 0; b < a; b++) xtx[a][b] = xtx[b][a];

  const coef = solve(
    xtx.map((r) => [...r]),
    xty,
  );
  const inv = invert(xtx);

  let sse = 0;
  const meat: number[][] = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < n; i++) {
    let fit = 0;
    for (let a = 0; a < k; a++) fit += coef[a] * design(i, a);
    const e = y[i] - fit;
    sse += e * e;
    const e2 = e * e;
    for (let a = 0; a < k; a++) {
      const da = design(i, a);
      for (let b = 0; b < k; b++) meat[a][b] += e2 * da * design(i, b);
    }
  }
  const my = mean(y);
  let sst = 0;
  for (let i = 0; i < n; i++) sst += (y[i] - my) * (y[i] - my);

  const seHC0: number[] = [];
  for (let a = 0; a < k; a++) {
    let v = 0;
    for (let b = 0; b < k; b++) for (let c = 0; c < k; c++) v += inv[a][b] * meat[b][c] * inv[c][a];
    seHC0.push(Math.sqrt(Math.max(v, 0)));
  }
  const t = coef.map((c, i) => c / seHC0[i]);
  const r2 = 1 - sse / sst;
  return {
    n,
    coef,
    seHC0,
    t,
    p: t.map(twoSidedP),
    r2,
    adjR2: 1 - (1 - r2) * ((n - 1) / (n - k)),
    residualStdev: Math.sqrt(sse / (n - k)),
  };
}

export function predict(fit: OlsFit, x: readonly ArrayLike<number>[], i: number): number {
  let out = fit.coef[0];
  for (let j = 0; j < x.length; j++) out += fit.coef[j + 1] * x[j][i];
  return out;
}

export interface SplitForecast {
  trainN: number;
  testN: number;
  inSampleR2: number;
  /** Out-of-sample R2 against the training-period mean as the benchmark. */
  outOfSampleR2: number;
  /** Correlation between forecast and realisation on the test slice. */
  testCorrelation: number;
  fit: OlsFit;
}

function slice(arr: ArrayLike<number>, from: number, to: number): Float64Array {
  const out = new Float64Array(to - from);
  for (let i = from; i < to; i++) out[i - from] = arr[i];
  return out;
}

/**
 * Fits on the first `trainFraction` of the sample and scores on the rest.
 * In-sample R2 measures the fit, not predictive power; only the out-of-sample
 * number answers "would this have helped".
 */
export function forecastSplit(y: ArrayLike<number>, x: readonly ArrayLike<number>[], trainFraction = 0.7): SplitForecast {
  const n = y.length;
  const cut = Math.floor(n * trainFraction);
  const yTrain = slice(y, 0, cut);
  const xTrain = x.map((c) => slice(c, 0, cut));
  const fit = ols(yTrain, xTrain);

  const yTest = slice(y, cut, n);
  const xTest = x.map((c) => slice(c, cut, n));
  const benchmark = mean(yTrain);
  let sse = 0;
  let sst = 0;
  const pred = new Float64Array(yTest.length);
  for (let i = 0; i < yTest.length; i++) {
    pred[i] = predict(fit, xTest, i);
    const e = yTest[i] - pred[i];
    sse += e * e;
    sst += (yTest[i] - benchmark) * (yTest[i] - benchmark);
  }

  const mp = mean(pred);
  const mt = mean(yTest);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < yTest.length; i++) {
    const dx = pred[i] - mp;
    const dy = yTest[i] - mt;
    sxy += dx * dy;
    sxx += dx * dx;
    syy += dy * dy;
  }

  return {
    trainN: cut,
    testN: yTest.length,
    inSampleR2: fit.r2,
    outOfSampleR2: 1 - sse / sst,
    testCorrelation: sxy / Math.sqrt(sxx * syy),
    fit,
  };
}
