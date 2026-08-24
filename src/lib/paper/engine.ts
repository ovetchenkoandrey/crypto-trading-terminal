import { useStore } from "../store";
import type {
  PaperOrder,
  PaperPosition,
  PaperTrade,
  Side,
  OrderType,
  Ticker,
} from "../store";
import { logInfo, logOk, logWarn, bus } from "../eventBus";
import { applySlippage } from "../execution/slippage";

function uid(prefix: string): string {
  return prefix + "-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

class PaperTradingEngine {
  private unsubTickers: (() => void) | null = null;

  init(): void {
    if (this.unsubTickers) return;
    // Subscribe to ticker updates — on lastPrice changes, run order matching for that symbol
    const prevPrices = new Map<string, number>();
    this.unsubTickers = useStore.subscribe((state) => {
      for (const [sym, t] of Object.entries(state.tickers)) {
        const prev = prevPrices.get(sym);
        if (prev !== t.lastPrice) {
          prevPrices.set(sym, t.lastPrice);
          this.onTick(sym, t.lastPrice);
        }
      }
    });
    logInfo("paper", "trading engine started");
  }

  shutdown(): void {
    this.unsubTickers?.();
    this.unsubTickers = null;
  }

  placeOrder(req: {
    symbol: string;
    side: Side;
    type: OrderType;
    price: number;     // for market this is reference price (use last)
    qty: number;
    botId?: string;
  }): PaperOrder {
    const order: PaperOrder = {
      id: uid("ord"),
      ts: Date.now(),
      symbol: req.symbol,
      side: req.side,
      type: req.type,
      price: req.price,
      qty: req.qty,
      status: "pending",
      botId: req.botId,
    };
    const st = useStore.getState();
    st.setPaperOrders([...st.paperOrders, order]);
    logInfo("paper", `order placed: ${order.side} ${order.qty} ${order.symbol} @ ${order.price} (${order.type})${order.botId ? " bot=" + order.botId : ""}`);

    // Market orders execute immediately at the current tick price (+ slippage)
    if (order.type === "market") {
      const t = st.tickers[order.symbol];
      const ref = t?.lastPrice ?? order.price;
      const cfg = st.settings.paperTrading.slippage;
      const fillPrice = applySlippage(ref, order.side, order.qty, t, cfg);
      this.fillOrder(order, fillPrice);
    }
    return order;
  }

  cancelOrder(id: string, reason = "user"): void {
    const st = useStore.getState();
    const idx = st.paperOrders.findIndex((o) => o.id === id);
    if (idx < 0) return;
    const o = st.paperOrders[idx];
    if (o.status !== "pending") return;
    const next = [...st.paperOrders];
    next[idx] = { ...o, status: "cancelled" };
    st.setPaperOrders(next);
    logInfo("paper", `order cancelled (${reason}): ${o.side} ${o.qty} ${o.symbol} @ ${o.price}`);
    bus.emit("bot", { ts: Date.now(), botId: o.botId ?? "", type: "order_cancelled", data: { orderId: o.id, reason } });
  }

  cancelOrdersByBot(botId: string): number {
    const st = useStore.getState();
    let count = 0;
    const next = st.paperOrders.map((o) => {
      if (o.status === "pending" && o.botId === botId) {
        count++;
        return { ...o, status: "cancelled" as const };
      }
      return o;
    });
    if (count > 0) {
      st.setPaperOrders(next);
      logInfo("paper", `cancelled ${count} orders for bot ${botId}`);
    }
    return count;
  }

  closePosition(positionId: string, atPrice?: number): void {
    const st = useStore.getState();
    const pos = st.paperPositions.find((p) => p.id === positionId);
    if (!pos) return;
    const price = atPrice ?? st.tickers[pos.symbol]?.lastPrice ?? pos.entryPrice;
    // Reverse market order
    this.placeOrder({
      symbol: pos.symbol,
      side: pos.side === "buy" ? "sell" : "buy",
      type: "market",
      price,
      qty: pos.qty,
      botId: pos.botId,
    });
  }

  /* ───────────────── matching engine ───────────────── */
  private onTick(symbol: string, lastPrice: number): void {
    const st = useStore.getState();
    const ticker = st.tickers[symbol];
    const slipCfg = st.settings.paperTrading.slippage;
    const pending = st.paperOrders.filter((o) => o.status === "pending" && o.symbol === symbol);
    for (const o of pending) {
      const trigger =
        o.type === "limit" && o.side === "buy"  && lastPrice <= o.price ? true :
        o.type === "limit" && o.side === "sell" && lastPrice >= o.price ? true :
        o.type === "stop"  && o.side === "buy"  && lastPrice >= o.price ? true :
        o.type === "stop"  && o.side === "sell" && lastPrice <= o.price ? true :
        false;
      if (trigger) {
        // Limit orders fill at the limit price exactly (no slippage — you ARE the maker).
        // Stop orders become market on trigger and ARE subject to slippage.
        const ref = o.price;
        const fillPrice = o.type === "stop"
          ? applySlippage(ref, o.side, o.qty, ticker, slipCfg)
          : ref;
        this.fillOrder(o, fillPrice);
      }
    }
  }

  private fillOrder(order: PaperOrder, fillPrice: number): void {
    const st = useStore.getState();
    // Mark order filled
    const orders = st.paperOrders.map((o) =>
      o.id === order.id ? { ...o, status: "filled" as const, filledPrice: fillPrice, filledTs: Date.now() } : o);
    st.setPaperOrders(orders);

    // Apply to balance and positions
    const fee = order.qty * fillPrice * st.settings.paperTrading.feeRate;

    // Look up an existing position on the same symbol (any side) belonging to the same scope (bot or manual)
    const sameSide = st.paperPositions.find(
      (p) => p.symbol === order.symbol && p.side === order.side && p.botId === order.botId,
    );
    const opposite = st.paperPositions.find(
      (p) => p.symbol === order.symbol && p.side !== order.side && p.botId === order.botId,
    );

    if (opposite) {
      // Net out against opposite position
      const closingQty = Math.min(opposite.qty, order.qty);
      const direction = opposite.side === "buy" ? 1 : -1;
      const pnl = (fillPrice - opposite.entryPrice) * closingQty * direction - fee;

      // Realised pnl already carries the fee; margin is treated as 1:1, so the
      // notional legs cancel out and must not be added again.
      st.setPaperBalance(st.paperBalance + pnl);

      // Trade history
      const trade: PaperTrade = {
        id: uid("trd"),
        ts: Date.now(),
        entryTs: opposite.openedTs,
        symbol: order.symbol,
        side: opposite.side,
        entryPrice: opposite.entryPrice,
        exitPrice: fillPrice,
        qty: closingQty,
        pnl,
        botId: order.botId,
      };
      st.setPaperHistory([...st.paperHistory, trade]);

      const remainingQty = opposite.qty - closingQty;
      const positions = st.paperPositions
        .filter((p) => p.id !== opposite.id)
        .concat(remainingQty > 0 ? [{ ...opposite, qty: remainingQty }] : []);

      // Remainder of the incoming order opens new position in the order's direction
      const extra = order.qty - closingQty;
      if (extra > 0) {
        positions.push({
          id: uid("pos"),
          symbol: order.symbol,
          side: order.side,
          entryPrice: fillPrice,
          qty: extra,
          openedTs: Date.now(),
          botId: order.botId,
        });
      }
      st.setPaperPositions(positions);

      logOk("paper", `fill ${order.side} ${order.qty} ${order.symbol} @ ${fillPrice} — closed ${closingQty}, P&L ${pnl.toFixed(2)}`);
    } else if (sameSide) {
      // Average up/down: weighted entry
      const totalQty = sameSide.qty + order.qty;
      const newEntry = (sameSide.entryPrice * sameSide.qty + fillPrice * order.qty) / totalQty;
      const positions = st.paperPositions.map((p) =>
        p.id === sameSide.id ? { ...p, qty: totalQty, entryPrice: newEntry } : p);
      st.setPaperPositions(positions);
      st.setPaperBalance(st.paperBalance - fee);
      logOk("paper", `fill ${order.side} ${order.qty} ${order.symbol} @ ${fillPrice} — averaged into existing position`);
    } else {
      // Open new position
      const pos: PaperPosition = {
        id: uid("pos"),
        symbol: order.symbol,
        side: order.side,
        entryPrice: fillPrice,
        qty: order.qty,
        openedTs: Date.now(),
        botId: order.botId,
      };
      st.setPaperPositions([...st.paperPositions, pos]);
      st.setPaperBalance(st.paperBalance - fee);
      logOk("paper", `fill ${order.side} ${order.qty} ${order.symbol} @ ${fillPrice} — opened new ${order.side} position`);
    }

    // Notify bot manager
    bus.emit("bot", { ts: Date.now(), botId: order.botId ?? "", type: "order_filled", data: { orderId: order.id, price: fillPrice } });
  }
}

// Singleton
export const paperEngine = new PaperTradingEngine();

// Helper for reading a ticker safely
export function getTicker(symbol: string): Ticker | undefined {
  return useStore.getState().tickers[symbol];
}
