import { describe, it, expect } from "vitest";
import type { Candle } from "../types";
import {
  sma, ema, stdev, bollinger, rsi, trueRange, atr, stochastic, macd,
  vwap, zigzag, pivotsAsOf, fractals, closes, typicalPrice,
} from "./core";

const flat = (price: number, t = 0, volume = 0): Candle => ({
  time: t, open: price, high: price, low: price, close: price, volume,
});

const bar = (high: number, low: number, close: number, t = 0, volume = 0): Candle => ({
  time: t, open: close, high, low, close, volume,
});

const flatSeries = (prices: number[]): Candle[] => prices.map((p, i) => flat(p, i * 60));

function wavyCandles(n: number): Candle[] {
  let s = 42;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    const close = Math.max(1, open * (1 + (rnd() - 0.5) * 0.08));
    const high = Math.max(open, close) * (1 + rnd() * 0.02);
    const low = Math.min(open, close) * (1 - rnd() * 0.02);
    out.push({ time: i * 60, open, high, low, close, volume: rnd() * 100 });
    price = close;
  }
  return out;
}

describe("core helpers", () => {
  it("closes extracts the close series", () => {
    expect(closes(flatSeries([1, 2, 3]))).toEqual([1, 2, 3]);
  });

  it("typicalPrice is (H + L + C) / 3", () => {
    expect(typicalPrice(bar(12, 6, 9))).toBe(9);
  });
});

describe("sma", () => {
  it("returns an empty array for empty input", () => {
    expect(sma([], 5)).toEqual([]);
  });

  it("keeps input length and nulls the unfilled head", () => {
    expect(sma([1, 2, 3, 4, 5], 3)).toEqual([null, null, 2, 3, 4]);
  });

  it("period 1 is the identity", () => {
    expect(sma([3, 1, 4], 1)).toEqual([3, 1, 4]);
  });

  it("returns all nulls when the period exceeds the input length", () => {
    expect(sma([1, 2, 3], 4)).toEqual([null, null, null]);
  });

  it("returns all nulls for a non-positive or broken period", () => {
    expect(sma([1, 2, 3], 0)).toEqual([null, null, null]);
    expect(sma([1, 2, 3], -2)).toEqual([null, null, null]);
    expect(sma([1, 2, 3], NaN)).toEqual([null, null, null]);
  });
});

describe("ema", () => {
  it("seeds with the SMA of the first `period` values", () => {
    expect(ema([2, 4, 6], 3)).toEqual([null, null, 4]);
  });

  it("uses the k = 2 / (period + 1) recurrence", () => {
    const out = ema([2, 4, 6, 10], 3);
    expect(out[3]).toBeCloseTo(7, 10);
  });

  it("period 1 is the identity", () => {
    expect(ema([3, 1, 4], 1)).toEqual([3, 1, 4]);
  });

  it("returns all nulls when the period exceeds the input length", () => {
    expect(ema([1, 2], 5)).toEqual([null, null]);
  });

  it("returns an empty array for empty input", () => {
    expect(ema([], 5)).toEqual([]);
  });
});

describe("stdev", () => {
  it("computes the population standard deviation (divides by period)", () => {
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(stdev(values, 8)[7]).toBeCloseTo(2, 12);
  });

  it("is zero on a flat window", () => {
    expect(stdev([5, 5, 5, 5], 3)).toEqual([null, null, 0, 0]);
  });

  it("period 1 gives zeros", () => {
    expect(stdev([1, 9, 4], 1)).toEqual([0, 0, 0]);
  });

  it("handles empty input and oversized periods", () => {
    expect(stdev([], 3)).toEqual([]);
    expect(stdev([1, 2], 5)).toEqual([null, null]);
  });
});

