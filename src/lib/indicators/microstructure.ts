// Bar-shape, volume and volatility-estimator features computable from plain OHLCV.
//
// These are the things a candle knows about itself that a moving average does
// not: how much of the range the body took, where the close sat inside it, how
// much of the volume leaned one way, and how the high-low range compares with
// the close-to-close move. Same null-padded Series convention as core.ts, and
// every value at index i uses candles 0..i only.

import type { Candle } from "../types";
import { sma, type Series } from "./core";
import { rollingSum } from "./extended";

function emptySeries(len: number): Series {
  return new Array(len).fill(null);
}

function normalizePeriod(period: number): number {
  const p = Math.floor(period);
  return Number.isFinite(p) && p >= 1 ? p : 0;
}

/** |close - open| / (high - low). 1 is a full marubozu, 0 is a doji. */
export function bodyRatio(candles: Candle[]): Series {
  return candles.map((c) => {
    const range = c.high - c.low;
    return range > 0 ? Math.abs(c.close - c.open) / range : null;
  });
}

/** Position of the close inside the bar range, 0 at the low and 1 at the high. */
export function closePosition(candles: Candle[]): Series {
  return candles.map((c) => {
    const range = c.high - c.low;
    return range > 0 ? (c.close - c.low) / range : null;
  });
}

/** Share of the range spent above max(open, close). */
export function upperWick(candles: Candle[]): Series {
  return candles.map((c) => {
    const range = c.high - c.low;
    return range > 0 ? (c.high - Math.max(c.open, c.close)) / range : null;
  });
}

/** Share of the range spent below min(open, close). */
export function lowerWick(candles: Candle[]): Series {
  return candles.map((c) => {
    const range = c.high - c.low;
    return range > 0 ? (Math.min(c.open, c.close) - c.low) / range : null;
  });
}

/**
 * Volume imbalance: volume signed by where the close sat inside its bar, summed
 * over the window and divided by total volume. This is the cheapest available
 * proxy for aggressor-side imbalance when the trade tape is not stored.
 */
export function volumeImbalance(candles: Candle[], period: number): Series {
  const n = candles.length;
  const signed = new Array<number>(n);
  const vol = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    const range = c.high - c.low;
    const lean = range > 0 ? (2 * c.close - c.high - c.low) / range : 0;
    signed[i] = lean * c.volume;
    vol[i] = c.volume;
  }
  const ss = rollingSum(signed, period);
  const sv = rollingSum(vol, period);
  const out = emptySeries(n);
  for (let i = 0; i < n; i++) {
    const a = ss[i];
    const b = sv[i];
    if (a === null || b === null || b <= 0) continue;
    out[i] = a / b;
  }
  return out;
}

/**
 * Parkinson volatility: high-low range estimator, per-bar standard deviation
 * averaged over the window. Roughly five times more efficient than close-to-close
 * under a driftless diffusion, which is why it is worth carrying separately.
 */
export function parkinsonVol(candles: Candle[], period: number): Series {
  const n = candles.length;
  const k = 1 / (4 * Math.log(2));
  const term = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (c.high > 0 && c.low > 0) {
      const r = Math.log(c.high / c.low);
      term[i] = k * r * r;
    }
  }
  const s = rollingSum(term, period);
  const p = normalizePeriod(period);
  const out = emptySeries(n);
  for (let i = 0; i < n; i++) {
    const v = s[i];
    if (v === null || v < 0) continue;
    out[i] = Math.sqrt(v / p);
  }
  return out;
}

/** Garman-Klass volatility: uses the open and close on top of the range. */
export function garmanKlassVol(candles: Candle[], period: number): Series {
  const n = candles.length;
  const term = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (!(c.high > 0 && c.low > 0 && c.open > 0 && c.close > 0)) continue;
    const hl = Math.log(c.high / c.low);
    const co = Math.log(c.close / c.open);
    term[i] = 0.5 * hl * hl - (2 * Math.log(2) - 1) * co * co;
  }
  const s = rollingSum(term, period);
  const p = normalizePeriod(period);
  const out = emptySeries(n);
  for (let i = 0; i < n; i++) {
    const v = s[i];
    if (v === null) continue;
    out[i] = Math.sqrt(Math.max(v, 0) / p);
  }
  return out;
}

/** Rogers-Satchell volatility: drift-independent, unlike Parkinson and GK. */
export function rogersSatchellVol(candles: Candle[], period: number): Series {
  const n = candles.length;
  const term = new Array<number>(n).fill(0);
  for (let i = 0; i < n; i++) {
    const c = candles[i];
    if (!(c.high > 0 && c.low > 0 && c.open > 0 && c.close > 0)) continue;
    const hc = Math.log(c.high / c.close);
    const ho = Math.log(c.high / c.open);
    const lc = Math.log(c.low / c.close);
    const lo = Math.log(c.low / c.open);
    term[i] = hc * ho + lc * lo;
  }
  const s = rollingSum(term, period);
  const p = normalizePeriod(period);
  const out = emptySeries(n);
  for (let i = 0; i < n; i++) {
    const v = s[i];
    if (v === null) continue;
    out[i] = Math.sqrt(Math.max(v, 0) / p);
  }
  return out;
}

