// Night mean reversion — fade a Bollinger excursion during the low-liquidity
// session and exit once the excursion has settled.
//
// "Settled" has no single definition, so it is a parameter: `exitRule` picks
// between the moving average, the opposite band, a fixed percentage from the
// entry, and a fraction of the way back to the mean. `exitMode` is a separate
// axis — it says whether that price is taken at market on a bar close or left
// resting as a reduce-only limit.
//
// The strategy only acts inside `onBar`, so every decision is taken on a closed
// bar and every price it reads comes from `ctx.history`, which is cut at that
// bar. The trading window is derived from the bar's own UTC timestamp, never
// from the machine clock — otherwise a backtest would be filtered by the hour it
// happened to be launched at.
//
// Entry, stop and (in limit mode) target are placed together as a bracket on the
// signal bar. The entry is a market order, so it fills at the next bar's open;
// the stop is resting from that same bar, which is what keeps the first bar of a
// trade from being unprotected.

import type { BotConfig, Side } from "../store";
import type { VenueOrder, VenuePosition } from "../execution/types";
import type { Bot, BotContext, BotFactory } from "./base";
import type { Candle } from "../types";
import { atr, bollinger, stdev } from "../indicators/core";
import { logInfo, logWarn } from "../eventBus";

const HOUR_SECONDS = 3600;
const DEFAULT_BAR_SECONDS = HOUR_SECONDS;
/** Bars of ATR warm-up kept in the window; Wilder seeding bias decays below 1e-4. */
const ATR_WARMUP_FACTOR = 10;

/** How the exit is executed once its price is known. */
export type ExitMode = "market" | "limit";
/**
 * Where the exit sits. All four answer the same question — "has the excursion
 * settled?" — with a different definition of settled:
 *
 *  - `mean`    the moving average, optionally shifted by `exitSigma` sigmas.
 *              Settled = the price is back where the window says it belongs.
 *  - `band`    the opposite Bollinger line. Settled = the excursion has fully
 *              reversed and overshot the other way.
 *  - `pct`     a fixed percentage away from the entry. Settled = the bounce has
 *              paid a fixed amount, regardless of what the band does.
 *  - `partial` a fraction of the way from the entry to the `mean` target.
 *              Settled = most of the snap-back has happened; `exitFraction` 1
 *              is exactly `mean`.
 */
export type ExitRule = "mean" | "band" | "pct" | "partial";
export type StopMode = "atr" | "pct" | "sigma";

export interface NightMeanReversionParams {
  bbPeriod: number;
  bbMult: number;
  sessionStartHour: number;
  sessionEndHour: number;
  requireReentry: boolean;
  allowLong: boolean;
  allowShort: boolean;
  exitMode: ExitMode;
  exitRule: ExitRule;
  exitSigma: number;
  exitPct: number;
  exitFraction: number;
  stopMode: StopMode;
  stopAtrMult: number;
  stopPct: number;
  stopSigmaMult: number;
  atrPeriod: number;
  minAtrPct: number;
  maxAtrPct: number;
  riskPct: number;
  maxLeverage: number;
  minQty: number;
  qtyStep: number;
  maxOpenPositions: number;
  closeOutsideSession: boolean;
  maxBarsInTrade: number;
}

/** UTC hour of a candle timestamp (seconds), independent of the host timezone. */
export function utcHour(timeSec: number): number {
  return ((Math.floor(timeSec / HOUR_SECONDS) % 24) + 24) % 24;
}

/**
 * Whether a bar falls inside the trading window [startHour, endHour) in UTC.
 * The window wraps midnight when endHour <= startHour (22 → 4 covers 22, 23,
 * 0, 1, 2, 3). start === end means no window filter at all.
 */
export function inSession(timeSec: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return true;
  const h = utcHour(timeSec);
  return startHour < endHour
    ? h >= startHour && h < endHour
    : h >= startHour || h < endHour;
}

