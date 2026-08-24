// Abstraction layer over the actual execution backend (paper / demo / live / backtest).
// Boots/scripts/UI must talk only through this interface — never to a concrete venue.
//
// Stage 1: PaperVenue is the only real implementation. Demo/Live/Backtest will plug in
// later without changing callers.

import type {
  PaperOrder,
  PaperPosition,
  PaperTrade,
  Side,
  OrderType,
  Ticker,
} from "../store";

export type VenueMode = "paper" | "demo" | "live" | "backtest";

// For Stage 1 we re-use the existing paper types so bots and UI keep working unchanged.
// In later stages these can evolve into venue-specific shapes if needed.
export type VenueOrder    = PaperOrder;
export type VenuePosition = PaperPosition;
export type VenueTrade    = PaperTrade;

export interface PlaceOrderRequest {
  symbol: string;
  side:   Side;
  type:   OrderType;
  price:  number;       // for market this is reference/last price; matching engine may override with slippage
  qty:    number;
  botId?: string;       // attribution — survives across venues
  clientId?: string;    // optional caller-side id for matching async fills
  /**
   * Never opens or flips a position — the fill is capped at what is open and
   * the order is dropped when nothing is. Required for stop-loss and
   * take-profit: without it a bar touching both leaves one of them to open a
   * fresh position in the opposite direction that nobody asked for.
   */
  reduceOnly?: boolean;
}

export interface VenueBalance {
  equity:    number;    // total account value in USDT
  available: number;    // free for new orders
}

export interface ExecutionVenue {
  readonly mode: VenueMode;

  /** Set up subscriptions / connections. Called once on app start (or on switch). */
  init(): void;
  /** Tear down subscriptions / connections. */
  shutdown(): void;

  /* ───────── mutations ───────── */
  placeOrder(req: PlaceOrderRequest): VenueOrder;
  cancelOrder(id: string, reason?: string): void;
  cancelOrdersByBot(botId: string): number;
  closePosition(positionId: string, atPrice?: number): void;

  /* ───────── snapshots ───────── */
  getOpenOrders(): VenueOrder[];
  getOpenPositions(): VenuePosition[];
  getHistory(): VenueTrade[];
  getBalance(): VenueBalance;
  getTicker(symbol: string): Ticker | undefined;
}
