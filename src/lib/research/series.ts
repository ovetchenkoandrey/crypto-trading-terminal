import type { Candle } from "../types.ts";

/**
 * Turning candles into a return series.
 *
 * The one thing that matters here is gaps. A missing minute makes
 * `ln(close[i]/close[i-1])` a two-minute return wearing a one-minute label; a
 * missing hour makes it an outlier that will dominate every second moment in
 * the study. So every return carries the timestamp of the bar it belongs to and
 * is emitted only when the previous bar is exactly one interval behind.
 */

export interface ReturnSeries {
  /** Open time of the bar whose close ends the return, UTC seconds. */
  time: Float64Array;
  /** Log return ln(close_t / close_{t-1}). */
  value: Float64Array;
  intervalSec: number;
  /** Bars in the source series. */
  bars: number;
  /** Returns dropped because the preceding bar was missing. */
  gaps: number;
}

export function closes(bars: readonly Candle[]): Float64Array {
  const out = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i++) out[i] = bars[i].close;
  return out;
}

export function times(bars: readonly Candle[]): Float64Array {
  const out = new Float64Array(bars.length);
  for (let i = 0; i < bars.length; i++) out[i] = bars[i].time;
  return out;
}

/** Close-to-close log returns, skipping every step that spans a data gap. */
export function logReturns(bars: readonly Candle[], intervalSec: number): ReturnSeries {
  const time = new Float64Array(Math.max(0, bars.length - 1));
  const value = new Float64Array(Math.max(0, bars.length - 1));
  let n = 0;
  let gaps = 0;
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1];
    const cur = bars[i];
    if (cur.time - prev.time !== intervalSec) {
      gaps++;
      continue;
    }
    if (!(prev.close > 0) || !(cur.close > 0)) {
      gaps++;
      continue;
    }
    time[n] = cur.time;
    value[n] = Math.log(cur.close / prev.close);
    n++;
  }
  return { time: time.subarray(0, n), value: value.subarray(0, n), intervalSec, bars: bars.length, gaps };
}

/**
 * Longest run of returns with no gap in it. Autocorrelation and the variance
 * ratio both read r_t next to r_{t-k}; feeding them a concatenation across a
 * missing hour invents a lag relation that never existed. Contiguous blocks are
 * the honest input, and the estimators below accumulate over a list of them.
 */
export function contiguousBlocks(series: ReturnSeries, minLength = 2): Float64Array[] {
  const out: Float64Array[] = [];
  const { time, value, intervalSec } = series;
  let start = 0;
  for (let i = 1; i <= value.length; i++) {
    const broken = i === value.length || time[i] - time[i - 1] !== intervalSec;
    if (!broken) continue;
    if (i - start >= minLength) out.push(value.subarray(start, i));
    start = i;
  }
  return out;
}

/**
 * Contiguous blocks restricted to the returns a predicate accepts.
 *
 * This is what makes "is the night a different regime" answerable rather than
 * rhetorical: run the same autocorrelation on the returns inside 03:00-06:00
 * UTC and on the ones outside it. Both ends of every pair must lie inside the
 * window, so a block ends at the window edge instead of joining 05:59 to the
 * next day's 03:00.
 */
export function contiguousBlocksWhere(
  series: ReturnSeries,
  accept: (timeSec: number) => boolean,
  minLength = 2,
): Float64Array[] {
  const out: Float64Array[] = [];
  const { time, value, intervalSec } = series;
  let run: number[] = [];
  const flush = (): void => {
    if (run.length >= minLength) out.push(Float64Array.from(run));
    run = [];
  };
  for (let i = 0; i < value.length; i++) {
    if (!accept(time[i])) {
      flush();
      continue;
    }
    if (run.length > 0 && time[i] - time[i - 1] !== intervalSec) flush();
    run.push(value[i]);
  }
  flush();
  return out;
}

/** Fraction of expected bars actually present between the first and last one. */
export function coverage(bars: readonly Candle[], intervalSec: number): number {
  if (bars.length < 2) return bars.length;
  const expected = (bars[bars.length - 1].time - bars[0].time) / intervalSec + 1;
  return bars.length / expected;
}

export const SEC_PER_HOUR = 3600;
export const SEC_PER_DAY = 86400;

/** UTC hour 0..23 of a timestamp in seconds. */
export function utcHour(timeSec: number): number {
  return Math.floor(timeSec / SEC_PER_HOUR) % 24;
}

/** UTC day of week, 0 = Sunday. 1970-01-01 was a Thursday. */
export function utcWeekday(timeSec: number): number {
  return (Math.floor(timeSec / SEC_PER_DAY) + 4) % 7;
}

/** Midnight UTC of the day a timestamp falls in. */
export function utcDayStart(timeSec: number): number {
  return Math.floor(timeSec / SEC_PER_DAY) * SEC_PER_DAY;
}

export function isWeekend(timeSec: number): boolean {
  const d = utcWeekday(timeSec);
  return d === 0 || d === 6;
}

/** Day of month, 1..31, UTC. */
export function utcDayOfMonth(timeSec: number): number {
  return new Date(timeSec * 1000).getUTCDate();
}

export type PriceLookup = (timeSec: number) => number | null;

/**
 * Close price of the bar at an exact timestamp, by binary search.
 *
 * A Map keyed by timestamp would be simpler and roughly a hundred megabytes
 * heavier on a two-year minute series; the search costs twenty comparisons and
 * the event studies only need a few thousand lookups.
 */
export function createPriceLookup(bars: readonly Candle[]): PriceLookup {
  const t = times(bars);
  const c = closes(bars);
  return (timeSec: number): number | null => {
    let lo = 0;
    let hi = t.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      if (t[mid] === timeSec) return c[mid];
      if (t[mid] < timeSec) lo = mid + 1;
      else hi = mid - 1;
    }
    return null;
  };
}
