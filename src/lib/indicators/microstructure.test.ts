import { describe, expect, it } from "vitest";
import type { Candle } from "../types";
import {
  amihudIlliquidity,
  bodyRatio,
  closePosition,
  gapRatio,
  garmanKlassVol,
  logReturnSeries,
  lowerWick,
  parkinsonVol,
  rangeToRealized,
  realizedVol,
  rogersSatchellVol,
  rollingKurtosis,
  rollingSkew,
  rollingZScore,
  signedRunLength,
  upperWick,
  volumeImbalance,
} from "./microstructure";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 100): Candle {
  return { time, open, high, low, close, volume };
}

function walk(n: number, sigma = 0.01, seed = 42): Candle[] {
  let s = seed;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648 - 0.5;
  };
  const out: Candle[] = [];
  let price = 100;
  for (let i = 0; i < n; i++) {
    const open = price;
    price = price * Math.exp(sigma * rnd());
    const wickUp = Math.abs(rnd()) * sigma * price;
    const wickDown = Math.abs(rnd()) * sigma * price;
    out.push(bar(i * 60, open, Math.max(open, price) + wickUp, Math.min(open, price) - wickDown, price, 50 + Math.abs(rnd()) * 100));
  }
  return out;
}

describe("bar shape", () => {
  it("bodyRatio is 1 for a marubozu and 0 for a doji", () => {
    expect(bodyRatio([bar(0, 10, 12, 10, 12)])[0]).toBeCloseTo(1, 12);
    expect(bodyRatio([bar(0, 11, 12, 10, 11)])[0]).toBeCloseTo(0, 12);
  });

  it("bodyRatio is null on a zero-range bar", () => {
    expect(bodyRatio([bar(0, 10, 10, 10, 10)])[0]).toBeNull();
  });

  it("closePosition is 1 at the high and 0 at the low", () => {
    expect(closePosition([bar(0, 10, 12, 8, 12)])[0]).toBeCloseTo(1, 12);
    expect(closePosition([bar(0, 10, 12, 8, 8)])[0]).toBeCloseTo(0, 12);
    expect(closePosition([bar(0, 10, 12, 8, 10)])[0]).toBeCloseTo(0.5, 12);
  });

  it("wick shares plus the body add up to one", () => {
    const c = walk(200);
    const b = bodyRatio(c);
    const u = upperWick(c);
    const l = lowerWick(c);
    for (let i = 0; i < c.length; i++) {
      if (b[i] === null) continue;
      expect((b[i] as number) + (u[i] as number) + (l[i] as number)).toBeCloseTo(1, 10);
    }
  });

  it("upperWick is the whole range for a bar that spiked and came back", () => {
    expect(upperWick([bar(0, 10, 20, 10, 10)])[0]).toBeCloseTo(1, 12);
    expect(lowerWick([bar(0, 10, 10, 5, 10)])[0]).toBeCloseTo(1, 12);
  });

  it("gapRatio is the open against the previous close", () => {
    const c = [bar(0, 10, 11, 9, 10), bar(60, 11, 12, 10, 11)];
    expect(gapRatio(c)[0]).toBeNull();
    expect(gapRatio(c)[1] as number).toBeCloseTo(0.1, 12);
  });
});

describe("volumeImbalance", () => {
  it("is +1 when every bar closes at its high", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 30; i++) c.push(bar(i * 60, 100, 102, 98, 102, 10 + i));
    expect(volumeImbalance(c, 20)[29] as number).toBeCloseTo(1, 10);
  });

  it("is -1 when every bar closes at its low", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 30; i++) c.push(bar(i * 60, 100, 102, 98, 98, 10 + i));
    expect(volumeImbalance(c, 20)[29] as number).toBeCloseTo(-1, 10);
  });

  it("weights by volume, not by bar count", () => {
    const c = [
      bar(0, 100, 102, 98, 102, 1),
      bar(60, 100, 102, 98, 98, 99),
    ];
    expect(volumeImbalance(c, 2)[1] as number).toBeCloseTo((1 - 99) / 100, 10);
  });

  it("stays inside -1..1", () => {
    const v = volumeImbalance(walk(300), 20);
    for (const x of v) if (x !== null) {
      expect(x).toBeGreaterThanOrEqual(-1);
      expect(x).toBeLessThanOrEqual(1);
    }
  });
});

describe("volatility estimators", () => {
  it("parkinson is zero when every bar has no range", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 30; i++) c.push(bar(i * 60, 100, 100, 100, 100));
    expect(parkinsonVol(c, 20)[29] as number).toBeCloseTo(0, 12);
  });

  it("parkinson recovers a known constant range", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 30; i++) c.push(bar(i * 60, 100, 101, 100, 100.5));
    const expected = Math.sqrt((Math.log(101 / 100) ** 2) / (4 * Math.log(2)));
    expect(parkinsonVol(c, 20)[29] as number).toBeCloseTo(expected, 12);
  });

  it("all three range estimators are non-negative and same order of magnitude", () => {
    const c = walk(500, 0.01);
    const p = parkinsonVol(c, 50);
    const g = garmanKlassVol(c, 50);
    const r = rogersSatchellVol(c, 50);
    const i = 400;
    for (const v of [p[i], g[i], r[i]]) {
      expect(v as number).toBeGreaterThan(0);
    }
    expect((g[i] as number) / (p[i] as number)).toBeGreaterThan(0.2);
    expect((g[i] as number) / (p[i] as number)).toBeLessThan(5);
  });

  it("realizedVol matches a hand-rolled close-to-close computation", () => {
    const c = walk(100);
    const rv = realizedVol(c, 20);
    const i = 60;
    let acc = 0;
    for (let j = i - 19; j <= i; j++) acc += Math.log(c[j].close / c[j - 1].close) ** 2;
    expect(rv[i] as number).toBeCloseTo(Math.sqrt(acc / 20), 12);
  });

  it("rangeToRealized is above one when bars have wicks", () => {
    const c: Candle[] = [];
    for (let i = 0; i < 60; i++) {
      const up = i % 2 === 0;
      c.push(bar(i * 60, 100, 101, 99, up ? 100.05 : 99.95));
    }
    expect(rangeToRealized(c, 20)[50] as number).toBeGreaterThan(1);
  });

  it("logReturnSeries leaves the first bar undefined", () => {
    const c = walk(10);
    const r = logReturnSeries(c);
    expect(r[0]).toBeNull();
    expect(r[5] as number).toBeCloseTo(Math.log(c[5].close / c[4].close), 12);
  });
});

