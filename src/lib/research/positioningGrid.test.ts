import { describe, expect, it } from "vitest";
import { METRICS_STEP_SEC, type MetricsRow } from "../data/metricsArchive.ts";
import {
  buildPositioningGrid,
  directional,
  laggedDiff,
  logOf,
  multiply,
  rollingMax,
  rollingMean,
  rollingMeanSd,
  rollingZ,
  scaleBySd,
  slotTime,
  subtract,
} from "./positioningGrid.ts";

const T0 = Date.UTC(2024, 5, 1) / 1000;
const NaNv = Number.NaN;

function row(timeSec: number, oi: number, oiv = oi * 1000): MetricsRow {
  return {
    timeSec,
    openInterest: oi,
    openInterestValue: oiv,
    topTraderAccountRatio: 2,
    topTraderPositionRatio: 1.5,
    accountRatio: 2.3,
    takerVolumeRatio: 0.9,
  };
}

describe("buildPositioningGrid", () => {
  it("places rows into five-minute slots and leaves holes as NaN", () => {
    const grid = buildPositioningGrid([row(T0, 10), row(T0 + 900, 40)]);
    expect(grid.length).toBe(4);
    expect(grid.startSec).toBe(T0);
    expect(grid.missing).toBe(2);
    expect(grid.openInterest[0]).toBe(10);
    expect(Number.isNaN(grid.openInterest[1])).toBe(true);
    expect(Number.isNaN(grid.openInterest[2])).toBe(true);
    expect(grid.openInterest[3]).toBe(40);
    expect(slotTime(grid, 3)).toBe(T0 + 900);
  });

  it("drops a timestamp that is not on the grid and says so", () => {
    const grid = buildPositioningGrid([row(T0, 10), row(T0 + 137, 20), row(T0 + 300, 30)]);
    expect(grid.offGrid).toBe(1);
    expect(grid.length).toBe(2);
    expect(Array.from(grid.openInterest)).toEqual([10, 30]);
  });

  it("recovers the mark price from the two open-interest columns", () => {
    const grid = buildPositioningGrid([row(T0, 80, 5_280_000)]);
    expect(grid.price[0]).toBeCloseTo(66_000, 6);
  });

  it("refuses to invent a price when open interest is zero", () => {
    const grid = buildPositioningGrid([row(T0, 0, 1000)]);
    expect(Number.isNaN(grid.price[0])).toBe(true);
  });

  it("returns an empty grid rather than throwing on no usable rows", () => {
    const grid = buildPositioningGrid([row(T0 + 61, 10)]);
    expect(grid.length).toBe(0);
    expect(grid.offGrid).toBe(1);
  });

  it("keeps the last row when a timestamp repeats", () => {
    const grid = buildPositioningGrid([row(T0, 10), row(T0, 99)]);
    expect(grid.openInterest[0]).toBe(99);
    expect(grid.missing).toBe(0);
  });
});

describe("laggedDiff", () => {
  it("is a difference in slots, so a hole poisons the pair", () => {
    const x = Float64Array.from([1, 2, NaNv, 4, 5]);
    const d = laggedDiff(x, 2);
    expect(Number.isNaN(d[0])).toBe(true);
    expect(d[2]).toBeNaN();
    expect(d[3]).toBe(2);
    expect(d[4]).toBeNaN();
  });
});

describe("logOf", () => {
  it("maps a non-positive reading to NaN instead of -Infinity", () => {
    const out = logOf(Float64Array.from([Math.E, 0, -1]));
    expect(out[0]).toBeCloseTo(1, 12);
    expect(Number.isNaN(out[1])).toBe(true);
    expect(Number.isNaN(out[2])).toBe(true);
  });
});

