import { describe, it, expect } from "vitest";
import { runBacktest } from "../execution/backtest/runner";
import type { BacktestCosts } from "../execution/backtest/runner";
import { getBotFactory } from "./registry";
import { fractalAt, parseFractalWaveParams } from "./fractalWave";
import { fractals } from "../indicators/core";
import type { Candle } from "../types";
import type { SlippageSettings } from "../settings";

const NO_SLIP: SlippageSettings = { kind: "none", bps: 0, spreadPct: 0, impactK: 0, impactRefQty: 1 };

const SYMBOL = "TESTUSDT";
const T0 = Date.UTC(2024, 0, 1) / 1000;

interface Spec { o: number; h: number; l: number; c: number }

/** Minute candles starting at 2024-01-01 00:00 UTC. */
function series(specs: Spec[]): Candle[] {
  return specs.map((s, i) => ({
    time: T0 + i * 60,
    open: s.o, high: s.h, low: s.l, close: s.c, volume: 100,
  }));
}

/**
 * Fixture shared by every execution test, with fractalN = 1 so the pivots can be
 * read off by eye.
 *
 * bar 1 is a high fractal (110, confirmed on bar 2) and bar 2 is a low fractal
 * (90, confirmed on bar 3). Wave = 20. On bar 3 price closes at 101, i.e. 11
 * above the anchor low — more than the 0.5 wave the default entry asks for — so
 * bar 3 is the signal bar and the entry fills at bar 4's open.
 */
const SETUP: Spec[] = [
  { o: 100, h: 102, l: 98,  c: 100 },
  { o: 100, h: 110, l: 99,  c: 108 },
  { o: 108, h: 105, l: 90,  c: 92  },
  { o: 92,  h: 102, l: 92,  c: 101 },
];

const tail = (n: number, p: number): Spec[] =>
  Array.from({ length: n }, () => ({ o: p, h: p, l: p, c: p }));

/**
 * Short windows and a 1% risk keep the arithmetic hand-checkable: equity 1000,
 * stop 10 away from a 101 entry, so every fixture trades exactly 1 unit.
 * The trend filter is off by default here — the fixture is four bars long and
 * has no second pair of pivots to confirm anything with.
 */
const BASE: Record<string, number | string> = {
  fractalN: 1,
  entryFrac: 0.5,
  tpFrac: 1,
  slFrac: 0.5,
  stopMode: "wave",
  trailStartFrac: 0,
  trailDistFrac: 0.5,
  trailStepFrac: 0.01,
  trailAnchor: "close",
  trendFilter: "off",
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
    bot: { id: "fw-test", kind: "fractal-wave", symbol: SYMBOL, params: { ...BASE, ...params }, status: "stopped" },
    initialBalance: 1000,
    feeRate: 0,
    slippageCfg: NO_SLIP,
    costs,
  });
}

describe("registry", () => {
  it("exposes the fractal wave bot", () => {
    const factory = getBotFactory("fractal-wave");
    expect(factory?.kind).toBe("fractal-wave");
    expect(factory?.paramSpec.map((s) => s.key)).toContain("trailStartFrac");
  });
});

describe("parseFractalWaveParams", () => {
  it("fills the author's defaults", () => {
    const p = parseFractalWaveParams({});
    expect(p.fractalN).toBe(2);
    expect(p.entryFrac).toBe(0.5);
    expect(p.tpFrac).toBe(1);
    expect(p.slFrac).toBe(0.5);
    expect(p.trendFilter).toBe("both");
    expect(p.stopMode).toBe("wave");
    expect(p.trailAnchor).toBe("close");
  });

  it("clamps nonsense instead of trusting it", () => {
    const p = parseFractalWaveParams({
      fractalN: 0, entryFrac: -1, slFrac: -2, riskPct: -5,
      stopMode: "sideways", trendFilter: "vibes", trailAnchor: "??",
    });
    expect(p.fractalN).toBe(1);
    expect(p.entryFrac).toBe(0);
    expect(p.slFrac).toBe(0);
    expect(p.riskPct).toBe(0);
    expect(p.stopMode).toBe("wave");
    expect(p.trendFilter).toBe("both");
    expect(p.trailAnchor).toBe("close");
  });
});

