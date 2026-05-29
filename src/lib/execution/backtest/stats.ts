// Pure stats calculator for completed backtests. Operates on the trade history
// (closed positions) and an optional equity series sampled per bar.

import type { PaperTrade } from "../../store";

export interface BacktestStats {
  netProfit:      number;       // USDT
  netProfitPct:   number;       // percent of initial balance
  trades:         number;
  wins:           number;
  losses:         number;
  winRate:        number;       // 0..1
  profitFactor:   number;       // sum of wins / abs(sum of losses), Infinity if no losses
  maxDrawdown:    number;       // USDT (positive number)
  maxDrawdownPct: number;       // percent of peak equity
  avgTrade:       number;       // USDT
  avgWin:         number;
  avgLoss:        number;
  avgHoldSec:     number;       // average position duration in seconds
  sharpeDaily:    number;       // crude daily-bucket sharpe; 0 if insufficient data
}

/** Equity sample at the end of a bar — fed by runner during the loop. */
export interface EquitySample {
  time: number;       // UTC seconds
  equity: number;
}

export function computeStats(
  initialBalance: number,
  trades: PaperTrade[],
  equity: EquitySample[],
): BacktestStats {
  const wins   = trades.filter((t) => t.pnl > 0);
  const losses = trades.filter((t) => t.pnl < 0);
  const sumW = wins.reduce((s, t) => s + t.pnl, 0);
  const sumL = losses.reduce((s, t) => s + t.pnl, 0);

  const finalEquity = equity.length ? equity[equity.length - 1].equity : initialBalance;
  const netProfit   = finalEquity - initialBalance;

  // Max drawdown across equity curve.
  let peak = initialBalance;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const e of equity) {
    if (e.equity > peak) peak = e.equity;
    const dd = peak - e.equity;
    if (dd > maxDd) {
      maxDd = dd;
      maxDdPct = peak > 0 ? (dd / peak) * 100 : 0;
    }
  }

  // Average hold time. We have no separate openedTs in PaperTrade, so the
  // runner must store something — approximate by trade.ts spacing if needed.
  // For now treat as 0 unless callers supply augmented trades.
  const avgHoldSec = 0;

  // Daily Sharpe (crude): bucket equity by day, take pct returns, mean/std.
  const daily = bucketByDay(equity);
  const dailyReturns: number[] = [];
  for (let i = 1; i < daily.length; i++) {
    if (daily[i - 1] === 0) continue;
    dailyReturns.push((daily[i] - daily[i - 1]) / daily[i - 1]);
  }
  const sharpeDaily = sharpe(dailyReturns);

  return {
    netProfit,
    netProfitPct:   initialBalance > 0 ? (netProfit / initialBalance) * 100 : 0,
    trades:         trades.length,
    wins:           wins.length,
    losses:         losses.length,
    winRate:        trades.length ? wins.length / trades.length : 0,
    profitFactor:   sumL === 0 ? (sumW > 0 ? Infinity : 0) : sumW / Math.abs(sumL),
    maxDrawdown:    maxDd,
    maxDrawdownPct: maxDdPct,
    avgTrade:       trades.length ? (sumW + sumL) / trades.length : 0,
    avgWin:         wins.length   ? sumW / wins.length   : 0,
    avgLoss:        losses.length ? sumL / losses.length : 0,
    avgHoldSec,
    sharpeDaily,
  };
}

function bucketByDay(equity: EquitySample[]): number[] {
  if (equity.length === 0) return [];
  const out: number[] = [];
  let currentDay = -1;
  let lastValue = equity[0].equity;
  for (const e of equity) {
    const day = Math.floor(e.time / 86400);
    if (day !== currentDay) {
      if (currentDay >= 0) out.push(lastValue);
      currentDay = day;
    }
    lastValue = e.equity;
  }
  out.push(lastValue);
  return out;
}

function sharpe(returns: number[]): number {
  if (returns.length < 2) return 0;
  const mean = returns.reduce((s, x) => s + x, 0) / returns.length;
  const variance = returns.reduce((s, x) => s + (x - mean) * (x - mean), 0) / (returns.length - 1);
  const std = Math.sqrt(variance);
  return std > 0 ? mean / std : 0;
}
