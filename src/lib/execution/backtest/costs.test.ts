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
    // Price is 100, buy limit at 110 crosses the book on arrival.
    const bars = flatBars(3, 100);
    const { clock, venue } = makeVenue(bars, { fees: FEES });

    clock.step();
    venue.placeOrder({ symbol: "BTCUSDT", side: "buy", type: "limit", price: 110, qty: 1 });
    clock.step();

    expect(venue.getOpenPositions()).toHaveLength(1);
    expect(venue.balance).toBeCloseTo(10_000 - 110 * 1 * FEES.takerRate, 9);
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
