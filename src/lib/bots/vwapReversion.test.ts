import { describe, it, expect } from "vitest";
import { runBacktest } from "../execution/backtest/runner";
import type { BacktestCosts } from "../execution/backtest/runner";
import { getBotFactory } from "./registry";
import {
  utcHour,
  inSession,
  quantiseDown,
  vwapBand,
  parseVwapReversionParams,
  vwapReversionFactory,
} from "./vwapReversion";
import type { Candle } from "../types";
import type { SlippageSettings } from "../settings";

const NO_SLIP: SlippageSettings = { kind: "none", bps: 0, spreadPct: 0, impactK: 0, impactRefQty: 1 };

const SYMBOL = "TESTUSDT";
const DAY0 = Date.UTC(2024, 0, 1) / 1000;   // 2024-01-01 00:00 UTC, exact hour boundary

interface Spec { o: number; h: number; l: number; c: number; v?: number }

/** Hourly candles; bar i sits at `startHour + i` hours after 2024-01-01 00:00 UTC. */
function series(startHour: number, specs: Spec[]): Candle[] {
  return specs.map((s, i) => ({
    time: DAY0 + (startHour + i) * 3600,
    open: s.o, high: s.h, low: s.l, close: s.c, volume: s.v ?? 100,
  }));
}

const flat = (p: number, v = 100): Spec => ({ o: p, h: p, l: p, c: p, v });

/**
 * Twelve flat bars at 100 on constant volume. Rolling VWAP over them is exactly
 * 100, every deviation is zero, so no fixture can fire a signal before its own
 * shape does.
 */
const WARMUP: Spec[] = Array.from({ length: 12 }, () => flat(100));

/**
 * The excursion bar. Typical price (100 + 95 + 95)/3 = 96.6667, so rolling
 * VWAP(5) = (100 x 4 + 96.6667)/5 = 99.3333 and the 2% threshold puts the lower
 * line at 97.3467. Closing at 95 is a long signal.
 */
const DIP: Spec = { o: 100, h: 100, l: 95, c: 95 };

/** Dips at bar 12, then closes back over VWAP at bar 13. */
const revert = (startHour = 0, dipVolume = 100): Candle[] => series(startHour, [
  ...WARMUP,
  { ...DIP, v: dipVolume },
  { o: 96, h: 100.5, l: 96, c: 100 },
  flat(100),
  flat(100),
]);

/** Dips at bar 12, then keeps falling through the 5% stop at 90.25. */
const stopout = (): Candle[] => series(0, [
  ...WARMUP,
  DIP,
  { o: 96, h: 96, l: 88, c: 89 },
  flat(89),
  flat(89),
]);

/** Dips at 03:00 UTC and never returns — the only way out is the session flatten. */
const held = (): Candle[] => series(15, [
  ...WARMUP,
  DIP,
  { o: 96, h: 96.5, l: 95.5, c: 96 },
  { o: 96, h: 96.5, l: 95.5, c: 96 },
  flat(96),
  flat(96),
]);

/** Dips at bar 12 and closes back inside the band, still under VWAP, at bar 13. */
const bounce = (): Candle[] => series(0, [
  ...WARMUP,
  DIP,
  { o: 96, h: 98, l: 96, c: 97.5 },
  { o: 97.6, h: 101, l: 97.5, c: 100.5 },
  flat(101),
  flat(101),
]);

/**
 * Rolling VWAP keeps the fixtures hand-checkable; a percent threshold keeps the
 * band out of the entry path so a test only pays for the band when it asks for
 * it. Session 0 -> 0 means "no window filter".
 */
const BASE: Record<string, number | string> = {
  vwapAnchor: "rolling",
  vwapPeriod: 5,
  bandPeriod: 5,
  entryBandMult: 0,
  entryPct: 2,
  volPeriod: 10,
  sessionStartHour: 0,
  sessionEndHour: 0,
  exitMode: "market",
  exitRule: "vwap",
  exitBandMult: 0,
  stopMode: "pct",
  stopPct: 5,
  atrPeriod: 5,
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
    bot: { id: "vwap-mr-test", kind: "vwap-mr", symbol: SYMBOL, params: { ...BASE, ...params }, status: "stopped" },
    initialBalance: 1000,
    feeRate: 0,
    slippageCfg: NO_SLIP,
    costs,
  });
}

describe("utcHour / inSession", () => {
  it("reads the hour from the bar timestamp, not the host clock", () => {
    expect(utcHour(DAY0)).toBe(0);
    expect(utcHour(DAY0 + 3 * 3600)).toBe(3);
    expect(utcHour(DAY0 + 24 * 3600)).toBe(0);
    expect(utcHour(-1)).toBe(23);
  });

  it("covers [start, end) and wraps midnight", () => {
    expect(inSession(DAY0 + 2 * 3600, 3, 6)).toBe(false);
    expect(inSession(DAY0 + 3 * 3600, 3, 6)).toBe(true);
    expect(inSession(DAY0 + 6 * 3600, 3, 6)).toBe(false);
    for (const h of [22, 23, 0, 1, 2, 3]) expect(inSession(DAY0 + h * 3600, 22, 4)).toBe(true);
    for (const h of [0, 5, 13, 23]) expect(inSession(DAY0 + h * 3600, 0, 0)).toBe(true);
  });
});

