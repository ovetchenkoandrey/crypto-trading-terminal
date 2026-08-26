import { describe, it, expect } from "vitest";
import type { Candle } from "../../lib/types";
import type { PaperTrade } from "../../lib/store";
import type { BacktestResult } from "../../lib/execution/backtest/runner";
import {
  autoDisplayTf, barIndexAt, barSecOf, buildDisplayCandles, buildTradeRows, buildTradeViews,
  buildUiReport, buildUnfilledViews, displayTfOptions, filterTrades, fmtDuration, fmtSigned,
  sortTrades, tfLabelSec, DISPLAY_BAR_BUDGET,
} from "./model";

function bars(count: number, stepSec: number, startSec = 1_700_000_000): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: startSec + i * stepSec,
    open: 100 + i, high: 101 + i, low: 99 + i, close: 100.5 + i,
    volume: 1,
  }));
}

function trade(p: Partial<PaperTrade> & { id: string }): PaperTrade {
  return {
    id: p.id,
    ts: p.ts ?? 0,
    entryTs: p.entryTs ?? 0,
    symbol: p.symbol ?? "BTCUSDT",
    side: p.side ?? "buy",
    entryPrice: p.entryPrice ?? 100,
    exitPrice: p.exitPrice ?? 101,
    qty: p.qty ?? 1,
    pnl: p.pnl ?? 0,
  };
}

describe("barSecOf", () => {
  it("takes the smallest positive gap, so one hole does not inflate the bar", () => {
    const c = bars(5, 60);
    c[3].time += 3600;         // a gap in the history
    expect(barSecOf(c)).toBe(60);
  });

  it("falls back to a minute on a series too short to measure", () => {
    expect(barSecOf([])).toBe(60);
  });
});

describe("autoDisplayTf", () => {
  it("keeps the native timeframe while the series fits the budget", () => {
    expect(autoDisplayTf(60, DISPLAY_BAR_BUDGET)).toBe(60);
  });

  it("climbs the ladder until a year of minutes fits", () => {
    const yearOfMinutes = 525_600;
    const picked = autoDisplayTf(60, yearOfMinutes);
    expect(picked).toBeGreaterThan(60);
    expect(yearOfMinutes * (60 / picked)).toBeLessThanOrEqual(DISPLAY_BAR_BUDGET);
  });

  it("never offers a timeframe finer than the run itself", () => {
    const options = displayTfOptions(900);
    expect(options[0]).toEqual({ sec: 900, label: "M15" });
    expect(options.every((o) => o.sec >= 900)).toBe(true);
  });
});

describe("buildDisplayCandles", () => {
  it("passes the series through untouched at the native timeframe", () => {
    const c = bars(10, 60);
    expect(buildDisplayCandles(c, 60, 60)).toBe(c);
  });

  it("aggregates minutes into hours", () => {
    // Start on an hour boundary, otherwise 120 minutes straddle three slots.
    const c = bars(120, 60, 1_699_999_200);
    const hourly = buildDisplayCandles(c, 3600, 60);
    expect(hourly).toHaveLength(2);
    expect(hourly[0].time % 3600).toBe(0);
    expect(hourly[0].open).toBe(c[0].open);
  });
});

describe("barIndexAt", () => {
  const c = bars(10, 60);
  it("finds the bar containing a timestamp", () => {
    expect(barIndexAt(c, c[4].time + 30)).toBe(4);
    expect(barIndexAt(c, c[4].time)).toBe(4);
  });
  it("reports -1 before the series starts", () => {
    expect(barIndexAt(c, c[0].time - 1)).toBe(-1);
  });
  it("clamps to the last bar past the end", () => {
    expect(barIndexAt(c, c[9].time + 10_000)).toBe(9);
  });
});

describe("buildTradeViews", () => {
  const hourly = bars(24, 3600, 1_700_000_000);

  it("snaps entry and exit onto display bars", () => {
    const t = trade({
      id: "t1",
      entryTs: (hourly[2].time + 1234) * 1000,
      ts: (hourly[5].time + 30) * 1000,
      pnl: 5,
    });
    const [v] = buildTradeViews([t], hourly);
    expect(v.entryBarTime).toBe(hourly[2].time);
    expect(v.exitBarTime).toBe(hourly[5].time);
    expect(v.holdSec).toBeCloseTo((t.ts - t.entryTs) / 1000);
  });

  it("draws a trade with no entry stamp as a point at its exit", () => {
    const t = trade({ id: "t2", entryTs: 0, ts: hourly[3].time * 1000 });
    const [v] = buildTradeViews([t], hourly);
    expect(v.entryBarTime).toBe(v.exitBarTime);
    expect(v.holdSec).toBe(0);
  });

  it("returns nothing when there is no series to snap onto", () => {
    expect(buildTradeViews([trade({ id: "t3" })], [])).toEqual([]);
  });
});

