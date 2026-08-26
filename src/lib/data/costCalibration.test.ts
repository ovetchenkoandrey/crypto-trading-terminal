import { describe, expect, it } from "vitest";
import type { QuoteDay, TradeDay } from "./tardisSamples";
import {
  accumulateQuotes,
  accumulateTakerCost,
  addDepthRow,
  aggregateHours,
  binQuantile,
  bucketIndex,
  buildBarSpans,
  createDepthProfile,
  finishDepthProfile,
  summarizeDepthDays,
  createHourStats,
  createLimitFillStats,
  createTakerCostStats,
  histQuantile,
  isWeekendMs,
  meanDepth,
  simulateLimitFills,
  summarizeDepth,
  summarizeHours,
  summarizeLimitFills,
  summarizeTakerCost,
  accumulateVolatilityCost,
  createVolatilityCostStats,
  rangeQuantile,
  summarizeVolatilityCost,
  utcDayOfWeekOfMs,
  utcHourOfMs,
  wilson,
} from "./costCalibration";

function quotes(rows: Array<[number, number, number, number, number]>): QuoteDay {
  const n = rows.length;
  const day: QuoteDay = {
    n,
    ts: new Float64Array(n),
    bid: new Float64Array(n),
    bidAmt: new Float64Array(n),
    ask: new Float64Array(n),
    askAmt: new Float64Array(n),
    malformed: 0,
  };
  rows.forEach(([ts, bid, bidAmt, ask, askAmt], i) => {
    day.ts[i] = ts;
    day.bid[i] = bid;
    day.bidAmt[i] = bidAmt;
    day.ask[i] = ask;
    day.askAmt[i] = askAmt;
  });
  return day;
}

function trades(rows: Array<[number, number, number, 0 | 1]>): TradeDay {
  const n = rows.length;
  const day: TradeDay = {
    n,
    ts: new Float64Array(n),
    price: new Float64Array(n),
    amount: new Float64Array(n),
    sell: new Uint8Array(n),
    malformed: 0,
  };
  rows.forEach(([ts, price, amount, sell], i) => {
    day.ts[i] = ts;
    day.price[i] = price;
    day.amount[i] = amount;
    day.sell[i] = sell;
  });
  return day;
}

const WED_10 = Date.UTC(2025, 5, 4, 10, 0, 0);
const SAT_04 = Date.UTC(2025, 5, 7, 4, 0, 0);

describe("clock helpers", () => {
  it("reads the UTC hour and weekday from a millisecond stamp", () => {
    expect(utcHourOfMs(WED_10)).toBe(10);
    expect(utcDayOfWeekOfMs(WED_10)).toBe(3);
    expect(isWeekendMs(WED_10)).toBe(false);
    expect(utcHourOfMs(SAT_04)).toBe(4);
    expect(isWeekendMs(SAT_04)).toBe(true);
  });

  it("keeps weekday and weekend in separate buckets", () => {
    expect(bucketIndex(4, false)).toBe(4);
    expect(bucketIndex(4, true)).toBe(28);
  });
});

