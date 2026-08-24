import { describe, it, expect } from "vitest";
import { BacktestClock } from "./clock";
import { BacktestVenueImpl } from "./BacktestVenue";
import type { BacktestVenueOptions } from "./BacktestVenue";
import type { Candle } from "../../types";
import type { SlippageSettings } from "../../settings";

const NO_SLIP: SlippageSettings = {
  kind: "none", bps: 0, spreadPct: 0, impactK: 0, impactRefQty: 1,
};

const FIXED_SLIP: SlippageSettings = {
  kind: "fixed_bps", bps: 10, spreadPct: 0, impactK: 0, impactRefQty: 1,
};

/** Distinct maker/taker rates so the charged fee identifies the role. */
const FEES = { makerRate: 0.001, takerRate: 0.01 };

const HOUR = 3600;

function flatBars(count: number, price: number, startSec = 0, stepSec = 60): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: startSec + i * stepSec,
    open: price, high: price, low: price, close: price, volume: 10,
  }));
}

function makeVenue(bars: Candle[], extra: Partial<BacktestVenueOptions> = {}) {
  const clock = new BacktestClock(bars);
  const venue = new BacktestVenueImpl({
    symbol: "BTCUSDT",
    initialBalance: 10_000,
    feeRate: 0,
    slippageCfg: NO_SLIP,
    clock,
    ...extra,
  });
  venue.init();
  return { clock, venue };
}

describe("fee role", () => {
  it("charges the maker rate on a resting limit", () => {
    // Bars sit at 100; a buy limit at 90 rests in the book until price drops.
    const bars = [...flatBars(2, 100), ...flatBars(1, 90, 120)];
    const { clock, venue } = makeVenue(bars, { fees: FEES });

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "limit", price: 90, qty: 1 });
    clock.step();
    clock.step();

    expect(venue.getOpenPositions()).toHaveLength(1);
    expect(venue.balance).toBeCloseTo(10_000 - 90 * 1 * FEES.makerRate, 9);
  });

  it("charges the taker rate on a limit priced through the market", () => {
    // Price is 100, buy limit at 110 crosses the book on arrival — it takes
    // liquidity, and it fills at the market, not at its own generous limit.
    const bars = flatBars(3, 100);
    const { clock, venue } = makeVenue(bars, { fees: FEES });

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "limit", price: 110, qty: 1 });
    clock.step();

    expect(venue.getOpenPositions()).toHaveLength(1);
    expect(venue.getOpenPositions()[0].entryPrice).toBe(100);
    expect(venue.balance).toBeCloseTo(10_000 - 100 * 1 * FEES.takerRate, 9);
  });

  it("charges the taker rate on a market order", () => {
    const bars = flatBars(3, 100);
    const { clock, venue } = makeVenue(bars, { fees: FEES });

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 1 });
    clock.step();

    expect(venue.balance).toBeCloseTo(10_000 - 100 * 1 * FEES.takerRate, 9);
  });

  it("falls back to the flat feeRate when no split rates are given", () => {
    const bars = flatBars(3, 100);
    const { clock, venue } = makeVenue(bars, { feeRate: 0.002 });

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 1 });
    clock.step();

    expect(venue.balance).toBeCloseTo(10_000 - 100 * 1 * 0.002, 9);
  });
});

