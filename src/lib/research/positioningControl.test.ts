import { describe, expect, it } from "vitest";
import { alignTriple, conditionalSpread } from "./positioningControl.ts";
import { gaussian, mulberry32 } from "./random.ts";

function triple(x: number[], c: number[], y: number[]): ReturnType<typeof alignTriple> {
  return alignTriple(
    x.map((v) => v),
    c.map((v) => v),
    Float64Array.from(y),
  );
}

describe("alignTriple", () => {
  it("keeps only positions where all three exist", () => {
    const out = alignTriple([1, null, 3, 4], [5, 6, null, 8], Float64Array.from([1, 2, 3, Number.NaN]));
    expect(Array.from(out.x)).toEqual([1]);
    expect(Array.from(out.c)).toEqual([5]);
    expect(Array.from(out.index)).toEqual([0]);
  });

  it("preserves the bar index so a later slice can find its way back", () => {
    const out = alignTriple([1, 2, 3], [1, 2, 3], Float64Array.from([1, 2, 3]));
    expect(Array.from(out.index)).toEqual([0, 1, 2]);
  });
});

describe("conditionalSpread", () => {
  const n = 9000;

  it("keeps a spread that the control knows nothing about", () => {
    const rng = mulberry32(3);
    const x: number[] = [];
    const c: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      const feature = gaussian(rng);
      x.push(feature);
      c.push(gaussian(rng));
      y.push(feature * 0.0006 + gaussian(rng) * 0.002);
    }
    const tri = triple(x, c, y);
    const cond = conditionalSpread(tri, 5, 3, 1);
    expect(cond.slices).toBe(3);
    expect(cond.spreadBps).toBeGreaterThan(15);
    expect(cond.spreadBps / cond.seBps).toBeGreaterThan(4);
  });

  it("destroys a spread that was the control in disguise", () => {
    // The feature is a noisy copy of the control, and only the control moves
    // the target. Inside a tercile of the control there is nothing left.
    const rng = mulberry32(4);
    const x: number[] = [];
    const c: number[] = [];
    const y: number[] = [];
    for (let i = 0; i < n; i++) {
      const control = gaussian(rng);
      c.push(control);
      x.push(control + gaussian(rng) * 0.05);
      y.push(control * 0.0006 + gaussian(rng) * 0.002);
    }
    const tri = triple(x, c, y);
    const uncond = conditionalSpread(tri, 5, 1, 1);
    const terciles = conditionalSpread(tri, 5, 3, 1);
    const deciles = conditionalSpread(tri, 5, 10, 1, 200);
    expect(uncond.spreadBps).toBeGreaterThan(15);
    // Conditioning on a coarse grid only partly removes a proxy: a near-perfect
    // copy keeps about four tenths of its spread inside terciles. That number is
    // the baseline a real result has to beat, not zero.
    expect(terciles.spreadBps / uncond.spreadBps).toBeGreaterThan(0.3);
    expect(terciles.spreadBps / uncond.spreadBps).toBeLessThan(0.5);
    expect(deciles.spreadBps).toBeLessThan(terciles.spreadBps);
    expect(deciles.spreadBps / uncond.spreadBps).toBeLessThan(0.2);
  });

  it("reports nothing rather than guessing when a slice is too thin", () => {
    const tri = triple([1, 2, 3], [1, 2, 3], [0.001, 0.002, 0.003]);
    const cond = conditionalSpread(tri, 5, 3, 1);
    expect(cond.slices).toBe(0);
    expect(Number.isNaN(cond.spreadBps)).toBe(true);
  });
});
