// Derivations shared by every piece of the visual tester.
//
// Two rules live here and nowhere else:
//   1. Numbers come from `lib/backtest/report.ts`. The UI never recomputes a
//      streak, a rolling window or an acceptance check — if it did, the panel
//      and the CLI report would drift apart and nobody would know which lied.
//   2. Trade times are snapped to the *display* series before they reach the
//      chart. lightweight-charts can only place a point on a bar it holds, and
//      a run on minutes drawn on hours has no bar at 14:37.

import type { Candle } from "../../lib/types";
import type { PaperTrade, PaperOrder } from "../../lib/store";
import type { BacktestResult } from "../../lib/execution/backtest/runner";
import type { RunSpec } from "../../lib/backtest/runConfig";
import { buildReport, type BacktestReport } from "../../lib/backtest/report";
import { aggregateBars } from "../../lib/execution/backtest/aggregate";

/* ── timeframe helpers ────────────────────────────────────────────────────── */

export const TF_STEPS: { sec: number; label: string }[] = [
  { sec: 60,     label: "M1"  },
  { sec: 300,    label: "M5"  },
  { sec: 900,    label: "M15" },
  { sec: 1800,   label: "M30" },
  { sec: 3600,   label: "H1"  },
  { sec: 14400,  label: "H4"  },
  { sec: 86400,  label: "D1"  },
];

export function tfLabelSec(sec: number): string {
  const hit = TF_STEPS.find((t) => t.sec === sec);
  if (hit) return hit.label;
  if (sec % 86400 === 0) return `D${sec / 86400}`;
  if (sec % 3600 === 0)  return `H${sec / 3600}`;
  return `M${Math.round(sec / 60)}`;
}

/**
 * Bar length of a series, taken as the smallest positive gap in the first
 * hundred bars. The mean would be skewed by every hole in the history.
 */
export function barSecOf(candles: readonly Candle[]): number {
  let best = 0;
  const upTo = Math.min(candles.length - 1, 100);
  for (let i = 0; i < upTo; i++) {
    const d = candles[i + 1].time - candles[i].time;
    if (d > 0 && (best === 0 || d < best)) best = d;
  }
  return best || 60;
}

/**
 * A year of minutes is ~525k bars; lightweight-charts chokes long before that.
 * Auto mode walks up the timeframe ladder until the series fits the budget.
 */
export const DISPLAY_BAR_BUDGET = 20_000;

export function autoDisplayTf(nativeSec: number, bars: number): number {
  if (bars <= DISPLAY_BAR_BUDGET) return nativeSec;
  for (const step of TF_STEPS) {
    if (step.sec <= nativeSec) continue;
    if (bars * (nativeSec / step.sec) <= DISPLAY_BAR_BUDGET) return step.sec;
  }
  return TF_STEPS[TF_STEPS.length - 1].sec;
}

/** Timeframes offered in the chart header: native and everything coarser. */
export function displayTfOptions(nativeSec: number): { sec: number; label: string }[] {
  const out = TF_STEPS.filter((t) => t.sec > nativeSec).map((t) => ({ sec: t.sec, label: t.label }));
  return [{ sec: nativeSec, label: tfLabelSec(nativeSec) }, ...out];
}

export function buildDisplayCandles(source: readonly Candle[], tfSec: number, nativeSec: number): Candle[] {
  if (tfSec <= nativeSec) return source as Candle[];
  return aggregateBars(source, tfSec);
}

/* ── trades ───────────────────────────────────────────────────────────────── */

export interface TradeView {
  id: string;
  /** 1-based position in close order — matches what the engine emitted. */
  index: number;
  side: "buy" | "sell";
  qty: number;
  pnl: number;
  entryTs: number;      // epoch ms
  exitTs: number;       // epoch ms
  entryPrice: number;
  exitPrice: number;
  holdSec: number;
  /** Snapped to the display series — what the chart can actually place. */
  entryBarTime: number; // UTC seconds
  exitBarTime: number;  // UTC seconds
}

