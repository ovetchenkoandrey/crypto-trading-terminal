import { describe, expect, it } from "vitest";
import {
  BOOK5_HEADER,
  accumulateBook5,
  accumulateBookSnapshots,
  bookSnapshotHeader,
  createBookRow,
  createLiquidityStats,
  fitLot,
  forEachBook5Row,
  histQuantileBps,
  interpolateCostBps,
  marketOrderCostBps,
  mergeLiquidityStats,
  summarizeLiquidity,
  sweepBook,
} from "./liquidityProfile.ts";

const enc = new TextEncoder();

const BASE_MS = 1_700_000_000_000;

/** A flat book `tick` wide per level, timestamped `msOffset` after BASE_MS. */
function bookRow(msOffset: number, bid: number, ask: number, amt: number, tick: number): string {
  const tsUs = (BASE_MS + msOffset) * 1000;
  const cells: string[] = ["binance-futures", "TESTUSDT", String(tsUs), String(tsUs)];
  for (let l = 0; l < 5; l++) {
    cells.push(String(+(ask + l * tick).toFixed(6)), String(amt));
    cells.push(String(+(bid - l * tick).toFixed(6)), String(amt));
  }
  return cells.join(",");
}

function csv(rows: string[]): Uint8Array {
  return enc.encode([BOOK5_HEADER.join(","), ...rows].join("\n") + "\n");
}

describe("forEachBook5Row", () => {
  it("reads five levels a side and converts microseconds to milliseconds", () => {
    const buf = csv([bookRow(0, 99.99, 100.01, 2, 0.01)]);
    const seen: { ts: number; bid: number; ask: number; levels: number }[] = [];
    const bad = forEachBook5Row(buf, (r) => {
      seen.push({ ts: r.tsMs, bid: r.bidPx[0], ask: r.askPx[0], levels: r.askLevels });
    });
    expect(bad).toBe(0);
    expect(seen).toHaveLength(1);
    expect(seen[0].ts).toBe(BASE_MS);
    expect(seen[0].bid).toBeCloseTo(99.99, 6);
    expect(seen[0].ask).toBeCloseTo(100.01, 6);
    expect(seen[0].levels).toBe(5);
  });

  it("keeps a short book and stops at the first missing level", () => {
    const cells = ["binance-futures", "TESTUSDT", "1000000", "1000000"];
    for (let l = 0; l < 5; l++) {
      if (l < 2) cells.push("101", "1", "99", "1");
      else cells.push("", "", "", "");
    }
    const buf = csv([cells.join(",")]);
    let levels = -1;
    forEachBook5Row(buf, (r) => {
      levels = r.askLevels;
    });
    expect(levels).toBe(2);
  });

  it("rejects a crossed book", () => {
    const buf = csv([bookRow(1_000, 100.5, 100.0, 1, 0.01)]);
    let rows = 0;
    const bad = forEachBook5Row(buf, () => {
      rows++;
    });
    expect(rows).toBe(0);
    expect(bad).toBe(1);
  });

  it("rejects a header that is not book_snapshot_5", () => {
    expect(() => forEachBook5Row(enc.encode("a,b\n1,2\n"), () => {})).toThrow(/book_snapshot_5/);
  });
});

describe("sweepBook", () => {
  it("fills inside the first level at that level's price", () => {
    const r = sweepBook([100, 101, 102], [10, 10, 10], 3, 500);
    expect(r.vwap).toBeCloseTo(100, 10);
    expect(r.filledUsdt).toBe(500);
  });

  it("walks levels and weights by notional", () => {
    // 1000 from level one (100 x 10), then 500 from level two at 200.
    const r = sweepBook([100, 200], [10, 10], 2, 1500);
    const qty = 10 + 500 / 200;
    expect(r.vwap).toBeCloseTo(1500 / qty, 10);
  });

  it("reports NaN when the visible levels cannot fill", () => {
    const r = sweepBook([100, 101], [1, 1], 2, 10_000);
    expect(Number.isNaN(r.vwap)).toBe(true);
    expect(r.filledUsdt).toBeCloseTo(201, 6);
  });

  it("treats a non-positive size as no order", () => {
    expect(Number.isNaN(sweepBook([100], [1], 1, 0).vwap)).toBe(true);
  });
});

