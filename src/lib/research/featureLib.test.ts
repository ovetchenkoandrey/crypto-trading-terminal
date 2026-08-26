import { describe, expect, it } from "vitest";
import type { Candle } from "../types.ts";
import { featureCatalog, regimeCatalog } from "./featureLib.ts";
import { gaussian, mulberry32 } from "./random.ts";

/** A synthetic hour series with drift, wicks, volume and a UTC-aligned clock. */
function synthetic(n: number, seed = 2024): Candle[] {
  const rng = mulberry32(seed);
  const out: Candle[] = [];
  let price = 20000;
  for (let i = 0; i < n; i++) {
    const open = price;
    price = price * Math.exp(gaussian(rng) * 0.004 + 0.00005);
    const up = Math.abs(gaussian(rng)) * price * 0.002;
    const down = Math.abs(gaussian(rng)) * price * 0.002;
    out.push({
      time: i * 3600,
      open,
      high: Math.max(open, price) + up,
      low: Math.min(open, price) - down,
      close: price,
      volume: 50 + Math.abs(gaussian(rng)) * 200,
    });
  }
  return out;
}

const CANDLES = synthetic(1200);
const CATALOG = featureCatalog();

describe("featureCatalog", () => {
  it("has unique names", () => {
    const names = CATALOG.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("carries a group and a note for every feature", () => {
    for (const s of CATALOG) {
      expect(s.name, s.name).toMatch(/^[a-z0-9_]+$/);
      expect(s.note.length, s.name).toBeGreaterThan(4);
    }
  });

  it("every feature returns a series as long as the input", () => {
    for (const s of CATALOG) {
      expect(s.compute(CANDLES).length, s.name).toBe(CANDLES.length);
    }
  });

  it("every feature is defined for most of the tail", () => {
    for (const s of CATALOG) {
      const tail = s.compute(CANDLES).slice(-300);
      const defined = tail.filter((v) => v !== null && Number.isFinite(v)).length;
      expect(defined, s.name).toBeGreaterThan(250);
    }
  });

  it("no feature produces a non-finite number where it produces a number at all", () => {
    for (const s of CATALOG) {
      for (const v of s.compute(CANDLES)) {
        if (v === null) continue;
        expect(Number.isFinite(v), s.name).toBe(true);
      }
    }
  });

  it("no feature looks into the future", () => {
    const prefix = CANDLES.slice(0, 900);
    const at = 850;
    for (const s of CATALOG) {
      const a = s.compute(prefix)[at];
      const b = s.compute(CANDLES)[at];
      if (a === null) {
        expect(b, s.name).toBeNull();
        continue;
      }
      expect(b as number, s.name).toBeCloseTo(a as number, 8);
    }
  });

  it("is scale invariant: doubling every price leaves the features unchanged", () => {
    const scaled = CANDLES.map((c) => ({ ...c, open: c.open * 2, high: c.high * 2, low: c.low * 2, close: c.close * 2 }));
    // trix is a percent change and roc_10 is a percent change; both are already
    // ratios, so the whole catalogue should be invariant.
    for (const s of CATALOG) {
      const a = s.compute(CANDLES)[1000];
      const b = s.compute(scaled)[1000];
      if (a === null) {
        expect(b, s.name).toBeNull();
        continue;
      }
      expect(b as number, s.name).toBeCloseTo(a as number, 6);
    }
  });

  it("covers every declared group", () => {
    const groups = new Set(CATALOG.map((s) => s.group));
    expect(groups).toEqual(new Set(["trend", "momentum", "meanReversion", "volume", "volatility", "shape"]));
  });

  it("has at least forty features", () => {
    expect(CATALOG.length).toBeGreaterThanOrEqual(40);
  });
});

describe("regimeCatalog", () => {
  const regimes = regimeCatalog();

  it("labels every regime it can emit", () => {
    for (const r of regimes) {
      const values = r.compute(CANDLES);
      expect(values.length, r.name).toBe(CANDLES.length);
      for (const v of values) {
        expect(v, r.name).toBeGreaterThanOrEqual(-1);
        expect(v, r.name).toBeLessThan(r.labels.length);
      }
    }
  });

  it("volatility terciles are roughly equal in size", () => {
    const spec = regimes.find((r) => r.name === "volatility")!;
    const values = spec.compute(CANDLES);
    const counts = [0, 0, 0];
    for (const v of values) if (v >= 0) counts[v]++;
    const total = counts.reduce((a, b) => a + b, 0);
    for (const c of counts) expect(c / total).toBeGreaterThan(0.25);
  });

  it("the session regime follows the UTC clock", () => {
    const spec = regimes.find((r) => r.name === "session")!;
    const bars: Candle[] = [0, 7, 13, 20].map((h) => ({
      time: h * 3600,
      open: 1,
      high: 1,
      low: 1,
      close: 1,
      volume: 1,
    }));
    expect(Array.from(spec.compute(bars))).toEqual([0, 1, 2, 3]);
  });

  it("the trend regime splits on the 200 EMA", () => {
    const spec = regimes.find((r) => r.name === "trend")!;
    const rising = Array.from({ length: 400 }, (_, i) => ({
      time: i * 3600,
      open: 100 + i,
      high: 101 + i,
      low: 99 + i,
      close: 100.5 + i,
      volume: 1,
    }));
    const values = spec.compute(rising);
    expect(values[399]).toBe(1);
    expect(values[100]).toBe(-1);
  });

  it("a regime never claims a value before its indicator exists", () => {
    const spec = regimes.find((r) => r.name === "range")!;
    const values = spec.compute(CANDLES);
    expect(values[0]).toBe(-1);
    expect(values[CANDLES.length - 1]).toBeGreaterThanOrEqual(0);
  });
});
