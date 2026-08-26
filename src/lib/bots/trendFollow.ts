// Trend following on the high timeframe — the only horizon where the arithmetic
// in docs/market-stats.md leaves room for a directional signal at all.
//
// One bot covers the three classical formulations of the same idea, because they
// are the same idea and testing them separately would only inflate the number of
// trials: price against a moving average, sign of the N-bar return, and the
// Donchian channel break of the turtle system. Each maps a closed signal bar to
// a desired direction; everything downstream — sizing, the volatility regime
// filter, rebalancing — is shared.
//
// The bot is always-in by construction: it holds a target position and moves to
// it, rather than opening and closing discrete trades. That matters for costs on
// a daily bar, where a stop-and-reverse pays two crossings and a hold pays none.
//
// No indicator reads past the bar being processed: every window is taken from
// ctx.history, which the runner bounds by the clock cursor.

import type { BotConfig, Side } from "../store";
import type { VenueOrder, VenuePosition } from "../execution/types";
import type { Bot, BotContext, BotFactory } from "./base";
import type { Candle } from "../types";
import { atr } from "../indicators/core";
import { logInfo, logWarn } from "../eventBus";

const DEFAULT_BAR_SECONDS = 86_400;
const YEAR_SECONDS = 365 * 86_400;
/** Bars of ATR warm-up kept in the window; Wilder seeding bias decays below 1e-4. */
const ATR_WARMUP_FACTOR = 10;

export type SignalMode = "ma" | "mom" | "donchian";
export type SizeMode = "notional" | "volTarget";
export type VolFilter = "none" | "skipHigh" | "skipLow";

export interface TrendFollowParams {
  signalMode: SignalMode;
  period: number;
  allowLong: boolean;
  allowShort: boolean;
  sizeMode: SizeMode;
  targetLeverage: number;
  targetVolPct: number;
  volPeriod: number;
  maxLeverage: number;
  minTradeFraction: number;
  volFilter: VolFilter;
  volFilterPct: number;
  volRankWindow: number;
  stopAtrMult: number;
  atrPeriod: number;
  minQty: number;
  qtyStep: number;
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

function oneOf<T extends string>(v: unknown, allowed: readonly T[], fallback: T): T {
  const s = String(v ?? "").trim().toLowerCase();
  const hit = (allowed as readonly string[]).find((a) => a.toLowerCase() === s);
  return (hit as T) ?? fallback;
}

export function parseTrendFollowParams(raw: Record<string, number | string>): TrendFollowParams {
  return {
    signalMode:       oneOf(raw.signalMode, ["ma", "mom", "donchian"] as const, "ma"),
    period:           Math.max(2, int(raw.period, 100)),
    allowLong:        flag(raw.allowLong, true),
    allowShort:       flag(raw.allowShort, false),
    sizeMode:         oneOf(raw.sizeMode, ["notional", "volTarget"] as const, "notional"),
    targetLeverage:   Math.max(0, num(raw.targetLeverage, 1)),
    targetVolPct:     Math.max(0, num(raw.targetVolPct, 60)),
    volPeriod:        Math.max(2, int(raw.volPeriod, 20)),
    maxLeverage:      Math.max(0, num(raw.maxLeverage, 2)),
    minTradeFraction: Math.min(1, Math.max(0, num(raw.minTradeFraction, 0.2))),
    volFilter:        oneOf(raw.volFilter, ["none", "skipHigh", "skipLow"] as const, "none"),
    volFilterPct:     Math.min(1, Math.max(0, num(raw.volFilterPct, 0.8))),
    volRankWindow:    Math.max(10, int(raw.volRankWindow, 250)),
    stopAtrMult:      Math.max(0, num(raw.stopAtrMult, 0)),
    atrPeriod:        Math.max(1, int(raw.atrPeriod, 14)),
    minQty:           Math.max(0, num(raw.minQty, 0.001)),
    qtyStep:          Math.max(0, num(raw.qtyStep, 0.001)),
  };
}

/** Rounds down to the instrument size step — never up, which would take more risk than asked. */
export function quantiseDown(qty: number, step: number): number {
  if (!(qty > 0)) return 0;
  if (!(step > 0)) return qty;
  const units = Math.floor(qty / step + 1e-9);
  if (units <= 0) return 0;
  return Number((units * step).toFixed(12));
}

/**
 * Desired direction from the closed bars in `bars`, the newest last.
 *
 * `donchian` is stateful in the original system — the position persists between
 * breaks — so the caller passes the direction currently held and gets it back
 * unchanged while price sits inside the channel.
 */
export function trendSignal(
  bars: readonly Candle[],
  mode: SignalMode,
  period: number,
  held: number,
): number | null {
  const n = bars.length;
  if (mode === "mom") {
    if (n < period + 1) return null;
    const now = bars[n - 1].close;
    const then = bars[n - 1 - period].close;
    return Math.sign(now - then);
  }
  if (mode === "ma") {
    if (n < period) return null;
    let sum = 0;
    for (let i = n - period; i < n; i++) sum += bars[i].close;
    return Math.sign(bars[n - 1].close - sum / period);
  }
  // donchian: break of the channel built from the `period` bars BEFORE this one
  if (n < period + 1) return null;
  let hi = -Infinity;
  let lo = Infinity;
  for (let i = n - 1 - period; i < n - 1; i++) {
    if (bars[i].high > hi) hi = bars[i].high;
    if (bars[i].low < lo) lo = bars[i].low;
  }
  const close = bars[n - 1].close;
  if (close > hi) return 1;
  if (close < lo) return -1;
  return held;
}

/** Annualised realised volatility of log returns over the last `period` bars. */
export function realisedVol(bars: readonly Candle[], period: number, barSeconds: number): number | null {
  const n = bars.length;
  if (n < period + 1) return null;
  const r: number[] = [];
  for (let i = n - period; i < n; i++) {
    const prev = bars[i - 1].close;
    const cur = bars[i].close;
    if (!(prev > 0) || !(cur > 0)) return null;
    r.push(Math.log(cur / prev));
  }
  const m = r.reduce((s, x) => s + x, 0) / r.length;
  let v = 0;
  for (const x of r) v += (x - m) * (x - m);
  v /= r.length;
  if (!(v > 0)) return null;
  return Math.sqrt(v) * Math.sqrt(YEAR_SECONDS / barSeconds);
}

/** Share of the trailing window strictly below the current value; null until the window is full. */
export function percentileRank(history: readonly number[], current: number, window: number): number | null {
  if (history.length < window) return null;
  const slice = history.slice(history.length - window);
  let below = 0;
  for (const x of slice) if (x < current) below += 1;
  return below / slice.length;
}

class TrendFollowBot implements Bot {
  config: BotConfig;

