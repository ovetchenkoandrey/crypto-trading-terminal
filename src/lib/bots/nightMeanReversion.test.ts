import { describe, it, expect } from "vitest";
import { runBacktest } from "../execution/backtest/runner";
import type { BacktestCosts } from "../execution/backtest/runner";
import type { InstrumentRules } from "../execution/instrumentRules";
import { getBotFactory } from "./registry";
import {
  inSession,
  utcHour,
  quantiseDown,
  parseNightMrParams,
  nightMeanReversionFactory,
} from "./nightMeanReversion";
import type { Candle } from "../types";
import type { SlippageSettings } from "../settings";

const NO_SLIP: SlippageSettings = { kind: "none", bps: 0, spreadPct: 0, impactK: 0, impactRefQty: 1 };

const SYMBOL = "TESTUSDT";
const DAY0 = Date.UTC(2024, 0, 1) / 1000;   // 2024-01-01 00:00 UTC, exact hour boundary

interface Spec { o: number; h: number; l: number; c: number }

/** Hourly candles; bar i sits at `startHour + i` hours after 2024-01-01 00:00 UTC. */
function series(startHour: number, specs: Spec[]): Candle[] {
  return specs.map((s, i) => ({
    time: DAY0 + (startHour + i) * 3600,
    open: s.o, high: s.h, low: s.l, close: s.c, volume: 100,
  }));
}

const flat = (p: number): Spec => ({ o: p, h: p, l: p, c: p });

// Seven flat bars fill BB(6) and ATR(5) with zero dispersion — no signal can fire
// there, so every fixture starts from a guaranteed-idle state.
const WARMUP: Spec[] = [flat(100), flat(100), flat(100), flat(100), flat(100), flat(100), flat(100)];

// The dip bar: BB(6, 2) over [100 x5, 88] gives mid 98, sd 4.4721, lower 89.0557.
// Close 88 is below the lower band, so bar 7 is a long signal in every fixture.
const DIP: Spec = { o: 100, h: 100, l: 88, c: 88 };

/** Dips at bar 7, then snaps back over the mean at bar 8 (mid 97.667, close 98). */
const revert = (startHour = 0): Candle[] => series(startHour, [
  ...WARMUP,
  DIP,
  { o: 90, h: 99, l: 89.5, c: 98 },
  flat(99),
  flat(99),
]);

/** Dips at bar 7, then keeps falling through the 5% stop at 83.6. */
const stopout = (): Candle[] => series(0, [
  ...WARMUP,
  DIP,
  { o: 90, h: 90, l: 80, c: 81 },
  flat(81),
  flat(81),
]);

/**
 * Starts at 20:00 so the dip lands on 03:00 UTC. Price never returns to the mean,
 * so the only way out is the end-of-session flatten.
 */
const held = (): Candle[] => series(20, [
  ...WARMUP,
  DIP,
  { o: 90, h: 90.5, l: 89.5, c: 90 },
  { o: 90, h: 90.5, l: 89.5, c: 90 },
  flat(91),
  flat(91),
]);

/** Second, deeper band break at bar 11 while the first position is still open. */
const secondDip = (): Candle[] => series(0, [
  ...WARMUP,
  DIP,
  { o: 90, h: 90, l: 89.5, c: 90 },
  { o: 90, h: 90, l: 89.5, c: 90 },
  { o: 90, h: 90, l: 89.5, c: 90 },
  { o: 90, h: 90, l: 70, c: 70 },   // mid 88, lower 70.11 — a long signal again
  flat(70),
]);

/**
 * Dips at bar 7, then retraces only half way: bar 8 closes at 94 while the mean
 * sits at 97. A partial target is reached, the mean target is not.
 */
const halfBack = (): Candle[] => series(0, [
  ...WARMUP,
  DIP,
  { o: 90, h: 95, l: 89, c: 94 },
  flat(94),
  flat(94),
]);

/** Dips at bar 7 and closes back inside the band at bar 8 — the confirmed bounce. */
const bounce = (): Candle[] => series(0, [
  ...WARMUP,
  DIP,
  { o: 90, h: 93, l: 89, c: 92 },
  { o: 93, h: 99, l: 93, c: 98 },
  flat(99),
  flat(99),
]);

