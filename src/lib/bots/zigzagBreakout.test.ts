import { describe, it, expect } from "vitest";
import { runBacktest } from "../execution/backtest/runner";
import type { BacktestCosts } from "../execution/backtest/runner";
import { getBotFactory } from "./registry";
import { zigzag, pivotsAsOf } from "../indicators/core";
import {
  visiblePivots,
  trendAgrees,
  parseZigzagBreakoutParams,
  zigzagBreakoutFactory,
} from "./zigzagBreakout";
import type { Candle } from "../types";
import type { SlippageSettings } from "../settings";

const NO_SLIP: SlippageSettings = { kind: "none", bps: 0, spreadPct: 0, impactK: 0, impactRefQty: 1 };

const SYMBOL = "TESTUSDT";
const DAY0 = Date.UTC(2024, 0, 1) / 1000;

interface Spec { o: number; h: number; l: number; c: number }

/** Hourly candles starting at 2024-01-01 00:00 UTC. */
function series(specs: Spec[]): Candle[] {
  return specs.map((s, i) => ({
    time: DAY0 + i * 3600,
    open: s.o, high: s.h, low: s.l, close: s.c, volume: 100,
  }));
}

const flat = (p: number): Spec => ({ o: p, h: p, l: p, c: p });

/**
 * The look-ahead fixture. A 10% ZigZag over it produces:
 *   low  @ bar 0  (100), confirmed at bar 3 — the rise through 112 is >10% off 100
 *   high @ bar 5  (120), confirmed at bar 9 — the fall to 106 is >10% off 120
 *
 * The wave is 100 → 120, so its length is 20. Bar 7 closes at 114, a
 * retracement of 6 = 0.30 of the wave: already past a 0.25 entry threshold.
 * A strategy reading the raw pivot list sees the bar-5 high at bar 7 and enters
 * there. A strategy filtering through `pivotsAsOf` cannot see that high until
 * bar 9 and enters one bar later, at a different price. The two are
 * distinguishable by the entry price alone, which is what the tests below use.
 */
const LOOKAHEAD: Candle[] = series([
  flat(100),                        // 0  wave origin (low pivot)
  flat(102),                        // 1
  flat(105),                        // 2
  flat(112),                        // 3  +12% off 100 → low@0 confirmed here
  flat(116),                        // 4
  flat(120),                        // 5  wave top — NOT a pivot yet
  flat(118),                        // 6  -1.7%
  flat(114),                        // 7  -5.0%; 0.30 of the wave — the naive trigger
  flat(113),                        // 8  -5.8%
  { o: 113, h: 113, l: 106, c: 106 }, // 9  -11.7% off 120 → high@5 confirmed HERE
  { o: 106, h: 107, l: 105, c: 106 }, // 10 entry fills at this open
  { o: 106, h: 117, l: 106, c: 117 }, // 11 target 116 hit
  flat(117),                        // 12
  flat(117),                        // 13
]);

/** Same setup, but price keeps falling after the pivot confirms — stop territory. */
const LOOKAHEAD_STOPOUT: Candle[] = series([
  flat(100), flat(102), flat(105), flat(112), flat(116), flat(120),
  flat(118), flat(114), flat(113),
  { o: 113, h: 113, l: 106, c: 106 },
  { o: 106, h: 106, l: 94, c: 94 },   // 10 entry at open 106, stop 96 taken out
  flat(94), flat(94),
]);

const BASE: Record<string, number | string> = {
  deviationPct: 10,
  lookbackBars: 400,
  entryMode: "pullback",
  pullbackFrac: 0.25,
  maxPullbackFrac: 1,
  tpFrac: 0.5,
  slFrac: 0.5,
  trendFilter: "none",
  riskPct: 1,
  maxLeverage: 5,
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
    bot: { id: "zz-test", kind: "zz-breakout", symbol: SYMBOL, params: { ...BASE, ...params }, status: "stopped" },
    initialBalance: 1000,
    feeRate: 0,
    slippageCfg: NO_SLIP,
    costs,
  });
}