describe("accumulateQuotes", () => {
  it("weights a quote by how long it stood, not by how often it printed", () => {
    const stats = createHourStats();
    accumulateQuotes(
      quotes([
        [WED_10, 100, 5, 100.1, 5],
        [WED_10 + 3000, 100, 5, 100.3, 5],
        [WED_10 + 4000, 100, 5, 100.1, 5],
      ]),
      stats,
      { tickSize: 0.1, endMs: WED_10 + 4000 },
    );
    const rows = summarizeHours(stats);
    expect(rows).toHaveLength(1);
    expect(rows[0].hour).toBe(10);
    expect(rows[0].weekend).toBe(false);
    expect(rows[0].hours).toBeCloseTo(4 / 3600, 12);
    expect(rows[0].meanSpreadTicks).toBeCloseTo(1.5, 9);
    expect(rows[0].oneTickShare).toBeCloseTo(0.75, 9);
    const perQuoteBps = ((0.1 / 100.05) * 10_000 * 3 + (0.3 / 100.15) * 10_000 * 1) / 4;
    expect(rows[0].meanSpreadBps).toBeCloseTo(perQuoteBps, 9);
  });

  it("drops a feed gap instead of pretending the quote stood through it", () => {
    const stats = createHourStats();
    accumulateQuotes(
      quotes([
        [WED_10, 100, 5, 100.1, 5],
        [WED_10 + 600_000, 100, 5, 100.1, 5],
      ]),
      stats,
      { tickSize: 0.1, maxGapMs: 5000, endMs: WED_10 + 600_000 },
    );
    expect(summarizeHours(stats)).toHaveLength(0);
    expect(stats.droppedSec).toBeCloseTo(600, 6);
  });

  it("ignores a crossed or locked book", () => {
    const stats = createHourStats();
    accumulateQuotes(
      quotes([
        [WED_10, 100.2, 5, 100.1, 5],
        [WED_10 + 1000, 100, 5, 100, 5],
        [WED_10 + 2000, 100, 5, 100.1, 5],
      ]),
      stats,
      { tickSize: 0.1, endMs: WED_10 + 3000 },
    );
    expect(summarizeHours(stats)[0].hours).toBeCloseTo(1 / 3600, 12);
  });

  it("aggregates buckets weighted by observed time", () => {
    const stats = createHourStats();
    accumulateQuotes(quotes([[WED_10, 100, 5, 100.1, 5], [WED_10 + 2000, 100, 5, 100.1, 5]]), stats, {
      tickSize: 0.1,
      endMs: WED_10 + 2000,
    });
    accumulateQuotes(quotes([[SAT_04, 100, 5, 100.4, 5], [SAT_04 + 2000, 100, 5, 100.4, 5]]), stats, {
      tickSize: 0.1,
      endMs: SAT_04 + 2000,
    });
    const rows = summarizeHours(stats);
    expect(aggregateHours(rows, (r) => !r.weekend).meanSpreadTicks).toBeCloseTo(1, 9);
    expect(aggregateHours(rows, (r) => r.weekend).meanSpreadTicks).toBeCloseTo(4, 9);
    expect(aggregateHours(rows, () => false).hours).toBe(0);
  });
});

describe("histQuantile", () => {
  it("returns the tick width holding the quantile", () => {
    expect(histQuantile([9, 1], 0.5)).toBe(1);
    expect(histQuantile([9, 1], 0.95)).toBe(2);
    expect(histQuantile([0, 0], 0.5)).toBeNaN();
  });
});

describe("binQuantile", () => {
  it("returns the upper edge of the bin holding the quantile", () => {
    expect(binQuantile([10, 10], 0.25, 0.25)).toBeCloseTo(0.25, 12);
    expect(binQuantile([10, 10], 0.75, 0.25)).toBeCloseTo(0.5, 12);
  });
});

describe("accumulateTakerCost", () => {
  it("charges the half-spread at zero latency, both sides", () => {
    const stats = createTakerCostStats([5, 10]);
    const rows: Array<[number, number, number, number, number]> = [];
    for (let k = 0; k <= 10; k++) rows.push([WED_10 + k * 500, 100, 5, 100.1, 5]);
    accumulateTakerCost(quotes(rows), stats, { latencyMs: 0, sampleStepMs: 1000 });
    const summary = summarizeTakerCost(stats);
    expect(summary).toHaveLength(1);
    // 6 decision instants (0..5 s), buy and sell sampled at each.
    expect(summary[0].samples).toBe(12);
    expect(summary[0].meanBps).toBeCloseTo((0.05 / 100.05) * 10_000, 6);
    expect(summary[0].overBand[0].share).toBe(0);
  });

  it("charges the adverse move that happens during the flight", () => {
    const stats = createTakerCostStats([5]);
    const rows: Array<[number, number, number, number, number]> = [
      [WED_10, 100, 5, 100.1, 5],
      [WED_10 + 400, 101, 5, 101.1, 5],
      [WED_10 + 1000, 101, 5, 101.1, 5],
      [WED_10 + 1400, 101, 5, 101.1, 5],
    ];
    accumulateTakerCost(quotes(rows), stats, { latencyMs: 400, sampleStepMs: 1000 });
    const summary = summarizeTakerCost(stats);
    // Buy pays ask(t+400) against mid(t): (101.1 - 100.05) / 100.05.
    expect(summary[0].overBand[0].share).toBeGreaterThan(0);
    expect(summary[0].meanBps).toBeGreaterThan(0);
  });

  it("drops a sample rather than pricing it off a stale quote", () => {
    const stats = createTakerCostStats();
    accumulateTakerCost(
      quotes([
        [WED_10, 100, 5, 100.1, 5],
        [WED_10 + 60_000, 100, 5, 100.1, 5],
      ]),
      stats,
      { latencyMs: 0, sampleStepMs: 1000, maxStaleMs: 2000 },
    );
    expect(stats.skipped).toBeGreaterThan(50);
    expect(summarizeTakerCost(stats).reduce((a, r) => a + r.samples, 0)).toBeLessThanOrEqual(8);
  });
});

