import { neweyWestSE } from "./autocorr.ts";
import { mean } from "./descriptive.ts";
import { twoSidedP } from "./distributions.ts";
import type { ReturnSeries } from "./series.ts";

/**
 * Cross-symbol lead-lag.
 *
 * If one instrument moves first and the other follows with a delay, the delay
 * is exploitable in a way single-series autocorrelation never shows: the
 * follower's next return is predicted by the leader's current one. On a venue
 * that lists both perpetuals side by side any such lag should be arbitraged to
 * nothing, so measuring it is also a sanity check on the data itself.
 */

export interface AlignedPair {
  time: Float64Array;
  a: Float64Array;
  b: Float64Array;
  intervalSec: number;
}

/** Keeps only timestamps present in both series, in ascending order. */
export function alignSeries(a: ReturnSeries, b: ReturnSeries): AlignedPair {
  if (a.intervalSec !== b.intervalSec) throw new Error("cannot align series of different intervals");
  const index = new Map<number, number>();
  for (let i = 0; i < b.time.length; i++) index.set(b.time[i], i);
  const time: number[] = [];
  const av: number[] = [];
  const bv: number[] = [];
  for (let i = 0; i < a.time.length; i++) {
    const j = index.get(a.time[i]);
    if (j === undefined) continue;
    time.push(a.time[i]);
    av.push(a.value[i]);
    bv.push(b.value[j]);
  }
  return { time: Float64Array.from(time), a: Float64Array.from(av), b: Float64Array.from(bv), intervalSec: a.intervalSec };
}

export interface CrossCorrResult {
  /** Positive lag: a at t against b at t + lag, i.e. "does a lead b". */
  lag: number;
  n: number;
  corr: number;
  seRobust: number;
  z: number;
  p: number;
  /** Mean of sign(a_t) * b_{t+lag}, in basis points — the tradable form. */
  edgeBps: number;
  edgeSeBps: number;
  edgeT: number;
}

export function crossCorrelation(pair: AlignedPair, lag: number): CrossCorrResult {
  const { a, b, time, intervalSec } = pair;
  const ma = mean(a);
  const mb = mean(b);
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  let fourth = 0;
  let n = 0;
  const payoff: number[] = [];
  for (let i = 0; i < a.length; i++) {
    const j = i + lag;
    if (j < 0 || j >= b.length) continue;
    // Only pairs that really are `lag` bars apart; gaps must not be bridged.
    if (time[j] - time[i] !== lag * intervalSec) continue;
    const da = a[i] - ma;
    const db = b[j] - mb;
    sxy += da * db;
    sxx += da * da;
    syy += db * db;
    fourth += da * da * db * db;
    n++;
    const dir = Math.sign(a[i]);
    if (dir !== 0) payoff.push(dir * b[j]);
  }
  const corr = sxy / Math.sqrt(sxx * syy);
  const seRobust = Math.sqrt(fourth / n / ((sxx / n) * (syy / n)) / n);
  const z = corr / seRobust;

  const arr = Float64Array.from(payoff);
  const edge = mean(arr);
  const edgeSe = neweyWestSE(arr, Math.max(1, Math.abs(lag)));
  return {
    lag,
    n,
    corr,
    seRobust,
    z,
    p: twoSidedP(z),
    edgeBps: edge * 1e4,
    edgeSeBps: edgeSe * 1e4,
    edgeT: edge / edgeSe,
  };
}

export function crossCorrelationProfile(pair: AlignedPair, lags: readonly number[]): CrossCorrResult[] {
  return lags.map((lag) => crossCorrelation(pair, lag));
}
