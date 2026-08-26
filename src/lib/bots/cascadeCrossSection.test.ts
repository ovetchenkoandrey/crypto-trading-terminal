import { describe, expect, it } from "vitest";
import {
  CROSS_SECTION_DEFAULTS,
  clusterEvents,
  effectiveSampleSize,
  extractEvents,
  reproducibility,
  summariseSimultaneity,
  symbolEffect,
  type CascadeEvent,
} from "./cascadeCrossSection";
import type { Candle } from "../types";

const MINUTE = 60;

function bar(time: number, close: number, open = close, volume = 100): Candle {
  return { time, open, high: Math.max(open, close) * 1.0001, low: Math.min(open, close) * 0.9999, close, volume };
}

/** Flat series with a controllable jump at `at`, long enough to clear warm-up. */
function series(n: number, jumps: Map<number, number>, start = 100): Candle[] {
  const out: Candle[] = [];
  let price = start;
  for (let i = 0; i < n; i++) {
    const prev = price;
    const jump = jumps.get(i);
    // A tiny deterministic wiggle keeps the quantile estimator from seeing a
    // degenerate all-zero distribution, which is not what real data looks like.
    price = jump !== undefined ? price * (1 + jump) : price * (1 + (i % 7 === 0 ? 0.0001 : -0.0001));
    out.push(bar(i * MINUTE, price, prev, 100));
  }
  return out;
}

const FAST = { warmupBars: 200, refreshBars: 10, percentile: 0.99, cooldownBars: 5 };

describe("extractEvents", () => {
  it("finds nothing before the warm-up is served", () => {
    const bars = series(150, new Map([[50, 0.2]]));
    expect(extractEvents(bars, { symbol: "X", params: FAST })).toHaveLength(0);
  });

  it("fires on a move past the expanding-window threshold", () => {
    const bars = series(400, new Map([[300, -0.2]]));
    const events = extractEvents(bars, { symbol: "X", params: FAST, holdCap: 10 });
    expect(events.length).toBeGreaterThan(0);
    expect(events[0].time).toBe(300 * MINUTE);
    expect(events[0].moveBps).toBeLessThan(0);
  });

  it("never lets the trigger bar into its own threshold", () => {
    // One huge bar; if it were observed before being judged, the quantile would
    // rise and the bar could fail its own test. It must still fire.
    const bars = series(400, new Map([[300, 0.5]]));
    const events = extractEvents(bars, { symbol: "X", params: FAST, holdCap: 5 });
    expect(events.map((e) => e.time)).toContain(300 * MINUTE);
  });

  it("collapses a multi-bar flush into one event via cooldown", () => {
    const jumps = new Map([[300, -0.2], [301, -0.2], [302, -0.2]]);
    const bars = series(400, jumps);
    const events = extractEvents(bars, { symbol: "X", params: { ...FAST, cooldownBars: 60 }, holdCap: 5 });
    expect(events).toHaveLength(1);
  });

  it("records the entry bar as the bar after the trigger", () => {
    const bars = series(400, new Map([[300, -0.2]]));
    const [e] = extractEvents(bars, { symbol: "X", params: FAST, holdCap: 5 });
    expect(e.entryOpen).toBe(bars[301].open);
    expect(e.path[0]).toBe(bars[301].open);
    expect(e.path[3]).toBe(bars[304].open);
  });

  it("signs the fade so a reverting move scores positive", () => {
    const bars = series(400, new Map([[300, -0.2], [301, 0.25]]));
    const [e] = extractEvents(bars, { symbol: "X", params: FAST, holdCap: 5 });
    expect(e.fadeCloseBps[1]).toBeGreaterThan(0);
  });

  it("scores a continuing move negative", () => {
    const bars = series(400, new Map([[300, -0.2], [301, -0.1]]));
    const [e] = extractEvents(bars, { symbol: "X", params: FAST, holdCap: 5 });
    expect(e.fadeCloseBps[1]).toBeLessThan(0);
  });

  it("omits horizons the series does not reach", () => {
    const bars = series(305, new Map([[300, -0.2]]));
    const [e] = extractEvents(bars, { symbol: "X", params: FAST, holdCap: 50 });
    expect(e.fadeCloseBps[1]).toBeDefined();
    expect(e.fadeCloseBps[60]).toBeUndefined();
    expect(e.path.length).toBeLessThanOrEqual(4);
  });

  it("carries a volume multiple relative to the prior window", () => {
    const bars = series(400, new Map([[300, -0.2]]));
    bars[300].volume = 1000;
    const [e] = extractEvents(bars, { symbol: "X", params: FAST, holdCap: 5 });
    expect(e.volumeMult).toBeCloseTo(10, 5);
  });

  it("keeps the default params conservative", () => {
    expect(CROSS_SECTION_DEFAULTS.thresholdMode).toBe("expanding");
    expect(CROSS_SECTION_DEFAULTS.percentile).toBe(0.9999);
  });

  it("returns an empty list on an empty series", () => {
    expect(extractEvents([], { symbol: "X" })).toEqual([]);
  });
});

