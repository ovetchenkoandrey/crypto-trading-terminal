// Portfolio simulator for the cascade-reversion effect across many symbols.
//
// The single-symbol bot cannot answer the question breadth raises, because the
// question is about what happens when forty symbols fire in the same minute:
// how many of those signals a 1000 USDT account can actually take, which ones
// it picks, and what the answer costs when it picks wrong.
//
// This is deliberately not a second backtest engine. It replays the price paths
// already recorded on each event (`CascadeEvent.path` — opens, starting one bar
// after the trigger, which is the first price a market order sent on the trigger
// bar can get) and books fees and slippage explicitly. Nothing here reads a
// price the strategy could not have seen.
//
// Three things it models that a per-symbol run cannot:
//  - a slot limit, so a market-wide flush produces N positions, not forty;
//  - the minimum notional of each instrument, which on a 1000 USDT account is
//    what actually decides whether a signal is takeable;
//  - a burst rule, because when eleven signals arrive together the choice of
//    which to take is a real parameter and not an implementation detail.

import type { CascadeEvent } from "./cascadeCrossSection";
import { universeSymbol } from "../data/universe";
import { quantiseDown } from "./cascadeReversion";

export type BurstRule = "biggest" | "first" | "smallest";

export interface PortfolioParams {
  /** Bars held; the exit price is `path[holdBars]`. */
  holdBars: number;
  /** Positions open at once across the whole portfolio. */
  maxConcurrent: number;
  /** Notional per position as a share of equity, in percent. */
  notionalPct: number;
  /** Hard cap on notional per position, USDT; 0 disables. */
  maxNotionalUsdt: number;
  /** Gross notional across open positions as a share of equity, in percent. */
  maxGrossPct: number;
  feeBpsPerSide: number;
  slippageBpsPerSide: number;
  /** Extra adverse bps at entry — the stress knob for an evaporated book. */
  stressEntryBps: number;
  stressExitBps: number;
  /**
   * When > 0, the entry only fills if the price it needs sits inside the entry
   * bar's own range. This is the honest version of "in a real panic nobody
   * fills you": the order is priced, and if the market never traded there it
   * does not happen.
   */
  fillBandBps: number;
  allowLong: boolean;
  allowShort: boolean;
  /** Minimum trigger size, bps; 0 means whatever the threshold admitted. */
  minMoveBps: number;
  burstRule: BurstRule;
  /** Same-minute grouping width in seconds. */
  burstWindowSec: number;
  initialEquity: number;
}

export const DEFAULT_PORTFOLIO_PARAMS: PortfolioParams = {
  holdBars: 60,
  maxConcurrent: 5,
  notionalPct: 20,
  maxNotionalUsdt: 0,
  maxGrossPct: 100,
  feeBpsPerSide: 5.5,
  slippageBpsPerSide: 0,
  stressEntryBps: 0,
  stressExitBps: 0,
  fillBandBps: 0,
  allowLong: true,
  allowShort: true,
  minMoveBps: 0,
  burstRule: "biggest",
  burstWindowSec: 60,
  initialEquity: 1000,
};

export interface PortfolioTrade {
  symbol: string;
  side: "buy" | "sell";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  notional: number;
  grossPnl: number;
  fees: number;
  pnl: number;
  moveBps: number;
}

export interface SkipReasons {
  slots: number;
  gross: number;
  minNotional: number;
  minMove: number;
  direction: number;
  noPath: number;
  noFill: number;
  symbolBusy: number;
}

export interface PortfolioResult {
  trades: PortfolioTrade[];
  equity: number;
  initialEquity: number;
  returnPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
  winRate: number;
  grossEdgeBps: number;
  netEdgeBps: number;
  netEdgeT: number;
  /**
   * The same t after collapsing trades that entered within five minutes of each
   * other into one observation. Positions opened in the same market-wide flush
   * are one bet placed forty times, and the naive t does not know that.
   */
  netEdgeClusterT: number;
  /** Observations left after that collapse. */
  netEdgeClusters: number;
  tradesPerDay: number;
  eventsSeen: number;
  skips: SkipReasons;
  /** Daily realized PnL keyed by UTC day index, in order. */
  dailyPnl: { day: number; pnl: number; equity: number }[];
  /** Share of total profit contributed by the single best day. */
  topDayShare: number;
  /** Calendar days on which at least one trade closed. */
  activeDays: number;
}

