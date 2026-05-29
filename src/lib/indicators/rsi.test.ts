import { describe, it, expect } from "vitest";
import { def as rsiDef } from "./rsi";
import type { Candle } from "../types";

const c = (close: number, t = 0): Candle => ({
  time: t, open: close, high: close, low: close, close, volume: 0,
});

describe("RSI", () => {
  it("returns empty data set when not enough candles", () => {
    const out = rsiDef.compute([c(1), c(2)], { period: 14 });
    expect(out.lines[0].data).toEqual([]);
    expect(out.lines[0].paneRelativeMin).toBe(0);
    expect(out.lines[0].paneRelativeMax).toBe(100);
  });

  it("returns 100 for a monotonically rising series (no losses)", () => {
    const candles = Array.from({ length: 30 }, (_, i) => c(100 + i, i));
    const out = rsiDef.compute(candles, { period: 14 });
    for (const p of out.lines[0].data) expect(p.value).toBe(100);
  });

  it("returns near-zero for a monotonically falling series (no gains)", () => {
    const candles = Array.from({ length: 30 }, (_, i) => c(100 - i, i));
    const out = rsiDef.compute(candles, { period: 14 });
    for (const p of out.lines[0].data) expect(p.value).toBeCloseTo(0, 10);
  });

  it("stays in [0, 100] for mixed input", () => {
    const closes = [10, 12, 11, 13, 14, 13, 15, 16, 14, 13, 12, 14, 15, 16, 17, 16, 18, 17];
    const candles = closes.map((v, i) => c(v, i));
    const out = rsiDef.compute(candles, { period: 14 });
    expect(out.lines[0].data.length).toBeGreaterThan(0);
    for (const p of out.lines[0].data) {
      expect(p.value).toBeGreaterThanOrEqual(0);
      expect(p.value).toBeLessThanOrEqual(100);
    }
  });
});
