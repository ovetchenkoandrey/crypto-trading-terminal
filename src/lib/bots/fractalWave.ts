// Fractal wave — join the leg that runs between the last two opposing fractals.
//
// The distance between the most recent confirmed high fractal and the most
// recent confirmed low fractal is the wave. The younger of the two is the
// anchor: price is travelling away from it, and the strategy joins that leg
// once the displacement reaches a fraction of the wave. Target, stop, trailing
// trigger and trailing distance are all fractions of the same wave, so a trade
// scales with the swing that produced it instead of with a fixed tick count.
//
// A fractal with window N is only knowable N bars after its extreme. The bot
// therefore never inspects the bar it is standing on — the candidate it tests
// is always `index - N`, with N confirmed neighbours on each side. That is the
// rule `fractals()` applies, and `fractalAt` is checked against it in the tests.
//
// Order bookkeeping deliberately avoids `getPendingOrders` and
// `cancelAllOrders`: both scan every order the venue has ever seen, which on a
// minute series with thousands of trades turns a run quadratic. Positions are
// the source of truth instead, and individual ids are cancelled by hand.

import type { BotConfig, Side } from "../store";
import type { VenueOrder, VenuePosition } from "../execution/types";
import type { Bot, BotContext, BotFactory } from "./base";
import type { Candle } from "../types";
import { quantiseDown } from "./nightMeanReversion";
import { logInfo, logWarn } from "../eventBus";

export type WaveStopMode = "wave" | "pivot";
export type TrailAnchor = "close" | "extreme";
export type TrendFilter = "off" | "highs" | "lows" | "any" | "both";

export interface FractalWaveParams {
  fractalN: number;
  entryFrac: number;
  maxEntryFrac: number;
  tpFrac: number;
  slFrac: number;
  stopMode: WaveStopMode;
  trailStartFrac: number;
  trailDistFrac: number;
  trailStepFrac: number;
  trailAnchor: TrailAnchor;
  trendFilter: TrendFilter;
  minWavePct: number;
  maxWavePct: number;
  maxAnchorAge: number;
  maxBarsInTrade: number;
  cooldownBars: number;
  allowLong: boolean;
  allowShort: boolean;
  riskPct: number;
  maxLeverage: number;
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
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

export function parseFractalWaveParams(raw: Record<string, number | string>): FractalWaveParams {
  return {
    fractalN:       Math.max(1, int(raw.fractalN, 2)),
    entryFrac:      Math.max(0, num(raw.entryFrac, 0.5)),
    maxEntryFrac:   Math.max(0, num(raw.maxEntryFrac, 0)),
    tpFrac:         Math.max(0, num(raw.tpFrac, 1)),
    slFrac:         Math.max(0, num(raw.slFrac, 0.5)),
    stopMode:       oneOf(raw.stopMode, ["wave", "pivot"] as const, "wave"),
    trailStartFrac: Math.max(0, num(raw.trailStartFrac, 0.5)),
    trailDistFrac:  Math.max(0, num(raw.trailDistFrac, 0.5)),
    trailStepFrac:  Math.max(0, num(raw.trailStepFrac, 0.1)),
    trailAnchor:    oneOf(raw.trailAnchor, ["close", "extreme"] as const, "close"),
    trendFilter:    oneOf(raw.trendFilter, ["off", "highs", "lows", "any", "both"] as const, "both"),
    minWavePct:     Math.max(0, num(raw.minWavePct, 0)),
    maxWavePct:     Math.max(0, num(raw.maxWavePct, 0)),
    maxAnchorAge:   Math.max(0, int(raw.maxAnchorAge, 0)),
    maxBarsInTrade: Math.max(0, int(raw.maxBarsInTrade, 0)),
    cooldownBars:   Math.max(0, int(raw.cooldownBars, 0)),
    allowLong:      flag(raw.allowLong, true),
    allowShort:     flag(raw.allowShort, true),
    riskPct:        Math.max(0, num(raw.riskPct, 0.5)),
    maxLeverage:    Math.max(0, num(raw.maxLeverage, 5)),
    minQty:         Math.max(0, num(raw.minQty, 0.001)),
    qtyStep:        Math.max(0, num(raw.qtyStep, 0.001)),
  };
}

/**
 * Whether the middle bar of a `2n + 1` window is a Bill Williams fractal.
 *
 * The window must be exactly that long: its centre is the candidate and both
 * halves are its confirmed neighbours. Feeding a window that ends at the
 * current bar is what makes the check honest — the candidate is `n` bars old,
 * which is precisely when a real fractal becomes knowable.
 */
export function fractalAt(window: readonly Candle[], n: number): { high: boolean; low: boolean } {
  if (n < 1 || window.length !== 2 * n + 1) return { high: false, low: false };
  const c = window[n];
  let isHigh = true;
  let isLow = true;
  for (let j = 1; j <= n; j++) {
    if (window[n - j].high >= c.high || window[n + j].high >= c.high) isHigh = false;
    if (window[n - j].low <= c.low || window[n + j].low <= c.low) isLow = false;
    if (!isHigh && !isLow) break;
  }
  return { high: isHigh, low: isLow };
}

interface Pivot {
  index: number;
  price: number;
}

interface SkipCounters {
  size: number;
  stop: number;
  wave: number;
  trend: number;
}

class FractalWaveBot implements Bot {
  config: BotConfig;

