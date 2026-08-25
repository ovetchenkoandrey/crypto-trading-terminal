// What "better" means when the optimizer ranks combinations.
//
// Every objective is a single number, higher is better, and a combination that
// did not trade enough to be judged gets `null` rather than a flattering zero.
// Profit factor and Calmar are capped: an unbounded ratio from three lucky
// trades would otherwise beat a real edge with a thousand.

import { annualizeSharpe } from "./report.ts";
import type { BacktestStats } from "../execution/backtest/stats";

export type ObjectiveKey = "sharpe" | "profitFactor" | "netProfit" | "netProfitPct" | "calmar" | "expectancy";

export const OBJECTIVES: ObjectiveKey[] = ["sharpe", "profitFactor", "netProfit", "netProfitPct", "calmar", "expectancy"];

export const RATIO_CAP = 10;

export function isObjective(value: string): value is ObjectiveKey {
  return (OBJECTIVES as string[]).includes(value);
}

export function objectiveLabel(key: ObjectiveKey): string {
  switch (key) {
    case "sharpe": return "Sharpe (annualised)";
    case "profitFactor": return "profit factor";
    case "netProfit": return "net profit, USDT";
    case "netProfitPct": return "net profit, %";
    case "calmar": return "net % / max drawdown %";
    case "expectancy": return "average trade, USDT";
  }
}

export function scoreStats(stats: BacktestStats, objective: ObjectiveKey): number {
  switch (objective) {
    case "sharpe":
      return annualizeSharpe(stats.sharpeDaily);
    case "profitFactor":
      return Number.isFinite(stats.profitFactor) ? Math.min(stats.profitFactor, RATIO_CAP) : stats.profitFactor > 0 ? RATIO_CAP : 0;
    case "netProfit":
      return stats.netProfit;
    case "netProfitPct":
      return stats.netProfitPct;
    case "calmar":
      return stats.maxDrawdownPct > 0
        ? Math.max(-RATIO_CAP, Math.min(RATIO_CAP, stats.netProfitPct / stats.maxDrawdownPct))
        : stats.netProfitPct > 0
          ? RATIO_CAP
          : 0;
    case "expectancy":
      return stats.avgTrade;
  }
}

/**
 * The score used for ranking, or null when the sample is too thin to rank on.
 * A combination with four trades can post any statistic at all; excluding it is
 * cheaper than explaining it later.
 */
export function rankScore(stats: BacktestStats, objective: ObjectiveKey, minTrades: number): number | null {
  if (stats.trades < minTrades) return null;
  const value = scoreStats(stats, objective);
  return Number.isFinite(value) ? value : null;
}
