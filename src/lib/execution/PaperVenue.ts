// PaperVenue — wraps the local matching engine behind the ExecutionVenue interface.
// All persistence still goes through the existing paper* slices in the Zustand store,
// so Terminal / overlay / scripts that read those slices keep working unchanged.

import { paperEngine, getTicker } from "../paper/engine";
import { useStore } from "../store";
import type {
  ExecutionVenue,
  PlaceOrderRequest,
  VenueBalance,
  VenueOrder,
  VenuePosition,
  VenueTrade,
} from "./types";
import type { Ticker } from "../store";

class PaperVenueImpl implements ExecutionVenue {
  readonly mode = "paper" as const;

  init(): void {
    paperEngine.init();
  }

  shutdown(): void {
    paperEngine.shutdown();
  }

  placeOrder(req: PlaceOrderRequest): VenueOrder {
    return paperEngine.placeOrder({
      symbol: req.symbol,
      side:   req.side,
      type:   req.type,
      price:  req.price,
      qty:    req.qty,
      botId:  req.botId,
    });
  }

  cancelOrder(id: string, reason?: string): void {
    paperEngine.cancelOrder(id, reason);
  }

  cancelOrdersByBot(botId: string): number {
    return paperEngine.cancelOrdersByBot(botId);
  }

  closePosition(positionId: string, atPrice?: number): void {
    paperEngine.closePosition(positionId, atPrice);
  }

  getOpenOrders(): VenueOrder[] {
    return useStore.getState().paperOrders.filter((o) => o.status === "pending");
  }

  getOpenPositions(): VenuePosition[] {
    return useStore.getState().paperPositions;
  }

  getHistory(): VenueTrade[] {
    return useStore.getState().paperHistory;
  }

  getBalance(): VenueBalance {
    const equity = useStore.getState().paperBalance;
    // Spot-style accounting: no margin reserved separately yet.
    return { equity, available: equity };
  }

  getTicker(symbol: string): Ticker | undefined {
    return getTicker(symbol);
  }
}

export const paperVenue = new PaperVenueImpl();
