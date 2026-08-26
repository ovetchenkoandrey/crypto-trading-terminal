import { describe, it, expect } from "vitest";
import { runBacktest } from "../execution/backtest/runner";
import type { BacktestCosts } from "../execution/backtest/runner";
import { getBotFactory } from "./registry";
import {
  quantiseDown,
  trendSignal,
  realisedVol,
  percentileRank,
  parseTrendFollowParams,
  trendFollowFactory,
} from "./trendFollow";
import type { Candle } from "../types";
import type { SlippageSettings } from "../settings";

const NO_SLIP: SlippageSettings = { kind: "none", bps: 0, spreadPct: 0, impactK: 0, impactRefQty: 1 };

const SYMBOL = "TESTUSDT";
const DAY0 = Date.UTC(2024, 0, 1) / 1000;
const DAY = 86_400;

/** Daily candles from a close series; each bar's range brackets its close. */
function fromCloses(closes: number[], spread = 0.5): Candle[] {
  return closes.map((c, i) => ({
    time: DAY0 + i * DAY,
    open: i === 0 ? c : closes[i - 1],
    high: Math.max(c, i === 0 ? c : closes[i - 1]) + spread,
    low: Math.min(c, i === 0 ? c : closes[i - 1]) - spread,
    close: c,
    volume: 100,
  }));
}

const BASE: Record<string, number | string> = {
  signalMode: "ma",
  period: 5,
  allowLong: 1,
  allowShort: 0,
  sizeMode: "notional",
  targetLeverage: 1,
  maxLeverage: 2,
  minTradeFraction: 0.2,
  volFilter: "none",
  minQty: 0.001,
  qtyStep: 0.001,
};

function run(
  candles: Candle[],
  params: Record<string, number | string> = {},
  costs: BacktestCosts = {},
) {
  return runBacktest({
    symbol: SYMBOL,
    candles,
    bot: { id: "trend-test", kind: "trend-follow", symbol: SYMBOL, params: { ...BASE, ...params }, status: "stopped" },
    initialBalance: 1000,
    feeRate: 0,
    slippageCfg: NO_SLIP,
    costs,
  });
}

describe("quantiseDown", () => {
  it("rounds down to the step and never up", () => {
    expect(quantiseDown(3.3337, 0.001)).toBe(3.333);
    expect(quantiseDown(0.0009, 0.001)).toBe(0);
    expect(quantiseDown(-1, 0.001)).toBe(0);
  });
});

describe("trendSignal", () => {
  const rising = fromCloses([100, 101, 102, 103, 104, 105]);
  const falling = fromCloses([105, 104, 103, 102, 101, 100]);

  it("ma: compares the last close with the average of the last `period` closes", () => {
    expect(trendSignal(rising, "ma", 5, 0)).toBe(1);
    expect(trendSignal(falling, "ma", 5, 0)).toBe(-1);
  });

  it("mom: takes the sign of the return over `period` bars", () => {
    expect(trendSignal(rising, "mom", 5, 0)).toBe(1);
    expect(trendSignal(falling, "mom", 5, 0)).toBe(-1);
  });

  it("returns null while the window is short of `period`", () => {
    expect(trendSignal(rising.slice(0, 3), "ma", 5, 0)).toBeNull();
    expect(trendSignal(rising.slice(0, 5), "mom", 5, 0)).toBeNull();
    expect(trendSignal(rising.slice(0, 5), "donchian", 5, 0)).toBeNull();
  });

  it("donchian: flips on a break and holds the previous direction inside the channel", () => {
    const chop = fromCloses([100, 101, 99, 100.5, 99.5, 100]);
    expect(trendSignal(chop, "donchian", 5, 1)).toBe(1);
    expect(trendSignal(chop, "donchian", 5, -1)).toBe(-1);

    const breakUp = fromCloses([100, 101, 99, 100.5, 99.5, 120]);
    expect(trendSignal(breakUp, "donchian", 5, -1)).toBe(1);

    const breakDown = fromCloses([100, 101, 99, 100.5, 99.5, 80]);
    expect(trendSignal(breakDown, "donchian", 5, 1)).toBe(-1);
  });

  it("donchian builds the channel from bars before the current one, never including it", () => {
    // The last bar is the highest of the window; if it were part of the channel
    // it could never break out of it.
    const bars = fromCloses([100, 100, 100, 100, 100, 101]);
    expect(trendSignal(bars, "donchian", 5, 0)).toBe(1);
  });
});

describe("realisedVol / percentileRank", () => {
  it("annualises the standard deviation of log returns", () => {
    const flat = fromCloses([100, 100, 100, 100, 100, 100]);
    expect(realisedVol(flat, 5, DAY)).toBeNull();

    const wiggle = fromCloses([100, 101, 100, 101, 100, 101]);
    const v = realisedVol(wiggle, 5, DAY);
    expect(v).not.toBeNull();
    expect(v as number).toBeGreaterThan(0);
    // The same series on 4h bars scales up by sqrt(6).
    const v4 = realisedVol(wiggle, 5, DAY / 6) as number;
    expect(v4 / (v as number)).toBeCloseTo(Math.sqrt(6), 6);
  });

  it("returns null before the ranking window is full", () => {
    expect(percentileRank([1, 2, 3], 2, 5)).toBeNull();
    expect(percentileRank([1, 2, 3, 4, 5], 3, 5)).toBeCloseTo(0.4, 10);
    expect(percentileRank([1, 2, 3, 4, 5], 9, 5)).toBe(1);
  });
});

