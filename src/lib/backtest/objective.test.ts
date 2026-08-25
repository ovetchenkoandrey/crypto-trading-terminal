import { describe, it, expect } from "vitest";
import { isObjective, objectiveLabel, rankScore, RATIO_CAP, scoreStats } from "./objective.ts";
import type { BacktestStats } from "../execution/backtest/stats";

function stats(over: Partial<BacktestStats>): BacktestStats {
  return {
    netProfit: 0,
    netProfitPct: 0,
    trades: 50,
    wins: 25,
    losses: 25,
    winRate: 0.5,
    profitFactor: 1,
    maxDrawdown: 0,
    maxDrawdownPct: 10,
    avgTrade: 0,
    avgWin: 1,
    avgLoss: -1,
    avgHoldSec: 60,
    sharpeDaily: 0,
    ...over,
  };
}

describe("scoreStats", () => {
  it("annualises the daily Sharpe", () => {
    expect(scoreStats(stats({ sharpeDaily: 0.1 }), "sharpe")).toBeCloseTo(0.1 * Math.sqrt(365), 10);
  });

  it("caps an unbounded profit factor so three lucky trades cannot win the sweep", () => {
    expect(scoreStats(stats({ profitFactor: Infinity }), "profitFactor")).toBe(RATIO_CAP);
    expect(scoreStats(stats({ profitFactor: 400 }), "profitFactor")).toBe(RATIO_CAP);
  });

  it("caps Calmar in both directions and handles a drawdown-free run", () => {
    expect(scoreStats(stats({ netProfitPct: 30, maxDrawdownPct: 10 }), "calmar")).toBeCloseTo(3, 10);
    expect(scoreStats(stats({ netProfitPct: 500, maxDrawdownPct: 1 }), "calmar")).toBe(RATIO_CAP);
    expect(scoreStats(stats({ netProfitPct: 5, maxDrawdownPct: 0 }), "calmar")).toBe(RATIO_CAP);
    expect(scoreStats(stats({ netProfitPct: -5, maxDrawdownPct: 0 }), "calmar")).toBe(0);
  });
});

describe("rankScore", () => {
  it("refuses to rank a sample too thin to mean anything", () => {
    expect(rankScore(stats({ trades: 4, sharpeDaily: 5 }), "sharpe", 20)).toBeNull();
    expect(rankScore(stats({ trades: 40, sharpeDaily: 0.05 }), "sharpe", 20)).not.toBeNull();
  });

  it("refuses a non-finite score rather than passing NaN up the chain", () => {
    expect(rankScore(stats({ netProfit: Number.NaN }), "netProfit", 0)).toBeNull();
    // annualizeSharpe already folds a non-finite daily Sharpe to zero, so the
    // sharpe objective never reaches rankScore with NaN in the first place.
    expect(rankScore(stats({ sharpeDaily: Number.NaN }), "sharpe", 0)).toBe(0);
  });
});

describe("isObjective", () => {
  it("accepts the known keys and rejects anything else", () => {
    expect(isObjective("calmar")).toBe(true);
    expect(isObjective("profit")).toBe(false);
    expect(objectiveLabel("calmar")).toContain("drawdown");
  });
});
