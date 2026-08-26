import { describe, expect, it } from "vitest";
import { ar1Series, garchSeries, mulberry32, normalSeries } from "./random.ts";
import { varianceRatio, varianceRatioProfile } from "./varianceRatio.ts";

describe("varianceRatio", () => {
  it("is one for a random walk", () => {
    const x = normalSeries(200000, 0.001, mulberry32(41));
    for (const q of [2, 5, 20]) {
      const vr = varianceRatio([x], q);
      expect(Math.abs(vr.vr - 1)).toBeLessThan(0.05);
      expect(Math.abs(vr.zHeteroskedastic)).toBeLessThan(3);
      expect(vr.ciLow).toBeLessThan(1);
      expect(vr.ciHigh).toBeGreaterThan(1);
    }
  });

  it("exceeds one when returns reinforce each other", () => {
    const x = ar1Series(200000, 0.25, 0.001, mulberry32(42));
    const vr = varianceRatio([x], 5);
    expect(vr.vr).toBeGreaterThan(1.3);
    expect(vr.zHeteroskedastic).toBeGreaterThan(10);
    expect(vr.ciLow).toBeGreaterThan(1);
  });

  it("falls below one when returns cancel each other", () => {
    const x = ar1Series(200000, -0.25, 0.001, mulberry32(43));
    const vr = varianceRatio([x], 5);
    expect(vr.vr).toBeLessThan(0.8);
    expect(vr.zHeteroskedastic).toBeLessThan(-10);
  });

  it("matches the theoretical AR(1) value at q = 2", () => {
    // VR(2) = 1 + rho_1 for an AR(1).
    const phi = 0.2;
    const x = ar1Series(400000, phi, 0.001, mulberry32(44));
    expect(varianceRatio([x], 2).vr).toBeCloseTo(1 + phi, 1);
  });

  it("keeps the robust statistic honest where the classical one is not", () => {
    // Pure volatility clustering, no serial correlation in the mean at all.
    // The homoskedastic z reads the clustering as evidence; z* must not.
    const x = garchSeries(400000, 0.12, 0.85, 0.001, mulberry32(45));
    const vr = varianceRatio([x], 10);
    expect(Math.abs(vr.zHeteroskedastic)).toBeLessThan(Math.abs(vr.zHomoskedastic));
    expect(Math.abs(vr.zHeteroskedastic)).toBeLessThan(3.5);
  });

  it("refuses q below two", () => {
    expect(() => varianceRatio([normalSeries(100, 1, mulberry32(46))], 1)).toThrow(/q >= 2/);
  });

  it("never sums returns across a block boundary", () => {
    const a = normalSeries(5000, 0.001, mulberry32(47));
    const b = normalSeries(5000, 0.001, mulberry32(48));
    const split = varianceRatio([a, b], 5);
    const joined = varianceRatio([Float64Array.from([...a, ...b])], 5);
    // One window per seam position is unavailable once the blocks are separate.
    expect(split.windows).toBe(joined.windows - 4);
  });

  it("profiles several horizons in order", () => {
    const x = normalSeries(50000, 0.001, mulberry32(49));
    expect(varianceRatioProfile([x], [2, 4, 8]).map((r) => r.q)).toEqual([2, 4, 8]);
  });
});