describe("params", () => {
  it("is registered under zz-breakout", () => {
    expect(getBotFactory("zz-breakout")).toBe(zigzagBreakoutFactory);
  });

  it("parses the factory defaults into the documented values", () => {
    const p = parseZigzagBreakoutParams(zigzagBreakoutFactory.defaultParams);
    expect(p.deviationPct).toBe(1);
    expect(p.entryMode).toBe("pullback");
    expect(p.pullbackFrac).toBe(0.5);
    expect(p.tpFrac).toBe(0.5);
    expect(p.slFrac).toBe(0.5);
    expect(p.trendFilter).toBe("none");
    expect(p.trendSource).toBe("zigzag");
    expect(p.maxTradesPerPivot).toBe(1);
  });

  it("falls back to defaults on junk", () => {
    const p = parseZigzagBreakoutParams({ deviationPct: "abc", entryMode: "nope", trendFilter: "", slFrac: -3 });
    expect(p.deviationPct).toBe(1);
    expect(p.entryMode).toBe("pullback");
    expect(p.trendFilter).toBe("none");
    expect(p.slFrac).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// The one that matters: no look-ahead through ZigZag confirmation.
// ─────────────────────────────────────────────────────────────────────────────

describe("look-ahead — pivots may only be used once confirmed", () => {
  it("the fixture really does confirm the top several bars after it printed", () => {
    const raw = zigzag(LOOKAHEAD, 10);
    const top = raw.find((p) => p.index === 5);
    expect(top).toBeDefined();
    expect(top!.kind).toBe("high");
    expect(top!.price).toBe(120);
    // The gap between "the extreme happened" and "the market knew" is the trap.
    expect(top!.confirmedAt).toBe(9);
    expect(raw.find((p) => p.index === 0)?.confirmedAt).toBe(3);
  });

  it("visiblePivots hides the top until its confirmation bar", () => {
    const topTime = LOOKAHEAD[5].time;
    for (let i = 5; i <= 8; i++) {
      const seen = visiblePivots(LOOKAHEAD.slice(0, i + 1), 10);
      expect(seen.some((p) => p.time === topTime)).toBe(false);
    }
    for (let i = 9; i < LOOKAHEAD.length; i++) {
      const seen = visiblePivots(LOOKAHEAD.slice(0, i + 1), 10);
      expect(seen.some((p) => p.time === topTime)).toBe(true);
    }
  });

  it("visiblePivots equals the global pivotsAsOf filter at every bar", () => {
    const global = zigzag(LOOKAHEAD, 10);
    for (let i = 0; i < LOOKAHEAD.length; i++) {
      const local = visiblePivots(LOOKAHEAD.slice(0, i + 1), 10).map((p) => `${p.kind}@${p.time}`);
      const expected = pivotsAsOf(global, i).map((p) => `${p.kind}@${p.time}`);
      expect(local).toEqual(expected);
    }
  });

  it("never reports an unconfirmed trailing extreme as a pivot", () => {
    for (let i = 0; i < LOOKAHEAD.length; i++) {
      const seen = visiblePivots(LOOKAHEAD.slice(0, i + 1), 10);
      expect(seen.every((p) => p.confirmed && p.confirmedAt !== null)).toBe(true);
    }
  });

  it("the bot enters on the confirmation bar, not on the bar the level was first crossed", async () => {
    const result = await run(LOOKAHEAD);

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.side).toBe("buy");
    // Signal on bar 9 (pivot confirmed there) → market fills at bar 10's open.
    expect(trade.entryPrice).toBe(106);
    // The look-ahead version would have signalled on bar 7 and filled at bar 8's
    // open, 113. Asserting the price we did NOT get is the point of the test.
    expect(trade.entryPrice).not.toBe(113);
    // Target: entry ref 106 + 0.5 * wave 20 = 116.
    expect(trade.exitPrice).toBe(116);
  });

  it("brackets protect the very first bar of the trade", async () => {
    const result = await run(LOOKAHEAD_STOPOUT);

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.entryPrice).toBe(106);
    // Stop at 106 - 0.5 * 20 = 96, hit on the same bar the entry filled.
    expect(trade.exitPrice).toBe(96);
    expect(trade.pnl).toBeLessThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("entry rules", () => {
  it("does nothing while the retracement is short of the threshold", async () => {
    // 0.75 of a 20-point wave means price must close at or below 105; the
    // fixture's deepest close after the top is 106. Shorts are disabled because
    // the rally out of that low later confirms it as a pivot and opens a
    // perfectly valid short setup, which is not what this test is about.
    const result = await run(LOOKAHEAD, { pullbackFrac: 0.75, allowShort: 0 });
    expect(result.trades).toHaveLength(0);
    expect(result.positions).toHaveLength(0);
  });

  it("abandons the setup when price retraces past the cap", async () => {
    // The confirmation bar itself is already 0.70 of the wave down.
    const result = await run(LOOKAHEAD, { maxPullbackFrac: 0.6 });
    expect(result.trades).toHaveLength(0);
  });

  it("takes only one trade per pivot", async () => {
    const result = await run(LOOKAHEAD_STOPOUT, { maxTradesPerPivot: 1 });
    expect(result.trades).toHaveLength(1);
  });

  it("respects the direction switches", async () => {
    const result = await run(LOOKAHEAD, { allowLong: 0 });
    expect(result.trades).toHaveLength(0);
  });

  it("skips the setup when the wave is thinner than the minimum", async () => {
    // Wave 20 on a ~106 close is ~19% — a 25% floor rules it out.
    const result = await run(LOOKAHEAD, { minWavePct: 25 });
    expect(result.trades).toHaveLength(0);
  });

  it("expires a setup that has waited too long for its entry", async () => {
    const result = await run(LOOKAHEAD, { pullbackFrac: 0.9, maxBarsToEntry: 1 });
    expect(result.trades).toHaveLength(0);
  });

  it("refuses to start with a zero stop fraction", async () => {
    const result = await run(LOOKAHEAD, { slFrac: 0 });
    expect(result.trades).toHaveLength(0);
    expect(result.orders).toHaveLength(0);
  });
});

describe("breakout entry mode", () => {
  /**
   * Same wave and confirmation as LOOKAHEAD, but after the pullback price
   * climbs back through the old top at 120 instead of stopping at the pullback
   * target. Only a stop entry above the pivot should trade here.
   */
  const RETEST: Candle[] = series([
    flat(100), flat(102), flat(105), flat(112), flat(116), flat(120),
    flat(118), flat(114), flat(113),
    { o: 113, h: 113, l: 106, c: 106 },  // 9  high@5 confirmed
    { o: 106, h: 110, l: 106, c: 110 },  // 10
    { o: 110, h: 119, l: 110, c: 119 },  // 11 still under the trigger
    { o: 119, h: 124, l: 119, c: 124 },  // 12 breaks 120 → stop entry fills
    { o: 124, h: 132, l: 124, c: 132 },  // 13 target 130 hit
    flat(132),
  ]);

  it("waits for the level to break instead of buying the dip", async () => {
    const result = await run(RETEST, { entryMode: "breakout" });

    expect(result.trades).toHaveLength(1);
    const trade = result.trades[0];
    expect(trade.side).toBe("buy");
    // Stop entry at the pivot, 120; bar 12 opens at 119 so it fills at 120.
    expect(trade.entryPrice).toBe(120);
    // Target 120 + 0.5 * 20 = 130.
    expect(trade.exitPrice).toBe(130);
  });

  it("stays flat when the level is never re-broken", async () => {
    // LOOKAHEAD tops out at 117 after the pullback, short of the 120 pivot.
    const result = await run(LOOKAHEAD, { entryMode: "breakout" });
    expect(result.trades).toHaveLength(0);
    expect(result.positions).toHaveLength(0);
  });

  it("withdraws the re-break order once its budget runs out", async () => {
    // The order is placed on bar 9 and the break comes on bar 12; a one-bar
    // budget withdraws it on bar 11, before price ever reaches the level.
    const result = await run(RETEST, { entryMode: "breakout", maxBarsToEntry: 1 });
    expect(result.trades).toHaveLength(0);
    const entries = result.orders.filter((o) => o.type === "stop" && o.side === "buy");
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe("cancelled");
  });
});

describe("trendAgrees", () => {
  it("passes everything when disabled", () => {
    expect(trendAgrees([], [], "buy", "none")).toBe(true);
  });

  it("demands a higher high for a long and a lower low for a short", () => {
    expect(trendAgrees([100, 110], [], "buy", "highs")).toBe(true);
    expect(trendAgrees([110, 100], [], "buy", "highs")).toBe(false);
    expect(trendAgrees([], [100, 90], "sell", "highs")).toBe(true);
    expect(trendAgrees([], [90, 100], "sell", "highs")).toBe(false);
  });

  it("demands both structures agree in 'both' mode", () => {
    expect(trendAgrees([100, 110], [90, 95], "buy", "both")).toBe(true);
    expect(trendAgrees([100, 110], [95, 90], "buy", "both")).toBe(false);
  });

  it("blocks rather than passes when there is not enough structure", () => {
    expect(trendAgrees([100], [], "buy", "highs")).toBe(false);
    expect(trendAgrees([100, 110], [90], "buy", "both")).toBe(false);
  });
});

describe("trend filter in the loop", () => {
  it("blocks the first setup, which has no earlier high to compare against", async () => {
    const result = await run(LOOKAHEAD, { trendFilter: "highs" });
    expect(result.trades).toHaveLength(0);
  });
});

describe("position sizing", () => {
  it("risks the configured fraction of equity on the stop distance", async () => {
    const result = await run(LOOKAHEAD, { riskPct: 1, maxLeverage: 50 });
    // 1% of 1000 = 10 USDT over a 10-point stop → 1.0 unit.
    expect(result.trades[0].qty).toBeCloseTo(1, 9);
  });

  it("caps the notional by leverage", async () => {
    const result = await run(LOOKAHEAD, { riskPct: 5, maxLeverage: 1 });
    // Risk alone asks for 5 units; leverage 1 on 1000 equity at 106 allows 9.43,
    // so the risk figure stands — raise the risk to make leverage bite.
    expect(result.trades[0].qty).toBeCloseTo(5, 9);
    const capped = await run(LOOKAHEAD, { riskPct: 20, maxLeverage: 1 });
    expect(capped.trades[0].qty).toBeCloseTo(9.433, 3);
  });

  it("skips the trade when the size lands under the exchange minimum", async () => {
    const result = await run(LOOKAHEAD, { riskPct: 0.001, minQty: 1 });
    expect(result.trades).toHaveLength(0);
  });
});
