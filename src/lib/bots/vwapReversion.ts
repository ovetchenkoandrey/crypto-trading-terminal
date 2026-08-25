// VWAP reversion — fade an excursion away from the volume weighted average price
// during the low-liquidity session and exit on the return to it.
//
// The volume analogue of the Bollinger night strategy. Both measure "how far is
// price from where it belongs", but the reference differs: a moving average
// weighs every bar the same, VWAP weighs it by traded volume. A spike printed on
// an empty book moves the mean as much as a real flow does, yet barely moves
// VWAP — so the distance to VWAP grows for exactly the excursions that were not
// paid for. That is the filter this hypothesis is testing.
//
// Every decision is taken on a closed bar from `ctx.history`, which is cut at
// that bar, and the session window comes from the bar's own UTC timestamp rather
// than the machine clock. Entry is a market order filling at the next bar's
// open; the protective stop is placed first, so the first bar of a trade is
// already covered.
//
// VWAP is null when the window carried no volume. That is deliberate in
// `indicators/core.ts` — a plain average would look like VWAP and carry none of
// its information — so a null here means "no signal on this bar", never
// "fall back to the mean".

import type { BotConfig, Side } from "../store";
import type { VenueOrder, VenuePosition } from "../execution/types";
import type { Bot, BotContext, BotFactory } from "./base";
import type { Candle } from "../types";
import { atr, vwap } from "../indicators/core";
import { logInfo, logWarn } from "../eventBus";

const HOUR_SECONDS = 3600;
const DAY_SECONDS = 86400;
const DEFAULT_BAR_SECONDS = HOUR_SECONDS;
/** Bars of ATR warm-up kept in the window; Wilder seeding bias decays below 1e-4. */
const ATR_WARMUP_FACTOR = 10;
/** Hard cap on the bars pulled per snapshot, so a fine signal timeframe cannot
 *  turn a day-anchored VWAP into a quadratic run. */
const MAX_WINDOW_BARS = 2000;

export type VwapAnchor = "session" | "rolling";
export type ExitMode = "market" | "limit";
/**
 * Where the exit sits, i.e. what counts as "the excursion is over":
 *  - `vwap`    back at VWAP, optionally shifted by `exitBandMult` bands.
 *  - `partial` a fraction of the way from the entry price to VWAP.
 *  - `band`    the opposite VWAP band — a full reversal, not just a return.
 */
export type ExitRule = "vwap" | "partial" | "band";
export type StopMode = "atr" | "pct" | "band";

