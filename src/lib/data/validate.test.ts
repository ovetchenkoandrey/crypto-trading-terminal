import { describe, expect, it } from "vitest";
import type { Candle } from "../types.ts";
import {
  expectedBarCount,
  formatFundingReport,
  formatQualityReport,
  mergeSourceSpans,
  validateCandles,
  validateFunding,
  type MonthInput,
} from "./validate.ts";

const START = Date.UTC(2025, 2, 1) / 1000;
const STEP = 60;

function series(count: number, startSec = START, price = 100): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: startSec + i * STEP,
    open: price,
    high: price + 1,
    low: price - 1,
    close: price,
    volume: 1,
  }));
}

function opts(candles: Candle[], extra: Record<string, unknown> = {}) {
  return {
    intervalSec: STEP,
    fromSec: candles[0].time,
    toSec: candles[candles.length - 1].time,
    ...extra,
  };
}

function kinds(report: { issues: { kind: string }[] }): string[] {
  return report.issues.map((i) => i.kind);
}

describe("expectedBarCount", () => {
  it("counts grid points inside an inclusive range", () => {
    expect(expectedBarCount(0, 59, 60)).toBe(1);
    expect(expectedBarCount(0, 60, 60)).toBe(2);
    expect(expectedBarCount(0, 3599, 60)).toBe(60);
    expect(expectedBarCount(100, 50, 60)).toBe(0);
  });
});

