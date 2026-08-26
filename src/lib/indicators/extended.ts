// Second wave of pure indicator math: everything the original core.ts did not cover.
//
// Same return convention as core.ts — an array as long as the input, with null
// wherever the value is not defined yet. Everything here is causal: the value at
// index i is a function of candles 0..i only. Where an indicator is classically
// drawn displaced into the future (Ichimoku cloud) the displaced copy is what is
// returned, so a strategy reading index i sees what was on screen at bar i.

import type { Candle } from "../types";
import { atr, ema, sma, stdev, trueRange, typicalPrice, type Series } from "./core";

function emptySeries(len: number): Series {
  return new Array(len).fill(null);
}

function normalizePeriod(period: number): number {
  const p = Math.floor(period);
  return Number.isFinite(p) && p >= 1 ? p : 0;
}

/** Rolling maximum over the last `period` bars, monotonic-deque, O(n). */
export function rollingMax(values: number[], period: number): Series {
  const p = normalizePeriod(period);
  const out = emptySeries(values.length);
  if (p === 0) return out;
  const deque: number[] = [];
  for (let i = 0; i < values.length; i++) {
    while (deque.length > 0 && values[deque[deque.length - 1]] <= values[i]) deque.pop();
    deque.push(i);
    while (deque[0] <= i - p) deque.shift();
    if (i >= p - 1) out[i] = values[deque[0]];
  }
  return out;
}

/** Rolling minimum over the last `period` bars. */
export function rollingMin(values: number[], period: number): Series {
  const p = normalizePeriod(period);
  const out = emptySeries(values.length);
  if (p === 0) return out;
  const deque: number[] = [];
  for (let i = 0; i < values.length; i++) {
    while (deque.length > 0 && values[deque[deque.length - 1]] >= values[i]) deque.pop();
    deque.push(i);
    while (deque[0] <= i - p) deque.shift();
    if (i >= p - 1) out[i] = values[deque[0]];
  }
  return out;
}

/** Rolling sum over the last `period` values. */
export function rollingSum(values: number[], period: number): Series {
  const p = normalizePeriod(period);
  const out = emptySeries(values.length);
  if (p === 0) return out;
  let acc = 0;
  for (let i = 0; i < values.length; i++) {
    acc += values[i];
    if (i >= p) acc -= values[i - p];
    if (i >= p - 1) out[i] = acc;
  }
  return out;
}

/**
 * Wilder's smoothing: seeded with the plain sum of the first `period` values,
 * then sum - sum/period + new. This is the accumulator ADX, +DI and -DI are
 * built on, and it is deliberately the running *sum*, not the average.
 */
export function wilderSum(values: number[], period: number, from = 0): Series {
  const p = normalizePeriod(period);
  const out = emptySeries(values.length);
  if (p === 0 || values.length < from + p) return out;
  let acc = 0;
  for (let i = from; i < from + p; i++) acc += values[i];
  out[from + p - 1] = acc;
  for (let i = from + p; i < values.length; i++) {
    acc = acc - acc / p + values[i];
    out[i] = acc;
  }
  return out;
}

export interface AdxResult {
  plusDi: Series;
  minusDi: Series;
  /** |+DI - -DI| / (+DI + -DI) * 100, before the second smoothing. */
  dx: Series;
  adx: Series;
}