describe("rolling moments", () => {
  it("z-score is zero at the mean and one sigma up at plus one sigma", () => {
    const v: (number | null)[] = [1, 2, 3, 4, 5];
    const z = rollingZScore(v, 5);
    expect(z[4] as number).toBeCloseTo((5 - 3) / Math.sqrt(2), 10);
  });

  it("z-score is null on a constant window", () => {
    expect(rollingZScore([2, 2, 2, 2], 4)[3]).toBeNull();
  });

  it("z-score skips nulls in the window", () => {
    const z = rollingZScore([null, 1, 2, 3], 4);
    expect(z[3] as number).toBeCloseTo((3 - 2) / Math.sqrt(2 / 3), 10);
  });

  it("skew is zero for a symmetric window and positive with a right tail", () => {
    expect(rollingSkew([-2, -1, 0, 1, 2], 5)[4] as number).toBeCloseTo(0, 10);
    expect(rollingSkew([0, 0, 0, 0, 10], 5)[4] as number).toBeGreaterThan(1);
  });

  it("kurtosis is negative for a uniform-ish window and positive with an outlier", () => {
    expect(rollingKurtosis([-2, -1, 0, 1, 2], 5)[4] as number).toBeLessThan(0);
    expect(rollingKurtosis([0, 0, 0, 0, 0, 0, 0, 0, 0, 20], 10)[9] as number).toBeGreaterThan(3);
  });

  it("short periods are rejected", () => {
    expect(rollingSkew([1, 2, 3], 2).every((v) => v === null)).toBe(true);
    expect(rollingKurtosis([1, 2, 3], 3).every((v) => v === null)).toBe(true);
    expect(rollingZScore([1, 2, 3], 1).every((v) => v === null)).toBe(true);
  });
});

describe("amihudIlliquidity", () => {
  it("rises when the same move happens on less volume", () => {
    const thick: Candle[] = [];
    const thin: Candle[] = [];
    for (let i = 0; i < 40; i++) {
      const price = 100 * Math.exp(0.001 * (i % 2 === 0 ? 1 : -1));
      thick.push(bar(i * 60, 100, 101, 99, price, 1000));
      thin.push(bar(i * 60, 100, 101, 99, price, 10));
    }
    expect(amihudIlliquidity(thin, 20)[39] as number).toBeGreaterThan(amihudIlliquidity(thick, 20)[39] as number);
  });

  it("is non-negative", () => {
    const a = amihudIlliquidity(walk(200), 20);
    for (const v of a) if (v !== null) expect(v).toBeGreaterThanOrEqual(0);
  });
});

describe("signedRunLength", () => {
  it("counts up and down streaks", () => {
    const closes = [10, 11, 12, 13, 12, 11, 12];
    const c = closes.map((p, i) => bar(i * 60, p, p, p, p));
    expect(signedRunLength(c)).toEqual([null, 1, 2, 3, -1, -2, 1]);
  });

  it("resets to zero on an unchanged close", () => {
    const closes = [10, 11, 11, 12];
    const c = closes.map((p, i) => bar(i * 60, p, p, p, p));
    expect(signedRunLength(c)).toEqual([null, 1, 0, 1]);
  });
});

describe("causality", () => {
  it("adding future bars never changes a past value", () => {
    const full = walk(400);
    const prefix = full.slice(0, 300);
    const at = 250;
    const checks: [string, (c: Candle[]) => (number | null)[]][] = [
      ["bodyRatio", (c) => bodyRatio(c)],
      ["closePosition", (c) => closePosition(c)],
      ["volumeImbalance", (c) => volumeImbalance(c, 20)],
      ["parkinson", (c) => parkinsonVol(c, 20)],
      ["garmanKlass", (c) => garmanKlassVol(c, 20)],
      ["rogersSatchell", (c) => rogersSatchellVol(c, 20)],
      ["realizedVol", (c) => realizedVol(c, 20)],
      ["amihud", (c) => amihudIlliquidity(c, 20)],
      ["runLength", (c) => signedRunLength(c)],
      ["rangeToRealized", (c) => rangeToRealized(c, 20)],
      ["skew", (c) => rollingSkew(logReturnSeries(c), 50)],
      ["kurtosis", (c) => rollingKurtosis(logReturnSeries(c), 50)],
      ["zscore", (c) => rollingZScore(logReturnSeries(c), 50)],
    ];
    for (const [name, fn] of checks) {
      const a = fn(prefix)[at];
      const b = fn(full)[at];
      if (a === null) {
        expect(b, name).toBeNull();
        continue;
      }
      expect(b as number, name).toBeCloseTo(a as number, 10);
    }
  });
});
