import { describe, it, expect } from "vitest";
import { runBacktest } from "../execution/backtest/runner";
import type { BacktestCosts } from "../execution/backtest/runner";
import { getBotFactory } from "./registry";
import {
  utcHour,
  inWindow,
  quantiseDown,
  parseCascadeParams,
  MoveQuantile,
  CascadeThreshold,
  cascadeReversionFactory,
} from "./cascadeReversion";
import type { Candle } from "../types";
import type { SlippageSettings } from "../settings";
import { DEFAULT_REJECTION_SETTINGS, makeStressWindow } from "../execution/rejection";

const NO_SLIP: SlippageSettings = { kind: "none", bps: 0, spreadPct: 0, impactK: 0, impactRefQty: 1 };

const SYMBOL = "TESTUSDT";
const DAY0 = Date.UTC(2024, 0, 1) / 1000;
const MIN = 60;

/** Minute candles starting at 2024-01-01 00:00 UTC. */
function series(closes: number[], volumes?: number[]): Candle[] {
  return closes.map((c, i) => {
    const prev = i === 0 ? c : closes[i - 1];
    return {
      time: DAY0 + i * MIN,
      open: prev,
      high: Math.max(prev, c),
      low: Math.min(prev, c),
      close: c,
      volume: volumes?.[i] ?? 100,
    };
  });
}

/** `n` bars of dead-flat price at `price`, so no bar can ever trigger. */
function flat(n: number, price: number): number[] {
  return Array.from({ length: n }, () => price);
}

/** Straight line from `from` (exclusive) to `to` in `bars` steps. */
function ramp(from: number, to: number, bars: number): number[] {
  return Array.from({ length: bars }, (_, i) => from + ((to - from) * (i + 1)) / bars);
}

/**
 * Quiet bars, one bar that moves `movePct`, then a recovery spread thin enough
 * that no single bar of it can trigger anything by itself.
 */
function cascade(opts: {
  lead: number;
  price: number;
  movePct: number;
  reboundPct: number;
  reboundBars: number;
  tail: number;
}): number[] {
  const { lead, price, movePct, reboundPct, reboundBars, tail } = opts;
  const shock = price * (1 + movePct / 100);
  const back = shock * (1 - (reboundPct / 100) * Math.sign(movePct));
  const out = flat(lead, price);
  out.push(shock);
  out.push(...ramp(shock, back, reboundBars));
  out.push(...flat(tail, back));
  return out;
}

/** The canonical fixture: a 2% drop after ten quiet bars, then a slow drift up. */
const DOWN_SHOCK = (tail = 10): number[] =>
  cascade({ lead: 10, price: 100, movePct: -2, reboundPct: 1, reboundBars: 5, tail });

/** The same shape the other way round. */
const UP_SHOCK = (tail = 10): number[] =>
  cascade({ lead: 10, price: 100, movePct: 2, reboundPct: 1, reboundBars: 5, tail });

const BASE: Record<string, number | string> = {
  thresholdMode: "fixed",
  thresholdBps: 100,
  moveBars: 1,
  direction: "fade",
  holdBars: 5,
  cooldownBars: 0,
  sizeMode: "notional",
  notionalPct: 100,
  maxLeverage: 3,
  minQty: 0.0001,
  qtyStep: 0.0001,
  stopMode: "none",
  targetMode: "none",
};

function run(
  candles: Candle[],
  params: Record<string, number | string> = {},
  costs: BacktestCosts = {},
) {
  return runBacktest({
    symbol: SYMBOL,
    candles,
    bot: { id: "cascade-test", kind: "cascade-mr", symbol: SYMBOL, params: { ...BASE, ...params }, status: "stopped" },
    initialBalance: 1000,
    feeRate: 0,
    slippageCfg: NO_SLIP,
    costs,
  });
}

describe("utcHour / inWindow", () => {
  it("reads the hour from the bar timestamp, not the host clock", () => {
    expect(utcHour(DAY0)).toBe(0);
    expect(utcHour(DAY0 + 7 * 3600)).toBe(7);
    expect(utcHour(-1)).toBe(23);
  });

  it("covers [start, end), wraps midnight, and start === end means all day", () => {
    expect(inWindow(DAY0 + 5 * 3600, 0, 6)).toBe(true);
    expect(inWindow(DAY0 + 6 * 3600, 0, 6)).toBe(false);
    for (const h of [22, 23, 0, 1]) expect(inWindow(DAY0 + h * 3600, 22, 2)).toBe(true);
    expect(inWindow(DAY0 + 13 * 3600, 5, 5)).toBe(true);
  });
});