/** Wilder's ADX / DMI. +DI and -DI appear at index `period`, ADX at 2*period - 1. */
export function adx(candles: Candle[], period: number): AdxResult {
  const p = normalizePeriod(period);
  const n = candles.length;
  const res: AdxResult = { plusDi: emptySeries(n), minusDi: emptySeries(n), dx: emptySeries(n), adx: emptySeries(n) };
  if (p === 0 || n < p + 1) return res;

  const tr = trueRange(candles);
  const plusDm = new Array<number>(n).fill(0);
  const minusDm = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = candles[i].high - candles[i - 1].high;
    const down = candles[i - 1].low - candles[i].low;
    plusDm[i] = up > down && up > 0 ? up : 0;
    minusDm[i] = down > up && down > 0 ? down : 0;
  }

  // Bar 0 has no directional movement, so every accumulator starts at index 1.
  const smTr = wilderSum(tr, p, 1);
  const smPlus = wilderSum(plusDm, p, 1);
  const smMinus = wilderSum(minusDm, p, 1);

  const dxDense: number[] = [];
  let dxStart = -1;
  for (let i = 0; i < n; i++) {
    const t = smTr[i];
    const pl = smPlus[i];
    const mi = smMinus[i];
    if (t === null || pl === null || mi === null || t === 0) continue;
    const pdi = (100 * pl) / t;
    const mdi = (100 * mi) / t;
    res.plusDi[i] = pdi;
    res.minusDi[i] = mdi;
    const sum = pdi + mdi;
    const d = sum === 0 ? 0 : (100 * Math.abs(pdi - mdi)) / sum;
    res.dx[i] = d;
    if (dxStart < 0) dxStart = i;
    dxDense.push(d);
  }
  if (dxStart < 0 || dxDense.length < p) return res;

  let acc = 0;
  for (let i = 0; i < p; i++) acc += dxDense[i];
  let value = acc / p;
  res.adx[dxStart + p - 1] = value;
  for (let i = p; i < dxDense.length; i++) {
    value = (value * (p - 1) + dxDense[i]) / p;
    res.adx[dxStart + i] = value;
  }
  return res;
}

export interface IchimokuResult {
  tenkan: Series;
  kijun: Series;
  /** Undisplaced (tenkan + kijun) / 2 at the bar it was computed on. */
  senkouA: Series;
  senkouB: Series;
  /** Top of the cloud visible at bar i, i.e. senkou computed `displacement` bars back. */
  cloudTop: Series;
  cloudBottom: Series;
}

export function ichimoku(
  candles: Candle[],
  tenkanPeriod = 9,
  kijunPeriod = 26,
  senkouPeriod = 52,
  displacement = 26,
): IchimokuResult {
  const n = candles.length;
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);

  const mid = (period: number): Series => {
    const hi = rollingMax(highs, period);
    const lo = rollingMin(lows, period);
    const out = emptySeries(n);
    for (let i = 0; i < n; i++) {
      const h = hi[i];
      const l = lo[i];
      if (h === null || l === null) continue;
      out[i] = (h + l) / 2;
    }
    return out;
  };

  const tenkan = mid(tenkanPeriod);
  const kijun = mid(kijunPeriod);
  const senkouB = mid(senkouPeriod);
  const senkouA = emptySeries(n);
  for (let i = 0; i < n; i++) {
    const t = tenkan[i];
    const k = kijun[i];
    if (t === null || k === null) continue;
    senkouA[i] = (t + k) / 2;
  }

  const d = Math.max(0, Math.floor(displacement));
  const cloudTop = emptySeries(n);
  const cloudBottom = emptySeries(n);
  for (let i = d; i < n; i++) {
    const a = senkouA[i - d];
    const b = senkouB[i - d];
    if (a === null || b === null) continue;
    cloudTop[i] = Math.max(a, b);
    cloudBottom[i] = Math.min(a, b);
  }
  return { tenkan, kijun, senkouA, senkouB, cloudTop, cloudBottom };
}

export interface Channel {
  mid: Series;
  upper: Series;
  lower: Series;
}

/** Keltner: EMA of close, bands at `mult` ATR. */
export function keltner(candles: Candle[], emaPeriod: number, atrPeriod: number, mult: number): Channel {
  const n = candles.length;
  const mid = ema(candles.map((c) => c.close), emaPeriod);
  const a = atr(candles, atrPeriod);
  const upper = emptySeries(n);
  const lower = emptySeries(n);
  for (let i = 0; i < n; i++) {
    const m = mid[i];
    const v = a[i];
    if (m === null || v === null) continue;
    upper[i] = m + mult * v;
    lower[i] = m - mult * v;
  }
  return { mid, upper, lower };
}

/** Donchian channel over the last `period` bars, current bar included. */
export function donchian(candles: Candle[], period: number): Channel {
  const n = candles.length;
  const upper = rollingMax(candles.map((c) => c.high), period);
  const lower = rollingMin(candles.map((c) => c.low), period);
  const mid = emptySeries(n);
  for (let i = 0; i < n; i++) {
    const u = upper[i];
    const l = lower[i];
    if (u === null || l === null) continue;
    mid[i] = (u + l) / 2;
  }
  return { mid, upper, lower };
}

