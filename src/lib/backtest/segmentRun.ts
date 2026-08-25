// One (parameter combination, time slice) evaluation.
//
// This is the unit of work the optimizer schedules, in-process or on a worker.
// It never touches the disk: the candles and funding events are loaded once by
// the caller and sliced here, which is the whole reason a few thousand runs are
// affordable.
//
// What comes back is deliberately small. Equity curves and trade lists are only
// returned when asked for, because a grid sweep produces thousands of segments
// and only a handful of them ever need more than their summary statistics.

import type { Candle } from "../types";
import type { BotConfig } from "../store";
import type { FundingRateEvent } from "../execution/funding";
import { runBacktest, type BacktestResult } from "../execution/backtest/runner";
import { computeStats, type BacktestStats, type EquitySample } from "../execution/backtest/stats";
import { resolveCosts, type RunSpec } from "./runConfig.ts";
import type { GridValue } from "./paramGrid.ts";

export type SegmentPhase = "train" | "test" | "full" | "stress";

export interface SegmentWants {
  equity?: boolean;
  trades?: boolean;
  daily?: boolean;
}

export interface SegmentJob {
  id: number;
  comboIndex: number;
  /** -1 for a job that spans the whole range instead of one fold. */
  foldIndex: number;
  phase: SegmentPhase;
  params: Record<string, GridValue>;
  fromSec: number;
  toSec: number;
  /** Slippage multiplier; absent or 1 means the declared cost model as-is. */
  stressSlippage?: number;
  want?: SegmentWants;
}

export interface TradeRecord {
  pnl: number;
  /** Close time, epoch ms. */
  ts: number;
  entryTs: number;
}

export interface SegmentOutcome {
  id: number;
  comboIndex: number;
  foldIndex: number;
  phase: SegmentPhase;
  stats: BacktestStats;
  startEquity: number;
  endEquity: number;
  funding: number;
  rejected: number;
  liquidations: number;
  bars: number;
  /** Day index (floor(sec / 86400)) of each daily return, when asked for. */
  days: number[] | null;
  returns: number[] | null;
  equity: EquitySample[] | null;
  trades: TradeRecord[] | null;
  error?: string;
}

export interface SegmentContext {
  spec: RunSpec;
  candles: Candle[];
  fundingEvents: FundingRateEvent[];
  /** Execution bars of history fed before the segment so indicators are warm. */
  warmupBars: number;
}