describe("quantiseDown", () => {
  it("rounds down to the step and never up", () => {
    expect(quantiseDown(3.3337, 0.001)).toBe(3.333);
    expect(quantiseDown(0.0009, 0.001)).toBe(0);
    expect(quantiseDown(1.5, 0)).toBe(1.5);
  });
});

describe("params", () => {
  it("is registered under cascade-mr", () => {
    expect(getBotFactory("cascade-mr")).toBe(cascadeReversionFactory);
  });

  it("parses the factory defaults into the documented values", () => {
    const p = parseCascadeParams(cascadeReversionFactory.defaultParams);
    expect(p.thresholdMode).toBe("expanding");
    expect(p.percentile).toBeCloseTo(0.9999, 6);
    expect(p.lookbackBars).toBe(129_600);
    expect(p.holdBars).toBe(60);
    expect(p.stopMode).toBe("none");
    expect(p.direction).toBe("fade");
    expect(p.sizeMode).toBe("notional");
  });

  it("falls back to defaults on junk and clamps out-of-range values", () => {
    const p = parseCascadeParams({
      thresholdMode: "???", direction: "", stopMode: "x", sizeMode: "nope",
      percentile: 5, holdBars: -3, tradeStartHour: 26, moveBars: 0,
    });
    expect(p.thresholdMode).toBe("expanding");
    expect(p.direction).toBe("fade");
    expect(p.stopMode).toBe("none");
    expect(p.sizeMode).toBe("notional");
    expect(p.percentile).toBeLessThanOrEqual(0.999999);
    expect(p.holdBars).toBe(1);
    expect(p.moveBars).toBe(1);
    expect(p.tradeStartHour).toBe(2);
  });

  it("exposes every parameter of the params interface in paramSpec", () => {
    const keys = new Set(cascadeReversionFactory.paramSpec.map((s) => s.key));
    for (const key of Object.keys(cascadeReversionFactory.defaultParams)) {
      expect(keys.has(key), `paramSpec is missing ${key}`).toBe(true);
    }
  });
});

describe("MoveQuantile", () => {
  it("bins monotonically and reports an upper edge at least as large as the sample", () => {
    let last = -1;
    for (const bps of [0, 0.1, 5, 50, 199.9, 200, 500, 999, 1000, 4000, 9999]) {
      const bin = MoveQuantile.binOf(bps);
      expect(bin).toBeGreaterThanOrEqual(last);
      expect(MoveQuantile.edgeOf(bin)).toBeGreaterThanOrEqual(Math.min(bps, 5000));
      last = bin;
    }
  });

  it("matches a sorted quantile to within one bin width", () => {
    const q = new MoveQuantile();
    const values: number[] = [];
    // deterministic spread over the fine range
    for (let i = 0; i < 10_000; i++) {
      const v = ((i * 7919) % 10_000) / 50;   // 0 .. 200 bps
      values.push(v);
      q.add(v);
    }
    values.sort((a, b) => a - b);
    for (const p of [0.5, 0.9, 0.99, 0.999]) {
      const exact = values[Math.floor(p * values.length)];
      expect(Math.abs(q.quantileBps(p) - exact)).toBeLessThanOrEqual(0.5);
    }
  });

  it("removes samples again, so a rolling window forgets what left it", () => {
    const q = new MoveQuantile();
    for (let i = 0; i < 1000; i++) q.add(10);
    q.add(900);
    expect(q.size).toBe(1001);
    expect(q.quantileBps(0.9999)).toBeGreaterThan(500);
    q.remove(900);
    expect(q.size).toBe(1000);
    expect(q.quantileBps(0.9999)).toBeLessThan(50);
  });

  it("saturates rather than losing samples above the top bin", () => {
    const q = new MoveQuantile();
    q.add(1e9);
    expect(q.size).toBe(1);
    expect(Number.isFinite(q.quantileBps(0.5))).toBe(true);
  });
});

