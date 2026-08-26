import { describe, expect, it } from "vitest";
import { mulberry32, normalSeries } from "./random.ts";
import type { ReturnSeries } from "./series.ts";
import { tailReversal } from "./tailReversal.ts";

function seriesOf(values: Float64Array, intervalSec = 60, gapAt = -1): ReturnSeries {
  const time = new Float64Array(values.length);
  let t = intervalSec;
  for (let i = 0; i < values.length; i++) {
    if (i === gapAt) t += intervalSec * 100;
    time[i] = t;
    t += intervalSec;
  }
  return { time, value: values, intervalSec, bars: values.length + 1, gaps: 0 };
}

describe("tailReversal", () => {
  it("finds nothing after extreme bars in white noise", () => {
    const s = seriesOf(normalSeries(200000, 0.001, mulberry32(121)));
    for (const row of tailReversal(s, [0.99, 0.999], [1, 5])) expect(Math.abs(row.t)).toBeLessThan(3.5);
  });

  it("recovers a snap back that only the extreme bars have", () => {
    const values = normalSeries(200000, 0.001, mulberry32(122));
    // Any bar past four sigma gives half of itself back on the next bar.
    for (let i = 1; i < values.length; i++) if (Math.abs(values[i - 1]) > 0.004) values[i] -= 0.5 * values[i - 1];
    const rows = tailReversal(seriesOf(values), [0.9, 0.9999], [1]);
    const mild = rows.find((r) => r.percentile === 0.9)!;
    const extreme = rows.find((r) => r.percentile === 0.9999)!;
    expect(extreme.reversalBps).toBeGreaterThan(mild.reversalBps * 5);
    expect(extreme.t).toBeGreaterThan(3);
    expect(extreme.hitRate).toBeGreaterThan(0.6);
  });

  it("accumulates over the whole horizon", () => {
    const values = normalSeries(100000, 0.001, mulberry32(123));
    // The give-back is spread over three bars instead of one.
    for (let i = 3; i < values.length; i++) {
      if (Math.abs(values[i - 3]) > 0.004) {
        values[i - 2] -= 0.2 * values[i - 3];
        values[i - 1] -= 0.2 * values[i - 3];
        values[i] -= 0.2 * values[i - 3];
      }
    }
    const rows = tailReversal(seriesOf(values), [0.999], [1, 5]);
    const short = rows.find((r) => r.horizon === 1)!;
    const long = rows.find((r) => r.horizon === 5)!;
    expect(long.reversalBps).toBeGreaterThan(short.reversalBps * 2);
  });

  it("counts fewer triggers as the percentile rises", () => {
    const s = seriesOf(normalSeries(100000, 0.001, mulberry32(124)));
    const rows = tailReversal(s, [0.99, 0.999], [1]);
    expect(rows[0].n).toBeGreaterThan(rows[1].n * 5);
    expect(rows[1].thresholdBps).toBeGreaterThan(rows[0].thresholdBps);
  });

  it("refuses to hold a position across a data gap", () => {
    const values = new Float64Array(1000).fill(0.0001);
    values[500] = 0.05;
    const withGap = tailReversal(seriesOf(values, 60, 502), [0.999], [5]);
    const clean = tailReversal(seriesOf(values, 60), [0.999], [5]);
    expect(withGap[0].n).toBeLessThan(clean[0].n);
  });

  it("reports a confidence interval that brackets the estimate", () => {
    const rows = tailReversal(seriesOf(normalSeries(50000, 0.001, mulberry32(125))), [0.99], [1, 15]);
    for (const r of rows) {
      expect(r.ciLowBps).toBeLessThan(r.reversalBps);
      expect(r.ciHighBps).toBeGreaterThan(r.reversalBps);
    }
  });
});
