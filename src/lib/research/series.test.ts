import { describe, expect, it } from "vitest";
import type { Candle } from "../types.ts";
import {
  closes,
  contiguousBlocks,
  contiguousBlocksWhere,
  coverage,
  createPriceLookup,
  isWeekend,
  logReturns,
  times,
  utcDayOfMonth,
  utcDayStart,
  utcHour,
  utcWeekday,
} from "./series.ts";

function bar(time: number, close: number): Candle {
  return { time, open: close, high: close, low: close, close, volume: 1 };
}

describe("closes and times", () => {
  it("unpack the fields into typed arrays", () => {
    const bars = [bar(60, 100), bar(120, 101)];
    expect(Array.from(closes(bars))).toEqual([100, 101]);
    expect(Array.from(times(bars))).toEqual([60, 120]);
  });
});

describe("logReturns", () => {
  it("computes close-to-close logs", () => {
    const r = logReturns([bar(60, 100), bar(120, 110), bar(180, 99)], 60);
    expect(r.value.length).toBe(2);
    expect(r.value[0]).toBeCloseTo(Math.log(1.1), 12);
    expect(r.value[1]).toBeCloseTo(Math.log(99 / 110), 12);
    expect(Array.from(r.time)).toEqual([120, 180]);
    expect(r.gaps).toBe(0);
  });

  it("drops the step that spans a missing bar instead of stretching it", () => {
    // 60, 120, then a hole, then 300.
    const r = logReturns([bar(60, 100), bar(120, 101), bar(300, 150)], 60);
    expect(r.value.length).toBe(1);
    expect(r.gaps).toBe(1);
    expect(Array.from(r.time)).toEqual([120]);
  });

  it("drops non-positive prices rather than producing NaN", () => {
    const r = logReturns([bar(60, 100), bar(120, 0), bar(180, 100)], 60);
    expect(r.value.length).toBe(0);
    expect(r.gaps).toBe(2);
  });

  it("handles a series too short to have any return", () => {
    expect(logReturns([bar(60, 100)], 60).value.length).toBe(0);
    expect(logReturns([], 60).value.length).toBe(0);
  });
});

describe("contiguousBlocks", () => {
  it("splits at every gap and drops runs that are too short", () => {
    const bars = [
      bar(60, 100),
      bar(120, 101),
      bar(180, 102),
      bar(240, 103),
      // gap
      bar(600, 104),
      bar(660, 105),
      // gap
      bar(1200, 106),
    ];
    const series = logReturns(bars, 60);
    const blocks = contiguousBlocks(series, 2);
    expect(blocks.length).toBe(1);
    expect(blocks[0].length).toBe(3);
    // With minLength 1 the lone return after the second gap survives.
    expect(contiguousBlocks(series, 1).length).toBe(2);
  });

  it("returns one block for a clean series", () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar(60 * (i + 1), 100 + i));
    const blocks = contiguousBlocks(logReturns(bars, 60), 2);
    expect(blocks.length).toBe(1);
    expect(blocks[0].length).toBe(9);
  });
});

describe("coverage", () => {
  it("is one for a complete series and below one with holes", () => {
    const full = Array.from({ length: 5 }, (_, i) => bar(60 * (i + 1), 100));
    expect(coverage(full, 60)).toBeCloseTo(1, 12);
    expect(coverage([bar(60, 1), bar(300, 1)], 60)).toBeCloseTo(2 / 5, 12);
  });
});

describe("calendar helpers", () => {
  it("reads the UTC hour", () => {
    expect(utcHour(0)).toBe(0);
    // 2025-01-01T03:30:00Z
    expect(utcHour(Date.UTC(2025, 0, 1, 3, 30) / 1000)).toBe(3);
    expect(utcHour(Date.UTC(2025, 0, 1, 23, 59) / 1000)).toBe(23);
  });

  it("reads the UTC weekday with Sunday as zero", () => {
    // 1970-01-01 was a Thursday.
    expect(utcWeekday(0)).toBe(4);
    // 2025-01-04 was a Saturday, 2025-01-05 a Sunday.
    expect(utcWeekday(Date.UTC(2025, 0, 4) / 1000)).toBe(6);
    expect(utcWeekday(Date.UTC(2025, 0, 5) / 1000)).toBe(0);
    expect(isWeekend(Date.UTC(2025, 0, 4) / 1000)).toBe(true);
    expect(isWeekend(Date.UTC(2025, 0, 6) / 1000)).toBe(false);
  });

  it("truncates to midnight UTC", () => {
    const t = Date.UTC(2025, 5, 17, 13, 44, 12) / 1000;
    expect(utcDayStart(t)).toBe(Date.UTC(2025, 5, 17) / 1000);
  });

  it("reads the UTC day of month", () => {
    expect(utcDayOfMonth(Date.UTC(2025, 5, 17, 13) / 1000)).toBe(17);
    expect(utcDayOfMonth(Date.UTC(2025, 5, 1, 0) / 1000)).toBe(1);
  });
});

describe("createPriceLookup", () => {
  it("finds exact timestamps and refuses to guess at the ones it lacks", () => {
    const bars = [bar(60, 100), bar(120, 101), bar(180, 102)];
    const at = createPriceLookup(bars);
    expect(at(60)).toBe(100);
    expect(at(180)).toBe(102);
    expect(at(90)).toBeNull();
    expect(at(0)).toBeNull();
    expect(at(1e9)).toBeNull();
  });
});

describe("contiguousBlocksWhere", () => {
  it("keeps only accepted returns and never joins across the window edge", () => {
    const bars = Array.from({ length: 10 }, (_, i) => bar(60 * (i + 1), 100 + i));
    const series = logReturns(bars, 60);
    // Nine returns at 120..600; this keeps 120/180/240 and 540/600.
    const accept = (t: number): boolean => t <= 240 || t >= 540;
    const blocks = contiguousBlocksWhere(series, accept, 2);
    expect(blocks.map((b) => b.length)).toEqual([3, 2]);
  });

  it("splits on data gaps as well as on the predicate", () => {
    const bars = [bar(60, 100), bar(120, 101), bar(180, 102), bar(600, 103), bar(660, 104), bar(720, 105)];
    const blocks = contiguousBlocksWhere(logReturns(bars, 60), () => true, 2);
    expect(blocks.map((b) => b.length)).toEqual([2, 2]);
  });

  it("returns nothing when the predicate rejects everything", () => {
    const bars = Array.from({ length: 5 }, (_, i) => bar(60 * (i + 1), 100 + i));
    expect(contiguousBlocksWhere(logReturns(bars, 60), () => false).length).toBe(0);
  });

  it("selects night hours the way the study does", () => {
    const start = Date.UTC(2025, 0, 1) / 1000;
    const bars = Array.from({ length: 24 * 60 }, (_, i) => bar(start + i * 60, 100 + (i % 7)));
    const series = logReturns(bars, 60);
    const night = contiguousBlocksWhere(series, (t) => utcHour(t) >= 3 && utcHour(t) < 6, 2);
    // Three whole hours of minute returns, one continuous run.
    expect(night.length).toBe(1);
    expect(night[0].length).toBe(180);
  });
});