describe("fractalAt", () => {
  it("agrees with fractals() bar for bar", () => {
    // Deterministic pseudo-random walk: the point is a series with plenty of
    // ties and equal highs, where a strict-inequality bug shows up.
    let seed = 12345;
    const rnd = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed / 2147483648;
    };
    const bars: Candle[] = [];
    let price = 100;
    for (let i = 0; i < 400; i++) {
      price += Math.round((rnd() - 0.5) * 6);
      const high = price + Math.round(rnd() * 3);
      const low = price - Math.round(rnd() * 3);
      bars.push({ time: T0 + i * 60, open: price, high, low, close: price, volume: 1 });
    }

    for (const n of [1, 2, 3]) {
      const expected = fractals(bars, n);
      const gotHighs: number[] = [];
      const gotLows: number[] = [];
      for (let i = 2 * n; i < bars.length; i++) {
        const f = fractalAt(bars.slice(i - 2 * n, i + 1), n);
        if (f.high) gotHighs.push(i - n);
        if (f.low) gotLows.push(i - n);
      }
      expect(gotHighs).toEqual(expected.highs);
      expect(gotLows).toEqual(expected.lows);
    }
  });

  it("refuses a window that is not exactly 2n+1 long", () => {
    const bars = series([{ o: 1, h: 5, l: 1, c: 1 }, { o: 1, h: 9, l: 0, c: 1 }]);
    expect(fractalAt(bars, 1)).toEqual({ high: false, low: false });
  });
});

describe("entry", () => {
  it("takes the wave once price has walked far enough from the anchor pivot", async () => {
    const r = await run(series([...SETUP, { o: 101, h: 103, l: 100, c: 102 }, ...tail(2, 102)]));
    const entry = r.orders.find((o) => o.type === "market" && o.side === "buy");
    expect(entry?.status).toBe("filled");
    expect(entry?.filledPrice).toBe(101);   // next bar's open, not the signal close
    expect(entry?.qty).toBeCloseTo(1, 6);   // 1% of 1000 over a stop 10 wide
  });

  it("stays out when the walk is shorter than entryFrac of the wave", async () => {
    // 11 of a 20 wave is 0.55; asking for 0.8 leaves the setup untraded.
    const r = await run(series([...SETUP, ...tail(3, 101)]), { entryFrac: 0.8 });
    expect(r.orders.filter((o) => o.type === "market")).toHaveLength(0);
    expect(r.trades).toHaveLength(0);
  });

  it("stays out when the wave is thinner than minWavePct", async () => {
    // Wave 20 on a 101 close is 19.8% — a 25% floor rejects it.
    const r = await run(series([...SETUP, ...tail(3, 101)]), { minWavePct: 25 });
    expect(r.orders.filter((o) => o.type === "market")).toHaveLength(0);
  });

  it("brackets the entry with a stop and a target before the fill", async () => {
    const r = await run(series([...SETUP, ...tail(3, 101)]));
    const stop = r.orders.find((o) => o.type === "stop");
    const target = r.orders.find((o) => o.type === "limit");
    expect(stop?.price).toBeCloseTo(91, 6);     // 101 - 0.5 x 20
    expect(target?.price).toBeCloseTo(121, 6);  // 101 + 1.0 x 20
    expect(stop?.ts).toBeLessThanOrEqual(r.orders.find((o) => o.type === "market")!.ts);
  });

  it("puts the stop beyond the anchor pivot in pivot mode", async () => {
    const r = await run(series([...SETUP, ...tail(3, 101)]), { stopMode: "pivot", slFrac: 0.1 });
    const stop = r.orders.find((o) => o.type === "stop");
    expect(stop?.price).toBeCloseTo(88, 6);     // low pivot 90 - 0.1 x 20
  });

  it("trades one anchor once, however long price hangs above it", async () => {
    const r = await run(series([...SETUP, ...tail(6, 101)]));
    expect(r.orders.filter((o) => o.type === "market" && o.side === "buy")).toHaveLength(1);
  });

  it("honours allowLong / allowShort", async () => {
    const r = await run(series([...SETUP, ...tail(3, 101)]), { allowLong: 0 });
    expect(r.orders.filter((o) => o.type === "market")).toHaveLength(0);
  });
});