describe("buildBarSpans", () => {
  it("cuts bars on the minute and carries the quote range", () => {
    const q = quotes([
      [0, 100, 1, 100.1, 1],
      [70_000, 101, 1, 101.1, 1],
    ]);
    const t = trades([
      [1000, 100, 1, 1],
      [2000, 99, 1, 1],
      [61_000, 101, 1, 0],
    ]);
    const spans = buildBarSpans(q, t, 60_000);
    expect(spans).toHaveLength(2);
    expect(spans[0]).toMatchObject({ startMs: 0, open: 100, low: 99, high: 100, tFrom: 0, tTo: 2, qFrom: 0, qTo: 1 });
    expect(spans[1]).toMatchObject({ startMs: 60_000, open: 101, tFrom: 2, tTo: 3 });
  });
});

describe("simulateLimitFills", () => {
  const EDGES = [0, 1, 60, Infinity];

  const q = quotes([
    [0, 100, 5, 100.5, 5],
    [1500, 99.5, 4, 100, 5],
    [2500, 99, 20, 99.5, 5],
  ]);
  const t = trades([
    [1000, 100, 2, 1],
    [2000, 99.5, 3, 1],
    [3000, 99, 10, 1],
  ]);

  function run(ourQty = 1) {
    const stats = createLimitFillStats(EDGES);
    simulateLimitFills(q, t, stats, { ourQty, tickSize: 0.5, levelsPerBar: 3 });
    return stats;
  }

  it("settles a level the tape traded through by price priority, not by queue", () => {
    const stats = run();
    // Buy limits at 100 and 99.5 both saw trades below them.
    expect(stats.swept[2]).toBe(1);
    expect(stats.swept[3]).toBe(1);
    expect(stats.filled[2]).toBe(1);
    expect(stats.filled[3]).toBe(1);
  });

  it("leaves the bar extreme to the queue assumption", () => {
    const stats = run();
    // Buy at the low (20 ahead, 10 traded) and sell at the high (nothing traded).
    expect(stats.touches[0]).toBe(2);
    expect(stats.swept[0]).toBe(0);
    expect(stats.filled[0]).toBe(0);
    expect(stats.filledOptimistic[0]).toBe(1);
    expect(stats.filledUniform[0]).toBeCloseTo((10 - 1) / 20, 9);
  });

  it("treats a level the book never quoted as swept, not as untouched", () => {
    expect(run().gapped[0]).toBe(1);
  });

  it("records the size that stood in front of us", () => {
    const rows = summarizeLimitFills(run());
    const extreme = rows.find((r) => r.toBps === 0);
    expect(extreme?.meanQueueAheadNotional).toBeCloseTo((20 * 99 + 0) / 2, 6);
    expect(extreme?.ci95[0]).toBeGreaterThanOrEqual(0);
    expect(extreme?.ci95[1]).toBeLessThanOrEqual(1);
  });

  it("scales the extreme-level fill with our own size", () => {
    expect(run(0.001).filledUniform[0]).toBeGreaterThan(run(100).filledUniform[0]);
    expect(run(100).filledUniform[0]).toBe(0);
    expect(run(100).filled[0]).toBe(0);
  });

  it("does not count a sweep that happened before the level came into play", () => {
    // The whole move down to 99 happens in the first bar; a level planted in the
    // second bar must not inherit it.
    const q2 = quotes([
      [0, 100, 5, 100.5, 5],
      [61_000, 100, 5, 100.5, 5],
    ]);
    const t2 = trades([
      [1000, 99, 10, 1],
      [61_000, 100, 1, 1],
    ]);
    const stats = createLimitFillStats(EDGES);
    simulateLimitFills(q2, t2, stats, { ourQty: 1, tickSize: 0.5, levelsPerBar: 3 });
    expect(stats.bars).toBe(2);
    // The 99 print belongs to the first bar; the second bar's level at 100 sees
    // only a trade at its own price, so it stays a queue question.
    expect(stats.swept.reduce((a, b) => a + b, 0)).toBe(0);
    expect(stats.filledOptimistic[0]).toBe(1);
    expect(stats.filled[0]).toBe(0);
  });
});

