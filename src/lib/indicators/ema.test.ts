import { describe, it, expect } from "vitest";
import { calcEma, def as emaDef } from "./ema";
import type { Candle } from "../types";

const c = (close: number, t = 0): Candle => ({
  time: t, open: close, high: close, low: close, close, volume: 0,
});

describe("EMA", () => {
  it("returns all nulls when not enough candles", () => {
    expect(calcEma([c(1), c(2)], 5)).toEqual([null, null]);
  });

  it("seeds EMA with SMA of first `period` closes", () => {
    // period=3, closes 2,4,6 → seed = 4
    const vals = calcEma([2, 4, 6].map((v, i) => c(v, i)), 3);
    expect(vals[0]).toBeNull();
    expect(vals[1]).toBeNull();
    expect(vals[2]).toBeCloseTo(4, 10);
  });

  it("uses the standard k=2/(period+1) recurrence", () => {
    // period=3 → k=0.5. Closes 2,4,6,10. seed=4 at i=2.
    // i=3: 10*0.5 + 4*0.5 = 7
    const vals = calcEma([2, 4, 6, 10].map((v, i) => c(v, i)), 3);
    expect(vals[3]).toBeCloseTo(7, 10);
  });

  it("compute() emits only non-null points", () => {
    const out = emaDef.compute([2, 4, 6, 10].map((v, i) => c(v, i)), { period: 3 });
    expect(out.lines[0].data.length).toBe(2);
    expect(out.lines[0].data[0].time).toBe(2);
  });
});
