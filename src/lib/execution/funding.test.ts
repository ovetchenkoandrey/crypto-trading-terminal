import { describe, it, expect } from "vitest";
import {
  DEFAULT_FUNDING_INTERVAL_MINUTES,
  annualizeFundingRate,
  computeFunding,
  fundingEventsFromBybit,
  fundingSchedule,
  netPnlAfterFunding,
  type FundingPosition,
  type FundingRateEvent,
} from "./funding";

const H8 = 8 * 3600 * 1000;
const DAY = 24 * 3600 * 1000;
const T0 = Date.UTC(2026, 0, 1, 0, 0, 0);

/** Settlements at 00:00 / 08:00 / 16:00 UTC across two days. */
function history(rate: number, count = 6): FundingRateEvent[] {
  return Array.from({ length: count }, (_, i) => ({ timestamp: T0 + i * H8, rate }));
}

const longOneAtHundred: FundingPosition = {
  side: "buy", qty: 1, price: 100, openedAt: T0, closedAt: T0 + DAY,
};

describe("computeFunding — count of settlements", () => {
  it("a position held for a day pays three times at the 8h interval", () => {
    const r = computeFunding(longOneAtHundred, history(0.0001));
    expect(r.count).toBe(3);
    expect(r.payments.map((p) => p.timestamp)).toEqual([T0 + H8, T0 + 2 * H8, T0 + 3 * H8]);
  });

  it("a settlement exactly at the open is not paid, one exactly at the close is", () => {
    const r = computeFunding(longOneAtHundred, history(0.0001));
    expect(r.payments.some((p) => p.timestamp === T0)).toBe(false);
    expect(r.payments.some((p) => p.timestamp === T0 + DAY)).toBe(true);
  });

  it("a 4h interval instrument pays six times over the same day", () => {
    const events = Array.from({ length: 12 }, (_, i) => ({ timestamp: T0 + i * 4 * 3600_000, rate: 0.0001 }));
    const r = computeFunding(longOneAtHundred, events, { intervalMinutes: 240 });
    expect(r.count).toBe(6);
  });

  it("a position closed inside the first interval pays nothing", () => {
    const r = computeFunding({ ...longOneAtHundred, closedAt: T0 + 3600_000 }, history(0.0001));
    expect(r.count).toBe(0);
    expect(r.total).toBe(0);
  });

  it("three days of holding pays nine times", () => {
    const events = Array.from({ length: 12 }, (_, i) => ({ timestamp: T0 + i * H8, rate: 0.0001 }));
    const r = computeFunding({ ...longOneAtHundred, closedAt: T0 + 3 * DAY }, events);
    expect(r.count).toBe(9);
  });
});

describe("computeFunding — sign", () => {
  it("long pays on a positive rate", () => {
    const r = computeFunding(longOneAtHundred, history(0.0001));
    expect(r.total).toBeCloseTo(-0.03, 10);
    expect(r.paid).toBeCloseTo(0.03, 10);
    expect(r.received).toBe(0);
    expect(r.payments.every((p) => p.amount < 0)).toBe(true);
  });

  it("short receives on a positive rate", () => {
    const r = computeFunding({ ...longOneAtHundred, side: "sell" }, history(0.0001));
    expect(r.total).toBeCloseTo(0.03, 10);
    expect(r.received).toBeCloseTo(0.03, 10);
    expect(r.paid).toBe(0);
  });

  it("long receives on a negative rate", () => {
    const r = computeFunding(longOneAtHundred, history(-0.0001));
    expect(r.total).toBeCloseTo(0.03, 10);
  });

  it("short pays on a negative rate", () => {
    const r = computeFunding({ ...longOneAtHundred, side: "sell" }, history(-0.0001));
    expect(r.total).toBeCloseTo(-0.03, 10);
  });

  it("mixed rates net out and paid/received are tracked separately", () => {
    const events: FundingRateEvent[] = [
      { timestamp: T0 + H8, rate: 0.0002 },
      { timestamp: T0 + 2 * H8, rate: -0.0001 },
      { timestamp: T0 + 3 * H8, rate: 0.0001 },
    ];
    const r = computeFunding(longOneAtHundred, events);
    expect(r.paid).toBeCloseTo(0.03, 10);
    expect(r.received).toBeCloseTo(0.01, 10);
    expect(r.total).toBeCloseTo(-0.02, 10);
  });
});

