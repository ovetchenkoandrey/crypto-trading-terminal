import { describe, it, expect } from "vitest";
import { def as stochDef } from "./stochastic";
import type { Candle } from "../types";

const hlc = (high: number, low: number, close: number, t = 0): Candle => ({
  time: t, open: close, high, low, close, volume: 0,
});

describe("Stochastic", () => {
  it("returns 100 when close == window high", () => {
    // kPeriod=3 — каждое окно: high=10, low=5, close=10 → %K=100
    const candles = Array.from({ length: 5 }, (_, i) => hlc(10, 5, 10, i));
    const out = stochDef.compute(candles, { kPeriod: 3, dPeriod: 1 });
    const kLine = out.lines.find(l => l.name === "%K")!;
    expect(kLine.data.length).toBe(3);
    for (const p of kLine.data) expect(p.value).toBe(100);
  });

  it("returns 0 when close == window low", () => {
    const candles = Array.from({ length: 5 }, (_, i) => hlc(10, 5, 5, i));
    const out = stochDef.compute(candles, { kPeriod: 3, dPeriod: 1 });
    const kLine = out.lines.find(l => l.name === "%K")!;
    for (const p of kLine.data) expect(p.value).toBe(0);
  });

  it("returns 50 when high == low (flat window)", () => {
    const candles = Array.from({ length: 5 }, (_, i) => hlc(7, 7, 7, i));
    const out = stochDef.compute(candles, { kPeriod: 3, dPeriod: 1 });
    const kLine = out.lines.find(l => l.name === "%K")!;
    for (const p of kLine.data) expect(p.value).toBe(50);
  });

  it("%D is SMA of %K", () => {
    // %K = [100, 0, 50] → %D(2) at index 1,2: 50, 25
    const candles = [
      hlc(10, 5, 10, 0),
      hlc(10, 5,  5, 1),
      hlc(10, 5,  7.5, 2),
    ];
    const out = stochDef.compute(candles, { kPeriod: 1, dPeriod: 2 });
    const dLine = out.lines.find(l => l.name === "%D")!;
    expect(dLine.data.map(p => p.value)).toEqual([50, 25]);
  });
});
