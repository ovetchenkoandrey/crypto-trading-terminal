import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Candle } from "../types.ts";
import { createCandleStore, type CandleStore } from "../data/candleStore.ts";
import { createFundingStore, type FundingStore } from "../data/fundingStore.ts";
import { monthStartSec } from "../data/months.ts";
import type { DatasetKey } from "../data/paths.ts";
import type { BacktestParams, BacktestResult } from "../execution/backtest/runner";
import { coverageOf, loadCandles, loadFunding, runFromSpec, runSpecs } from "./cliRun.ts";
import { resolveRunSpec, type CostsDecl, type RunDecl, type RunSpec } from "./runConfig.ts";

const KEY: DatasetKey = { market: "linear", symbol: "BTCUSDT", interval: "1m" };
const MONTH = "2026-04";
const START = monthStartSec(MONTH);

const COSTS: CostsDecl = {
  fees: "bybit-linear",
  slippage: { kind: "fixed_bps", bps: 5 },
  rules: true,
  funding: true,
};

/** Deterministic saw-tooth around 70000 — enough for a grid to round-trip. */
function sawtooth(bars: number): Candle[] {
  return Array.from({ length: bars }, (_, i) => {
    const close = 70_000 + Math.sin(i / 40) * 1500;
    return {
      time: START + i * 60,
      open: close,
      high: close + 60,
      low: close - 60,
      close,
      volume: 10,
    };
  });
}

function makeSpec(over: Partial<RunDecl> = {}): RunSpec {
  return resolveRunSpec({
    name: "grid-test",
    symbol: "BTCUSDT",
    interval: "1m",
    from: MONTH,
    to: MONTH,
    initialBalance: 1000,
    bot: { kind: "grid", params: { lowPrice: 68_500, highPrice: 71_500, levels: 10, qtyPerLevel: 0.001 } },
    costs: COSTS,
    ...over,
  });
}

let root: string;
let candles: CandleStore;
let funding: FundingStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "cli-backtest-"));
  candles = createCandleStore(root);
  funding = createFundingStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("loadCandles", () => {
  it("reads the requested slice out of the on-disk store", () => {
    candles.writeMonth(KEY, MONTH, sawtooth(500), { source: "binance-archive", complete: true });
    const spec = makeSpec({ from: START, to: START + 99 * 60 });
    expect(loadCandles(candles, spec)).toHaveLength(100);
  });

  it("refuses an empty slice instead of reporting a run of zeroes", () => {
    expect(() => loadCandles(candles, makeSpec())).toThrow(/no candles for linear:BTCUSDT:1m/);
  });

  it("says what the dataset does hold when the range misses", () => {
    candles.writeMonth(KEY, MONTH, sawtooth(10), { source: "binance-archive", complete: true });
    expect(() => loadCandles(candles, makeSpec({ from: "2026-06", to: "2026-06" }))).toThrow(/dataset holds 10 bar/);
  });
});

describe("loadFunding", () => {
  it("converts stored settlements into engine events inside the range", () => {
    funding.writeMonth("linear", "BTCUSDT", MONTH, [
      { time: START + 3600, rate: 0.0001 },
      { time: START + 100 * 86_400, rate: 0.0002 },
    ], 480);
    const events = loadFunding(funding, makeSpec({ from: START, to: START + 86_400 }));
    expect(events).toEqual([{ timestamp: START + 3600, rate: 0.0001 }]);
  });
});

describe("coverageOf", () => {
  it("reports the share of expected bars that are actually present", () => {
    const spec = makeSpec({ from: START, to: START + 99 * 60 + 59 });
    expect(coverageOf(sawtooth(100), spec)).toMatchObject({ bars: 100, expectedBars: 100, ratio: 1 });
    expect(coverageOf(sawtooth(50), spec).ratio).toBeCloseTo(0.5, 10);
  });
});