describe("funding", () => {
  const events = [
    { timestamp: 2 * HOUR, rate: 0.0001 },
    { timestamp: 4 * HOUR, rate: 0.0001 },
    { timestamp: 6 * HOUR, rate: 0.0001 },
  ];
  // Bars every hour so each settlement falls strictly between two of them.
  const bars = flatBars(8, 100, 0, HOUR);

  it("charges a long when the rate is positive", () => {
    const { clock, venue } = makeVenue(bars, { funding: { events } });

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 2 });
    for (let i = 0; i < 7; i++) clock.step();

    // Three settlements on a 2 notional of 100 at 0.01% each.
    expect(venue.fundingTotal).toBeCloseTo(-3 * 2 * 100 * 0.0001, 9);
    expect(venue.balance).toBeCloseTo(10_000 + venue.fundingTotal, 9);
  });

  it("pays a short when the rate is positive", () => {
    const { clock, venue } = makeVenue(bars, { funding: { events } });

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "sell", type: "market", price: 0, qty: 2 });
    for (let i = 0; i < 7; i++) clock.step();

    expect(venue.fundingTotal).toBeCloseTo(3 * 2 * 100 * 0.0001, 9);
  });

  it("charges nothing while flat", () => {
    const { clock, venue } = makeVenue(bars, { funding: { events } });

    for (let i = 0; i < 8; i++) clock.step();

    expect(venue.fundingTotal).toBe(0);
  });

  it("charges nothing when no funding is configured", () => {
    const { clock, venue } = makeVenue(bars);

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 2 });
    for (let i = 0; i < 7; i++) clock.step();

    expect(venue.fundingTotal).toBe(0);
  });
});

describe("instrument rules", () => {
  const rules = { symbol: "BTCUSDT", minOrderQty: 0.001, qtyStep: 0.001, tickSize: 0.1, minNotional: 5 };

  it("rejects an order below the minimum size", () => {
    const bars = flatBars(3, 100);
    const { clock, venue } = makeVenue(bars, { rules });

    clock.step();
    const order = venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 0.0001 });
    clock.step();

    expect(order.status).toBe("cancelled");
    expect(venue.rejectedCount).toBe(1);
    expect(venue.getOpenPositions()).toHaveLength(0);
  });

  it("floors quantity onto the step", () => {
    const bars = flatBars(3, 100);
    const { clock, venue } = makeVenue(bars, { rules });

    clock.step();
    const order = venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 0.10349 });
    clock.step();

    expect(order.qty).toBeCloseTo(0.103, 9);
  });

  it("quantises a limit price against the order side", () => {
    const bars = flatBars(3, 100);
    const { clock, venue } = makeVenue(bars, { rules });

    clock.step();
    const order = venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "limit", price: 90.17, qty: 1 });

    expect(order.price).toBeCloseTo(90.1, 9);
  });
});

describe("slippage context", () => {
  const DEAD_HOUR_CFG = {
    enabled: true,
    deadHoursUtc: [3],
    deadHourMultiplier: 2,
    weekendMultiplier: 1,
    volatilityEnabled: false,
    volatilityRefPct: 0.2,
    volatilityMaxMultiplier: 1,
    maxMultiplier: 4,
  };

  function fillPriceAtHour(hourUtc: number, contextCfg?: typeof DEAD_HOUR_CFG): number {
    // 1970-01-01 is a Thursday, so plain hour offsets stay on a weekday.
    const bars = flatBars(3, 100, hourUtc * HOUR, 60);
    const { clock, venue } = makeVenue(bars, {
      slippageCfg: FIXED_SLIP,
      slippageContext: contextCfg,
    });

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 1 });
    clock.step();

    return venue.getOpenPositions()[0].entryPrice;
  }

  it("costs more in a dead hour than in a normal one", () => {
    const normal = fillPriceAtHour(12, DEAD_HOUR_CFG);
    const dead   = fillPriceAtHour(3,  DEAD_HOUR_CFG);

    expect(normal).toBeCloseTo(100 * 1.001, 9);          // 10 bps
    expect(dead).toBeCloseTo(100 * 1.002, 9);            // doubled
    expect(dead).toBeGreaterThan(normal);
  });

  it("applies no multiplier when the context is not configured", () => {
    expect(fillPriceAtHour(3)).toBeCloseTo(100 * 1.001, 9);
  });
});

