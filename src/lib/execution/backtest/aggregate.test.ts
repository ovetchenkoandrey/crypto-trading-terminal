import { describe, it, expect } from "vitest";
import { BarAggregator, aggregateBars, alignDown } from "./aggregate";
import type { Candle } from "../../types";

const MIN = 60;
const HOUR = 3600;

/** Minute bars starting at `startSec`, each one point higher than the last. */
function minutes(count: number, startSec = 0, base = 100): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time:   startSec + i * MIN,
    open:   base + i,
    high:   base + i + 2,
    low:    base + i - 2,
    close:  base + i + 1,
    volume: 1,
  }));
}

describe("alignDown", () => {
  it("snaps to the start of the interval", () => {
    expect(alignDown(3_661, HOUR)).toBe(3_600);
    expect(alignDown(3_600, HOUR)).toBe(3_600);
    expect(alignDown(3_599, HOUR)).toBe(0);
  });

  it("handles a 20 minute grid", () => {
    expect(alignDown(0, 20 * MIN)).toBe(0);
    expect(alignDown(19 * MIN, 20 * MIN)).toBe(0);
    expect(alignDown(20 * MIN, 20 * MIN)).toBe(20 * MIN);
    expect(alignDown(41 * MIN, 20 * MIN)).toBe(40 * MIN);
  });

  it("returns the input for a non-positive interval", () => {
    expect(alignDown(1234, 0)).toBe(1234);
    expect(alignDown(1234, -5)).toBe(1234);
  });
});

describe("BarAggregator", () => {
  it("emits nothing until the next period starts", () => {
    const agg = new BarAggregator(15 * MIN);
    const bars = minutes(15);

    const emitted = bars.map((b) => agg.push(b)).filter(Boolean);

    // 15 minutes exactly fill the period, but its close is only known once a
    // bar of the following period shows up.
    expect(emitted).toHaveLength(0);
  });

  it("emits the finished period when the next one opens", () => {
    const agg = new BarAggregator(15 * MIN);
    const bars = minutes(16);

    const emitted = bars.map((b) => agg.push(b)).filter(Boolean) as Candle[];

    expect(emitted).toHaveLength(1);
    expect(emitted[0]).toEqual({
      time:   0,
      open:   100,            // open of the first minute
      high:   116,            // 100 + 14 + 2
      low:     98,            // 100 + 0 - 2
      close:  115,            // close of the fifteenth minute
      volume:  15,
    });
  });

  it("aligns periods to the grid rather than to the first bar", () => {
    // Series starts at 00:07, so the first emitted period is 00:00, not 00:07.
    // Runs to 00:36 so the 00:15 period is closed by a bar of the next one.
    const agg = new BarAggregator(15 * MIN);
    const emitted = minutes(30, 7 * MIN).map((b) => agg.push(b)).filter(Boolean) as Candle[];

    expect(emitted.map((b) => b.time)).toEqual([0, 15 * MIN]);
  });

  it("works on a 20 minute interval", () => {
    const agg = new BarAggregator(20 * MIN);
    const emitted = minutes(45).map((b) => agg.push(b)).filter(Boolean) as Candle[];

    expect(emitted.map((b) => b.time)).toEqual([0, 20 * MIN]);
  });

  it("works on an hourly interval", () => {
    const agg = new BarAggregator(HOUR);
    const emitted = minutes(125).map((b) => agg.push(b)).filter(Boolean) as Candle[];

    expect(emitted.map((b) => b.time)).toEqual([0, HOUR]);
    expect(emitted[0].volume).toBe(60);
  });

  it("skips empty periods instead of inventing them", () => {
    // A gap in the data: minutes 0..2, then nothing until the next hour.
    const agg = new BarAggregator(HOUR);
    const bars = [...minutes(3), ...minutes(2, 2 * HOUR)];

    const emitted = bars.map((b) => agg.push(b)).filter(Boolean) as Candle[];

    expect(emitted).toHaveLength(1);
    expect(emitted[0].time).toBe(0);
  });

  it("never exposes the forming period through push", () => {
    const agg = new BarAggregator(HOUR);
    const bars = minutes(30);

    for (const b of bars) expect(agg.push(b)).toBeNull();
    expect(agg.pending()?.close).toBe(bars[29].close);
  });

  it("carries high and low across the whole period", () => {
    const agg = new BarAggregator(HOUR);
    const bars: Candle[] = [
      { time: 0,       open: 100, high: 105, low:  99, close: 101, volume: 1 },
      { time: MIN,     open: 101, high: 120, low: 100, close: 102, volume: 2 },
      { time: 2 * MIN, open: 102, high: 103, low:  80, close:  90, volume: 3 },
      { time: HOUR,    open:  90, high:  95, low:  85, close:  92, volume: 4 },
    ];

    const emitted = bars.map((b) => agg.push(b)).filter(Boolean) as Candle[];

    expect(emitted[0]).toMatchObject({ open: 100, high: 120, low: 80, close: 90, volume: 6 });
  });
});

describe("aggregateBars", () => {
  it("keeps the trailing period", () => {
    const out = aggregateBars(minutes(90), HOUR);

    expect(out.map((b) => b.time)).toEqual([0, HOUR]);
    expect(out[1].volume).toBe(30);
  });

  it("returns nothing for an empty series", () => {
    expect(aggregateBars([], HOUR)).toEqual([]);
  });

  it("passes bars through when the interval matches the series", () => {
    const bars = minutes(5);

    const out = aggregateBars(bars, MIN);

    expect(out).toEqual(bars);
  });
});