describe("marketOrderCostBps", () => {
  it("costs half the spread when the top level is deep enough", () => {
    const row = createBookRow();
    row.askPx[0] = 100.01;
    row.askAmt[0] = 100;
    row.bidPx[0] = 99.99;
    row.bidAmt[0] = 100;
    row.askLevels = 1;
    row.bidLevels = 1;
    const c = marketOrderCostBps(row, 100);
    expect(c.filled).toBe(true);
    // half spread = 0.01 / 100 = 1 bp
    expect(c.meanBps).toBeCloseTo(1, 6);
    expect(c.buyBps).toBeCloseTo(1, 6);
    expect(c.sellBps).toBeCloseTo(1, 6);
  });

  it("charges more than half the spread once the order walks", () => {
    const row = createBookRow();
    row.askPx.set([100.01, 100.11]);
    row.askAmt.set([1, 100]);
    row.bidPx.set([99.99, 99.89]);
    row.bidAmt.set([1, 100]);
    row.askLevels = 2;
    row.bidLevels = 2;
    const c = marketOrderCostBps(row, 1000);
    // 100 USDT at the touch, the other 900 ten basis points away.
    expect(c.meanBps).toBeCloseTo(10, 4);
  });

  it("is unfilled when even five levels are too thin", () => {
    const row = createBookRow();
    row.askPx.set([100.01]);
    row.askAmt.set([0.01]);
    row.bidPx.set([99.99]);
    row.bidAmt.set([0.01]);
    row.askLevels = 1;
    row.bidLevels = 1;
    const c = marketOrderCostBps(row, 1000);
    expect(c.filled).toBe(false);
    expect(Number.isNaN(c.meanBps)).toBe(true);
  });
});

describe("accumulateBook5", () => {
  it("weights by the time each book stood, not by how often it changed", () => {
    // Wide book for 1 second, tight book for 9 seconds.
    const rows = [
      bookRow(0, 99.0, 101.0, 1000, 0.01),
      bookRow(1_000, 99.99, 100.01, 1000, 0.01),
    ];
    const stats = createLiquidityStats({ sizes: [100] });
    accumulateBook5(csv(rows), stats, { endMs: BASE_MS + 10_000 });
    const s = summarizeLiquidity(stats);
    expect(s.bookSeconds).toBeCloseTo(10, 6);
    // wide spread ~200 bp for 1 s, tight ~2 bp for 9 s
    expect(s.spreadBpsMean).toBeGreaterThan(15);
    expect(s.spreadBpsMean).toBeLessThan(25);
    expect(s.spreadBpsMedian).toBeLessThan(5);
  });

  it("drops implausible gaps instead of crediting them as standing book", () => {
    const rows = [bookRow(0, 99.99, 100.01, 1000, 0.01), bookRow(600_000, 99.99, 100.01, 1000, 0.01)];
    const stats = createLiquidityStats({ sizes: [100] });
    accumulateBook5(csv(rows), stats, { maxGapMs: 60_000, endMs: BASE_MS + 600_100 });
    const s = summarizeLiquidity(stats);
    expect(s.droppedSec).toBeCloseTo(600, 1);
    expect(s.bookSeconds).toBeCloseTo(0.1, 3);
  });

  it("separates unfillable time from the cost average", () => {
    const thin = bookRow(0, 99.99, 100.01, 0.001, 0.01);
    const thick = bookRow(1_000, 99.99, 100.01, 1000, 0.01);
    const stats = createLiquidityStats({ sizes: [10_000] });
    accumulateBook5(csv([thin, thick]), stats, { endMs: BASE_MS + 2_000 });
    const s = summarizeLiquidity(stats);
    expect(s.sizes[0].unfilledFrac).toBeCloseTo(0.5, 6);
    expect(s.sizes[0].costBpsMean).toBeCloseTo(1, 4);
  });

  it("reports depth at the touch and across five levels", () => {
    const stats = createLiquidityStats({ sizes: [100] });
    accumulateBook5(csv([bookRow(0, 100, 100.1, 2, 0.1)]), stats, { endMs: BASE_MS + 1_000 });
    const s = summarizeLiquidity(stats);
    expect(s.topBidUsdt).toBeCloseTo(200, 0);
    expect(s.depthVisibleUsdt).toBeGreaterThan(900);
  });
});

describe("deep snapshots", () => {
  it("reads a twenty-five level file, which the 32-field splitter used to cut off", () => {
    const levels = 25;
    const cells = ["binance-futures", "TESTUSDT", String(BASE_MS * 1000), String(BASE_MS * 1000)];
    for (let l = 0; l < levels; l++) {
      cells.push(String(100 + l), "1", String(99 - l), "1");
    }
    const buf = enc.encode([bookSnapshotHeader(levels).join(","), cells.join(",")].join("\n") + "\n");
    const stats = createLiquidityStats({ sizes: [2000] });
    const r = accumulateBookSnapshots(buf, stats, { fileLevels: levels, endMs: BASE_MS + 1_000 });
    expect(r.bad).toBe(0);
    const s = summarizeLiquidity(stats);
    // Five levels hold under 500 USDT on the bid; twenty-five hold 2175.
    expect(s.depthVisibleUsdt).toBeCloseTo(2175, 6);
    expect(s.sizes[0].unfilledFrac).toBe(0);
  });

  it("would leave the same order unfilled with only five levels", () => {
    const stats = createLiquidityStats({ sizes: [2000] });
    accumulateBook5(csv([bookRow(0, 99, 100, 1, 1)]), stats, { endMs: BASE_MS + 1_000 });
    expect(summarizeLiquidity(stats).sizes[0].unfilledFrac).toBe(1);
  });
});