describe("rejection", () => {
  const ALWAYS_REJECT = {
    enabled: true,
    slippageToleranceBps: 0,        // any slippage breaches the band
    baseRejectProb: 0,
    maxRejectProb: 0,
    volatilityRefPct: 0.2,
    volatilityMaxFactor: 1,
    limitFillProbability: 1,
    limitFullFillPenetrationBps: 5,
    stressWindows: [],
  };

  it("drops a market order that breaches the price band", () => {
    const bars = flatBars(3, 100);
    const { clock, venue } = makeVenue(bars, {
      slippageCfg: FIXED_SLIP,
      rejection: ALWAYS_REJECT,
    });

    clock.step();
    const order = venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 1 });
    clock.step();

    expect(order.status).toBe("cancelled");
    expect(venue.rejectedCount).toBe(1);
    expect(venue.getOpenPositions()).toHaveLength(0);
  });

  it("fills normally when no rejection model is configured", () => {
    const bars = flatBars(3, 100);
    const { clock, venue } = makeVenue(bars, { slippageCfg: FIXED_SLIP });

    clock.step();
    const order = venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 1 });
    clock.step();

    expect(order.status).toBe("filled");
    expect(venue.rejectedCount).toBe(0);
  });

  it("is reproducible across identical runs", () => {
    const cfg = { ...ALWAYS_REJECT, slippageToleranceBps: 50, baseRejectProb: 0.5, maxRejectProb: 0.5 };
    const outcomes = [0, 1].map(() => {
      const bars = flatBars(12, 100);
      const { clock, venue } = makeVenue(bars, { slippageCfg: FIXED_SLIP, rejection: cfg });
      clock.step();
      for (let i = 0; i < 10; i++) {
        venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 1 + i });
        clock.step();
      }
      return venue.rejectedCount;
    });

    expect(outcomes[0]).toBe(outcomes[1]);
  });
});

describe("reduce-only", () => {
  // Long entered at 100, then a take-profit at 105 and a stop at 95 both rest.
  // Bar 3 spans 88..110 and touches both.
  const bars: Candle[] = [
    { time: 0,   open: 100, high: 100, low: 100, close: 100, volume: 10 },
    { time: 60,  open: 100, high: 100, low: 100, close: 100, volume: 10 },
    { time: 120, open: 100, high: 110, low:  88, close: 100, volume: 10 },
    { time: 180, open: 100, high: 100, low: 100, close: 100, volume: 10 },
  ];

  function openLongThenBracket(reduceOnly: boolean) {
    const { clock, venue } = makeVenue(bars);
    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 1 });
    clock.step();                                     // filled at bar 1 open = 100
    venue.placeOrder({ symbol: "BTCUSDT", side: "sell", type: "limit", price: 105, qty: 1, reduceOnly });
    venue.placeOrder({ symbol: "BTCUSDT", side: "sell", type: "stop",  price: 95,  qty: 1, reduceOnly });
    clock.step();                                     // bar 2 touches both levels
    return venue;
  }

  it("does not open a phantom position when a bar hits both stop and target", () => {
    const venue = openLongThenBracket(true);

    expect(venue.getOpenPositions()).toHaveLength(0);
    expect(venue.getHistory()).toHaveLength(1);
  });

  it("leaves the phantom position without reduce-only, which is why it exists", () => {
    const venue = openLongThenBracket(false);

    // Documents the hazard: the second leg has nothing to close and opens a
    // short nobody asked for.
    expect(venue.getOpenPositions()).toHaveLength(1);
    expect(venue.getOpenPositions()[0].side).toBe("sell");
  });

  it("caps the fill at the open size instead of flipping", () => {
    const { clock, venue } = makeVenue(bars);
    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 1 });
    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "sell", type: "market", price: 0, qty: 5, reduceOnly: true });
    clock.step();

    expect(venue.getOpenPositions()).toHaveLength(0);
    expect(venue.getHistory()[0].qty).toBe(1);
  });

  it("drops a reduce-only order when nothing is open", () => {
    const { clock, venue } = makeVenue(bars);
    clock.step();
    const order = venue.placeOrder({ symbol: "BTCUSDT", side: "sell", type: "market", price: 0, qty: 1, reduceOnly: true });
    clock.step();

    expect(order.status).toBe("cancelled");
    expect(venue.getOpenPositions()).toHaveLength(0);
  });
});

