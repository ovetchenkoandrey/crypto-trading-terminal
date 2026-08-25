import { describe, it, expect } from "vitest";
import {
  deflatedSharpe,
  expectedMaxSharpe,
  moments,
  mulberry32,
  normalCdf,
  normalInv,
  probabilisticSharpe,
  realityCheck,
  sharpeOf,
  stationaryBootstrapIndices,
} from "./multipleTesting.ts";

describe("normal distribution helpers", () => {
  it("matches the textbook values of the standard normal CDF", () => {
    expect(normalCdf(0)).toBeCloseTo(0.5, 6);
    expect(normalCdf(1.6448536)).toBeCloseTo(0.95, 5);
    expect(normalCdf(-1.9599640)).toBeCloseTo(0.025, 5);
  });

  it("inverts itself", () => {
    for (const p of [0.001, 0.05, 0.25, 0.5, 0.75, 0.95, 0.999]) {
      expect(normalCdf(normalInv(p))).toBeCloseTo(p, 6);
    }
  });
});

describe("moments", () => {
  it("reports a normal-shaped sample as roughly symmetric with kurtosis near 3", () => {
    const rng = mulberry32(7);
    const values: number[] = [];
    for (let i = 0; i < 20_000; i++) {
      // Box-Muller, so the sample really is normal rather than merely centred.
      const u = Math.max(1e-12, rng());
      const v = rng();
      values.push(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v));
    }
    const m = moments(values);
    expect(m.mean).toBeCloseTo(0, 1);
    expect(m.stdev).toBeCloseTo(1, 1);
    expect(Math.abs(m.skew)).toBeLessThan(0.1);
    expect(m.kurtosis).toBeGreaterThan(2.7);
    expect(m.kurtosis).toBeLessThan(3.3);
  });

  it("picks up left skew", () => {
    const m = moments([0.01, 0.01, 0.01, 0.01, -0.2]);
    expect(m.skew).toBeLessThan(-1);
  });
});

describe("expectedMaxSharpe", () => {
  it("is zero when the trials had no spread", () => {
    expect(expectedMaxSharpe(500, 0)).toBe(0);
  });

  it("grows with the number of trials", () => {
    const ten = expectedMaxSharpe(10, 0.01);
    const thousand = expectedMaxSharpe(1000, 0.01);
    expect(thousand).toBeGreaterThan(ten);
    expect(ten).toBeGreaterThan(0);
  });
});

describe("probabilisticSharpe", () => {
  it("rises with sample length for the same observed Sharpe", () => {
    const short = probabilisticSharpe(0.1, 0, 30, 0, 3);
    const long = probabilisticSharpe(0.1, 0, 3000, 0, 3);
    expect(long).toBeGreaterThan(short);
  });

  it("punishes negative skew and fat tails", () => {
    const clean = probabilisticSharpe(0.1, 0, 500, 0, 3);
    const ugly = probabilisticSharpe(0.1, 0, 500, -1.5, 12);
    expect(ugly).toBeLessThan(clean);
  });
});

describe("deflatedSharpe", () => {
  it("charges for the number of trials: the same Sharpe is worth less after a wide search", () => {
    const input = { sharpe: 0.12, observations: 400, skew: 0, kurtosis: 3, trialSharpes: spread(0.05, 200) };
    const few = deflatedSharpe({ ...input, trials: 5 });
    const many = deflatedSharpe({ ...input, trials: 5000 });
    expect(many.threshold).toBeGreaterThan(few.threshold);
    expect(many.dsr).toBeLessThan(few.dsr);
    expect(few.psrZero).toBeGreaterThan(few.dsr);
  });

  it("charges nothing when every trial gave the same answer", () => {
    const r = deflatedSharpe({ sharpe: 0.1, observations: 400, skew: 0, kurtosis: 3, trialSharpes: [0.1, 0.1, 0.1], trials: 3 });
    expect(r.threshold).toBeCloseTo(0, 12);
    expect(r.dsr).toBeCloseTo(r.psrZero, 10);
  });
});

function spread(sd: number, n: number): number[] {
  const rng = mulberry32(11);
  return Array.from({ length: n }, () => (rng() - 0.5) * sd * Math.sqrt(12));
}

describe("stationaryBootstrapIndices", () => {
  it("returns the requested length with indices inside the series", () => {
    const idx = stationaryBootstrapIndices(50, 5, mulberry32(1));
    expect(idx).toHaveLength(50);
    expect(Math.min(...idx)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...idx)).toBeLessThan(50);
  });

  it("keeps runs of consecutive indices, unlike an iid resample", () => {
    const idx = stationaryBootstrapIndices(400, 20, mulberry32(3));
    let consecutive = 0;
    for (let i = 1; i < idx.length; i++) if (idx[i] === (idx[i - 1] + 1) % 400) consecutive++;
    expect(consecutive).toBeGreaterThan(200);
  });

  it("is reproducible from the seed", () => {
    expect(stationaryBootstrapIndices(30, 4, mulberry32(9))).toEqual(stationaryBootstrapIndices(30, 4, mulberry32(9)));
  });
});

describe("realityCheck", () => {
  const rng = mulberry32(42);
  const noise = (n: number) => Array.from({ length: n }, () => (rng() - 0.5) * 0.04);

  it("does not call the best of many noise series significant", () => {
    const series = Array.from({ length: 60 }, () => noise(250));
    const r = realityCheck({ series, samples: 400, seed: 5 });
    expect(r.pValue).toBeGreaterThan(0.05);
    expect(r.strategies).toBe(60);
    expect(r.observations).toBe(250);
  });

  it("finds a real edge when one series is genuinely shifted", () => {
    const series = Array.from({ length: 20 }, () => noise(400));
    series.push(noise(400).map((v) => v + 0.02));
    const r = realityCheck({ series, samples: 400, seed: 5 });
    expect(r.pValue).toBeLessThan(0.05);
    expect(r.bestIndex).toBe(20);
  });

  it("scores a candidate against the null built from the grid alone", () => {
    const series = Array.from({ length: 30 }, () => noise(300));
    const candidate = noise(300).map((v) => v + 0.03);
    const r = realityCheck({ series, candidate, samples: 400, seed: 5 });
    expect(r.candidateStatistic).not.toBeNull();
    expect(r.candidatePValue).toBeLessThan(0.05);
    expect(r.strategies).toBe(30);
  });

  it("refuses series of different lengths rather than silently truncating", () => {
    expect(() => realityCheck({ series: [[1, 2, 3], [1, 2]] })).toThrow(/same length/);
  });

  it("reports p = 1 when there is nothing to test", () => {
    expect(realityCheck({ series: [] }).pValue).toBe(1);
  });
});

describe("sharpeOf", () => {
  it("is zero for a constant series", () => {
    expect(sharpeOf([0.01, 0.01, 0.01])).toBe(0);
  });

  it("is the mean over the standard deviation", () => {
    const values = [0.02, -0.01, 0.03, 0.0];
    const m = moments(values);
    expect(sharpeOf(values)).toBeCloseTo(m.mean / m.stdev, 10);
  });
});