function num(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function int(v: unknown, fallback: number): number {
  return Math.floor(num(v, fallback));
}

function flag(v: unknown, fallback: boolean): boolean {
  if (v === undefined || v === null || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n !== 0 : String(v).trim().toLowerCase() === "true";
}

function hourParam(v: unknown, fallback: number): number {
  const n = int(v, fallback);
  return ((n % 24) + 24) % 24;
}

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = String(v ?? "").trim().toLowerCase();
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

/** Rounds down to the instrument size step. Never up: rounding up would silently
 *  take more risk than the caller asked for. */
export function quantiseDown(qty: number, step: number): number {
  if (!(qty > 0)) return 0;
  if (!(step > 0)) return qty;
  const units = Math.floor(qty / step + 1e-9);
  if (units <= 0) return 0;
  return Number((units * step).toFixed(12));
}

export function parseNightMrParams(raw: Record<string, number | string>): NightMeanReversionParams {
  return {
    bbPeriod:            Math.max(2, int(raw.bbPeriod, 20)),
    bbMult:              Math.max(0, num(raw.bbMult, 2)),
    sessionStartHour:    hourParam(raw.sessionStartHour, 3),
    sessionEndHour:      hourParam(raw.sessionEndHour, 6),
    requireReentry:      flag(raw.requireReentry, false),
    allowLong:           flag(raw.allowLong, true),
    allowShort:          flag(raw.allowShort, true),
    exitMode:            oneOf(raw.exitMode, ["market", "limit"] as const, "market"),
    exitRule:            oneOf(raw.exitRule, ["mean", "band", "pct", "partial"] as const, "mean"),
    exitSigma:           num(raw.exitSigma, 0),
    exitPct:             Math.max(0, num(raw.exitPct, 0.5)),
    // Clamped to (0, 1]: 0 would put the target on the entry itself and fire on
    // the first bar, above 1 would overshoot the mean — that is what `band` is.
    exitFraction:        Math.min(1, Math.max(0.01, num(raw.exitFraction, 0.5))),
    stopMode:            oneOf(raw.stopMode, ["atr", "pct", "sigma"] as const, "atr"),
    stopAtrMult:         Math.max(0, num(raw.stopAtrMult, 1.5)),
    stopPct:             Math.max(0, num(raw.stopPct, 0.8)),
    stopSigmaMult:       Math.max(0, num(raw.stopSigmaMult, 1)),
    atrPeriod:           Math.max(1, int(raw.atrPeriod, 14)),
    minAtrPct:           Math.max(0, num(raw.minAtrPct, 0)),
    maxAtrPct:           Math.max(0, num(raw.maxAtrPct, 0)),
    riskPct:             Math.max(0, num(raw.riskPct, 0.5)),
    maxLeverage:         Math.max(0, num(raw.maxLeverage, 5)),
    minQty:              Math.max(0, num(raw.minQty, 0.001)),
    qtyStep:             Math.max(0, num(raw.qtyStep, 0.001)),
    maxOpenPositions:    Math.max(1, int(raw.maxOpenPositions, 1)),
    closeOutsideSession: flag(raw.closeOutsideSession, true),
    maxBarsInTrade:      Math.max(0, int(raw.maxBarsInTrade, 0)),
  };
}

interface Snapshot {
  close: number;
  mid: number;
  upper: number;
  lower: number;
  sd: number;
  prevClose: number;
  prevUpper: number;
  prevLower: number;
  prevMid: number;
  atr: number | null;
}

interface SkipCounters {
  size: number;
  stop: number;
}

class NightMeanReversionBot implements Bot {
  config: BotConfig;

  private readonly p: NightMeanReversionParams;
  private valid = true;

  /** Entry orders awaiting a fill. */
  private pendingEntryIds: string[] = [];
  /** Resting protective stops, one per entry unit. */
  private stopIds: string[] = [];
  private exitOrderId: string | null = null;
  private exitPrice: number | null = null;
  private exitQty = 0;
  /** Entry units held or in flight — the cap for maxOpenPositions. */
  private units = 0;
  private entryBar: number | null = null;

  private skips: SkipCounters = { size: 0, stop: 0 };
  private entriesPlaced = 0;
  private sessionCloses = 0;

  constructor(config: BotConfig) {
    this.config = config;
    this.p = parseNightMrParams(config.params);
  }

  start(_ctx: BotContext): void {
    void _ctx;
    const p = this.p;
    if (!(p.bbMult > 0)) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "bbMult must be > 0 — bands would collapse onto the mean");
      return;
    }
    if (!(p.riskPct > 0)) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "riskPct must be > 0 — nothing to size a position from");
      return;
    }
    if (!p.allowLong && !p.allowShort) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "both directions disabled");
      return;
    }
    this.reset();
    logInfo(
      `bot:${this.config.id}`,
      `night MR started — BB(${p.bbPeriod}, ${p.bbMult}), session ${p.sessionStartHour}:00-${p.sessionEndHour}:00 UTC, ` +
      `stop ${p.stopMode}, risk ${p.riskPct}%`,
    );
  }

  stop(ctx: BotContext): void {
    const cancelled = ctx.cancelAllOrders();
    this.reset();
    logInfo(
      `bot:${this.config.id}`,
      `night MR stopped — entries ${this.entriesPlaced}, session closes ${this.sessionCloses}, ` +
      `skipped (size) ${this.skips.size}, skipped (stop) ${this.skips.stop}, cancelled ${cancelled}`,
    );
  }

  /** Stops and targets are bracketed at signal time, so a fill needs no follow-up. */
  onOrderFilled(_ctx: BotContext, _order: VenueOrder, _fillPrice: number): void {
    void _ctx; void _order; void _fillPrice;
  }

  onBar(ctx: BotContext, bar: Candle, index: number): void {
    if (!this.valid) return;
    this.reconcile(ctx);

    const p = this.p;
    const position = this.position(ctx);
    const step = this.barSeconds(ctx);
    // An entry decided on this bar fills at the next one, so both bars have to
    // sit inside the window for the trade to belong to the session.
    const sessionOpen =
      inSession(bar.time, p.sessionStartHour, p.sessionEndHour) &&
      inSession(bar.time + step, p.sessionStartHour, p.sessionEndHour);

    if (p.closeOutsideSession && !sessionOpen) {
      if (position || this.hasWorkingOrders()) {
        this.cancelWorking(ctx);
        if (position) {
          this.closeAtMarket(ctx, position, bar.close);
          this.sessionCloses += 1;
        }
      }
      return;
    }

    const snap = this.snapshot(ctx);
    if (!snap) return;

    if (position && this.manageOpen(ctx, position, snap, index, bar)) return;
    if (!sessionOpen) return;
    this.tryEnter(ctx, snap, index, position);
  }

  // ─── state ────────────────────────────────────────────────────────────────

  private reset(): void {
    this.pendingEntryIds = [];
    this.stopIds = [];
    this.exitOrderId = null;
    this.exitPrice = null;
    this.exitQty = 0;
    this.units = 0;
    this.entryBar = null;
  }

  private hasWorkingOrders(): boolean {
    return this.pendingEntryIds.length > 0 || this.stopIds.length > 0 || this.exitOrderId !== null;
  }

  /**
   * Drops order ids the venue no longer holds and, once genuinely flat, clears
   * the brackets left behind. Rebuilding from the venue each bar keeps the bot
   * from drifting out of sync when an order is rejected or a stop fires
   * intrabar.
   *
   * The venue scans every order it has ever seen to answer `getPendingOrders`,
   * so it is only asked while this bot actually has orders working — otherwise
   * an idle bot would make a long run quadratic in the number of bars.
   */
  private reconcile(ctx: BotContext): void {
    if (this.hasWorkingOrders()) {
      const pending = new Set(ctx.getPendingOrders().map((o) => o.id));
      this.pendingEntryIds = this.pendingEntryIds.filter((id) => pending.has(id));
      this.stopIds = this.stopIds.filter((id) => pending.has(id));
      if (this.exitOrderId !== null && !pending.has(this.exitOrderId)) {
        this.exitOrderId = null;
        this.exitPrice = null;
        this.exitQty = 0;
      }
    }

    if (this.position(ctx) !== null || this.pendingEntryIds.length > 0) return;

    for (const id of this.stopIds) ctx.cancelOrder(id, "flat");
    if (this.exitOrderId !== null) ctx.cancelOrder(this.exitOrderId, "flat");
    this.stopIds = [];
    this.exitOrderId = null;
    this.exitPrice = null;
    this.exitQty = 0;
    this.units = 0;
    this.entryBar = null;
  }

  private position(ctx: BotContext): VenuePosition | null {
    return ctx.getPositions().find((p) => p.symbol === this.config.symbol && p.qty > 0) ?? null;
  }

  /**
   * Bar length inferred from the timestamps already seen. Reading the cadence of
   * past bars is not look-ahead — it says nothing about future prices — and it
   * is what lets the bot recognise the last bar of a session.
   */
  private barSeconds(ctx: BotContext): number {
    const bars = ctx.history.last(4);
    let best = 0;
    for (let i = 1; i < bars.length; i++) {
      const d = bars[i].time - bars[i - 1].time;
      if (d > 0 && (best === 0 || d < best)) best = d;
    }
    return best > 0 ? best : DEFAULT_BAR_SECONDS;
  }

  // ─── indicators ───────────────────────────────────────────────────────────

  /** Bands and ATR as of the current bar, computed only from visible history. */
  private snapshot(ctx: BotContext): Snapshot | null {
    const p = this.p;
    const need = p.bbPeriod + 1;
    const closes = ctx.history.closes(need);
    if (closes.length < need) return null;

    const bands = bollinger(closes, p.bbPeriod, p.bbMult);
    const sd = stdev(closes, p.bbPeriod);
    const i = closes.length - 1;
    const mid = bands.mid[i];
    const upper = bands.upper[i];
    const lower = bands.lower[i];
    const dev = sd[i];
    const prevMid = bands.mid[i - 1];
    const prevUpper = bands.upper[i - 1];
    const prevLower = bands.lower[i - 1];
    if (mid === null || upper === null || lower === null || dev === null) return null;
    if (prevMid === null || prevUpper === null || prevLower === null) return null;

    const window = Math.max(p.atrPeriod * ATR_WARMUP_FACTOR, p.atrPeriod + 1);
    const bars = ctx.history.last(window);
    let atrValue: number | null = null;
    if (bars.length >= p.atrPeriod + 1) {
      const series = atr(bars, p.atrPeriod);
      atrValue = series[series.length - 1];
    }

    return {
      close: closes[i],
      mid,
      upper,
      lower,
      sd: dev,
      prevClose: closes[i - 1],
      prevMid,
      prevUpper,
      prevLower,
      atr: atrValue,
    };
  }

  // ─── open position ────────────────────────────────────────────────────────

  /** Returns true when the position was flattened on this bar. */
  private manageOpen(
    ctx: BotContext,
    position: VenuePosition,
    snap: Snapshot,
    index: number,
    bar: Candle,
  ): boolean {
    const p = this.p;

    if (p.maxBarsInTrade > 0 && this.entryBar !== null && index - this.entryBar >= p.maxBarsInTrade) {
      this.cancelWorking(ctx);
      this.closeAtMarket(ctx, position, bar.close);
      return true;
    }

    const target = this.exitTarget(position.side, snap, position.entryPrice);

    if (p.exitMode === "market") {
      const reached = position.side === "buy" ? snap.close >= target : snap.close <= target;
      if (!reached) return false;
      this.cancelWorking(ctx);
      this.closeAtMarket(ctx, position, bar.close);
      return true;
    }

    this.refreshExitLimit(ctx, position.side, position.qty, target);
    return false;
  }

  /**
   * Price at which the excursion counts as settled. `anchor` is where the trade
   * was entered — the entry price once a position exists, the signal close while
   * the entry is still in flight. Only `pct` and `partial` read it; the other
   * two are defined by the bands alone and follow them as they move.
   */
  private exitTarget(side: Side, snap: Snapshot, anchor: number): number {
    const p = this.p;
    switch (p.exitRule) {
      case "band":
        return side === "buy" ? snap.upper : snap.lower;
      case "pct": {
        const k = p.exitPct / 100;
        return side === "buy" ? anchor * (1 + k) : anchor * (1 - k);
      }
      case "partial": {
        const mean = this.meanTarget(side, snap);
        return anchor + p.exitFraction * (mean - anchor);
      }
      case "mean":
      default:
        return this.meanTarget(side, snap);
    }
  }

  /** True when the exit price is measured from the entry rather than the bands. */
  private anchoredExit(): boolean {
    return this.p.exitRule === "pct" || this.p.exitRule === "partial";
  }

  /** The moving average, shifted by `exitSigma` bands toward the entry side. */
  private meanTarget(side: Side, snap: Snapshot): number {
    const shift = this.p.exitSigma * snap.sd;
    return side === "buy" ? snap.mid - shift : snap.mid + shift;
  }

  /** Re-prices the resting target: the mean moves every bar, so the order follows it. */
  private refreshExitLimit(ctx: BotContext, side: Side, qty: number, target: number): void {
    if (!(target > 0) || !(qty > 0)) return;
    if (this.exitOrderId !== null && this.exitPrice === target && this.exitQty === qty) return;
    if (this.exitOrderId !== null) ctx.cancelOrder(this.exitOrderId, "retarget");

    const order = ctx.placeOrder({
      symbol: this.config.symbol,
      side: side === "buy" ? "sell" : "buy",
      type: "limit",
      price: target,
      qty,
      reduceOnly: true,
    });
    if (order.status === "pending") {
      this.exitOrderId = order.id;
      this.exitPrice = target;
      this.exitQty = qty;
    } else {
      this.exitOrderId = null;
      this.exitPrice = null;
      this.exitQty = 0;
    }
  }

  private closeAtMarket(ctx: BotContext, position: VenuePosition, refPrice: number): void {
    ctx.placeOrder({
      symbol: this.config.symbol,
      side: position.side === "buy" ? "sell" : "buy",
      type: "market",
      price: refPrice,
      qty: position.qty,
      reduceOnly: true,
    });
  }

  private cancelWorking(ctx: BotContext): void {
    ctx.cancelAllOrders();
    this.pendingEntryIds = [];
    this.stopIds = [];
    this.exitOrderId = null;
    this.exitPrice = null;
    this.exitQty = 0;
  }

  // ─── entry ────────────────────────────────────────────────────────────────

  private tryEnter(ctx: BotContext, snap: Snapshot, index: number, position: VenuePosition | null): void {
    const p = this.p;
    if (this.pendingEntryIds.length > 0) return;
    if (this.units >= p.maxOpenPositions) return;
    if (!this.volatilityOk(snap)) return;

    const side = this.signal(snap);
    if (side === null) return;
    if (side === "buy" && !p.allowLong) return;
    if (side === "sell" && !p.allowShort) return;
    // Never stack against an open position — that would be a reversal, not a
    // scale-in, and the netting venue would silently flip the whole trade.
    if (position && position.side !== side) return;

    const distance = this.stopDistance(snap);
    if (!(distance > 0)) {
      this.skips.stop += 1;
      return;
    }
    const stopPrice = side === "buy" ? snap.close - distance : snap.close + distance;
    if (!(stopPrice > 0)) {
      this.skips.stop += 1;
      return;
    }

    const qty = this.positionSize(ctx, snap.close, distance);
    if (qty <= 0) {
      this.skips.size += 1;
      return;
    }

    // Protection goes in first, so it is already resting when the entry fills at
    // the next bar's open — a stop sent after the fill would leave the first bar
    // of the trade uncovered. If the venue will not take the stop, the trade is
    // dropped rather than run naked: the whole point of the stop is that an
    // excursion can be the start of a trend instead of noise.
    const stop = ctx.placeOrder({
      symbol: this.config.symbol,
      side: side === "buy" ? "sell" : "buy",
      type: "stop",
      price: stopPrice,
      qty,
      reduceOnly: true,
    });
    if (stop.status !== "pending") {
      this.skips.stop += 1;
      return;
    }

    const entry = ctx.placeOrder({
      symbol: this.config.symbol,
      side,
      type: "market",
      price: snap.close,
      qty,
    });
    if (entry.status !== "pending") {
      ctx.cancelOrder(stop.id, "entry rejected");
      this.skips.size += 1;
      return;
    }

    this.stopIds.push(stop.id);
    this.pendingEntryIds.push(entry.id);
    this.units += 1;
    this.entriesPlaced += 1;
    if (this.entryBar === null) this.entryBar = index;

    // A band-derived target is known before the fill, so the limit can rest from
    // the same bar as the stop. `pct` and `partial` measure from the entry price,
    // which the market order will not settle until the next bar's open — pricing
    // them off the signal close would put the order somewhere the parameter never
    // asked for. Those two wait for `manageOpen` to see the real entry.
    if (p.exitMode === "limit" && !this.anchoredExit()) {
      this.refreshExitLimit(ctx, side, (position?.qty ?? 0) + entry.qty, this.exitTarget(side, snap, snap.close));
    }
  }

  private signal(snap: Snapshot): Side | null {
    const p = this.p;
    // Zero dispersion collapses the bands onto the mean and would fire both
    // directions at once on any flat stretch.
    if (!(snap.sd > 0)) return null;

    if (!p.requireReentry) {
      if (snap.close <= snap.lower) return "buy";
      if (snap.close >= snap.upper) return "sell";
      return null;
    }
    // Confirmed bounce: the previous bar closed outside the band and this one
    // closed back inside it, still short of the mean. The previous band must be
    // a real band — a flat stretch collapses it and would confirm everything.
    if (!(snap.prevUpper > snap.prevLower)) return null;
    if (snap.prevClose <= snap.prevLower && snap.close > snap.lower && snap.close < snap.mid) return "buy";
    if (snap.prevClose >= snap.prevUpper && snap.close < snap.upper && snap.close > snap.mid) return "sell";
    return null;
  }

  private volatilityOk(snap: Snapshot): boolean {
    const p = this.p;
    if (p.minAtrPct <= 0 && p.maxAtrPct <= 0) return true;
    if (snap.atr === null || !(snap.close > 0)) return false;
    const pct = (snap.atr / snap.close) * 100;
    if (p.minAtrPct > 0 && pct < p.minAtrPct) return false;
    if (p.maxAtrPct > 0 && pct > p.maxAtrPct) return false;
    return true;
  }

  private stopDistance(snap: Snapshot): number {
    const p = this.p;
    switch (p.stopMode) {
      case "pct":   return snap.close * (p.stopPct / 100);
      case "sigma": return snap.sd * p.stopSigmaMult;
      case "atr":
      default:      return snap.atr === null ? 0 : snap.atr * p.stopAtrMult;
    }
  }

  /**
   * Size from risk: the fraction of equity lost if the stop is hit, divided by
   * the distance to it. Capped by notional leverage, then rounded DOWN to the
   * instrument step — a size that lands below the exchange minimum means the
   * trade is skipped, never rounded up into more risk than was asked for.
   */
  private positionSize(ctx: BotContext, refPrice: number, distance: number): number {
    const p = this.p;
    const equity = ctx.getBalance().equity;
    if (!(equity > 0) || !(refPrice > 0) || !(distance > 0)) return 0;

    const risk = equity * (p.riskPct / 100);
    if (!(risk > 0)) return 0;

    let qty = risk / distance;
    if (p.maxLeverage > 0) qty = Math.min(qty, (equity * p.maxLeverage) / refPrice);
    qty = quantiseDown(qty, p.qtyStep);
    if (qty + 1e-12 < p.minQty) return 0;
    return qty;
  }
}

