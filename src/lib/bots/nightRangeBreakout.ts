// Night range breakout — measure the box price built during the quiet hours and
// trade the exit from it when the active session starts.
//
// The mirror image of the night mean-reversion hypothesis: there the bet is that
// an excursion out of the quiet-hours range comes back, here that it keeps
// going. Both are run on the same bars on purpose. If one of them pays and the
// other does not, the night session has a direction to it; if neither does,
// there is no exploitable structure in those hours and both ideas die together.
//
// The range is accumulated bar by bar while the clock is inside the range
// window and frozen the moment it leaves — nothing is ever read from a bar the
// strategy has not lived through. Hours come from the bar's own UTC timestamp,
// never from the machine clock. Entry is a market order filling at the next
// bar's open, with the protective stop placed first so the first bar of the
// trade is already covered.

import type { BotConfig, Side } from "../store";
import type { VenueOrder, VenuePosition } from "../execution/types";
import type { Bot, BotContext, BotFactory } from "./base";
import type { Candle } from "../types";
import { atr } from "../indicators/core";
import { logInfo, logWarn } from "../eventBus";

const HOUR_SECONDS = 3600;
const DEFAULT_BAR_SECONDS = HOUR_SECONDS;
/** Bars of ATR warm-up kept in the window; Wilder seeding bias decays below 1e-4. */
const ATR_WARMUP_FACTOR = 10;

export type TriggerMode = "close" | "wick";
export type StopMode = "opposite" | "fraction" | "atr" | "pct";
export type TargetMode = "none" | "r" | "range";

export interface NightRangeBreakoutParams {
  rangeStartHour: number;
  rangeEndHour: number;
  tradeStartHour: number;
  tradeEndHour: number;
  minRangeBars: number;
  minRangePct: number;
  maxRangePct: number;
  maxRangeAtrMult: number;
  breakoutBufferPct: number;
  triggerMode: TriggerMode;
  allowLong: boolean;
  allowShort: boolean;
  stopMode: StopMode;
  stopFraction: number;
  stopAtrMult: number;
  stopPct: number;
  targetMode: TargetMode;
  targetR: number;
  targetRangeMult: number;
  atrPeriod: number;
  riskPct: number;
  maxLeverage: number;
  minQty: number;
  qtyStep: number;
  maxEntriesPerRange: number;
  flattenAtEnd: boolean;
  maxBarsInTrade: number;
}

/** UTC hour of a candle timestamp (seconds), independent of the host timezone. */
export function utcHour(timeSec: number): number {
  return ((Math.floor(timeSec / HOUR_SECONDS) % 24) + 24) % 24;
}

/**
 * Whether a bar falls inside the window [startHour, endHour) in UTC. The window
 * wraps midnight when endHour <= startHour (22 -> 4 covers 22, 23, 0, 1, 2, 3).
 * start === end means the whole day.
 */
