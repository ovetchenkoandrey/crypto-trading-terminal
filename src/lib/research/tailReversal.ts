import { neweyWestSE } from "./autocorr.ts";
import { mean, quantile } from "./descriptive.ts";
import { twoSidedP } from "./distributions.ts";
import type { ReturnSeries } from "./series.ts";

/**
 * What happens after an extreme bar, held for several bars.
 *
 * The decile view in `reversalByMagnitude` stops at the top ten percent, which
 * for a minute series is still an ordinary bar. The interesting question is
 * narrower: after a move so large it can only be a liquidation cascade or a news
 * print, does price come back, by how much, and over what horizon. A one-bar
 * measurement would miss it — if the snap back takes twenty minutes, holding for
 * one shows nothing.
 *
 * Two warnings travel with every number this produces.
 *
 * The samples are small by construction. The top 0.01% of a two-year minute
 * series is about a hundred events, so a t-statistic near three is one lucky
 * quarter away from vanishing, and the confidence interval is the honest
 * summary rather than the point estimate.
 *
 * And it is exactly the regime where the cost model is least trustworthy: in a
 * cascade the book thins out, spreads widen by an order of magnitude, and the
 * standard 11 bp round trip stops describing anything.
 */

export interface TailReversalRow {
  /** Quantile of |return| that defines the trigger, e.g. 0.999. */
  percentile: number;
  thresholdBps: number;
  /** Bars held after the trigger bar. */
  horizon: number;
  n: number;
  /** Mean of -sign(trigger) * cumulative return over the horizon, in bps. */
  reversalBps: number;
  seBps: number;
  t: number;
  p: number;
  ciLowBps: number;
  ciHighBps: number;
  hitRate: number;
}

/**
 * @param series     return series with timestamps; gaps break a horizon
 * @param percentiles trigger quantiles of |return|
 * @param horizons   how many bars to hold after the trigger
 */
export function tailReversal(
  series: ReturnSeries,
  percentiles: readonly number[] = [0.99, 0.995, 0.999, 0.9999],
  horizons: readonly number[] = [1, 5, 15, 60],
  z95 = 1.959963985,
): TailReversalRow[] {
  const { value, time, intervalSec } = series;
  const n = value.length;
  const abs = new Float64Array(n);
  for (let i = 0; i < n; i++) abs[i] = Math.abs(value[i]);

  const out: TailReversalRow[] = [];
  for (const p of percentiles) {
    const threshold = quantile(abs, p);
    for (const h of horizons) {
      let count = 0;
      for (let i = 0; i + h < n; i++) {
        if (abs[i] < threshold) continue;
        if (time[i + h] - time[i] !== h * intervalSec) continue;
        count++;
      }
      const payoff = new Float64Array(count);
      let at = 0;
      let hits = 0;
      for (let i = 0; i + h < n; i++) {
        if (abs[i] < threshold) continue;
        if (time[i + h] - time[i] !== h * intervalSec) continue;
        let sum = 0;
        for (let k = 1; k <= h; k++) sum += value[i + k];
        const v = -Math.sign(value[i]) * sum;
        payoff[at++] = v;
        if (v > 0) hits++;
      }
      const m = mean(payoff);
      const se = neweyWestSE(payoff, h);
      const t = m / se;
      out.push({
        percentile: p,
        thresholdBps: threshold * 1e4,
        horizon: h,
        n: count,
        reversalBps: m * 1e4,
        seBps: se * 1e4,
        t,
        p: twoSidedP(t),
        ciLowBps: (m - z95 * se) * 1e4,
        ciHighBps: (m + z95 * se) * 1e4,
        hitRate: count > 0 ? hits / count : Number.NaN,
      });
    }
  }
  return out;
}
