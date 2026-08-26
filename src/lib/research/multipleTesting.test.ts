import { describe, expect, it } from "vitest";
import { adjustPValues, expectedMaxAbsZ, familywiseZThreshold } from "./multipleTesting.ts";

describe("adjustPValues", () => {
  it("matches the Benjamini-Hochberg worked example", () => {
    const raw = [0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216];
    const out = adjustPValues(raw.map((p, i) => ({ label: `t${i}`, p })));
    // q_i = min over ranks j >= i of p_j * m / j.
    expect(out[0].bh).toBeCloseTo(0.01, 6);
    expect(out[1].bh).toBeCloseTo(0.04, 6);
    expect(out[2].bh).toBeCloseTo(0.084, 6);
    expect(out[9].bh).toBeCloseTo(0.216, 6);
  });

  it("keeps q-values monotone in p", () => {
    const raw = [0.5, 0.001, 0.02, 0.3, 0.07];
    const out = adjustPValues(raw.map((p, i) => ({ label: `t${i}`, p })));
    const sorted = [...out].sort((a, b) => a.p - b.p);
    for (let i = 1; i < sorted.length; i++) expect(sorted[i].bh).toBeGreaterThanOrEqual(sorted[i - 1].bh - 1e-12);
  });

  it("bonferroni is p times the family size, capped at one", () => {
    const out = adjustPValues([
      { label: "a", p: 0.01 },
      { label: "b", p: 0.5 },
    ]);
    expect(out[0].bonferroni).toBeCloseTo(0.02, 12);
    expect(out[1].bonferroni).toBe(1);
  });

  it("leaves a single test alone", () => {
    const out = adjustPValues([{ label: "only", p: 0.03 }]);
    expect(out[0].bh).toBeCloseTo(0.03, 12);
    expect(out[0].bonferroni).toBeCloseTo(0.03, 12);
  });

  it("preserves input order", () => {
    const out = adjustPValues([
      { label: "x", p: 0.4 },
      { label: "y", p: 0.01 },
    ]);
    expect(out.map((o) => o.label)).toEqual(["x", "y"]);
  });
});

describe("familywiseZThreshold", () => {
  it("is the usual 1.96 for a single test", () => {
    expect(familywiseZThreshold(1)).toBeCloseTo(1.959963985, 6);
  });

  it("rises with the family size", () => {
    expect(familywiseZThreshold(100)).toBeGreaterThan(3.4);
    expect(familywiseZThreshold(1000)).toBeGreaterThan(familywiseZThreshold(100));
  });
});

describe("expectedMaxAbsZ", () => {
  it("is the mean absolute normal for a single draw", () => {
    expect(expectedMaxAbsZ(1)).toBeCloseTo(Math.sqrt(2 / Math.PI), 4);
  });

  it("grows like sqrt(2 log m)", () => {
    // The number a "best of the grid" result has to beat.
    expect(expectedMaxAbsZ(42)).toBeGreaterThan(2.2);
    expect(expectedMaxAbsZ(42)).toBeLessThan(2.9);
    expect(expectedMaxAbsZ(1000)).toBeGreaterThan(expectedMaxAbsZ(42));
    expect(expectedMaxAbsZ(1000)).toBeLessThan(4.5);
  });

  it("is monotone in the number of trials", () => {
    let prev = 0;
    for (const m of [1, 5, 20, 100, 500]) {
      const v = expectedMaxAbsZ(m);
      expect(v).toBeGreaterThan(prev);
      prev = v;
    }
  });
});