export function inWindow(timeSec: number, startHour: number, endHour: number): boolean {
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

export function parseNightRangeParams(raw: Record<string, number | string>): NightRangeBreakoutParams {
  return {
    rangeStartHour:     hourParam(raw.rangeStartHour, 0),
    rangeEndHour:       hourParam(raw.rangeEndHour, 6),
    tradeStartHour:     hourParam(raw.tradeStartHour, 6),
    tradeEndHour:       hourParam(raw.tradeEndHour, 14),
    minRangeBars:       Math.max(0, int(raw.minRangeBars, 0)),
    minRangePct:        Math.max(0, num(raw.minRangePct, 0)),
    maxRangePct:        Math.max(0, num(raw.maxRangePct, 0)),
    maxRangeAtrMult:    Math.max(0, num(raw.maxRangeAtrMult, 0)),
    breakoutBufferPct:  Math.max(0, num(raw.breakoutBufferPct, 0)),
    triggerMode:        oneOf(raw.triggerMode, ["close", "wick"] as const, "close"),
    allowLong:          flag(raw.allowLong, true),
    allowShort:         flag(raw.allowShort, true),
    stopMode:           oneOf(raw.stopMode, ["opposite", "fraction", "atr", "pct"] as const, "opposite"),
    stopFraction:       Math.max(0, num(raw.stopFraction, 0.5)),
    stopAtrMult:        Math.max(0, num(raw.stopAtrMult, 1.5)),
    stopPct:            Math.max(0, num(raw.stopPct, 0.8)),
    targetMode:         oneOf(raw.targetMode, ["none", "r", "range"] as const, "r"),
    targetR:            Math.max(0, num(raw.targetR, 1.5)),
    targetRangeMult:    Math.max(0, num(raw.targetRangeMult, 1)),
    atrPeriod:          Math.max(1, int(raw.atrPeriod, 14)),
    riskPct:            Math.max(0, num(raw.riskPct, 0.5)),
    maxLeverage:        Math.max(0, num(raw.maxLeverage, 5)),
    minQty:             Math.max(0, num(raw.minQty, 0.001)),
    qtyStep:            Math.max(0, num(raw.qtyStep, 0.001)),
    maxEntriesPerRange: Math.max(1, int(raw.maxEntriesPerRange, 1)),
    flattenAtEnd:       flag(raw.flattenAtEnd, true),
    maxBarsInTrade:     Math.max(0, int(raw.maxBarsInTrade, 0)),
  };
}

export interface NightRange {
  high: number;
  low: number;
  height: number;
  mid: number;
  bars: number;
  /** Timestamp of the last bar that fed the range. */
  closedAt: number;
}

interface SkipCounters {
  size: number;
  stop: number;
  narrow: number;
}

class NightRangeBreakoutBot implements Bot {
  config: BotConfig;

  private readonly p: NightRangeBreakoutParams;
  private valid = true;

  private pendingEntryIds: string[] = [];
  private stopIds: string[] = [];
  private targetIds: string[] = [];
  private entryBar: number | null = null;

  /** Range under construction — only bars already seen feed it. */
  private building = false;
  private curHigh = 0;
  private curLow = 0;
  private curBars = 0;
  private curTime = 0;
  /** The last completed range, cleared when its trade window ends. */
  private range: NightRange | null = null;
  private entriesThisRange = 0;
  private wasInTrade = false;

  private skips: SkipCounters = { size: 0, stop: 0, narrow: 0 };
  private entriesPlaced = 0;
  private rangesBuilt = 0;
  private windowCloses = 0;

  constructor(config: BotConfig) {
    this.config = config;
    this.p = parseNightRangeParams(config.params);
  }

  start(_ctx: BotContext): void {
    void _ctx;
    const p = this.p;
    if (p.rangeStartHour === p.rangeEndHour) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "range window covers the whole day — it would never close");
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
      `night range breakout started — range ${p.rangeStartHour}:00-${p.rangeEndHour}:00 UTC, ` +
      `trade ${p.tradeStartHour}:00-${p.tradeEndHour}:00, stop ${p.stopMode}, target ${p.targetMode}, risk ${p.riskPct}%`,
    );
  }

  stop(ctx: BotContext): void {
    const cancelled = ctx.cancelAllOrders();
    this.reset();
    logInfo(
      `bot:${this.config.id}`,
      `night range breakout stopped — ranges ${this.rangesBuilt}, entries ${this.entriesPlaced}, ` +
      `window closes ${this.windowCloses}, skipped (narrow) ${this.skips.narrow}, (size) ${this.skips.size}, ` +
      `(stop) ${this.skips.stop}, cancelled ${cancelled}`,
    );
  }

  onOrderFilled(_ctx: BotContext, _order: VenueOrder, _fillPrice: number): void {
    void _ctx; void _order; void _fillPrice;
  }

  onBar(ctx: BotContext, bar: Candle, index: number): void {
    if (!this.valid) return;
    this.reconcile(ctx);

    const p = this.p;
    this.trackRange(bar);

    const step = this.barSeconds(ctx);
    const inTrade = inWindow(bar.time, p.tradeStartHour, p.tradeEndHour);
    // An entry decided on this bar fills at the next one, so the next bar has to
    // be inside the window too — otherwise the trade would open after the
    // session it belongs to has already ended.
    const canEnter = inTrade && inWindow(bar.time + step, p.tradeStartHour, p.tradeEndHour);

    const position = this.position(ctx);

    if (this.wasInTrade && !inTrade) {
      this.wasInTrade = false;
      this.range = null;
      this.entriesThisRange = 0;
      if (p.flattenAtEnd && (position || this.hasWorkingOrders())) {
        this.cancelWorking(ctx);
        if (position) {
          this.closeAtMarket(ctx, position, bar.close);
          this.windowCloses += 1;
        }
        return;
      }
      if (!position) this.cancelWorking(ctx);
    }
    if (inTrade) this.wasInTrade = true;

    if (position && this.manageOpen(ctx, position, index, bar)) return;
    if (!canEnter) return;
    this.tryEnter(ctx, bar, index, position);
  }

  // --- range ---------------------------------------------------------------

  /**
   * Grows the range while the clock is inside the range window and freezes it on
   * the first bar outside. Only bars the strategy has already been handed take
   * part, so the box is exactly what a live bot would have drawn.
   */
  private trackRange(bar: Candle): void {
    const p = this.p;
    const inRange = inWindow(bar.time, p.rangeStartHour, p.rangeEndHour);

    if (inRange) {
      if (!this.building) {
        this.building = true;
        this.curHigh = bar.high;
        this.curLow = bar.low;
        this.curBars = 0;
      }
      if (bar.high > this.curHigh) this.curHigh = bar.high;
      if (bar.low < this.curLow) this.curLow = bar.low;
      this.curBars += 1;
      this.curTime = bar.time;
      return;
    }

    if (!this.building) return;
    this.building = false;
    const height = this.curHigh - this.curLow;
    if (!(height > 0) || !(this.curLow > 0)) return;
    this.range = {
      high: this.curHigh,
      low: this.curLow,
      height,
      mid: (this.curHigh + this.curLow) / 2,
      bars: this.curBars,
      closedAt: this.curTime,
    };
    this.entriesThisRange = 0;
    this.rangesBuilt += 1;
  }

  /** Narrowness gate — the whole premise is a box tight enough for the exit to mean something. */
  private rangeUsable(range: NightRange, atrValue: number | null): boolean {
    const p = this.p;
    if (p.minRangeBars > 0 && range.bars < p.minRangeBars) return false;
    if (!(range.mid > 0)) return false;
    const pct = (range.height / range.mid) * 100;
    if (p.minRangePct > 0 && pct < p.minRangePct) return false;
    if (p.maxRangePct > 0 && pct > p.maxRangePct) return false;
    if (p.maxRangeAtrMult > 0) {
      if (atrValue === null || !(atrValue > 0)) return false;
      if (range.height > atrValue * p.maxRangeAtrMult) return false;
    }
    return true;
  }

  // --- state ---------------------------------------------------------------

  private reset(): void {
    this.pendingEntryIds = [];
    this.stopIds = [];
    this.targetIds = [];
    this.entryBar = null;
    this.building = false;
    this.curHigh = 0;
    this.curLow = 0;
    this.curBars = 0;
    this.curTime = 0;
    this.range = null;
    this.entriesThisRange = 0;
    this.wasInTrade = false;
  }

  private hasWorkingOrders(): boolean {
    return this.pendingEntryIds.length > 0 || this.stopIds.length > 0 || this.targetIds.length > 0;
  }

  private reconcile(ctx: BotContext): void {
    if (this.hasWorkingOrders()) {
      const pending = new Set(ctx.getPendingOrders().map((o) => o.id));
      this.pendingEntryIds = this.pendingEntryIds.filter((id) => pending.has(id));
      this.stopIds = this.stopIds.filter((id) => pending.has(id));
      this.targetIds = this.targetIds.filter((id) => pending.has(id));
    }

    if (this.position(ctx) !== null || this.pendingEntryIds.length > 0) return;

    for (const id of this.stopIds) ctx.cancelOrder(id, "flat");
    for (const id of this.targetIds) ctx.cancelOrder(id, "flat");
    this.stopIds = [];
    this.targetIds = [];
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

  private atrNow(ctx: BotContext): number | null {
    const p = this.p;
    const window = Math.max(p.atrPeriod * ATR_WARMUP_FACTOR, p.atrPeriod + 1);
    const bars = ctx.history.last(window);
    if (bars.length < p.atrPeriod + 1) return null;
    const series = atr(bars, p.atrPeriod);
    return series[series.length - 1];
  }

  // --- open position -------------------------------------------------------

  /** Returns true when the position was flattened on this bar. */
  private manageOpen(ctx: BotContext, position: VenuePosition, index: number, bar: Candle): boolean {
    const p = this.p;
    if (p.maxBarsInTrade > 0 && this.entryBar !== null && index - this.entryBar >= p.maxBarsInTrade) {
      this.cancelWorking(ctx);
      this.closeAtMarket(ctx, position, bar.close);
      return true;
    }
    return false;
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
    this.targetIds = [];
  }

  // --- entry ---------------------------------------------------------------

  private tryEnter(ctx: BotContext, bar: Candle, index: number, position: VenuePosition | null): void {
    const p = this.p;
    const range = this.range;
    if (range === null) return;
    if (this.pendingEntryIds.length > 0) return;
    if (position !== null) return;
    if (this.entriesThisRange >= p.maxEntriesPerRange) return;

    const atrValue = this.atrNow(ctx);
    if (!this.rangeUsable(range, atrValue)) {
      this.skips.narrow += 1;
      return;
    }

    const side = this.signal(bar, range);
    if (side === null) return;
    if (side === "buy" && !p.allowLong) return;
    if (side === "sell" && !p.allowShort) return;

    const ref = bar.close;
    const distance = this.stopDistance(side, ref, range, atrValue);
    if (!(distance > 0)) {
      this.skips.stop += 1;
      return;
    }
    const stopPrice = side === "buy" ? ref - distance : ref + distance;
    if (!(stopPrice > 0)) {
      this.skips.stop += 1;
      return;
    }

    const qty = this.positionSize(ctx, ref, distance);
    if (qty <= 0) {
      this.skips.size += 1;
      return;
    }

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
      price: ref,
      qty,
    });
    if (entry.status !== "pending") {
      ctx.cancelOrder(stop.id, "entry rejected");
      this.skips.size += 1;
      return;
    }

    this.stopIds.push(stop.id);
    this.pendingEntryIds.push(entry.id);
    this.entriesThisRange += 1;
    this.entriesPlaced += 1;
    if (this.entryBar === null) this.entryBar = index;

    const target = this.targetPrice(side, ref, distance, range);
    if (target !== null) {
      const order = ctx.placeOrder({
        symbol: this.config.symbol,
        side: side === "buy" ? "sell" : "buy",
        type: "limit",
        price: target,
        qty,
        reduceOnly: true,
      });
      if (order.status === "pending") this.targetIds.push(order.id);
    }
  }

  /**
   * The break itself. `close` waits for a bar to settle beyond the boundary,
   * `wick` takes the first touch — the touch is legitimate to read here because
   * the entry still fills at the next bar's open, not inside the bar that
   * produced the signal.
   */
  private signal(bar: Candle, range: NightRange): Side | null {
    const p = this.p;
    const buffer = range.height * (p.breakoutBufferPct / 100);
    const up = range.high + buffer;
    const down = range.low - buffer;
    if (p.triggerMode === "wick") {
      if (bar.high >= up && bar.low <= down) return null;   // both sides in one bar — no direction
      if (bar.high >= up) return "buy";
      if (bar.low <= down) return "sell";
      return null;
    }
    if (bar.close >= up) return "buy";
    if (bar.close <= down) return "sell";
    return null;
  }

  private stopDistance(side: Side, ref: number, range: NightRange, atrValue: number | null): number {
    const p = this.p;
    switch (p.stopMode) {
      case "fraction":
        return range.height * p.stopFraction;
      case "atr":
        return atrValue === null ? 0 : atrValue * p.stopAtrMult;
      case "pct":
        return ref * (p.stopPct / 100);
      case "opposite":
      default:
        // Behind the far side of the box: a long that gets pushed back through
        // the whole range was not a breakout.
        return side === "buy" ? ref - range.low : range.high - ref;
    }
  }

  private targetPrice(side: Side, ref: number, distance: number, range: NightRange): number | null {
    const p = this.p;
    let move = 0;
    if (p.targetMode === "r") move = distance * p.targetR;
    else if (p.targetMode === "range") move = range.height * p.targetRangeMult;
    if (!(move > 0)) return null;
    const price = side === "buy" ? ref + move : ref - move;
    return price > 0 ? price : null;
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

export const nightRangeBreakoutFactory: BotFactory = {
  kind: "night-range",
  name: "Пробой ночного диапазона",
  defaultParams: {
    rangeStartHour: 0,
    rangeEndHour: 6,
    tradeStartHour: 6,
    tradeEndHour: 14,
    minRangeBars: 0,
    minRangePct: 0,
    maxRangePct: 0,
    maxRangeAtrMult: 0,
    breakoutBufferPct: 0,
    triggerMode: "close",
    allowLong: 1,
    allowShort: 1,
    stopMode: "opposite",
    stopFraction: 0.5,
    stopAtrMult: 1.5,
    stopPct: 0.8,
    targetMode: "r",
    targetR: 1.5,
    targetRangeMult: 1,
    atrPeriod: 14,
    riskPct: 0.5,
    maxLeverage: 5,
    minQty: 0.001,
    qtyStep: 0.001,
    maxEntriesPerRange: 1,
    flattenAtEnd: 1,
    maxBarsInTrade: 0,
  },
  paramSpec: [
    { key: "rangeStartHour",     label: "Начало диапазона (час UTC)",       type: "number", min: 0, max: 23,  step: 1 },
    { key: "rangeEndHour",       label: "Конец диапазона (час UTC)",        type: "number", min: 0, max: 23,  step: 1 },
    { key: "tradeStartHour",     label: "Начало окна пробоя (час UTC)",     type: "number", min: 0, max: 23,  step: 1 },
    { key: "tradeEndHour",       label: "Конец окна пробоя (час UTC)",      type: "number", min: 0, max: 23,  step: 1 },
    { key: "minRangeBars",       label: "Мин. баров в диапазоне (0=выкл)",  type: "number", min: 0, max: 2000, step: 1 },
    { key: "minRangePct",        label: "Мин. ширина, % (0=выкл)",          type: "number", min: 0, max: 20,  step: 0.01 },
    { key: "maxRangePct",        label: "Макс. ширина, % (0=выкл)",         type: "number", min: 0, max: 20,  step: 0.01 },
    { key: "maxRangeAtrMult",    label: "Макс. ширина в ATR (0=выкл)",      type: "number", min: 0, max: 50,  step: 0.5 },
    { key: "breakoutBufferPct",  label: "Буфер пробоя, % ширины",           type: "number", min: 0, max: 100, step: 1 },
    { key: "triggerMode",        label: "Триггер: close / wick",            type: "string" },
    { key: "allowLong",          label: "Разрешить лонги (0/1)",            type: "number", min: 0, max: 1,   step: 1 },
    { key: "allowShort",         label: "Разрешить шорты (0/1)",            type: "number", min: 0, max: 1,   step: 1 },
    { key: "stopMode",           label: "Стоп: opposite / fraction / atr / pct", type: "string" },
    { key: "stopFraction",       label: "Стоп, доля ширины диапазона",      type: "number", min: 0, max: 5,   step: 0.05 },
    { key: "stopAtrMult",        label: "Стоп, множитель ATR",              type: "number", min: 0, max: 10,  step: 0.1 },
    { key: "stopPct",            label: "Стоп, % от цены",                  type: "number", min: 0, max: 20,  step: 0.1 },
    { key: "targetMode",         label: "Цель: none / r / range",           type: "string" },
    { key: "targetR",            label: "Цель, R (кратно риску)",           type: "number", min: 0, max: 10,  step: 0.1 },
    { key: "targetRangeMult",    label: "Цель, кратно ширине диапазона",    type: "number", min: 0, max: 10,  step: 0.1 },
    { key: "atrPeriod",          label: "Период ATR",                       type: "number", min: 1, max: 200, step: 1 },
    { key: "riskPct",            label: "Риск на сделку, % депозита",       type: "number", min: 0, max: 20,  step: 0.05 },
    { key: "maxLeverage",        label: "Макс. плечо по номиналу",          type: "number", min: 0, max: 50,  step: 0.5 },
    { key: "minQty",             label: "Мин. лот инструмента",             type: "number", min: 0, step: 0.001 },
    { key: "qtyStep",            label: "Шаг объёма",                       type: "number", min: 0, step: 0.001 },
    { key: "maxEntriesPerRange", label: "Макс. входов на диапазон",         type: "number", min: 1, max: 10,  step: 1 },
    { key: "flattenAtEnd",       label: "Закрывать в конце окна (0/1)",     type: "number", min: 0, max: 1,   step: 1 },
    { key: "maxBarsInTrade",     label: "Макс. баров в сделке (0=выкл)",    type: "number", min: 0, max: 2000, step: 1 },
  ],
  create(config) {
    return new NightRangeBreakoutBot(config);
  },
};
