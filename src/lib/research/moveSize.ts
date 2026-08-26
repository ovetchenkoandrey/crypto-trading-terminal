import { breakEvenHitRate, costShareOfMove, COST_FLOORS } from "./costs.ts";
import { mean, quantileSorted } from "./descriptive.ts";

/**
 * How big a bar is, measured against what a round trip costs.
 *
 * This is the arithmetic that killed three hypotheses after the fact and could
 * have killed them before a line of strategy code was written: if the median
 * bar at a timeframe moves 4 basis points and a round trip costs 11, no signal
 * on that timeframe can pay for itself, however good it is.
 */

export interface CostComparison {
  label: string;
  roundTripBps: number;
  /** Share of bars whose absolute move exceeds the round trip. */
  shareAboveCost: number;
  /** Round trip as a multiple of the median absolute move. */
  costOverMedian: number;
  /** Win rate needed at a target equal to the median absolute move. */
  breakEvenAtMedian: number;
}

export interface MoveProfile {
  label: string;
  intervalSec: number;
  n: number;
  /** Absolute close-to-close move, basis points. */
  meanAbsBps: number;
  medianAbsBps: number;
  p25Bps: number;
  p75Bps: number;
  p90Bps: number;
  p99Bps: number;
  /** Standard deviation of the signed return, basis points. */
  stdevBps: number;
  /** Mean high-low range of the bar, basis points of the open. */
  meanRangeBps: number;
  /**
   * Everything a perfect one-bar-ahead forecast could earn per day, in percent:
   * the sum of absolute moves. The ceiling on any strategy at this timeframe.
   */
  oracleDailyPct: number;
  /** Bars per day at this interval. */
  barsPerDay: number;
  costs: CostComparison[];
}

export interface MoveInput {
  label: string;
  intervalSec: number;
  /** Signed log returns. */
  returns: ArrayLike<number>;
  /** Optional (high - low) / open per bar, as a fraction. */
  ranges?: ArrayLike<number>;
}

export function moveProfile(input: MoveInput): MoveProfile {
  const { returns, intervalSec } = input;
  const n = returns.length;
  const abs = new Float64Array(n);
  for (let i = 0; i < n; i++) abs[i] = Math.abs(returns[i]);
  const sorted = Float64Array.from(abs);
  sorted.sort();

  const meanAbs = mean(abs);
  const medianAbs = quantileSorted(sorted, 0.5);
  const m = mean(returns);
  let sq = 0;
  for (let i = 0; i < n; i++) sq += (returns[i] - m) * (returns[i] - m);
  const sd = Math.sqrt(sq / Math.max(1, n - 1));

  const barsPerDay = 86400 / intervalSec;
  const costs: CostComparison[] = COST_FLOORS.map((floor) => {
    const threshold = floor.roundTripBps / 1e4;
    let above = 0;
    for (let i = 0; i < n; i++) if (abs[i] > threshold) above++;
    return {
      label: floor.label,
      roundTripBps: floor.roundTripBps,
      shareAboveCost: n > 0 ? above / n : Number.NaN,
      costOverMedian: costShareOfMove(medianAbs * 1e4, floor.roundTripBps),
      breakEvenAtMedian: breakEvenHitRate(medianAbs * 1e4, floor.roundTripBps),
    };
  });

  return {
    label: input.label,
    intervalSec,
    n,
    meanAbsBps: meanAbs * 1e4,
    medianAbsBps: medianAbs * 1e4,
    p25Bps: quantileSorted(sorted, 0.25) * 1e4,
    p75Bps: quantileSorted(sorted, 0.75) * 1e4,
    p90Bps: quantileSorted(sorted, 0.9) * 1e4,
    p99Bps: quantileSorted(sorted, 0.99) * 1e4,
    stdevBps: sd * 1e4,
    meanRangeBps: input.ranges ? mean(input.ranges) * 1e4 : Number.NaN,
    oracleDailyPct: meanAbs * barsPerDay * 100,
    barsPerDay,
    costs,
  };
}
