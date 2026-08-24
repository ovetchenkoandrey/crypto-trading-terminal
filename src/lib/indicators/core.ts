// Pure numeric indicator math, shared by chart IndicatorDef wrappers and strategies.
//
// Return convention: every series function returns an array of the same length as
// its input, with `null` in positions where the value is not defined yet (period
// not filled). Same convention as the original `calcEma`.

import type { Candle } from "../types";

export type Series = (number | null)[];

export function closes(candles: Candle[]): number[] {
  return candles.map((c) => c.close);
}

export function typicalPrice(c: Candle): number {
  return (c.high + c.low + c.close) / 3;
}

function emptySeries(len: number): Series {
  return new Array(len).fill(null);
}

function normalizePeriod(period: number): number {
  const p = Math.floor(period);
  return Number.isFinite(p) && p >= 1 ? p : 0;
}

export function sma(values: number[], period: number): Series {
  const p = normalizePeriod(period);
  const out = emptySeries(values.length);
  if (p === 0) return out;

  for (let i = p - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - p + 1; j <= i; j++) sum += values[j];
    out[i] = sum / p;
  }
  return out;
}

export function ema(values: number[], period: number): Series {
  const p = normalizePeriod(period);
  const out = emptySeries(values.length);
  if (p === 0 || values.length < p) return out;

  const k = 2 / (p + 1);
  let sum = 0;
  for (let i = 0; i < p; i++) sum += values[i];
  out[p - 1] = sum / p;

  for (let i = p; i < values.length; i++) {
    out[i] = values[i] * k + (out[i - 1] as number) * (1 - k);
  }
  return out;
}

/** Population standard deviation over a rolling window (divides by period). */
export function stdev(values: number[], period: number): Series {
  const p = normalizePeriod(period);
  const out = emptySeries(values.length);
  if (p === 0) return out;

  for (let i = p - 1; i < values.length; i++) {
    let sum = 0;
    for (let j = i - p + 1; j <= i; j++) sum += values[j];
    const mean = sum / p;

    let variance = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const diff = values[j] - mean;
      variance += diff * diff;
    }
    out[i] = Math.sqrt(variance / p);
  }
  return out;
}

export interface BollingerBands {
  mid: Series;
  upper: Series;
  lower: Series;
}

export function bollinger(values: number[], period: number, mult: number): BollingerBands {
  const mid = sma(values, period);
  const sd = stdev(values, period);
  const upper = emptySeries(values.length);
  const lower = emptySeries(values.length);

  for (let i = 0; i < values.length; i++) {
    const m = mid[i];
    const s = sd[i];
    if (m === null || s === null) continue;
    upper[i] = m + mult * s;
    lower[i] = m - mult * s;
  }
  return { mid, upper, lower };
}

/** Wilder RSI. The first value lands at index `period`, so it needs period + 1 values. */
export function rsi(values: number[], period: number): Series {
  const p = normalizePeriod(period);
  const out = emptySeries(values.length);
  if (p === 0 || values.length < p + 1) return out;

  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i <= p; i++) {
    const diff = values[i] - values[i - 1];
    if (diff >= 0) avgGain += diff; else avgLoss += -diff;
  }
  avgGain /= p;
  avgLoss /= p;

  const at = (ag: number, al: number) => (al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  out[p] = at(avgGain, avgLoss);

  for (let i = p + 1; i < values.length; i++) {
    const diff = values[i] - values[i - 1];
    const gain = diff > 0 ? diff : 0;
    const loss = diff < 0 ? -diff : 0;
    avgGain = (avgGain * (p - 1) + gain) / p;
    avgLoss = (avgLoss * (p - 1) + loss) / p;
    out[i] = at(avgGain, avgLoss);
  }
  return out;
}

/** True Range per bar. The first bar has no previous close, so it uses high - low. */
export function trueRange(candles: Candle[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    if (i === 0) {
      out.push(c.high - c.low);
      continue;
    }
    const pc = candles[i - 1].close;
    out.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
  }
  return out;
}

/** ATR with Wilder smoothing, seeded by the SMA of the first `period` true ranges. */
export function atr(candles: Candle[], period: number): Series {
  const p = normalizePeriod(period);
  const out = emptySeries(candles.length);
  if (p === 0 || candles.length < p + 1) return out;

  const tr = trueRange(candles);
  let value = 0;
  for (let i = 0; i < p; i++) value += tr[i];
  value /= p;
  out[p - 1] = value;

  for (let i = p; i < tr.length; i++) {
    value = (value * (p - 1) + tr[i]) / p;
    out[i] = value;
  }
  return out;
}

