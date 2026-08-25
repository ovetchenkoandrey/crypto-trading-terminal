import { describe, it, expect } from "vitest";
import { MAX_AUTO_WORKERS, parseOptimizePlan, resolveWorkerCount } from "./optimizeConfig.ts";

const base = {
  market: "linear",
  symbol: "BTCUSDT",
  interval: "1m",
  signalInterval: "15m",
  from: "2025-01",
  to: "2025-06",
  bot: { kind: "night-mr", params: { riskPct: 0.5 } },
  costs: { fees: "bybit-linear", slippage: { kind: "fixed_bps", bps: 5 } },
};

const walkForward = { trainDays: 45, testDays: 15 };

describe("parseOptimizePlan", () => {
  it("expands the grid and plans the folds", () => {
    const plan = parseOptimizePlan({ base, grid: { bbPeriod: [15, 20], bbMult: [2, 2.5, 3] }, walkForward });
    expect(plan.grid.size).toBe(6);
    expect(plan.walkForward.folds.length).toBeGreaterThanOrEqual(2);
    expect(plan.spec.symbol).toBe("BTCUSDT");
    expect(plan.spec.signalIntervalSec).toBe(900);
    expect(plan.objective).toBe("sharpe");
  });

  it("keeps the fixed parameters from base and lets the grid override them per combination", () => {
    const plan = parseOptimizePlan({ base, grid: { bbMult: [2, 3] }, walkForward });
    expect(plan.spec.bot.params.riskPct).toBe(0.5);
    expect(plan.grid.combos.map((c) => c.params.bbMult)).toEqual([2, 3]);
  });

  it("refuses a grid over a parameter the bot does not have", () => {
    expect(() => parseOptimizePlan({ base, grid: { bbPeroid: [15, 20] }, walkForward })).toThrow(
      /does not have: bbPeroid/,
    );
  });

  it("demands base, grid and walkForward explicitly", () => {
    expect(() => parseOptimizePlan({ grid: { bbMult: [2] }, walkForward })).toThrow(/"base" is required/);
    expect(() => parseOptimizePlan({ base, walkForward })).toThrow(/"grid" is required/);
    expect(() => parseOptimizePlan({ base, grid: { bbMult: [2] } })).toThrow(/"walkForward" is required/);
  });

  it("inherits the cost contract of a plain run: costs must be spelled out", () => {
    const { costs, ...noCosts } = base;
    expect(() => parseOptimizePlan({ base: noCosts, grid: { bbMult: [2] }, walkForward })).toThrow(/costs must be declared/);
  });

  it("rejects an unknown objective and a plateau axis outside the grid", () => {
    expect(() => parseOptimizePlan({ base, grid: { bbMult: [2] }, walkForward, objective: "profit" })).toThrow(/objective/);
    expect(() => parseOptimizePlan({ base, grid: { bbMult: [2] }, walkForward, plateauAxes: ["bbMult", "nope"] })).toThrow(
      /not in the grid/,
    );
  });

  it("defaults the expensive diagnostics on and lets them be turned off", () => {
    const on = parseOptimizePlan({ base, grid: { bbMult: [2] }, walkForward });
    expect(on.evaluateAllOnTest).toBe(true);
    expect(on.compareNaive).toBe(true);
    const off = parseOptimizePlan({ base, grid: { bbMult: [2] }, walkForward, evaluateAllOnTest: false, compareNaive: false });
    expect(off.evaluateAllOnTest).toBe(false);
    expect(off.compareNaive).toBe(false);
  });

  it("propagates the walk-forward failure message when the range is too short", () => {
    expect(() =>
      parseOptimizePlan({ base: { ...base, to: "2025-02" }, grid: { bbMult: [2] }, walkForward: { trainDays: 45, testDays: 30 } }),
    ).toThrow(/fold\(s\) fit in/);
  });
});

describe("resolveWorkerCount", () => {
  it("never spawns more workers than there are jobs", () => {
    expect(resolveWorkerCount("auto", 3)).toBeLessThanOrEqual(3);
    expect(resolveWorkerCount(64, 2)).toBe(2);
  });

  it("honours an explicit single worker", () => {
    expect(resolveWorkerCount(1, 1000)).toBe(1);
  });

  it("caps the automatic count so the box stays usable", () => {
    expect(resolveWorkerCount("auto", 10_000)).toBeLessThanOrEqual(MAX_AUTO_WORKERS);
  });

  it("cuts the pool down when every worker would need its own copy of a huge series", () => {
    const huge = 200_000_000;
    expect(resolveWorkerCount("auto", 10_000, { barsPerWorker: huge })).toBe(1);
    expect(resolveWorkerCount(8, 10_000, { barsPerWorker: huge })).toBe(1);
  });

  it("leaves a normal dataset alone", () => {
    expect(resolveWorkerCount(4, 10_000, { barsPerWorker: 100_000 })).toBe(4);
  });
});