describe("runFromSpec", () => {
  beforeEach(() => {
    candles.writeMonth(KEY, MONTH, sawtooth(4000), { source: "binance-archive", complete: true });
    funding.writeMonth("linear", "BTCUSDT", MONTH, [
      { time: START + 8 * 3600, rate: 0.0001 },
      { time: START + 16 * 3600, rate: 0.0001 },
    ], 480);
  });

  it("runs the real engine end to end off local files", async () => {
    const spec = makeSpec({ from: START, to: START + 3999 * 60 });
    const outcome = await runFromSpec(spec, { dataRoot: root, stores: { candles, funding } });

    expect(outcome.coverage.bars).toBe(4000);
    expect(outcome.report.run.bars).toBe(4000);
    expect(outcome.report.stats.trades).toBeGreaterThan(0);
    expect(outcome.report.costs.applied).toEqual(
      expect.arrayContaining(["maker/taker fees", "instrument rules", "funding"]),
    );
    expect(outcome.fundingEvents).toBe(2);
    expect(outcome.report.criteria.checks.length).toBeGreaterThan(5);
  });

  it("is reproducible — the same spec twice gives the same numbers", async () => {
    const spec = makeSpec({ from: START, to: START + 3999 * 60 });
    const a = await runFromSpec(spec, { dataRoot: root, stores: { candles, funding } });
    const b = await runFromSpec(spec, { dataRoot: root, stores: { candles, funding } });
    expect(b.report.stats).toEqual(a.report.stats);
    expect(b.report.streaks).toEqual(a.report.streaks);
  });

  it("skips the funding store when funding was not declared", async () => {
    const spec = makeSpec({
      from: START,
      to: START + 999 * 60,
      costs: { fees: "bybit-linear", slippage: false },
    });
    const outcome = await runFromSpec(spec, { dataRoot: root, stores: { candles, funding } });
    expect(outcome.fundingEvents).toBe(0);
    expect(outcome.report.execution.funding).toBe(0);
    expect(outcome.report.costs.applied).toEqual(["maker/taker fees"]);
  });

  it("runs a second, stressed backtest when stressSlippage is set", async () => {
    const engine = vi.fn(async (params: BacktestParams): Promise<BacktestResult> => ({
      params,
      costsApplied: [],
      funding: 0,
      rejected: 0,
      liquidations: 0,
      stats: {
        netProfit: 0, netProfitPct: 0, trades: 0, wins: 0, losses: 0, winRate: 0,
        profitFactor: 0, maxDrawdown: 0, maxDrawdownPct: 0, avgTrade: 0, avgWin: 0,
        avgLoss: 0, avgHoldSec: 0, sharpeDaily: 0,
      },
      trades: [],
      positions: [],
      orders: [],
      equity: [],
    }));

    const spec = makeSpec({ from: START, to: START + 999 * 60, stressSlippage: 2 });
    const outcome = await runFromSpec(spec, { dataRoot: root, stores: { candles, funding }, runner: engine });

    expect(engine).toHaveBeenCalledTimes(2);
    expect(engine.mock.calls[0][0].slippageCfg).toMatchObject({ kind: "fixed_bps", bps: 5 });
    expect(engine.mock.calls[1][0].slippageCfg).toMatchObject({ kind: "fixed_bps", bps: 10 });
    expect(outcome.stressResult).not.toBeNull();
    expect(outcome.report.stress).toMatchObject({ multiplier: 2 });
  });

  it("reports progress for both the plain and the stressed pass", async () => {
    const seen = new Set<boolean>();
    const spec = makeSpec({ from: START, to: START + 199 * 60, stressSlippage: 2 });
    await runFromSpec(spec, {
      dataRoot: root,
      stores: { candles, funding },
      onProgress: (p) => { seen.add(p.stress); },
    });
    expect(seen).toEqual(new Set([false, true]));
  });
});

describe("runSpecs", () => {
  it("keeps going after a run that has no data and reports it", async () => {
    candles.writeMonth(KEY, MONTH, sawtooth(2000), { source: "binance-archive", complete: true });
    const ok = makeSpec({ name: "ok", from: START, to: START + 1999 * 60 });
    const broken = makeSpec({ name: "broken", symbol: "ETHUSDT", from: START, to: START + 1999 * 60 });

    const { outcomes, failures } = await runSpecs([broken, ok], { dataRoot: root, stores: { candles, funding } });
    expect(outcomes.map((o) => o.spec.name)).toEqual(["ok"]);
    expect(failures).toHaveLength(1);
    expect(failures[0].spec.name).toBe("broken");
    expect(failures[0].error).toMatch(/no candles/);
  });
});