export interface StochasticResult {
  k: Series;
  d: Series;
}

export function stochastic(candles: Candle[], kPeriod: number, dPeriod: number): StochasticResult {
  const kp = normalizePeriod(kPeriod);
  const dp = normalizePeriod(dPeriod);
  const k = emptySeries(candles.length);
  const d = emptySeries(candles.length);
  if (kp === 0) return { k, d };

  for (let i = kp - 1; i < candles.length; i++) {
    let hi = -Infinity;
    let lo = Infinity;
    for (let j = i - kp + 1; j <= i; j++) {
      if (candles[j].high > hi) hi = candles[j].high;
      if (candles[j].low < lo) lo = candles[j].low;
    }
    k[i] = hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
  }

  if (dp === 0) return { k, d };
  for (let i = kp + dp - 2; i < candles.length; i++) {
    let sum = 0;
    for (let j = i - dp + 1; j <= i; j++) sum += k[j] as number;
    d[i] = sum / dp;
  }
  return { k, d };
}

export interface MacdResult {
  macd: Series;
  signal: Series;
  histogram: Series;
}

export function macd(values: number[], fastPeriod: number, slowPeriod: number, signalPeriod: number): MacdResult {
  const fast = ema(values, fastPeriod);
  const slow = ema(values, slowPeriod);
  const line = emptySeries(values.length);
  const signal = emptySeries(values.length);
  const histogram = emptySeries(values.length);

  let first = -1;
  for (let i = 0; i < values.length; i++) {
    const f = fast[i];
    const s = slow[i];
    if (f === null || s === null) continue;
    line[i] = f - s;
    if (first < 0) first = i;
  }
  if (first < 0) return { macd: line, signal, histogram };

  // Signal EMA is seeded on the MACD line, counting from its first defined bar.
  const dense = line.slice(first) as number[];
  const sig = ema(dense, signalPeriod);
  for (let j = 0; j < sig.length; j++) {
    const s = sig[j];
    if (s === null) continue;
    signal[first + j] = s;
    histogram[first + j] = (line[first + j] as number) - s;
  }
  return { macd: line, signal, histogram };
}

export type VwapMode = "session" | "rolling";

export interface VwapOptions {
  /** "session" (default) resets at UTC midnight; "rolling" uses a sliding window of `period` bars. */
  mode?: VwapMode;
  /** Window size for mode "rolling". Ignored in session mode. */
  period?: number;
  /** Price source per bar, typical price (H+L+C)/3 by default. */
  source?: (c: Candle) => number;
}

const DAY_SECONDS = 86400;

/**
 * Volume Weighted Average Price. Default mode is "session": cumulative from the start of
 * the UTC day, the classic daily VWAP that resets at 00:00 UTC.
 *
 * With no volume in the window the value is null, not a fallback average. Substituting a
 * plain mean would hand a strategy something that looks like VWAP but carries no volume
 * information, and nothing downstream could tell the difference — synthetic fixtures must
 * set a volume to get a VWAP.
 */
export function vwap(candles: Candle[], opts: VwapOptions = {}): Series {
  const mode = opts.mode ?? "session";
  const src = opts.source ?? typicalPrice;
  const out = emptySeries(candles.length);

  if (mode === "rolling") {
    const p = normalizePeriod(opts.period ?? 20);
    if (p === 0) return out;
    for (let i = p - 1; i < candles.length; i++) {
      let pv = 0;
      let vol = 0;
      for (let j = i - p + 1; j <= i; j++) {
        const price = src(candles[j]);
        const v = candles[j].volume;
        pv += price * v;
        vol += v;
      }
      out[i] = vol > 0 ? pv / vol : null;
    }
    return out;
  }

  let day: number | null = null;
  let pv = 0;
  let vol = 0;
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const d = Math.floor(c.time / DAY_SECONDS);
    if (d !== day) {
      day = d;
      pv = 0;
      vol = 0;
    }
    pv += src(c) * c.volume;
    vol += c.volume;
    out[i] = vol > 0 ? pv / vol : null;
  }
  return out;
}

export type ZigzagKind = "high" | "low";

export interface ZigzagPivot {
  index: number;
  time: number;
  price: number;
  kind: ZigzagKind;
  /** False for the trailing pivot: price has not retraced far enough yet, it can still move. */
  confirmed: boolean;
  /** Bar index at which the pivot became known. `null` while unconfirmed. */
  confirmedAt: number | null;
}