/* ── clustering ───────────────────────────────────────────────────────────── */

function ev(symbol: string, timeMin: number, fade = 10): CascadeEvent {
  return {
    symbol,
    time: timeMin * MINUTE,
    moveBps: -100,
    thresholdBps: 90,
    triggerClose: 100,
    volumeMult: 5,
    entryOpen: 100,
    entryLow: 99,
    entryHigh: 101,
    fadeCloseBps: { 60: fade },
    fadeOpenBps: { 60: fade },
    path: [100, 100],
  };
}

describe("clusterEvents", () => {
  it("puts same-minute events on different symbols in one cluster", () => {
    const clusters = clusterEvents([ev("A", 10), ev("B", 10), ev("C", 10)], 60);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].symbols).toEqual(["A", "B", "C"]);
  });

  it("keeps distant events apart", () => {
    const clusters = clusterEvents([ev("A", 10), ev("B", 1000)], 60);
    expect(clusters).toHaveLength(2);
  });

  it("chains a rolling flush through single linkage", () => {
    const clusters = clusterEvents([ev("A", 10), ev("B", 11), ev("C", 12)], 60);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].events).toHaveLength(3);
  });

  it("breaks the chain when a link exceeds the window", () => {
    const clusters = clusterEvents([ev("A", 10), ev("B", 11), ev("C", 20)], 60);
    expect(clusters).toHaveLength(2);
  });

  it("handles an empty input", () => {
    expect(clusterEvents([], 60)).toEqual([]);
  });

  it("counts one symbol twice in the same cluster only once in symbols", () => {
    const clusters = clusterEvents([ev("A", 10), ev("A", 11)], 60);
    expect(clusters[0].symbols).toEqual(["A"]);
    expect(clusters[0].events).toHaveLength(2);
  });
});

describe("summariseSimultaneity", () => {
  it("reports the clustered share", () => {
    const clusters = clusterEvents([ev("A", 10), ev("B", 10), ev("C", 5000)], 60);
    const s = summariseSimultaneity(clusters);
    expect(s.events).toBe(3);
    expect(s.clusters).toBe(2);
    expect(s.clusteredEvents).toBe(2);
    expect(s.clusteredShare).toBeCloseTo(2 / 3, 6);
    expect(s.maxClusterSize).toBe(2);
  });

  it("builds a size histogram", () => {
    const clusters = clusterEvents([ev("A", 10), ev("B", 10), ev("C", 5000)], 60);
    expect(summariseSimultaneity(clusters).sizeHistogram).toEqual([1, 1]);
  });

  it("survives no clusters at all", () => {
    const s = summariseSimultaneity([]);
    expect(s.events).toBe(0);
    expect(s.clusteredShare).toBe(0);
  });
});

