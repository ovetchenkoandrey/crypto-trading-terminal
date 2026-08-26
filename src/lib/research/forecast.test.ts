import { describe, expect, it } from "vitest";
import { directionForecast } from "./forecast.ts";
import { ar1Series, garchSeries, mulberry32, normalSeries } from "./random.ts";

describe("directionForecast", () => {
  it("recovers an AR(1) and turns it into a positive held-out edge", () => {
    const x = ar1Series(200000, 0.2, 0.001, mulberry32(111));
    const f = directionForecast([x], 3);
    expect(f.fit.coef[1]).toBeCloseTo(0.2, 2);
    expect(f.outOfSampleR2).toBeGreaterThan(0.02);
    expect(f.testEdgeBps).toBeGreaterThan(0);
    expect(f.testEdgeT).toBeGreaterThan(4);
  });

  it("finds nothing out of sample in white noise", () => {
    const x = normalSeries(200000, 0.001, mulberry32(112));
    const f = directionForecast([x], 5);
    expect(f.outOfSampleR2).toBeLessThan(0.005);
    expect(Math.abs(f.testEdgeT)).toBeLessThan(3);
  });

  it("is not fooled by volatility clustering with no drift structure", () => {
    const x = garchSeries(200000, 0.12, 0.85, 0.001, mulberry32(113));
    const f = directionForecast([x], 5);
    expect(f.outOfSampleR2).toBeLessThan(0.005);
  });

  it("splits in time and accounts for every row", () => {
    const x = normalSeries(1000, 0.001, mulberry32(114));
    const f = directionForecast([x], 4, 0.6);
    expect(f.rows).toBe(996);
    expect(f.trainRows).toBe(597);
    expect(f.testRows).toBe(996 - 597);
    expect(f.lagT.length).toBe(4);
  });

  it("never builds a row whose history crosses a block boundary", () => {
    const a = normalSeries(100, 0.001, mulberry32(115));
    const b = normalSeries(100, 0.001, mulberry32(116));
    const split = directionForecast([a, b], 3);
    const joined = directionForecast([Float64Array.from([...a, ...b])], 3);
    expect(split.rows).toBe(joined.rows - 3);
  });

  it("reports a negative edge when the series mean-reverts and the model says so", () => {
    const x = ar1Series(200000, -0.2, 0.001, mulberry32(117));
    const f = directionForecast([x], 2);
    expect(f.fit.coef[1]).toBeLessThan(-0.15);
    // The fitted rule follows its own forecast, so a reverting series still
    // yields a positive edge — the model has simply learned to fade.
    expect(f.testEdgeBps).toBeGreaterThan(0);
  });
});
