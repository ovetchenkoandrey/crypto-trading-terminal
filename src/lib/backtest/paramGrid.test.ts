import { describe, it, expect } from "vitest";
import { comboLabel, expandGrid, neighbourIndices, parseAxis, parseGridSpec, strideTable } from "./paramGrid.ts";

describe("parseAxis", () => {
  it("accepts a list, a range with a step and a range with a count", () => {
    expect(parseAxis("a", [1, 2, 3]).values).toEqual([1, 2, 3]);
    expect(parseAxis("a", { from: 1, to: 2, step: 0.5 }).values).toEqual([1, 1.5, 2]);
    expect(parseAxis("a", { from: 0, to: 10, count: 3 }).values).toEqual([0, 5, 10]);
  });

  it("treats a bare scalar as a one-value axis", () => {
    expect(parseAxis("mode", "limit").values).toEqual(["limit"]);
    expect(parseAxis("n", 7).values).toEqual([7]);
  });

  it("keeps float steps printable instead of accumulating error", () => {
    expect(parseAxis("bbMult", { from: 1.5, to: 3, step: 0.1 }).values).toContain(2.4);
  });

  it("drops repeated values so the trial count is the real one", () => {
    expect(parseAxis("a", [1, 1, 2]).values).toEqual([1, 2]);
  });

  it("rejects an empty list, a non-positive step and a reversed range", () => {
    expect(() => parseAxis("a", [])).toThrow(/empty/);
    expect(() => parseAxis("a", { from: 1, to: 3, step: 0 })).toThrow(/step/);
    expect(() => parseAxis("a", { from: 3, to: 1, step: 1 })).toThrow(/below from/);
  });
});

describe("expandGrid", () => {
  it("enumerates the cartesian product with the last axis varying fastest", () => {
    const grid = expandGrid({ a: [1, 2], b: ["x", "y", "z"] });
    expect(grid.size).toBe(6);
    expect(grid.combos.map((c) => `${c.params.a}${c.params.b}`)).toEqual(["1x", "1y", "1z", "2x", "2y", "2z"]);
    expect(grid.combos[4].coords).toEqual([1, 1]);
  });

  it("refuses to expand past the cap and names the shape in the message", () => {
    expect(() => expandGrid({ a: { from: 1, to: 100, step: 1 }, b: { from: 1, to: 100, step: 1 } }, { maxCombos: 500 })).toThrow(
      /10000 combinations \(a:100 x b:100\), over the cap of 500/,
    );
  });

  it("rejects an empty grid", () => {
    expect(() => expandGrid({})).toThrow(/grid is empty/);
  });
});

describe("neighbourIndices", () => {
  const grid = expandGrid({ a: [1, 2, 3], b: [10, 20] });

  it("returns combinations one step away along exactly one axis", () => {
    const middle = grid.combos.findIndex((c) => c.params.a === 2 && c.params.b === 10);
    const got = neighbourIndices(grid, middle).map((i) => grid.combos[i].params);
    expect(got).toEqual([
      { a: 1, b: 10 },
      { a: 3, b: 10 },
      { a: 2, b: 20 },
    ]);
  });

  it("does not walk off the edge of the grid", () => {
    const corner = grid.combos.findIndex((c) => c.params.a === 1 && c.params.b === 10);
    expect(neighbourIndices(grid, corner)).toHaveLength(2);
  });

  it("strides match the odometer layout", () => {
    expect(strideTable(grid.axes)).toEqual([2, 1]);
  });
});

describe("parseGridSpec", () => {
  it("reads value lists and from:to:step ranges", () => {
    const decl = parseGridSpec("bbPeriod=10:40:10;bbMult=1.5,2;exitMode=market,limit");
    expect(decl).toEqual({
      bbPeriod: { from: 10, to: 40, step: 10 },
      bbMult: [1.5, 2],
      exitMode: ["market", "limit"],
    });
    expect(expandGrid(decl).size).toBe(4 * 2 * 2);
  });

  it("rejects a chunk that is not key=values", () => {
    expect(() => parseGridSpec("bbPeriod")).toThrow(/not key=values/);
    expect(() => parseGridSpec("bbPeriod=")).toThrow(/no values/);
  });
});

describe("comboLabel", () => {
  it("prints axes in declaration order", () => {
    const grid = expandGrid({ bbPeriod: [20], bbMult: [2] });
    expect(comboLabel(grid.combos[0], grid.axes)).toBe("bbPeriod=20 bbMult=2");
  });
});