describe("effectiveSampleSize", () => {
  const outcome = (e: CascadeEvent) => e.fadeCloseBps[60];

  it("equals n when every cluster holds one event", () => {
    const events = [ev("A", 10, 5), ev("B", 5000, 15), ev("C", 9000, 25)];
    const r = effectiveSampleSize(clusterEvents(events, 60), outcome);
    expect(r.n).toBe(3);
    expect(r.clusters).toBe(3);
    expect(r.effectiveN).toBeCloseTo(3, 6);
  });

  it("collapses toward the cluster count when a cluster moves in lockstep", () => {
    const events = [
      ev("A", 10, 20), ev("B", 10, 20), ev("C", 10, 20), ev("D", 10, 20),
      ev("E", 5000, 0), ev("F", 5000, 0), ev("G", 5000, 0), ev("H", 5000, 0),
      ev("I", 9000, 40), ev("J", 9000, 40), ev("K", 9000, 40), ev("L", 9000, 40),
    ];
    const r = effectiveSampleSize(clusterEvents(events, 60), outcome);
    expect(r.n).toBe(12);
    expect(r.clusters).toBe(3);
    expect(r.icc).toBeCloseTo(1, 3);
    expect(r.effectiveN).toBeLessThan(4);
  });

  it("keeps effectiveN near n when cluster members disagree", () => {
    const events = [
      ev("A", 10, -60), ev("B", 10, 60), ev("C", 10, -20), ev("D", 10, 20),
      ev("E", 5000, -60), ev("F", 5000, 60), ev("G", 5000, -20), ev("H", 5000, 20),
    ];
    const r = effectiveSampleSize(clusterEvents(events, 60), outcome);
    expect(r.icc).toBeLessThan(0.1);
    expect(r.effectiveN).toBeGreaterThan(6);
  });

  it("computes both a naive and a cluster t", () => {
    const events = [ev("A", 10, 20), ev("B", 10, 20), ev("C", 5000, 10), ev("D", 9000, 30)];
    const r = effectiveSampleSize(clusterEvents(events, 60), outcome);
    expect(Number.isFinite(r.naiveT)).toBe(true);
    expect(Number.isFinite(r.clusterT)).toBe(true);
    expect(r.clusterT).toBeLessThan(r.naiveT);
  });

  it("ignores events with no outcome at the horizon", () => {
    const good = ev("A", 10, 20);
    const blank = ev("B", 5000);
    blank.fadeCloseBps = {};
    const r = effectiveSampleSize(clusterEvents([good, blank], 60), outcome);
    expect(r.n).toBe(1);
  });
});

describe("symbolEffect and reproducibility", () => {
  const outcome = (e: CascadeEvent) => e.fadeCloseBps[60];

  it("summarises one symbol", () => {
    const e = symbolEffect("A", [ev("A", 1, 10), ev("A", 2, 30), ev("A", 3, -20)], outcome);
    expect(e.n).toBe(3);
    expect(e.meanBps).toBeCloseTo(20 / 3, 6);
    expect(e.medianBps).toBe(10);
    expect(e.winRate).toBeCloseTo(2 / 3, 6);
  });

  it("reports how much of the profit sits in one event", () => {
    const e = symbolEffect("A", [ev("A", 1, 1), ev("A", 2, 99)], outcome);
    expect(e.topShare).toBeCloseTo(0.99, 6);
  });

  it("counts positive symbols and scores them against a coin flip", () => {
    const effects = [
      symbolEffect("A", [ev("A", 1, 10)], outcome),
      symbolEffect("B", [ev("B", 1, 10)], outcome),
      symbolEffect("C", [ev("C", 1, 10)], outcome),
      symbolEffect("D", [ev("D", 1, -10)], outcome),
    ];
    const r = reproducibility(effects);
    expect(r.symbols).toBe(4);
    expect(r.positive).toBe(3);
    expect(r.z).toBeCloseTo(1, 6);
  });

  it("drops symbols with no usable events", () => {
    const blank = symbolEffect("Z", [], outcome);
    expect(blank.n).toBe(0);
    expect(reproducibility([blank]).symbols).toBe(0);
  });
});