describe("quantiseDown", () => {
  it("rounds down to the step and never up", () => {
    expect(quantiseDown(2.2727, 0.001)).toBe(2.272);
    expect(quantiseDown(0.0009, 0.001)).toBe(0);
    expect(quantiseDown(1.23456, 0.01)).toBe(1.23);
  });
});

describe("vwapBand", () => {
  it("is the root mean square distance from VWAP, not a variance about its mean", () => {
    // Deviations -2, -2, -2: RMS is 2, while a mean-centred stdev would be 0.
    const band = vwapBand([98, 98, 98], [100, 100, 100], 3);
    expect(band).toBeCloseTo(2, 12);
  });

  it("uses only the last `period` bars", () => {
    const band = vwapBand([50, 98, 102], [100, 100, 100], 2);
    expect(band).toBeCloseTo(2, 12);
  });

  it("skips bars with no VWAP and gives up under two points", () => {
    expect(vwapBand([98, 102], [null, 100], 2)).toBeNull();
    expect(vwapBand([98, 102], [100, 100], 2)).toBeCloseTo(2, 12);
    expect(vwapBand([], [], 5)).toBeNull();
  });
});

describe("params", () => {
  it("is registered under vwap-mr", () => {
    expect(getBotFactory("vwap-mr")).toBe(vwapReversionFactory);
  });

  it("parses the factory defaults into the documented values", () => {
    const p = parseVwapReversionParams(vwapReversionFactory.defaultParams);
    expect(p.vwapAnchor).toBe("session");
    expect(p.entryBandMult).toBe(2);
    expect(p.sessionStartHour).toBe(3);
    expect(p.sessionEndHour).toBe(6);
    expect(p.exitRule).toBe("vwap");
    expect(p.stopMode).toBe("atr");
    expect(p.maxRelVolume).toBe(0);
  });

  it("falls back to defaults on junk and normalises hours", () => {
    const p = parseVwapReversionParams({
      vwapAnchor: "nonsense", exitRule: "", stopMode: "???",
      sessionStartHour: 27, sessionEndHour: -2, exitFraction: 5,
    });
    expect(p.vwapAnchor).toBe("session");
    expect(p.exitRule).toBe("vwap");
    expect(p.stopMode).toBe("atr");
    expect(p.sessionStartHour).toBe(3);
    expect(p.sessionEndHour).toBe(22);
    expect(p.exitFraction).toBe(1);
  });
});

describe("vwap reversion — entry and exit", () => {
  it("buys the excursion below VWAP and exits on the return to it", async () => {
    const result = await run(revert());

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].side).toBe("buy");
    // Signal on bar 12 (close 95 < lower 97.347) -> market fills at bar 13 open.
    expect(result.trades[0].entryPrice).toBe(96);
    // Bar 13 closes at 100, above VWAP 99.1 -> close fills at bar 14 open.
    expect(result.trades[0].exitPrice).toBe(100);
    expect(result.positions).toHaveLength(0);
    expect(result.orders.filter((o) => o.status === "pending")).toHaveLength(0);
  });

  it("stops out inside the entry bar when price keeps falling", async () => {
    const result = await run(stopout());

    // Stop is 5% below the 95 signal close = 90.25, already resting when the
    // entry fills at 96 on the same bar.
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryPrice).toBe(96);
    expect(result.trades[0].exitPrice).toBeCloseTo(90.25, 6);
    expect(result.trades[0].pnl).toBeLessThan(0);
    // reduceOnly means the stop closed the long instead of flipping into a
    // short. Price stays under VWAP afterwards, so the bot legitimately buys
    // again — what must not exist is a short.
    expect(result.positions.some((p) => p.side === "sell")).toBe(false);
  });

  it("places a reduce-only limit at VWAP in limit exit mode", async () => {
    const result = await run(revert(), { exitMode: "limit" });

    const exit = result.orders.find((o) => o.type === "limit" && o.side === "sell");
    expect(exit).toBeDefined();
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitPrice).toBeLessThan(100);
  });

  it("takes a fraction of the way back with the partial exit rule", async () => {
    const full = await run(revert());
    const half = await run(revert(), { exitRule: "partial", exitFraction: 0.1, exitMode: "limit" });

    expect(half.trades).toHaveLength(1);
    // A tenth of the distance from the entry to VWAP is reached earlier and pays less.
    expect(half.trades[0].exitPrice).toBeLessThan(full.trades[0].exitPrice);
  });

  it("waits for the close back inside the band when reentry is required", async () => {
    const immediate = await run(bounce());
    const confirmed = await run(bounce(), { requireReentry: 1 });

    expect(immediate.trades[0].entryPrice).toBe(96);     // entered off bar 12
    expect(confirmed.trades[0].entryPrice).toBe(97.6);   // waited for bar 13 to close back inside
  });

  it("honours the direction switches", async () => {
    expect((await run(revert(), { allowLong: 0 })).trades).toHaveLength(0);
    expect((await run(revert(), { allowShort: 0 })).trades).toHaveLength(1);
  });
});