export interface SupertrendResult {
  value: Series;
  /** +1 while price is above the trailing stop, -1 below. */
  direction: Series;
}

export function supertrend(candles: Candle[], period: number, mult: number): SupertrendResult {
  const n = candles.length;
  const value = emptySeries(n);
  const direction = emptySeries(n);
  const a = atr(candles, period);

  let prevUpper = Number.NaN;
  let prevLower = Number.NaN;
  let dir = 1;
  let started = false;

  for (let i = 0; i < n; i++) {
    const v = a[i];
    if (v === null) continue;
    const c = candles[i];
    const basis = (c.high + c.low) / 2;
    let upper = basis + mult * v;
    let lower = basis - mult * v;

    if (started) {
      const prevClose = candles[i - 1].close;
      if (!(upper < prevUpper || prevClose > prevUpper)) upper = prevUpper;
      if (!(lower > prevLower || prevClose < prevLower)) lower = prevLower;
      if (dir === 1 && c.close < prevLower) dir = -1;
      else if (dir === -1 && c.close > prevUpper) dir = 1;
    } else {
      dir = c.close >= basis ? 1 : -1;
      started = true;
    }

    prevUpper = upper;
    prevLower = lower;
    value[i] = dir === 1 ? lower : upper;
    direction[i] = dir;
  }
  return { value, direction };
}

/** Commodity Channel Index on the typical price, Lambert's 0.015 scaling. */
export function cci(candles: Candle[], period: number): Series {
  const p = normalizePeriod(period);
  const n = candles.length;
  const out = emptySeries(n);
  if (p === 0) return out;
  const tp = candles.map(typicalPrice);
  const avg = sma(tp, p);
  for (let i = p - 1; i < n; i++) {
    const m = avg[i] as number;
    let mad = 0;
    for (let j = i - p + 1; j <= i; j++) mad += Math.abs(tp[j] - m);
    mad /= p;
    out[i] = mad === 0 ? 0 : (tp[i] - m) / (0.015 * mad);
  }
  return out;
}

/** Williams %R: -100 at the bottom of the range, 0 at the top. */
export function williamsR(candles: Candle[], period: number): Series {
  const n = candles.length;
  const hi = rollingMax(candles.map((c) => c.high), period);
  const lo = rollingMin(candles.map((c) => c.low), period);
  const out = emptySeries(n);
  for (let i = 0; i < n; i++) {
    const h = hi[i];
    const l = lo[i];
    if (h === null || l === null) continue;
    out[i] = h === l ? -50 : (-100 * (h - candles[i].close)) / (h - l);
  }
  return out;
}

/** On-Balance Volume, cumulative from the first bar. */
export function obv(candles: Candle[]): number[] {
  const out = new Array<number>(candles.length).fill(0);
  let acc = 0;
  for (let i = 1; i < candles.length; i++) {
    const diff = candles[i].close - candles[i - 1].close;
    if (diff > 0) acc += candles[i].volume;
    else if (diff < 0) acc -= candles[i].volume;
    out[i] = acc;
  }
  return out;
}

/** Money Flow Index — RSI computed on volume-weighted typical price. */
export function moneyFlowIndex(candles: Candle[], period: number): Series {
  const p = normalizePeriod(period);
  const n = candles.length;
  const out = emptySeries(n);
  if (p === 0 || n < p + 1) return out;

  const tp = candles.map(typicalPrice);
  const pos = new Array<number>(n).fill(0);
  const neg = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const flow = tp[i] * candles[i].volume;
    if (tp[i] > tp[i - 1]) pos[i] = flow;
    else if (tp[i] < tp[i - 1]) neg[i] = flow;
  }
  const sp = rollingSum(pos, p);
  const sn = rollingSum(neg, p);
  for (let i = p; i < n; i++) {
    const a = sp[i];
    const b = sn[i];
    if (a === null || b === null) continue;
    if (a + b === 0) out[i] = 50;
    else out[i] = (100 * a) / (a + b);
  }
  return out;
}

/** Close location value: +1 at the high of the bar, -1 at the low. */
export function closeLocationValue(c: Candle): number {
  const range = c.high - c.low;
  if (range <= 0) return 0;
  return (2 * c.close - c.high - c.low) / range;
}

