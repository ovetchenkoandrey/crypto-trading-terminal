import { describe, expect, it } from "vitest";
import { chiSquareSf, erf, erfc, normalCdf, normalQuantile, normalSf, twoSidedP } from "./distributions.ts";

describe("erfc", () => {
  it("matches known values", () => {
    expect(erfc(0)).toBeCloseTo(1, 6);
    expect(erfc(0.5)).toBeCloseTo(0.4795001222, 6);
    expect(erfc(1)).toBeCloseTo(0.1572992071, 6);
    expect(erfc(2)).toBeCloseTo(0.004677734981, 8);
  });

  it("is symmetric: erfc(-x) = 2 - erfc(x)", () => {
    for (const x of [0.3, 1.1, 2.7]) expect(erfc(-x)).toBeCloseTo(2 - erfc(x), 12);
  });

  it("erf is 1 - erfc", () => {
    expect(erf(1)).toBeCloseTo(0.8427007929, 6);
  });

  it("keeps fractional accuracy far into the tail where absolute error would not", () => {
    // A 1e-7 absolute-error approximation reports zero here; the ratio to the
    // exact asymptotic value must stay close to one instead.
    const z = 12;
    const sf = normalSf(z);
    const asymptotic = Math.exp((-z * z) / 2) / (z * Math.sqrt(2 * Math.PI));
    expect(sf).toBeGreaterThan(0);
    expect(sf / asymptotic).toBeGreaterThan(0.9);
    expect(sf / asymptotic).toBeLessThan(1.1);
  });
});

describe("normal cdf and survival", () => {
  it("is a half at zero", () => {
    // The Chebyshev erfc carries a fractional error near 1e-7, so seven
    // decimals is the honest tolerance everywhere in this file.
    expect(normalCdf(0)).toBeCloseTo(0.5, 7);
    expect(normalSf(0)).toBeCloseTo(0.5, 7);
  });

  it("matches the standard quantiles", () => {
    expect(normalSf(1.959963985)).toBeCloseTo(0.025, 7);
    expect(normalSf(1.6448536)).toBeCloseTo(0.05, 7);
    expect(normalCdf(1)).toBeCloseTo(0.8413447461, 7);
  });

  it("cdf and sf sum to one", () => {
    for (const z of [-2.5, -0.4, 0.9, 3.3]) expect(normalCdf(z) + normalSf(z)).toBeCloseTo(1, 7);
  });

  it("two-sided p is capped at one", () => {
    expect(twoSidedP(0)).toBe(1);
    expect(twoSidedP(1.959963985)).toBeCloseTo(0.05, 7);
    expect(twoSidedP(-1.959963985)).toBeCloseTo(0.05, 7);
  });
});

describe("normalQuantile", () => {
  it("inverts normalCdf", () => {
    for (const p of [0.001, 0.025, 0.2, 0.5, 0.84, 0.975, 0.9999]) {
      expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 7);
    }
  });

  it("matches the textbook 97.5% point", () => {
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963985, 7);
  });
});

describe("chiSquareSf", () => {
  it("matches the 5% critical values", () => {
    expect(chiSquareSf(3.841459, 1)).toBeCloseTo(0.05, 6);
    expect(chiSquareSf(5.991465, 2)).toBeCloseTo(0.05, 6);
    expect(chiSquareSf(18.307038, 10)).toBeCloseTo(0.05, 6);
    expect(chiSquareSf(124.342, 100)).toBeCloseTo(0.05, 4);
  });

  it("is one at zero and decreasing", () => {
    expect(chiSquareSf(0, 5)).toBe(1);
    expect(chiSquareSf(10, 5)).toBeLessThan(chiSquareSf(5, 5));
  });
});
