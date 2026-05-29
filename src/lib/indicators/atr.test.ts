import { describe, it, expect } from "vitest";
import { def as atrDef } from "./atr";
import type { Candle } from "../types";

const hlc = (high: number, low: number, close: number, t = 0): Candle => ({
  time: t, open: close, high, low, close, volume: 0,
});

describe("ATR", () => {
  it("returns empty when not enough candles", () => {
    const out = atrDef.compute([hlc(2, 1, 1)], { period: 14 });
    expect(out.lines[0].data).toEqual([]);
  });

  it("uses simple range for the first candle, then full TR formula", () => {
    // period=2.
    // c0: H=10, L=8, C=9 → TR0 = 10-8 = 2
    // c1: H=12, L=9,  C=11 → TR1 = max(12-9=3, |12-9|=3, |9-9|=0) = 3   (prevClose=9)
    // c2: H=11, L=7,  C=8  → TR2 = max(11-7=4, |11-11|=0, |7-11|=4) = 4 (prevClose=11)
    // Initial ATR (SMA of period TRs) = (2+3)/2 = 2.5 at index 1
    // Next: ATR = (2.5*1 + 4)/2 = 3.25 at index 2
    const candles = [
      hlc(10, 8, 9, 0),
      hlc(12, 9, 11, 1),
      hlc(11, 7, 8, 2),
    ];
    const out = atrDef.compute(candles, { period: 2 });
    expect(out.lines[0].data).toEqual([
      { time: 1, value: 2.5 },
      { time: 2, value: 3.25 },
    ]);
  });

  it("ATR is always non-negative", () => {
    const candles = Array.from({ length: 30 }, (_, i) =>
      hlc(100 + i + 1, 100 + i - 1, 100 + i, i)
    );
    const out = atrDef.compute(candles, { period: 14 });
    for (const p of out.lines[0].data) expect(p.value).toBeGreaterThanOrEqual(0);
  });
});