/** Chaikin Money Flow: volume-weighted mean close location over the window. */
export function chaikinMoneyFlow(candles: Candle[], period: number): Series {
  const n = candles.length;
  const flow = new Array<number>(n);
  const vol = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    flow[i] = closeLocationValue(candles[i]) * candles[i].volume;
    vol[i] = candles[i].volume;
  }
  const sf = rollingSum(flow, period);
  const sv = rollingSum(vol, period);
  const out = emptySeries(n);
  for (let i = 0; i < n; i++) {
    const a = sf[i];
    const b = sv[i];
    if (a === null || b === null || b === 0) continue;
    out[i] = a / b;
  }
  return out;
}

/** Rate of change in percent over `period` bars. */
export function roc(values: number[], period: number): Series {
  const p = normalizePeriod(period);
  const out = emptySeries(values.length);
  if (p === 0) return out;
  for (let i = p; i < values.length; i++) {
    const base = values[i - p];
    if (base === 0) continue;
    out[i] = ((values[i] - base) / base) * 100;
  }
  return out;
}

/** Williams' Ultimate Oscillator over three windows, weighted 4 / 2 / 1. */
export function ultimateOscillator(candles: Candle[], p1 = 7, p2 = 14, p3 = 28): Series {
  const n = candles.length;
  const out = emptySeries(n);
  const bp = new Array<number>(n).fill(0);
  const tr = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    const c = candles[i];
    const pc = candles[i - 1].close;
    const low = Math.min(c.low, pc);
    bp[i] = c.close - low;
    tr[i] = Math.max(c.high, pc) - low;
  }
  const sums = [p1, p2, p3].map((p) => ({ bp: rollingSum(bp, p), tr: rollingSum(tr, p) }));
  const start = Math.max(p1, p2, p3);
  for (let i = start; i < n; i++) {
    let ok = true;
    const avg: number[] = [];
    for (const s of sums) {
      const b = s.bp[i];
      const t = s.tr[i];
      if (b === null || t === null || t === 0) { ok = false; break; }
      avg.push(b / t);
    }
    if (!ok) continue;
    out[i] = (100 * (4 * avg[0] + 2 * avg[1] + avg[2])) / 7;
  }
  return out;
}

/** Awesome Oscillator: SMA(median price, 5) - SMA(median price, 34). */
export function awesomeOscillator(candles: Candle[], fast = 5, slow = 34): Series {
  const median = candles.map((c) => (c.high + c.low) / 2);
  const f = sma(median, fast);
  const s = sma(median, slow);
  const out = emptySeries(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const a = f[i];
    const b = s[i];
    if (a === null || b === null) continue;
    out[i] = a - b;
  }
  return out;
}

export interface SarResult {
  sar: Series;
  /** +1 while the stop trails below price, -1 above. */
  direction: Series;
}

/** Wilder's Parabolic SAR. */
export function parabolicSar(candles: Candle[], step = 0.02, maxStep = 0.2): SarResult {
  const n = candles.length;
  const sar = emptySeries(n);
  const direction = emptySeries(n);
  if (n < 2) return { sar, direction };

  let dir: 1 | -1 = candles[1].close >= candles[0].close ? 1 : -1;
  let extreme = dir === 1 ? candles[1].high : candles[1].low;
  let value = dir === 1 ? Math.min(candles[0].low, candles[1].low) : Math.max(candles[0].high, candles[1].high);
  let af = step;
  sar[1] = value;
  direction[1] = dir;

  for (let i = 2; i < n; i++) {
    const c = candles[i];
    let next = value + af * (extreme - value);

    if (dir === 1) {
      next = Math.min(next, candles[i - 1].low, candles[i - 2].low);
      if (c.low < next) {
        dir = -1;
        next = extreme;
        extreme = c.low;
        af = step;
      } else if (c.high > extreme) {
        extreme = c.high;
        af = Math.min(af + step, maxStep);
      }
    } else {
      next = Math.max(next, candles[i - 1].high, candles[i - 2].high);
      if (c.high > next) {
        dir = 1;
        next = extreme;
        extreme = c.high;
        af = step;
      } else if (c.low < extreme) {
        extreme = c.low;
        af = Math.min(af + step, maxStep);
      }
    }

    value = next;
    sar[i] = value;
    direction[i] = dir;
  }
  return { sar, direction };
}

