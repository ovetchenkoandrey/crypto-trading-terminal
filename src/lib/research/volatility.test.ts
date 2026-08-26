import { describe, expect, it } from "vitest";
import { garchSeries, mulberry32, normalSeries } from "./random.ts";
import type { ReturnSeries } from "./series.ts";
import { harForecast, realizedVol, regimeTransitions, volConditionalMeanAbs } from "./volatility.ts";

function seriesOf(values: Float64Array, intervalSec = 60, startSec = 0): ReturnSeries {
  const time = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) time[i] = startSec + (i + 1) * intervalSec;
  return { time, value: values, intervalSec, bars: values.length + 1, gaps: 0 };
}

describe("realizedVol", () => {
  it("sums squared returns inside each period", () => {
    // Four minutes of 1% moves inside one hour: sqrt(4 * 0.0001) = 2%.
    const values = new Float64Array(4).fill(0.01);
    const rv = realizedVol(seriesOf(values, 60, 0), 3600);
    expect(rv.vol.length).toBe(1);
    expect(rv.vol[0]).toBeCloseTo(0.02, 12);
    expect(rv.count[0]).toBe(4);
  });

  it("splits on the period boundary", () => {
    // Timestamps 0..7140, i.e. exactly two full hours of minutes.
    const values = new Float64Array(120).fill(0.001);
    const rv = realizedVol(seriesOf(values, 60, -60), 3600);
    expect(rv.vol.length).toBe(2);
    expect(rv.count[0]).toBe(60);
    expect(rv.time[1] - rv.time[0]).toBe(3600);
  });

  it("leaves a trailing partial period as its own bucket", () => {
    const values = new Float64Array(61).fill(0.001);
    const rv = realizedVol(seriesOf(values, 60, -60), 3600);
    expect(rv.vol.length).toBe(2);
    expect(rv.count[1]).toBe(1);
  });

  it("drops periods with too few observations", () => {
    const values = new Float64Array(61).fill(0.001);
    const rv = realizedVol(seriesOf(values, 60, 0), 3600, 30);
    expect(rv.vol.length).toBe(1);
  });

  it("returns periods in ascending time", () => {
    const rv = realizedVol(seriesOf(normalSeries(5000, 0.001, mulberry32(81)), 60, 0), 3600);
    for (let i = 1; i < rv.time.length; i++) expect(rv.time[i]).toBeGreaterThan(rv.time[i - 1]);
  });
});

describe("harForecast", () => {
  it("predicts clustered volatility out of sample", () => {
    // Persistence 0.999 per minute is a half-life of about half a day, which
    // is what makes hourly realized volatility forecastable at all. A GARCH
    // whose memory dies inside an hour aggregates away to noise.
    const r = garchSeries(400000, 0.05, 0.949, 0.001, mulberry32(82));
    const rv = realizedVol(seriesOf(r, 60, 0), 3600);
    const har = harForecast(rv.vol);
    expect(har.periods).toBeGreaterThan(200);
    expect(har.outOfSampleR2).toBeGreaterThan(0.1);
    expect(har.testCorrelation).toBeGreaterThan(0.3);
  });

  it("predicts nothing when volatility is constant noise", () => {
    const r = normalSeries(400000, 0.001, mulberry32(83));
    const rv = realizedVol(seriesOf(r, 60, 0), 3600);
    const har = harForecast(rv.vol);
    expect(har.outOfSampleR2).toBeLessThan(0.1);
  });

  it("honours a custom lag set", () => {
    const rv = realizedVol(seriesOf(garchSeries(200000, 0.05, 0.949, 0.001, mulberry32(84)), 60, 0), 3600);
    const har = harForecast(rv.vol, [1, 3, 10]);
    expect(har.lags).toEqual([1, 3, 10]);
    expect(har.periods).toBe(rv.vol.length - 10);
  });
});

describe("regimeTransitions", () => {
  it("splits into equal-frequency regimes", () => {
    const v = Float64Array.from({ length: 3000 }, (_, i) => i);
    const r = regimeTransitions(v, 3);
    for (const b of r.base) expect(b).toBeCloseTo(1 / 3, 2);
    expect(r.cuts.length).toBe(2);
  });

  it("finds persistence far above the base rate for clustered volatility", () => {
    const rv = realizedVol(seriesOf(garchSeries(600000, 0.05, 0.949, 0.001, mulberry32(85)), 60, 0), 3600);
    const r = regimeTransitions(rv.vol, 3);
    expect(r.persistence[0]).toBeGreaterThan(0.45);
    expect(r.persistence[2]).toBeGreaterThan(0.45);
    expect(r.persistenceSe[0]).toBeLessThan(0.05);
  });

  it("finds persistence at the base rate for independent draws", () => {
    const v = normalSeries(20000, 1, mulberry32(86));
    const abs = v.map(Math.abs);
    const r = regimeTransitions(abs, 3);
    for (let i = 0; i < 3; i++) expect(Math.abs(r.persistence[i] - 1 / 3)).toBeLessThan(0.03);
  });

  it("rows of the transition matrix sum to one", () => {
    const r = regimeTransitions(normalSeries(5000, 1, mulberry32(87)).map(Math.abs), 4);
    for (const row of r.transitions) expect(row.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9);
  });
});

describe("volConditionalMeanAbs", () => {
  it("shows the next period is larger after a high-volatility one", () => {
    const r = garchSeries(600000, 0.05, 0.949, 0.001, mulberry32(88));
    const rv = realizedVol(seriesOf(r, 60, 0), 3600);
    const nextAbs = rv.vol;
    const buckets = volConditionalMeanAbs(rv.vol, nextAbs, 3);
    expect(buckets[2]).toBeGreaterThan(buckets[0] * 1.5);
  });

  it("shows no difference for independent draws", () => {
    const v = normalSeries(20000, 1, mulberry32(89)).map(Math.abs);
    const buckets = volConditionalMeanAbs(v, v, 3);
    expect(Math.abs(buckets[2] / buckets[0] - 1)).toBeLessThan(0.15);
  });
});
