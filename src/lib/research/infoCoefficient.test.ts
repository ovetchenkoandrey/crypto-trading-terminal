import { describe, expect, it } from "vitest";
import type { Candle } from "../types.ts";
import {
  alignPairs,
  bucketProfile,
  conditionalIc,
  forwardReturns,
  hacBandwidth,
  informationCoefficient,
  pairGrid,
} from "./infoCoefficient.ts";
import { mulberry32, gaussian } from "./random.ts";

function series(closes: number[], intervalSec = 60, startSec = 0): Candle[] {
  return closes.map((c, i) => ({ time: startSec + i * intervalSec, open: c, high: c, low: c, close: c, volume: 1 }));
}

function pairsOf(x: (number | null)[], y: number[]): ReturnType<typeof alignPairs> {
  return alignPairs(x, Float64Array.from(y));
}

describe("forwardReturns", () => {
  it("is the log return over the horizon", () => {
    const bars = series([100, 110, 121]);
    const f = forwardReturns(bars, 1, 60);
    expect(f[0]).toBeCloseTo(Math.log(1.1), 12);
    expect(f[1]).toBeCloseTo(Math.log(1.1), 12);
    expect(Number.isNaN(f[2])).toBe(true);
  });

  it("multi-bar horizons reach across", () => {
    const bars = series([100, 110, 121]);
    expect(forwardReturns(bars, 2, 60)[0]).toBeCloseTo(Math.log(1.21), 12);
  });

  it("refuses to span a data gap", () => {
    const bars = series([100, 110, 121]);
    bars[2].time += 60; // one bar missing between index 1 and 2
    const f = forwardReturns(bars, 1, 60);
    expect(f[0]).toBeCloseTo(Math.log(1.1), 12);
    expect(Number.isNaN(f[1])).toBe(true);
  });

  it("bandwidth grows with the horizon", () => {
    expect(hacBandwidth(1)).toBe(2);
    expect(hacBandwidth(96)).toBe(192);
  });
});

describe("alignPairs", () => {
  it("drops nulls on either side and keeps the bar index", () => {
    const p = alignPairs([null, 1, 2, null, 4], Float64Array.from([0, 0.1, Number.NaN, 0.3, 0.4]));
    expect(Array.from(p.x)).toEqual([1, 4]);
    expect(Array.from(p.y)).toEqual([0.1, 0.4]);
    expect(Array.from(p.index)).toEqual([1, 4]);
  });
});

describe("informationCoefficient", () => {
  it("is near zero for an independent feature", () => {
    const rng = mulberry32(7);
    const n = 5000;
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      x.push(gaussian(rng));
      y.push(gaussian(rng) * 0.001);
    }
    const ic = informationCoefficient(pairsOf(x, y), 1);
    expect(Math.abs(ic.ic)).toBeLessThan(0.05);
    expect(Math.abs(ic.z)).toBeLessThan(3);
  });

  it("recovers a planted linear relation", () => {
    const rng = mulberry32(11);
    const n = 5000;
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = gaussian(rng);
      x.push(f);
      y.push(0.3 * f + gaussian(rng));
    }
    const ic = informationCoefficient(pairsOf(x, y), 1);
    expect(ic.ic).toBeGreaterThan(0.2);
    expect(ic.z).toBeGreaterThan(10);
  });

  it("is invariant to a monotone transform of the feature", () => {
    const rng = mulberry32(3);
    const n = 2000;
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = gaussian(rng);
      x.push(f);
      y.push(0.2 * f + gaussian(rng));
    }
    const a = informationCoefficient(pairsOf(x, y), 1);
    const b = informationCoefficient(pairsOf(x.map((v) => Math.exp(v)), y), 1);
    expect(b.ic).toBeCloseTo(a.ic, 10);
  });

  it("the robust standard error is much larger than 1/sqrt(n) on overlapping windows", () => {
    // Feature and target both built from a slow-moving series: heavy positive
    // autocorrelation in the product, which is exactly what Newey-West is for.
    const rng = mulberry32(19);
    const n = 4000;
    const x: number[] = [];
    const y: number[] = [];
    let level = 0;
    for (let i = 0; i < n; i++) {
      level = 0.99 * level + gaussian(rng);
      x.push(level);
      y.push(level * 0.5 + gaussian(rng) * 0.1);
    }
    const ic = informationCoefficient(pairsOf(x, y), 50);
    expect(ic.se).toBeGreaterThan(ic.seIid * 3);
  });

  it("refuses a sample under thirty rows", () => {
    expect(Number.isNaN(informationCoefficient(pairsOf([1, 2, 3], [1, 2, 3]), 1).ic)).toBe(true);
  });

  it("pearson and spearman agree on a clean normal pair and diverge under a fat tail", () => {
    const rng = mulberry32(23);
    const n = 3000;
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = gaussian(rng);
      x.push(f);
      y.push(0.4 * f + gaussian(rng));
    }
    const clean = informationCoefficient(pairsOf(x, y), 1);
    expect(Math.abs(clean.ic - clean.icPearson)).toBeLessThan(0.05);

    x.push(1e6);
    y.push(-1e6);
    const dirty = informationCoefficient(pairsOf(x, y), 1);
    expect(dirty.icPearson).toBeLessThan(0);
    expect(dirty.ic).toBeGreaterThan(0.2);
  });
});