describe("CascadeThreshold — estimated from past bars only", () => {
  const params = (over: Record<string, number | string>) =>
    parseCascadeParams({ ...cascadeReversionFactory.defaultParams, ...over });

  it("offers nothing until the warm-up window has been observed", () => {
    const t = new CascadeThreshold(params({ thresholdMode: "rolling", lookbackBars: 500, percentile: 0.99 }));
    for (let i = 0; i < 499; i++) {
      expect(Number.isNaN(t.thresholdBps())).toBe(true);
      t.observe(10);
    }
    t.observe(10);
    expect(Number.isNaN(t.thresholdBps())).toBe(false);
  });

  it("big moves raise the threshold only for the bars that come after them", () => {
    const p = params({ thresholdMode: "rolling", lookbackBars: 200, percentile: 0.99, refreshBars: 1 });
    const t = new CascadeThreshold(p);
    for (let i = 0; i < 200; i++) t.observe(10);
    const before = t.thresholdBps();
    for (let i = 0; i < 5; i++) t.observe(800);
    const after = t.thresholdBps();
    expect(before).toBeLessThan(50);
    expect(after).toBeGreaterThan(500);
  });

  it("rolling forgets an old spike once it leaves the window, expanding never does", () => {
    const roll = new CascadeThreshold(params({ thresholdMode: "rolling", lookbackBars: 100, percentile: 0.99, refreshBars: 1 }));
    const grow = new CascadeThreshold(params({ thresholdMode: "expanding", percentile: 0.99, refreshBars: 1, warmupBars: 100 }));
    for (const t of [roll, grow]) {
      for (let i = 0; i < 5; i++) t.observe(800);
      for (let i = 0; i < 300; i++) t.observe(5);
    }
    expect(roll.thresholdBps()).toBeLessThan(50);
    expect(grow.thresholdBps()).toBeGreaterThan(500);
  });

  it("fixed mode ignores observations entirely", () => {
    const t = new CascadeThreshold(params({ thresholdMode: "fixed", thresholdBps: 77 }));
    expect(t.thresholdBps()).toBe(77);
    for (let i = 0; i < 1000; i++) t.observe(5000);
    expect(t.thresholdBps()).toBe(77);
  });

  it("sigma mode scales with the dispersion of the observed moves", () => {
    const quiet = new CascadeThreshold(params({ thresholdMode: "sigma", sigmaMult: 4, sigmaWindow: 200 }));
    const wild = new CascadeThreshold(params({ thresholdMode: "sigma", sigmaMult: 4, sigmaWindow: 200 }));
    for (let i = 0; i < 200; i++) {
      quiet.observe(i % 2 === 0 ? 5 : -5);
      wild.observe(i % 2 === 0 ? 50 : -50);
    }
    expect(wild.thresholdBps()).toBeGreaterThan(quiet.thresholdBps() * 9);
  });

  it("honours the min and max clamps", () => {
    const t = new CascadeThreshold(params({ thresholdMode: "fixed", thresholdBps: 10, minThresholdBps: 60, maxThresholdBps: 200 }));
    expect(t.thresholdBps()).toBe(60);
    const u = new CascadeThreshold(params({ thresholdMode: "fixed", thresholdBps: 900, maxThresholdBps: 200 }));
    expect(u.thresholdBps()).toBe(200);
  });
});

