import { describe, it, expect } from "vitest";
import { computeStats } from "./stats";
import type { PaperTrade } from "../../store";
import type { EquitySample } from "./stats";

const trade = (pnl: number, ts = 0, entryTs = ts): PaperTrade => ({
  id: String(ts) + "-" + pnl, ts, entryTs, symbol: "BTCUSDT", side: "buy",
  entryPrice: 100, exitPrice: 100 + pnl, qty: 1, pnl,
});

describe("computeStats", () => {
  it("computes net profit from final equity sample", () => {
    const equity: EquitySample[] = [
      { time: 0,    equity: 1000 },
      { time: 86400, equity: 1100 },
      { time: 172800, equity: 1080 },
    ];
    const stats = computeStats(1000, [trade(80, 100000)], equity);
    expect(stats.netProfit).toBe(80);
    expect(stats.netProfitPct).toBeCloseTo(8, 5);
  });

  it("max drawdown captures peak-to-trough drop", () => {
    const equity: EquitySample[] = [
      { time: 0,     equity: 1000 },
      { time: 1000,  equity: 1200 },   // peak
      { time: 2000,  equity: 1100 },   // dd = 100
      { time: 3000,  equity: 900  },   // dd = 300
      { time: 4000,  equity: 1050 },
    ];
    const s = computeStats(1000, [], equity);
    expect(s.maxDrawdown).toBe(300);
    expect(s.maxDrawdownPct).toBeCloseTo(25, 5);
  });

  it("win rate and profit factor", () => {
    const trades = [trade(50), trade(30), trade(-20), trade(-10)];
    const equity: EquitySample[] = [
      { time: 0, equity: 1000 }, { time: 100, equity: 1050 },
    ];
    const s = computeStats(1000, trades, equity);
    expect(s.wins).toBe(2);
    expect(s.losses).toBe(2);
    expect(s.winRate).toBeCloseTo(0.5);
    // sum wins 80 / abs(sum losses) 30 → 2.666...
    expect(s.profitFactor).toBeCloseTo(80 / 30, 5);
  });

  it("profit factor handles all-wins (Infinity) and no trades (0)", () => {
    const eq: EquitySample[] = [{ time: 0, equity: 1000 }];
    const allWins = computeStats(1000, [trade(10), trade(20)], eq);
    expect(allWins.profitFactor).toBe(Infinity);
    const none = computeStats(1000, [], eq);
    expect(none.profitFactor).toBe(0);
  });

  it("avg trade is sum / count", () => {
    const eq: EquitySample[] = [{ time: 0, equity: 1000 }];
    const s = computeStats(1000, [trade(10), trade(20), trade(-15)], eq);
    expect(s.avgTrade).toBeCloseTo((10 + 20 - 15) / 3, 5);
    expect(s.avgWin).toBeCloseTo(15);
    expect(s.avgLoss).toBeCloseTo(-15);
  });
});

describe("max drawdown percentage", () => {
  it("reports the deepest percentage, not the percentage of the deepest amount", () => {
    // Early: 1000 -> 750 is 250 USDT but 25%.
    // Later: 2000 -> 1690 is 310 USDT yet only 15.5%.
    // Tracking one maximum reports 15.5% and lets a 25% drawdown pass the gate.
    const equity = [
      { time: 0, equity: 1000 },
      { time: 1, equity:  750 },
      { time: 2, equity: 2000 },
      { time: 3, equity: 1690 },
    ];

    const stats = computeStats(1000, [], equity);

    expect(stats.maxDrawdown).toBeCloseTo(310, 9);
    expect(stats.maxDrawdownPct).toBeCloseTo(25, 9);
  });

  it("keeps both maxima on a single drawdown", () => {
    const equity = [
      { time: 0, equity: 1000 },
      { time: 1, equity:  800 },
      { time: 2, equity: 1000 },
    ];

    const stats = computeStats(1000, [], equity);

    expect(stats.maxDrawdown).toBeCloseTo(200, 9);
    expect(stats.maxDrawdownPct).toBeCloseTo(20, 9);
  });
});

describe("average hold time", () => {
  it("averages the span between entry and exit", () => {
    const trades = [
      trade(10, 120_000, 60_000),    // 60s
      trade(-5, 300_000, 180_000),   // 120s
    ];

    expect(computeStats(1000, trades, []).avgHoldSec).toBeCloseTo(90, 9);
  });

  it("skips trades without an entry stamp rather than counting them as instant", () => {
    // Zero means "not recorded" — a real trade never opens at the epoch.
    const withStamp = trade(10, 120_000, 60_000);
    const without = { ...trade(5, 120_000), entryTs: 0 };

    expect(computeStats(1000, [withStamp, without], []).avgHoldSec).toBeCloseTo(60, 9);
  });

  it("is zero with no trades", () => {
    expect(computeStats(1000, [], []).avgHoldSec).toBe(0);
  });
});
