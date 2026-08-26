// Render smoke tests for the report panel and the trade list.
//
// They render to static markup (no DOM needed) and assert that the numbers the
// owner is going to read actually reach the page: the verdict, the streak
// histogram, the cost models, and one trade row per trade.

import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Candle } from "../../lib/types";
import type { PaperTrade } from "../../lib/store";
import type { BacktestResult } from "../../lib/execution/backtest/runner";
import { TesterReport } from "./TesterReport";
import { TesterTrades } from "./TesterTrades";

const HOUR = 3600;
const START = 1_699_999_200;

function candles(count: number): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: START + i * HOUR,
    open: 100 + i, high: 102 + i, low: 98 + i, close: 101 + i,
    volume: 10,
  }));
}

function makeResult(): BacktestResult {
  const bars = candles(200);
  const trades: PaperTrade[] = [
    { id: "t1", entryTs: bars[2].time * 1000, ts: bars[6].time * 1000, symbol: "BTCUSDT", side: "buy",  entryPrice: 102, exitPrice: 110, qty: 0.5, pnl: 4 },
    { id: "t2", entryTs: bars[8].time * 1000, ts: bars[11].time * 1000, symbol: "BTCUSDT", side: "sell", entryPrice: 112, exitPrice: 118, qty: 0.5, pnl: -3 },
    { id: "t3", entryTs: bars[12].time * 1000, ts: bars[15].time * 1000, symbol: "BTCUSDT", side: "buy", entryPrice: 118, exitPrice: 116, qty: 0.5, pnl: -1 },
    { id: "t4", entryTs: bars[16].time * 1000, ts: bars[20].time * 1000, symbol: "BTCUSDT", side: "buy", entryPrice: 116, exitPrice: 124, qty: 0.5, pnl: 4 },
  ];
  return {
    params: {
      symbol: "BTCUSDT",
      candles: bars,
      bot: { id: "b1", kind: "grid", symbol: "BTCUSDT", params: {}, status: "stopped" },
      initialBalance: 1000,
      feeRate: 0.0006,
      slippageCfg: {},
      costs: {},
    },
    costsApplied: ["maker/taker fees", "instrument rules"],
    funding: -0.42,
    rejected: 3,
    liquidations: 0,
    stats: {
      netProfit: 4, netProfitPct: 0.4, trades: 4, wins: 2, losses: 2, winRate: 0.5,
      profitFactor: 2, maxDrawdown: 6, maxDrawdownPct: 0.6, avgTrade: 1,
      avgWin: 4, avgLoss: -2, avgHoldSec: 4 * HOUR, sharpeDaily: 0.08,
    },
    trades,
    positions: [],
    orders: [],
    equity: bars.map((c, i) => ({ time: c.time, equity: 1000 + Math.sin(i / 7) * 8 })),
  } as unknown as BacktestResult;
}

describe("TesterReport", () => {
  const html = renderToStaticMarkup(<TesterReport result={makeResult()} durationMs={2500} />);

  it("renders every section the spec asks for", () => {
    for (const title of ["Итог", "Качество", "Серии", "Издержки", "Устойчивость", "Критерии приёмки"]) {
      expect(html).toContain(title);
    }
  });

  it("labels which Sharpe is which — the usual source of confusion", () => {
    expect(html).toContain("Sharpe, годовой");
    expect(html).toContain("Sharpe, дневной");
  });

  it("names the cost models the run actually applied", () => {
    expect(html).toContain("maker/taker fees, instrument rules");
  });

  it("draws the losing-streak distribution, not just the maximum", () => {
    expect(html).toContain("rep-streak-hist");
    expect(html).toContain("sh-bar");
  });

  it("shows a verdict and marks the trade-count gate as failed on four trades", () => {
    expect(html).toContain("НЕ ПРОШЛА");
    expect(html).toContain("FAIL");
  });
});

describe("TesterTrades", () => {
  const result = makeResult();
  const html = renderToStaticMarkup(<TesterTrades trades={result.trades} symbol="BTCUSDT" />);

  it("renders one row per trade with entry and exit times", () => {
    for (let i = 1; i <= 4; i++) expect(html).toContain(`tt-row-${i}`);
    expect(html).toContain("Вход");
    expect(html).toContain("Выход");
    expect(html).toContain("Длительность");
  });

  it("offers the win / loss filters with live counts", () => {
    expect(html).toContain("Прибыльные · 2");
    expect(html).toContain("Убыточные · 2");
  });

  it("says out loud that exit reason is not recorded yet", () => {
    expect(html).toContain("Причина выхода");
  });
});

describe("TesterTrades with nothing to show", () => {
  it("does not pretend an empty run is a result", () => {
    const html = renderToStaticMarkup(<TesterTrades trades={[]} symbol="BTCUSDT" />);
    expect(html).toContain("Сделок нет");
  });
});
