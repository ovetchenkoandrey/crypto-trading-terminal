// Glue the out-of-sample segments into one series.
//
// Each fold's test window is run on a fresh account, because that is what makes
// the folds independent. Reading them as one track therefore has to compound
// them: segment i+1 starts on whatever segment i left. Trade P&L is scaled by
// the same factor, otherwise a 10 USDT win early and a 10 USDT win after the
// account doubled would count as equal contributions and the profit factor of
// the stitched series would not match its equity curve.
//
// The alternative — averaging fold returns — hides the ordering, and ordering is
// the whole question: a strategy that makes 30% then loses 25% is not the same
// asset as one that does it the other way round.

import type { BacktestStats, EquitySample } from "../execution/backtest/stats";
import type { SegmentOutcome, TradeRecord } from "./segmentRun.ts";

export interface StitchSegment {
  fromSec: number;
  startEquity: number;
  endEquity: number;
  equity: readonly EquitySample[];
  trades: readonly TradeRecord[];
  /** Daily returns of this segment, already scale-free. */
  days?: readonly number[] | null;
  returns?: readonly number[] | null;
}

export interface StitchedSeries {
  equity: EquitySample[];
  trades: TradeRecord[];
  days: number[];
  returns: number[];
  finalEquity: number;
  /** endEquity / startEquity of each segment, in time order. */
  multiples: number[];
  /** Compound growth of the whole stitched track. */
  totalMultiple: number;
}

export function stitchSegments(segments: readonly StitchSegment[], initialBalance: number): StitchedSeries {
  const ordered = [...segments].sort((a, b) => a.fromSec - b.fromSec);
  const equity: EquitySample[] = [];
  const trades: TradeRecord[] = [];
  const days: number[] = [];
  const returns: number[] = [];
  const multiples: number[] = [];

  let factor = 1;
  for (const segment of ordered) {
    const start = segment.startEquity > 0 ? segment.startEquity : initialBalance;
    const scale = (initialBalance * factor) / start;
    for (const sample of segment.equity) equity.push({ time: sample.time, equity: sample.equity * scale });
    for (const trade of segment.trades) trades.push({ pnl: trade.pnl * scale, ts: trade.ts, entryTs: trade.entryTs });
    if (segment.days && segment.returns) {
      for (let i = 0; i < segment.days.length; i++) {
        days.push(segment.days[i]);
        returns.push(segment.returns[i]);
      }
    }
    const multiple = start > 0 ? Math.max(0, segment.endEquity / start) : 0;
    multiples.push(multiple);
    factor *= multiple;
  }

  trades.sort((a, b) => a.ts - b.ts);
  return {
    equity,
    trades,
    days,
    returns,
    finalEquity: initialBalance * factor,
    multiples,
    totalMultiple: factor,
  };
}

/**
 * Compounded statistics for a combination across its test segments, built from
 * the per-segment summaries alone.
 *
 * The sweep does not keep equity curves for every combination — thousands of
 * them would cost gigabytes — so drawdown here is measured on the daily curve
 * rebuilt from daily returns and is therefore a lower bound: an intraday dip
 * that recovered by the close is invisible. Good enough for ranking baselines,
 * not good enough for the acceptance gate, which uses the per-bar curve of the
 * selected strategy instead.
 */
export function aggregateSegments(outcomes: readonly SegmentOutcome[], initialBalance: number): BacktestStats & { multiple: number } {
  const ordered = [...outcomes].sort((a, b) => a.foldIndex - b.foldIndex || a.id - b.id);
  let factor = 1;
  let trades = 0;
  let wins = 0;
  let losses = 0;
  let grossWin = 0;
  let grossLoss = 0;
  let holdWeight = 0;
  let holdSum = 0;
  const returns: number[] = [];

  for (const o of ordered) {
    const start = o.startEquity > 0 ? o.startEquity : initialBalance;
    const scale = (initialBalance * factor) / start;
    trades += o.stats.trades;
    wins += o.stats.wins;
    losses += o.stats.losses;
    grossWin += o.stats.avgWin * o.stats.wins * scale;
    grossLoss += Math.abs(o.stats.avgLoss) * o.stats.losses * scale;
    holdSum += o.stats.avgHoldSec * o.stats.trades;
    holdWeight += o.stats.trades;
    if (o.returns) for (const r of o.returns) returns.push(r);
    factor *= start > 0 ? Math.max(0, o.endEquity / start) : 0;
  }

  const netProfit = initialBalance * (factor - 1);
  let equity = 1;
  let peak = 1;
  let maxDdPct = 0;
  let maxDd = 0;
  for (const r of returns) {
    equity *= 1 + r;
    if (equity > peak) peak = equity;
    const dd = peak - equity;
    if (peak > 0 && (dd / peak) * 100 > maxDdPct) maxDdPct = (dd / peak) * 100;
    if (dd * initialBalance > maxDd) maxDd = dd * initialBalance;
  }

  const mean = returns.length ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
  const variance = returns.length > 1 ? returns.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (returns.length - 1) : 0;
  const sd = Math.sqrt(variance);

  return {
    netProfit,
    netProfitPct: (factor - 1) * 100,
    trades,
    wins,
    losses,
    winRate: trades ? wins / trades : 0,
    profitFactor: grossLoss === 0 ? (grossWin > 0 ? Infinity : 0) : grossWin / grossLoss,
    maxDrawdown: maxDd,
    maxDrawdownPct: maxDdPct,
    avgTrade: trades ? netProfit / trades : 0,
    avgWin: wins ? grossWin / wins : 0,
    avgLoss: losses ? -grossLoss / losses : 0,
    avgHoldSec: holdWeight ? holdSum / holdWeight : 0,
    sharpeDaily: sd > 0 ? mean / sd : 0,
    multiple: factor,
  };
}

/** Daily returns of a combination's segments, concatenated in fold order. */
export function concatDaily(outcomes: readonly SegmentOutcome[]): { days: number[]; returns: number[] } {
  const ordered = [...outcomes].sort((a, b) => a.foldIndex - b.foldIndex || a.id - b.id);
  const days: number[] = [];
  const returns: number[] = [];
  for (const o of ordered) {
    if (!o.days || !o.returns) continue;
    for (let i = 0; i < o.days.length; i++) {
      days.push(o.days[i]);
      returns.push(o.returns[i]);
    }
  }
  return { days, returns };
}

/**
 * Daily returns of every combination laid out on one day grid, for the reality
 * check. Rows are combinations, columns are days; a day a combination has no
 * observation for contributes zero, which is the honest reading — the strategy
 * was flat that day, not absent.
 */
export function alignReturnMatrix(
  perCombo: readonly { days: readonly number[]; returns: readonly number[] }[],
): { days: number[]; matrix: number[][] } {
  const dayset = new Set<number>();
  for (const row of perCombo) for (const d of row.days) dayset.add(d);
  const days = Array.from(dayset).sort((a, b) => a - b);
  const column = new Map<number, number>();
  days.forEach((d, i) => column.set(d, i));

  const matrix = perCombo.map((row) => {
    const out = new Array<number>(days.length).fill(0);
    for (let i = 0; i < row.days.length; i++) {
      const at = column.get(row.days[i]);
      if (at !== undefined) out[at] += row.returns[i];
    }
    return out;
  });
  return { days, matrix };
}