  private readonly p: TrendFollowParams;
  private valid = true;

  /** Direction the Donchian rule is carrying between breaks. */
  private held = 0;
  private volHistory: number[] = [];
  private stopIds: string[] = [];

  private rebalances = 0;
  private skippedByVol = 0;
  private lastDirection = 0;
  private directionChanges = 0;

  constructor(config: BotConfig) {
    this.config = config;
    this.p = parseTrendFollowParams(config.params);
  }

  start(_ctx: BotContext): void {
    void _ctx;
    const p = this.p;
    if (!p.allowLong && !p.allowShort) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "both directions disabled — nothing to trade");
      return;
    }
    if (p.sizeMode === "notional" && !(p.targetLeverage > 0)) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "targetLeverage must be > 0 in notional sizing");
      return;
    }
    if (p.sizeMode === "volTarget" && !(p.targetVolPct > 0)) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "targetVolPct must be > 0 in volTarget sizing");
      return;
    }
    this.held = 0;
    this.volHistory = [];
    this.stopIds = [];
    this.lastDirection = 0;
    logInfo(
      `bot:${this.config.id}`,
      `trend follow started — ${p.signalMode}(${p.period}), ${p.allowShort ? "long/short" : "long only"}, ` +
      `sizing ${p.sizeMode}, vol filter ${p.volFilter}`,
    );
  }

  stop(ctx: BotContext): void {
    const cancelled = ctx.cancelAllOrders();
    this.stopIds = [];
    logInfo(
      `bot:${this.config.id}`,
      `trend follow stopped — rebalances ${this.rebalances}, direction changes ${this.directionChanges}, ` +
      `skipped by vol filter ${this.skippedByVol}, cancelled ${cancelled}`,
    );
  }

  onOrderFilled(_ctx: BotContext, _order: VenueOrder, _fillPrice: number): void {
    void _ctx; void _order; void _fillPrice;
  }

  onBar(ctx: BotContext, bar: Candle, _index: number): void {
    void _index;
    if (!this.valid) return;
    const p = this.p;

    const barSeconds = this.barSeconds(ctx);
    const window = Math.max(p.period + 1, p.volPeriod + 1, p.atrPeriod * ATR_WARMUP_FACTOR) + 2;
    const bars = ctx.history.last(window);

    const raw = trendSignal(bars, p.signalMode, p.period, this.held);
    if (raw === null) return;
    this.held = raw;

    let direction = raw;
    if (direction > 0 && !p.allowLong) direction = 0;
    if (direction < 0 && !p.allowShort) direction = 0;
    if (!this.volAllows(bars, barSeconds)) {
      if (direction !== 0) this.skippedByVol += 1;
      direction = 0;
    }

    const price = bar.close;
    const targetQty = direction === 0 ? 0 : this.targetQty(ctx, bars, price, barSeconds);
    const target = direction * targetQty;

    const position = this.position(ctx);
    const current = position ? (position.side === "buy" ? position.qty : -position.qty) : 0;

    if (direction !== this.lastDirection) {
      this.directionChanges += 1;
      this.lastDirection = direction;
    }

    this.rebalance(ctx, current, target, price);
    this.refreshStop(ctx, bars, price);
  }

  // --- decisions -----------------------------------------------------------

  private volAllows(bars: readonly Candle[], barSeconds: number): boolean {
    const p = this.p;
    const vol = realisedVol(bars, p.volPeriod, barSeconds);
    if (vol === null) return p.volFilter === "none";
    const rank = percentileRank(this.volHistory, vol, p.volRankWindow);
    this.volHistory.push(vol);
    if (this.volHistory.length > p.volRankWindow * 2) this.volHistory = this.volHistory.slice(-p.volRankWindow);
    if (p.volFilter === "none") return true;
    if (rank === null) return false;   // no trading before the regime is measurable
    return p.volFilter === "skipHigh" ? rank < p.volFilterPct : rank >= 1 - p.volFilterPct;
  }

  private targetQty(ctx: BotContext, bars: readonly Candle[], price: number, barSeconds: number): number {
    const p = this.p;
    const equity = ctx.getBalance().equity;
    if (!(equity > 0) || !(price > 0)) return 0;

    let leverage = p.targetLeverage;
    if (p.sizeMode === "volTarget") {
      const vol = realisedVol(bars, p.volPeriod, barSeconds);
      if (vol === null || !(vol > 0)) return 0;
      leverage = p.targetVolPct / 100 / vol;
    }
    if (p.maxLeverage > 0) leverage = Math.min(leverage, p.maxLeverage);
    if (!(leverage > 0)) return 0;

    const qty = quantiseDown((equity * leverage) / price, p.qtyStep);
    return qty + 1e-12 < p.minQty ? 0 : qty;
  }

  /**
   * Moves the position towards `target`. A single market order crosses zero on
   * its own — the venue closes the opposite side first and opens the remainder —
   * so no separate close leg is needed. Small drifts are ignored: on a daily bar
   * a 5% size correction costs more in fees than it fixes in tracking.
   */
  private rebalance(ctx: BotContext, current: number, target: number, price: number): void {
    const p = this.p;
    const delta = target - current;
    if (delta === 0) return;

    const qty = quantiseDown(Math.abs(delta), p.qtyStep);
    if (qty <= 0) return;

    const crossesZero = target === 0 || Math.sign(target) !== Math.sign(current);
    if (!crossesZero) {
      const scale = Math.abs(target) > 0 ? Math.abs(delta) / Math.abs(target) : 1;
      if (scale < p.minTradeFraction) return;
      if (qty + 1e-12 < p.minQty) return;
    }

    const side: Side = delta > 0 ? "buy" : "sell";
    const order = ctx.placeOrder({
      symbol: this.config.symbol,
      side,
      type: "market",
      price,
      qty,
      reduceOnly: target === 0,
    });
    if (order.status === "pending") this.rebalances += 1;
  }

  /** Protective stop, off by default: the signal itself is the exit. */
  private refreshStop(ctx: BotContext, bars: readonly Candle[], price: number): void {
    const p = this.p;
    if (!(p.stopAtrMult > 0)) return;

    const pending = new Set(ctx.getPendingOrders().map((o) => o.id));
    this.stopIds = this.stopIds.filter((id) => pending.has(id));

    const position = this.position(ctx);
    if (!position) {
      for (const id of this.stopIds) ctx.cancelOrder(id, "flat");
      this.stopIds = [];
      return;
    }

    if (bars.length < p.atrPeriod + 1) return;
    const series = atr(bars, p.atrPeriod);
    const value = series[series.length - 1];
    if (!(value > 0)) return;

    const distance = value * p.stopAtrMult;
    const stopPrice = position.side === "buy" ? price - distance : price + distance;
    if (!(stopPrice > 0)) return;

    for (const id of this.stopIds) ctx.cancelOrder(id, "stop moved");
    this.stopIds = [];
    const order = ctx.placeOrder({
      symbol: this.config.symbol,
      side: position.side === "buy" ? "sell" : "buy",
      type: "stop",
      price: stopPrice,
      qty: position.qty,
      reduceOnly: true,
    });
    if (order.status === "pending") this.stopIds.push(order.id);
  }

  // --- helpers -------------------------------------------------------------

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
}