  private readonly p: FractalWaveParams;
  private valid = true;

  private lastHigh: Pivot | null = null;
  private prevHigh: Pivot | null = null;
  private lastLow: Pivot | null = null;
  private prevLow: Pivot | null = null;

  private entryId: string | null = null;
  private entryBar: number | null = null;
  private stopId: string | null = null;
  private stopPrice = 0;
  private tpId: string | null = null;
  /** Wave length frozen at entry — targets must not drift with later fractals. */
  private tradeWave = 0;
  /** Best price seen since entry, by the configured anchor. */
  private best = 0;
  private closingBar: number | null = null;
  private cooldownUntil = -1;
  /** Anchor already traded, so one pivot produces at most one entry. */
  private tradedAnchor: number | null = null;

  private skips: SkipCounters = { size: 0, stop: 0, wave: 0, trend: 0 };
  private entriesPlaced = 0;
  private trailMoves = 0;
  private timeExits = 0;

  constructor(config: BotConfig) {
    this.config = config;
    this.p = parseFractalWaveParams(config.params);
  }

  start(_ctx: BotContext): void {
    void _ctx;
    const p = this.p;
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
    if (p.stopMode === "wave" && !(p.slFrac > 0)) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "slFrac must be > 0 in wave stop mode — the stop would sit on the entry");
      return;
    }
    this.resetAll();
    logInfo(
      `bot:${this.config.id}`,
      `fractal wave started — fractal(${p.fractalN}), entry ${p.entryFrac}w, tp ${p.tpFrac}w, sl ${p.slFrac}w (${p.stopMode}), ` +
      `trail ${p.trailStartFrac}/${p.trailDistFrac}w by ${p.trailAnchor}, filter ${p.trendFilter}, risk ${p.riskPct}%`,
    );
  }

  stop(_ctx: BotContext): void {
    void _ctx;
    logInfo(
      `bot:${this.config.id}`,
      `fractal wave stopped — entries ${this.entriesPlaced}, trail moves ${this.trailMoves}, time exits ${this.timeExits}, ` +
      `skipped: size ${this.skips.size}, stop ${this.skips.stop}, wave ${this.skips.wave}, trend ${this.skips.trend}`,
    );
  }

  /** Brackets are placed with the entry, so a fill needs no follow-up. */
  onOrderFilled(_ctx: BotContext, _order: VenueOrder, _fillPrice: number): void {
    void _ctx; void _order; void _fillPrice;
  }

  onBar(ctx: BotContext, bar: Candle, index: number): void {
    if (!this.valid) return;

    this.updateFractals(ctx, index);
    const position = this.reconcile(ctx, index);

    if (position) {
      this.manageOpen(ctx, position, bar, index);
      return;
    }
    this.tryEnter(ctx, bar, index);
  }

  // ─── fractal tracking ─────────────────────────────────────────────────────

  /**
   * Promotes the bar `fractalN` back to a pivot when its neighbours confirm it.
   * O(fractalN) per bar rather than a rescan of the window, which matters on a
   * minute series with hundreds of thousands of bars.
   */
  private updateFractals(ctx: BotContext, index: number): void {
    const n = this.p.fractalN;
    const need = 2 * n + 1;
    const window = ctx.history.last(need);
    if (window.length !== need) return;

    const f = fractalAt(window, n);
    if (!f.high && !f.low) return;

    const candidate = window[n];
    const candidateIndex = index - n;
    if (f.high) {
      this.prevHigh = this.lastHigh;
      this.lastHigh = { index: candidateIndex, price: candidate.high };
    }
    if (f.low) {
      this.prevLow = this.lastLow;
      this.lastLow = { index: candidateIndex, price: candidate.low };
    }
  }

  // ─── state ────────────────────────────────────────────────────────────────

  private resetAll(): void {
    this.lastHigh = null;
    this.prevHigh = null;
    this.lastLow = null;
    this.prevLow = null;
    this.clearTrade();
    this.cooldownUntil = -1;
    this.tradedAnchor = null;
  }

  private clearTrade(): void {
    this.entryId = null;
    this.entryBar = null;
    this.stopId = null;
    this.stopPrice = 0;
    this.tpId = null;
    this.tradeWave = 0;
    this.best = 0;
    this.closingBar = null;
  }

  private position(ctx: BotContext): VenuePosition | null {
    return ctx.getPositions().find((p) => p.symbol === this.config.symbol && p.qty > 0) ?? null;
  }

  /**
   * Reconciles bot state with the venue using positions alone.
   *
   * A market entry placed on bar k fills at the open of bar k + 1, so by the
   * time this runs on a later bar the trade either exists or never will —
   * rejection cancels the order outright. Being flat with brackets still
   * registered therefore means the trade is over, whether it ended on the stop,
   * the target, or a rejected entry.
   */
  private reconcile(ctx: BotContext, index: number): VenuePosition | null {
    const position = this.position(ctx);

    if (position) {
      if (this.entryId !== null) {
        this.entryId = null;
        this.best = position.entryPrice;
      }
      return position;
    }

    const awaitingFill = this.entryId !== null && this.entryBar !== null && index <= this.entryBar;
    if (awaitingFill) return null;
    if (this.entryId === null && this.stopId === null && this.tpId === null) return null;

    this.closeout(ctx, index);
    return null;
  }

  private closeout(ctx: BotContext, index: number): void {
    if (this.entryId !== null) ctx.cancelOrder(this.entryId, "flat");
    if (this.stopId !== null) ctx.cancelOrder(this.stopId, "flat");
    if (this.tpId !== null) ctx.cancelOrder(this.tpId, "flat");
    this.clearTrade();
    this.cooldownUntil = index + this.p.cooldownBars;
  }

  // ─── open position ────────────────────────────────────────────────────────

  private manageOpen(ctx: BotContext, position: VenuePosition, bar: Candle, index: number): void {
    const p = this.p;

    if (this.closingBar !== null) {
      // The flatten order is in flight. Re-issue only if it clearly did not
      // take, rather than stacking a market close on every bar.
      if (index - this.closingBar >= 2) this.flatten(ctx, position, bar, index);
      return;
    }

    if (p.maxBarsInTrade > 0 && this.entryBar !== null && index - this.entryBar >= p.maxBarsInTrade) {
      if (this.stopId !== null) ctx.cancelOrder(this.stopId, "time exit");
      if (this.tpId !== null) ctx.cancelOrder(this.tpId, "time exit");
      this.stopId = null;
      this.tpId = null;
      this.timeExits += 1;
      this.flatten(ctx, position, bar, index);
      return;
    }

    this.trail(ctx, position, bar);
  }

  private flatten(ctx: BotContext, position: VenuePosition, bar: Candle, index: number): void {
    ctx.placeOrder({
      symbol: this.config.symbol,
      side: position.side === "buy" ? "sell" : "buy",
      type: "market",
      price: bar.close,
      qty: position.qty,
      reduceOnly: true,
    });
    this.closingBar = index;
  }

  /**
   * Ratchets the stop behind the best price once the move has paid for itself.
   *
   * `best` follows closes by default. Following bar extremes instead assumes the
   * stop was already sitting at its new level while the bar was forming, which
   * silently changes what the same bar would have done — an assumption the run
   * has to opt into rather than inherit.
   */
  private trail(ctx: BotContext, position: VenuePosition, bar: Candle): void {
    const p = this.p;
    if (!(p.trailStartFrac > 0) || !(this.tradeWave > 0) || !(p.trailDistFrac > 0)) return;

    const long = position.side === "buy";
    const anchor = p.trailAnchor === "extreme" ? (long ? bar.high : bar.low) : bar.close;
    this.best = long ? Math.max(this.best, anchor) : Math.min(this.best, anchor);

    const move = long ? this.best - position.entryPrice : position.entryPrice - this.best;
    if (move < p.trailStartFrac * this.tradeWave) return;

    const dist = p.trailDistFrac * this.tradeWave;
    const candidate = long ? this.best - dist : this.best + dist;
    const step = p.trailStepFrac * this.tradeWave;
    const better = long ? candidate > this.stopPrice + step : candidate < this.stopPrice - step;
    if (!better || !(candidate > 0)) return;

    // New stop first: if the venue refuses it, the old one is still protecting
    // the position. Cancelling first would leave the trade naked for a bar.
    const order = ctx.placeOrder({
      symbol: this.config.symbol,
      side: long ? "sell" : "buy",
      type: "stop",
      price: candidate,
      qty: position.qty,
      reduceOnly: true,
    });
    if (order.status !== "pending") return;

    const previous = this.stopId;
    this.stopId = order.id;
    this.stopPrice = candidate;
    this.trailMoves += 1;
    if (previous !== null) ctx.cancelOrder(previous, "trail");
  }

  // ─── entry ────────────────────────────────────────────────────────────────

  private tryEnter(ctx: BotContext, bar: Candle, index: number): void {
    const p = this.p;
    if (index < this.cooldownUntil) return;
    if (this.lastHigh === null || this.lastLow === null) return;
    if (this.lastHigh.index === this.lastLow.index) return;

    const wave = Math.abs(this.lastHigh.price - this.lastLow.price);
    if (!(wave > 0)) return;

    const close = bar.close;
    if (!(close > 0)) return;
    const wavePct = (wave / close) * 100;
    if (p.minWavePct > 0 && wavePct < p.minWavePct) { this.skips.wave += 1; return; }
    if (p.maxWavePct > 0 && wavePct > p.maxWavePct) { this.skips.wave += 1; return; }

    const anchorIsLow = this.lastLow.index > this.lastHigh.index;
    const anchor = anchorIsLow ? this.lastLow : this.lastHigh;
    const side: Side = anchorIsLow ? "buy" : "sell";

    if (this.tradedAnchor === anchor.index) return;
    if (side === "buy" && !p.allowLong) return;
    if (side === "sell" && !p.allowShort) return;
    if (p.maxAnchorAge > 0 && index - anchor.index > p.maxAnchorAge) return;

    const displacement = side === "buy" ? close - anchor.price : anchor.price - close;
    if (displacement < p.entryFrac * wave) return;
    if (p.maxEntryFrac > 0 && displacement > p.maxEntryFrac * wave) return;

    if (!this.trendOk(side)) { this.skips.trend += 1; return; }

    const stopPrice = this.stopFor(side, close, anchor, wave);
    const distance = Math.abs(close - stopPrice);
    if (!(stopPrice > 0) || !(distance > 0)) { this.skips.stop += 1; return; }

    const qty = this.positionSize(ctx, close, distance);
    if (qty <= 0) { this.skips.size += 1; return; }

    // Protection is placed before the entry so it is already resting when the
    // market order fills at the next bar's open. An unprotected first bar is
    // exactly where a wave trade can be at its worst.
    const stop = ctx.placeOrder({
      symbol: this.config.symbol,
      side: side === "buy" ? "sell" : "buy",
      type: "stop",
      price: stopPrice,
      qty,
      reduceOnly: true,
    });
    if (stop.status !== "pending") { this.skips.stop += 1; return; }

    let tpId: string | null = null;
    if (p.tpFrac > 0) {
      const target = side === "buy" ? close + p.tpFrac * wave : close - p.tpFrac * wave;
      const tp = ctx.placeOrder({
        symbol: this.config.symbol,
        side: side === "buy" ? "sell" : "buy",
        type: "limit",
        price: target,
        qty,
        reduceOnly: true,
      });
      if (tp.status !== "pending") {
        ctx.cancelOrder(stop.id, "target rejected");
        this.skips.stop += 1;
        return;
      }
      tpId = tp.id;
    }

    const entry = ctx.placeOrder({
      symbol: this.config.symbol,
      side,
      type: "market",
      price: close,
      qty,
    });
    if (entry.status !== "pending") {
      ctx.cancelOrder(stop.id, "entry rejected");
      if (tpId !== null) ctx.cancelOrder(tpId, "entry rejected");
      this.skips.size += 1;
      return;
    }

    this.entryId = entry.id;
    this.entryBar = index;
    this.stopId = stop.id;
    this.stopPrice = stopPrice;
    this.tpId = tpId;
    this.tradeWave = wave;
    this.best = close;
    this.closingBar = null;
    this.tradedAnchor = anchor.index;
    this.entriesPlaced += 1;
  }

  /** Two consecutive pivots of the same kind, pointing the way we intend to trade. */
  private trendOk(side: Side): boolean {
    const mode = this.p.trendFilter;
    if (mode === "off") return true;
    const up = side === "buy";

    const highsOk = this.lastHigh !== null && this.prevHigh !== null
      && (up ? this.lastHigh.price > this.prevHigh.price : this.lastHigh.price < this.prevHigh.price);
    const lowsOk = this.lastLow !== null && this.prevLow !== null
      && (up ? this.lastLow.price > this.prevLow.price : this.lastLow.price < this.prevLow.price);

    switch (mode) {
      case "highs": return highsOk;
      case "lows":  return lowsOk;
      case "any":   return highsOk || lowsOk;
      default:      return highsOk && lowsOk;
    }
  }

  /**
   * `wave` measures the stop from the entry, `pivot` puts it beyond the anchor
   * fractal — the level whose break says the wave was misread. The second is
   * the wider stop once price has already run, which is the whole difference.
   */
  private stopFor(side: Side, close: number, anchor: Pivot, wave: number): number {
    const p = this.p;
    if (p.stopMode === "pivot") {
      return side === "buy" ? anchor.price - p.slFrac * wave : anchor.price + p.slFrac * wave;
    }
    return side === "buy" ? close - p.slFrac * wave : close + p.slFrac * wave;
  }

  /** Risk-based size, capped by notional leverage and rounded down to the step. */
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

