import { describe, it, expect } from "vitest";
import { expandGrid } from "./paramGrid.ts";
import { analysePlateau, formatAxisProfiles, formatHeatmap, pickMapAxes } from "./plateau.ts";

const grid = expandGrid({ a: [1, 2, 3], b: [10, 20, 30] });

/** Scores laid out as a 3x3 surface, row-major over a then b. */
function surface(rows: number[][]): number[] {
  return rows.flat();
}

describe("analysePlateau", () => {
  it("calls a broad region a plateau", () => {
    const scores = surface([
      [0.8, 0.9, 0.8],
      [0.9, 1.0, 0.9],
      [0.8, 0.9, 0.8],
    ]);
    const best = scores.indexOf(1.0);
    const report = analysePlateau(grid, scores, best);
    expect(report.verdict).toBe("plateau");
    expect(report.robustness).toBe(1);
    expect(report.neighbours.scored).toBe(4);
    expect(report.neighbours.better).toBe(0);
  });

  it("calls a spike surrounded by rubble an isolated peak", () => {
    const scores = surface([
      [0.01, 0.02, 0.01],
      [0.02, 1.0, 0.02],
      [0.01, 0.02, 0.01],
    ]);
    const report = analysePlateau(grid, scores, scores.indexOf(1.0));
    expect(report.verdict).toBe("isolated-peak");
    expect(report.robustness).toBe(0);
    expect(report.neighbours.max).toBeCloseTo(0.02, 10);
  });

  it("calls a half-holding neighbourhood a slope", () => {
    const scores = surface([
      [0.1, 0.6, 0.1],
      [0.6, 1.0, 0.05],
      [0.1, 0.05, 0.1],
    ]);
    const report = analysePlateau(grid, scores, scores.indexOf(1.0));
    expect(report.verdict).toBe("slope");
    expect(report.robustness).toBeCloseTo(0.5, 10);
  });

  it("declines to judge when the winner itself is not profitable", () => {
    const scores = surface([
      [-2, -1.5, -2],
      [-1.5, -1, -1.5],
      [-2, -1.5, -2],
    ]);
    const report = analysePlateau(grid, scores, scores.indexOf(-1));
    expect(report.verdict).toBe("n/a");
  });

  it("ignores unscored neighbours instead of counting them as failures", () => {
    const scores: (number | null)[] = surface([
      [0.9, 0.9, 0.9],
      [0.9, 1.0, 0.9],
      [0.9, 0.9, 0.9],
    ]);
    scores[1] = null;
    scores[3] = null;
    const report = analysePlateau(grid, scores, 4);
    expect(report.neighbours.total).toBe(4);
    expect(report.neighbours.scored).toBe(2);
    expect(report.robustness).toBe(1);
  });

  it("reports the median over the other axes for every parameter value", () => {
    const scores = surface([
      [0.1, 0.2, 0.3],
      [1.0, 1.1, 1.2],
      [0.4, 0.5, 0.6],
    ]);
    const report = analysePlateau(grid, scores, scores.indexOf(1.2));
    const axisA = report.axisProfiles.find((p) => p.key === "a")!;
    expect(axisA.points.map((p) => p.median)).toEqual([0.2, 1.1, 0.5]);
    expect(axisA.points.find((p) => p.isBest)!.value).toBe(2);
  });
});

describe("pickMapAxes", () => {
  it("prefers the axes the caller named", () => {
    expect(pickMapAxes(expandGrid({ a: [1, 2], b: [1, 2], c: [1, 2] }), ["c", "a"])).toEqual(["c", "a"]);
  });

  it("falls back to the two widest axes", () => {
    const wide = expandGrid({ a: [1, 2], b: [1, 2, 3, 4], c: [1, 2, 3] });
    expect(pickMapAxes(wide)).toEqual(["b", "c"]);
  });

  it("returns nothing when fewer than two axes actually vary", () => {
    expect(pickMapAxes(expandGrid({ a: [1, 2], b: [5] }))).toBeNull();
  });
});

describe("formatHeatmap", () => {
  it("draws a numeric matrix and marks the selected cell", () => {
    const scores = surface([
      [0.1, 0.2, 0.3],
      [0.4, 0.9, 0.6],
      [0.7, 0.8, 0.5],
    ]);
    const text = formatHeatmap(grid, scores, { bestIndex: scores.indexOf(0.9), xAxis: "b", yAxis: "a" });
    expect(text).toContain("[0.90]");
    expect(text).toContain("b ->");
    expect(text).toContain("^ a");
  });

  it("says so rather than drawing nonsense when an axis is missing", () => {
    expect(formatHeatmap(grid, [0, 0, 0, 0, 0, 0, 0, 0, 0], { bestIndex: 0, xAxis: "zzz", yAxis: "a" })).toContain("no map");
  });
});

describe("formatAxisProfiles", () => {
  it("marks the selected value of every axis", () => {
    const scores = surface([
      [0.1, 0.2, 0.3],
      [0.4, 0.9, 0.6],
      [0.7, 0.8, 0.5],
    ]);
    const report = analysePlateau(grid, scores, scores.indexOf(0.9));
    const text = formatAxisProfiles(report.axisProfiles, grid.axes);
    expect(text).toContain("2 *");
    expect(text).toContain("20 *");
  });
});