describe("bucketProfile", () => {
  it("is monotone with a positive spread for a linear relation", () => {
    const rng = mulberry32(5);
    const n = 20000;
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = gaussian(rng);
      x.push(f);
      y.push(0.0005 * f + gaussian(rng) * 0.001);
    }
    const p = bucketProfile(pairsOf(x, y), 5, 1);
    expect(p.buckets).toHaveLength(5);
    expect(p.spreadBps).toBeGreaterThan(0);
    expect(p.spreadT).toBeGreaterThan(5);
    expect(p.monotonicity).toBeCloseTo(1, 10);
    expect(p.monotoneSteps).toBe(4);
    // A linear effect on a normal feature is monotone but not rank-linear: the
    // outer quantiles sit further from the mean, so they earn more. Curvature
    // stays near zero, which is what separates this from a U shape.
    expect(Math.abs(p.curvatureBps)).toBeLessThan(Math.abs(p.spreadBps) / 5);
  });

  it("finds a U shape the correlation misses", () => {
    const rng = mulberry32(13);
    const n = 30000;
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = gaussian(rng);
      x.push(f);
      y.push(0.001 * (f * f - 1) + gaussian(rng) * 0.001);
    }
    const pairs = pairsOf(x, y);
    const ic = informationCoefficient(pairs, 1);
    expect(Math.abs(ic.ic)).toBeLessThan(0.05);

    const p = bucketProfile(pairs, 5, 1);
    expect(Math.abs(p.spreadBps)).toBeLessThan(Math.abs(p.curvatureBps));
    expect(p.curvatureBps).toBeGreaterThan(0);
    expect(p.pEqual).toBeLessThan(1e-6);
    expect(p.pNonlinear).toBeLessThan(1e-6);
  });

  it("sees nothing when there is nothing", () => {
    const rng = mulberry32(29);
    const n = 20000;
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      x.push(gaussian(rng));
      y.push(gaussian(rng) * 0.001);
    }
    const p = bucketProfile(pairsOf(x, y), 5, 1);
    expect(Math.abs(p.spreadT)).toBeLessThan(3);
    expect(p.pEqual).toBeGreaterThan(0.01);
  });

  it("bucket means are the means of their members", () => {
    const x = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20];
    const y = x.map((v) => v / 10000);
    const p = bucketProfile(pairsOf(x, y), 2, 1);
    expect(p.buckets[0].meanBps).toBeCloseTo(5.5, 6);
    expect(p.buckets[1].meanBps).toBeCloseTo(15.5, 6);
    expect(p.spreadBps).toBeCloseTo(10, 6);
  });
});

describe("conditionalIc", () => {
  it("separates a regime where the feature works from one where it does not", () => {
    const rng = mulberry32(31);
    const n = 20000;
    const x: number[] = [];
    const y: number[] = [];
    const regime: number[] = [];
    for (let i = 0; i < n; i++) {
      const r = i % 2;
      const f = gaussian(rng);
      x.push(f);
      regime.push(r);
      y.push((r === 1 ? 0.4 * f : 0) + gaussian(rng));
    }
    const res = conditionalIc(pairsOf(x, y), (i) => regime[i], ["off", "on"], 1);
    expect(Math.abs(res.regimes[0].ic.ic)).toBeLessThan(0.05);
    expect(res.regimes[1].ic.ic).toBeGreaterThan(0.25);
    expect(Math.abs(res.maxDiffZ)).toBeGreaterThan(10);
    expect(res.p).toBeLessThan(1e-6);
  });

  it("reports no difference when the feature works everywhere", () => {
    const rng = mulberry32(37);
    const n = 20000;
    const x: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      const f = gaussian(rng);
      x.push(f);
      y.push(0.3 * f + gaussian(rng));
    }
    const res = conditionalIc(pairsOf(x, y), (i) => i % 3, ["a", "b", "c"], 1);
    expect(Math.abs(res.maxDiffZ)).toBeLessThan(4);
    expect(res.p).toBeGreaterThan(0.001);
  });
});

describe("pairGrid", () => {
  it("finds an interaction that neither feature shows alone", () => {
    const rng = mulberry32(41);
    const n = 40000;
    const a: number[] = [];
    const b: (number | null)[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      const fa = gaussian(rng);
      const fb = gaussian(rng);
      a.push(fa);
      b.push(fb);
      // Pure product term: both marginals are flat, the grid is not.
      y.push(0.002 * Math.sign(fa) * Math.sign(fb) + gaussian(rng) * 0.001);
    }
    const pairs = pairsOf(a, y);
    expect(Math.abs(informationCoefficient(pairs, 1).ic)).toBeLessThan(0.05);

    const grid = pairGrid(pairs, b, 3, 1);
    expect(grid.cells).toHaveLength(9);
    expect(grid.pInteraction).toBeLessThan(1e-6);
    expect(Math.abs(grid.maxCellZ)).toBeGreaterThan(5);
    expect(grid.spreadBps).toBeGreaterThan(20);
  });

  it("reports no interaction for two independent additive features", () => {
    const rng = mulberry32(43);
    const n = 40000;
    const a: number[] = [];
    const b: (number | null)[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      const fa = gaussian(rng);
      const fb = gaussian(rng);
      a.push(fa);
      b.push(fb);
      y.push(0.001 * fa + 0.001 * fb + gaussian(rng) * 0.001);
    }
    const grid = pairGrid(pairsOf(a, y), b, 3, 1);
    expect(grid.pInteraction).toBeGreaterThan(0.001);
  });

  it("skips rows where the second feature is missing", () => {
    const a = Array.from({ length: 600 }, (_, i) => i);
    const y = a.map(() => 0.0001);
    const b: (number | null)[] = a.map((v, i) => (i < 300 ? null : v));
    const grid = pairGrid(pairsOf(a, y), b, 3, 1);
    const total = grid.cells.reduce((s, c) => s + c.n, 0);
    expect(total).toBe(300);
  });
});