/**
 * Short periods keep the fixtures hand-checkable; the percent stop keeps ATR out
 * of the sizing path so volatility-filter tests do not move the position size.
 * Session 0→0 means "no window", so a test only pays for the window when it asks.
 */
const BASE: Record<string, number | string> = {
  bbPeriod: 6,
  bbMult: 2,
  atrPeriod: 5,
  sessionStartHour: 0,
  sessionEndHour: 0,
  stopMode: "pct",
  stopPct: 5,
  exitMode: "market",
  exitSigma: 0,
  riskPct: 1,
  maxLeverage: 5,
  minQty: 0.001,
  qtyStep: 0.001,
  maxOpenPositions: 1,
  closeOutsideSession: 1,
};

function run(
  candles: Candle[],
  params: Record<string, number | string> = {},
  costs: BacktestCosts = {},
) {
  return runBacktest({
    symbol: SYMBOL,
    candles,
    bot: { id: "night-mr-test", kind: "night-mr", symbol: SYMBOL, params: { ...BASE, ...params }, status: "stopped" },
    initialBalance: 1000,
    feeRate: 0,
    slippageCfg: NO_SLIP,
    costs,
  });
}

const entries = (orders: { type: string; side: string }[]) =>
  orders.filter((o) => o.type === "market" && o.side === "buy");

describe("utcHour", () => {
  it("reads the hour from the bar timestamp, not the host clock", () => {
    expect(utcHour(DAY0)).toBe(0);
    expect(utcHour(DAY0 + 3 * 3600)).toBe(3);
    expect(utcHour(DAY0 + 23 * 3600)).toBe(23);
    expect(utcHour(DAY0 + 24 * 3600)).toBe(0);
  });

  it("stays in range for timestamps before the epoch", () => {
    expect(utcHour(-3600)).toBe(23);
    expect(utcHour(-1)).toBe(23);
  });
});

describe("inSession", () => {
  it("covers [start, end) for a window inside one day", () => {
    expect(inSession(DAY0 + 2 * 3600, 3, 6)).toBe(false);
    expect(inSession(DAY0 + 3 * 3600, 3, 6)).toBe(true);
    expect(inSession(DAY0 + 5 * 3600, 3, 6)).toBe(true);
    expect(inSession(DAY0 + 6 * 3600, 3, 6)).toBe(false);
  });

  it("wraps midnight when the end hour is not after the start", () => {
    for (const h of [22, 23, 0, 1, 2, 3]) {
      expect(inSession(DAY0 + h * 3600, 22, 4)).toBe(true);
    }
    for (const h of [4, 12, 21]) {
      expect(inSession(DAY0 + h * 3600, 22, 4)).toBe(false);
    }
  });

  it("treats an equal start and end as no filter", () => {
    for (const h of [0, 5, 13, 23]) expect(inSession(DAY0 + h * 3600, 0, 0)).toBe(true);
  });
});

describe("quantiseDown", () => {
  it("rounds down to the step and never up", () => {
    expect(quantiseDown(2.2727, 0.001)).toBe(2.272);
    expect(quantiseDown(0.0019, 0.001)).toBe(0.001);
    expect(quantiseDown(0.0009, 0.001)).toBe(0);
  });

  it("leaves no float dust behind", () => {
    expect(quantiseDown(0.007123, 0.001)).toBe(0.007);
    expect(quantiseDown(1.23456, 0.01)).toBe(1.23);
  });
});