export interface AroonResult {
  up: Series;
  down: Series;
  /** up - down, in the -100..100 range. */
  oscillator: Series;
}

/** Aroon over a lookback of `period` bars plus the current one. */
export function aroon(candles: Candle[], period: number): AroonResult {
  const p = normalizePeriod(period);
  const n = candles.length;
  const up = emptySeries(n);
  const down = emptySeries(n);
  const oscillator = emptySeries(n);
  if (p === 0) return { up, down, oscillator };

  for (let i = p; i < n; i++) {
    let hiIdx = i - p;
    let loIdx = i - p;
    for (let j = i - p; j <= i; j++) {
      if (candles[j].high >= candles[hiIdx].high) hiIdx = j;
      if (candles[j].low <= candles[loIdx].low) loIdx = j;
    }
    const u = (100 * (p - (i - hiIdx))) / p;
    const d = (100 * (p - (i - loIdx))) / p;
    up[i] = u;
    down[i] = d;
    oscillator[i] = u - d;
  }
  return { up, down, oscillator };
}

export interface VortexResult {
  plus: Series;
  minus: Series;
  /** VI+ minus VI-. */
  diff: Series;
}

export function vortex(candles: Candle[], period: number): VortexResult {
  const n = candles.length;
  const vmPlus = new Array<number>(n).fill(0);
  const vmMinus = new Array<number>(n).fill(0);
  const tr = trueRange(candles);
  const trShifted = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) {
    vmPlus[i] = Math.abs(candles[i].high - candles[i - 1].low);
    vmMinus[i] = Math.abs(candles[i].low - candles[i - 1].high);
    trShifted[i] = tr[i];
  }
  const sp = rollingSum(vmPlus, period);
  const sm = rollingSum(vmMinus, period);
  const st = rollingSum(trShifted, period);

  const plus = emptySeries(n);
  const minus = emptySeries(n);
  const diff = emptySeries(n);
  const p = normalizePeriod(period);
  for (let i = p; i < n; i++) {
    const a = sp[i];
    const b = sm[i];
    const t = st[i];
    if (a === null || b === null || t === null || t === 0) continue;
    plus[i] = a / t;
    minus[i] = b / t;
    diff[i] = (a - b) / t;
  }
  return { plus, minus, diff };
}

/** TRIX: percent rate of change of a triple-smoothed EMA. */
export function trix(values: number[], period: number): Series {
  const e1 = ema(values, period);
  const dense1: number[] = [];
  let start1 = -1;
  for (let i = 0; i < e1.length; i++) {
    if (e1[i] === null) continue;
    if (start1 < 0) start1 = i;
    dense1.push(e1[i] as number);
  }
  const out = emptySeries(values.length);
  if (start1 < 0) return out;

  const e2 = ema(dense1, period);
  const dense2: number[] = [];
  let start2 = -1;
  for (let i = 0; i < e2.length; i++) {
    if (e2[i] === null) continue;
    if (start2 < 0) start2 = i;
    dense2.push(e2[i] as number);
  }
  if (start2 < 0) return out;

  const e3 = ema(dense2, period);
  const offset = start1 + start2;
  for (let i = 1; i < e3.length; i++) {
    const cur = e3[i];
    const prev = e3[i - 1];
    if (cur === null || prev === null || prev === 0) continue;
    out[offset + i] = ((cur - prev) / prev) * 100;
  }
  return out;
}

export interface ElderRayResult {
  bull: Series;
  bear: Series;
}

/** Elder Ray: how far the bar's high and low reach past the EMA. */
export function elderRay(candles: Candle[], period: number): ElderRayResult {
  const base = ema(candles.map((c) => c.close), period);
  const bull = emptySeries(candles.length);
  const bear = emptySeries(candles.length);
  for (let i = 0; i < candles.length; i++) {
    const b = base[i];
    if (b === null) continue;
    bull[i] = candles[i].high - b;
    bear[i] = candles[i].low - b;
  }
  return { bull, bear };
}

/**
 * Choppiness Index: 100 when the sum of true ranges fills the whole window range
 * (pure chop), near 0 when price walked straight across it.
 */
