import { describe, it, expect } from "vitest";
import { def as fractalsDef } from "./fractals";
import type { Candle } from "../types";

// helper: bar with arbitrary high/low at time t
const b = (high: number, low: number, t: number): Candle => ({
  time: t, open: low, high, low, close: high, volume: 0,
});

describe("Fractals", () => {
  it("returns no markers when there aren't enough bars", () => {
    const candles = [b(10, 5, 0), b(11, 6, 1)];
    const out = fractalsDef.compute(candles, { period: 2 });
    expect(out.markers).toEqual([]);
  });

  it("detects a bullish fractal — local low with N higher lows on each side", () => {
    // bar 2 has the lowest low; lows are 5,4,3,4,5
    const candles = [
      b(10, 5, 0), b(10, 4, 1), b(10, 3, 2), b(10, 4, 3), b(10, 5, 4),
    ];
    const out = fractalsDef.compute(candles, { period: 2 });
    expect(out.markers).toHaveLength(1);
    expect(out.markers![0]).toMatchObject({
      time: 2, position: "belowBar", shape: "arrowUp",
    });
  });

  it("detects a bearish fractal — local high with N lower highs on each side", () => {
    // bar 2 has the highest high; highs are 5,6,7,6,5
    const candles = [
      b(5, 0, 0), b(6, 0, 1), b(7, 0, 2), b(6, 0, 3), b(5, 0, 4),
    ];
    const out = fractalsDef.compute(candles, { period: 2 });
    expect(out.markers).toHaveLength(1);
    expect(out.markers![0]).toMatchObject({
      time: 2, position: "aboveBar", shape: "arrowDown",
    });
  });

  it("does not mark a bar where neighbors equal it (strict comparison)", () => {
    // bar 2 ties with bar 1 on the high — not a fractal
    const candles = [
      b(5, 0, 0), b(7, 0, 1), b(7, 0, 2), b(6, 0, 3), b(5, 0, 4),
    ];
    const out = fractalsDef.compute(candles, { period: 2 });
    expect(out.markers).toEqual([]);
  });

  it("respects the period parameter (N=3 needs 3 neighbors on each side)", () => {
    // N=3: only the centre bar (index 3) has 3 neighbors on each side
    const candles = [
      b(5, 0, 0), b(6, 0, 1), b(7, 0, 2),
      b(10, 0, 3),     // peak
      b(7, 0, 4), b(6, 0, 5), b(5, 0, 6),
    ];
    const out = fractalsDef.compute(candles, { period: 3 });
    expect(out.markers).toHaveLength(1);
    expect(out.markers![0]).toMatchObject({ time: 3, shape: "arrowDown" });
  });
});