describe("computeFunding — notional", () => {
  it("scales with qty and price", () => {
    const pos: FundingPosition = { side: "buy", qty: 0.5, price: 77_000, openedAt: T0, closedAt: T0 + DAY };
    const r = computeFunding(pos, history(0.0001));
    expect(r.payments[0].notional).toBeCloseTo(38_500, 10);
    expect(r.total).toBeCloseTo(-3 * 38_500 * 0.0001, 10);
  });

  it("prefers the mark price of the settlement when provided", () => {
    const events: FundingRateEvent[] = [{ timestamp: T0 + H8, rate: 0.0001, markPrice: 200 }];
    const r = computeFunding(longOneAtHundred, events);
    expect(r.payments[0].price).toBe(200);
    expect(r.payments[0].notional).toBeCloseTo(200, 10);
  });

  it("ignores a non-positive mark price and falls back to the position price", () => {
    const events: FundingRateEvent[] = [{ timestamp: T0 + H8, rate: 0.0001, markPrice: 0 }];
    expect(computeFunding(longOneAtHundred, events).payments[0].price).toBe(100);
  });
});

describe("computeFunding — open positions and gaps", () => {
  it("uses `now` as the close time for a still-open position", () => {
    const open: FundingPosition = { side: "buy", qty: 1, price: 100, openedAt: T0 };
    const r = computeFunding(open, history(0.0001), { now: T0 + DAY });
    expect(r.count).toBe(3);
  });

  it("falls back to the last event when neither closedAt nor now is given", () => {
    const open: FundingPosition = { side: "buy", qty: 1, price: 100, openedAt: T0 };
    const r = computeFunding(open, history(0.0001, 4));
    expect(r.count).toBe(3);
  });

  it("missing history means zero funding unless fillMissingWithRate is set", () => {
    const bare = computeFunding(longOneAtHundred, [], { now: T0 + DAY });
    expect(bare.count).toBe(0);

    const filled = computeFunding(longOneAtHundred, [], { fillMissingWithRate: 0.0001 });
    expect(filled.count).toBe(3);
    expect(filled.payments.every((p) => p.synthetic)).toBe(true);
    expect(filled.total).toBeCloseTo(-0.03, 10);
  });

  it("only fills the gaps, keeping the real events", () => {
    const partial: FundingRateEvent[] = [{ timestamp: T0 + 2 * H8, rate: 0.0005 }];
    const r = computeFunding(longOneAtHundred, partial, { fillMissingWithRate: 0.0001 });
    expect(r.count).toBe(3);
    expect(r.payments.filter((p) => p.synthetic)).toHaveLength(2);
    expect(r.payments.find((p) => p.timestamp === T0 + 2 * H8)?.rate).toBe(0.0005);
  });

  it("deduplicates repeated settlements at the same timestamp", () => {
    const dup: FundingRateEvent[] = [
      { timestamp: T0 + H8, rate: 0.0001 },
      { timestamp: T0 + H8, rate: 0.0002 },
    ];
    const r = computeFunding(longOneAtHundred, dup);
    expect(r.count).toBe(1);
    expect(r.payments[0].rate).toBe(0.0002);
  });

  it("sorts unordered history before applying it", () => {
    const shuffled: FundingRateEvent[] = [
      { timestamp: T0 + 3 * H8, rate: 0.0001 },
      { timestamp: T0 + H8, rate: 0.0001 },
      { timestamp: T0 + 2 * H8, rate: 0.0001 },
    ];
    const r = computeFunding(longOneAtHundred, shuffled);
    expect(r.payments.map((p) => p.timestamp)).toEqual([T0 + H8, T0 + 2 * H8, T0 + 3 * H8]);
  });
});