/** Index of the last bar at or before `timeSec`; -1 when the series starts later. */
export function barIndexAt(bars: readonly Candle[], timeSec: number): number {
  if (bars.length === 0) return -1;
  if (timeSec < bars[0].time) return -1;
  let lo = 0;
  let hi = bars.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (bars[mid].time <= timeSec) { ans = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return ans;
}

export function buildTradeViews(trades: readonly PaperTrade[], bars: readonly Candle[]): TradeView[] {
  if (bars.length === 0) return [];
  const first = bars[0].time;
  const last  = bars[bars.length - 1].time;
  const snap = (ms: number): number => {
    const sec = Math.floor(ms / 1000);
    if (sec <= first) return first;
    if (sec >= last)  return last;
    const idx = barIndexAt(bars, sec);
    return idx < 0 ? first : bars[idx].time;
  };
  return trades.map((t, i) => ({
    id: t.id,
    index: i + 1,
    side: t.side,
    qty: t.qty,
    pnl: t.pnl,
    entryTs: t.entryTs,
    exitTs: t.ts,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    // A trade without an entry stamp is drawn as a point at its exit rather
    // than as a segment reaching back to 1970.
    holdSec: t.entryTs > 0 ? Math.max(0, (t.ts - t.entryTs) / 1000) : 0,
    entryBarTime: t.entryTs > 0 ? snap(t.entryTs) : snap(t.ts),
    exitBarTime:  snap(t.ts),
  }));
}

/**
 * Table rows: the same shape without bar snapping. The list shows real trade
 * times, not the bar they were rounded onto — rounding is a chart concern.
 */
export function buildTradeRows(trades: readonly PaperTrade[]): TradeView[] {
  return trades.map((t, i) => ({
    id: t.id,
    index: i + 1,
    side: t.side,
    qty: t.qty,
    pnl: t.pnl,
    entryTs: t.entryTs,
    exitTs: t.ts,
    entryPrice: t.entryPrice,
    exitPrice: t.exitPrice,
    holdSec: t.entryTs > 0 ? Math.max(0, (t.ts - t.entryTs) / 1000) : 0,
    entryBarTime: Math.floor((t.entryTs > 0 ? t.entryTs : t.ts) / 1000),
    exitBarTime: Math.floor(t.ts / 1000),
  }));
}

/** Orders that never became a trade — the grid-strategy diagnostic. */
export interface UnfilledOrderView {
  id: string;
  side: "buy" | "sell";
  price: number;
  qty: number;
  barTime: number;
  status: string;
}

export function buildUnfilledViews(orders: readonly PaperOrder[], bars: readonly Candle[]): UnfilledOrderView[] {
  if (bars.length === 0) return [];
  const first = bars[0].time;
  const last  = bars[bars.length - 1].time;
  const out: UnfilledOrderView[] = [];
  for (const o of orders) {
    if (o.status === "filled") continue;
    const sec = Math.floor(o.ts / 1000);
    const clamped = sec <= first ? first : sec >= last ? last : bars[Math.max(0, barIndexAt(bars, sec))].time;
    out.push({ id: o.id, side: o.side, price: o.price, qty: o.qty, barTime: clamped, status: o.status });
  }
  return out;
}

/* ── sorting / filtering ──────────────────────────────────────────────────── */

import type { TradeFilter, TradeSortKey, SortDir } from "../../lib/backtest/store";

export function filterTrades(trades: readonly TradeView[], filter: TradeFilter): TradeView[] {
  if (filter === "wins")   return trades.filter((t) => t.pnl > 0);
  if (filter === "losses") return trades.filter((t) => t.pnl < 0);
  return trades as TradeView[];
}

const SORT_VALUE: Record<TradeSortKey, (t: TradeView) => number | string> = {
  index:      (t) => t.index,
  entryTs:    (t) => t.entryTs,
  ts:         (t) => t.exitTs,
  side:       (t) => t.side,
  qty:        (t) => t.qty,
  entryPrice: (t) => t.entryPrice,
  exitPrice:  (t) => t.exitPrice,
  pnl:        (t) => t.pnl,
  hold:       (t) => t.holdSec,
};

export function sortTrades(trades: readonly TradeView[], key: TradeSortKey, dir: SortDir): TradeView[] {
  const get = SORT_VALUE[key] ?? SORT_VALUE.index;
  const sign = dir === "asc" ? 1 : -1;
  return [...trades].sort((a, b) => {
    const va = get(a);
    const vb = get(b);
    if (typeof va === "string" || typeof vb === "string") {
      return String(va).localeCompare(String(vb)) * sign;
    }
    return (va - vb) * sign;
  });
}

/* ── report ───────────────────────────────────────────────────────────────── */

/**
 * Same builder the CLI uses, fed from an in-browser run. Declared costs are the
 * one field a UI run cannot supply — the driver resolves settings straight into
 * engine options without going through a RunSpec — so the panel shows
 * `result.costsApplied` (what actually ran) and never the declaration.
 */
export function buildUiReport(result: BacktestResult, durationMs: number): BacktestReport {
  const candles = result.params.candles;
  const barSec  = barSecOf(candles);
  const fromSec = candles.length ? candles[0].time : 0;
  const toSec   = candles.length ? candles[candles.length - 1].time + barSec - 1 : 0;

  const spec = {
    name: `${result.params.bot.kind} · ${result.params.symbol}`,
    market: "linear",
    symbol: result.params.symbol,
    interval: intervalNameOf(barSec),
    signalIntervalSec: result.params.signalIntervalSec ?? 0,
    fromSec,
    toSec,
    initialBalance: result.params.initialBalance,
    bot: result.params.bot,
    costs: { fees: false, slippage: false },
    feeRate: result.params.feeRate,
    stressSlippage: null,
    window: { days: 30, stepDays: 7 },
  } as unknown as RunSpec;

  return buildReport({
    spec,
    bars: candles.length,
    durationMs,
    stats: result.stats,
    equity: result.equity,
    trades: result.trades,
    funding: result.funding,
    rejected: result.rejected,
    liquidations: result.liquidations ?? 0,
    openPositions: result.positions.length,
    pendingOrders: result.orders.filter((o) => o.status === "pending").length,
    costsApplied: result.costsApplied,
    costsDetail: [],
    barSec,
    rangeStartSec: fromSec,
    stress: null,
  });
}

function intervalNameOf(barSec: number): string {
  if (barSec % 86400 === 0) return `${barSec / 86400}d`;
  if (barSec % 3600 === 0)  return `${barSec / 3600}h`;
  return `${Math.round(barSec / 60)}m`;
}

/* ── formatting ───────────────────────────────────────────────────────────── */

export function fmtDuration(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return "—";
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}д ${h}ч`;
  if (h > 0) return `${h}ч ${m}м`;
  return `${m}м`;
}

export function fmtStamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return new Date(ms).toISOString().slice(0, 16).replace("T", " ");
}

export function fmtSigned(v: number, digits = 2): string {
  const s = Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
  return `${v >= 0 ? "+" : "−"}${s}`;
}