interface OpenPosition {
  event: CascadeEvent;
  side: "buy" | "sell";
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  notional: number;
  fees: number;
}

const MINUTE = 60;
const DAY = 86_400;

function instrument(symbol: string): { minQty: number; qtyStep: number; minNotional: number } {
  const u = universeSymbol(symbol);
  return {
    minQty: u?.minQty ?? 0.001,
    qtyStep: u?.qtyStep ?? 0.001,
    minNotional: u?.minNotionalUsdt ?? 5,
  };
}

/**
 * Adverse price adjustment. `bps` is always paid against the trader: a buy fills
 * higher, a sell fills lower, on both legs.
 */
function adverse(price: number, side: "buy" | "sell", bps: number): number {
  if (!(bps > 0)) return price;
  const k = bps / 1e4;
  return side === "buy" ? price * (1 + k) : price * (1 - k);
}

/** Groups events into bursts by open time. Input need not be sorted. */
export function groupBursts(events: readonly CascadeEvent[], windowSec: number): CascadeEvent[][] {
  const sorted = [...events].sort((a, b) => a.time - b.time || a.symbol.localeCompare(b.symbol));
  const out: CascadeEvent[][] = [];
  let current: CascadeEvent[] = [];
  let anchor = -Infinity;
  for (const e of sorted) {
    if (current.length > 0 && e.time - anchor >= Math.max(1, windowSec)) {
      out.push(current);
      current = [];
    }
    if (current.length === 0) anchor = e.time;
    current.push(e);
  }
  if (current.length > 0) out.push(current);
  return out;
}

function orderBurst(burst: readonly CascadeEvent[], rule: BurstRule): CascadeEvent[] {
  const list = [...burst];
  if (rule === "biggest") list.sort((a, b) => Math.abs(b.moveBps) - Math.abs(a.moveBps));
  else if (rule === "smallest") list.sort((a, b) => Math.abs(a.moveBps) - Math.abs(b.moveBps));
  return list;
}

/**
 * Replays the portfolio over the whole event stream.
 *
 * Positions are closed before new ones are considered at the same timestamp,
 * which is the order a live account would see: the slot frees on the exit bar.
 * Equity compounds off realized PnL only — open positions do not enlarge the
 * next position's size, which keeps sizing from depending on marks the run
 * would have to fetch from bars it is not replaying.
 */
