import { describe, expect, it } from "vitest";
import { autocorrAt } from "./autocorr.ts";
import { moments } from "./descriptive.ts";
import { ar1Series, gaussian, garchSeries, mulberry32, normalSeries } from "./random.ts";

describe("mulberry32", () => {
  it("is reproducible from a seed", () => {
    const a = mulberry32(1234);
    const b = mulberry32(1234);
    for (let i = 0; i < 10; i++) expect(a()).toBe(b());
  });

  it("stays inside the unit interval and covers it", () => {
    const rng = mulberry32(5);
    const n = 100000;
    let sum = 0;
    let outside = 0;
    for (let i = 0; i < n; i++) {
      const v = rng();
      if (!(v >= 0 && v < 1)) outside++;
      sum += v;
    }
    expect(outside).toBe(0);
    expect(sum / n).toBeCloseTo(0.5, 2);
  });
});

describe("gaussian", () => {
  it("has the moments of a standard normal", () => {
    const rng = mulberry32(6);
    const x = new Float64Array(200000);
    for (let i = 0; i < x.length; i++) x[i] = gaussian(rng);
    const m = moments(x);
    expect(m.mean).toBeCloseTo(0, 2);
    expect(m.stdev).toBeCloseTo(1, 2);
    expect(Math.abs(m.skewness)).toBeLessThan(0.05);
    expect(Math.abs(m.kurtosis)).toBeLessThan(0.1);
  });
});

describe("normalSeries", () => {
  it("scales to the requested sigma and has no memory", () => {
    const x = normalSeries(200000, 0.002, mulberry32(7));
    expect(moments(x).stdev).toBeCloseTo(0.002, 4);
    expect(Math.abs(autocorrAt([x], 1).z)).toBeLessThan(4);
  });
});

describe("ar1Series", () => {
  it("has the stationary variance sigma^2 / (1 - phi^2)", () => {
    const phi = 0.6;
    const sigma = 0.001;
    const x = ar1Series(400000, phi, sigma, mulberry32(8));
    expect(moments(x).stdev).toBeCloseTo(sigma / Math.sqrt(1 - phi * phi), 4);
  });
});

describe("garchSeries", () => {
  it("has no serial correlation in the mean but plenty in the magnitude", () => {
    const x = garchSeries(300000, 0.12, 0.85, 0.001, mulberry32(9));
    const abs = x.map(Math.abs);
    expect(Math.abs(autocorrAt([x], 1).z)).toBeLessThan(4);
    expect(autocorrAt([abs], 1).rho).toBeGreaterThan(0.1);
  });

  it("has fatter tails than a normal", () => {
    const x = garchSeries(300000, 0.12, 0.85, 0.001, mulberry32(10));
    expect(moments(x).kurtosis).toBeGreaterThan(0.5);
  });

  it("hits the requested unconditional sigma", () => {
    const x = garchSeries(400000, 0.1, 0.85, 0.002, mulberry32(11));
    expect(moments(x).stdev).toBeGreaterThan(0.0015);
    expect(moments(x).stdev).toBeLessThan(0.0026);
  });

  it("refuses a non-stationary parameterisation", () => {
    expect(() => garchSeries(10, 0.5, 0.6, 0.001, mulberry32(12))).toThrow(/stationary/);
  });
});
