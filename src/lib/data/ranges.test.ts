import { describe, expect, it } from "vitest";
import type { Candle } from "../types.ts";
import {
  dedupeSorted,
  intersectRanges,
  mergeCandles,
  normalizeRanges,
  rangesFromCandles,
  sortByTime,
  subtractRanges,
  totalBars,
} from "./ranges.ts";

function bar(time: number, close = 1): Candle {
  return { time, open: close, high: close, low: close, close, volume: 1 };
}

describe("ranges", () => {
  it("merges overlapping and grid-adjacent ranges", () => {
    expect(normalizeRanges([{ from: 10, to: 20 }, { from: 15, to: 30 }])).toEqual([{ from: 10, to: 30 }]);
    expect(normalizeRanges([{ from: 0, to: 59 }, { from: 60, to: 119 }])).toEqual([
      { from: 0, to: 59 },
      { from: 60, to: 119 },
    ]);
    expect(normalizeRanges([{ from: 0, to: 59 }, { from: 60, to: 119 }], 1)).toEqual([{ from: 0, to: 119 }]);
    expect(normalizeRanges([{ from: 30, to: 10 }])).toEqual([]);
  });

  it("subtracts holes from a base range", () => {
    expect(subtractRanges({ from: 0, to: 100 }, [{ from: 20, to: 30 }])).toEqual([
      { from: 0, to: 19 },
      { from: 31, to: 100 },
    ]);
    expect(subtractRanges({ from: 0, to: 100 }, [{ from: 0, to: 100 }])).toEqual([]);
    expect(subtractRanges({ from: 0, to: 100 }, [])).toEqual([{ from: 0, to: 100 }]);
    expect(subtractRanges({ from: 0, to: 100 }, [{ from: 200, to: 300 }])).toEqual([{ from: 0, to: 100 }]);
    expect(subtractRanges({ from: 50, to: 100 }, [{ from: 0, to: 60 }])).toEqual([{ from: 61, to: 100 }]);
  });

  it("intersects two range lists", () => {
    expect(intersectRanges([{ from: 0, to: 100 }], [{ from: 50, to: 150 }])).toEqual([{ from: 50, to: 100 }]);
    expect(intersectRanges([{ from: 0, to: 10 }, { from: 20, to: 30 }], [{ from: 5, to: 25 }])).toEqual([
      { from: 5, to: 10 },
      { from: 20, to: 25 },
    ]);
    expect(intersectRanges([{ from: 0, to: 10 }], [{ from: 20, to: 30 }])).toEqual([]);
  });

  it("derives the covered ranges from a candle series with holes", () => {
    const candles = [bar(0), bar(60), bar(120), bar(300), bar(360)];
    expect(rangesFromCandles(candles, 60)).toEqual([
      { from: 0, to: 179 },
      { from: 300, to: 419 },
    ]);
    expect(rangesFromCandles([], 60)).toEqual([]);
    expect(rangesFromCandles([bar(0)], 60)).toEqual([{ from: 0, to: 59 }]);
  });

  it("counts bars in a range list", () => {
    expect(totalBars([{ from: 0, to: 179 }], 60)).toBe(3);
    expect(totalBars([{ from: 0, to: 59 }, { from: 120, to: 179 }], 60)).toBe(2);
  });

  it("merges candle arrays with the newer value winning", () => {
    const a = [bar(0, 1), bar(60, 1)];
    const b = [bar(60, 2), bar(120, 2)];
    expect(mergeCandles(a, b).map((c) => [c.time, c.close])).toEqual([
      [0, 1],
      [60, 2],
      [120, 2],
    ]);
    expect(mergeCandles([], b)).toEqual(b);
    expect(mergeCandles(a, [])).toEqual(a);
  });

  it("sorts and dedupes keeping the last duplicate", () => {
    expect(sortByTime([bar(120), bar(0), bar(60)]).map((c) => c.time)).toEqual([0, 60, 120]);
    expect(dedupeSorted([bar(0, 1), bar(0, 2), bar(60, 3)]).map((c) => [c.time, c.close])).toEqual([
      [0, 2],
      [60, 3],
    ]);
  });
});