export interface VwapReversionParams {
  vwapAnchor: VwapAnchor;
  vwapPeriod: number;
  bandPeriod: number;
  entryBandMult: number;
  entryPct: number;
  sessionStartHour: number;
  sessionEndHour: number;
  requireReentry: boolean;
  allowLong: boolean;
  allowShort: boolean;
  exitMode: ExitMode;
  exitRule: ExitRule;
  exitBandMult: number;
  exitFraction: number;
  volPeriod: number;
  maxRelVolume: number;
  minRelVolume: number;
  stopMode: StopMode;
  stopAtrMult: number;
  stopPct: number;
  stopBandMult: number;
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
 * Whether a bar falls inside the window [startHour, endHour) in UTC. The window
 * wraps midnight when endHour <= startHour (22 -> 4 covers 22, 23, 0, 1, 2, 3).
 * start === end means no window filter at all.
 */
export function inSession(timeSec: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return true;
  const h = utcHour(timeSec);
  return startHour < endHour
    ? h >= startHour && h < endHour
    : h >= startHour || h < endHour;
}

/**
 * Dispersion of price around VWAP over the last `period` bars, as root mean
 * square rather than a standard deviation about the sample mean.
 *
 * VWAP is the reference the strategy trades against, so the deviation that
 * matters is the one measured from VWAP itself. Centring on the mean deviation
 * would quietly subtract any persistent offset — exactly the trend-day tilt an
 * excursion filter should still see.
 */
export function vwapBand(closes: readonly number[], vwaps: readonly (number | null)[], period: number): number | null {
  if (period <= 0) return null;
  const n = Math.min(closes.length, vwaps.length);
  let sum = 0;
  let count = 0;
  for (let i = n - 1; i >= 0 && count < period; i--) {
    const v = vwaps[i];
    if (v === null) continue;
    const d = closes[i] - v;
    sum += d * d;
    count += 1;
  }
  if (count < 2) return null;
  return Math.sqrt(sum / count);
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

export function parseVwapReversionParams(raw: Record<string, number | string>): VwapReversionParams {
  return {
    vwapAnchor:          oneOf(raw.vwapAnchor, ["session", "rolling"] as const, "session"),
    vwapPeriod:          Math.max(2, int(raw.vwapPeriod, 60)),
    bandPeriod:          Math.max(2, int(raw.bandPeriod, 40)),
    entryBandMult:       Math.max(0, num(raw.entryBandMult, 2)),
    entryPct:            Math.max(0, num(raw.entryPct, 0)),
    sessionStartHour:    hourParam(raw.sessionStartHour, 3),
    sessionEndHour:      hourParam(raw.sessionEndHour, 6),
    requireReentry:      flag(raw.requireReentry, false),
    allowLong:           flag(raw.allowLong, true),
    allowShort:          flag(raw.allowShort, true),
    exitMode:            oneOf(raw.exitMode, ["market", "limit"] as const, "market"),
    exitRule:            oneOf(raw.exitRule, ["vwap", "partial", "band"] as const, "vwap"),
    exitBandMult:        num(raw.exitBandMult, 0),
    exitFraction:        Math.min(1, Math.max(0, num(raw.exitFraction, 0.5))),
    volPeriod:           Math.max(2, int(raw.volPeriod, 40)),
    maxRelVolume:        Math.max(0, num(raw.maxRelVolume, 0)),
    minRelVolume:        Math.max(0, num(raw.minRelVolume, 0)),
    stopMode:            oneOf(raw.stopMode, ["atr", "pct", "band"] as const, "atr"),
    stopAtrMult:         Math.max(0, num(raw.stopAtrMult, 1.5)),
    stopPct:             Math.max(0, num(raw.stopPct, 0.8)),
    stopBandMult:        Math.max(0, num(raw.stopBandMult, 1)),
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
  vwap: number;
  band: number;
  /** Entry threshold distance from VWAP, in price units. */
  threshold: number;
  prevClose: number;
  prevVwap: number | null;
  prevThreshold: number | null;
  relVolume: number | null;
  atr: number | null;
}

interface SkipCounters {
  size: number;
  stop: number;
  novwap: number;
  volume: number;
}

class VwapReversionBot implements Bot {
  config: BotConfig;

  private readonly p: VwapReversionParams;
  private valid = true;

  private pendingEntryIds: string[] = [];
  private stopIds: string[] = [];
  private exitOrderId: string | null = null;
  private exitPrice: number | null = null;
  private exitQty = 0;
  private units = 0;
  private entryBar: number | null = null;

  private skips: SkipCounters = { size: 0, stop: 0, novwap: 0, volume: 0 };
  private entriesPlaced = 0;
  private sessionCloses = 0;

  constructor(config: BotConfig) {
    this.config = config;
    this.p = parseVwapReversionParams(config.params);
  }

  start(_ctx: BotContext): void {
    void _ctx;
    const p = this.p;
    if (!(p.entryBandMult > 0) && !(p.entryPct > 0)) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "entryBandMult or entryPct must be > 0 — a zero threshold fires on every bar");
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
      `vwap reversion started — ${p.vwapAnchor} VWAP, entry ${p.entryBandMult} band / ${p.entryPct}%, ` +
      `session ${p.sessionStartHour}:00-${p.sessionEndHour}:00 UTC, stop ${p.stopMode}, risk ${p.riskPct}%`,
    );
  }

  stop(ctx: BotContext): void {
    const cancelled = ctx.cancelAllOrders();
    this.reset();
    logInfo(
      `bot:${this.config.id}`,
      `vwap reversion stopped — entries ${this.entriesPlaced}, session closes ${this.sessionCloses}, ` +
      `skipped (size) ${this.skips.size}, (stop) ${this.skips.stop}, (no vwap) ${this.skips.novwap}, ` +
      `(volume) ${this.skips.volume}, cancelled ${cancelled}`,
    );
  }

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
    if (!sessionOpen && !position) return;

    const snap = this.snapshot(ctx, step);
    if (!snap) return;

    if (position && this.manageOpen(ctx, position, snap, index, bar)) return;
    if (!sessionOpen) return;
    this.tryEnter(ctx, snap, index, position);
  }

  // --- state ---------------------------------------------------------------

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
   * the brackets left behind. The venue scans every order it has ever seen to
   * answer `getPendingOrders`, so it is only asked while this bot actually has
   * orders working.
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