describe("params", () => {
  it("is registered under night-mr", () => {
    expect(getBotFactory("night-mr")).toBe(nightMeanReversionFactory);
  });

  it("parses the factory defaults into the documented values", () => {
    const p = parseNightMrParams(nightMeanReversionFactory.defaultParams);
    expect(p.bbPeriod).toBe(20);
    expect(p.bbMult).toBe(2);
    expect(p.sessionStartHour).toBe(3);
    expect(p.sessionEndHour).toBe(6);
    expect(p.stopMode).toBe("atr");
    expect(p.exitMode).toBe("market");
    expect(p.exitRule).toBe("mean");
    expect(p.closeOutsideSession).toBe(true);
    expect(p.maxOpenPositions).toBe(1);
  });

  it("falls back to defaults on junk and normalises hours", () => {
    const p = parseNightMrParams({ bbPeriod: "abc", exitMode: "nonsense", exitRule: "wat", stopMode: "", sessionStartHour: 27, sessionEndHour: -2 });
    expect(p.bbPeriod).toBe(20);
    expect(p.exitMode).toBe("market");
    expect(p.exitRule).toBe("mean");
    expect(p.stopMode).toBe("atr");
    expect(p.sessionStartHour).toBe(3);
    expect(p.sessionEndHour).toBe(22);
  });

  it("clamps the retrace fraction into (0, 1]", () => {
    expect(parseNightMrParams({ exitFraction: 0 }).exitFraction).toBe(0.01);
    expect(parseNightMrParams({ exitFraction: -3 }).exitFraction).toBe(0.01);
    expect(parseNightMrParams({ exitFraction: 5 }).exitFraction).toBe(1);
    expect(parseNightMrParams({ exitFraction: 0.25 }).exitFraction).toBe(0.25);
  });
});

describe("night mean reversion — entry and exit", () => {
  it("buys the break of the lower band and exits on the return to the mean", async () => {
    const result = await run(revert());

    expect(result.trades).toHaveLength(1);
    // Signal on bar 7 (close 88 < lower 89.06) → market fills at bar 8 open.
    expect(result.trades[0].entryPrice).toBe(90);
    // Bar 8 closes at 98, above mid 97.667 → close fills at bar 9 open.
    expect(result.trades[0].exitPrice).toBe(99);
    expect(result.trades[0].side).toBe("buy");
    expect(result.positions).toHaveLength(0);
  });

  it("leaves nothing behind after the round trip", async () => {
    const result = await run(revert());

    expect(result.orders.filter((o) => o.status === "pending")).toHaveLength(0);
    expect(entries(result.orders)).toHaveLength(1);
  });

  it("stops out inside the entry bar when price keeps falling", async () => {
    const result = await run(stopout());

    // Stop is 5% below the 88 signal close = 83.6, and it is already resting
    // when the entry fills at 90 on the same bar.
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryPrice).toBe(90);
    expect(result.trades[0].exitPrice).toBeCloseTo(83.6, 6);
    expect(result.trades[0].pnl).toBeLessThan(0);
    // reduceOnly means the stop closed the long instead of opening a short.
    expect(result.positions).toHaveLength(0);
  });

  it("places a reduce-only limit at the mean in limit exit mode", async () => {
    const result = await run(revert(), { exitMode: "limit" });

    const exit = result.orders.find((o) => o.type === "limit" && o.side === "sell");
    expect(exit).toBeDefined();
    expect(exit?.price).toBeCloseTo(98, 6);   // mid of the signal bar
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitPrice).toBeCloseTo(98, 6);
  });

  it("holds past the mean when the target is the opposite band", async () => {
    // Bar 8 closes at 98, over mid 97.667 — enough for `mean`, short of upper
    // 106.5 — so the band exit is still holding when the fixture ends.
    const result = await run(revert(), { exitRule: "band" });

    expect(result.trades).toHaveLength(0);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].entryPrice).toBe(90);
  });

  it("takes a fixed percentage off the entry price", async () => {
    // Entry fills at 90 on bar 8, so the target is 90 x 1.05 = 94.5 — measured
    // from the fill, not from the 88 signal close it was decided on.
    const result = await run(revert(), { exitRule: "pct", exitPct: 5, exitMode: "limit" });

    const exit = result.orders.find((o) => o.type === "limit" && o.side === "sell");
    expect(exit?.price).toBeCloseTo(94.5, 6);
  });

  it("does not rest an entry-anchored limit before the entry has filled", async () => {
    // The stop is bracketed at signal time; a pct target cannot be, because the
    // entry price it measures from does not exist yet.
    const anchored = await run(revert(), { exitRule: "pct", exitPct: 5, exitMode: "limit" });
    const banded = await run(revert(), { exitRule: "mean", exitMode: "limit" });

    const firstLimit = (r: typeof anchored) =>
      r.orders.filter((o) => o.type === "limit" && o.side === "sell")[0];
    // Band targets rest from the signal bar, entry-anchored ones a bar later.
    expect(firstLimit(banded).ts).toBeLessThan(firstLimit(anchored).ts);
  });

  it("exits on a half retrace that never reaches the mean", async () => {
    // Entry 90, mean 97 → half way is 93.5, and bar 8 closes at 94.
    const partial = await run(halfBack(), { exitRule: "partial", exitFraction: 0.5 });
    const mean = await run(halfBack(), { exitRule: "mean" });

    expect(partial.trades).toHaveLength(1);
    expect(partial.trades[0].entryPrice).toBe(90);
    expect(partial.trades[0].exitPrice).toBe(94);
    // The same retrace leaves the mean exit still holding when the series ends.
    expect(mean.trades).toHaveLength(0);
    expect(mean.positions).toHaveLength(1);
  });

  it("collapses onto the mean target when the retrace fraction is 1", async () => {
    const partial = await run(revert(), { exitRule: "partial", exitFraction: 1 });
    const mean = await run(revert(), { exitRule: "mean" });

    expect(partial.trades).toHaveLength(1);
    expect(partial.trades[0].exitPrice).toBe(mean.trades[0].exitPrice);
  });

  it("waits for the close back inside the band when reentry is required", async () => {
    const immediate = await run(bounce());
    const confirmed = await run(bounce(), { requireReentry: 1 });

    expect(immediate.trades[0].entryPrice).toBe(90);   // entered off bar 7
    expect(confirmed.trades[0].entryPrice).toBe(93);   // waited for bar 8 to close back inside
  });

  it("takes no short when shorts are disabled", async () => {
    const result = await run(revert(), { allowLong: 0 });

    expect(result.orders).toHaveLength(0);
    expect(result.trades).toHaveLength(0);
  });
});

