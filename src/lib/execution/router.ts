// VenueRouter — singleton that holds the currently-active ExecutionVenue and proxies
// all calls. Switching venues is a single point of change for the whole app.
//
// Stage 1: only "paper" is wired. Demo/Live/Backtest are placeholders that throw
// when activated — they'll get real implementations in later stages.

import { paperVenue } from "./PaperVenue";
import type {
  ExecutionVenue,
  PlaceOrderRequest,
  VenueBalance,
  VenueMode,
  VenueOrder,
  VenuePosition,
  VenueTrade,
} from "./types";
import type { Ticker } from "../store";
import { logInfo, logWarn } from "../eventBus";

function notImplemented(mode: VenueMode): ExecutionVenue {
  const stub: ExecutionVenue = {
    mode,
    init()     { logWarn("venue", `${mode} venue is not implemented yet`); },
    shutdown() { /* no-op */ },
    placeOrder()       { throw new Error(`venue:${mode} not implemented`); },
    cancelOrder()      { throw new Error(`venue:${mode} not implemented`); },
    cancelOrdersByBot() { return 0; },
    closePosition()    { throw new Error(`venue:${mode} not implemented`); },
    getOpenOrders()    { return []; },
    getOpenPositions() { return []; },
    getHistory()       { return []; },
    getBalance(): VenueBalance { return { equity: 0, available: 0 }; },
    getTicker()        { return undefined; },
  };
  return stub;
}

class VenueRouter implements ExecutionVenue {
  private venues: Record<VenueMode, ExecutionVenue> = {
    paper:    paperVenue,
    demo:     notImplemented("demo"),
    live:     notImplemented("live"),
    backtest: notImplemented("backtest"),
  };
  private current: VenueMode = "paper";

  get mode(): VenueMode { return this.current; }
  get active(): ExecutionVenue { return this.venues[this.current]; }

  switchMode(next: VenueMode): void {
    if (next === this.current) return;
    logInfo("venue", `switching ${this.current} → ${next}`);
    this.venues[this.current].shutdown();
    this.current = next;
    this.venues[this.current].init();
  }

  /** Plug a real implementation in place of the placeholder. */
  register(mode: VenueMode, impl: ExecutionVenue): void {
    this.venues[mode] = impl;
  }

  init()     { this.active.init(); }
  shutdown() { this.active.shutdown(); }

  placeOrder(req: PlaceOrderRequest): VenueOrder         { return this.active.placeOrder(req); }
  cancelOrder(id: string, reason?: string): void         { this.active.cancelOrder(id, reason); }
  cancelOrdersByBot(botId: string): number               { return this.active.cancelOrdersByBot(botId); }
  closePosition(positionId: string, atPrice?: number): void { this.active.closePosition(positionId, atPrice); }

  getOpenOrders(): VenueOrder[]        { return this.active.getOpenOrders(); }
  getOpenPositions(): VenuePosition[]  { return this.active.getOpenPositions(); }
  getHistory(): VenueTrade[]           { return this.active.getHistory(); }
  getBalance(): VenueBalance           { return this.active.getBalance(); }
  getTicker(symbol: string): Ticker | undefined { return this.active.getTicker(symbol); }
}

export const venue = new VenueRouter();
