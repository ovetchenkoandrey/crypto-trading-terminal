import { describe, it, expect } from "vitest";
import { parseOptimizePlan } from "./optimizeConfig.ts";
import { runOptimize } from "./optimizer.ts";
import { formatOptimizeReportText, buildOptimizeReport } from "./optimizeReport.ts";
import { mulberry32 } from "./multipleTesting.ts";
import type { SegmentExecutor } from "./segmentExecutor.ts";
import type { SegmentJob, SegmentOutcome } from "./segmentRun.ts";
import type { BacktestStats } from "../execution/backtest/stats";

const DAY = 86_400;

const base = {
  market: "linear",
  symbol: "BTCUSDT",
  interval: "1m",
  from: "2025-01",
  to: "2025-06",
  initialBalance: 1000,
  bot: { kind: "night-mr" },
  costs: { fees: false, slippage: false },
  window: { days: 30, stepDays: 7 },
};

function plan(over: Record<string, unknown> = {}) {
  return parseOptimizePlan({
    base,
    grid: { bbPeriod: [10, 20, 30], bbMult: [2, 2.5, 3] },
    walkForward: { trainDays: 45, testDays: 15 },
    bootstrapSamples: 200,
    minTrainTrades: 0,
    ...over,
  });
}

function stats(over: Partial<BacktestStats>): BacktestStats {
  return {
    netProfit: 0,
    netProfitPct: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    profitFactor: 1,
    maxDrawdown: 0,
    maxDrawdownPct: 1,
    avgTrade: 0,
    avgWin: 1,
    avgLoss: -1,
    avgHoldSec: 60,
    sharpeDaily: 0,
    ...over,
  };
}

/**
 * A synthetic engine. `edgeOf` decides how good a combination is, so a test can
 * hand the optimizer a surface with a known answer and check that it finds it —
 * without a dataset and without the real matching engine.
 */
function fakeExecutor(edgeOf: (job: SegmentJob) => number, opts: { noise?: number } = {}): SegmentExecutor {
  const rng = mulberry32(4);
  const calls: SegmentJob[] = [];
  const executor: SegmentExecutor & { calls: SegmentJob[] } = {
    workers: 1,
    dataset: { bars: 1000, fundingEvents: 0 },
    calls,
    async run(jobs) {
      const out: SegmentOutcome[] = [];
      for (const job of jobs) {
        calls.push(job);
        const days = Math.max(1, Math.round((job.toSec - job.fromSec) / DAY));
        const drift = edgeOf(job);
        const returns: number[] = [];
        for (let d = 0; d < days; d++) returns.push(drift + (rng() - 0.5) * (opts.noise ?? 0.002));
        const multiple = returns.reduce((acc, r) => acc * (1 + r), 1);
        const start = 1000;
        const end = start * multiple;
        const wins = Math.round(days * 0.6);
        out.push({
          id: job.id,
          comboIndex: job.comboIndex,
          foldIndex: job.foldIndex,
          phase: job.phase,
          stats: stats({
            netProfit: end - start,
            netProfitPct: (multiple - 1) * 100,
            trades: days * 2,
            wins,
            losses: days * 2 - wins,
            winRate: wins / (days * 2),
            profitFactor: drift > 0 ? 1.5 : 0.6,
            sharpeDaily: sharpe(returns),
            maxDrawdownPct: 5,
          }),
          startEquity: start,
          endEquity: end,
          funding: 0,
          rejected: 0,
          liquidations: 0,
          bars: days * 1440,
          days: job.want?.daily ? Array.from({ length: days }, (_, d) => Math.floor(job.fromSec / DAY) + d) : null,
          returns: job.want?.daily ? returns : null,
          equity: job.want?.equity
            ? returns.map((_, d) => ({ time: job.fromSec + d * DAY, equity: start * returns.slice(0, d + 1).reduce((a, r) => a * (1 + r), 1) }))
            : null,
          trades: job.want?.trades ? returns.map((r, d) => ({ pnl: r * start, ts: (job.fromSec + d * DAY) * 1000, entryTs: (job.fromSec + d * DAY - 60) * 1000 })) : null,
        });
      }
      return out;
    },
    async close() {
      /* nothing */
    },
  };
  return executor;
}

function sharpe(values: number[]): number {
  if (values.length < 2) return 0;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const varr = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
  return varr > 0 ? mean / Math.sqrt(varr) : 0;
}

