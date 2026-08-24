// Self-contained venue used by the strategy tester.
// Holds its own positions / orders / history (NOT the paper slices in store).
// Price source is the current bar of the BacktestClock; matching uses the same
// slippage model as paper for consistency.

import type {
  ExecutionVenue,
  PlaceOrderRequest,
  VenueBalance,
  VenueOrder,
  VenuePosition,
  VenueTrade,
} from "../types";
import type { Side, Ticker, PaperOrder, PaperPosition, PaperTrade } from "../../store";
import type { Candle } from "../../types";
import { applySlippage, applySlippageWithContext } from "../slippage";
import type { SlippageContextSettings } from "../slippage";
import type { SlippageSettings } from "../../settings";
import { computeOrderFee, feeSettingsFromFlatRate, normalizeFeeSettings } from "../fees";
import type { FeeRole, FeeSettings } from "../fees";
import { evaluateRejection } from "../rejection";
import type { RejectionSettings } from "../rejection";
import { normalizeOrder } from "../instrumentRules";
import type { InstrumentRules } from "../instrumentRules";
import type { FundingRateEvent } from "../funding";
import { BacktestClock } from "./clock";

function uid(prefix: string): string {
  return prefix + "-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/**
 * Cost models are opt-in: a model left undefined is not applied at all, rather
 * than silently defaulting to its own settings. A backtest has to declare the
 * costs it runs under — switching them on by default would quietly change what
 * previous runs meant.
 */
export interface BacktestVenueOptions {
  symbol:        string;       // single-symbol backtest
  initialBalance: number;
  feeRate:        number;       // 0.001 = 0.1% — used when `fees` is absent
  slippageCfg:    SlippageSettings;
  clock:          BacktestClock;
  /** Split maker/taker rates. Falls back to the flat feeRate above. */
  fees?:           FeeSettings;
  /** Time-of-day and volatility multipliers on top of the base slippage. */
  slippageContext?: SlippageContextSettings;
  /** Order rejection (thin book, price band, stress windows). */
  rejection?:      RejectionSettings;
  /** Quantisation and minimum-size rules of the traded instrument. */
  rules?:          InstrumentRules;
  /** Perpetual funding settlements applied while a position is open. */
  funding?:        { events: FundingRateEvent[] };
}

export interface BacktestVenueListeners {
  onOrderFilled?: (order: VenueOrder, fillPrice: number) => void;
}

export class BacktestVenueImpl implements ExecutionVenue {
  readonly mode = "backtest" as const;

  balance:   number;
  positions: PaperPosition[] = [];
  orders:    PaperOrder[] = [];
  history:   PaperTrade[] = [];
  /** Funding paid (negative) or received (positive) over the run. */
  fundingTotal = 0;
  /** Orders dropped by the rejection model, for the run report. */
  rejectedCount = 0;
  private listeners: BacktestVenueListeners = {};
  private unsub: (() => void) | null = null;
  private readonly fees: FeeSettings;
  /** Orders that take liquidity — market, stop, and marketable limits. */
  private takesLiquidity = new Set<string>();
  private lastBarTime: number | null = null;

  constructor(private opts: BacktestVenueOptions) {
    this.balance = opts.initialBalance;
    this.fees = opts.fees
      ? normalizeFeeSettings(opts.fees)
      : feeSettingsFromFlatRate(opts.feeRate);
  }

  /** Register fill listener — used by the bot manager to forward to bots. */
  setListeners(l: BacktestVenueListeners): void {
    this.listeners = l;
  }

  init(): void {
    // Subscribe to bar ticks — each bar attempts to match all pending orders.
    this.unsub = this.opts.clock.onBar((bar) => this.onBar(bar));
  }

  shutdown(): void {
    this.unsub?.();
    this.unsub = null;
  }

  placeOrder(req: PlaceOrderRequest): VenueOrder {
    const rules = this.opts.rules;
    let qty = req.qty;
    let price = req.price;
    let allowed = true;

    if (rules) {
      if (req.type === "market") {
        // A market order's price field is only a reference; validate its size
        // against the current bar instead of quantising a price nobody uses.
        const ref = this.opts.clock.current?.close ?? req.price;
        const n = normalizeOrder({ qty, price: ref }, rules, {});
        qty = n.qty;
        allowed = n.ok;
      } else {
        const n = normalizeOrder({ qty, price }, rules, { side: req.side });
        qty = n.qty;
        price = n.price;
        allowed = n.ok;
      }
    }

    const order: PaperOrder = {
      id: uid("ord"),
      ts: this.nowMs(),
      symbol: req.symbol,
      side:   req.side,
      type:   req.type,
      price,
      qty,
      status: "pending",
      botId:  req.botId,
    };
    this.orders.push(order);

    // Below the exchange minimum, or not on the size step — the venue would
    // never have accepted it, so neither do we.
    if (!allowed) {
      order.status = "cancelled";
      this.rejectedCount += 1;
      return order;
    }

    // Fee role is fixed at placement. A limit priced through the current market
    // crosses the book immediately and pays the taker rate; assuming every
    // limit is a maker is the optimistic mistake that flatters grid strategies.
    if (order.type === "market" || order.type === "stop") {
      this.takesLiquidity.add(order.id);
    } else if (order.type === "limit") {
      const ref = this.opts.clock.current?.close;
      const marketable = ref !== undefined && (
        (order.side === "buy"  && order.price >= ref) ||
        (order.side === "sell" && order.price <= ref)
      );
      if (marketable) this.takesLiquidity.add(order.id);
    }

    // Market orders stay pending and fill at the NEXT bar's open (see onBar).
    // Filling at the current bar's close would hand the strategy a price it
    // already knew when it decided to trade — the decision is made once the bar
    // has closed, so the earliest reachable price is the next open.
    return order;
  }

  cancelOrder(id: string, _reason?: string): void {
    void _reason;
    const o = this.orders.find((x) => x.id === id);
    if (o && o.status === "pending") {
      o.status = "cancelled";
    }
  }

  cancelOrdersByBot(botId: string): number {
    let n = 0;
    for (const o of this.orders) {
      if (o.status === "pending" && o.botId === botId) { o.status = "cancelled"; n++; }
    }
    return n;
  }

  closePosition(positionId: string, atPrice?: number): void {
    const pos = this.positions.find((p) => p.id === positionId);
    if (!pos) return;
    const bar = this.opts.clock.current;
    const price = atPrice ?? bar?.close ?? pos.entryPrice;
    this.placeOrder({
      symbol: pos.symbol,
      side:   pos.side === "buy" ? "sell" : "buy",
      type:   "market",
      price,
      qty:    pos.qty,
      botId:  pos.botId,
    });
  }

  getOpenOrders():    VenueOrder[]    { return this.orders.filter((o) => o.status === "pending"); }
  getOpenPositions(): VenuePosition[] { return this.positions.slice(); }
  getHistory():       VenueTrade[]    { return this.history.slice(); }
  getBalance(): VenueBalance {
    return { equity: this.balance + this.unrealisedPnl(), available: this.balance };
  }
  getTicker(symbol: string): Ticker | undefined {
    if (symbol !== this.opts.symbol) return undefined;
    const bar = this.opts.clock.current;
    return bar ? this.barAsTicker(bar) : undefined;
  }

  // ─── matching ─────────────────────────────────────────────────────────────
  private onBar(bar: Candle): void {
    // Snapshot of orders eligible for matching ON THIS BAR. Orders created by
    // the bot in reaction to a fill (via onOrderFilled) won't be matched until
    // the NEXT bar — otherwise grid-style strategies would feed themselves in
    // an infinite loop within a single bar.
    this.applyFunding(bar);

    const snapshot = this.orders.filter((o) => o.status === "pending");
    const ticker = this.barAsTicker(bar);

    // Market orders queued on an earlier bar fill at this bar's open, before any
    // limit or stop is considered — that is the first price reachable after the
    // decision was made.
    const openTicker = this.barAsTicker(bar, bar.open);
    for (const o of snapshot) {
      if (o.status !== "pending" || o.type !== "market") continue;
      const fill = this.slipped(bar.open, o.side, o.qty, openTicker, bar);
      if (this.rejected(o, fill, bar)) continue;
      this.fillOrder(o, fill);
    }

    for (const o of snapshot) {
      if (o.status !== "pending" || o.type === "market") continue;   // could be closed by a paired fill
      const hit =
        o.type === "limit" && o.side === "buy"  && bar.low  <= o.price ? true :
        o.type === "limit" && o.side === "sell" && bar.high >= o.price ? true :
        o.type === "stop"  && o.side === "buy"  && bar.high >= o.price ? true :
        o.type === "stop"  && o.side === "sell" && bar.low  <= o.price ? true :
        false;
      if (!hit) continue;
      const fill = o.type === "stop"
        ? this.slipped(o.price, o.side, o.qty, ticker, bar)
        : o.price;
      if (this.rejected(o, fill, bar)) continue;
      this.fillOrder(o, fill);
    }
  }

  /** Base slippage, scaled by time-of-day and volatility when configured. */
  private slipped(ref: number, side: Side, qty: number, ticker: Ticker, bar: Candle): number {
    const contextCfg = this.opts.slippageContext;
    if (!contextCfg) {
      return applySlippage(ref, side, qty, ticker, this.opts.slippageCfg);
    }
    return applySlippageWithContext(ref, side, qty, ticker, this.opts.slippageCfg, {
      barTime: bar.time,
      bar,
      contextCfg,
    });
  }

  /** Cancels the order and reports true when the rejection model drops it. */
  private rejected(order: PaperOrder, fillPrice: number, bar: Candle): boolean {
    const cfg = this.opts.rejection;
    if (!cfg) return false;

    const ref = order.type === "market" ? bar.open : order.price;
    const decision = evaluateRejection({
      symbol: order.symbol,
      side:   order.side,
      type:   order.type,
      qty:    order.qty,
      price:  fillPrice,
      barTime: bar.time,
      expectedSlippageBps: ref > 0 ? (Math.abs(fillPrice - ref) / ref) * 10_000 : 0,
      barRangePct: bar.close > 0 ? ((bar.high - bar.low) / bar.close) * 100 : 0,
      crossedBook: this.takesLiquidity.has(order.id),
    }, cfg);

    if (decision.accepted) return false;
    order.status = "cancelled";
    this.rejectedCount += 1;
    this.takesLiquidity.delete(order.id);
    return true;
  }

  /**
   * Charges funding settlements that fall between the previous bar and this one.
   * A perpetual held for a day pays three times at the usual 8h interval, so
   * ignoring this systematically overstates the result of any position that
   * survives overnight.
   */
  private applyFunding(bar: Candle): void {
    const prev = this.lastBarTime;
    this.lastBarTime = bar.time;
    const events = this.opts.funding?.events;
    if (!events || prev === null || this.positions.length === 0) return;

    for (const ev of events) {
      const ts = ev.timestamp > 1e11 ? Math.floor(ev.timestamp / 1000) : ev.timestamp;
      if (ts <= prev || ts > bar.time) continue;
      for (const p of this.positions) {
        if (p.symbol !== this.opts.symbol) continue;
        const price = ev.markPrice ?? bar.close;
        const dir = p.side === "buy" ? 1 : -1;
        const amount = -dir * p.qty * price * ev.rate;
        this.balance += amount;
        this.fundingTotal += amount;
      }
    }
  }

  private fillOrder(order: PaperOrder, fillPrice: number): void {
    order.status = "filled";
    order.filledPrice = fillPrice;
    order.filledTs = this.nowMs();
    const role: FeeRole = this.takesLiquidity.has(order.id) ? "taker" : "maker";
    this.takesLiquidity.delete(order.id);
    const fee = computeOrderFee(fillPrice, order.qty, role, this.fees);

    const sameSide = this.positions.find((p) => p.symbol === order.symbol && p.side === order.side && p.botId === order.botId);
    const opposite = this.positions.find((p) => p.symbol === order.symbol && p.side !== order.side && p.botId === order.botId);

    if (opposite) {
      const closingQty = Math.min(opposite.qty, order.qty);
      const direction  = opposite.side === "buy" ? 1 : -1;
      const pnl = (fillPrice - opposite.entryPrice) * closingQty * direction - fee;
      this.balance += pnl;

      this.history.push({
        id: uid("trd"),
        ts: this.nowMs(),
        symbol: order.symbol,
        side:   opposite.side as Side,
        entryPrice: opposite.entryPrice,
        exitPrice:  fillPrice,
        qty:        closingQty,
        pnl,
        botId:      order.botId,
      });

      const remaining = opposite.qty - closingQty;
      if (remaining > 0) opposite.qty = remaining;
      else this.positions = this.positions.filter((p) => p.id !== opposite.id);

      const extra = order.qty - closingQty;
      if (extra > 0) {
        this.positions.push({
          id: uid("pos"),
          symbol: order.symbol,
          side:   order.side,
          entryPrice: fillPrice,
          qty: extra,
          openedTs: this.nowMs(),
          botId: order.botId,
        });
      }
    } else if (sameSide) {
      const total = sameSide.qty + order.qty;
      sameSide.entryPrice = (sameSide.entryPrice * sameSide.qty + fillPrice * order.qty) / total;
      sameSide.qty = total;
      this.balance -= fee;
    } else {
      this.positions.push({
        id: uid("pos"),
        symbol: order.symbol,
        side:   order.side,
        entryPrice: fillPrice,
        qty: order.qty,
        openedTs: this.nowMs(),
        botId: order.botId,
      });
      this.balance -= fee;
    }

    this.listeners.onOrderFilled?.(order, fillPrice);
  }

  private unrealisedPnl(): number {
    const bar = this.opts.clock.current;
    if (!bar) return 0;
    let sum = 0;
    for (const p of this.positions) {
      if (p.symbol !== this.opts.symbol) continue;
      const dir = p.side === "buy" ? 1 : -1;
      sum += (bar.close - p.entryPrice) * p.qty * dir;
    }
    return sum;
  }

  private nowMs(): number {
    const bar = this.opts.clock.current;
    return bar ? bar.time * 1000 : Date.now();
  }

  private barAsTicker(bar: Candle, price?: number): Ticker {
    const px = price ?? bar.close;
    return {
      symbol:     this.opts.symbol,
      lastPrice:  px,
      bid1:       px,
      ask1:       px,
      change24h:  0,
      high24h:    bar.high,
      low24h:     bar.low,
      volume24h:  bar.volume,
      updatedAt:  bar.time * 1000,
    };
  }
}
