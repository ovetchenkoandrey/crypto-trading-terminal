import { describe, it, expect, afterEach } from "vitest";
import { runBacktest } from "../execution/backtest/runner";
import type { BacktestCosts } from "../execution/backtest/runner";
import { getBotFactory } from "./registry";
import {
  clearFundingHistory,
  extremeStreak,
  fundingExtremeFactory,
  getFundingHistory,
  parseFundingExtremeParams,
  quantiseDown,
  setFundingHistory,
  sideForRate,
  type FundingPoint,
} from "./fundingExtreme";
import type { Candle } from "../types";
import type { SlippageSettings } from "../settings";

const NO_SLIP: SlippageSettings = { kind: "none", bps: 0, spreadPct: 0, impactK: 0, impactRefQty: 1 };

const SYMBOL = "TESTUSDT";
const DAY0 = Date.UTC(2024, 0, 1) / 1000;
const HOUR = 3600;

/** Hourly candles; bar i sits at hour i of 2024-01-01 UTC. */
function series(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    time: DAY0 + i * HOUR,
    open: c,
    high: c,
    low: c,
    close: c,
    volume: 100,
  }));
}

const flatPrices = (n: number, p = 100): number[] => Array.from({ length: n }, () => p);

const BASE: Record<string, number | string> = {
  thresholdBps: 20,
  direction: "contrarian",
  requireStreak: 1,
  holdSettlements: 3,
  sizeMode: "notional",
  notionalPct: 50,
  maxLeverage: 3,
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
    bot: { id: "funding-extreme-test", kind: "funding-extreme", symbol: SYMBOL, params: { ...BASE, ...params }, status: "stopped" },
    initialBalance: 1000,
    feeRate: 0,
    slippageCfg: NO_SLIP,
    costs,
  });
}

/** Settlements on the eight-hour grid starting at hour `startHour`. */
function grid(rates: number[], startHour = 8, stepHours = 8): FundingPoint[] {
  return rates.map((rate, i) => ({ time: DAY0 + (startHour + i * stepHours) * HOUR, rate }));
}

afterEach(() => clearFundingHistory());

describe("funding history registry", () => {
  it("sorts, normalises and is case insensitive on the symbol", () => {
    setFundingHistory("testusdt", [
      { time: DAY0 + 100, rate: 0.001 },
      { time: DAY0, rate: 0.002 },
      { time: Number.NaN, rate: 0.003 },
    ]);
    const got = getFundingHistory("TESTUSDT");
    expect(got.map((e) => e.time)).toEqual([DAY0, DAY0 + 100]);
  });

  it("returns an empty list for an unknown symbol", () => {
    expect(getFundingHistory("NOPEUSDT")).toEqual([]);
  });
});

describe("sideForRate", () => {
  it("fades the crowd when contrarian", () => {
    expect(sideForRate(0.003, "contrarian")).toBe("sell");
    expect(sideForRate(-0.003, "contrarian")).toBe("buy");
  });

  it("joins the crowd when momentum", () => {
    expect(sideForRate(0.003, "momentum")).toBe("buy");
    expect(sideForRate(-0.003, "momentum")).toBe("sell");
  });

  it("has no opinion on a zero or broken rate", () => {
    expect(sideForRate(0, "contrarian")).toBeNull();
    expect(sideForRate(Number.NaN, "contrarian")).toBeNull();
  });
});

describe("extremeStreak", () => {
  const events = grid([0.003, 0.004, 0.005, -0.0005, -0.004]);

  it("counts the run of same-signed extremes ending at the index", () => {
    expect(extremeStreak(events, 0, 20)).toBe(1);
    expect(extremeStreak(events, 1, 20)).toBe(2);
    expect(extremeStreak(events, 2, 20)).toBe(3);
  });

  it("breaks the run on a sign change", () => {
    expect(extremeStreak(events, 4, 20)).toBe(1);
  });

  it("is zero when the settlement itself is not extreme", () => {
    expect(extremeStreak(events, 3, 20)).toBe(0);
    expect(extremeStreak(events, -1, 20)).toBe(0);
    expect(extremeStreak(events, 99, 20)).toBe(0);
  });
});

describe("quantiseDown", () => {
  it("rounds down to the step and never up", () => {
    expect(quantiseDown(3.3337, 0.001)).toBe(3.333);
    expect(quantiseDown(0.0009, 0.001)).toBe(0);
    expect(quantiseDown(1.5, 0)).toBe(1.5);
    expect(quantiseDown(-1, 0.001)).toBe(0);
  });
});