describe("exits", () => {
  it("takes profit at the target", async () => {
    const r = await run(series([
      ...SETUP,
      { o: 101, h: 125, l: 100, c: 122 },
      ...tail(2, 122),
    ]));
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].exitPrice).toBeCloseTo(121, 6);
    expect(r.trades[0].pnl).toBeCloseTo(20, 6);
    expect(r.positions).toHaveLength(0);
  });

  it("stops out at the stop", async () => {
    const r = await run(series([
      ...SETUP,
      { o: 101, h: 102, l: 88, c: 89 },
      ...tail(2, 89),
    ]));
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].exitPrice).toBeCloseTo(91, 6);
    expect(r.trades[0].pnl).toBeCloseTo(-10, 6);
  });

  it("takes the loss, not a phantom position, when one bar covers both brackets", async () => {
    // Stop 91 and target 121 both inside the bar. Nothing in OHLC says which
    // came first, so the run must take the worse one — and the reduce-only
    // target must die rather than open a fresh short.
    const r = await run(series([
      ...SETUP,
      { o: 101, h: 125, l: 88, c: 120 },
      ...tail(2, 120),
    ]));
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].pnl).toBeCloseTo(-10, 6);
    expect(r.positions).toHaveLength(0);
  });

  it("flattens at market after maxBarsInTrade", async () => {
    const r = await run(series([
      ...SETUP,
      { o: 101, h: 103, l: 100, c: 102 },
      { o: 102, h: 103, l: 100, c: 103 },
      { o: 104, h: 105, l: 103, c: 104 },
      ...tail(2, 104),
    ]), { maxBarsInTrade: 2 });
    expect(r.trades).toHaveLength(1);
    // Entry on bar 3 fills at bar 4's open; the exit is decided on bar 5 and
    // fills at bar 6's open.
    expect(r.trades[0].exitPrice).toBeCloseTo(104, 6);
  });
});

describe("trailing stop", () => {
  // Shorts off: the pullback that trips the trailing stop also builds a fresh
  // down-leg setup, and a second trade would blur what these fixtures assert.
  const TRAIL = { trailStartFrac: 0.25, trailDistFrac: 0.25, tpFrac: 0, allowShort: 0 };

  it("ratchets the stop behind price and exits there", async () => {
    const r = await run(series([
      ...SETUP,
      { o: 101, h: 112, l: 100, c: 110 },   // best 110: stop moves 91 -> 105
      { o: 108, h: 109, l: 100, c: 101 },   // dips through 105
      ...tail(2, 101),
    ]), TRAIL);

    const stops = r.orders.filter((o) => o.type === "stop");
    expect(stops.map((o) => o.price)).toEqual([91, 105]);
    expect(stops[0].status).toBe("cancelled");
    expect(r.trades).toHaveLength(1);
    expect(r.trades[0].exitPrice).toBeCloseTo(105, 6);
    expect(r.trades[0].pnl).toBeCloseTo(4, 6);   // the original stop would have lost 10
  });

  it("leaves the stop alone until the move pays for the trigger", async () => {
    const r = await run(series([
      ...SETUP,
      { o: 101, h: 105, l: 100, c: 104 },   // only 3 of the 5 the trigger wants
      ...tail(3, 104),
    ]), TRAIL);
    expect(r.orders.filter((o) => o.type === "stop").map((o) => o.price)).toEqual([91]);
  });

  it("never walks the stop backwards", async () => {
    const r = await run(series([
      ...SETUP,
      { o: 101, h: 112, l: 100, c: 110 },   // stop -> 105
      { o: 110, h: 111, l: 106, c: 107 },   // best still 110, no new stop
      { o: 107, h: 115, l: 106, c: 114 },   // best 114, stop -> 109
      ...tail(2, 114),
    ]), TRAIL);
    expect(r.orders.filter((o) => o.type === "stop").map((o) => o.price)).toEqual([91, 105, 109]);
  });

  it("follows bar extremes instead of closes when asked", async () => {
    const r = await run(series([
      ...SETUP,
      { o: 101, h: 115, l: 100, c: 106 },   // extreme 115 -> stop 110; close 106 -> stop 101
      ...tail(3, 106),
    ]), { ...TRAIL, trailAnchor: "extreme" });
    expect(r.orders.filter((o) => o.type === "stop").map((o) => o.price)).toEqual([91, 110]);
  });

  it("is switched off by trailStartFrac 0", async () => {
    const r = await run(series([
      ...SETUP,
      { o: 101, h: 112, l: 100, c: 110 },
      ...tail(3, 110),
    ]), { ...TRAIL, trailStartFrac: 0 });
    expect(r.orders.filter((o) => o.type === "stop")).toHaveLength(1);
  });
});