describe("fills on a gapping bar", () => {
  it("executes a stop at the open when the bar gaps through it", () => {
    // Long at 100 with a stop at 95; next bar opens at 92, far below the stop.
    const bars: Candle[] = [
      { time: 0,   open: 100, high: 100, low: 100, close: 100, volume: 10 },
      { time: 60,  open: 100, high: 100, low: 100, close: 100, volume: 10 },
      { time: 120, open:  92, high:  93, low:  88, close:  90, volume: 10 },
    ];
    const { clock, venue } = makeVenue(bars);

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 1 });
    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "sell", type: "stop", price: 95, qty: 1, reduceOnly: true });
    clock.step();

    // Filling at 95 would pretend the gap could be traded through.
    expect(venue.getHistory()[0].exitPrice).toBe(92);
  });

  it("still uses the stop price when the bar opens above it", () => {
    const bars: Candle[] = [
      { time: 0,   open: 100, high: 100, low: 100, close: 100, volume: 10 },
      { time: 60,  open: 100, high: 100, low: 100, close: 100, volume: 10 },
      { time: 120, open:  99, high: 100, low:  90, close:  95, volume: 10 },
    ];
    const { clock, venue } = makeVenue(bars);

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 1 });
    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "sell", type: "stop", price: 95, qty: 1, reduceOnly: true });
    clock.step();

    expect(venue.getHistory()[0].exitPrice).toBe(95);
  });

  it("fills a resting limit at its own price", () => {
    const bars: Candle[] = [
      { time: 0,   open: 100, high: 100, low: 100, close: 100, volume: 10 },
      { time: 60,  open: 100, high: 100, low:  85, close: 100, volume: 10 },
    ];
    const { clock, venue } = makeVenue(bars);

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "limit", price: 90, qty: 1 });
    clock.step();

    expect(venue.getOpenPositions()[0].entryPrice).toBe(90);
  });
});

describe("fee attribution", () => {
  it("counts both entry and exit fees in the trade pnl", () => {
    const bars = flatBars(4, 100);
    const { clock, venue } = makeVenue(bars, { fees: FEES });

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 1 });
    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "sell", type: "market", price: 0, qty: 1 });
    clock.step();

    // Flat price: the whole loss is the two taker fees, not just the exit one.
    const expected = -2 * 100 * FEES.takerRate;
    expect(venue.getHistory()[0].pnl).toBeCloseTo(expected, 9);
  });

  it("keeps summed trade pnl equal to the balance change", () => {
    const bars = flatBars(6, 100);
    const { clock, venue } = makeVenue(bars, { fees: FEES });

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 2 });
    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "sell", type: "market", price: 0, qty: 2 });
    clock.step();

    const summed = venue.getHistory().reduce((s, t) => s + t.pnl, 0);
    expect(summed).toBeCloseTo(venue.balance - 10_000, 9);
  });

  it("charges a flip only for the part that closes", () => {
    const bars = flatBars(6, 100);
    const { clock, venue } = makeVenue(bars, { fees: FEES });

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 1 });
    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "sell", type: "market", price: 0, qty: 3 });
    clock.step();

    // Closing leg is 1 of the 3 sold: entry fee on 1 plus exit fee on 1.
    expect(venue.getHistory()[0].qty).toBe(1);
    expect(venue.getHistory()[0].pnl).toBeCloseTo(-2 * 100 * FEES.takerRate, 9);
    expect(venue.getOpenPositions()[0].qty).toBe(2);
  });
});

describe("rejected limits stay in the book", () => {
  const NEVER_FILLS = {
    enabled: true,
    slippageToleranceBps: 10_000,
    baseRejectProb: 0,
    maxRejectProb: 0,
    volatilityRefPct: 0.2,
    volatilityMaxFactor: 1,
    limitFillProbability: 0,        // queue never reaches the order
    limitFullFillPenetrationBps: 5,
    stressWindows: [],
  };

  it("keeps an unfilled limit pending instead of cancelling it", () => {
    // Bars touch the limit exactly: no penetration, so the queue decides.
    const bars: Candle[] = [
      { time: 0,   open: 100, high: 100, low: 100, close: 100, volume: 10 },
      { time: 60,  open: 100, high: 100, low:  90, close: 100, volume: 10 },
      { time: 120, open: 100, high: 100, low:  90, close: 100, volume: 10 },
    ];
    const { clock, venue } = makeVenue(bars, { rejection: NEVER_FILLS });

    clock.step();
    const order = venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "limit", price: 90, qty: 1 });
    clock.step();
    clock.step();

    expect(order.status).toBe("pending");
    expect(venue.rejectedCount).toBe(0);   // not a rejection, just no fill yet
  });
});