export const fractalWaveFactory: BotFactory = {
  kind: "fractal-wave",
  name: "Волна по фракталам",
  defaultParams: {
    fractalN: 2,
    entryFrac: 0.5,
    maxEntryFrac: 0,
    tpFrac: 1,
    slFrac: 0.5,
    stopMode: "wave",
    trailStartFrac: 0.5,
    trailDistFrac: 0.5,
    trailStepFrac: 0.1,
    trailAnchor: "close",
    trendFilter: "both",
    minWavePct: 0,
    maxWavePct: 0,
    maxAnchorAge: 0,
    maxBarsInTrade: 0,
    cooldownBars: 0,
    allowLong: 1,
    allowShort: 1,
    riskPct: 0.5,
    maxLeverage: 5,
    minQty: 0.001,
    qtyStep: 0.001,
  },
  paramSpec: [
    { key: "fractalN",       label: "Окно фрактала, баров",            type: "number", min: 1, max: 20, step: 1 },
    { key: "entryFrac",      label: "Вход: отход от пивота, волн",     type: "number", min: 0, max: 3, step: 0.05 },
    { key: "maxEntryFrac",   label: "Макс. отход для входа (0=выкл)",  type: "number", min: 0, max: 5, step: 0.05 },
    { key: "tpFrac",         label: "Тейк, волн (0=без тейка)",        type: "number", min: 0, max: 5, step: 0.05 },
    { key: "slFrac",         label: "Стоп, волн",                      type: "number", min: 0, max: 5, step: 0.05 },
    { key: "stopMode",       label: "Стоп: wave / pivot",              type: "string" },
    { key: "trailStartFrac", label: "Трейлинг: порог, волн (0=выкл)",  type: "number", min: 0, max: 5, step: 0.05 },
    { key: "trailDistFrac",  label: "Трейлинг: дистанция, волн",       type: "number", min: 0, max: 5, step: 0.05 },
    { key: "trailStepFrac",  label: "Трейлинг: шаг подтяжки, волн",    type: "number", min: 0, max: 2, step: 0.01 },
    { key: "trailAnchor",    label: "Трейлинг по: close / extreme",    type: "string" },
    { key: "trendFilter",    label: "Фильтр: off/highs/lows/any/both", type: "string" },
    { key: "minWavePct",     label: "Мин. волна, % цены (0=выкл)",     type: "number", min: 0, max: 10, step: 0.01 },
    { key: "maxWavePct",     label: "Макс. волна, % цены (0=выкл)",    type: "number", min: 0, max: 20, step: 0.01 },
    { key: "maxAnchorAge",   label: "Макс. возраст пивота, баров",     type: "number", min: 0, max: 500, step: 1 },
    { key: "maxBarsInTrade", label: "Макс. баров в сделке (0=выкл)",   type: "number", min: 0, max: 2000, step: 1 },
    { key: "cooldownBars",   label: "Пауза после сделки, баров",       type: "number", min: 0, max: 500, step: 1 },
    { key: "allowLong",      label: "Разрешить лонги (0/1)",           type: "number", min: 0, max: 1, step: 1 },
    { key: "allowShort",     label: "Разрешить шорты (0/1)",           type: "number", min: 0, max: 1, step: 1 },
    { key: "riskPct",        label: "Риск на сделку, % депозита",      type: "number", min: 0, max: 20, step: 0.05 },
    { key: "maxLeverage",    label: "Макс. плечо по номиналу",         type: "number", min: 0, max: 50, step: 0.5 },
    { key: "minQty",         label: "Мин. лот инструмента",            type: "number", min: 0, step: 0.001 },
    { key: "qtyStep",        label: "Шаг объёма",                      type: "number", min: 0, step: 0.001 },
  ],
  create(config) {
    return new FractalWaveBot(config);
  },
};