export function choppiness(candles: Candle[], period: number): Series {
  const p = normalizePeriod(period);
  const n = candles.length;
  const out = emptySeries(n);
  if (p < 2) return out;
  const st = rollingSum(trueRange(candles), p);
  const hi = rollingMax(candles.map((c) => c.high), p);
  const lo = rollingMin(candles.map((c) => c.low), p);
  const denom = Math.log10(p);
  for (let i = 0; i < n; i++) {
    const s = st[i];
    const h = hi[i];
    const l = lo[i];
    if (s === null || h === null || l === null) continue;
    const range = h - l;
    if (range <= 0 || s <= 0) continue;
    out[i] = (100 * Math.log10(s / range)) / denom;
  }
  return out;
}

/**
 * Rolling Hurst exponent by the generalised-moment method: the root mean square
 * of k-step differences scales as k^H, so H is the slope of log rms against
 * log k.
 *
 * The moment is taken about zero rather than about the window mean. Removing the
 * mean is the textbook R/S recipe, but it also removes the drift, and on a clean
 * ramp the centred variance of a k-step difference collapses to zero — the
 * estimator then has nothing to fit. About zero a straight line gives H = 1, a
 * random walk 0.5, an alternating series well under 0.5, which is the behaviour
 * a screening feature needs.
 *
 * 0.5 is a random walk, above is persistence, below is mean reversion. Estimated
 * on a window of a few hundred bars it is noisy — the point of measuring it here
 * is whether the noise happens to predict anything, not whether the number is
 * a faithful fractal dimension.
 */
export function hurstExponent(values: number[], period: number, lags: readonly number[] = [1, 2, 4, 8, 16]): Series {
  const p = normalizePeriod(period);
  const n = values.length;
  const out = emptySeries(n);
  const usable = lags.filter((k) => k >= 1 && k * 2 <= p);
  if (p === 0 || usable.length < 2) return out;

  const logLag = usable.map((k) => Math.log(k));
  const meanLogLag = logLag.reduce((a, b) => a + b, 0) / logLag.length;
  let denom = 0;
  for (const l of logLag) denom += (l - meanLogLag) * (l - meanLogLag);
  if (denom === 0) return out;

  for (let i = p - 1; i < n; i++) {
    const from = i - p + 1;
    const logSd: number[] = [];
    let ok = true;
    for (const k of usable) {
      let sumSq = 0;
      let count = 0;
      for (let j = from + k; j <= i; j++) {
        const d = values[j] - values[j - k];
        sumSq += d * d;
        count++;
      }
      if (count < 2) { ok = false; break; }
      const ms = sumSq / count;
      if (!(ms > 0)) { ok = false; break; }
      logSd.push(0.5 * Math.log(ms));
    }
    if (!ok) continue;
    const meanLogSd = logSd.reduce((a, b) => a + b, 0) / logSd.length;
    let cov = 0;
    for (let k = 0; k < usable.length; k++) cov += (logLag[k] - meanLogLag) * (logSd[k] - meanLogSd);
    out[i] = cov / denom;
  }
  return out;
}

/**
 * Kaufman efficiency ratio: net move over the window divided by the path length.
 * 1 is a straight line, 0 is pure noise around a level.
 */
export function efficiencyRatio(values: number[], period: number): Series {
  const p = normalizePeriod(period);
  const n = values.length;
  const out = emptySeries(n);
  if (p === 0) return out;
  const steps = new Array<number>(n).fill(0);
  for (let i = 1; i < n; i++) steps[i] = Math.abs(values[i] - values[i - 1]);
  const path = rollingSum(steps, p);
  for (let i = p; i < n; i++) {
    const total = path[i];
    if (total === null || total === 0) continue;
    out[i] = Math.abs(values[i] - values[i - p]) / total;
  }
  return out;
}

/** Bollinger %b: 0 at the lower band, 1 at the upper. Uses close by default. */
export function percentB(values: number[], period: number, mult: number): Series {
  const mid = sma(values, period);
  const sd = stdev(values, period);
  const out = emptySeries(values.length);
  for (let i = 0; i < values.length; i++) {
    const m = mid[i];
    const s = sd[i];
    if (m === null || s === null || s === 0) continue;
    out[i] = (values[i] - (m - mult * s)) / (2 * mult * s);
  }
  return out;
}