describe("validateCandles", () => {
  it("passes a clean series", () => {
    const report = validateCandles(series(1000), opts(series(1000)));
    expect(report.ok).toBe(true);
    expect(report.errors).toBe(0);
    expect(report.issues).toEqual([]);
    expect(report.coverage).toBe(1);
    expect(report.bars).toMatchObject({ expected: 1000, unique: 1000, missing: 0 });
  });

  it("reports a hole without filling it", () => {
    const candles = [...series(10), ...series(10, START + 15 * STEP)];
    const report = validateCandles(candles, opts(candles));
    expect(report.gapCount).toBe(1);
    expect(report.gapBars).toBe(5);
    expect(report.gaps[0]).toEqual({ after: START + 9 * STEP, before: START + 15 * STEP, missingBars: 5, atMonthSeam: false });
    expect(report.largestGap?.missingBars).toBe(5);
    expect(kinds(report)).toContain("gap");
    expect(report.bars.unique).toBe(20);
    expect(report.bars.missing).toBe(5);
  });

  it("escalates a long hole from warning to error", () => {
    const candles = [...series(10), ...series(10, START + 200 * STEP)];
    const warn = validateCandles(candles, opts(candles, { gapErrorBars: 1000, minCoverage: 0 }));
    expect(warn.issues.find((i) => i.kind === "gap")?.severity).toBe("warning");
    const fail = validateCandles(candles, opts(candles, { gapErrorBars: 60, minCoverage: 0 }));
    expect(fail.issues.find((i) => i.kind === "gap")?.severity).toBe("error");
    expect(fail.ok).toBe(false);
  });

  it("flags duplicates and out-of-order bars", () => {
    const clean = series(5);
    const candles = [clean[0], clean[1], clean[1], clean[3], clean[2], clean[4]];
    const report = validateCandles(candles, {
      intervalSec: STEP,
      fromSec: clean[0].time,
      toSec: clean[4].time,
      minCoverage: 0,
    });
    expect(report.bars.duplicates).toBe(1);
    expect(report.bars.outOfOrder).toBe(1);
    expect(report.ok).toBe(false);
  });

  it("flags bars off the interval grid", () => {
    const candles = series(3);
    candles[1] = { ...candles[1], time: candles[1].time + 7 };
    const report = validateCandles(candles, opts(candles, { minCoverage: 0 }));
    expect(report.bars.misaligned).toBe(1);
    expect(kinds(report)).toContain("misaligned");
    expect(report.ok).toBe(false);
  });

  it("flags impossible OHLC and non-positive prices", () => {
    const candles = series(4);
    candles[1] = { ...candles[1], high: 50, low: 200 };
    candles[2] = { ...candles[2], close: 0 };
    candles[3] = { ...candles[3], volume: -1 };
    const report = validateCandles(candles, opts(candles));
    expect(kinds(report)).toContain("bad-ohlc");
    expect(report.counts["non-positive"]).toBe(2);
    expect(report.ok).toBe(false);
  });

  it("flags an implausible one-bar move", () => {
    const candles = series(5);
    candles[3] = { ...candles[3], open: 500, high: 501, low: 499, close: 500 };
    const report = validateCandles(candles, opts(candles, { extremeMovePct: 10 }));
    expect(report.counts["extreme-move"]).toBe(2);
    expect(report.errors).toBe(0);
  });

  it("flags a long run of zero-volume bars", () => {
    const candles = series(200).map((c, i) => (i >= 50 && i < 150 ? { ...c, volume: 0 } : c));
    const report = validateCandles(candles, opts(candles, { flatRunBars: 60 }));
    const flat = report.issues.find((i) => i.kind === "flat-run");
    expect(flat?.bars).toBe(100);
    expect(flat?.severity).toBe("warning");
  });

  it("reports leading and trailing shortfalls against the requested range", () => {
    const candles = series(10, START + 5 * STEP);
    const report = validateCandles(candles, {
      intervalSec: STEP,
      fromSec: START,
      toSec: START + 20 * STEP,
      gapErrorBars: 1000,
      minCoverage: 0,
    });
    const coverage = report.issues.filter((i) => i.kind === "coverage");
    expect(coverage).toHaveLength(2);
    expect(coverage[0].bars).toBe(5);
    expect(coverage[1].bars).toBe(6);
  });

  it("fails when coverage drops below the threshold", () => {
    const candles = [...series(10), ...series(10, START + 500 * STEP)];
    const report = validateCandles(candles, opts(candles, { gapErrorBars: 100000, minCoverage: 0.99 }));
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === "coverage" && i.severity === "error")).toBe(true);
  });

  it("fails on an empty range", () => {
    const report = validateCandles([], { intervalSec: STEP, fromSec: START, toSec: START + 100 * STEP });
    expect(report.ok).toBe(false);
    expect(kinds(report)).toContain("coverage");
    expect(report.bars.unique).toBe(0);
  });

  it("tags a hole that lands on a month boundary", () => {
    const marchEnd = Date.UTC(2025, 2, 31, 23, 55) / 1000;
    const candles = [...series(5, marchEnd), ...series(5, Date.UTC(2025, 3, 1, 0, 5) / 1000)];
    const report = validateCandles(candles, opts(candles, { minCoverage: 0 }));
    expect(kinds(report)).toContain("month-seam");
    expect(report.gaps[0].atMonthSeam).toBe(true);
  });

  it("locates the handover between data sources and measures the price jump", () => {
    const candles = [...series(10, START, 100), ...series(10, START + 10 * STEP, 130)];
    const report = validateCandles(candles, {
      ...opts(candles),
      sourceSpans: [
        { source: "binance-archive", from: START, to: START + 9 * STEP },
        { source: "bybit-rest", from: START + 10 * STEP, to: START + 19 * STEP },
      ],
      extremeMovePct: 100,
    });
    expect(report.sourceSeams).toHaveLength(1);
    expect(report.sourceSeams[0]).toMatchObject({ time: START + 10 * STEP, from: "binance-archive", to: "bybit-rest" });
    expect(report.sourceSeams[0].jumpPct).toBeCloseTo(30, 5);
    const seam = report.issues.find((i) => i.kind === "source-mix");
    expect(seam?.severity).toBe("error");
  });

  it("stays quiet when a single source covers the range", () => {
    const candles = series(20);
    const report = validateCandles(candles, {
      ...opts(candles),
      sourceSpans: [
        { source: "binance-archive", from: START, to: START + 9 * STEP },
        { source: "binance-archive", from: START + 10 * STEP, to: START + 19 * STEP },
      ],
    });
    expect(report.sourceSpans).toHaveLength(1);
    expect(report.sourceSeams).toEqual([]);
  });

  it("surfaces broken months from the store", () => {
    const candles = series(10);
    const months: MonthInput[] = [
      { month: "2025-02", present: false, state: "missing", sources: [], count: 0, complete: false, expected: 40320 },
      { month: "2025-03", present: true, state: "trailing", sources: ["binance-archive"], count: 10, complete: false, expected: 44640 },
    ];
    const report = validateCandles(candles, opts(candles, { months, minCoverage: 0 }));
    expect(report.months[0].missing).toBe(40320);
    expect(report.months[1].coverage).toBeCloseTo(10 / 44640, 8);
    const storage = report.issues.filter((i) => i.kind === "storage");
    expect(storage.map((i) => i.severity)).toEqual(["error", "warning"]);
  });

  it("caps the issue list but keeps the counts honest", () => {
    const candles = series(50).map((c) => ({ ...c, close: 0 }));
    const report = validateCandles(candles, opts(candles, { maxIssues: 5 }));
    expect(report.issues).toHaveLength(5);
    expect(report.issuesOmitted).toBeGreaterThan(0);
    expect(report.counts["non-positive"]).toBe(50);
  });

  it("renders a readable summary", () => {
    const candles = [...series(10), ...series(10, START + 15 * STEP)];
    const report = validateCandles(candles, {
      ...opts(candles),
      minCoverage: 0,
      months: [{ month: "2025-03", present: true, state: "ok", sources: ["binance-archive"], count: 20, complete: true, expected: 25 }],
      sourceSpans: [
        { source: "binance-archive", from: START, to: START + 9 * STEP },
        { source: "bybit-rest", from: START + 15 * STEP, to: START + 24 * STEP },
      ],
    });
    const text = formatQualityReport(report);
    expect(text).toContain("Data quality report");
    expect(text).toContain("Gaps      1 hole(s), 5 missing bar(s)");
    expect(text).toContain("2025-03");
    expect(text).toContain("seam binance-archive -> bybit-rest");
    expect(text).toContain("Findings by kind");
  });
});

