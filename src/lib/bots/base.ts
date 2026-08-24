import type { BotConfig, Ticker, Side, OrderType } from "../store";
import type { VenueOrder, VenuePosition, VenueTrade, VenueBalance } from "../execution/types";
import type { Candle } from "../types";
import type { BarHistory } from "./history";

// Bot context is intentionally agnostic of which ExecutionVenue is behind it —
// the BotManager wires the active venue in. Bots only see VenueOrder shapes.
export interface BotContext {
  placeOrder: (req: {
    symbol: string;
    side: Side;
    type: OrderType;
    price: number;
    qty: number;
    /** Caps the fill at the open position and never flips — for stops and targets. */
    reduceOnly?: boolean;
  }) => VenueOrder;
  cancelOrder: (id: string, reason?: string) => void;
  cancelAllOrders: () => number;     // returns count cancelled
  getPendingOrders: () => VenueOrder[];
  getTicker: (symbol: string) => Ticker | undefined;

  /** Bars up to and including the one being processed — never beyond it. */
  history: BarHistory;
  getPositions: () => VenuePosition[];
  getBalance: () => VenueBalance;
  getTrades: () => VenueTrade[];
  /** Epoch ms of the current bar in a backtest, wall clock when live. */
  now: () => number;
}

export interface Bot {
  config: BotConfig;
  start(ctx: BotContext): void;
  stop(ctx: BotContext): void;
  onOrderFilled(ctx: BotContext, order: VenueOrder, fillPrice: number): void;
  /**
   * Called once per closed bar, after that bar's orders have been matched.
   * Optional: event-driven bots (grid, DCA) do not need it.
   *
   * A market order placed here fills at the NEXT bar's open, never at this
   * bar's close — the close is already known when this runs, so filling at it
   * would be trading on information the strategy could not have acted on.
   */
  onBar?(ctx: BotContext, bar: Candle, index: number): void;
}

export interface BotFactory {
  kind: string;
  name: string;
  defaultParams: Record<string, number | string>;
  paramSpec: { key: string; label: string; type: "number" | "string"; min?: number; max?: number; step?: number }[];
  create(config: BotConfig): Bot;
}
