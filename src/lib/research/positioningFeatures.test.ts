import { describe, expect, it } from "vitest";
import { METRICS_STEP_SEC, type MetricsRow } from "../data/metricsArchive.ts";
import type { Candle } from "../types.ts";
import {
  DEFAULT_MAX_STALE_SEC,
  DEFAULT_PUBLISH_LAG_SEC,
  SLOTS_28D,
  alignmentDiagnostic,
  asOfSeries,
  asOfSlot,
  buildPositioningSeries,
  inferIntervalSec,
  positioningFeatureSpecs,
} from "./positioningFeatures.ts";
import { buildPositioningGrid } from "./positioningGrid.ts";
import { gaussian, mulberry32 } from "./random.ts";

const T0 = Date.UTC(2024, 0, 1) / 1000;

/** A synthetic five-minute metrics series long enough to fill the 28-day windows. */
function synthetic(n: number, seed = 7): MetricsRow[] {
  const rng = mulberry32(seed);
  const out: MetricsRow[] = [];
  let oi = 80_000;
  let price = 40_000;
  let ttPos = 1.5;
  let acc = 2.3;
  for (let i = 0; i < n; i++) {
    oi *= Math.exp(gaussian(rng) * 0.002);
    price *= Math.exp(gaussian(rng) * 0.0015);
    ttPos *= Math.exp(gaussian(rng) * 0.01);
    acc *= Math.exp(gaussian(rng) * 0.01);
    out.push({
      timeSec: T0 + i * METRICS_STEP_SEC,
      openInterest: oi,
      openInterestValue: oi * price,
      topTraderAccountRatio: 2 + gaussian(rng) * 0.05,
      topTraderPositionRatio: ttPos,
      accountRatio: acc,
      takerVolumeRatio: Math.exp(gaussian(rng) * 0.2),
    });
  }
  return out;
}

/** Hourly bars covering the same span, closing on the hour. */
function hourlyBars(count: number, startSec = T0): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: startSec + i * 3600,
    open: 1,
    high: 1,
    low: 1,
    close: 1,
    volume: 1,
  }));
}

const ROWS = synthetic(9000);
const SET = buildPositioningSeries(ROWS);

describe("asOfSlot", () => {
  const grid = buildPositioningGrid(synthetic(20));
  const values = grid.openInterest;

  it("never uses a snapshot that would still be unpublished at the bar close", () => {
    // A bar closing at T0 + 3600 sees the snapshot stamped T0 + 3300, whose
    // publication time is exactly that close. The one stamped T0 + 3600 belongs
    // to the future and must not be reachable.
    const slot = asOfSlot(grid, values, T0 + 3600, DEFAULT_PUBLISH_LAG_SEC, DEFAULT_MAX_STALE_SEC);
    expect(slot).toBe(11);
    expect(grid.startSec + slot * METRICS_STEP_SEC).toBe(T0 + 3300);
    expect(grid.startSec + slot * METRICS_STEP_SEC + DEFAULT_PUBLISH_LAG_SEC).toBeLessThanOrEqual(T0 + 3600);
  });

  it("moves the boundary when the lag is raised", () => {
    expect(asOfSlot(grid, values, T0 + 3600, 900, DEFAULT_MAX_STALE_SEC)).toBe(9);
  });

  it("has nothing to offer before the series starts", () => {
    expect(asOfSlot(grid, values, T0, DEFAULT_PUBLISH_LAG_SEC, DEFAULT_MAX_STALE_SEC)).toBe(-1);
  });

  it("skips a hole but refuses to hand back a stale reading", () => {
    const holed = buildPositioningGrid([
      ...synthetic(4),
      { ...synthetic(1)[0], timeSec: T0 + 40 * METRICS_STEP_SEC },
    ]);
    const barClose = T0 + 20 * METRICS_STEP_SEC;
    // The newest publishable slot is a hole; the last real one is far behind.
    expect(asOfSlot(holed, holed.openInterest, barClose, DEFAULT_PUBLISH_LAG_SEC, 3600)).toBe(-1);
    expect(asOfSlot(holed, holed.openInterest, T0 + 5 * METRICS_STEP_SEC, DEFAULT_PUBLISH_LAG_SEC, 3600)).toBe(3);
  });
});

describe("inferIntervalSec", () => {
  it("reads the timeframe off the bars", () => {
    expect(inferIntervalSec(hourlyBars(5))).toBe(3600);
  });

  it("takes the smallest spacing, so a gap does not masquerade as the timeframe", () => {
    const bars = [...hourlyBars(3), { ...hourlyBars(1)[0], time: T0 + 10 * 3600 }];
    expect(inferIntervalSec(bars)).toBe(3600);
  });
});

describe("asOfSeries", () => {
  it("hands each bar the newest snapshot it could have had, and no other", () => {
    const rows = synthetic(200);
    const grid = buildPositioningGrid(rows);
    const marker = Float64Array.from(Array.from({ length: grid.length }, (_, i) => i));
    const bars = hourlyBars(10, T0);
    const series = asOfSeries(grid, marker, bars);
    for (let i = 0; i < bars.length; i++) {
      const close = bars[i].time + 3600;
      const expected = Math.floor((close - DEFAULT_PUBLISH_LAG_SEC - grid.startSec) / METRICS_STEP_SEC);
      if (expected < 0) expect(series[i]).toBeNull();
      else expect(series[i]).toBe(expected);
    }
  });

  it("is null before the metrics begin rather than borrowing from the future", () => {
    const grid = buildPositioningGrid(synthetic(50));
    const bars = hourlyBars(5, T0 - 10 * 3600);
    expect(asOfSeries(grid, grid.openInterest, bars).slice(0, 5).every((v) => v === null)).toBe(true);
  });
});

