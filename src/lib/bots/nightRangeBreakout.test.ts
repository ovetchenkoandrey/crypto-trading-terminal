import { describe, it, expect } from "vitest";
import { runBacktest } from "../execution/backtest/runner";
import type { BacktestCosts } from "../execution/backtest/runner";
import { getBotFactory } from "./registry";
import {
  utcHour,
  inWindow,
  quantiseDown,
  parseNightRangeParams,
  nightRangeBreakoutFactory,
} from "./nightRangeBreakout";
import type { Candle } from "../types";
import type { SlippageSettings } from "../settings";

const NO_SLIP: SlippageSettings = { kind: "none", bps: 0, spreadPct: 0, impactK: 0, impactRefQty: 1 };

const SYMBOL = "TESTUSDT";
const DAY0 = Date.UTC(2024, 0, 1) / 1000;   // 2024-01-01 00:00 UTC, exact hour boundary

interface Spec { o: number; h: number; l: number; c: number }

/** Hourly candles; bar i sits at hour i of 2024-01-01 UTC. */
function series(specs: Spec[]): Candle[] {
  return specs.map((s, i) => ({
    time: DAY0 + i * 3600,
    open: s.o, high: s.h, low: s.l, close: s.c, volume: 100,
  }));
}

/**
 * Six bars of chop between 99 and 101 fill the 00:00-06:00 range window, so
 * every fixture starts from the same box: high 101, low 99, height 2, mid 100.
 */
const BOX: Spec[] = [
  { o: 100, h: 101, l: 99.5, c: 100 },
  { o: 100, h: 100.5, l: 99, c: 99.5 },
  { o: 99.5, h: 100.5, l: 99.2, c: 100.2 },
  { o: 100.2, h: 101, l: 99.8, c: 100 },
  { o: 100, h: 100.6, l: 99, c: 99.8 },
  { o: 99.8, h: 100.4, l: 99.4, c: 100 },
];

const flat = (p: number): Spec => ({ o: p, h: p, l: p, c: p });

/** Breaks the box high at 06:00 and runs to the 1.5R target at 07:00. */
const breakUp = (): Candle[] => series([
  ...BOX,
  { o: 100, h: 102, l: 100, c: 102 },       // 06:00 — close 102 above the 101 high
  { o: 102.5, h: 107, l: 102, c: 106.8 },   // 07:00 — entry fill, target 106.5 tagged
  flat(107),
]);

/** Breaks the box low at 06:00 and runs to the 1.5R target at 07:00. */
const breakDown = (): Candle[] => series([
  ...BOX,
  { o: 100, h: 100, l: 97, c: 97 },
  { o: 96.5, h: 96.8, l: 90, c: 91 },
  flat(91),
]);

/** Pokes the high with a wick at 06:00 but closes back inside the box. */
const wickOnly = (): Candle[] => series([
  ...BOX,
  { o: 100, h: 102, l: 100, c: 100.5 },
  { o: 100.6, h: 104, l: 100.5, c: 103.5 },
  flat(104),
]);

/** Breaks up, gets pushed back through the box to the stop, then breaks up again. */
const failThenBreak = (): Candle[] => series([
  ...BOX,
  { o: 100, h: 102, l: 100, c: 102 },       // 06:00 signal
  { o: 102.5, h: 102.5, l: 98, c: 99 },     // 07:00 entry 102.5, stop 99 taken out
  { o: 99, h: 102.5, l: 99, c: 102.4 },     // 08:00 back above the box high
  { o: 102.5, h: 108, l: 102.4, c: 107.8 }, // 09:00
  flat(108),
]);

/** Breaks up at 06:00, then drifts sideways until the 14:00 window close. */
const drift = (): Candle[] => series([
  ...BOX,
  { o: 100, h: 102, l: 100, c: 102 },
  ...Array.from({ length: 7 }, () => ({ o: 102.5, h: 103, l: 102, c: 102.5 })),  // 07:00-13:00
  flat(102.5),   // 14:00 — outside the trade window
  flat(102.5),
]);

/**
 * A wide-open trade window and no narrowness gate keep the fixtures about the
 * breakout itself; individual tests switch on the filter they are measuring.
 */
const BASE: Record<string, number | string> = {
  rangeStartHour: 0,
  rangeEndHour: 6,
  tradeStartHour: 6,
  tradeEndHour: 14,
  breakoutBufferPct: 0,
  triggerMode: "close",
  stopMode: "opposite",
  targetMode: "r",
  targetR: 1.5,
  atrPeriod: 3,
  riskPct: 1,
  maxLeverage: 5,
  minQty: 0.001,
  qtyStep: 0.001,
  maxEntriesPerRange: 1,
  flattenAtEnd: 1,
};