export function runPortfolio(events: readonly CascadeEvent[], raw: Partial<PortfolioParams> = {}): PortfolioResult {
  const p: PortfolioParams = { ...DEFAULT_PORTFOLIO_PARAMS, ...raw };
  const bursts = groupBursts(events, p.burstWindowSec);

  let equity = p.initialEquity;
  let peak = equity;
  let maxDd = 0;
  const trades: PortfolioTrade[] = [];
  const open: OpenPosition[] = [];
  const skips: SkipReasons = {
    slots: 0, gross: 0, minNotional: 0, minMove: 0, direction: 0, noPath: 0, noFill: 0, symbolBusy: 0,
  };
  const dailyMap = new Map<number, number>();
  let eventsSeen = 0;

  const closeDue = (now: number): void => {
    for (let i = open.length - 1; i >= 0; i--) {
      const pos = open[i];
      if (pos.exitTime > now) continue;
      open.splice(i, 1);
      const dir = pos.side === "buy" ? 1 : -1;
      const gross = dir * (pos.exitPrice - pos.entryPrice) * pos.qty;
      const pnl = gross - pos.fees;
      equity += pnl;
      peak = Math.max(peak, equity);
      if (peak > 0) maxDd = Math.max(maxDd, (peak - equity) / peak);
      const day = Math.floor(pos.exitTime / DAY);
      dailyMap.set(day, (dailyMap.get(day) ?? 0) + pnl);
      trades.push({
        symbol: pos.event.symbol,
        side: pos.side,
        entryTime: pos.entryTime,
        exitTime: pos.exitTime,
        entryPrice: pos.entryPrice,
        exitPrice: pos.exitPrice,
        qty: pos.qty,
        notional: pos.notional,
        grossPnl: gross,
        fees: pos.fees,
        pnl,
        moveBps: pos.event.moveBps,
      });
    }
  };

  for (const burst of bursts) {
    const now = burst[0].time;
    closeDue(now);

    for (const e of orderBurst(burst, p.burstRule)) {
      eventsSeen += 1;
      if (p.minMoveBps > 0 && Math.abs(e.moveBps) < p.minMoveBps) {
        skips.minMove += 1;
        continue;
      }
      const side: "buy" | "sell" = e.moveBps > 0 ? "sell" : "buy";
      if ((side === "buy" && !p.allowLong) || (side === "sell" && !p.allowShort)) {
        skips.direction += 1;
        continue;
      }
      if (open.length >= p.maxConcurrent) {
        skips.slots += 1;
        continue;
      }
      if (open.some((o) => o.event.symbol === e.symbol)) {
        skips.symbolBusy += 1;
        continue;
      }
      if (e.path.length <= p.holdBars) {
        skips.noPath += 1;
        continue;
      }

      const entryRef = e.path[0];
      const exitRef = e.path[p.holdBars];
      if (!(entryRef > 0) || !(exitRef > 0)) {
        skips.noPath += 1;
        continue;
      }

      const entryPrice = adverse(entryRef, side, p.slippageBpsPerSide + p.stressEntryBps);
      const exitSide: "buy" | "sell" = side === "buy" ? "sell" : "buy";
      const exitPrice = adverse(exitRef, exitSide, p.slippageBpsPerSide + p.stressExitBps);

      if (p.fillBandBps > 0) {
        // The entry bar's own range is the only evidence that a price was
        // reachable. A fill outside it is a fill nobody offered.
        const lo = e.entryLow * (1 - p.fillBandBps / 1e4);
        const hi = e.entryHigh * (1 + p.fillBandBps / 1e4);
        if (entryPrice < lo || entryPrice > hi) {
          skips.noFill += 1;
          continue;
        }
      }

      const inst = instrument(e.symbol);
      let notional = equity * (p.notionalPct / 100);
      if (p.maxNotionalUsdt > 0) notional = Math.min(notional, p.maxNotionalUsdt);
      const grossOpen = open.reduce((s, o) => s + o.notional, 0);
      const grossCap = equity * (p.maxGrossPct / 100);
      if (grossOpen + notional > grossCap) {
        notional = Math.max(0, grossCap - grossOpen);
        if (notional <= 0) {
          skips.gross += 1;
          continue;
        }
      }

      const qty = quantiseDown(notional / entryPrice, inst.qtyStep);
      const realNotional = qty * entryPrice;
      if (qty <= 0 || qty + 1e-12 < inst.minQty || realNotional + 1e-9 < inst.minNotional) {
        skips.minNotional += 1;
        continue;
      }

      const fees = (realNotional + qty * exitPrice) * (p.feeBpsPerSide / 1e4);
      open.push({
        event: e,
        side,
        entryTime: e.time + MINUTE,
        exitTime: e.time + MINUTE * (1 + p.holdBars),
        entryPrice,
        exitPrice,
        qty,
        notional: realNotional,
        fees,
      });
    }
  }

  closeDue(Infinity);
  trades.sort((a, b) => a.exitTime - b.exitTime);

  return summarise(trades, p.initialEquity, equity, maxDd, dailyMap, eventsSeen, skips, events);
}

