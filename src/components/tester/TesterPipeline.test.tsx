// End-to-end check of the visual tester pipeline: a real engine run goes in,
// chart geometry and a rendered report come out.
//
// This is the test that would have caught the bug the whole feature is built
// around — a trade without `entryTs` has no left end and cannot be drawn.

import { describe, it, expect, beforeAll } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Candle } from "../../lib/types";
import type { BotConfig } from "../../lib/store";
import { runBacktest, type BacktestResult } from "../../lib/execution/backtest/runner";
import {
  barSecOf, buildDisplayCandles, buildTradeViews, buildUiReport, buildUnfilledViews,
} from "./model";
import { TesterReport } from "./TesterReport";
import { TesterTrades } from "./TesterTrades";

const HOUR = 3600;
const START = 1_699_999_200;

/** A price that swings through the whole grid many times, so orders fill. */
function oscillating(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => {
    const mid = 70_000 + Math.sin(i / 9) * 8_000;
    return {
      time: START + i * HOUR,
      open: mid,
      high: mid + 400,
      low: mid - 400,
      close: mid + Math.cos(i / 4) * 120,
      volume: 5,
    };
  });
}

const bot: BotConfig = {
  id: "bot-grid",
  kind: "grid",
  symbol: "BTCUSDT",
  status: "stopped",
  params: { lowPrice: 63_000, highPrice: 77_000, levels: 10, qtyPerLevel: 0.01 },
};

describe("visual tester pipeline", () => {
  let result: BacktestResult;
  const candles = oscillating(600);

  beforeAll(async () => {
    result = await runBacktest({
      symbol: "BTCUSDT",
      candles,
      bot,
      initialBalance: 100_000,
      feeRate: 0.00055,
      slippageCfg: { model: "fixed_bps", fixedBps: 2 } as never,
      costs: {},
    });
  });

  it("produces trades that carry an entry stamp — the precondition for drawing them", () => {
    expect(result.trades.length).toBeGreaterThan(0);
    for (const t of result.trades) {
      expect(t.entryTs).toBeGreaterThan(0);
      expect(t.ts).toBeGreaterThanOrEqual(t.entryTs);
    }
  });

  it("places both ends of every segment on a real display bar", () => {
    const nativeSec = barSecOf(candles);
    expect(nativeSec).toBe(HOUR);
    const display = buildDisplayCandles(candles, nativeSec, nativeSec);
    const times = new Set(display.map((c) => c.time));
    const views = buildTradeViews(result.trades, display);
    expect(views).toHaveLength(result.trades.length);
    for (const v of views) {
      expect(times.has(v.entryBarTime)).toBe(true);
      expect(times.has(v.exitBarTime)).toBe(true);
      expect(v.exitBarTime).toBeGreaterThanOrEqual(v.entryBarTime);
    }
  });

  it("keeps the segments placeable after aggregating to a coarser timeframe", () => {
    const daily = buildDisplayCandles(candles, 86_400, HOUR);
    expect(daily.length).toBeLessThan(candles.length);
    const times = new Set(daily.map((c) => c.time));
    for (const v of buildTradeViews(result.trades, daily)) {
      expect(times.has(v.entryBarTime)).toBe(true);
      expect(times.has(v.exitBarTime)).toBe(true);
    }
  });

  it("separates unfilled orders from the ones that became trades", () => {
    const display = buildDisplayCandles(candles, HOUR, HOUR);
    const unfilled = buildUnfilledViews(result.orders, display);
    const filled = result.orders.filter((o) => o.status === "filled").length;
    expect(unfilled.length + filled).toBe(result.orders.length);
  });

  it("agrees with the report builder on the headline numbers", () => {
    const report = buildUiReport(result, 1000);
    expect(report.stats.trades).toBe(result.trades.length);
    expect(report.stats.netProfit).toBeCloseTo(result.stats.netProfit, 8);
    expect(report.execution.liquidations).toBe(result.liquidations ?? 0);
  });

  it("renders the report and the trade list from that same run", () => {
    const reportHtml = renderToStaticMarkup(<TesterReport result={result} durationMs={900} />);
    expect(reportHtml).toContain("Критерии приёмки");
    expect(reportHtml).toContain("Профит-фактор");

    const tradesHtml = renderToStaticMarkup(<TesterTrades trades={result.trades} symbol="BTCUSDT" />);
    expect(tradesHtml).toContain("tt-row-1");
    expect(tradesHtml).toContain("tt-filter-losses");
  });
});
