import { describe, expect, it } from "vitest";
import { DEFAULT_PORTFOLIO_PARAMS, groupBursts, runPortfolio } from "./cascadePortfolio";
import type { CascadeEvent } from "./cascadeCrossSection";

const MINUTE = 60;

/**
 * A synthetic event whose price path reverts by `revertBps` over `hold` bars.
 * `moveBps` sets the side: negative move means the strategy buys.
 */
function ev(opts: {
  symbol?: string;
  minute?: number;
  moveBps?: number;
  revertBps?: number;
  price?: number;
  hold?: number;
}): CascadeEvent {
  const symbol = opts.symbol ?? "BTCUSDT";
  const minute = opts.minute ?? 0;
  const moveBps = opts.moveBps ?? -100;
  const revert = opts.revertBps ?? 0;
  const price = opts.price ?? 100;
  const hold = opts.hold ?? 60;
  const dir = moveBps > 0 ? -1 : 1; // fade direction
  const path: number[] = [];
  for (let h = 0; h <= hold; h++) {
    const frac = hold === 0 ? 1 : h / hold;
    path.push(price * (1 + (dir * revert * frac) / 1e4));
  }
  return {
    symbol,
    time: minute * MINUTE,
    moveBps,
    thresholdBps: 90,
    triggerClose: price,
    volumeMult: 8,
    entryOpen: price,
    entryLow: price * 0.99,
    entryHigh: price * 1.01,
    fadeCloseBps: { 60: revert },
    fadeOpenBps: { 60: revert },
    path,
  };
}

const FREE = { feeBpsPerSide: 0, slippageBpsPerSide: 0 };

describe("groupBursts", () => {
  it("groups same-minute events", () => {
    const b = groupBursts([ev({ symbol: "A" }), ev({ symbol: "B" }), ev({ symbol: "C", minute: 500 })], 60);
    expect(b).toHaveLength(2);
    expect(b[0]).toHaveLength(2);
  });

  it("sorts by time regardless of input order", () => {
    const b = groupBursts([ev({ minute: 100 }), ev({ minute: 1 })], 60);
    expect(b[0][0].time).toBe(1 * MINUTE);
  });

  it("returns nothing for no events", () => {
    expect(groupBursts([], 60)).toEqual([]);
  });
});

describe("runPortfolio sizing and limits", () => {
  it("never exceeds the concurrency cap", () => {
    const burst = [0, 1, 2, 3, 4, 5].map((i) => ev({ symbol: `SYM${i}`, revertBps: 50 }));
    const r = runPortfolio(burst, { ...FREE, maxConcurrent: 3 });
    expect(r.trades).toHaveLength(3);
    expect(r.skips.slots).toBe(3);
  });

  it("takes the biggest movers first under the biggest rule", () => {
    const burst = [
      ev({ symbol: "SMALL", moveBps: -100, revertBps: 10 }),
      ev({ symbol: "BIG", moveBps: -500, revertBps: 10 }),
    ];
    const r = runPortfolio(burst, { ...FREE, maxConcurrent: 1, burstRule: "biggest" });
    expect(r.trades.map((t) => t.symbol)).toEqual(["BIG"]);
  });

  it("takes the smallest movers first under the smallest rule", () => {
    const burst = [
      ev({ symbol: "SMALL", moveBps: -100, revertBps: 10 }),
      ev({ symbol: "BIG", moveBps: -500, revertBps: 10 }),
    ];
    const r = runPortfolio(burst, { ...FREE, maxConcurrent: 1, burstRule: "smallest" });
    expect(r.trades.map((t) => t.symbol)).toEqual(["SMALL"]);
  });

  it("frees the slot once the hold expires", () => {
    const a = ev({ symbol: "AAAUSDT", minute: 0, revertBps: 50, hold: 60 });
    const b = ev({ symbol: "BBBUSDT", minute: 200, revertBps: 50, hold: 60 });
    const r = runPortfolio([a, b], { ...FREE, maxConcurrent: 1 });
    expect(r.trades).toHaveLength(2);
    expect(r.skips.slots).toBe(0);
  });

  it("does not open a second position on a symbol already held", () => {
    const a = ev({ symbol: "AAAUSDT", minute: 0, revertBps: 50 });
    const b = ev({ symbol: "AAAUSDT", minute: 10, revertBps: 50 });
    const r = runPortfolio([a, b], { ...FREE, maxConcurrent: 5 });
    expect(r.trades).toHaveLength(1);
    expect(r.skips.symbolBusy).toBe(1);
  });

  it("rejects a signal whose notional is below the instrument minimum", () => {
    // BTCUSDT needs 50 USDT; 1% of a 1000 USDT account is 10.
    const r = runPortfolio([ev({ symbol: "BTCUSDT", revertBps: 50, price: 60000 })], {
      ...FREE, notionalPct: 1,
    });
    expect(r.trades).toHaveLength(0);
    expect(r.skips.minNotional).toBe(1);
  });

  it("accepts the same signal once the notional clears the minimum", () => {
    const r = runPortfolio([ev({ symbol: "BTCUSDT", revertBps: 50, price: 60000 })], {
      ...FREE, notionalPct: 20,
    });
    expect(r.trades).toHaveLength(1);
  });

  it("caps gross exposure across open positions", () => {
    const burst = [0, 1, 2, 3].map((i) => ev({ symbol: `SYM${i}`, revertBps: 50 }));
    const r = runPortfolio(burst, { ...FREE, maxConcurrent: 4, notionalPct: 40, maxGrossPct: 100 });
    const gross = r.trades.reduce((s, t) => s + t.notional, 0);
    expect(gross).toBeLessThanOrEqual(1000 * 1.0001);
  });

  it("honours a per-trade notional cap", () => {
    const r = runPortfolio([ev({ symbol: "SOLUSDT", revertBps: 50 })], {
      ...FREE, notionalPct: 50, maxNotionalUsdt: 100,
    });
    expect(r.trades[0].notional).toBeLessThanOrEqual(100);
  });
});

