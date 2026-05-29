import { describe, it, expect } from "vitest";
import { def as smaDef } from "./sma";
import type { Candle } from "../types";

const c = (close: number, t = 0): Candle => ({
  time: t, open: close, high: close, low: close, close, volume: 0,
});

describe("SMA", () => {
  it("returns empty when not enough candles", () => {
    const out = smaDef.compute([c(1), c(2)], { period: 5 });
    expect(out.lines[0].data).toEqual([]);
  });

  it("computes a simple moving average correctly", () => {
    // closes: 1,2,3,4,5 ; SMA(3) at i=2,3,4 → 2,3,4
    const candles = [1, 2, 3, 4, 5].map((v, i) => c(v, i));
    const out = smaDef.compute(candles, { period: 3 });
    expect(out.lines[0].data.map(p => p.value)).toEqual([2, 3, 4]);
    expect(out.lines[0].data.map(p => p.time)).toEqual([2, 3, 4]);
  });

  it("name includes period; respects color param", () => {
    const out = smaDef.compute([c(1, 0), c(2, 1)], { period: 2, color: "#abcdef" });
    expect(out.lines[0].name).toBe("SMA(2)");
    expect(out.lines[0].color).toBe("#abcdef");
  });
});