describe("mergeLiquidityStats", () => {
  it("adds a day into a running total instead of reparsing the file", () => {
    const day1 = createLiquidityStats({ sizes: [100] });
    const day2 = createLiquidityStats({ sizes: [100] });
    accumulateBook5(csv([bookRow(0, 99.99, 100.01, 1000, 0.01)]), day1, { endMs: BASE_MS + 1_000 });
    accumulateBook5(csv([bookRow(0, 99.9, 100.1, 1000, 0.01)]), day2, { endMs: BASE_MS + 3_000 });
    const total = createLiquidityStats({ sizes: [100] });
    mergeLiquidityStats(total, day1);
    mergeLiquidityStats(total, day2);
    const s = summarizeLiquidity(total);
    expect(s.bookSeconds).toBeCloseTo(4, 6);
    const a = summarizeLiquidity(day1).spreadBpsMean;
    const b = summarizeLiquidity(day2).spreadBpsMean;
    expect(s.spreadBpsMean).toBeCloseTo((a * 1 + b * 3) / 4, 6);
  });

  it("refuses stats that were built for different sizes", () => {
    const a = createLiquidityStats({ sizes: [100] });
    const b = createLiquidityStats({ sizes: [100, 200] });
    expect(() => mergeLiquidityStats(a, b)).toThrow(/incompatible/);
  });
});

describe("histQuantileBps", () => {
  it("finds the bin holding the requested mass", () => {
    const hist = new Float64Array([1, 1, 1, 1]);
    expect(histQuantileBps(hist, 0, 4, 1, 0.5)).toBeCloseTo(1.5, 6);
    expect(histQuantileBps(hist, 0, 4, 1, 0.99)).toBeCloseTo(3.5, 6);
  });

  it("is NaN on an empty histogram", () => {
    expect(Number.isNaN(histQuantileBps(new Float64Array(4), 0, 4, 1, 0.5))).toBe(true);
  });
});

describe("interpolateCostBps", () => {
  it("returns a measured point exactly", () => {
    expect(interpolateCostBps([100, 1000], [1, 3], 100)).toBeCloseTo(1, 10);
    expect(interpolateCostBps([100, 1000], [1, 3], 1000)).toBeCloseTo(3, 10);
  });

  it("is linear in log size between two points", () => {
    // sqrt(100 * 1000) sits halfway in log space.
    expect(interpolateCostBps([100, 1000], [1, 3], Math.sqrt(100_000))).toBeCloseTo(2, 8);
  });

  it("clamps instead of extrapolating outside the measured grid", () => {
    expect(interpolateCostBps([100, 1000], [1, 3], 10)).toBeCloseTo(1, 10);
    expect(interpolateCostBps([100, 1000], [1, 3], 1e6)).toBeCloseTo(3, 10);
  });

  it("is NaN with nothing to interpolate", () => {
    expect(Number.isNaN(interpolateCostBps([], [], 100))).toBe(true);
  });
});

describe("fitLot", () => {
  it("floors to the step and reports the shortfall", () => {
    // TRB: step 0.1 at 41 USDT is 4.1 USDT of granularity.
    const fit = fitLot(110, 41, { minQty: 0.1, qtyStep: 0.1, minNotionalUsdt: 5 });
    expect(fit.tradable).toBe(true);
    expect(fit.qty).toBeCloseTo(2.6, 6);
    expect(fit.notionalUsdt).toBeCloseTo(106.6, 6);
    expect(fit.error).toBeGreaterThan(0.03);
  });

  it("refuses a name whose minimum quantity is bigger than the target", () => {
    // BTC: 0.001 at 120 000 is a 120 USDT minimum ticket.
    const fit = fitLot(110, 120_000, { minQty: 0.001, qtyStep: 0.001, minNotionalUsdt: 100 });
    expect(fit.tradable).toBe(false);
    expect(fit.notionalUsdt).toBe(0);
    expect(fit.error).toBe(1);
  });

  it("refuses a name that clears the step but not MIN_NOTIONAL", () => {
    const fit = fitLot(10, 1, { minQty: 1, qtyStep: 1, minNotionalUsdt: 20 });
    expect(fit.tradable).toBe(false);
  });

  it("is exact when the step is fine relative to the target", () => {
    const fit = fitLot(110, 0.2, { minQty: 1, qtyStep: 1, minNotionalUsdt: 5 });
    expect(fit.tradable).toBe(true);
    expect(fit.error).toBeLessThan(0.005);
  });
});