describe("cascade reversion — entry and exit", () => {
  it("buys after a large down bar and closes at the hold horizon", async () => {
    const result = await run(series(DOWN_SHOCK()));
    expect(result.trades.length).toBe(1);
    expect(result.trades[0].side).toBe("buy");
    expect(result.stats.netProfit).toBeGreaterThan(0);
  });

  it("sells after a large up bar", async () => {
    const result = await run(series(UP_SHOCK()));
    expect(result.trades.length).toBe(1);
    expect(result.trades[0].side).toBe("sell");
  });

  it("follow mode takes the opposite side of fade mode", async () => {
    const candles = series(DOWN_SHOCK());
    const fade = await run(candles, { direction: "fade" });
    const follow = await run(candles, { direction: "follow" });
    expect(fade.trades[0].side).toBe("buy");
    expect(follow.trades[0].side).toBe("sell");
  });

  it("respects allowLong / allowShort", async () => {
    expect((await run(series(DOWN_SHOCK()), { allowLong: 0 })).trades.length).toBe(0);
    expect((await run(series(DOWN_SHOCK()), { allowLong: 1 })).trades.length).toBe(1);
    expect((await run(series(UP_SHOCK()), { allowShort: 0 })).trades.length).toBe(0);
  });

  it("enters at the next bar open, never at the close that produced the signal", async () => {
    const candles = series(DOWN_SHOCK());
    const result = await run(candles);
    expect(result.trades[0].entryPrice).toBe(candles[11].open);
    expect(result.trades[0].entryTs).toBe(candles[11].time * 1000);
  });

  it("is exposed for exactly holdBars bars", async () => {
    for (const hold of [3, 7, 12]) {
      const result = await run(series(DOWN_SHOCK(40)), { holdBars: hold });
      expect(result.trades.length).toBe(1);
      const t = result.trades[0];
      // signal on bar 10, entry fills at the open of bar 11, exit is decided on
      // bar 10 + hold and fills at the open of bar 11 + hold
      expect((t.ts - t.entryTs) / 1000 / MIN).toBe(hold);
    }
  });

  it("does not trigger below the threshold", async () => {
    const closes = [...flat(10, 100), 99.5, ...flat(10, 99.5)];
    expect((await run(series(closes), { thresholdBps: 100 })).trades.length).toBe(0);
  });

  it("moveBars measures the move over several bars", async () => {
    // two 0.6% steps: neither triggers alone, together they clear 100 bps
    const closes = [...flat(10, 100), 99.4, 98.8, ...flat(20, 98.8)];
    expect((await run(series(closes), { moveBars: 1 })).trades.length).toBe(0);
    expect((await run(series(closes), { moveBars: 2 })).trades.length).toBe(1);
  });
});

describe("cascade reversion — filters", () => {
  it("cooldown suppresses a second trigger inside the window", async () => {
    const closes = [...flat(10, 100), 98, ...flat(3, 98), 96.04, ...flat(20, 96.04)];
    const hot = await run(series(closes), { cooldownBars: 0, holdBars: 2 });
    const cold = await run(series(closes), { cooldownBars: 500, holdBars: 2 });
    expect(hot.trades.length).toBe(2);
    expect(cold.trades.length).toBe(1);
  });

  it("the hour window keeps trades out of the excluded hours", async () => {
    const candles = series(DOWN_SHOCK());
    expect((await run(candles, { tradeStartHour: 0, tradeEndHour: 1 })).trades.length).toBe(1);
    expect((await run(candles, { tradeStartHour: 12, tradeEndHour: 13 })).trades.length).toBe(0);
  });

  it("the volume filter rejects a move that came on ordinary volume", async () => {
    const closes = [...flat(20, 100), 98, ...ramp(98, 99, 5), ...flat(10, 99)];
    const quiet = series(closes, closes.map(() => 100));
    const loud = series(closes, closes.map((_, i) => (i === 20 ? 900 : 100)));
    expect((await run(quiet, { minVolumeMult: 5, volumeWindow: 15 })).trades.length).toBe(0);
    expect((await run(loud, { minVolumeMult: 5, volumeWindow: 15 })).trades.length).toBe(1);
  });

  it("minMoveAtrMult rejects a move that is ordinary for the current volatility", async () => {
    const candles = series(DOWN_SHOCK());
    expect((await run(candles, { minMoveAtrMult: 0, atrPeriod: 5 })).trades.length).toBe(1);
    expect((await run(candles, { minMoveAtrMult: 50, atrPeriod: 5 })).trades.length).toBe(0);
  });

  it("maxTradesPerDay caps entries within a UTC day", async () => {
    let price = 100;
    const closes: number[] = [...flat(10, price)];
    for (let k = 0; k < 4; k++) {
      price *= 0.98;
      closes.push(price);
      closes.push(...flat(9, price));
    }
    closes.push(...flat(10, price));
    const candles = series(closes);
    const capped = await run(candles, { maxTradesPerDay: 2, holdBars: 3, cooldownBars: 0 });
    const free = await run(candles, { maxTradesPerDay: 0, holdBars: 3, cooldownBars: 0 });
    expect(capped.trades.length).toBe(2);
    expect(free.trades.length).toBe(4);
  });

  it("entryDelayBars postpones the entry by the requested number of bars", async () => {
    const candles = series(DOWN_SHOCK(30));
    const now = await run(candles, { entryDelayBars: 0 });
    const later = await run(candles, { entryDelayBars: 3 });
    expect((later.trades[0].entryTs - now.trades[0].entryTs) / 1000 / MIN).toBe(3);
  });

  it("a stop that is hit caps the loss the time exit would have taken", async () => {
    const candles = series([...flat(10, 100), 98, 97.6, 97.2, ...flat(25, 97.2)]);
    const noStop = await run(candles, { stopMode: "none", holdBars: 20 });
    const stopped = await run(candles, { stopMode: "pct", stopPct: 0.5, holdBars: 20 });
    expect(noStop.trades.length).toBe(1);
    expect(stopped.trades.length).toBe(1);
    expect(stopped.trades[0].pnl).toBeGreaterThan(noStop.trades[0].pnl);
  });

  it("a target that is reached closes the position early", async () => {
    const candles = series([...flat(10, 100), 98, ...ramp(98, 99, 5), ...flat(25, 99)]);
    const plain = await run(candles, { targetMode: "none", holdBars: 20 });
    const withTarget = await run(candles, { targetMode: "pct", targetPct: 0.5, holdBars: 20 });
    expect(withTarget.trades[0].ts).toBeLessThan(plain.trades[0].ts);
  });
});