describe("runOptimize", () => {
  it("selects per fold and judges on windows the selection never saw", async () => {
    const p = plan();
    const executor = fakeExecutor((job) => (job.params.bbPeriod === 20 ? 0.004 : 0.0005));
    const result = await runOptimize(p, { executor });

    expect(result.folds.length).toBe(p.walkForward.folds.length);
    for (const fold of result.folds) expect(fold.selected?.params.bbPeriod).toBe(20);

    const trainJobs = (executor as unknown as { calls: SegmentJob[] }).calls.filter((j) => j.phase === "train");
    const testJobs = (executor as unknown as { calls: SegmentJob[] }).calls.filter((j) => j.phase === "test");
    for (const train of trainJobs) {
      for (const test of testJobs) {
        if (train.foldIndex !== test.foldIndex) continue;
        expect(test.fromSec).toBeGreaterThan(train.toSec);
      }
    }
  });

  it("counts every combination as a trial and reports the correction", async () => {
    const result = await runOptimize(plan(), { executor: fakeExecutor(() => 0.0005, { noise: 0.02 }) });
    expect(result.multipleTesting.combos).toBe(9);
    expect(result.multipleTesting.selectionTrials).toBe(9 * result.folds.length);
    expect(result.multipleTesting.runs).toBe(result.runs);
    expect(result.multipleTesting.deflatedWalkForward).not.toBeNull();
    expect(result.multipleTesting.reality).not.toBeNull();
  });

  it("does not certify a grid that is pure noise", async () => {
    const result = await runOptimize(plan(), { executor: fakeExecutor(() => 0, { noise: 0.05 }) });
    expect(result.multipleTesting.verdict).toBe("fails");
    expect(result.stitched.criteria?.passed).toBe(false);
  });

  it("separates the naive in-sample claim from what the same parameters did out of sample", async () => {
    const result = await runOptimize(plan(), { executor: fakeExecutor((job) => (job.params.bbMult === 3 ? 0.003 : 0.0005)) });
    expect(result.baselines.naive).not.toBeNull();
    expect(result.baselines.naive!.inSampleScore).not.toBeNull();
    expect(result.baselines.naive!.walkForwardScore).not.toBeNull();
    expect(result.baselines.oracle).not.toBeNull();
    expect(result.baselines.medianCombo.score).not.toBeNull();
  });

  it("maps the neighbourhood of the winner, not only the winner", async () => {
    const result = await runOptimize(plan(), { executor: fakeExecutor((job) => (job.params.bbPeriod === 20 ? 0.004 : 0.0035)) });
    expect(result.plateau).not.toBeNull();
    expect(result.plateau!.train.verdict).toBe("plateau");
    expect(result.plateau!.trainMap).toContain("bbPeriod");
  });

  it("calls a lone spike an isolated peak and says so in the warnings", async () => {
    const result = await runOptimize(plan(), {
      executor: fakeExecutor((job) => (job.params.bbPeriod === 20 && job.params.bbMult === 2.5 ? 0.02 : 0.0002)),
    });
    expect(result.plateau!.train.verdict).toBe("isolated-peak");
    expect(result.warnings.join(" ")).toMatch(/isolated peak/);
  });

  it("skips a fold where nothing reaches the minimum trade count, and says why", async () => {
    const p = plan({ minTrainTrades: 1_000_000 });
    const result = await runOptimize(p, { executor: fakeExecutor(() => 0.001) });
    expect(result.folds.every((f) => f.selected === null)).toBe(true);
    expect(result.stitched.stats).toBeNull();
    expect(result.warnings.join(" ")).toMatch(/minTrainTrades/);
  });

  it("renders a report that names the search size, the split and the verdict", async () => {
    const result = await runOptimize(plan(), { executor: fakeExecutor((job) => (job.params.bbPeriod === 20 ? 0.004 : 0.0005)) });
    const text = formatOptimizeReportText(result);
    expect(text).toContain("total combinations   9");
    expect(text).toContain("Walk-forward split");
    expect(text).toContain("Multiple testing");
    expect(text).toContain("Plateau or peak");
    expect(text).toContain("Acceptance criteria");

    const json = buildOptimizeReport(result);
    expect(json.kind).toBe("walk-forward-optimization");
    expect(json.grid.size).toBe(9);
    expect(json.walkForward.folds).toBe(result.folds.length);
    expect(JSON.parse(JSON.stringify(json)).multipleTesting.combos).toBe(9);
  });

  it("runs no out-of-sample sweep when the diagnostics are switched off", async () => {
    const executor = fakeExecutor(() => 0.001);
    const result = await runOptimize(plan({ evaluateAllOnTest: false, compareNaive: false }), { executor });
    const calls = (executor as unknown as { calls: SegmentJob[] }).calls;
    expect(calls.filter((j) => j.phase === "full")).toHaveLength(0);
    expect(result.multipleTesting.verdict).toBe("not-evaluated");
    expect(result.multipleTesting.notes.join(" ")).toMatch(/evaluateAllOnTest/);
  });
});
