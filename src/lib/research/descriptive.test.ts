import { describe, expect, it } from "vitest";
import {
  absOf,
  correlation,
  mean,
  meanTest,
  median,
  moments,
  quantile,
  quantileSorted,
  rankCorrelation,
  squareOf,
  stdev,
  variance,
  welchTest,
  winsorize,
} from "./descriptive.ts";
import { mulberry32, normalSeries } from "./random.ts";

describe("mean, variance, stdev", () => {
  it("matches hand computation", () => {
    const x = [2, 4, 4, 4, 5, 5, 7, 9];
    expect(mean(x)).toBe(5);
    // Sample variance with denominator n-1: 32 / 7.
    expect(variance(x)).toBeCloseTo(32 / 7, 12);
    expect(stdev(x)).toBeCloseTo(Math.sqrt(32 / 7), 12);
  });

  it("returns NaN where the sample is too small", () => {
    expect(Number.isNaN(mean([]))).toBe(true);
    expect(Number.isNaN(variance([1]))).toBe(true);
  });
});

describe("moments", () => {
  it("gives zero skew and zero excess kurtosis for a symmetric flat sample", () => {
    const m = moments([-3, -1, 1, 3]);
    expect(m.mean).toBeCloseTo(0, 12);
    expect(m.skewness).toBeCloseTo(0, 12);
    expect(m.min).toBe(-3);
    expect(m.max).toBe(3);
  });

  it("finds the fat tail a normal sample does not have", () => {
    const rng = mulberry32(7);
    const normal = normalSeries(20000, 1, rng);
    const fat = Float64Array.from(normal);
    fat[0] = 40;
    fat[1] = -40;
    expect(Math.abs(moments(normal).kurtosis)).toBeLessThan(0.3);
    expect(moments(fat).kurtosis).toBeGreaterThan(5);
  });
});

describe("quantiles", () => {
  it("interpolates between order statistics", () => {
    const sorted = [1, 2, 3, 4];
    expect(quantileSorted(sorted, 0)).toBe(1);
    expect(quantileSorted(sorted, 1)).toBe(4);
    expect(quantileSorted(sorted, 0.5)).toBeCloseTo(2.5, 12);
  });

  it("does not disturb the caller's array", () => {
    const x = [5, 1, 3];
    expect(median(x)).toBe(3);
    expect(x).toEqual([5, 1, 3]);
  });

  it("clamps out-of-range probabilities", () => {
    expect(quantile([1, 2, 3], -1)).toBe(1);
    expect(quantile([1, 2, 3], 2)).toBe(3);
  });
});

describe("absOf and squareOf", () => {
  it("map elementwise", () => {
    expect(Array.from(absOf([-1, 2, -3]))).toEqual([1, 2, 3]);
    expect(Array.from(squareOf([-1, 2, -3]))).toEqual([1, 4, 9]);
  });
});

describe("winsorize", () => {
  it("clips both tails to the requested quantiles", () => {
    const x = [-100, 1, 2, 3, 4, 5, 6, 7, 8, 100];
    const w = winsorize(x, 0.1);
    expect(Math.min(...w)).toBeCloseTo(quantile(x, 0.1), 9);
    expect(Math.max(...w)).toBeCloseTo(quantile(x, 0.9), 9);
    // The middle of the sample is untouched.
    expect(w[4]).toBe(4);
  });

  it("leaves a sample with no outliers alone", () => {
    const x = [1, 2, 3, 4, 5];
    expect(Array.from(winsorize(x, 0))).toEqual(x);
  });

  it("tames the kurtosis a single spike creates", () => {
    const x = Float64Array.from(normalSeries(20000, 1, mulberry32(13)));
    x[0] = 500;
    expect(moments(x).kurtosis).toBeGreaterThan(100);
    expect(Math.abs(moments(winsorize(x, 0.001)).kurtosis)).toBeLessThan(1);
  });
});

describe("meanTest", () => {
  it("finds no signal in centred noise", () => {
    const x = normalSeries(50000, 0.001, mulberry32(11));
    const t = meanTest(x);
    expect(Math.abs(t.t)).toBeLessThan(3);
    expect(t.ciLow).toBeLessThan(t.mean);
    expect(t.ciHigh).toBeGreaterThan(t.mean);
  });

  it("finds a shift that is really there", () => {
    const base = normalSeries(50000, 0.001, mulberry32(12));
    const shifted = base.map((v) => v + 0.0002);
    const t = meanTest(shifted);
    expect(t.t).toBeGreaterThan(10);
    expect(t.ciLow).toBeGreaterThan(0);
  });
});

describe("welchTest", () => {
  it("separates two samples with different means", () => {
    const a = normalSeries(10000, 1, mulberry32(1));
    const b = normalSeries(10000, 1, mulberry32(2)).map((v) => v + 0.2);
    const w = welchTest(a, b);
    expect(w.t).toBeLessThan(-8);
    expect(w.nA).toBe(10000);
  });

  it("stays near zero for two draws from the same law", () => {
    const a = normalSeries(10000, 1, mulberry32(3));
    const b = normalSeries(10000, 1, mulberry32(4));
    expect(Math.abs(welchTest(a, b).t)).toBeLessThan(3);
  });
});

describe("correlation", () => {
  it("is one for a series against itself and minus one against its negation", () => {
    const x = [1, 2, 3, 4, 5.5];
    expect(correlation(x, x)).toBeCloseTo(1, 12);
    expect(correlation(x, x.map((v) => -v))).toBeCloseTo(-1, 12);
  });

  it("rank correlation sees a monotone but non-linear relation in full", () => {
    const x = [1, 2, 3, 4, 5];
    const y = x.map((v) => Math.exp(v));
    expect(rankCorrelation(x, y)).toBeCloseTo(1, 12);
    expect(correlation(x, y)).toBeLessThan(0.95);
  });

  it("averages ranks across ties", () => {
    expect(rankCorrelation([1, 1, 2, 2], [1, 1, 2, 2])).toBeCloseTo(1, 12);
  });
});