describe("validateFunding", () => {
  const EIGHT = 8 * 3600;
  const from = Date.UTC(2025, 2, 1) / 1000;

  function fundingSeries(count: number, rate = 0.0001) {
    return Array.from({ length: count }, (_, i) => ({ time: from + i * EIGHT, rate }));
  }

  it("passes a complete grid", () => {
    const events = fundingSeries(90);
    const report = validateFunding(events, { fromSec: from, toSec: events[89].time, intervalMinutes: 480 });
    expect(report.ok).toBe(true);
    expect(report.events).toMatchObject({ expected: 90, unique: 90, missing: 0 });
    expect(report.coverage).toBe(1);
    expect(report.rate.mean).toBeCloseTo(0.0001, 10);
    expect(report.rate.annualizedMean).toBeCloseTo(0.1095, 4);
  });

  it("reports missing settlements as errors", () => {
    const events = [...fundingSeries(10), ...fundingSeries(10).map((e) => ({ ...e, time: e.time + 20 * EIGHT }))];
    const report = validateFunding(events, { fromSec: from, toSec: events[events.length - 1].time, intervalMinutes: 480 });
    expect(report.ok).toBe(false);
    expect(report.issues.some((i) => i.kind === "gap")).toBe(true);
  });

  it("flags off-grid settlements", () => {
    const events = fundingSeries(3);
    events[1] = { ...events[1], time: events[1].time + 137 };
    const report = validateFunding(events, { fromSec: from, toSec: events[2].time, intervalMinutes: 480 });
    expect(report.issues.some((i) => i.kind === "misaligned")).toBe(true);
  });

  it("flags a rate at the exchange cap", () => {
    const events = fundingSeries(3);
    events[1] = { ...events[1], rate: 0.0075 };
    const report = validateFunding(events, { fromSec: from, toSec: events[2].time, intervalMinutes: 480 });
    expect(report.issues.some((i) => i.kind === "extreme-move")).toBe(true);
  });

  it("disables gap detection when the interval is unknown", () => {
    const report = validateFunding(fundingSeries(5), { fromSec: from, toSec: from + 4 * EIGHT, intervalMinutes: null });
    expect(report.issues.some((i) => i.kind === "coverage" && i.severity === "warning")).toBe(true);
    expect(report.issues.some((i) => i.kind === "gap")).toBe(false);
  });

  it("fails on an empty history", () => {
    const report = validateFunding([], { fromSec: from, toSec: from + EIGHT, intervalMinutes: 480 });
    expect(report.ok).toBe(false);
  });

  it("renders a readable summary", () => {
    const events = fundingSeries(30);
    const text = formatFundingReport(
      validateFunding(events, { fromSec: from, toSec: events[29].time, intervalMinutes: 480, symbol: "BTCUSDT", market: "linear" }),
    );
    expect(text).toContain("Funding quality report — linear:BTCUSDT");
    expect(text).toContain("Interval  480 min");
  });
});

describe("mergeSourceSpans", () => {
  it("folds neighbours and sorts by start", () => {
    expect(
      mergeSourceSpans([
        { source: "b", from: 100, to: 200 },
        { source: "a", from: 0, to: 50 },
        { source: "a", from: 51, to: 99 },
      ]),
    ).toEqual([
      { source: "a", from: 0, to: 99 },
      { source: "b", from: 100, to: 200 },
    ]);
  });
});
