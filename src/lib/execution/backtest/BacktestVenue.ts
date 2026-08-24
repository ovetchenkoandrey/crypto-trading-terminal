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
  private reduceOnly = new Set<string>();
  /** Entry fee still attributable to each open position, by position id. */
  private entryFees = new Map<string, number>();
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

    if (req.reduceOnly) this.reduceOnly.add(order.id);

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
      this.forget(o.id);
    }
  }

  cancelOrdersByBot(botId: string): number {
    let n = 0;
    for (const o of this.orders) {
      if (o.status === "pending" && o.botId === botId) { o.status = "cancelled"; this.forget(o.id); n++; }
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
      reduceOnly: true,   // closing must never flip into a new position
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

    // Stops are matched before limits. When one bar covers both a stop-loss and
    // a take-profit, OHLC cannot say which happened first, so we take the worse
    // outcome for the strategy rather than let array order decide it.
    const resting = snapshot
      .filter((o) => o.type !== "market")
      .sort((a, b) => Number(b.type === "stop") - Number(a.type === "stop"));

    for (const o of resting) {
      if (o.status !== "pending") continue;   // could be closed by a paired fill
      const hit =
        o.type === "limit" && o.side === "buy"  && bar.low  <= o.price ? true :
        o.type === "limit" && o.side === "sell" && bar.high >= o.price ? true :
        o.type === "stop"  && o.side === "buy"  && bar.high >= o.price ? true :
        o.type === "stop"  && o.side === "sell" && bar.low  <= o.price ? true :
        false;
      if (!hit) continue;

      // A bar that opens beyond the level fills there, not at the level: a stop
      // at 95 on a bar opening at 92 is a 92 fill, and a buy limit at 110 on a
      // bar opening at 100 is a 100 fill. Using the order price either way
      // understates stop losses and overstates marketable limits.
      const base = o.side === "buy"
        ? (o.type === "stop" ? Math.max(bar.open, o.price) : Math.min(bar.open, o.price))
        : (o.type === "stop" ? Math.min(bar.open, o.price) : Math.max(bar.open, o.price));
      const fill = o.type === "stop"
        ? this.slipped(base, o.side, o.qty, ticker, bar)
        : base;
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

  /** True when the rejection model refuses this fill on this bar. */
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
      // How far the bar traded through the limit. Deep penetration means the
      // queue almost certainly cleared, so the model can stop treating the fill
      // as a coin flip.
      penetrationBps: order.type === "limit" && order.price > 0
        ? (order.side === "buy"
            ? Math.max(0, order.price - bar.low) / order.price
            : Math.max(0, bar.high - order.price) / order.price) * 10_000
        : undefined,
    }, cfg);

    if (decision.accepted) return false;

    // A limit that did not fill stays in the book: the queue simply failed to
    // reach it on this bar, and it can fill later. Cancelling it would delete
    // the order for a timing artefact. Liquidity-taking orders really are gone.
    if (order.type === "limit") return true;

    order.status = "cancelled";
    this.rejectedCount += 1;
    this.forget(order.id);
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
    const sameSide = this.positions.find((p) => p.symbol === order.symbol && p.side === order.side && p.botId === order.botId);
    const opposite = this.positions.find((p) => p.symbol === order.symbol && p.side !== order.side && p.botId === order.botId);

    // Reduce-only never opens or flips: with nothing to close it simply dies.
    let qty = order.qty;
    if (this.reduceOnly.has(order.id)) {
      if (!opposite) {
        order.status = "cancelled";
        this.forget(order.id);
        return;
      }
      qty = Math.min(qty, opposite.qty);
      order.qty = qty;
    }

    order.status = "filled";
    order.filledPrice = fillPrice;
    order.filledTs = this.nowMs();
    const role: FeeRole = this.takesLiquidity.has(order.id) ? "taker" : "maker";
    this.forget(order.id);
    const fee = computeOrderFee(fillPrice, qty, role, this.fees);

    if (opposite) {
      const closingQty = Math.min(opposite.qty, qty);
      const direction  = opposite.side === "buy" ? 1 : -1;
      // Split the fee between the part that closes and the part that opens, so
      // a flip does not charge the closing trade for the whole order.
      const closingFee = qty > 0 ? fee * (closingQty / qty) : 0;
      const openingFee = fee - closingFee;
      const gross = (fillPrice - opposite.entryPrice) * closingQty * direction;

      // Entry fee was already taken from the balance when the position opened;
      // it belongs in the trade's pnl but must not be deducted twice.
      const entryFeeTotal = this.entryFees.get(opposite.id) ?? 0;
      const entryFeeShare = opposite.qty > 0 ? entryFeeTotal * (closingQty / opposite.qty) : 0;
      this.balance += gross - closingFee;

      this.history.push({
        id: uid("trd"),
        ts: this.nowMs(),
        symbol: order.symbol,
        side:   opposite.side as Side,
        entryPrice: opposite.entryPrice,
        exitPrice:  fillPrice,
        qty:        closingQty,
        pnl:        gross - closingFee - entryFeeShare,
        botId:      order.botId,
      });

      const remaining = opposite.qty - closingQty;
      if (remaining > 0) {
        opposite.qty = remaining;
        this.entryFees.set(opposite.id, entryFeeTotal - entryFeeShare);
      } else {
        this.positions = this.positions.filter((p) => p.id !== opposite.id);
        this.entryFees.delete(opposite.id);
      }

      const extra = qty - closingQty;
      if (extra > 0) {
        const id = uid("pos");
        this.positions.push({
          id,
          symbol: order.symbol,
          side:   order.side,
          entryPrice: fillPrice,
          qty: extra,
          openedTs: this.nowMs(),
          botId: order.botId,
        });
        this.entryFees.set(id, openingFee);
        this.balance -= openingFee;
      }
    } else if (sameSide) {
      const total = sameSide.qty + qty;
      sameSide.entryPrice = (sameSide.entryPrice * sameSide.qty + fillPrice * qty) / total;
      sameSide.qty = total;
      this.balance -= fee;
      this.entryFees.set(sameSide.id, (this.entryFees.get(sameSide.id) ?? 0) + fee);
    } else {
      const id = uid("pos");
      this.positions.push({
        id,
        symbol: order.symbol,
        side:   order.side,
        entryPrice: fillPrice,
        qty,
        openedTs: this.nowMs(),
        botId: order.botId,
      });
      this.entryFees.set(id, fee);
      this.balance -= fee;
    }

    this.listeners.onOrderFilled?.(order, fillPrice);
  }

  /** Drops per-order bookkeeping once an order can no longer fill. */
  private forget(orderId: string): void {
    this.takesLiquidity.delete(orderId);
    this.reduceOnly.delete(orderId);
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