describe("buildPositioningSeries", () => {
  it("produces a named, documented series for every feature", () => {
    expect(SET.byName.size).toBeGreaterThanOrEqual(25);
    for (const name of SET.byName.keys()) {
      expect(name, name).toMatch(/^pos_[a-z0-9_]+$/);
      expect((SET.notes.get(name) ?? "").length, name).toBeGreaterThan(8);
      expect(SET.byName.get(name)!.length).toBe(SET.grid.length);
    }
  });

  it("has finite values once the trailing windows are filled", () => {
    for (const [name, values] of SET.byName) {
      let finite = 0;
      for (let i = SLOTS_28D + 300; i < values.length; i++) if (Number.isFinite(values[i])) finite++;
      expect(finite, name).toBeGreaterThan(100);
    }
  });

  it("computes every value from the past alone", () => {
    // The same series built from a truncated history must agree everywhere the
    // truncated history reaches. This is the whole no-lookahead claim, checked
    // on all features at once rather than argued from the source.
    const cut = 6000;
    const truncated = buildPositioningSeries(ROWS.slice(0, cut));
    expect(truncated.grid.startSec).toBe(SET.grid.startSec);
    for (const [name, full] of SET.byName) {
      const part = truncated.byName.get(name)!;
      for (let i = 0; i < cut; i++) {
        if (Number.isFinite(full[i]) !== Number.isFinite(part[i])) {
          throw new Error(`${name} at ${i}: full=${full[i]} truncated=${part[i]}`);
        }
        if (Number.isFinite(full[i])) expect(part[i], `${name} at ${i}`).toBeCloseTo(full[i], 9);
      }
    }
  });

  it("is invariant to the scale of open interest", () => {
    const scaled = buildPositioningSeries(
      ROWS.map((r) => ({ ...r, openInterest: r.openInterest * 1000, openInterestValue: r.openInterestValue * 1000 })),
    );
    for (const [name, base] of SET.byName) {
      const other = scaled.byName.get(name)!;
      for (let i = 0; i < base.length; i += 137) {
        if (!Number.isFinite(base[i])) continue;
        expect(other[i], `${name} at ${i}`).toBeCloseTo(base[i], 8);
      }
    }
  });

  it("is invariant to the scale of price", () => {
    const scaled = buildPositioningSeries(ROWS.map((r) => ({ ...r, openInterestValue: r.openInterestValue * 7 })));
    for (const [name, base] of SET.byName) {
      const other = scaled.byName.get(name)!;
      for (let i = 0; i < base.length; i += 137) {
        if (!Number.isFinite(base[i])) continue;
        expect(other[i], `${name} at ${i}`).toBeCloseTo(base[i], 8);
      }
    }
  });

  it("reads a rising open interest as a positive change", () => {
    const rising = synthetic(400).map((r, i) => ({ ...r, openInterest: 1000 * Math.exp(i * 0.001) }));
    const set = buildPositioningSeries(rising.map((r) => ({ ...r, openInterestValue: r.openInterest * 40_000 })));
    const chg = set.byName.get("pos_oi_chg_1h")!;
    expect(chg[300]).toBeCloseTo(0.012, 6);
  });
});

describe("positioningFeatureSpecs", () => {
  const specs = positioningFeatureSpecs(SET);
  const bars = hourlyBars(700, T0 + SLOTS_28D * METRICS_STEP_SEC);

  it("presents itself to the screener as an ordinary feature catalogue", () => {
    expect(specs.length).toBe(SET.byName.size);
    for (const s of specs) {
      expect(s.group).toBe("positioning");
      const series = s.compute(bars);
      expect(series.length, s.name).toBe(bars.length);
      expect(series.some((v) => v !== null), s.name).toBe(true);
    }
  });

  it("gives a bar the same value however much history follows it", () => {
    const early = bars.slice(0, 100);
    for (const s of specs) {
      const long = s.compute(bars).slice(0, 100);
      const short = s.compute(early);
      expect(short, s.name).toEqual(long);
    }
  });
});

describe("alignmentDiagnostic", () => {
  it("finds the window a taker ratio actually describes", () => {
    // Built so the ratio stamped T explains the move over [T, T+5m): the
    // stamp is the start of the window it summarises.
    const rng = mulberry32(11);
    const rows: MetricsRow[] = [];
    let price = 40_000;
    const pending: number[] = [];
    for (let i = 0; i < 2000; i++) pending.push(gaussian(rng));
    for (let i = 0; i < 2000; i++) {
      rows.push({
        timeSec: T0 + i * METRICS_STEP_SEC,
        openInterest: 1000,
        openInterestValue: 1000 * price,
        topTraderAccountRatio: 2,
        topTraderPositionRatio: 1.5,
        accountRatio: 2.3,
        takerVolumeRatio: Math.exp(pending[i] * 0.2),
      });
      price *= Math.exp(pending[i] * 0.001);
    }
    const diag = alignmentDiagnostic(buildPositioningGrid(rows));
    expect(diag.n).toBeGreaterThan(1000);
    expect(diag.corrWithNextBar).toBeGreaterThan(0.9);
    expect(Math.abs(diag.corrWithPastBar)).toBeLessThan(0.2);
  });
});