describe("runPortfolio direction and pnl", () => {
  it("buys after a down move and profits when it reverts", () => {
    const r = runPortfolio([ev({ symbol: "SOLUSDT", moveBps: -300, revertBps: 100 })], FREE);
    expect(r.trades[0].side).toBe("buy");
    expect(r.trades[0].pnl).toBeGreaterThan(0);
  });

  it("sells after an up move and profits when it reverts", () => {
    const r = runPortfolio([ev({ symbol: "SOLUSDT", moveBps: 300, revertBps: 100 })], FREE);
    expect(r.trades[0].side).toBe("sell");
    expect(r.trades[0].pnl).toBeGreaterThan(0);
  });

  it("loses when the move continues", () => {
    const r = runPortfolio([ev({ symbol: "SOLUSDT", moveBps: -300, revertBps: -100 })], FREE);
    expect(r.trades[0].pnl).toBeLessThan(0);
  });

  it("turns a 10 bps gross edge into a loss under an 11 bps round trip", () => {
    const events = [0, 1, 2, 3, 4].map((i) =>
      ev({ symbol: `SYM${i}`, minute: i * 200, moveBps: -300, revertBps: 10 }),
    );
    const free = runPortfolio(events, { ...FREE, maxConcurrent: 1 });
    const paid = runPortfolio(events, { feeBpsPerSide: 5.5, maxConcurrent: 1 });
    expect(free.returnPct).toBeGreaterThan(0);
    expect(paid.returnPct).toBeLessThan(0);
  });

  it("charges slippage on both legs", () => {
    const e = ev({ symbol: "SOLUSDT", moveBps: -300, revertBps: 100 });
    const clean = runPortfolio([e], FREE);
    const slipped = runPortfolio([e], { ...FREE, slippageBpsPerSide: 20 });
    expect(slipped.trades[0].pnl).toBeLessThan(clean.trades[0].pnl);
  });

  it("applies the stress knobs on top of ordinary slippage", () => {
    const e = ev({ symbol: "SOLUSDT", moveBps: -300, revertBps: 100 });
    const base = runPortfolio([e], FREE);
    const stressed = runPortfolio([e], { ...FREE, stressEntryBps: 40, stressExitBps: 40 });
    expect(stressed.trades[0].entryPrice).toBeGreaterThan(base.trades[0].entryPrice);
    expect(stressed.trades[0].exitPrice).toBeLessThan(base.trades[0].exitPrice);
  });

  it("refuses a fill the entry bar never reached when a band is set", () => {
    const e = ev({ symbol: "SOLUSDT", moveBps: -300, revertBps: 100 });
    const r = runPortfolio([e], { ...FREE, stressEntryBps: 500, fillBandBps: 0 });
    expect(r.trades).toHaveLength(1);
    const banded = runPortfolio([e], { ...FREE, stressEntryBps: 500, fillBandBps: 0.0001 });
    expect(banded.trades).toHaveLength(0);
    expect(banded.skips.noFill).toBe(1);
  });

  it("honours direction switches", () => {
    const down = ev({ symbol: "SOLUSDT", moveBps: -300, revertBps: 100 });
    const up = ev({ symbol: "ADAUSDT", moveBps: 300, revertBps: 100 });
    const longsOnly = runPortfolio([down, up], { ...FREE, allowShort: false });
    expect(longsOnly.trades.map((t) => t.side)).toEqual(["buy"]);
    expect(longsOnly.skips.direction).toBe(1);
  });

  it("filters by minimum trigger size", () => {
    const small = ev({ symbol: "SOLUSDT", moveBps: -100, revertBps: 100 });
    const big = ev({ symbol: "ADAUSDT", moveBps: -400, revertBps: 100 });
    const r = runPortfolio([small, big], { ...FREE, minMoveBps: 200 });
    expect(r.trades.map((t) => t.symbol)).toEqual(["ADAUSDT"]);
    expect(r.skips.minMove).toBe(1);
  });

  it("skips an event whose path is shorter than the hold", () => {
    const e = ev({ symbol: "SOLUSDT", revertBps: 100, hold: 10 });
    const r = runPortfolio([e], { ...FREE, holdBars: 60 });
    expect(r.trades).toHaveLength(0);
    expect(r.skips.noPath).toBe(1);
  });
});