  /** Bar length inferred from timestamps already seen — says nothing about future prices. */
  private barSeconds(ctx: BotContext): number {
    const bars = ctx.history.last(4);
    let best = 0;
    for (let i = 1; i < bars.length; i++) {
      const d = bars[i].time - bars[i - 1].time;
      if (d > 0 && (best === 0 || d < best)) best = d;
    }
    return best > 0 ? best : DEFAULT_BAR_SECONDS;
  }

  // --- indicators ----------------------------------------------------------

  /**
   * How many bars have to be pulled for the VWAP to be anchored correctly.
   *
   * Session mode resets at UTC midnight, and `vwap` restarts its accumulation at
   * the first bar it is handed. Feeding it a short window would therefore anchor
   * the average somewhere in the middle of the night instead of at midnight, so
   * the window must reach back past the previous midnight.
   *
   * Rolling mode needs its own period AND the band period on top: the first
   * `vwapPeriod - 1` values of a rolling series are null, so a window of exactly
   * `vwapPeriod` bars yields a single usable point and no band at all.
   */
  private windowBars(step: number): number {
    const p = this.p;
    const need = p.vwapAnchor === "session"
      ? Math.floor(DAY_SECONDS / Math.max(1, step)) + 2
      : p.vwapPeriod + p.bandPeriod;
    return Math.min(MAX_WINDOW_BARS, Math.max(need, p.bandPeriod + 1, p.volPeriod + 1, 3));
  }

  /** VWAP, band and ATR as of the current bar, computed only from visible history. */
  private snapshot(ctx: BotContext, step: number): Snapshot | null {
    const p = this.p;
    const bars = ctx.history.last(this.windowBars(step));
    if (bars.length < Math.max(p.bandPeriod, 3)) return null;

    const series = p.vwapAnchor === "rolling"
      ? vwap(bars, { mode: "rolling", period: p.vwapPeriod })
      : vwap(bars, { mode: "session" });

    const i = bars.length - 1;
    const current = series[i];
    // Null means the window carried no volume at all. Skipped, never patched up
    // with a plain average — see the file header.
    if (current === null || !(current > 0)) {
      this.skips.novwap += 1;
      return null;
    }

    const closeSeries = bars.map((b) => b.close);
    const band = vwapBand(closeSeries, series, p.bandPeriod);
    const threshold = this.threshold(current, band);
    if (threshold === null || !(threshold > 0)) return null;

    const prevVwap = i > 0 ? series[i - 1] : null;
    const prevBand = i > 0 ? vwapBand(closeSeries.slice(0, i), series.slice(0, i), p.bandPeriod) : null;
    const prevThreshold = prevVwap !== null && prevVwap > 0 ? this.threshold(prevVwap, prevBand) : null;

    let relVolume: number | null = null;
    if (bars.length > p.volPeriod) {
      let sum = 0;
      for (let j = bars.length - 1 - p.volPeriod; j < bars.length - 1; j++) sum += bars[j].volume;
      const avg = sum / p.volPeriod;
      if (avg > 0) relVolume = bars[i].volume / avg;
    }

    const atrWindow = Math.max(p.atrPeriod * ATR_WARMUP_FACTOR, p.atrPeriod + 1);
    const atrBars = ctx.history.last(atrWindow);
    let atrValue: number | null = null;
    if (atrBars.length >= p.atrPeriod + 1) {
      const a = atr(atrBars, p.atrPeriod);
      atrValue = a[a.length - 1];
    }

    return {
      close: bars[i].close,
      vwap: current,
      band: band ?? 0,
      threshold,
      prevClose: bars[i - 1].close,
      prevVwap,
      prevThreshold,
      relVolume,
      atr: atrValue,
    };
  }

  /**
   * Entry distance from VWAP. `entryPct` is a floor under the band distance, so
   * a night that compresses the band to nothing cannot make every tick a signal;
   * with `entryBandMult` at zero it becomes the whole rule.
   */
  private threshold(vwapValue: number, band: number | null): number | null {
    const p = this.p;
    const fromBand = p.entryBandMult > 0 && band !== null && band > 0 ? band * p.entryBandMult : 0;
    const fromPct = p.entryPct > 0 ? vwapValue * (p.entryPct / 100) : 0;
    const t = Math.max(fromBand, fromPct);
    return t > 0 ? t : null;
  }

  // --- open position -------------------------------------------------------

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

    const target = this.exitTarget(position.side, position.entryPrice, snap);
    if (!(target > 0)) return false;

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