describe("bollinger", () => {
  it("mid is the SMA and the bands are mult stdevs away", () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8];
    const period = 4;
    const mult = 2;
    const bands = bollinger(values, period, mult);
    const mid = sma(values, period);
    const sd = stdev(values, period);

    expect(bands.mid).toEqual(mid);
    for (let i = 0; i < values.length; i++) {
      if (mid[i] === null) {
        expect(bands.upper[i]).toBeNull();
        expect(bands.lower[i]).toBeNull();
        continue;
      }
      expect(bands.upper[i]).toBeCloseTo((mid[i] as number) + mult * (sd[i] as number), 12);
      expect(bands.lower[i]).toBeCloseTo((mid[i] as number) - mult * (sd[i] as number), 12);
    }
  });

  it("collapses to a single line on a flat series", () => {
    const bands = bollinger([7, 7, 7], 3, 2);
    expect(bands.mid[2]).toBe(7);
    expect(bands.upper[2]).toBe(7);
    expect(bands.lower[2]).toBe(7);
  });

  it("returns all nulls when the period exceeds the input length", () => {
    const bands = bollinger([1, 2], 5, 2);
    expect(bands.mid).toEqual([null, null]);
    expect(bands.upper).toEqual([null, null]);
    expect(bands.lower).toEqual([null, null]);
  });
});

describe("rsi", () => {
  it("first value lands at index `period`", () => {
    const out = rsi([1, 2, 3, 4, 5], 2);
    expect(out.slice(0, 2)).toEqual([null, null]);
    expect(out[2]).not.toBeNull();
  });

  it("is 100 for a monotonically rising series", () => {
    const out = rsi(Array.from({ length: 30 }, (_, i) => 100 + i), 14);
    for (const v of out) if (v !== null) expect(v).toBe(100);
  });

  it("is 0 for a monotonically falling series", () => {
    const out = rsi(Array.from({ length: 30 }, (_, i) => 100 - i), 14);
    for (const v of out) if (v !== null) expect(v).toBeCloseTo(0, 10);
  });

  it("stays inside [0, 100]", () => {
    const values = [10, 12, 11, 13, 14, 13, 15, 16, 14, 13, 12, 14, 15, 16, 17, 16, 18, 17];
    for (const v of rsi(values, 14)) {
      if (v === null) continue;
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(100);
    }
  });

  it("needs period + 1 values", () => {
    expect(rsi([1, 2, 3], 3)).toEqual([null, null, null]);
    expect(rsi([], 14)).toEqual([]);
  });
});