describe("margin and liquidation", () => {
  const MARGIN = { leverage: 5, maintenanceMarginRate: 0.005 };

  it("refuses an order beyond the leverage cap", () => {
    const bars = flatBars(3, 100);
    const { clock, venue } = makeVenue(bars, { margin: MARGIN });

    clock.step();
    // Equity 10 000 at 5x allows 50 000 notional; 600 x 100 is 60 000.
    const order = venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 600 });
    clock.step();

    expect(order.status).toBe("cancelled");
    expect(venue.getOpenPositions()).toHaveLength(0);
  });

  it("allows an order inside the cap", () => {
    const bars = flatBars(3, 100);
    const { clock, venue } = makeVenue(bars, { margin: MARGIN });

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 400 });
    clock.step();

    expect(venue.getOpenPositions()).toHaveLength(1);
  });

  it("liquidates when equity falls under the maintenance floor", () => {
    // 400 long at 100 on 10 000 equity: a drop to 75 wipes it out.
    const bars: Candle[] = [
      { time: 0,   open: 100, high: 100, low: 100, close: 100, volume: 10 },
      { time: 60,  open: 100, high: 100, low: 100, close: 100, volume: 10 },
      { time: 120, open:  95, high:  95, low:  74, close:  95, volume: 10 },
    ];
    const { clock, venue } = makeVenue(bars, { margin: MARGIN });

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 400 });
    clock.step();
    clock.step();

    expect(venue.liquidations).toBe(1);
    expect(venue.getOpenPositions()).toHaveLength(0);
    expect(venue.getHistory()).toHaveLength(1);
  });

  it("liquidates on an intrabar low even when the bar closes back above water", () => {
    // Close recovers to 100, but the wick to 74 already killed the account.
    const bars: Candle[] = [
      { time: 0,   open: 100, high: 100, low: 100, close: 100, volume: 10 },
      { time: 60,  open: 100, high: 100, low: 100, close: 100, volume: 10 },
      { time: 120, open: 100, high: 101, low:  74, close: 100, volume: 10 },
    ];
    const { clock, venue } = makeVenue(bars, { margin: MARGIN });

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 400 });
    clock.step();
    clock.step();

    expect(venue.liquidations).toBe(1);
  });

  it("cancels resting orders on liquidation", () => {
    const bars: Candle[] = [
      { time: 0,   open: 100, high: 100, low: 100, close: 100, volume: 10 },
      { time: 60,  open: 100, high: 100, low: 100, close: 100, volume: 10 },
      { time: 120, open: 100, high: 101, low:  74, close: 100, volume: 10 },
    ];
    const { clock, venue } = makeVenue(bars, { margin: MARGIN });

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 400 });
    clock.step();
    const resting = venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "limit", price: 50, qty: 1 });
    clock.step();

    expect(venue.liquidations).toBe(1);
    expect(resting.status).toBe("cancelled");
  });

  it("does not liquidate a comfortably funded position", () => {
    const bars: Candle[] = [
      { time: 0,   open: 100, high: 100, low: 100, close: 100, volume: 10 },
      { time: 60,  open: 100, high: 100, low: 100, close: 100, volume: 10 },
      { time: 120, open:  99, high: 100, low:  98, close:  99, volume: 10 },
    ];
    const { clock, venue } = makeVenue(bars, { margin: MARGIN });

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 10 });
    clock.step();
    clock.step();

    expect(venue.liquidations).toBe(0);
    expect(venue.getOpenPositions()).toHaveLength(1);
  });

  it("ignores margin entirely when not configured", () => {
    const bars = flatBars(3, 100);
    const { clock, venue } = makeVenue(bars);

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "market", price: 0, qty: 10_000 });
    clock.step();

    expect(venue.getOpenPositions()).toHaveLength(1);
    expect(venue.liquidations).toBe(0);
  });
});