describe("params", () => {
  it("is registered under funding-extreme", () => {
    expect(getBotFactory("funding-extreme")).toBe(fundingExtremeFactory);
  });

  it("parses the factory defaults into the documented values", () => {
    const p = parseFundingExtremeParams(fundingExtremeFactory.defaultParams);
    expect(p.thresholdBps).toBe(20);
    expect(p.direction).toBe("contrarian");
    expect(p.requireStreak).toBe(1);
    expect(p.holdSettlements).toBe(3);
    expect(p.sizeMode).toBe("notional");
    expect(p.allowLong).toBe(true);
    expect(p.allowShort).toBe(true);
  });

  it("falls back to defaults on junk and clamps the ranges", () => {
    const p = parseFundingExtremeParams({ direction: "???", sizeMode: "", holdSettlements: 0, requireStreak: -5, thresholdBps: -1 });
    expect(p.direction).toBe("contrarian");
    expect(p.sizeMode).toBe("notional");
    expect(p.holdSettlements).toBe(1);
    expect(p.requireStreak).toBe(1);
    expect(p.thresholdBps).toBe(0);
  });

  it("reads booleans from 0/1 and from words", () => {
    expect(parseFundingExtremeParams({ allowLong: 0 }).allowLong).toBe(false);
    expect(parseFundingExtremeParams({ allowShort: "false" }).allowShort).toBe(false);
    expect(parseFundingExtremeParams({ allowShort: "true" }).allowShort).toBe(true);
  });
});

describe("funding extreme — entry", () => {
  it("does nothing at all without a funding history", async () => {
    const result = await run(series(flatPrices(30)));
    expect(result.trades).toHaveLength(0);
    expect(result.positions).toHaveLength(0);
  });

  it("shorts after a large positive settlement and fills at the next bar open", async () => {
    setFundingHistory(SYMBOL, grid([0.003]));
    // Settlement lands on the 08:00 bar; the market order fills at 09:00.
    const prices = flatPrices(40);
    prices[9] = 111;
    const result = await run(series(prices));

    expect(result.trades.length + result.positions.length).toBeGreaterThan(0);
    const side = result.trades[0]?.side ?? result.positions[0]?.side;
    expect(side).toBe("sell");
    const entry = result.trades[0]?.entryPrice ?? result.positions[0]?.entryPrice;
    expect(entry).toBe(111);
  });

  it("buys after a large negative settlement", async () => {
    setFundingHistory(SYMBOL, grid([-0.003]));
    const result = await run(series(flatPrices(40)));
    const side = result.trades[0]?.side ?? result.positions[0]?.side;
    expect(side).toBe("buy");
  });

  it("takes the momentum side when asked", async () => {
    setFundingHistory(SYMBOL, grid([0.003]));
    const result = await run(series(flatPrices(40)), { direction: "momentum" });
    const side = result.trades[0]?.side ?? result.positions[0]?.side;
    expect(side).toBe("buy");
  });

  it("ignores settlements below the threshold", async () => {
    setFundingHistory(SYMBOL, grid([0.0005, 0.0010, 0.0015]));
    const result = await run(series(flatPrices(40)), { thresholdBps: 20 });
    expect(result.trades).toHaveLength(0);
    expect(result.positions).toHaveLength(0);
  });

  it("respects a one-sided permission", async () => {
    setFundingHistory(SYMBOL, grid([0.003]));
    const result = await run(series(flatPrices(40)), { allowShort: 0 });
    expect(result.trades).toHaveLength(0);
    expect(result.positions).toHaveLength(0);
  });

  it("waits for the required streak of extremes", async () => {
    setFundingHistory(SYMBOL, grid([0.003, 0.004, 0.005]));
    const single = await run(series(flatPrices(60)), { requireStreak: 1, holdSettlements: 1 });
    const triple = await run(series(flatPrices(60)), { requireStreak: 3, holdSettlements: 1 });
    const firstEntryTime = (r: Awaited<ReturnType<typeof run>>) =>
      r.trades[0]?.entryTs ?? r.positions[0]?.openedTs ?? 0;
    expect(firstEntryTime(single)).toBeLessThan(firstEntryTime(triple));
  });

  it("skips a settlement past the maxRateBps cap", async () => {
    setFundingHistory(SYMBOL, grid([0.025]));
    const result = await run(series(flatPrices(40)), { maxRateBps: 100 });
    expect(result.trades).toHaveLength(0);
    expect(result.positions).toHaveLength(0);
  });

  it("does not open a second position while one is running", async () => {
    setFundingHistory(SYMBOL, grid([0.003, 0.004, 0.005, 0.006]));
    const result = await run(series(flatPrices(60)), { holdSettlements: 4 });
    expect(result.trades.length + result.positions.length).toBe(1);
  });
});