describe("trueRange / atr", () => {
  it("first true range falls back to high - low", () => {
    expect(trueRange([bar(10, 8, 9, 0), bar(12, 9, 11, 1)])).toEqual([2, 3]);
  });

  it("uses Wilder smoothing after the SMA seed", () => {
    const candles = [bar(10, 8, 9, 0), bar(12, 9, 11, 1), bar(11, 7, 8, 2)];
    expect(atr(candles, 2)).toEqual([null, 2.5, 3.25]);
  });

  it("needs period + 1 candles", () => {
    expect(atr([bar(10, 8, 9, 0), bar(12, 9, 11, 1)], 2)).toEqual([null, null]);
    expect(atr([], 14)).toEqual([]);
  });

  it("is never negative", () => {
    for (const v of atr(wavyCandles(60), 14)) {
      if (v !== null) expect(v).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("stochastic", () => {
  it("aligns %K at kPeriod - 1 and %D at kPeriod + dPeriod - 2", () => {
    const candles = [5, 10, 7.5, 5, 10].map((c, i) => bar(10, 5, c, i));
    const { k, d } = stochastic(candles, 3, 2);
    expect(k).toEqual([null, null, 50, 0, 100]);
    expect(d).toEqual([null, null, null, 25, 50]);
  });

  it("returns 50 on a flat window", () => {
    const candles = Array.from({ length: 4 }, (_, i) => bar(7, 7, 7, i));
    expect(stochastic(candles, 3, 1).k[3]).toBe(50);
  });

  it("handles empty input and oversized periods", () => {
    expect(stochastic([], 14, 3)).toEqual({ k: [], d: [] });
    const short = stochastic([bar(2, 1, 1, 0)], 14, 3);
    expect(short.k).toEqual([null]);
    expect(short.d).toEqual([null]);
  });
});

describe("macd", () => {
  it("aligns the lines and keeps histogram = macd - signal", () => {
    const values = Array.from({ length: 20 }, (_, i) => i + 1);
    const res = macd(values, 3, 5, 2);

    expect(res.macd.slice(0, 4)).toEqual([null, null, null, null]);
    expect(res.macd[4]).toBeCloseTo(1, 12);
    expect(res.signal.slice(0, 5)).toEqual([null, null, null, null, null]);
    expect(res.signal[5]).toBeCloseTo(1, 12);

    for (let i = 0; i < values.length; i++) {
      const h = res.histogram[i];
      if (h === null) {
        expect(res.signal[i]).toBeNull();
        continue;
      }
      expect(h).toBeCloseTo((res.macd[i] as number) - (res.signal[i] as number), 12);
    }
  });

  it("returns all nulls when there is not enough data for the slow EMA", () => {
    const res = macd([1, 2, 3], 12, 26, 9);
    expect(res.macd).toEqual([null, null, null]);
    expect(res.signal).toEqual([null, null, null]);
    expect(res.histogram).toEqual([null, null, null]);
  });
});

describe("vwap", () => {
  it("defaults to the session mode anchored at UTC midnight", () => {
    const candles = [
      { ...flat(10, 0, 1) },
      { ...flat(20, 3600, 3) },
    ];
    expect(vwap(candles)).toEqual([10, 17.5]);
  });

  it("resets the accumulator on a new UTC day", () => {
    const candles = [
      { ...flat(10, 86400 - 60, 1) },
      { ...flat(20, 86400 - 1, 3) },
      { ...flat(50, 86400, 1) },
      { ...flat(70, 86460, 1) },
    ];
    expect(vwap(candles)).toEqual([10, 17.5, 50, 60]);
  });

  it("weights by the typical price by default", () => {
    const candles = [bar(12, 6, 9, 0, 2)];
    expect(vwap(candles)).toEqual([9]);
  });

  it("accepts a custom price source", () => {
    const candles = [bar(12, 6, 30, 0, 2)];
    expect(vwap(candles, { source: (c) => c.close })).toEqual([30]);
  });

  it("rolling mode averages over the last N bars only", () => {
    const candles = [
      { ...flat(10, 0, 1) },
      { ...flat(20, 60, 3) },
      { ...flat(30, 120, 1) },
    ];
    const out = vwap(candles, { mode: "rolling", period: 2 });
    expect(out[0]).toBeNull();
    expect(out[1]).toBe(17.5);
    expect(out[2]).toBe((20 * 3 + 30 * 1) / 4);
  });

  it("rolling mode ignores the UTC day boundary", () => {
    const candles = [
      { ...flat(10, 86400 - 60, 1) },
      { ...flat(20, 86400, 1) },
    ];
    expect(vwap(candles, { mode: "rolling", period: 2 })[1]).toBe(15);
  });

  it("returns null when the window carries no volume", () => {
    const candles = [
      { ...flat(10, 0, 0) },
      { ...flat(20, 60, 0) },
      { ...flat(60, 120, 0) },
    ];
    expect(vwap(candles)).toEqual([null, null, null]);
    expect(vwap(candles, { mode: "rolling", period: 2 })).toEqual([null, null, null]);
  });

  it("stays null until the session sees volume, then weights by it", () => {
    const candles = [
      { ...flat(10, 0, 0) },
      { ...flat(20, 60, 2) },
    ];
    expect(vwap(candles)).toEqual([null, 20]);
  });

  it("handles empty input and oversized rolling windows", () => {
    expect(vwap([])).toEqual([]);
    expect(vwap([], { mode: "rolling", period: 5 })).toEqual([]);
    expect(vwap(flatSeries([1, 2]), { mode: "rolling", period: 5 })).toEqual([null, null]);
    expect(vwap(flatSeries([1, 2]), { mode: "rolling", period: 0 })).toEqual([null, null]);
  });

  it("rolling with period 1 is just the bar price", () => {
    const candles = [flat(4, 0, 1), flat(9, 60, 1)];
    expect(vwap(candles, { mode: "rolling", period: 1 })).toEqual([4, 9]);
  });
});

describe("zigzag", () => {
  it("returns nothing for empty input or a broken deviation", () => {
    expect(zigzag([], 5)).toEqual([]);
    expect(zigzag(flatSeries([1, 2, 3]), 0)).toEqual([]);
    expect(zigzag(flatSeries([1, 2, 3]), -5)).toEqual([]);
    expect(zigzag(flatSeries([1, 2, 3]), NaN)).toEqual([]);
  });

  it("returns nothing while price never moves past the deviation", () => {
    expect(zigzag(flatSeries([100, 101, 100, 99, 100]), 10)).toEqual([]);
  });

  it("marks pivots on a V shape and leaves the trailing extreme unconfirmed", () => {
    const candles = flatSeries([100, 95, 90, 100, 110, 105, 100, 90]);
    const pivots = zigzag(candles, 10);

    expect(pivots).toEqual([
      { index: 0, time: 0, price: 100, kind: "high", confirmed: true, confirmedAt: 2 },
      { index: 2, time: 120, price: 90, kind: "low", confirmed: true, confirmedAt: 3 },
      { index: 4, time: 240, price: 110, kind: "high", confirmed: true, confirmedAt: 7 },
      { index: 7, time: 420, price: 90, kind: "low", confirmed: false, confirmedAt: null },
    ]);
  });

  it("alternates high and low pivots", () => {
    const pivots = zigzag(wavyCandles(200), 5);
    expect(pivots.length).toBeGreaterThan(2);
    for (let i = 1; i < pivots.length; i++) {
      expect(pivots[i].kind).not.toBe(pivots[i - 1].kind);
      expect(pivots[i].index).toBeGreaterThan(pivots[i - 1].index);
    }
  });

  it("confirms every pivot except possibly the trailing one", () => {
    const pivots = zigzag(wavyCandles(200), 5);
    for (let i = 0; i < pivots.length - 1; i++) {
      expect(pivots[i].confirmed).toBe(true);
      expect(pivots[i].confirmedAt).not.toBeNull();
    }
    const last = pivots[pivots.length - 1];
    expect(last.confirmed).toBe(false);
    expect(last.confirmedAt).toBeNull();
  });

  it("confirms a pivot no earlier than the bar it sits on", () => {
    for (const p of zigzag(wavyCandles(200), 5)) {
      if (p.confirmedAt === null) continue;
      expect(p.confirmedAt).toBeGreaterThanOrEqual(p.index);
    }
  });

  it("keeps the unconfirmed pivot moving as new bars arrive", () => {
    const base = flatSeries([100, 95, 90, 100, 110, 105, 100, 90]);
    const grown = [...base, flat(85, 8 * 60)];

    const before = zigzag(base, 10);
    const after = zigzag(grown, 10);

    expect(before[before.length - 1]).toMatchObject({ index: 7, price: 90, confirmed: false });
    expect(after[after.length - 1]).toMatchObject({ index: 8, price: 85, confirmed: false });
    expect(after.slice(0, -1)).toEqual(before.slice(0, -1));
  });

  it("pivotsAsOf hides pivots the bar could not know about yet", () => {
    const candles = flatSeries([100, 95, 90, 100, 110, 105, 100, 90]);
    const pivots = zigzag(candles, 10);

    expect(pivotsAsOf(pivots, 1)).toEqual([]);
    expect(pivotsAsOf(pivots, 2).map((p) => p.index)).toEqual([0]);
    expect(pivotsAsOf(pivots, 6).map((p) => p.index)).toEqual([0, 2]);
    expect(pivotsAsOf(pivots, 7).map((p) => p.index)).toEqual([0, 2, 4]);
  });

  it("pivotsAsOf on the full history matches recomputing on the prefix (no look-ahead)", () => {
    const candles = wavyCandles(150);
    const full = zigzag(candles, 4);

    for (let i = 0; i < candles.length; i++) {
      const prefix = zigzag(candles.slice(0, i + 1), 4).filter((p) => p.confirmed);
      expect(prefix).toEqual(pivotsAsOf(full, i));
    }
  });

  it("starts the chain from the first bar when price only trends", () => {
    const pivots = zigzag(flatSeries([100, 105, 110, 120]), 10);
    expect(pivots).toEqual([
      { index: 0, time: 0, price: 100, kind: "low", confirmed: true, confirmedAt: 2 },
      { index: 3, time: 180, price: 120, kind: "high", confirmed: false, confirmedAt: null },
    ]);
  });

  it("uses bar extremes, not closes", () => {
    const candles = [
      bar(100, 99, 100, 0),
      bar(110, 100, 101, 60),
      bar(100, 98, 99, 120),
    ];
    const pivots = zigzag(candles, 10);

    expect(pivots).toEqual([
      { index: 0, time: 0, price: 99, kind: "low", confirmed: true, confirmedAt: 1 },
      { index: 1, time: 60, price: 110, kind: "high", confirmed: true, confirmedAt: 2 },
      { index: 2, time: 120, price: 98, kind: "low", confirmed: false, confirmedAt: null },
    ]);
  });

  it("resolves a bar that breaches both directions in favour of the larger move", () => {
    const candles = [
      bar(100, 99, 100, 0),
      bar(101, 89, 95, 60),
      bar(96, 94, 95, 120),
    ];
    // Bar 1 is +13.5% off the running low and -11.9% off the running high at once.
    const pivots = zigzag(candles, 10);
    expect(pivots[0]).toMatchObject({ index: 1, kind: "low", price: 89, confirmedAt: 1 });
  });

  it("a wider deviation yields no more pivots than a tighter one", () => {
    const candles = wavyCandles(200);
    expect(zigzag(candles, 10).length).toBeLessThanOrEqual(zigzag(candles, 2).length);
  });
});

describe("fractals", () => {
  it("returns index arrays for highs and lows", () => {
    const candles = [
      bar(10, 5, 7, 0), bar(10, 4, 7, 1), bar(10, 3, 7, 2), bar(10, 4, 7, 3), bar(10, 5, 7, 4),
    ];
    expect(fractals(candles, 2)).toEqual({ highs: [], lows: [2] });
  });

  it("detects a fractal high", () => {
    const candles = [
      bar(5, 0, 1, 0), bar(6, 0, 1, 1), bar(7, 0, 1, 2), bar(6, 0, 1, 3), bar(5, 0, 1, 4),
    ];
    expect(fractals(candles, 2)).toEqual({ highs: [2], lows: [] });
  });

  it("uses strict comparison against neighbours", () => {
    const candles = [
      bar(5, 0, 1, 0), bar(7, 0, 1, 1), bar(7, 0, 1, 2), bar(6, 0, 1, 3), bar(5, 0, 1, 4),
    ];
    expect(fractals(candles, 2)).toEqual({ highs: [], lows: [] });
  });

  it("needs n neighbours on both sides", () => {
    const candles = [
      bar(5, 0, 1, 0), bar(6, 0, 1, 1), bar(7, 0, 1, 2), bar(10, 0, 1, 3),
      bar(7, 0, 1, 4), bar(6, 0, 1, 5), bar(5, 0, 1, 6),
    ];
    expect(fractals(candles, 3)).toEqual({ highs: [3], lows: [] });
    expect(fractals(candles, 4)).toEqual({ highs: [], lows: [] });
  });

  it("handles empty input and a broken n", () => {
    expect(fractals([], 2)).toEqual({ highs: [], lows: [] });
    expect(fractals(wavyCandles(10), 0)).toEqual({ highs: [], lows: [] });
  });

  it("a bar can be both a fractal high and a fractal low", () => {
    const candles = [
      bar(5, 5, 5, 0), bar(6, 4, 5, 1), bar(5, 5, 5, 2),
    ];
    expect(fractals(candles, 1)).toEqual({ highs: [1], lows: [1] });
  });
});