describe("night mean reversion — trading window", () => {
  it("ignores signals outside the session hours", async () => {
    const result = await run(revert(), { sessionStartHour: 3, sessionEndHour: 6 });

    expect(result.orders).toHaveLength(0);
    expect(result.trades).toHaveLength(0);
  });

  it("trades the same signal once the window covers it", async () => {
    const result = await run(revert(), { sessionStartHour: 7, sessionEndHour: 10 });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryPrice).toBe(90);
    expect(result.trades[0].exitPrice).toBe(99);
  });

  it("handles a window that crosses midnight", async () => {
    // Dip at 23:00, entry fills at 00:00 the next day — both inside 22:00–04:00.
    const result = await run(revert(16), { sessionStartHour: 22, sessionEndHour: 4 });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryPrice).toBe(90);
    expect(result.trades[0].exitPrice).toBe(99);
  });

  it("stays flat on the same bars when the window misses them entirely", async () => {
    const result = await run(revert(16), { sessionStartHour: 8, sessionEndHour: 11 });

    expect(result.orders).toHaveLength(0);
  });

  it("does not enter when the fill would land outside the window", async () => {
    // Dip on the last in-session bar: the entry would fill at 06:00, outside.
    const result = await run(revert(), { sessionStartHour: 5, sessionEndHour: 8 });

    expect(entries(result.orders)).toHaveLength(0);
  });

  it("force-closes an open position at the end of the session", async () => {
    const result = await run(held(), { sessionStartHour: 3, sessionEndHour: 6 });

    // Entry at 04:00 open, flatten decided on the 05:00 bar, filled at 06:00 open.
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryPrice).toBe(90);
    expect(result.trades[0].exitPrice).toBe(91);
    expect(result.positions).toHaveLength(0);
  });

  it("keeps the position past the session when the flatten is disabled", async () => {
    const result = await run(held(), { sessionStartHour: 3, sessionEndHour: 6, closeOutsideSession: 0 });

    expect(result.trades).toHaveLength(0);
    expect(result.positions).toHaveLength(1);
    expect(result.positions[0].entryPrice).toBe(90);
  });
});