  private exitTarget(side: Side, entryPrice: number, snap: Snapshot): number {
    const p = this.p;
    const shift = p.exitBandMult * snap.band;
    const atVwap = side === "buy" ? snap.vwap - shift : snap.vwap + shift;
    switch (p.exitRule) {
      case "band":
        return side === "buy" ? snap.vwap + snap.threshold : snap.vwap - snap.threshold;
      case "partial": {
        if (!(entryPrice > 0)) return atVwap;
        return entryPrice + (atVwap - entryPrice) * p.exitFraction;
      }
      case "vwap":
      default:
        return atVwap;
    }
  }

  /** Re-prices the resting target: VWAP moves every bar, so the order follows it. */
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

  // --- entry ---------------------------------------------------------------

  private tryEnter(ctx: BotContext, snap: Snapshot, index: number, position: VenuePosition | null): void {
    const p = this.p;
    if (this.pendingEntryIds.length > 0) return;
    if (this.units >= p.maxOpenPositions) return;
    if (!this.volatilityOk(snap)) return;

    const side = this.signal(snap);
    if (side === null) return;
    if (side === "buy" && !p.allowLong) return;
    if (side === "sell" && !p.allowShort) return;
    if (!this.volumeOk(snap)) {
      this.skips.volume += 1;
      return;
    }
    // Never stack against an open position — the netting venue would flip the
    // whole trade instead of scaling in.
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

    // Protection first: the stop has to be resting before the entry fills at the
    // next bar's open, and a venue that refuses the stop means the trade is
    // dropped rather than run naked.
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

    if (p.exitMode === "limit") {
      const qtyAfter = (position?.qty ?? 0) + entry.qty;
      this.refreshExitLimit(ctx, side, qtyAfter, this.exitTarget(side, snap.close, snap));
    }
  }

  private signal(snap: Snapshot): Side | null {
    const p = this.p;
    const lower = snap.vwap - snap.threshold;
    const upper = snap.vwap + snap.threshold;

    if (!p.requireReentry) {
      if (snap.close <= lower) return "buy";
      if (snap.close >= upper) return "sell";
      return null;
    }
    // Confirmed bounce: the previous bar closed beyond the band and this one
    // closed back inside it, still short of VWAP.
    if (snap.prevVwap === null || snap.prevThreshold === null) return null;
    const prevLower = snap.prevVwap - snap.prevThreshold;
    const prevUpper = snap.prevVwap + snap.prevThreshold;
    if (snap.prevClose <= prevLower && snap.close > lower && snap.close < snap.vwap) return "buy";
    if (snap.prevClose >= prevUpper && snap.close < upper && snap.close > snap.vwap) return "sell";
    return null;
  }

