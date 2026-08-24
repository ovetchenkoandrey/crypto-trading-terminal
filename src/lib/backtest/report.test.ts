import { describe, expect, it } from "vitest";
import type { BacktestStats, EquitySample } from "../execution/backtest/stats";
import {
  ACCEPTANCE,
  annualizeSharpe,
  buildReport,
  checkCriteria,
  computeRollingWindows,
  computeStreaks,
  formatReportText,
  formatSummaryTable,
  TRADING_DAYS_PER_YEAR,
} from "./report.ts";
import { resolveRunSpec, type CostsDecl, type RunSpec } from "./runConfig.ts";

const COSTS: CostsDecl = { fees: "bybit-linear", slippage: { kind: "fixed_bps", bps: 5 } };

function spec(over: Record<string, unknown> = {}): RunSpec {
  return resolveRunSpec({
    name: "t",
    symbol: "BTCUSDT",
    from: "2026-04",
    to: "2026-04",
    bot: { kind: "grid" },
    costs: COSTS,
    ...over,
  });
}

function pnls(...values: number[]) {
  return values.map((pnl) => ({ pnl }));
}

function statsWith(over: Partial<BacktestStats> = {}): BacktestStats {
  return {
    netProfit: 0,
    netProfitPct: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    profitFactor: 0,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    avgTrade: 0,
    avgWin: 0,
    avgLoss: 0,
    avgHoldSec: 0,
    sharpeDaily: 0,
    ...over,
  };
}

/** Daily equity samples starting at 2026-04-01, one per `stepSec`. */
function equity(values: number[], stepSec = 86_400): EquitySample[] {
  const start = Date.UTC(2026, 3, 1) / 1000;
  return values.map((v, i) => ({ time: start + i * stepSec, equity: v }));
}

describe("computeStreaks", () => {
  it("finds the longest losing run and its distribution", () => {
    const s = computeStreaks(pnls(-1, -1, -1, 5, -1, 3, -1, -1, 4));
    expect(s.maxLossStreak).toBe(3);
    expect(s.lossStreaks).toBe(3);
    expect(s.lossDistribution).toEqual([
      { length: 1, count: 1 },
      { length: 2, count: 1 },
      { length: 3, count: 1 },
    ]);
    expect(s.avgLossStreak).toBeCloseTo(2, 10);
  });

  it("counts a losing run that is still open when the series ends", () => {
    const s = computeStreaks(pnls(5, -1, -1));
    expect(s.maxLossStreak).toBe(2);
    expect(s.finalLossStreak).toBe(2);
    expect(s.lossDistribution).toEqual([{ length: 2, count: 1 }]);
  });

  it("does not let a break-even trade extend a streak", () => {
    const s = computeStreaks(pnls(-1, -1, 0, -1));
    expect(s.maxLossStreak).toBe(2);
    expect(s.lossStreaks).toBe(2);
  });

  it("tracks the winning run separately", () => {
    const s = computeStreaks(pnls(1, 2, 3, -1, 1));
    expect(s.maxWinStreak).toBe(3);
    expect(s.maxLossStreak).toBe(1);
  });

  it("returns zeroes for an empty history", () => {
    const s = computeStreaks([]);
    expect(s).toMatchObject({ maxLossStreak: 0, maxWinStreak: 0, lossStreaks: 0, avgLossStreak: 0 });
    expect(s.lossDistribution).toEqual([]);
  });
});

