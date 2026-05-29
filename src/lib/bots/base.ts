import type { BotConfig, Ticker, Side, OrderType } from "../store";
import type { VenueOrder } from "../execution/types";

// Bot context is intentionally agnostic of which ExecutionVenue is behind it —
// the BotManager wires the active venue in. Bots only see VenueOrder shapes.
export interface BotContext {
  placeOrder: (req: {
    symbol: string;
    side: Side;
    type: OrderType;
    price: number;
    qty: number;
  }) => VenueOrder;
  cancelOrder: (id: string, reason?: string) => void;
  cancelAllOrders: () => number;     // returns count cancelled
  getPendingOrders: () => VenueOrder[];
  getTicker: (symbol: string) => Ticker | undefined;
}

export interface Bot {
  config: BotConfig;
  start(ctx: BotContext): void;
  stop(ctx: BotContext): void;
  onOrderFilled(ctx: BotContext, order: VenueOrder, fillPrice: number): void;
}

export interface BotFactory {
  kind: string;
  name: string;
  defaultParams: Record<string, number | string>;
  paramSpec: { key: string; label: string; type: "number" | "string"; min?: number; max?: number; step?: number }[];
  create(config: BotConfig): Bot;
}
