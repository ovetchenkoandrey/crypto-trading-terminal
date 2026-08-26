import { describe, expect, it } from "vitest";
import { alignSeries, crossCorrelation, crossCorrelationProfile } from "./leadLag.ts";
import { gaussian, mulberry32, normalSeries } from "./random.ts";
import type { ReturnSeries } from "./series.ts";

function seriesOf(values: Float64Array, times?: number[]): ReturnSeries {
  const time = times ? Float64Array.from(times) : Float64Array.from(values.map((_, i) => 60 * (i + 1)));
  return { time, value: values, intervalSec: 60, bars: values.length + 1, gaps: 0 };
}

describe("alignSeries", () => {
  it("keeps only the timestamps both series have", () => {
    const a = seriesOf(Float64Array.from([1, 2, 3]), [60, 120, 180]);
    const b = seriesOf(Float64Array.from([10, 30]), [60, 180]);
    const pair = alignSeries(a, b);
    expect(Array.from(pair.time)).toEqual([60, 180]);
    expect(Array.from(pair.a)).toEqual([1, 3]);
    expect(Array.from(pair.b)).toEqual([10, 30]);
  });

  it("refuses to mix intervals", () => {
    const a = seriesOf(Float64Array.from([1]));
    const b: ReturnSeries = { ...seriesOf(Float64Array.from([1])), intervalSec: 300 };
    expect(() => alignSeries(a, b)).toThrow(/different intervals/);
  });
});

describe("crossCorrelation", () => {
  it("finds a contemporaneous relation at lag zero", () => {
    const rng = mulberry32(91);
    const n = 100000;
    const a = normalSeries(n, 0.001, rng);
    const b = new Float64Array(n);
    for (let i = 0; i < n; i++) b[i] = 0.8 * a[i] + 0.001 * gaussian(rng);
    const pair = alignSeries(seriesOf(a), seriesOf(b));
    expect(crossCorrelation(pair, 0).corr).toBeGreaterThan(0.5);
    expect(Math.abs(crossCorrelation(pair, 3).corr)).toBeLessThan(0.05);
  });

  it("finds a lead where one series is a delayed copy of the other", () => {
    const rng = mulberry32(92);
    const n = 100000;
    const a = normalSeries(n, 0.001, rng);
    const b = new Float64Array(n);
    // b at t is driven by a at t-2: a leads b by two bars.
    for (let i = 2; i < n; i++) b[i] = 0.5 * a[i - 2] + 0.001 * gaussian(rng);
    const pair = alignSeries(seriesOf(a), seriesOf(b));
    const profile = crossCorrelationProfile(pair, [-2, -1, 0, 1, 2, 3]);
    const best = profile.reduce((x, y) => (Math.abs(y.corr) > Math.abs(x.corr) ? y : x));
    expect(best.lag).toBe(2);
    expect(best.corr).toBeGreaterThan(0.3);
    expect(best.edgeBps).toBeGreaterThan(0);
    expect(best.edgeT).toBeGreaterThan(10);
  });

  it("finds nothing between two independent series", () => {
    const a = normalSeries(100000, 0.001, mulberry32(93));
    const b = normalSeries(100000, 0.001, mulberry32(94));
    const pair = alignSeries(seriesOf(a), seriesOf(b));
    for (const r of crossCorrelationProfile(pair, [-2, -1, 0, 1, 2])) expect(Math.abs(r.z)).toBeLessThan(4);
  });

  it("never pairs across a gap", () => {
    // Timestamps 60, 120, then a hole, then 300, 360.
    const a = seriesOf(Float64Array.from([1, 2, 3, 4]), [60, 120, 300, 360]);
    const b = seriesOf(Float64Array.from([1, 2, 3, 4]), [60, 120, 300, 360]);
    const pair = alignSeries(a, b);
    // Only 60->120 and 300->360 are genuinely one bar apart.
    expect(crossCorrelation(pair, 1).n).toBe(2);
    expect(crossCorrelation(pair, 0).n).toBe(4);
  });

  it("is symmetric under swapping the sign of the lag and the roles", () => {
    const rng = mulberry32(95);
    const n = 50000;
    const a = normalSeries(n, 0.001, rng);
    const b = new Float64Array(n);
    for (let i = 1; i < n; i++) b[i] = 0.4 * a[i - 1] + 0.001 * gaussian(rng);
    const forward = crossCorrelation(alignSeries(seriesOf(a), seriesOf(b)), 1);
    const reversed = crossCorrelation(alignSeries(seriesOf(b), seriesOf(a)), -1);
    expect(forward.corr).toBeCloseTo(reversed.corr, 9);
  });
});
