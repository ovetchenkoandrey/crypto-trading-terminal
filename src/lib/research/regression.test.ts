import { describe, expect, it } from "vitest";
import { forecastSplit, ols, predict } from "./regression.ts";
import { gaussian, mulberry32, normalSeries } from "./random.ts";

describe("ols", () => {
  it("recovers known coefficients", () => {
    const rng = mulberry32(51);
    const n = 20000;
    const x1 = normalSeries(n, 1, rng);
    const x2 = normalSeries(n, 2, rng);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = 1.5 + 0.8 * x1[i] - 0.3 * x2[i] + 0.5 * gaussian(rng);
    const fit = ols(y, [x1, x2]);
    expect(fit.coef[0]).toBeCloseTo(1.5, 1);
    expect(fit.coef[1]).toBeCloseTo(0.8, 2);
    expect(fit.coef[2]).toBeCloseTo(-0.3, 2);
    expect(fit.r2).toBeGreaterThan(0.7);
    expect(Math.abs(fit.t[1])).toBeGreaterThan(20);
  });

  it("fits an exact line with no residual", () => {
    const x = Float64Array.from([1, 2, 3, 4, 5]);
    const y = Float64Array.from([3, 5, 7, 9, 11]);
    const fit = ols(y, [x]);
    expect(fit.coef[0]).toBeCloseTo(1, 9);
    expect(fit.coef[1]).toBeCloseTo(2, 9);
    expect(fit.r2).toBeCloseTo(1, 9);
  });

  it("finds no relation where there is none", () => {
    const rng = mulberry32(52);
    const x = normalSeries(20000, 1, rng);
    const y = normalSeries(20000, 1, rng);
    const fit = ols(y, [x]);
    expect(Math.abs(fit.t[1])).toBeLessThan(3);
    expect(fit.r2).toBeLessThan(0.01);
  });

  it("reports wider HC0 errors than the classical formula would under heteroskedasticity", () => {
    const rng = mulberry32(53);
    const n = 20000;
    const x = normalSeries(n, 1, rng);
    const y = new Float64Array(n);
    // Residual variance grows with x: the case classical errors get wrong.
    for (let i = 0; i < n; i++) y[i] = 0.5 * x[i] + (1 + 3 * Math.abs(x[i])) * gaussian(rng);
    const fit = ols(y, [x]);
    let sxx = 0;
    let sx = 0;
    for (let i = 0; i < n; i++) {
      sx += x[i];
      sxx += x[i] * x[i];
    }
    const classical = fit.residualStdev / Math.sqrt(sxx - (sx * sx) / n);
    expect(fit.seHC0[1]).toBeGreaterThan(classical * 1.3);
  });

  it("rejects a singular design", () => {
    const x = Float64Array.from([1, 1, 1, 1]);
    expect(() => ols(Float64Array.from([1, 2, 3, 4]), [x])).toThrow(/singular/);
  });

  it("adjusted R2 penalises extra regressors", () => {
    const rng = mulberry32(54);
    const n = 200;
    const x1 = normalSeries(n, 1, rng);
    const noise = normalSeries(n, 1, rng);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = x1[i] + gaussian(rng);
    const one = ols(y, [x1]);
    const two = ols(y, [x1, noise]);
    expect(two.r2).toBeGreaterThanOrEqual(one.r2 - 1e-12);
    expect(two.adjR2).toBeLessThan(one.adjR2 + 1e-9);
  });
});

describe("predict", () => {
  it("reproduces the fitted values", () => {
    const x = Float64Array.from([1, 2, 3]);
    const fit = ols(Float64Array.from([2, 4, 6]), [x]);
    expect(predict(fit, [x], 1)).toBeCloseTo(4, 9);
  });
});

describe("forecastSplit", () => {
  it("keeps a real relation out of sample", () => {
    const rng = mulberry32(55);
    const n = 20000;
    const x = normalSeries(n, 1, rng);
    const y = new Float64Array(n);
    for (let i = 0; i < n; i++) y[i] = 0.7 * x[i] + gaussian(rng);
    const split = forecastSplit(y, [x], 0.7);
    expect(split.outOfSampleR2).toBeGreaterThan(0.2);
    expect(split.testCorrelation).toBeGreaterThan(0.4);
    expect(split.trainN).toBe(14000);
    expect(split.testN).toBe(6000);
  });

  it("gives no out-of-sample power to a spurious in-sample fit", () => {
    const rng = mulberry32(56);
    const n = 400;
    const x = normalSeries(n, 1, rng);
    const y = normalSeries(n, 1, rng);
    const split = forecastSplit(y, [x], 0.7);
    expect(split.outOfSampleR2).toBeLessThan(0.05);
  });
});