function run(
  candles: Candle[],
  params: Record<string, number | string> = {},
  costs: BacktestCosts = {},
) {
  return runBacktest({
    symbol: SYMBOL,
    candles,
    bot: { id: "night-range-test", kind: "night-range", symbol: SYMBOL, params: { ...BASE, ...params }, status: "stopped" },
    initialBalance: 1000,
    feeRate: 0,
    slippageCfg: NO_SLIP,
    costs,
  });
}

describe("utcHour / inWindow", () => {
  it("reads the hour from the bar timestamp, not the host clock", () => {
    expect(utcHour(DAY0)).toBe(0);
    expect(utcHour(DAY0 + 6 * 3600)).toBe(6);
    expect(utcHour(DAY0 + 24 * 3600)).toBe(0);
    expect(utcHour(-1)).toBe(23);
  });

  it("covers [start, end) and wraps midnight", () => {
    expect(inWindow(DAY0 + 5 * 3600, 0, 6)).toBe(true);
    expect(inWindow(DAY0 + 6 * 3600, 0, 6)).toBe(false);
    for (const h of [22, 23, 0, 1]) expect(inWindow(DAY0 + h * 3600, 22, 2)).toBe(true);
    for (const h of [2, 12, 21]) expect(inWindow(DAY0 + h * 3600, 22, 2)).toBe(false);
  });
});

describe("quantiseDown", () => {
  it("rounds down to the step and never up", () => {
    expect(quantiseDown(3.3337, 0.001)).toBe(3.333);
    expect(quantiseDown(0.0009, 0.001)).toBe(0);
  });
});

describe("params", () => {
  it("is registered under night-range", () => {
    expect(getBotFactory("night-range")).toBe(nightRangeBreakoutFactory);
  });

  it("parses the factory defaults into the documented values", () => {
    const p = parseNightRangeParams(nightRangeBreakoutFactory.defaultParams);
    expect(p.rangeStartHour).toBe(0);
    expect(p.rangeEndHour).toBe(6);
    expect(p.tradeStartHour).toBe(6);
    expect(p.tradeEndHour).toBe(14);
    expect(p.stopMode).toBe("opposite");
    expect(p.targetMode).toBe("r");
    expect(p.triggerMode).toBe("close");
    expect(p.maxEntriesPerRange).toBe(1);
  });

  it("falls back to defaults on junk and normalises hours", () => {
    const p = parseNightRangeParams({ stopMode: "???", targetMode: "", triggerMode: "x", rangeStartHour: 26, rangeEndHour: -1 });
    expect(p.stopMode).toBe("opposite");
    expect(p.targetMode).toBe("r");
    expect(p.triggerMode).toBe("close");
    expect(p.rangeStartHour).toBe(2);
    expect(p.rangeEndHour).toBe(23);
  });
});

describe("night range breakout — entry and exit", () => {
  it("buys the break of the box high and takes the R target", async () => {
    const result = await run(breakUp());

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].side).toBe("buy");
    // Signal on the 06:00 bar -> market fills at 07:00 open.
    expect(result.trades[0].entryPrice).toBe(102.5);
    // Stop at the far side of the box (99), so 1R = 3 and the target sits at 106.5.
    expect(result.trades[0].exitPrice).toBeCloseTo(106.5, 6);
    expect(result.positions).toHaveLength(0);
  });

  it("sells the break of the box low", async () => {
    const result = await run(breakDown());

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].side).toBe("sell");
    expect(result.trades[0].entryPrice).toBe(96.5);
    // Stop at the box high 101, i.e. 4 points from the 97 signal close, so the
    // 1.5R target sits at 97 - 6 = 91.
    expect(result.trades[0].exitPrice).toBeCloseTo(91, 6);
  });

  it("stops out at the far side of the box when the break fails", async () => {
    const result = await run(failThenBreak(), { maxEntriesPerRange: 1 });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryPrice).toBe(102.5);
    expect(result.trades[0].exitPrice).toBeCloseTo(99, 6);
    expect(result.trades[0].pnl).toBeLessThan(0);
    // reduceOnly means the stop flattened the long instead of opening a short.
    expect(result.positions.some((p) => p.side === "sell")).toBe(false);
  });

  it("takes only one entry per range unless allowed more", async () => {
    const once = await run(failThenBreak(), { maxEntriesPerRange: 1 });
    const twice = await run(failThenBreak(), { maxEntriesPerRange: 2 });

    expect(once.trades).toHaveLength(1);
    expect(twice.trades.length).toBeGreaterThan(1);
  });

  it("honours the direction switches", async () => {
    expect((await run(breakUp(), { allowLong: 0 })).trades).toHaveLength(0);
    expect((await run(breakDown(), { allowShort: 0 })).trades).toHaveLength(0);
  });

  it("runs without a target when the target is switched off", async () => {
    const result = await run(breakUp(), { targetMode: "none" });
    expect(result.trades).toHaveLength(0);
    expect(result.positions).toHaveLength(1);
  });

  it("takes a target measured in range heights", async () => {
    const result = await run(breakUp(), { targetMode: "range", targetRangeMult: 2 });
    // 2 x the 2-point box from the 102 signal close.
    expect(result.trades[0].exitPrice).toBeCloseTo(106, 6);
  });
});

