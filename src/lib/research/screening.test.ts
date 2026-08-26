import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createCandleStore } from "../data/candleStore.ts";
import { parseInterval } from "../data/interval.ts";
import type { Candle } from "../types.ts";
import { gaussian, mulberry32 } from "./random.ts";
import { runScreen, type ScreenResult } from "./screening.ts";

/**
 * End-to-end check of the screen on a store whose answer is known: fifteen
 * minute returns are built with a strong negative autocorrelation, so the
 * feature that reads the last bar's return must come out with a large negative
 * information coefficient, and nothing else should look remarkable.
 */

const MONTH = "2024-01";
const START = Date.UTC(2024, 0, 1) / 1000;
const MINUTES = 31 * 1440;

function buildMinutes(seed: number, phi: number): Candle[] {
  const rng = mulberry32(seed);
  const out: Candle[] = [];
  let price = 30000;
  let prevBlock = 0;
  const blocks = Math.floor(MINUTES / 15);
  for (let b = 0; b < blocks; b++) {
    const r = phi * prevBlock + gaussian(rng) * 0.004;
    prevBlock = r;
    const step = r / 15;
    for (let m = 0; m < 15; m++) {
      const open = price;
      price = price * Math.exp(step + gaussian(rng) * 0.0002);
      out.push({
        time: START + (b * 15 + m) * 60,
        open,
        high: Math.max(open, price) * 1.0002,
        low: Math.min(open, price) * 0.9998,
        close: price,
        volume: 10 + Math.abs(gaussian(rng)) * 40,
      });
    }
  }
  return out;
}

let root = "";
let result: ScreenResult;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "feature-screen-"));
  const store = createCandleStore(root);
  const interval = parseInterval("1m");
  store.writeMonth({ market: "linear", symbol: "AAAUSDT", interval }, MONTH, buildMinutes(11, -0.35));
  store.writeMonth({ market: "linear", symbol: "BBBUSDT", interval }, MONTH, buildMinutes(29, -0.35));

  result = runScreen({
    dataRoot: root,
    market: "linear",
    symbols: ["AAAUSDT", "BBBUSDT"],
    fromSec: START,
    toSec: START + MINUTES * 60,
    timeframes: ["15m"],
    horizons: [1, 4],
    buckets: 5,
    subperiods: 2,
    shortlist: 4,
  });
}, 300000);

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("runScreen", () => {
  it("screens every feature on every timeframe and horizon", () => {
    expect(result.featureCount).toBeGreaterThan(40);
    // Every feature at both horizons, minus the ones that are constant on this
    // fixture: the synthetic path is continuous, so gap_norm is identically zero
    // and has no ranks to correlate.
    expect(result.cells.length).toBe((result.featureCount - 1) * 2);
    expect(result.cells.some((c) => c.feature === "gap_norm")).toBe(false);
    expect(result.icAdjusted.length).toBe(result.cells.length);
  });

  it("counts bars per symbol", () => {
    expect(result.perSymbolBars.AAAUSDT["15m"]).toBeGreaterThan(2900);
    expect(result.perSymbolBars.BBBUSDT["15m"]).toBeGreaterThan(2900);
  });

  it("finds the planted reversal in the last bar's return", () => {
    const cell = result.cells.find((c) => c.feature === "ret_1_norm" && c.horizon === 1);
    expect(cell).toBeDefined();
    expect(cell!.ic).toBeLessThan(-0.2);
    expect(cell!.z).toBeLessThan(-8);
    expect(cell!.symbolAgree).toBe(2);
    expect(cell!.sliceAgree).toBe(cell!.sliceTotal);
  });

  it("the planted feature also shows a monotone quantile profile", () => {
    const cell = result.cells.find((c) => c.feature === "ret_1_norm" && c.horizon === 1)!;
    expect(cell.bucketBps[0]).toBeGreaterThan(cell.bucketBps[cell.bucketBps.length - 1]);
    expect(cell.spreadBps).toBeLessThan(0);
    expect(cell.monotonicity).toBeLessThan(-0.5);
  });

  it("leaves features that cannot see the planted signal unremarkable", () => {
    // Volatility features describe the size of the move, not its sign, and the
    // fixture puts nothing directional in them.
    const vol = result.cells.filter((c) => c.group === "volatility");
    const big = vol.filter((c) => Math.abs(c.z) > result.family.zThreshold);
    expect(big).toHaveLength(0);
  });

  it("measures the cross-symbol correlation it uses to inflate the pooled errors", () => {
    // Two independently generated symbols: the inflation should be near nothing.
    expect(Math.abs(result.crossCorr["15m"])).toBeLessThan(0.1);
  });

  it("reports the size of the whole family it looked at", () => {
    const f = result.family;
    expect(f.total).toBe(f.icTests + f.shapeTests + f.regimeTests + f.pairTests);
    expect(f.zThreshold).toBeGreaterThan(3);
    expect(f.expectedMaxZ).toBeGreaterThan(2.5);
    expect(f.expectedMaxZ).toBeLessThan(f.zThreshold);
  });

  it("carries the per-symbol detail behind every pooled number", () => {
    for (const c of result.cells) {
      expect(c.perSymbol.length).toBeGreaterThan(0);
      for (const s of c.perSymbol) expect(["AAAUSDT", "BBBUSDT"]).toContain(s.symbol);
    }
  });

  it("runs the regime and pair stages on the shortlist", () => {
    expect(result.regimes.length).toBeGreaterThan(0);
    expect(result.pairs.length).toBeGreaterThan(0);
    for (const g of result.regimes) expect(g.perRegime.length).toBeGreaterThan(1);
  });

  it("skips a timeframe with too few bars instead of throwing", () => {
    const tiny = runScreen({
      dataRoot: root,
      market: "linear",
      symbols: ["AAAUSDT"],
      fromSec: START,
      toSec: START + 3600,
      timeframes: ["1d"],
      horizons: [1],
    });
    expect(tiny.cells).toHaveLength(0);
    expect(tiny.family.total).toBe(0);
  });
});