/** First index whose bar time is >= t. */
function lowerBound(candles: readonly Candle[], t: number): number {
  let lo = 0;
  let hi = candles.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export function sliceIndices(candles: readonly Candle[], fromSec: number, toSec: number, warmupBars: number): { start: number; end: number; runStart: number } {
  const start = lowerBound(candles, fromSec);
  const end = lowerBound(candles, toSec + 1);
  return { start, end, runStart: Math.max(0, start - Math.max(0, warmupBars)) };
}

/**
 * Daily returns of an equity curve, anchored on the equity the segment opened
 * with. Days come back as absolute day indices so that curves from different
 * combinations can be lined up column by column without re-deriving dates.
 */
export function dailyReturns(equity: readonly EquitySample[], startEquity: number): { days: number[]; returns: number[] } {
  const days: number[] = [];
  const returns: number[] = [];
  if (equity.length === 0) return { days, returns };

  let prev = startEquity;
  let currentDay = Math.floor(equity[0].time / 86_400);
  let last = equity[0].equity;
  for (const sample of equity) {
    const day = Math.floor(sample.time / 86_400);
    if (day !== currentDay) {
      days.push(currentDay);
      returns.push(prev > 0 ? (last - prev) / prev : 0);
      prev = last;
      currentDay = day;
    }
    last = sample.equity;
  }
  days.push(currentDay);
  returns.push(prev > 0 ? (last - prev) / prev : 0);
  return { days, returns };
}

function botFor(spec: RunSpec, params: Record<string, GridValue>): BotConfig {
  return { ...spec.bot, params: { ...spec.bot.params, ...params } };
}

/** A segment that could not run, shaped like one that did so callers need no special case. */
export function failedOutcome(job: SegmentJob, initialBalance: number, error: string): SegmentOutcome {
  return {
    id: job.id,
    comboIndex: job.comboIndex,
    foldIndex: job.foldIndex,
    phase: job.phase,
    stats: computeStats(initialBalance, [], []),
    startEquity: initialBalance,
    endEquity: initialBalance,
    funding: 0,
    rejected: 0,
    liquidations: 0,
    bars: 0,
    days: null,
    returns: null,
    equity: null,
    trades: null,
    error,
  };
}

/**
 * Runs the slice and trims the warm-up prefix out of the numbers.
 *
 * Trimming matters: without it the first fold would be judged partly on bars
 * that also fed the previous fold's training. The prefix is still traded — a
 * strategy that opens a position during warm-up carries it into the segment,
 * exactly as a live bot restarted mid-week would.
 */
export async function runSegment(ctx: SegmentContext, job: SegmentJob): Promise<SegmentOutcome> {
  const { start, end, runStart } = sliceIndices(ctx.candles, job.fromSec, job.toSec, ctx.warmupBars);
  const base = {
    id: job.id,
    comboIndex: job.comboIndex,
    foldIndex: job.foldIndex,
    phase: job.phase,
    funding: 0,
    rejected: 0,
    liquidations: 0,
    bars: 0,
    days: null,
    returns: null,
    equity: null,
    trades: null,
  };

  if (end <= start) return failedOutcome(job, ctx.spec.initialBalance, "no bars in slice");

  const candles = ctx.candles.slice(runStart, end);
  const funding = ctx.fundingEvents.filter((e) => e.timestamp >= candles[0].time && e.timestamp <= job.toSec);
  const stress = job.stressSlippage && job.stressSlippage > 0 ? job.stressSlippage : 1;
  const resolved = resolveCosts(ctx.spec, funding, { stressSlippage: stress });

  const result: BacktestResult = await runBacktest({
    symbol: ctx.spec.symbol,
    candles,
    bot: botFor(ctx.spec, job.params),
    initialBalance: ctx.spec.initialBalance,
    feeRate: resolved.feeRate,
    slippageCfg: resolved.slippage,
    costs: resolved.costs,
    signalIntervalSec: ctx.spec.signalIntervalSec,
  });

  const cutSec = job.fromSec;
  const cutMs = cutSec * 1000;
  const equity = ctx.warmupBars > 0 ? result.equity.filter((e) => e.time >= cutSec) : result.equity;
  const trades = ctx.warmupBars > 0 ? result.trades.filter((t) => t.ts >= cutMs) : result.trades;

  // Everything the segment is judged on is measured from the equity it had at
  // the first bar inside the segment, not from the nominal initial balance.
  let startEquity = ctx.spec.initialBalance;
  if (ctx.warmupBars > 0) {
    const before = result.equity.filter((e) => e.time < cutSec);
    if (before.length > 0) startEquity = before[before.length - 1].equity;
  }

  const stats = computeStats(startEquity, trades, equity);
  const endEquity = equity.length ? equity[equity.length - 1].equity : startEquity;
  const want = job.want ?? {};
  const daily = want.daily ? dailyReturns(equity, startEquity) : null;

  return {
    ...base,
    stats,
    startEquity,
    endEquity,
    funding: result.funding,
    rejected: result.rejected,
    liquidations: result.liquidations,
    bars: end - start,
    days: daily ? daily.days : null,
    returns: daily ? daily.returns : null,
    equity: want.equity ? equity.map((e) => ({ time: e.time, equity: e.equity })) : null,
    trades: want.trades ? trades.map((t) => ({ pnl: t.pnl, ts: t.ts, entryTs: t.entryTs })) : null,
  };
}