describe("computeRollingWindows", () => {
  it("counts a window as profitable when it ends above its start", () => {
    // 60 daily samples: first 30 rising, next 30 falling back.
    const rising = Array.from({ length: 31 }, (_, i) => 1000 + i * 10);
    const falling = Array.from({ length: 30 }, (_, i) => 1300 - i * 10);
    const r = computeRollingWindows(equity([...rising, ...falling]), { days: 30, stepDays: 30 });
    expect(r.windows).toBe(2);
    expect(r.profitable).toBe(1);
    expect(r.share).toBeCloseTo(0.5, 10);
    expect(r.best!.returnPct).toBeGreaterThan(0);
    expect(r.worst!.returnPct).toBeLessThan(0);
  });

  it("reports insufficient data instead of inventing a window", () => {
    const r = computeRollingWindows(equity([1000, 1010, 1020]), { days: 30, stepDays: 7 });
    expect(r.windows).toBe(0);
    expect(r.share).toBe(0);
    expect(r.insufficient).toBe(true);
  });

  it("credits the last bar with the interval it covers", () => {
    // Exactly one month of minute bars, equity sampled from bar 1 onward: without
    // the bar-width credit this lands one bar short of a single 30-day window.
    const start = Date.UTC(2026, 3, 1) / 1000;
    const bars = 30 * 1440;
    const series: EquitySample[] = Array.from({ length: bars - 1 }, (_, i) => ({
      time: start + (i + 1) * 60,
      equity: 1000 + i,
    }));
    const naive = computeRollingWindows(series, { days: 30, stepDays: 7 });
    expect(naive.windows).toBe(0);
    const anchored = computeRollingWindows(series, { days: 30, stepDays: 7 }, { barSec: 60, startSec: start });
    expect(anchored.windows).toBe(1);
    expect(anchored.profitable).toBe(1);
  });

  it("steps windows by the requested stride", () => {
    const r = computeRollingWindows(equity(Array.from({ length: 61 }, (_, i) => 1000 + i)), { days: 30, stepDays: 7 });
    expect(r.windows).toBe(5); // day 0, 7, 14, 21, 28 — day 35 would end past the series
    expect(r.profitable).toBe(5);
  });
});

describe("annualizeSharpe", () => {
  it("scales the daily figure by the square root of the year", () => {
    expect(annualizeSharpe(0.1)).toBeCloseTo(0.1 * Math.sqrt(TRADING_DAYS_PER_YEAR), 10);
    expect(annualizeSharpe(0)).toBe(0);
  });
});

describe("checkCriteria", () => {
  const passing = {
    stats: statsWith({
      trades: 150,
      profitFactor: 1.8,
      maxDrawdownPct: 12,
      sharpeDaily: 0.1,
    }),
    rolling: { windowDays: 30, stepDays: 7, windows: 10, profitable: 7, share: 0.7, best: null, worst: null, insufficient: false },
    streaks: computeStreaks(pnls(-1, -1, 3)),
  };

  it("passes when every gate is met", () => {
    const v = checkCriteria({ ...passing, stressProfitFactor: 1.6 });
    expect(v.passed).toBe(true);
    expect(v.failed).toEqual([]);
    expect(v.unchecked).toEqual([]);
  });

  it("gates Sharpe on the annualised figure, not the daily one", () => {
    // 0.06 daily = 1.15 annualised: passes the annual bar, fails a naive daily read.
    const v = checkCriteria({ ...passing, stats: statsWith({ ...passing.stats, sharpeDaily: 0.06 }), stressProfitFactor: 2 });
    const sharpe = v.checks.find((c) => c.key === "sharpe")!;
    expect(sharpe.passed).toBe(true);
    expect(sharpe.raw).toBeCloseTo(0.06 * Math.sqrt(365), 6);
    expect(sharpe.note).toMatch(/daily 0\.0600/);
  });

  it("fails each threshold from the strategy document", () => {
    const v = checkCriteria({
      stats: statsWith({ trades: 40, profitFactor: 1.1, maxDrawdownPct: 33, sharpeDaily: -0.01 }),
      rolling: { windowDays: 30, stepDays: 7, windows: 10, profitable: 3, share: 0.3, best: null, worst: null, insufficient: false },
      streaks: computeStreaks(pnls(-1)),
      stressProfitFactor: 0.4,
    });
    expect(v.passed).toBe(false);
    expect(v.failed).toEqual(
      expect.arrayContaining(["profitFactor", "trades", "maxDrawdown", "sharpe", "profitableWindows", "costStress"]),
    );
  });

  it("marks the stress criterion unchecked when no stress run was made", () => {
    const v = checkCriteria(passing);
    expect(v.unchecked).toContain("costStress");
    expect(v.passed).toBe(false);
  });

  it("marks the rolling-window criterion unchecked when the run is too short", () => {
    const v = checkCriteria({
      ...passing,
      rolling: { windowDays: 30, stepDays: 7, windows: 0, profitable: 0, share: 0, best: null, worst: null, insufficient: true },
      stressProfitFactor: 2,
    });
    expect(v.unchecked).toContain("profitableWindows");
    expect(v.passed).toBe(false);
  });

  it("fails the run outright on a liquidation", () => {
    const v = checkCriteria({ ...passing, stressProfitFactor: 1.6, liquidations: 1 });
    expect(v.failed).toContain("liquidations");
    expect(v.passed).toBe(false);
  });

  it("records the max losing streak without gating on it", () => {
    const v = checkCriteria({ ...passing, stressProfitFactor: 1.6, streaks: computeStreaks(pnls(-1, -1, -1, -1, 2)) });
    const streak = v.checks.find((c) => c.key === "maxLossStreak")!;
    expect(streak.gate).toBe(false);
    expect(streak.raw).toBe(4);
    expect(v.passed).toBe(true);
  });

  it("uses the thresholds published in docs/strategy-search.md", () => {
    expect(ACCEPTANCE).toEqual({
      profitFactor: 1.3,
      trades: 100,
      maxDrawdownPct: 20,
      sharpeAnnual: 1.0,
      profitableWindowShare: 0.6,
      stressMultiplier: 2,
    });
  });
});

