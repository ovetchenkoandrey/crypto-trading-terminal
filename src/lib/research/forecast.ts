import { neweyWestSE } from "./autocorr.ts";
import { mean } from "./descriptive.ts";
import { twoSidedP } from "./distributions.ts";
import { ols, predict, type OlsFit } from "./regression.ts";

/**
 * How much of the next bar is knowable from the recent past, measured as a
 * budget rather than one coefficient at a time.
 *
 * A single autocorrelation can be small while several together add up to
 * something; this fits all of them at once and then scores the fit on data it
 * never saw. The out-of-sample R2 is the answer to "how big is the
 * predictability", and the sign-following edge on the same held-out slice is
 * that answer restated in basis points, where it can be put next to the fee.
 */

export interface DirectionForecast {
  lags: number;
  rows: number;
  trainRows: number;
  testRows: number;
  inSampleR2: number;
  outOfSampleR2: number;
  /** Gross basis points per bar from trading the sign of the forecast. */
  testEdgeBps: number;
  testEdgeSeBps: number;
  testEdgeT: number;
  testEdgeP: number;
  testTrades: number;
  /** t-statistics of the lag coefficients, intercept excluded. */
  lagT: number[];
  fit: OlsFit;
}

/**
 * Builds the design matrix out of gap-free blocks: row t uses r_{t-1}..r_{t-L}
 * as regressors, and only rows whose whole history sits inside one block are
 * used. Rows keep their original order so the train/test split stays a split in
 * time, not a random one.
 */
export function directionForecast(blocks: readonly Float64Array[], lags: number, trainFraction = 0.7): DirectionForecast {
  let rows = 0;
  for (const b of blocks) rows += Math.max(0, b.length - lags);

  const y = new Float64Array(rows);
  const x = Array.from({ length: lags }, () => new Float64Array(rows));
  let at = 0;
  for (const b of blocks) {
    for (let i = lags; i < b.length; i++) {
      y[at] = b[i];
      for (let k = 0; k < lags; k++) x[k][at] = b[i - 1 - k];
      at++;
    }
  }
  const cut = Math.floor(rows * trainFraction);

  const yTrain = y.subarray(0, cut);
  const xTrain = x.map((col) => col.subarray(0, cut));
  const fit = ols(yTrain, xTrain);

  const yTest = y.subarray(cut);
  const xTest = x.map((col) => col.subarray(cut));
  const benchmark = mean(yTrain);
  let sse = 0;
  let sst = 0;
  const payoff = new Float64Array(yTest.length);
  let traded = 0;
  for (let i = 0; i < yTest.length; i++) {
    const p = predict(fit, xTest, i);
    const e = yTest[i] - p;
    sse += e * e;
    sst += (yTest[i] - benchmark) * (yTest[i] - benchmark);
    const dir = Math.sign(p);
    if (dir !== 0) payoff[traded++] = dir * yTest[i];
  }
  const arr = payoff.subarray(0, traded);
  const edge = mean(arr);
  const se = neweyWestSE(arr, Math.max(1, lags));
  const t = edge / se;

  return {
    lags,
    rows,
    trainRows: cut,
    testRows: yTest.length,
    inSampleR2: fit.r2,
    outOfSampleR2: 1 - sse / sst,
    testEdgeBps: edge * 1e4,
    testEdgeSeBps: se * 1e4,
    testEdgeT: t,
    testEdgeP: twoSidedP(t),
    testTrades: arr.length,
    lagT: fit.t.slice(1),
    fit,
  };
}