  /**
   * The volume half of the hypothesis: an excursion printed on thin volume is
   * the one nobody paid for, so it is the one expected to come back. With both
   * bounds off the strategy is a pure VWAP-distance test, which is what the
   * diagnostic run measures before any filter is added.
   */
  private volumeOk(snap: Snapshot): boolean {
    const p = this.p;
    if (p.maxRelVolume <= 0 && p.minRelVolume <= 0) return true;
    if (snap.relVolume === null) return false;
    if (p.maxRelVolume > 0 && snap.relVolume > p.maxRelVolume) return false;
    if (p.minRelVolume > 0 && snap.relVolume < p.minRelVolume) return false;
    return true;
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
      case "pct":  return snap.close * (p.stopPct / 100);
      case "band": return snap.band * p.stopBandMult;
      case "atr":
      default:     return snap.atr === null ? 0 : snap.atr * p.stopAtrMult;
    }
  }

  /**
   * Size from risk: the fraction of equity lost if the stop is hit, divided by
   * the distance to it. Capped by notional leverage, then rounded DOWN to the
   * instrument step — below the exchange minimum the trade is skipped, never
   * rounded up into more risk than was asked for.
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

export const vwapReversionFactory: BotFactory = {
  kind: "vwap-mr",
  name: "Отклонение от VWAP с возвратом",
  defaultParams: {
    vwapAnchor: "session",
    vwapPeriod: 60,
    bandPeriod: 40,
    entryBandMult: 2,
    entryPct: 0,
    sessionStartHour: 3,
    sessionEndHour: 6,
    requireReentry: 0,
    allowLong: 1,
    allowShort: 1,
    exitMode: "market",
    exitRule: "vwap",
    exitBandMult: 0,
    exitFraction: 0.5,
    volPeriod: 40,
    maxRelVolume: 0,
    minRelVolume: 0,
    stopMode: "atr",
    stopAtrMult: 1.5,
    stopPct: 0.8,
    stopBandMult: 1,
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
    { key: "vwapAnchor",          label: "VWAP: session / rolling",         type: "string" },
    { key: "vwapPeriod",          label: "Окно VWAP (для rolling)",         type: "number", min: 2,  max: 1000, step: 1 },
    { key: "bandPeriod",          label: "Окно полосы отклонений",          type: "number", min: 2,  max: 1000, step: 1 },
    { key: "entryBandMult",       label: "Вход: полос отклонения",          type: "number", min: 0,  max: 6,    step: 0.1 },
    { key: "entryPct",            label: "Вход: мин. отклонение, % (0=выкл)", type: "number", min: 0, max: 10,  step: 0.01 },
    { key: "sessionStartHour",    label: "Начало сессии (час UTC)",         type: "number", min: 0,  max: 23,   step: 1 },
    { key: "sessionEndHour",      label: "Конец сессии (час UTC)",          type: "number", min: 0,  max: 23,   step: 1 },
    { key: "requireReentry",      label: "Ждать возврата в канал (0/1)",    type: "number", min: 0,  max: 1,    step: 1 },
    { key: "allowLong",           label: "Разрешить лонги (0/1)",           type: "number", min: 0,  max: 1,    step: 1 },
    { key: "allowShort",          label: "Разрешить шорты (0/1)",           type: "number", min: 0,  max: 1,    step: 1 },
    { key: "exitMode",            label: "Выход: market / limit",           type: "string" },
    { key: "exitRule",            label: "Цель: vwap / partial / band",     type: "string" },
    { key: "exitBandMult",        label: "Смещение цели, полос",            type: "number", min: -3, max: 3,    step: 0.1 },
    { key: "exitFraction",        label: "Доля пути до VWAP (partial)",     type: "number", min: 0,  max: 1,    step: 0.05 },
    { key: "volPeriod",           label: "Окно среднего объёма",            type: "number", min: 2,  max: 1000, step: 1 },
    { key: "maxRelVolume",        label: "Макс. объём бара / средний (0=выкл)", type: "number", min: 0, max: 10, step: 0.05 },
    { key: "minRelVolume",        label: "Мин. объём бара / средний (0=выкл)", type: "number", min: 0, max: 10, step: 0.05 },
    { key: "stopMode",            label: "Стоп: atr / pct / band",          type: "string" },
    { key: "stopAtrMult",         label: "Стоп, множитель ATR",             type: "number", min: 0,  max: 10,   step: 0.1 },
    { key: "stopPct",             label: "Стоп, % от цены",                 type: "number", min: 0,  max: 20,   step: 0.1 },
    { key: "stopBandMult",        label: "Стоп, множитель полосы",          type: "number", min: 0,  max: 10,   step: 0.1 },
    { key: "atrPeriod",           label: "Период ATR",                      type: "number", min: 1,  max: 200,  step: 1 },
    { key: "minAtrPct",           label: "Мин. ATR, % от цены (0=выкл)",    type: "number", min: 0,  max: 20,   step: 0.01 },
    { key: "maxAtrPct",           label: "Макс. ATR, % от цены (0=выкл)",   type: "number", min: 0,  max: 20,   step: 0.01 },
    { key: "riskPct",             label: "Риск на сделку, % депозита",      type: "number", min: 0,  max: 20,   step: 0.05 },
    { key: "maxLeverage",         label: "Макс. плечо по номиналу",         type: "number", min: 0,  max: 50,   step: 0.5 },
    { key: "minQty",              label: "Мин. лот инструмента",            type: "number", min: 0,  step: 0.001 },
    { key: "qtyStep",             label: "Шаг объёма",                      type: "number", min: 0,  step: 0.001 },
    { key: "maxOpenPositions",    label: "Макс. позиций одновременно",      type: "number", min: 1,  max: 10,   step: 1 },
    { key: "closeOutsideSession", label: "Закрывать в конце сессии (0/1)",  type: "number", min: 0,  max: 1,    step: 1 },
    { key: "maxBarsInTrade",      label: "Макс. баров в сделке (0=выкл)",   type: "number", min: 0,  max: 500,  step: 1 },
  ],
  create(config) {
    return new VwapReversionBot(config);
  },
};