describe("trend filter", () => {
  /**
   * Two full swings. Highs 110 then 118, lows 90 then 100 — both rising, so an
   * uptrend by every reading of the filter. The second setup is the one being
   * tested; the first exists only to give the filter a previous pivot.
   */
  const RISING: Spec[] = [
    { o: 100, h: 102, l: 98,  c: 100 },
    { o: 100, h: 110, l: 99,  c: 108 },   // high pivot 110
    { o: 108, h: 105, l: 90,  c: 92  },   // low pivot 90
    { o: 92,  h: 104, l: 92,  c: 103 },
    { o: 103, h: 118, l: 103, c: 116 },   // high pivot 118
    { o: 116, h: 117, l: 100, c: 102 },   // low pivot 100
    { o: 102, h: 112, l: 102, c: 111 },   // 11 above the anchor, wave 18
  ];

  /**
   * Highs 120 then 110, lows 100 then 80 — a downtrend by both pairs. Price
   * then walks up 16 of the 30-wide wave off the 80 low, which is a long signal
   * on bar 8 and one the filter is supposed to refuse. Shorts are disabled so
   * the leg down to 80 does not open a trade of its own on the way.
   */
  const FALLING: Spec[] = [
    { o: 108, h: 112, l: 105, c: 110 },
    { o: 110, h: 120, l: 108, c: 118 },   // high pivot 120
    { o: 118, h: 115, l: 100, c: 102 },   // low pivot 100
    { o: 102, h: 108, l: 101, c: 105 },
    { o: 105, h: 110, l: 104, c: 106 },   // high pivot 110 (lower high)
    { o: 106, h: 107, l: 90,  c: 92  },
    { o: 92,  h: 95,  l: 80,  c: 82  },   // low pivot 80 (lower low)
    { o: 82,  h: 90,  l: 84,  c: 88  },
    { o: 88,  h: 98,  l: 87,  c: 96  },   // 16 above the anchor, wave 30
  ];

  it("lets a long through when both pivot pairs rise", async () => {
    const r = await run(series([...RISING, ...tail(3, 111)]), { trendFilter: "both" });
    expect(r.orders.filter((o) => o.type === "market" && o.side === "buy")).toHaveLength(1);
  });

  it("blocks a long when the pivots point the other way", async () => {
    const r = await run(series([...FALLING, ...tail(3, 96)]), { trendFilter: "both", allowShort: 0 });
    expect(r.orders.filter((o) => o.type === "market")).toHaveLength(0);
  });

  it("takes the same setup once the filter is off", async () => {
    const r = await run(series([...FALLING, ...tail(3, 96)]), { trendFilter: "off", allowShort: 0 });
    const entries = r.orders.filter((o) => o.type === "market" && o.side === "buy");
    expect(entries).toHaveLength(1);
    expect(entries[0].filledPrice).toBe(96);
  });

  it("needs a previous pivot pair before it can confirm anything", async () => {
    // The four-bar fixture has exactly one high and one low, so "both" has
    // nothing to compare against and must refuse rather than assume a trend.
    const r = await run(series([...SETUP, ...tail(3, 101)]), { trendFilter: "both" });
    expect(r.orders.filter((o) => o.type === "market")).toHaveLength(0);
  });
});

describe("shorts", () => {
  /**
   * Mirror of SETUP: bar 1 is a low fractal (90), bar 2 a high fractal (110),
   * wave 20, and bar 3 closes 11 below the anchor high.
   */
  const SHORT_SETUP: Spec[] = [
    { o: 100, h: 102, l: 98,  c: 100 },
    { o: 100, h: 101, l: 90,  c: 92  },
    { o: 92,  h: 110, l: 95,  c: 108 },
    { o: 108, h: 108, l: 98,  c: 99  },
  ];

  it("sells the down leg with mirrored brackets", async () => {
    const r = await run(series([...SHORT_SETUP, { o: 99, h: 100, l: 78, c: 79 }, ...tail(2, 79)]));
    const entry = r.orders.find((o) => o.type === "market" && o.side === "sell");
    expect(entry?.filledPrice).toBe(99);
    expect(r.orders.find((o) => o.type === "stop")?.price).toBeCloseTo(109, 6);
    expect(r.orders.find((o) => o.type === "limit")?.price).toBeCloseTo(79, 6);
    expect(r.trades[0].side).toBe("sell");
    expect(r.trades[0].pnl).toBeCloseTo(20, 6);
  });
});