describe("night mean reversion — filters", () => {
  it("skips the trade when volatility is below the floor", async () => {
    // ATR(5) on the dip bar is 2.4 = 2.73% of the 88 close.
    const result = await run(revert(), { minAtrPct: 5 });

    expect(result.orders).toHaveLength(0);
  });

  it("skips the trade when volatility is above the ceiling", async () => {
    const result = await run(revert(), { maxAtrPct: 1 });

    expect(result.orders).toHaveLength(0);
  });

  it("trades when volatility sits inside the band", async () => {
    const result = await run(revert(), { minAtrPct: 1, maxAtrPct: 10 });

    expect(result.trades).toHaveLength(1);
  });

  it("caps concurrent entries at maxOpenPositions", async () => {
    const one = await run(secondDip(), { stopPct: 30, maxOpenPositions: 1 });
    const two = await run(secondDip(), { stopPct: 30, maxOpenPositions: 2 });

    expect(entries(one.orders)).toHaveLength(1);
    expect(entries(two.orders)).toHaveLength(2);
  });

  it("closes on the bar cap when the mean is never reached", async () => {
    const result = await run(held(), { maxBarsInTrade: 2 });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryPrice).toBe(90);
  });
});

describe("night mean reversion — position sizing", () => {
  it("sizes from risk and stop distance, rounded down to the step", async () => {
    const result = await run(revert());

    // 1% of 1000 = 10 USDT risked over a 4.4 stop distance = 2.2727, floored to 2.272.
    expect(result.trades[0].qty).toBeCloseTo(2.272, 9);
    expect(result.trades[0].pnl).toBeCloseTo(9 * 2.272, 6);
  });

  it("respects a coarser size step", async () => {
    const result = await run(revert(), { qtyStep: 0.5, minQty: 0.5 });

    expect(result.trades[0].qty).toBeCloseTo(2, 9);
  });

  it("caps notional by max leverage", async () => {
    // Risk 20% over a 4.4 stop wants 45.45 units (≈4000 USDT notional);
    // leverage 1 allows only 1000 / 88 = 11.36, floored to 11.363.
    const result = await run(revert(), { riskPct: 20, maxLeverage: 1 });

    expect(result.trades[0].qty).toBeCloseTo(11.363, 9);
  });

  it("skips the trade when the size lands below the minimum lot", async () => {
    const result = await run(revert(), { riskPct: 0.0001 });

    expect(result.orders).toHaveLength(0);
    expect(result.trades).toHaveLength(0);
    expect(result.stats.netProfit).toBe(0);
  });

  it("survives a minimum lot far above what the risk allows", async () => {
    const result = await run(revert(), { minQty: 100, qtyStep: 100 });

    expect(result.orders).toHaveLength(0);
    expect(result.positions).toHaveLength(0);
  });

  it("trades normally under exchange instrument rules", async () => {
    const rules: InstrumentRules = {
      symbol: SYMBOL, minOrderQty: 0.001, qtyStep: 0.001, tickSize: 0.1, minNotional: 5,
    };
    const result = await run(revert(), {}, { rules });

    expect(result.trades).toHaveLength(1);
    expect(result.rejected).toBe(0);
  });

  it("does not enter when the venue refuses the protective stop", async () => {
    // Sized at 2.272, the entry is worth 199.9 at the 88 signal close but the
    // stop at 83.6 is only worth 189.9 — a 195 minimum lets the entry through
    // and bounces the stop.
    const rules: InstrumentRules = {
      symbol: SYMBOL, minOrderQty: 0.001, qtyStep: 0.001, tickSize: 0.1, minNotional: 195,
    };
    const result = await run(revert(), {}, { rules });

    expect(result.orders.filter((o) => o.type === "market")).toHaveLength(0);
    expect(result.positions).toHaveLength(0);
    expect(result.trades).toHaveLength(0);
  });

  it("never opens a position the venue would refuse to protect", async () => {
    // Nothing this size can be placed, so both bracket legs bounce off the rules.
    const rules: InstrumentRules = {
      symbol: SYMBOL, minOrderQty: 1000, qtyStep: 1000, tickSize: 0.1, minNotional: 5,
    };
    const result = await run(revert(), {}, { rules });

    expect(result.positions).toHaveLength(0);
    expect(result.trades).toHaveLength(0);
    expect(result.orders.filter((o) => o.status === "filled")).toHaveLength(0);
  });
});
