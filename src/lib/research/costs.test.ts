import { describe, expect, it } from "vitest";
import {
  breakEvenHitRate,
  costShareOfMove,
  COST_FLOORS,
  MAKER_ROUND_TRIP_BPS,
  requiredGrossBps,
  TAKER_ROUND_TRIP_BPS,
} from "./costs.ts";

describe("cost constants", () => {
  it("match the Bybit linear perpetual schedule", () => {
    // 0.055% taker and 0.02% maker per side, both sides of a round trip.
    expect(TAKER_ROUND_TRIP_BPS).toBeCloseTo(11, 9);
    expect(MAKER_ROUND_TRIP_BPS).toBeCloseTo(4, 9);
  });

  it("lists the floors from cheapest to dearest", () => {
    const values = COST_FLOORS.map((f) => f.roundTripBps);
    expect(values).toEqual([...values].sort((a, b) => a - b));
  });
});

describe("breakEvenHitRate", () => {
  it("is a coin flip when trading is free", () => {
    expect(breakEvenHitRate(20, 0)).toBeCloseTo(0.5, 12);
  });

  it("rises as the target shrinks toward the fee", () => {
    expect(breakEvenHitRate(100, 11)).toBeCloseTo(0.555, 3);
    expect(breakEvenHitRate(22, 11)).toBeCloseTo(0.75, 9);
    // A target equal to the round trip needs a hit rate no system reaches.
    expect(breakEvenHitRate(11, 11)).toBeCloseTo(1, 9);
  });

  it("goes past one — impossible — when the target is under the fee", () => {
    expect(breakEvenHitRate(5, 11)).toBeGreaterThan(1);
  });

  it("is NaN for a non-positive target", () => {
    expect(Number.isNaN(breakEvenHitRate(0, 11))).toBe(true);
  });
});

describe("costShareOfMove", () => {
  it("is the ratio of fee to move", () => {
    expect(costShareOfMove(22, 11)).toBeCloseTo(0.5, 12);
    expect(costShareOfMove(11, 11)).toBeCloseTo(1, 12);
  });

  it("is infinite for a zero move", () => {
    expect(costShareOfMove(0, 11)).toBe(Infinity);
  });
});

describe("requiredGrossBps", () => {
  it("reproduces the 0.6% rule from the hypothesis log", () => {
    // 15 bp of round-trip cost eating at most a quarter of gross: 60 bp.
    expect(requiredGrossBps(15, 0.25)).toBeCloseTo(60, 9);
  });

  it("shrinks as the tolerated share rises", () => {
    expect(requiredGrossBps(11, 0.5)).toBeLessThan(requiredGrossBps(11, 0.25));
  });
});
