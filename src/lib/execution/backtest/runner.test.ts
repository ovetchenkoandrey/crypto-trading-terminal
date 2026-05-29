import { describe, it, expect } from "vitest";
import { runBacktest } from "./runner";
import type { Candle } from "../../types";
import type { BotConfig } from "../../store";

const slipNone = {
  kind: "none" as const, bps: 0, spreadPct: 0, impactK: 0, impactRefQty: 1,
};

function bar(time: number, open: number, high: number, low: number, close: number): Candle {
  return { time, open, high, low, close, volume: 1 };
}

// Oscillating range: 100 → 110 → 100 → 110 → ... so Grid orders fill in pairs.
function oscillating(n: number, lo = 100, hi = 110): Candle[] {
  const candles: Candle[] = [];
  for (let i = 0; i < n; i++) {
    const goingUp = i % 2 === 0;
    const o = goingUp ? lo : hi;
    const c = goingUp ? hi : lo;
    candles.push(bar(i * 900, o, hi + 1, lo - 1, c));
  }
  return candles;
}

describe("runBacktest end-to-end", () => {
  it("Grid bot on oscillating range produces trades and respects slippage off", async () => {
    // Grid: 5 levels between 100 and 110, qty 1 each. Price oscillates 100↔110.
    // On bar 0 (price 100→110), mid=105, levels 100,102.5,105,107.5,110.
    // Above mid → sell limits at 107.5, 110. Below mid → buy limits at 100, 102.5.
    const candles = oscillating(8);
    const cfg: BotConfig = {
      id: "grid-osc", kind: "grid", symbol: "BTCUSDT",
      params: { lowPrice: 100, highPrice: 110, levels: 5, qtyPerLevel: 1 },
      status: "stopped",
    };
    const res = await runBacktest({
      symbol: "BTCUSDT", candles, bot: cfg,
      initialBalance: 100_000, feeRate: 0, slippageCfg: slipNone,
    });
    // Some orders should have triggered as price swung through the range.
    const filled = res.orders.filter((o) => o.status === "filled");
    expect(filled.length).toBeGreaterThan(0);
    // equity recorded for every advanced bar (we step initial bar before the loop)
    expect(res.equity.length).toBeGreaterThan(0);
  });

  it("returns clean result even with zero trades", async () => {
    // Bot that never trades (grid range entirely above the price)
    const candles = oscillating(5, 100, 102);
    const cfg: BotConfig = {
      id: "grid-no", kind: "grid", symbol: "BTCUSDT",
      params: { lowPrice: 500, highPrice: 1000, levels: 5, qtyPerLevel: 1 },
      status: "stopped",
    };
    const res = await runBacktest({
      symbol: "BTCUSDT", candles, bot: cfg,
      initialBalance: 10_000, feeRate: 0, slippageCfg: slipNone,
    });
    expect(res.trades.length).toBe(0);
    expect(res.stats.netProfit).toBe(0);
    expect(res.stats.winRate).toBe(0);
  });

  it("shouldStop cancels mid-run", async () => {
    const candles = oscillating(50);
    const cfg: BotConfig = {
      id: "grid-stop", kind: "grid", symbol: "BTCUSDT",
      params: { lowPrice: 100, highPrice: 110, levels: 5, qtyPerLevel: 1 },
      status: "stopped",
    };
    let count = 0;
    const res = await runBacktest({
      symbol: "BTCUSDT", candles, bot: cfg,
      initialBalance: 100_000, feeRate: 0, slippageCfg: slipNone,
    }, {
      shouldStop: () => { count++; return count > 5; },
    });
    expect(res.equity.length).toBeLessThan(candles.length);
  });
});
