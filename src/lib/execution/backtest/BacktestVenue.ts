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
import { applySlippage } from "../slippage";
import type { SlippageSettings } from "../../settings";
import { BacktestClock } from "./clock";

function uid(prefix: string): string {
  return prefix + "-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export interface BacktestVenueOptions {
  symbol:        string;       // single-symbol backtest
  initialBalance: number;
  feeRate:        number;       // 0.001 = 0.1%
  slippageCfg:    SlippageSettings;
  clock:          BacktestClock;
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
  private listeners: BacktestVenueListeners = {};
  private unsub: (() => void) | null = null;

  constructor(private opts: BacktestVenueOptions) {
    this.balance = opts.initialBalance;
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
    const order: PaperOrder = {
      id: uid("ord"),
      ts: this.nowMs(),
      symbol: req.symbol,
      side:   req.side,
      type:   req.type,
      price:  req.price,
      qty:    req.qty,
      status: "pending",
      botId:  req.botId,
    };
    this.orders.push(order);

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
    const snapshot = this.orders.filter((o) => o.status === "pending");
    const ticker = this.barAsTicker(bar);

    // Market orders queued on an earlier bar fill at this bar's open, before any
    // limit or stop is considered — that is the first price reachable after the
    // decision was made.
    const openTicker = this.barAsTicker(bar, bar.open);
    for (const o of snapshot) {
      if (o.status !== "pending" || o.type !== "market") continue;
      const fill = applySlippage(bar.open, o.side, o.qty, openTicker, this.opts.slippageCfg);
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
        ? applySlippage(o.price, o.side, o.qty, ticker, this.opts.slippageCfg)
        : o.price;
      this.fillOrder(o, fill);
    }
  }

  private fillOrder(order: PaperOrder, fillPrice: number): void {
    order.status = "filled";
    order.filledPrice = fillPrice;
    order.filledTs = this.nowMs();
    const fee = order.qty * fillPrice * this.opts.feeRate;

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