describe("rolling statistics", () => {
  it("averages only over the trailing window", () => {
    const x = Float64Array.from([1, 2, 3, 4, 5]);
    const m = rollingMean(x, 3, 1);
    expect(Number.isNaN(m[1])).toBe(true);
    expect(m[2]).toBeCloseTo(2, 12);
    expect(m[4]).toBeCloseTo(4, 12);
  });

  it("refuses a window that is mostly holes", () => {
    const x = Float64Array.from([1, NaNv, NaNv, NaNv, 5]);
    const m = rollingMean(x, 4, 0.8);
    expect(m.every((v) => Number.isNaN(v))).toBe(true);
  });

  it("tolerates a window that is only slightly holed", () => {
    const x = Float64Array.from([1, 2, 3, NaNv, 5, 6, 7, 8, 9, 10]);
    const m = rollingMean(x, 5, 0.6);
    expect(Number.isFinite(m[4])).toBe(true);
    expect(m[4]).toBeCloseTo(2.75, 12);
  });

  it("computes a standard deviation that matches the direct formula", () => {
    const x = Float64Array.from([2, 4, 4, 4, 5, 5, 7, 9]);
    const { mean, sd } = rollingMeanSd(x, 8, 1);
    expect(mean[7]).toBeCloseTo(5, 12);
    expect(sd[7]).toBeCloseTo(2, 12);
  });

  it("z-scores against the trailing window, current value included", () => {
    const x = Float64Array.from([2, 4, 4, 4, 5, 5, 7, 9]);
    const z = rollingZ(x, 8, 1);
    expect(z[7]).toBeCloseTo((9 - 5) / 2, 12);
    expect(Number.isNaN(z[6])).toBe(true);
  });

  it("scales by the trailing sd without removing the mean", () => {
    const x = Float64Array.from([2, 4, 4, 4, 5, 5, 7, 9]);
    expect(scaleBySd(x, 8, 1)[7]).toBeCloseTo(9 / 2, 12);
  });

  it("returns NaN rather than dividing by a zero standard deviation", () => {
    const x = Float64Array.from([3, 3, 3, 3]);
    expect(rollingZ(x, 4, 1).every((v) => Number.isNaN(v))).toBe(true);
  });

  it("never looks forward", () => {
    const x = Float64Array.from(Array.from({ length: 40 }, (_, i) => Math.sin(i)));
    const full = rollingZ(x, 8, 1);
    const cut = rollingZ(x.subarray(0, 25), 8, 1);
    for (let i = 0; i < 25; i++) {
      if (Number.isNaN(full[i])) expect(Number.isNaN(cut[i])).toBe(true);
      else expect(cut[i]).toBeCloseTo(full[i], 12);
    }
  });
});

describe("rollingMax", () => {
  it("takes the largest value of the trailing window", () => {
    const x = Float64Array.from([1, 5, 2, NaNv, 3]);
    const m = rollingMax(x, 3);
    expect(Number.isNaN(m[1])).toBe(true);
    expect(m[2]).toBe(5);
    expect(m[4]).toBe(3);
  });
});

describe("combinators", () => {
  it("multiplies and subtracts elementwise, propagating holes", () => {
    const a = Float64Array.from([2, NaNv, 4]);
    const b = Float64Array.from([3, 3, NaNv]);
    expect(multiply(a, b)[0]).toBe(6);
    expect(Number.isNaN(multiply(a, b)[1])).toBe(true);
    expect(subtract(a, b)[0]).toBe(-1);
    expect(Number.isNaN(subtract(a, b)[2])).toBe(true);
  });

  it("builds the direction features as sign times a one-sided magnitude", () => {
    const move = Float64Array.from([1, 1, -1, -1]);
    const oi = Float64Array.from([2, -2, 2, -2]);
    // Follow a move backed by rising open interest.
    expect(Array.from(directional(move, oi, 1, 1))).toEqual([2, 0, -2, -0]);
    // Fade a move made on falling open interest.
    expect(Array.from(directional(move, oi, -1, -1))).toEqual([-0, -2, 0, 2]);
  });
});