describe("vwap reversion — the volume half of the hypothesis", () => {
  it("refuses to trade when the window carried no volume at all", async () => {
    // VWAP is null without volume; substituting a plain average would hand the
    // strategy something that looks like VWAP and carries none of its meaning.
    const zeroVolume = revert().map((c) => ({ ...c, volume: 0 }));
    const result = await run(zeroVolume);

    expect(result.trades).toHaveLength(0);
    expect(result.orders).toHaveLength(0);
  });

  it("skips an excursion printed on heavy volume when a ceiling is set", async () => {
    const heavy = revert(0, 500);   // dip bar at 5x the average volume

    expect((await run(heavy)).trades).toHaveLength(1);
    expect((await run(heavy, { maxRelVolume: 2 })).trades).toHaveLength(0);
    expect((await run(heavy, { maxRelVolume: 6 })).trades).toHaveLength(1);
  });

  it("skips a quiet excursion when a volume floor is set", async () => {
    expect((await run(revert(), { minRelVolume: 2 })).trades).toHaveLength(0);
  });
});

describe("vwap reversion — band threshold", () => {
  it("fires off the deviation band when no percent floor is given", async () => {
    const near = await run(revert(), { entryPct: 0, entryBandMult: 0.5 });
    const far = await run(revert(), { entryPct: 0, entryBandMult: 20 });

    expect(near.trades).toHaveLength(1);
    expect(far.trades).toHaveLength(0);
  });

  it("still builds a band with a rolling anchor", async () => {
    // A rolling series is null for its first `vwapPeriod - 1` bars, so the
    // window has to carry the band period on top of the VWAP period. With only
    // `vwapPeriod` bars there is a single usable point, no band, and the bot
    // silently never trades.
    const result = await run(revert(), { vwapAnchor: "rolling", vwapPeriod: 5, bandPeriod: 5, entryPct: 0, entryBandMult: 0.5 });
    expect(result.trades).toHaveLength(1);
  });

  it("takes the wider of band and percent thresholds", async () => {
    // A huge band multiplier suppresses the signal even though the percent
    // floor alone would have fired it.
    expect((await run(revert(), { entryPct: 2, entryBandMult: 20 })).trades).toHaveLength(0);
  });
});

describe("vwap reversion — session window", () => {
  it("ignores an excursion outside the trading hours", async () => {
    // startHour 0 puts the dip at 12:00 UTC, well outside 03:00-06:00.
    const result = await run(revert(0), { sessionStartHour: 3, sessionEndHour: 6 });
    expect(result.trades).toHaveLength(0);
  });

  it("trades the same excursion when it falls inside the hours", async () => {
    // startHour 15 puts the dip at 03:00 UTC of the next day.
    const result = await run(revert(15), { sessionStartHour: 3, sessionEndHour: 6 });
    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].entryPrice).toBe(96);
  });

  it("flattens a position that never came back before the session ends", async () => {
    const result = await run(held(), { sessionStartHour: 3, sessionEndHour: 6 });

    expect(result.trades).toHaveLength(1);
    expect(result.trades[0].exitPrice).toBe(96);
    expect(result.positions).toHaveLength(0);
  });

  it("keeps the position past the session when the flatten is disabled", async () => {
    const result = await run(held(), { sessionStartHour: 3, sessionEndHour: 6, closeOutsideSession: 0 });
    expect(result.trades).toHaveLength(0);
    expect(result.positions).toHaveLength(1);
  });
});

describe("vwap reversion — risk sizing", () => {
  it("sizes from the risk fraction and the stop distance", async () => {
    const result = await run(revert(), { riskPct: 1, stopPct: 5 });
    // 1% of 1000 = 10 USDT of risk over a 4.75 stop distance (5% of 95).
    expect(result.trades[0].qty).toBeCloseTo(2.105, 3);
  });

  it("skips the trade when the sized quantity lands under the exchange minimum", async () => {
    const result = await run(revert(), { riskPct: 0.0001, minQty: 1 });
    expect(result.trades).toHaveLength(0);
  });

  it("caps the notional at the leverage limit", async () => {
    const capped = await run(revert(), { riskPct: 20, stopPct: 0.5, maxLeverage: 1 });
    // Risk sizing alone would ask for 42 units; 1x leverage allows 1000/95.
    expect(capped.trades[0].qty).toBeLessThanOrEqual(1000 / 95);
  });
});