describe("buildTradeRows", () => {
  it("keeps real trade times — rounding is a chart concern", () => {
    const t = trade({ id: "t1", entryTs: 1_700_000_123_000, ts: 1_700_003_777_000 });
    const [row] = buildTradeRows([t]);
    expect(row.entryTs).toBe(t.entryTs);
    expect(row.exitTs).toBe(t.ts);
    expect(row.index).toBe(1);
  });
});

describe("buildUnfilledViews", () => {
  it("keeps everything that never filled and drops what did", () => {
    const c = bars(10, 60);
    const orders = [
      { id: "o1", ts: c[2].time * 1000, symbol: "BTCUSDT", side: "buy" as const, type: "limit" as const, price: 99, qty: 1, status: "pending" as const },
      { id: "o2", ts: c[3].time * 1000, symbol: "BTCUSDT", side: "sell" as const, type: "limit" as const, price: 105, qty: 1, status: "filled" as const },
      { id: "o3", ts: c[4].time * 1000, symbol: "BTCUSDT", side: "buy" as const, type: "limit" as const, price: 98, qty: 1, status: "cancelled" as const },
    ];
    const views = buildUnfilledViews(orders, c);
    expect(views.map((v) => v.id)).toEqual(["o1", "o3"]);
    expect(views[0].barTime).toBe(c[2].time);
  });
});

describe("filter and sort", () => {
  const rows = buildTradeRows([
    trade({ id: "a", pnl: 10, ts: 3000, entryTs: 1000 }),
    trade({ id: "b", pnl: -4, ts: 5000, entryTs: 2000 }),
    trade({ id: "c", pnl: 0,  ts: 9000, entryTs: 3000 }),
  ]);

  it("treats a zero-P&L trade as neither a win nor a loss", () => {
    expect(filterTrades(rows, "wins").map((t) => t.id)).toEqual(["a"]);
    expect(filterTrades(rows, "losses").map((t) => t.id)).toEqual(["b"]);
    expect(filterTrades(rows, "all")).toHaveLength(3);
  });

  it("sorts both ways without mutating the input", () => {
    const asc = sortTrades(rows, "pnl", "asc").map((t) => t.id);
    const desc = sortTrades(rows, "pnl", "desc").map((t) => t.id);
    expect(asc).toEqual(["b", "c", "a"]);
    expect(desc).toEqual(["a", "c", "b"]);
    expect(rows.map((t) => t.id)).toEqual(["a", "b", "c"]);
  });
});

describe("formatting", () => {
  it("renders durations in the largest two units", () => {
    expect(fmtDuration(0)).toBe("—");
    expect(fmtDuration(90 * 60)).toBe("1ч 30м");
    expect(fmtDuration(3 * 86400 + 4 * 3600)).toBe("3д 4ч");
  });

  it("always shows the sign", () => {
    expect(fmtSigned(12.3)).toBe("+12.30");
    expect(fmtSigned(-0.5)).toBe("−0.50");
  });

  it("labels timeframes by seconds", () => {
    expect(tfLabelSec(900)).toBe("M15");
    expect(tfLabelSec(3600)).toBe("H1");
    expect(tfLabelSec(7200)).toBe("H2");
  });
});

describe("buildUiReport", () => {
  it("routes UI numbers through the same builder the CLI prints", () => {
    const candles = bars(120, 3600);
    const trades = [
      trade({ id: "t1", pnl: 30, entryTs: candles[1].time * 1000, ts: candles[3].time * 1000 }),
      trade({ id: "t2", pnl: -10, entryTs: candles[4].time * 1000, ts: candles[6].time * 1000 }),
    ];
    const result = {
      params: {
        symbol: "BTCUSDT",
        candles,
        bot: { id: "b1", kind: "grid", symbol: "BTCUSDT", params: {}, status: "stopped" },
        initialBalance: 1000,
        feeRate: 0.0006,
        slippageCfg: {},
        costs: {},
      },
      costsApplied: ["maker/taker fees"],
      funding: -1.25,
      rejected: 2,
      liquidations: 0,
      stats: {
        netProfit: 20, netProfitPct: 2, trades: 2, wins: 1, losses: 1, winRate: 0.5,
        profitFactor: 3, maxDrawdown: 10, maxDrawdownPct: 1, avgTrade: 10,
        avgWin: 30, avgLoss: -10, avgHoldSec: 7200, sharpeDaily: 0.1,
      },
      trades,
      positions: [],
      orders: [],
      equity: candles.map((c, i) => ({ time: c.time, equity: 1000 + i })),
    } as unknown as BacktestResult;

    const report = buildUiReport(result, 1234);
    expect(report.stats.sharpeAnnual).toBeCloseTo(0.1 * Math.sqrt(365), 6);
    expect(report.streaks.maxLossStreak).toBe(1);
    expect(report.execution.rejectedOrders).toBe(2);
    expect(report.costs.applied).toEqual(["maker/taker fees"]);
    expect(report.run.bars).toBe(candles.length);
    expect(report.criteria.checks.some((c) => c.key === "profitFactor")).toBe(true);
    // Two trades is far below the acceptance threshold — the gate must say so.
    expect(report.criteria.passed).toBe(false);
    expect(report.criteria.failed).toContain("trades");
  });
});