export const nightMeanReversionFactory: BotFactory = {
  kind: "night-mr",
  name: "Ночной mean reversion",
  defaultParams: {
    bbPeriod: 20,
    bbMult: 2,
    sessionStartHour: 3,
    sessionEndHour: 6,
    requireReentry: 0,
    allowLong: 1,
    allowShort: 1,
    exitMode: "market",
    exitRule: "mean",
    exitSigma: 0,
    exitPct: 0.5,
    exitFraction: 0.5,
    stopMode: "atr",
    stopAtrMult: 1.5,
    stopPct: 0.8,
    stopSigmaMult: 1,
    atrPeriod: 14,
    minAtrPct: 0,
    maxAtrPct: 0,
    riskPct: 0.5,
    maxLeverage: 5,
    minQty: 0.001,
    qtyStep: 0.001,
    maxOpenPositions: 1,
    closeOutsideSession: 1,
    maxBarsInTrade: 0,
  },
  paramSpec: [
    { key: "bbPeriod",            label: "Период Bollinger",              type: "number", min: 2,  max: 400, step: 1 },
    { key: "bbMult",              label: "Отклонений для входа",          type: "number", min: 0.1, max: 6,  step: 0.1 },
    { key: "sessionStartHour",    label: "Начало сессии (час UTC)",       type: "number", min: 0,  max: 23,  step: 1 },
    { key: "sessionEndHour",      label: "Конец сессии (час UTC)",        type: "number", min: 0,  max: 23,  step: 1 },
    { key: "requireReentry",      label: "Ждать возврата в канал (0/1)",  type: "number", min: 0,  max: 1,   step: 1 },
    { key: "allowLong",           label: "Разрешить лонги (0/1)",         type: "number", min: 0,  max: 1,   step: 1 },
    { key: "allowShort",          label: "Разрешить шорты (0/1)",         type: "number", min: 0,  max: 1,   step: 1 },
    { key: "exitMode",            label: "Выход: market / limit",         type: "string" },
    { key: "exitRule",            label: "Цель: mean / band / pct / partial", type: "string" },
    { key: "exitSigma",           label: "Смещение цели, сигм",           type: "number", min: -3, max: 3,   step: 0.1 },
    { key: "exitPct",             label: "Цель pct, % от входа",          type: "number", min: 0,  max: 20,  step: 0.05 },
    { key: "exitFraction",        label: "Цель partial, доля пути к средней", type: "number", min: 0.01, max: 1, step: 0.05 },
    { key: "stopMode",            label: "Стоп: atr / pct / sigma",       type: "string" },
    { key: "stopAtrMult",         label: "Стоп, множитель ATR",           type: "number", min: 0,  max: 10,  step: 0.1 },
    { key: "stopPct",             label: "Стоп, % от цены",               type: "number", min: 0,  max: 20,  step: 0.1 },
    { key: "stopSigmaMult",       label: "Стоп, множитель сигмы",         type: "number", min: 0,  max: 10,  step: 0.1 },
    { key: "atrPeriod",           label: "Период ATR",                    type: "number", min: 1,  max: 200, step: 1 },
    { key: "minAtrPct",           label: "Мин. ATR, % от цены (0=выкл)",  type: "number", min: 0,  max: 20,  step: 0.01 },
    { key: "maxAtrPct",           label: "Макс. ATR, % от цены (0=выкл)", type: "number", min: 0,  max: 20,  step: 0.01 },
    { key: "riskPct",             label: "Риск на сделку, % депозита",    type: "number", min: 0,  max: 20,  step: 0.05 },
    { key: "maxLeverage",         label: "Макс. плечо по номиналу",       type: "number", min: 0,  max: 50,  step: 0.5 },
    { key: "minQty",              label: "Мин. лот инструмента",          type: "number", min: 0,  step: 0.001 },
    { key: "qtyStep",             label: "Шаг объёма",                    type: "number", min: 0,  step: 0.001 },
    { key: "maxOpenPositions",    label: "Макс. позиций одновременно",    type: "number", min: 1,  max: 10,  step: 1 },
    { key: "closeOutsideSession", label: "Закрывать в конце сессии (0/1)", type: "number", min: 0, max: 1,   step: 1 },
    { key: "maxBarsInTrade",      label: "Макс. баров в сделке (0=выкл)", type: "number", min: 0,  max: 500, step: 1 },
  ],
  create(config) {
    return new NightMeanReversionBot(config);
  },
};
