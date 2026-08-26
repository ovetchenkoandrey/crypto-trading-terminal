import { mean, quantile, stdev } from "./descriptive.ts";
import { twoSidedP } from "./distributions.ts";
import type { PriceLookup } from "./series.ts";

/**
 * What happens around a funding settlement.
 *
 * Two separate questions live here. The first is mechanical: does price move in
 * a systematic way in the minutes before and after the payment, the way it
 * would if crowded positions were being closed to dodge the fee. The second is
 * economic: the funding rate is published in advance, so it is a genuine
 * ex-ante signal about positioning — and, unusually for this project, one whose
 * payoff is a cash flow rather than a price forecast.
 */

export interface FundingPoint {
  /** Settlement time, UTC seconds. */
  time: number;
  /** Rate for one interval; 0.0001 = 1 bp. */
  rate: number;
}

export interface WindowSpec {
  label: string;
  /** Offsets in minutes relative to settlement; return measured from -> to. */
  fromMin: number;
  toMin: number;
}

export interface WindowStat {
  label: string;
  fromMin: number;
  toMin: number;
  n: number;
  meanBps: number;
  seBps: number;
  t: number;
  p: number;
  medianBps: number;
}

const MINUTE = 60;

/** Mean return over a window anchored on each settlement. */
export function fundingWindowReturns(
  events: readonly FundingPoint[],
  priceAt: PriceLookup,
  windows: readonly WindowSpec[],
): WindowStat[] {
  return windows.map((w) => {
    const samples: number[] = [];
    for (const e of events) {
      const p0 = priceAt(e.time + w.fromMin * MINUTE);
      const p1 = priceAt(e.time + w.toMin * MINUTE);
      if (p0 === null || p1 === null || !(p0 > 0) || !(p1 > 0)) continue;
      samples.push(Math.log(p1 / p0));
    }
    const arr = Float64Array.from(samples);
    const m = mean(arr);
    const se = stdev(arr, m) / Math.sqrt(arr.length);
    const t = m / se;
    return {
      label: w.label,
      fromMin: w.fromMin,
      toMin: w.toMin,
      n: arr.length,
      meanBps: m * 1e4,
      seBps: se * 1e4,
      t,
      p: twoSidedP(t),
      medianBps: quantile(arr, 0.5) * 1e4,
    };
  });
}

export interface CarryBucket {
  label: string;
  n: number;
  /** Mean funding rate in the bucket, basis points per settlement. */
  meanRateBps: number;
  /** Mean price return over the interval that follows, basis points. */
  meanForwardBps: number;
  /**
   * Payoff of holding the side that receives funding until the next
   * settlement: the rate collected minus the price move against you.
   */
  carryBps: number;
  carrySeBps: number;
  carryT: number;
  carryP: number;
  /** Share of settlements where that hold ended positive. */
  winRate: number;
}

/**
 * Splits settlements into rate quantiles and measures the receive-funding hold.
 *
 * This is deliberately gross of fees: a single round trip costs 11 bp taker,
 * and the whole point is to see whether the carry is even the same order of
 * magnitude before deciding it is worth modelling execution for.
 */
export function fundingCarry(
  events: readonly FundingPoint[],
  priceAt: PriceLookup,
  intervalSec: number,
  bucketCount = 5,
): CarryBucket[] {
  const usable: { rate: number; forward: number }[] = [];
  for (const e of events) {
    const p0 = priceAt(e.time);
    const p1 = priceAt(e.time + intervalSec);
    if (p0 === null || p1 === null || !(p0 > 0) || !(p1 > 0)) continue;
    usable.push({ rate: e.rate, forward: Math.log(p1 / p0) });
  }
  const rates = Float64Array.from(usable.map((u) => u.rate));
  const cuts: number[] = [];
  for (let i = 1; i < bucketCount; i++) cuts.push(quantile(rates, i / bucketCount));

  const buckets: { rate: number; forward: number }[][] = Array.from({ length: bucketCount }, () => []);
  for (const u of usable) {
    let idx = 0;
    while (idx < cuts.length && u.rate > cuts[idx]) idx++;
    buckets[idx].push(u);
  }

  return buckets.map((rows, i) => {
    const carry = Float64Array.from(rows.map((r) => Math.abs(r.rate) - Math.sign(r.rate) * r.forward));
    const m = mean(carry);
    const se = stdev(carry, m) / Math.sqrt(carry.length);
    const t = m / se;
    let wins = 0;
    for (let k = 0; k < carry.length; k++) if (carry[k] > 0) wins++;
    return {
      label: `Q${i + 1}`,
      n: rows.length,
      meanRateBps: mean(Float64Array.from(rows.map((r) => r.rate))) * 1e4,
      meanForwardBps: mean(Float64Array.from(rows.map((r) => r.forward))) * 1e4,
      carryBps: m * 1e4,
      carrySeBps: se * 1e4,
      carryT: t,
      carryP: twoSidedP(t),
      winRate: carry.length > 0 ? wins / carry.length : Number.NaN,
    };
  });
}