describe("funding extreme — exit", () => {
  it("flattens after the configured number of settlements", async () => {
    setFundingHistory(SYMBOL, grid([0.003, 0.0001, 0.0001, 0.0001, 0.0001]));
    const result = await run(series(flatPrices(60)), { holdSettlements: 2 });

    expect(result.trades).toHaveLength(1);
    // Entry decided on the 08:00 settlement; two more settlements land at 16:00
    // and 24:00, and the exit is placed on the bar that carries the second.
    expect(result.trades[0].ts).toBe((DAY0 + 25 * HOUR) * 1000);
    expect(result.positions).toHaveLength(0);
  });

  it("counts settlements, not hours, when the grid is broken", async () => {
    // A two-hour grid, as SOLUSDT ran during the FTX week. Holding "three
    // settlements" must mean six hours here, not twenty-four.
    setFundingHistory(SYMBOL, grid([0.003, 0.0001, 0.0001, 0.0001], 8, 2));
    const result = await run(series(flatPrices(40)), { holdSettlements: 3 });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].ts).toBe((DAY0 + 15 * HOUR) * 1000);
  });

  it("honours the hard bar cap", async () => {
    setFundingHistory(SYMBOL, grid([0.003, 0.0001, 0.0001, 0.0001, 0.0001]));
    const result = await run(series(flatPrices(60)), { holdSettlements: 5, maxBarsInTrade: 4 });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].ts).toBeLessThan((DAY0 + 20 * HOUR) * 1000);
  });

  it("takes the protective stop", async () => {
    setFundingHistory(SYMBOL, grid([0.003]));
    const prices = flatPrices(40);
    for (let i = 12; i < prices.length; i++) prices[i] = 130;   // a short gets run over
    const result = await run(series(prices), { holdSettlements: 10, stopPct: 5 });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].pnl).toBeLessThan(0);
    expect(result.positions).toHaveLength(0);
  });

  it("takes the profit target", async () => {
    setFundingHistory(SYMBOL, grid([0.003]));
    const prices = flatPrices(40);
    for (let i = 12; i < prices.length; i++) prices[i] = 80;    // the short works
    const result = await run(series(prices), { holdSettlements: 10, targetPct: 5 });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].pnl).toBeGreaterThan(0);
  });
});

describe("funding extreme — no look-ahead", () => {
  it("never acts on a settlement before the bar that carries it", async () => {
    setFundingHistory(SYMBOL, grid([0.003], 20));
    const prices = flatPrices(40);
    // Everything before the settlement is one price, everything after another.
    for (let i = 0; i < 21; i++) prices[i] = 100;
    for (let i = 21; i < prices.length; i++) prices[i] = 200;
    const result = await run(series(prices), { holdSettlements: 1 });

    const entryTs = result.trades[0]?.entryTs ?? result.positions[0]?.openedTs ?? 0;
    const entryPrice = result.trades[0]?.entryPrice ?? result.positions[0]?.entryPrice ?? 0;
    // The settlement is at hour 20, so the earliest possible fill is hour 21.
    expect(entryTs).toBe((DAY0 + 21 * HOUR) * 1000);
    expect(entryPrice).toBe(200);
  });

  it("does not react to a settlement that falls after the last bar", async () => {
    setFundingHistory(SYMBOL, grid([0.003], 100));
    const result = await run(series(flatPrices(40)));
    expect(result.trades).toHaveLength(0);
    expect(result.positions).toHaveLength(0);
  });
});

describe("funding extreme — sizing", () => {
  /** A single settlement leaves the position open to the last bar; either shape carries the size. */
  const qtyOf = (r: Awaited<ReturnType<typeof run>>): number =>
    r.trades[0]?.qty ?? r.positions[0]?.qty ?? 0;

  it("scales the notional with notionalPct", async () => {
    setFundingHistory(SYMBOL, grid([0.003]));
    const small = await run(series(flatPrices(40)), { notionalPct: 10, holdSettlements: 1 });
    const large = await run(series(flatPrices(40)), { notionalPct: 100, holdSettlements: 1 });
    expect(qtyOf(large)).toBeGreaterThan(qtyOf(small) * 5);
  });

  it("caps the notional at maxLeverage", async () => {
    setFundingHistory(SYMBOL, grid([0.003]));
    const result = await run(series(flatPrices(40)), { notionalPct: 900, maxLeverage: 2, holdSettlements: 1 });
    expect(qtyOf(result) * 100).toBeLessThanOrEqual(1000 * 2 + 1e-6);
  });

  it("sizes from the stop distance in risk mode", async () => {
    setFundingHistory(SYMBOL, grid([0.003]));
    const result = await run(series(flatPrices(40)), { sizeMode: "risk", riskPct: 1, stopPct: 5, holdSettlements: 1 });
    // 1% of 1000 = 10 USDT of risk over a 5 USDT stop distance = 2 units.
    expect(qtyOf(result)).toBeCloseTo(2, 3);
  });

  it("refuses to trade in risk mode without a stop", async () => {
    setFundingHistory(SYMBOL, grid([0.003]));
    const result = await run(series(flatPrices(40)), { sizeMode: "risk", stopPct: 0 });
    expect(result.trades).toHaveLength(0);
    expect(result.positions).toHaveLength(0);
  });

  it("skips the trade when the size rounds below the instrument minimum", async () => {
    setFundingHistory(SYMBOL, grid([0.003]));
    const result = await run(series(flatPrices(40)), { notionalPct: 0.001, minQty: 1, qtyStep: 1 });
    expect(result.trades).toHaveLength(0);
    expect(result.positions).toHaveLength(0);
  });
});