describe("runPortfolio reporting", () => {
  it("reports profit factor, win rate and edge in bps", () => {
    const events = [
      ev({ symbol: "SYM0", minute: 0, moveBps: -300, revertBps: 100 }),
      ev({ symbol: "SYM1", minute: 500, moveBps: -300, revertBps: -50 }),
    ];
    const r = runPortfolio(events, { ...FREE, maxConcurrent: 1 });
    expect(r.trades).toHaveLength(2);
    expect(r.winRate).toBeCloseTo(0.5, 6);
    expect(r.profitFactor).toBeCloseTo(2, 1);
    expect(r.grossEdgeBps).toBeCloseTo(25, 0);
  });

  it("separates gross from net edge once fees are paid", () => {
    const e = ev({ symbol: "SOLUSDT", moveBps: -300, revertBps: 100 });
    const r = runPortfolio([e], { feeBpsPerSide: 5.5 });
    expect(r.grossEdgeBps - r.netEdgeBps).toBeGreaterThan(10);
  });

  it("tracks drawdown off realized equity", () => {
    const events = [
      ev({ symbol: "SYM0", minute: 0, moveBps: -300, revertBps: -200 }),
      ev({ symbol: "SYM1", minute: 500, moveBps: -300, revertBps: 200 }),
    ];
    const r = runPortfolio(events, { ...FREE, maxConcurrent: 1 });
    expect(r.maxDrawdownPct).toBeGreaterThan(0);
  });

  it("measures how concentrated the profit is by day", () => {
    const events = [
      ev({ symbol: "SYM0", minute: 0, moveBps: -300, revertBps: 500 }),
      ev({ symbol: "SYM1", minute: 5000, moveBps: -300, revertBps: 1 }),
    ];
    const r = runPortfolio(events, { ...FREE, maxConcurrent: 1 });
    expect(r.topDayShare).toBeGreaterThan(0.9);
  });

  it("keeps a defaulted config trading perpetuals with taker fees", () => {
    expect(DEFAULT_PORTFOLIO_PARAMS.feeBpsPerSide).toBeCloseTo(5.5, 6);
    expect(DEFAULT_PORTFOLIO_PARAMS.initialEquity).toBe(1000);
  });

  it("returns a clean empty result for no events", () => {
    const r = runPortfolio([], FREE);
    expect(r.trades).toEqual([]);
    expect(r.equity).toBe(1000);
    expect(r.returnPct).toBe(0);
  });
});