describe("buildReport", () => {
  const base = {
    spec: spec(),
    bars: 100,
    durationMs: 1234,
    stats: statsWith({ trades: 3, netProfit: 12, profitFactor: 2, sharpeDaily: 0.05 }),
    equity: equity([1000, 1005, 1012]),
    trades: pnls(-4, 8, 8),
    funding: -1.25,
    rejected: 7,
    liquidations: 0,
    openPositions: 1,
    pendingOrders: 2,
    costsApplied: ["maker/taker fees", "funding"],
    costsDetail: ["fees: maker 0.02% / taker 0.055%", "funding: on, 3 settlement(s) in range"],
    now: Date.UTC(2026, 7, 24),
  };

  it("carries the engine numbers and the derived ones side by side", () => {
    const r = buildReport(base);
    expect(r.run.name).toBe("t");
    expect(r.run.bars).toBe(100);
    expect(r.stats.sharpeAnnual).toBeCloseTo(annualizeSharpe(0.05), 10);
    expect(r.stats.finalEquity).toBe(1012);
    expect(r.execution).toEqual({ funding: -1.25, rejectedOrders: 7, liquidations: 0, openPositions: 1, pendingOrders: 2 });
    expect(r.streaks.maxLossStreak).toBe(1);
    expect(r.costs.applied).toEqual(["maker/taker fees", "funding"]);
    expect(r.costs.declared).toEqual(COSTS);
  });

  it("attaches the stress run when one was made", () => {
    const r = buildReport({
      ...base,
      spec: spec({ stressSlippage: 2 }),
      stress: { multiplier: 2, stats: statsWith({ profitFactor: 1.4, netProfit: 3, trades: 3 }) },
    });
    expect(r.stress).toEqual({ multiplier: 2, profitFactor: 1.4, netProfit: 3, trades: 3 });
    expect(r.criteria.checks.find((c) => c.key === "costStress")!.raw).toBe(1.4);
  });

  it("renders text that names the verdict, the streaks and the cost models", () => {
    const text = formatReportText(buildReport(base));
    expect(text).toContain("Backtest report — t");
    expect(text).toContain("linear:BTCUSDT:1m");
    expect(text).toContain("maker/taker fees");
    expect(text).toContain("Max losing run  1 trade(s)");
    expect(text).toContain("Rejected orders 7");
    expect(text).toContain("annualised");
    expect(text).toMatch(/Overall: NOT PASSED/);
  });
});

describe("formatSummaryTable", () => {
  function report(name: string, trades: number) {
    return buildReport({
      spec: spec({ name }),
      bars: 10,
      durationMs: 1,
      stats: statsWith({ trades, netProfit: 50, netProfitPct: 5, profitFactor: 1.5, maxDrawdownPct: 8, sharpeDaily: 0.1 }),
      equity: equity([1000, 1050]),
      trades: pnls(-1, 2),
      funding: 0,
      rejected: 0,
      openPositions: 0,
      pendingOrders: 0,
      costsApplied: [],
      costsDetail: [],
    });
  }

  it("puts one aligned row per run with its gate verdict", () => {
    const table = formatSummaryTable([report("grid-10", 120), report("grid-20", 12)]);
    const lines = table.split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatch(/^run\s+trades/);
    expect(lines[2]).toContain("grid-10");
    expect(lines[3]).toContain("grid-20");
    expect(lines[3]).toContain("FAIL");
    expect(new Set(lines.map((l) => l.length)).size).toBe(1);
  });
});