/**
 * Classic ZigZag on bar highs/lows: an extreme becomes a pivot once price retraces more
 * than `deviationPct` percent away from it.
 *
 * The last element may be an unconfirmed pivot (`confirmed: false`) — it is the extreme
 * currently being tracked and can still move as new bars arrive. Every pivot also carries
 * `confirmedAt`, the bar index at which it became known; a bar-by-bar strategy must filter
 * through `pivotsAsOf` to avoid look-ahead bias.
 */
export function zigzag(candles: Candle[], deviationPct: number): ZigzagPivot[] {
  const pivots: ZigzagPivot[] = [];
  const n = candles.length;
  if (n === 0 || !Number.isFinite(deviationPct) || deviationPct <= 0) return pivots;

  const dev = deviationPct / 100;
  const add = (index: number, kind: ZigzagKind, confirmedAt: number | null) => {
    const c = candles[index];
    pivots.push({
      index,
      time: c.time,
      price: kind === "high" ? c.high : c.low,
      kind,
      confirmed: confirmedAt !== null,
      confirmedAt,
    });
  };

  // dir 0: direction unknown, both extremes tracked from bar 0.
  // dir 1: last pivot was a low, a high extreme is being tracked.
  // dir -1: last pivot was a high, a low extreme is being tracked.
  let dir: -1 | 0 | 1 = 0;
  let extIdx = 0;
  let extPrice = 0;
  let hiIdx = 0;
  let hiPrice = candles[0].high;
  let loIdx = 0;
  let loPrice = candles[0].low;

  for (let i = 1; i < n; i++) {
    const c = candles[i];

    if (dir === 0) {
      if (c.high > hiPrice) { hiPrice = c.high; hiIdx = i; }
      if (c.low < loPrice) { loPrice = c.low; loIdx = i; }

      const down = hiPrice > 0 ? (hiPrice - c.low) / hiPrice : 0;
      const up = loPrice > 0 ? (c.high - loPrice) / loPrice : 0;
      const downOk = down >= dev;
      const upOk = up >= dev;
      if (!downOk && !upOk) continue;

      const takeDown = downOk && (!upOk || hiIdx < loIdx || (hiIdx === loIdx && down >= up));
      if (takeDown) {
        add(hiIdx, "high", i);
        dir = -1;
        extIdx = i;
        extPrice = c.low;
      } else {
        add(loIdx, "low", i);
        dir = 1;
        extIdx = i;
        extPrice = c.high;
      }
      continue;
    }

    if (dir === 1) {
      if (c.high > extPrice) {
        extPrice = c.high;
        extIdx = i;
      } else if (extPrice > 0 && (extPrice - c.low) / extPrice >= dev) {
        add(extIdx, "high", i);
        dir = -1;
        extIdx = i;
        extPrice = c.low;
      }
      continue;
    }

    if (c.low < extPrice) {
      extPrice = c.low;
      extIdx = i;
    } else if (extPrice > 0 && (c.high - extPrice) / extPrice >= dev) {
      add(extIdx, "low", i);
      dir = 1;
      extIdx = i;
      extPrice = c.high;
    }
  }

  if (dir !== 0) add(extIdx, dir === 1 ? "high" : "low", null);
  return pivots;
}

/** Pivots a strategy is allowed to see while replaying bar `barIndex`. */
export function pivotsAsOf(pivots: ZigzagPivot[], barIndex: number): ZigzagPivot[] {
  return pivots.filter((p) => p.confirmedAt !== null && p.confirmedAt <= barIndex);
}

export interface FractalIndices {
  highs: number[];
  lows: number[];
}

/**
 * Bill Williams fractals: bar indices whose high (or low) is strictly beyond the `n`
 * neighbours on each side. A fractal at index i is only known at bar i + n, which a
 * bar-by-bar strategy has to respect.
 */
export function fractals(candles: Candle[], n: number): FractalIndices {
  const N = normalizePeriod(n);
  const highs: number[] = [];
  const lows: number[] = [];
  if (N === 0) return { highs, lows };

  for (let i = N; i < candles.length - N; i++) {
    const c = candles[i];
    let isHigh = true;
    let isLow = true;
    for (let j = 1; j <= N; j++) {
      if (candles[i - j].high >= c.high || candles[i + j].high >= c.high) isHigh = false;
      if (candles[i - j].low <= c.low || candles[i + j].low <= c.low) isLow = false;
      if (!isHigh && !isLow) break;
    }
    if (isHigh) highs.push(i);
    if (isLow) lows.push(i);
  }
  return { highs, lows };
}