describe("no look-ahead", () => {
  /**
   * The threshold is the one place this strategy could cheat: a quantile over the
   * whole series knows in advance which minutes turned out to be the largest and
   * would then admit exactly those. Rewriting every bar after the decision point
   * must leave every earlier decision untouched.
   */
  it("rewriting the future does not change any order placed before it", async () => {
    const head = [...flat(600, 100), 98, ...ramp(98, 99, 5), ...flat(45, 99)];
    const quietTail = flat(600, 99);
    const wildTail: number[] = [];
    let p = 99;
    for (let i = 0; i < 600; i++) {
      p *= i % 20 === 0 ? 1.05 : 0.999;
      wildTail.push(p);
    }

    const params = { thresholdMode: "rolling", lookbackBars: 500, percentile: 0.99, refreshBars: 1, holdBars: 5 };
    const a = await run(series([...head, ...quietTail]), params);
    const b = await run(series([...head, ...wildTail]), params);

    const cutoffMs = (DAY0 + head.length * MIN) * 1000;
    const before = (r: Awaited<ReturnType<typeof run>>) =>
      r.orders.filter((o) => o.ts < cutoffMs).map((o) => [o.side, o.type, o.qty, o.price, o.ts].join("|"));

    expect(before(a).length).toBeGreaterThan(0);
    expect(before(a)).toEqual(before(b));
  });

  it("the trigger bar itself is not part of the window that admitted it", async () => {
    // 500 quiet bars carrying a little noise, then one 3% drop. Were the trigger
    // bar folded into its own sample, the quantile would rise above the move.
    const noise = Array.from({ length: 500 }, (_, i) => 100 + (i % 5) * 0.01);
    const last = noise[noise.length - 1];
    const closes = [...noise, last * 0.97, ...flat(50, last * 0.97)];
    const result = await run(series(closes), {
      thresholdMode: "rolling", lookbackBars: 400, percentile: 0.99, refreshBars: 1, holdBars: 5,
    });
    expect(result.trades.length).toBe(1);
    expect(result.trades[0].side).toBe("buy");
  });

  it("an all-flat history never produces a trade, whatever the mode", async () => {
    for (const mode of ["rolling", "expanding", "sigma"]) {
      const result = await run(series(flat(3000, 100)), {
        thresholdMode: mode, lookbackBars: 500, sigmaWindow: 500, warmupBars: 500,
      });
      expect(result.trades.length, mode).toBe(0);
    }
  });

  it("nothing is traded until the warm-up window has been observed", async () => {
    const closes = [...flat(50, 100), 98, ...ramp(98, 99, 5), ...flat(600, 99), 97, ...flat(50, 97)];
    const result = await run(series(closes), {
      thresholdMode: "rolling", lookbackBars: 400, percentile: 0.99, refreshBars: 1, holdBars: 5,
    });
    // the first shock lands on bar 50, long before 400 bars have been observed
    expect(result.trades.length).toBe(1);
    expect(result.trades[0].entryTs).toBeGreaterThan((DAY0 + 400 * MIN) * 1000);
  });
});