describe("computeFunding — defensive", () => {
  it("returns an empty result for qty 0, bad price or undefined history", () => {
    expect(computeFunding({ ...longOneAtHundred, qty: 0 }, history(0.0001)).count).toBe(0);
    expect(computeFunding({ ...longOneAtHundred, price: 0 }, history(0.0001)).count).toBe(0);
    expect(computeFunding(longOneAtHundred, undefined).count).toBe(0);
  });

  it("skips events with non-finite fields", () => {
    const bad = [
      { timestamp: T0 + H8, rate: NaN },
      { timestamp: NaN, rate: 0.0001 },
      { timestamp: T0 + 2 * H8, rate: 0.0001 },
    ] as FundingRateEvent[];
    expect(computeFunding(longOneAtHundred, bad).count).toBe(1);
  });
});

describe("timeUnit", () => {
  it("works on UTC seconds, the unit our candles use", () => {
    const t0s = T0 / 1000;
    const pos: FundingPosition = { side: "buy", qty: 1, price: 100, openedAt: t0s, closedAt: t0s + 86_400 };
    const events = Array.from({ length: 6 }, (_, i) => ({ timestamp: t0s + i * 8 * 3600, rate: 0.0001 }));
    const r = computeFunding(pos, events, { timeUnit: "s" });
    expect(r.count).toBe(3);
    expect(r.total).toBeCloseTo(-0.03, 10);
  });

  it("fills gaps on the seconds grid too", () => {
    const t0s = T0 / 1000;
    const pos: FundingPosition = { side: "buy", qty: 1, price: 100, openedAt: t0s, closedAt: t0s + 86_400 };
    const r = computeFunding(pos, [], { timeUnit: "s", fillMissingWithRate: 0.0001 });
    expect(r.count).toBe(3);
    expect(r.payments[0].timestamp).toBe(t0s + 8 * 3600);
  });
});

describe("fundingSchedule", () => {
  it("aligns to the epoch grid: 00:00 / 08:00 / 16:00 UTC", () => {
    const grid = fundingSchedule(T0, T0 + DAY);
    expect(grid).toEqual([T0 + H8, T0 + 2 * H8, T0 + 3 * H8]);
  });

  it("snaps a mid-interval start forward to the next settlement", () => {
    const grid = fundingSchedule(T0 + 3600_000, T0 + DAY);
    expect(grid[0]).toBe(T0 + H8);
  });

  it("returns nothing for an inverted or empty range", () => {
    expect(fundingSchedule(T0 + DAY, T0)).toEqual([]);
    expect(fundingSchedule(T0, T0)).toEqual([]);
    expect(fundingSchedule(NaN, T0)).toEqual([]);
  });

  it("honours a custom interval", () => {
    const grid = fundingSchedule(T0, T0 + 4 * 3600_000, { intervalMinutes: 60 });
    expect(grid).toHaveLength(4);
  });
});

describe("annualizeFundingRate", () => {
  it("0.01% per 8h is about 10.95% a year", () => {
    expect(annualizeFundingRate(0.0001, 480)).toBeCloseTo(0.1095, 6);
  });

  it("falls back to the default interval on garbage input", () => {
    expect(annualizeFundingRate(0.0001, 0)).toBeCloseTo(
      annualizeFundingRate(0.0001, DEFAULT_FUNDING_INTERVAL_MINUTES), 12,
    );
  });
});

describe("fundingEventsFromBybit", () => {
  it("parses string fields and sorts ascending", () => {
    const rows = [
      { fundingRate: "0.0002", fundingRateTimestamp: "1700000000000" },
      { fundingRate: "-0.0001", fundingRateTimestamp: "1699971200000" },
    ];
    const out = fundingEventsFromBybit(rows);
    expect(out).toEqual([
      { timestamp: 1699971200000, rate: -0.0001 },
      { timestamp: 1700000000000, rate: 0.0002 },
    ]);
  });

  it("drops unparsable rows and survives undefined", () => {
    expect(fundingEventsFromBybit([{ fundingRate: "x", fundingRateTimestamp: "1" }])).toEqual([]);
    expect(fundingEventsFromBybit(undefined)).toEqual([]);
  });
});

describe("netPnlAfterFunding", () => {
  it("subtracts what was paid", () => {
    const r = computeFunding(longOneAtHundred, history(0.0001));
    expect(netPnlAfterFunding(1, r)).toBeCloseTo(0.97, 10);
  });

  it("passes the pnl through when there is no funding data", () => {
    expect(netPnlAfterFunding(1, undefined)).toBe(1);
  });
});