export const trendFollowFactory: BotFactory = {
  kind: "trend-follow",
  name: "Трендовый фильтр на старшем ТФ",
  defaultParams: {
    signalMode: "ma",
    period: 100,
    allowLong: 1,
    allowShort: 0,
    sizeMode: "notional",
    targetLeverage: 1,
    targetVolPct: 60,
    volPeriod: 20,
    maxLeverage: 2,
    minTradeFraction: 0.2,
    volFilter: "none",
    volFilterPct: 0.8,
    volRankWindow: 250,
    stopAtrMult: 0,
    atrPeriod: 14,
    minQty: 0.001,
    qtyStep: 0.001,
  },
  paramSpec: [
    { key: "signalMode",       label: "Сигнал: ma / mom / donchian",      type: "string" },
    { key: "period",           label: "Период сигнала (баров)",           type: "number", min: 2, max: 500, step: 1 },
    { key: "allowLong",        label: "Разрешить лонги (0/1)",            type: "number", min: 0, max: 1,   step: 1 },
    { key: "allowShort",       label: "Разрешить шорты (0/1)",            type: "number", min: 0, max: 1,   step: 1 },
    { key: "sizeMode",         label: "Размер: notional / volTarget",     type: "string" },
    { key: "targetLeverage",   label: "Плечо по номиналу",                type: "number", min: 0, max: 10,  step: 0.1 },
    { key: "targetVolPct",     label: "Целевая волатильность, %/год",     type: "number", min: 0, max: 300, step: 5 },
    { key: "volPeriod",        label: "Окно волатильности (баров)",       type: "number", min: 2, max: 200, step: 1 },
    { key: "maxLeverage",      label: "Макс. плечо по номиналу",          type: "number", min: 0, max: 20,  step: 0.5 },
    { key: "minTradeFraction", label: "Порог ребаланса, доля позиции",    type: "number", min: 0, max: 1,   step: 0.05 },
    { key: "volFilter",        label: "Фильтр вола: none / skipHigh / skipLow", type: "string" },
    { key: "volFilterPct",     label: "Порог фильтра, процентиль",        type: "number", min: 0, max: 1,   step: 0.05 },
    { key: "volRankWindow",    label: "Окно ранга волатильности (баров)", type: "number", min: 10, max: 2000, step: 10 },
    { key: "stopAtrMult",      label: "Стоп, множитель ATR (0=выкл)",     type: "number", min: 0, max: 10,  step: 0.1 },
    { key: "atrPeriod",        label: "Период ATR",                       type: "number", min: 1, max: 200, step: 1 },
    { key: "minQty",           label: "Мин. лот инструмента",             type: "number", min: 0, step: 0.001 },
    { key: "qtyStep",          label: "Шаг объёма",                       type: "number", min: 0, step: 0.001 },
  ],
  create(config) {
    return new TrendFollowBot(config);
  },
};