function summarise(
  trades: PortfolioTrade[],
  initialEquity: number,
  equity: number,
  maxDd: number,
  dailyMap: Map<number, number>,
  eventsSeen: number,
  skips: SkipReasons,
  events: readonly CascadeEvent[],
): PortfolioResult {
  let wins = 0;
  let grossWin = 0;
  let grossLoss = 0;
  const grossBps: number[] = [];
  const netBps: number[] = [];
  for (const t of trades) {
    if (t.pnl > 0) {
      wins += 1;
      grossWin += t.pnl;
    } else {
      grossLoss -= t.pnl;
    }
    if (t.notional > 0) {
      grossBps.push((t.grossPnl / t.notional) * 1e4);
      netBps.push((t.pnl / t.notional) * 1e4);
    }
  }

  const days = new Set<number>();
  for (const e of events) days.add(Math.floor(e.time / DAY));
  const span = spanDays(events);

  const daily = [...dailyMap.entries()].sort((a, b) => a[0] - b[0]);
  let running = initialEquity;
  const dailyPnl = daily.map(([day, pnl]) => {
    running += pnl;
    return { day, pnl, equity: running };
  });
  const totalProfit = equity - initialEquity;
  const bestDay = daily.reduce((m, [, pnl]) => Math.max(m, pnl), 0);

  const meanNet = mean(netBps);
  const sdNet = sd(netBps, meanNet);
  const clustered = clusterTradeReturns(trades);
  const meanCl = mean(clustered);
  const sdCl = sd(clustered, meanCl);

  return {
    trades,
    equity,
    initialEquity,
    returnPct: initialEquity > 0 ? ((equity - initialEquity) / initialEquity) * 100 : 0,
    maxDrawdownPct: maxDd * 100,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? Infinity : 0,
    winRate: trades.length > 0 ? wins / trades.length : Number.NaN,
    grossEdgeBps: mean(grossBps),
    netEdgeBps: meanNet,
    netEdgeT: netBps.length > 1 && sdNet > 0 ? meanNet / (sdNet / Math.sqrt(netBps.length)) : Number.NaN,
    netEdgeClusterT: clustered.length > 1 && sdCl > 0 ? meanCl / (sdCl / Math.sqrt(clustered.length)) : Number.NaN,
    netEdgeClusters: clustered.length,
    tradesPerDay: span > 0 ? trades.length / span : Number.NaN,
    eventsSeen,
    skips,
    dailyPnl,
    topDayShare: totalProfit > 0 ? bestDay / totalProfit : Number.NaN,
    activeDays: daily.length,
  };
}

const TRADE_CLUSTER_SEC = 300;

/**
 * Mean net return per market-wide flush, in bps. Trades entered within
 * `TRADE_CLUSTER_SEC` of each other are averaged into a single number, because
 * they are one market event and their errors are not independent.
 */
function clusterTradeReturns(trades: readonly PortfolioTrade[]): number[] {
  const usable = trades.filter((t) => t.notional > 0).sort((a, b) => a.entryTime - b.entryTime);
  const out: number[] = [];
  let bucket: number[] = [];
  let last = -Infinity;
  for (const t of usable) {
    if (bucket.length > 0 && t.entryTime - last > TRADE_CLUSTER_SEC) {
      out.push(mean(bucket));
      bucket = [];
    }
    bucket.push((t.pnl / t.notional) * 1e4);
    last = t.entryTime;
  }
  if (bucket.length > 0) out.push(mean(bucket));
  return out;
}

function spanDays(events: readonly CascadeEvent[]): number {
  if (events.length === 0) return 0;
  let min = Infinity;
  let max = -Infinity;
  for (const e of events) {
    if (e.time < min) min = e.time;
    if (e.time > max) max = e.time;
  }
  return Math.max(1, (max - min) / DAY);
}

function mean(x: readonly number[]): number {
  if (x.length === 0) return Number.NaN;
  let s = 0;
  for (const v of x) s += v;
  return s / x.length;
}

function sd(x: readonly number[], m: number): number {
  if (x.length < 2) return Number.NaN;
  let s = 0;
  for (const v of x) s += (v - m) * (v - m);
  return Math.sqrt(s / (x.length - 1));
}