describe("sizing", () => {
  it("notional sizing scales the position with equity and respects the leverage cap", async () => {
    const candles = series(DOWN_SHOCK());
    const small = await run(candles, { notionalPct: 50, maxLeverage: 10 });
    const large = await run(candles, { notionalPct: 200, maxLeverage: 10 });
    const capped = await run(candles, { notionalPct: 200, maxLeverage: 1 });
    expect(large.trades[0].qty).toBeCloseTo(small.trades[0].qty * 4, 3);
    expect(capped.trades[0].qty).toBeLessThan(large.trades[0].qty);
  });

  it("risk sizing without a stop is refused rather than sized as if a stop existed", async () => {
    const result = await run(series(DOWN_SHOCK()), { sizeMode: "risk", stopMode: "none", riskPct: 1 });
    expect(result.trades.length).toBe(0);
  });

  it("risk sizing with a stop puts riskPct of equity behind the stop distance", async () => {
    const result = await run(series(DOWN_SHOCK()), {
      sizeMode: "risk", stopMode: "pct", stopPct: 2, riskPct: 1, maxLeverage: 50,
    });
    expect(result.trades.length).toBe(1);
    const t = result.trades[0];
    expect(t.qty * t.entryPrice * 0.02).toBeCloseTo(1000 * 0.01, 1);
  });

  it("skips the trade when the sized quantity falls below the instrument minimum", async () => {
    const result = await run(series(DOWN_SHOCK()), { notionalPct: 1, minQty: 100, qtyStep: 1 });
    expect(result.trades.length).toBe(0);
  });
});

describe("costs", () => {
  it("fees turn a thin winner into a loser without changing the trade count", async () => {
    const candles = series(cascade({ lead: 10, price: 100, movePct: -2, reboundPct: 0.05, reboundBars: 5, tail: 5 }));
    const free = await run(candles);
    const paid = await runBacktest({
      symbol: SYMBOL,
      candles,
      bot: { id: "cascade-fee", kind: "cascade-mr", symbol: SYMBOL, params: { ...BASE }, status: "stopped" },
      initialBalance: 1000,
      feeRate: 0,
      slippageCfg: NO_SLIP,
      costs: { fees: { makerRate: 0.0002, takerRate: 0.00055 } },
    });
    expect(paid.trades.length).toBe(free.trades.length);
    expect(free.stats.netProfit).toBeGreaterThan(0);
    expect(paid.stats.netProfit).toBeLessThan(free.stats.netProfit);
  });
});

describe("stress windows", () => {
  /**
   * A market order is not guaranteed to execute: inside a cascade Bybit converts
   * it to an IOC limit in a price band and it can find nothing to match. The
   * position must not then be forgotten for another full holding period — the
   * exit has to be retried on the next bar.
   */
  it("retries the exit on the next bar when the book refuses it", async () => {
    const candles = series(DOWN_SHOCK(40));
    const plain = await run(candles, { holdBars: 5 });
    const exitBar = candles.find((c) => c.time * 1000 === plain.trades[0].ts)!;

    const blocked = await run(candles, { holdBars: 5 }, {
      rejection: {
        ...DEFAULT_REJECTION_SETTINGS,
        stressWindows: [makeStressWindow(exitBar.time, exitBar.time)],
      },
    });

    expect(blocked.trades.length).toBe(1);
    expect(blocked.trades[0].ts).toBe(plain.trades[0].ts + MIN * 1000);
  });

  it("refuses the entry outright when the band cannot be crossed", async () => {
    const candles = series(DOWN_SHOCK());
    const blocked = await run(candles, {}, {
      rejection: {
        ...DEFAULT_REJECTION_SETTINGS,
        stressWindows: [makeStressWindow(candles[0].time, candles[candles.length - 1].time)],
      },
    });
    expect(blocked.trades.length).toBe(0);
  });
});
