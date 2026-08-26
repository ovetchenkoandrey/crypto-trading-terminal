import { describe, expect, it } from "vitest";
import { moveProfile } from "./moveSize.ts";
import { mulberry32, normalSeries } from "./random.ts";

describe("moveProfile", () => {
  it("reports absolute moves in basis points", () => {
    // Alternating +/- 10 bp: median, mean and stdev are all 10 bp.
    const returns = new Float64Array(1000);
    for (let i = 0; i < returns.length; i++) returns[i] = (i % 2 === 0 ? 1 : -1) * 0.001;
    const p = moveProfile({ label: "1m", intervalSec: 60, returns });
    expect(p.meanAbsBps).toBeCloseTo(10, 6);
    expect(p.medianAbsBps).toBeCloseTo(10, 6);
    expect(p.p99Bps).toBeCloseTo(10, 6);
  });

  it("matches the normal relation between mean absolute move and sigma", () => {
    const returns = normalSeries(200000, 0.0005, mulberry32(61));
    const p = moveProfile({ label: "1m", intervalSec: 60, returns });
    // E|X| = sigma * sqrt(2/pi) for a centred normal.
    expect(p.meanAbsBps).toBeCloseTo(5 * Math.sqrt(2 / Math.PI), 1);
    expect(p.stdevBps).toBeCloseTo(5, 1);
    // Median of |X| is sigma * 0.6745.
    expect(p.medianAbsBps).toBeCloseTo(5 * 0.6745, 1);
  });

  it("counts bars that clear each cost floor", () => {
    const returns = new Float64Array(1000);
    // Half the bars move 20 bp, half move 2 bp.
    for (let i = 0; i < returns.length; i++) returns[i] = i % 2 === 0 ? 0.002 : 0.0002;
    const p = moveProfile({ label: "1m", intervalSec: 60, returns });
    const taker = p.costs.find((c) => c.label === "taker/taker")!;
    const maker = p.costs.find((c) => c.label === "maker/maker")!;
    expect(taker.shareAboveCost).toBeCloseTo(0.5, 6);
    expect(maker.shareAboveCost).toBeCloseTo(0.5, 6);
  });

  it("scales the oracle ceiling with bars per day", () => {
    const returns = new Float64Array(100).fill(0.0001);
    const minute = moveProfile({ label: "1m", intervalSec: 60, returns });
    const hour = moveProfile({ label: "1h", intervalSec: 3600, returns });
    expect(minute.barsPerDay).toBe(1440);
    expect(hour.barsPerDay).toBe(24);
    expect(minute.oracleDailyPct).toBeCloseTo(hour.oracleDailyPct * 60, 6);
  });

  it("ties break-even hit rate to the median move", () => {
    const returns = new Float64Array(1000).fill(0.0022);
    const p = moveProfile({ label: "5m", intervalSec: 300, returns });
    const taker = p.costs.find((c) => c.label === "taker/taker")!;
    // Median move 22 bp, round trip 11 bp: 0.5 + 11 / 44.
    expect(taker.breakEvenAtMedian).toBeCloseTo(0.75, 6);
    expect(taker.costOverMedian).toBeCloseTo(0.5, 6);
  });

  it("averages the supplied bar ranges", () => {
    const returns = new Float64Array(10).fill(0.001);
    const ranges = new Float64Array(10).fill(0.004);
    expect(moveProfile({ label: "1m", intervalSec: 60, returns, ranges }).meanRangeBps).toBeCloseTo(40, 6);
  });

  it("leaves the range NaN when none is supplied", () => {
    const p = moveProfile({ label: "1m", intervalSec: 60, returns: new Float64Array(10).fill(0.001) });
    expect(Number.isNaN(p.meanRangeBps)).toBe(true);
  });
});
