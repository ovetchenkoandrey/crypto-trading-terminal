import { describe, it, expect } from "vitest";
import { dailyReturns, failedOutcome, sliceIndices } from "./segmentRun.ts";
import type { Candle } from "../types";

const DAY = 86_400;

function series(from: number, count: number, step = 60): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: from + i * step,
    open: 100,
    high: 101,
    low: 99,
    close: 100,
    volume: 1,
  }));
}

describe("sliceIndices", () => {
  const candles = series(1000, 100);

  it("selects the inclusive range of bars", () => {
    const { start, end } = sliceIndices(candles, 1000 + 10 * 60, 1000 + 19 * 60, 0);
    expect(start).toBe(10);
    expect(end).toBe(20);
  });

  it("moves the run start back by the warm-up without moving the measured start", () => {
    const { start, runStart } = sliceIndices(candles, 1000 + 30 * 60, 1000 + 40 * 60, 12);
    expect(start).toBe(30);
    expect(runStart).toBe(18);
  });

  it("clamps the warm-up at the beginning of the dataset", () => {
    expect(sliceIndices(candles, 1000, 1000 + 60, 500).runStart).toBe(0);
  });

  it("returns an empty range when no bar falls inside", () => {
    const { start, end } = sliceIndices(candles, 10_000_000, 10_000_060, 0);
    expect(end - start).toBe(0);
  });
});

describe("dailyReturns", () => {
  it("anchors the first day on the equity the segment opened with", () => {
    const out = dailyReturns(
      [
        { time: 0, equity: 1050 },
        { time: 3600, equity: 1100 },
        { time: DAY, equity: 1210 },
      ],
      1000,
    );
    expect(out.days).toEqual([0, 1]);
    expect(out.returns[0]).toBeCloseTo(0.1, 10);
    expect(out.returns[1]).toBeCloseTo(0.1, 10);
  });

  it("returns nothing for an empty curve", () => {
    expect(dailyReturns([], 1000)).toEqual({ days: [], returns: [] });
  });

  it("reports a flat day as a zero return, not a missing one", () => {
    const out = dailyReturns(
      [
        { time: 0, equity: 1000 },
        { time: DAY, equity: 1000 },
      ],
      1000,
    );
    expect(out.returns).toEqual([0, 0]);
  });
});

describe("failedOutcome", () => {
  it("looks like any other outcome so callers need no special case", () => {
    const out = failedOutcome(
      { id: 3, comboIndex: 7, foldIndex: 1, phase: "train", params: {}, fromSec: 0, toSec: 1 },
      1000,
      "no bars",
    );
    expect(out.error).toBe("no bars");
    expect(out.stats.trades).toBe(0);
    expect(out.startEquity).toBe(1000);
    expect(out.endEquity).toBe(1000);
  });
});