/** Close-to-close realised volatility over the window, per bar. */
export function realizedVol(candles: Candle[], period: number): Series {
  const n = candles.length;
  const sq = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const prev = candles[i - 1].close;
    const cur = candles[i].close;
    if (prev > 0 && cur > 0) {
      const r = Math.log(cur / prev);
      sq[i] = r * r;
    }
  }
  const s = rollingSum(sq, period);
  const p = normalizePeriod(period);
  const out = emptySeries(n);
  for (let i = Math.max(1, p); i < n; i++) {
    const v = s[i];
    if (v === null) continue;
    out[i] = Math.sqrt(v / p);
  }
  return out;
}

/** Log returns bar to bar; index 0 is null. */
export function logReturnSeries(candles: Candle[]): Series {
  const out = emptySeries(candles.length);
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    const cur = candles[i].close;
    if (prev > 0 && cur > 0) out[i] = Math.log(cur / prev);
  }
  return out;
}

/**
 * Rolling z-score of a series against its own window. Turns any level-valued
 * quantity (volume, range, an oscillator) into something comparable across
 * symbols and across a five-year sample where the raw scale moved by orders of
 * magnitude.
 */
export function rollingZScore(values: Series, period: number): Series {
  const p = normalizePeriod(period);
  const n = values.length;
  const out = emptySeries(n);
  if (p < 2) return out;
  for (let i = p - 1; i < n; i++) {
    let sum = 0;
    let sumSq = 0;
    let count = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const v = values[j];
      if (v === null || !Number.isFinite(v)) continue;
      sum += v;
      sumSq += v * v;
      count++;
    }
    if (count < 2) continue;
    const mean = sum / count;
    const variance = sumSq / count - mean * mean;
    const cur = values[i];
    if (cur === null || !(variance > 0)) continue;
    out[i] = (cur - mean) / Math.sqrt(variance);
  }
  return out;
}

/** Rolling skewness of the values in the window (population moments). */
export function rollingSkew(values: Series, period: number): Series {
  const p = normalizePeriod(period);
  const n = values.length;
  const out = emptySeries(n);
  if (p < 3) return out;
  for (let i = p - 1; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const v = values[j];
      if (v === null || !Number.isFinite(v)) continue;
      sum += v;
      count++;
    }
    if (count < 3) continue;
    const mean = sum / count;
    let m2 = 0;
    let m3 = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const v = values[j];
      if (v === null || !Number.isFinite(v)) continue;
      const d = v - mean;
      m2 += d * d;
      m3 += d * d * d;
    }
    m2 /= count;
    m3 /= count;
    if (!(m2 > 0)) continue;
    out[i] = m3 / Math.pow(m2, 1.5);
  }
  return out;
}

/** Rolling excess kurtosis; 0 for a normal window. */
export function rollingKurtosis(values: Series, period: number): Series {
  const p = normalizePeriod(period);
  const n = values.length;
  const out = emptySeries(n);
  if (p < 4) return out;
  for (let i = p - 1; i < n; i++) {
    let sum = 0;
    let count = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const v = values[j];
      if (v === null || !Number.isFinite(v)) continue;
      sum += v;
      count++;
    }
    if (count < 4) continue;
    const mean = sum / count;
    let m2 = 0;
    let m4 = 0;
    for (let j = i - p + 1; j <= i; j++) {
      const v = values[j];
      if (v === null || !Number.isFinite(v)) continue;
      const d = v - mean;
      m2 += d * d;
      m4 += d * d * d * d;
    }
    m2 /= count;
    m4 /= count;
    if (!(m2 > 0)) continue;
    out[i] = m4 / (m2 * m2) - 3;
  }
  return out;
}

/**
 * Amihud illiquidity: |return| per unit of volume, averaged over the window.
 * High values mean the price moved a lot on little trade — a thin book.
 */
export function amihudIlliquidity(candles: Candle[], period: number): Series {
  const n = candles.length;
  const ratio = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const prev = candles[i - 1].close;
    const cur = candles[i].close;
    const vol = candles[i].volume;
    if (prev > 0 && cur > 0 && vol > 0) ratio[i] = Math.abs(Math.log(cur / prev)) / vol;
  }
  const avg = sma(ratio, period);
  const out = emptySeries(n);
  const p = normalizePeriod(period);
  for (let i = Math.max(1, p); i < n; i++) out[i] = avg[i];
  return out;
}

/**
 * Signed run length: +k after k consecutive up closes, -k after k down closes.
 * The direct test of "does a streak continue or snap".
 */
export function signedRunLength(candles: Candle[]): Series {
  const out = emptySeries(candles.length);
  let run = 0;
  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    const dir = diff > 0 ? 1 : diff < 0 ? -1 : 0;
    if (dir === 0) run = 0;
    else if (run > 0 && dir > 0) run += 1;
    else if (run < 0 && dir < 0) run -= 1;
    else run = dir;
    out[i] = run;
  }
  return out;
}

/** Overnight-style gap: (open - previous close) relative to the previous close. */
export function gapRatio(candles: Candle[]): Series {
  const out = emptySeries(candles.length);
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1].close;
    if (prev > 0) out[i] = (candles[i].open - prev) / prev;
  }
  return out;
}

/**
 * Range against realised volatility: how much of the bar's high-low travel the
 * close-to-close move kept. Low values mark bars that went somewhere and came
 * back, high values mark clean directional bars.
 */
export function rangeToRealized(candles: Candle[], period: number): Series {
  const park = parkinsonVol(candles, period);
  const real = realizedVol(candles, period);
  const out = emptySeries(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const p = park[i];
    const r = real[i];
    if (p === null || r === null || !(r > 0)) continue;
    out[i] = p / r;
  }
  return out;
}