describe("params", () => {
  it("is registered under trend-follow", () => {
    expect(getBotFactory("trend-follow")).toBe(trendFollowFactory);
  });

  it("parses the factory defaults into the documented values", () => {
    const p = parseTrendFollowParams(trendFollowFactory.defaultParams);
    expect(p.signalMode).toBe("ma");
    expect(p.period).toBe(100);
    expect(p.allowLong).toBe(true);
    expect(p.allowShort).toBe(false);
    expect(p.sizeMode).toBe("notional");
    expect(p.volFilter).toBe("none");
  });

  it("falls back to defaults on junk and clamps out-of-range values", () => {
    const p = parseTrendFollowParams({ signalMode: "???", sizeMode: "", volFilter: "x", period: 0, minTradeFraction: 5 });
    expect(p.signalMode).toBe("ma");
    expect(p.sizeMode).toBe("notional");
    expect(p.volFilter).toBe("none");
    expect(p.period).toBe(2);
    expect(p.minTradeFraction).toBe(1);
  });
});

describe("trend follow — position management", () => {
  it("goes long once price clears the average and holds without churning", async () => {
    const closes = [100, 100, 100, 100, 100, ...Array.from({ length: 10 }, (_, i) => 101 + i)];
    const result = await run(fromCloses(closes));
    const pos = result.positions.find((p) => p.symbol === SYMBOL);
    expect(pos).toBeDefined();
    expect(pos?.side).toBe("buy");
    // One entry plus at most a couple of size top-ups as equity grows — not one
    // order per bar.
    expect(result.orders.filter((o) => o.status === "filled").length).toBeLessThanOrEqual(3);
  });

  it("flattens when the trend turns and stays flat while shorts are disabled", async () => {
    const closes = [100, 101, 102, 103, 104, 105, 106, 107, 100, 95, 90, 85, 80, 75, 70];
    const result = await run(fromCloses(closes));
    expect(result.positions.filter((p) => p.qty > 0)).toHaveLength(0);
    expect(result.stats.trades).toBeGreaterThan(0);
  });

  it("reverses into a short when allowShort is on", async () => {
    const closes = [100, 101, 102, 103, 104, 105, 106, 107, 100, 95, 90, 85, 80, 75, 70];
    const result = await run(fromCloses(closes), { allowShort: 1 });
    const pos = result.positions.find((p) => p.symbol === SYMBOL && p.qty > 0);
    expect(pos?.side).toBe("sell");
  });

  it("never trades before the signal window is full", async () => {
    const closes = [100, 101, 102, 103];   // fewer bars than period = 5
    const result = await run(fromCloses(closes));
    expect(result.orders).toHaveLength(0);
    expect(result.stats.trades).toBe(0);
  });

  it("does not act on the bar that produced the signal — the fill is the next open", async () => {
    const closes = [100, 100, 100, 100, 100, 130, 130, 130];
    const result = await run(fromCloses(closes));
    const first = result.orders.find((o) => o.status === "filled");
    expect(first).toBeDefined();
    // Bar 5 (close 130) is the signal; bar 6 opens at bar 5's close of 130.
    expect(first?.filledPrice).toBe(130);
  });

  it("caps notional by maxLeverage", async () => {
    const closes = [100, 100, 100, 100, 100, 110, 111, 112];
    const result = await run(fromCloses(closes), { targetLeverage: 10, maxLeverage: 2 });
    const first = result.orders.find((o) => o.status === "filled");
    expect(first).toBeDefined();
    const notional = (first as { qty: number }).qty * (first as { filledPrice?: number }).filledPrice!;
    expect(notional).toBeLessThanOrEqual(1000 * 2);
    expect(notional).toBeGreaterThan(1000 * 1.9);
  });

  it("a flat average leaves no direction and the bot stands aside", async () => {
    const closes = [100, 100, 100, 100, 100, 100, 100, 100];
    const result = await run(fromCloses(closes));
    expect(result.orders).toHaveLength(0);
  });

  it("skipHigh keeps the bot flat in the top volatility regime", async () => {
    // Calm ramp first, then a violent one: the ranking window sees the calm
    // stretch, so the violent bars land in the top percentile and are skipped.
    const calm = Array.from({ length: 40 }, (_, i) => 100 + i * 0.1);
    const wild = Array.from({ length: 10 }, (_, i) => 104 * (1 + 0.2 * (i + 1)));
    const filtered = await run(fromCloses([...calm, ...wild]), {
      period: 5, volPeriod: 5, volFilter: "skipHigh", volFilterPct: 0.9, volRankWindow: 20,
    });
    const plain = await run(fromCloses([...calm, ...wild]), { period: 5, volPeriod: 5 });
    expect(plain.stats.netProfit).toBeGreaterThan(filtered.stats.netProfit);
  });

  it("an ATR stop, when enabled, closes the position on a gap against it", async () => {
    const closes = [100, 100, 100, 100, 100, 110, 111, 112, 60, 60];
    const withStop = await run(fromCloses(closes), { stopAtrMult: 1, atrPeriod: 3 });
    const noStop = await run(fromCloses(closes), { stopAtrMult: 0 });
    expect(withStop.stats.netProfit).toBeGreaterThan(noStop.stats.netProfit);
  });
});