describe("night range breakout — the trigger", () => {
  it("ignores a wick through the boundary in close mode", async () => {
    expect((await run(wickOnly())).trades).toHaveLength(0);
  });

  it("takes the same wick in wick mode", async () => {
    const result = await run(wickOnly(), { triggerMode: "wick" });
    expect(result.trades).toHaveLength(1);
    // The entry still fills at the NEXT bar's open, never inside the signal bar.
    expect(result.trades[0].entryPrice).toBe(100.6);
  });

  it("requires the break to clear the buffer", async () => {
    // 100% of the 2-point box puts the trigger at 103, above the 102 close.
    expect((await run(breakUp(), { breakoutBufferPct: 100 })).trades).toHaveLength(0);
    expect((await run(breakUp(), { breakoutBufferPct: 40 })).trades).toHaveLength(1);
  });
});

describe("night range breakout — the narrowness gate", () => {
  it("skips a box wider than the ceiling", async () => {
    // The box is 2 points on a mid of 100, i.e. 2%.
    expect((await run(breakUp(), { maxRangePct: 1 })).trades).toHaveLength(0);
    expect((await run(breakUp(), { maxRangePct: 3 })).trades).toHaveLength(1);
  });

  it("skips a box narrower than the floor", async () => {
    expect((await run(breakUp(), { minRangePct: 5 })).trades).toHaveLength(0);
  });

  it("skips a range built from too few bars", async () => {
    // Five, not six: the harness consumes bar 0 to give the bot a price before
    // it starts, so the range window sees 01:00..05:00.
    expect((await run(breakUp(), { minRangeBars: 20 })).trades).toHaveLength(0);
    expect((await run(breakUp(), { minRangeBars: 5 })).trades).toHaveLength(1);
  });

  it("skips a box too wide relative to ATR", async () => {
    expect((await run(breakUp(), { maxRangeAtrMult: 0.5 })).trades).toHaveLength(0);
  });
});

describe("night range breakout — windows", () => {
  it("does not trade a break outside the trade window", async () => {
    // Moving the window to 10:00-14:00 leaves the 06:00 break untouched.
    expect((await run(breakUp(), { tradeStartHour: 10, tradeEndHour: 14 })).trades).toHaveLength(0);
  });

  it("flattens what is still open when the trade window ends", async () => {
    const result = await run(drift(), { targetMode: "none" });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryPrice).toBe(102.5);
    expect(result.trades[0].exitPrice).toBe(102.5);
    expect(result.positions).toHaveLength(0);
  });

  it("keeps the position past the window when the flatten is disabled", async () => {
    const result = await run(drift(), { targetMode: "none", flattenAtEnd: 0 });
    expect(result.trades).toHaveLength(0);
    expect(result.positions).toHaveLength(1);
  });

  it("refuses to run when the range window covers the whole day", async () => {
    const result = await run(breakUp(), { rangeStartHour: 0, rangeEndHour: 0 });
    expect(result.trades).toHaveLength(0);
    expect(result.orders).toHaveLength(0);
  });
});

describe("night range breakout — risk sizing", () => {
  it("sizes from the risk fraction and the distance to the far side of the box", async () => {
    const result = await run(breakUp(), { riskPct: 1 });
    // 1% of 1000 = 10 USDT over a 3-point stop distance (102 close down to 99).
    expect(result.trades[0].qty).toBeCloseTo(3.333, 3);
  });

  it("skips the trade when the sized quantity lands under the exchange minimum", async () => {
    expect((await run(breakUp(), { riskPct: 0.0001, minQty: 1 })).trades).toHaveLength(0);
  });

  it("sizes from a fraction of the box when asked", async () => {
    const result = await run(breakUp(), { stopMode: "fraction", stopFraction: 0.25 });
    // A quarter of the 2-point box is a 0.5 stop, so the same 10 USDT of risk
    // buys 20 units — still under the 49-unit leverage cap.
    expect(result.trades[0].qty).toBeCloseTo(20, 6);
  });
});
