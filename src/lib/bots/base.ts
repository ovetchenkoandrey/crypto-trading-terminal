import type { BotConfig, PaperOrder, Ticker, Side, OrderType } from "../store";

export interface BotContext {
  placeOrder: (req: {
    symbol: string;
    side: Side;
    type: OrderType;
    price: number;
    qty: number;
  }) => PaperOrder;
  cancelOrder: (id: string, reason?: string) => void;
  cancelAllOrders: () => number;     // returns count cancelled
  getPendingOrders: () => PaperOrder[];
  getTicker: (symbol: string) => Ticker | undefined;
}

export interface Bot {
  config: BotConfig;
  start(ctx: BotContext): void;
  stop(ctx: BotContext): void;
  onOrderFilled(ctx: BotContext, order: PaperOrder, fillPrice: number): void;
}

export interface BotFactory {
  kind: string;
  name: string;
  defaultParams: Record<string, number | string>;
  paramSpec: { key: string; label: string; type: "number" | "string"; min?: number; max?: number; step?: number }[];
  create(config: BotConfig): Bot;
}