describe("wilson", () => {
  it("stays inside the unit interval near the edges", () => {
    const [lo, hi] = wilson(0, 100);
    expect(lo).toBe(0);
    expect(hi).toBeGreaterThan(0);
    expect(hi).toBeLessThan(0.05);
    const [lo2, hi2] = wilson(100, 100);
    expect(hi2).toBeCloseTo(1, 12);
    expect(lo2).toBeGreaterThan(0.95);
  });

  it("brackets the point estimate", () => {
    const [lo, hi] = wilson(30, 100);
    expect(lo).toBeLessThan(0.3);
    expect(hi).toBeGreaterThan(0.3);
  });

  it("is undefined without observations", () => {
    expect(wilson(0, 0)[0]).toBeNaN();
  });
});

describe("depth profile", () => {
  it("keeps only the band nearest the touch and splits weekday from weekend", () => {
    const p = createDepthProfile();
    addDepthRow(p, WED_10 / 1000, -1, 100);
    addDepthRow(p, WED_10 / 1000, 1, 200);
    addDepthRow(p, WED_10 / 1000, 5, 999_999);
    addDepthRow(p, SAT_04 / 1000, 1, 50);
    const rows = summarizeDepth(p);
    expect(rows).toHaveLength(2);
    expect(meanDepth(rows, (r) => !r.weekend)).toBeCloseTo(150, 9);
    expect(meanDepth(rows, (r) => r.weekend)).toBeCloseTo(50, 9);
    expect(meanDepth(rows, () => false)).toBeNaN();
  });

  it("pairs the two sides of a snapshot before judging a collapse", () => {
    const p = createDepthProfile();
    const t0 = WED_10 / 1000;
    for (const [i, size] of [100, 100, 100, 10].entries()) {
      addDepthRow(p, t0 + i * 30, -1, size, "2025-06-04");
      addDepthRow(p, t0 + i * 30, 1, size, "2025-06-04");
    }
    finishDepthProfile(p);
    const [day] = summarizeDepthDays(p);
    expect(day.date).toBe("2025-06-04");
    expect(day.snapshots).toBe(4);
    expect(day.median).toBe(200);
    expect(day.min).toBe(20);
    expect(day.troughRatio).toBeCloseTo(0.1, 9);
  });

  it("records nothing per day when no date is supplied", () => {
    const p = createDepthProfile();
    addDepthRow(p, WED_10 / 1000, 1, 100);
    finishDepthProfile(p);
    expect(summarizeDepthDays(p)).toEqual([]);
  });
});

describe("accumulateVolatilityCost", () => {
  it("buckets minutes by their own range and prices each bucket separately", () => {
    // Bar 0: 0.02% range and a one-cent spread. Bar 1: 1% range and a wide one.
    const q = quotes([
      [0, 99.99, 1, 100.0, 1],
      [30_000, 99.99, 1, 100.0, 1],
      [60_000, 99.5, 1, 100.5, 1],
      [90_000, 99.5, 1, 100.5, 1],
    ]);
    const t = trades([
      [1000, 100, 1, 1],
      [30_000, 100.02, 1, 0],
      [61_000, 100, 1, 1],
      [90_000, 101, 1, 0],
    ]);
    const stats = createVolatilityCostStats([0.05, 0.5, Infinity]);
    accumulateVolatilityCost(q, t, stats, { latencyMs: 0, sampleStepMs: 1000 });
    const rows = summarizeVolatilityCost(stats, 0.02);
    expect(rows).toHaveLength(2);
    expect(rows[0].bars).toBe(1);
    expect(rows[1].bars).toBe(1);
    expect(rows[0].multiplier).toBeCloseTo(1, 9);
    // Half-spread goes from 0.005 to 0.5 of a percent-ish price: about 100x.
    expect(rows[1].multiplier).toBeGreaterThan(50);
    expect(rows[0].barShare).toBeCloseTo(0.5, 9);
  });

  it("reports the bar-range distribution it saw", () => {
    const q = quotes([
      [0, 99.99, 1, 100.0, 1],
      [60_000, 99.5, 1, 100.5, 1],
      [120_000, 99.5, 1, 100.5, 1],
    ]);
    const t = trades([
      [1000, 100, 1, 1],
      [30_000, 100.02, 1, 0],
      [61_000, 100, 1, 1],
      [90_000, 101, 1, 0],
    ]);
    const stats = createVolatilityCostStats([0.05, 0.5, Infinity]);
    accumulateVolatilityCost(q, t, stats, { latencyMs: 0 });
    expect(rangeQuantile(stats, 0.5)).toBe(0.05);
    expect(rangeQuantile(stats, 0.9)).toBe(Infinity);
  });
});
