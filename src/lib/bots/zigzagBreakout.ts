// ZigZag continuation breakout — hypothesis 2 from docs/strategy-ideas.md.
//
// A ZigZag wave ends at a pivot. Once that pivot is CONFIRMED, price has by
// construction already moved away from it (the deviation threshold is what
// confirms it). The hypothesis is that after retracing a given fraction of the
// last wave, price resumes in the direction of that wave — a continuation, not
// a reversal. Take-profit and stop-loss are fractions of the same wave length,
// so every trade is sized in units of the structure that produced it.
//
// Look-ahead is the whole game here. `zigzag` reports an extreme at the bar
// where it happened, but that bar only becomes a pivot several bars later, when
// price has retraced far enough. Reading the raw pivot list index-by-index
// hands the strategy the top of a wave before the market knew it was a top, and
// manufactures profit that cannot exist. Two defences are stacked:
//
//   1. Pivots are computed from `ctx.history`, which is already cut at the bar
//      being processed — no future bar ever enters the computation.
//   2. The result is filtered through `pivotsAsOf`, which drops the trailing
//      unconfirmed extreme. "The last built pivot" means the last CONFIRMED
//      one; the running extreme is not a pivot yet and must not be traded.
//
// Fractals used by the trend filter are safe for the same reason: `fractals`
// never reports one within N bars of the end of the series it is given, and the
// series it is given ends at the current bar.

import type { BotConfig, Side } from "../store";
import type { VenueOrder, VenuePosition } from "../execution/types";
import type { Bot, BotContext, BotFactory } from "./base";
import type { Candle } from "../types";
import { zigzag, pivotsAsOf, fractals, type ZigzagPivot } from "../indicators/core";
import { logInfo, logWarn } from "../eventBus";
import { quantiseDown } from "./nightMeanReversion";

export type EntryMode = "pullback" | "breakout";
export type TrendFilter = "none" | "highs" | "both";
export type TrendSource = "zigzag" | "fractals";

export interface ZigzagBreakoutParams {
  /** ZigZag reversal threshold in percent — defines what counts as a wave. */
  deviationPct: number;
  /** Signal bars fed to ZigZag each bar. Must comfortably exceed a wave. */
  lookbackBars: number;
  entryMode: EntryMode;
  /** Retracement that arms the setup, as a fraction of the last wave. */
  pullbackFrac: number;
  /** Beyond this retracement the setup is abandoned. */
  maxPullbackFrac: number;
  /** Breakout mode: entry stop offset past the pivot, as a fraction of the wave. */
  breakoutBufferFrac: number;
  tpFrac: number;
  slFrac: number;
  trendFilter: TrendFilter;
  trendSource: TrendSource;
  fractalN: number;
  /** Wave length filters, in percent of price. 0 disables. */
  minWavePct: number;
  maxWavePct: number;
  /** Signal bars a setup stays valid after its pivot confirmed. 0 disables. */
  maxBarsToEntry: number;
  maxBarsInTrade: number;
  maxTradesPerPivot: number;
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

export function parseZigzagBreakoutParams(raw: Record<string, number | string>): ZigzagBreakoutParams {
  return {
    deviationPct:       Math.max(0, num(raw.deviationPct, 1)),
    lookbackBars:       Math.max(10, int(raw.lookbackBars, 400)),
    entryMode:          oneOf(raw.entryMode, ["pullback", "breakout"] as const, "pullback"),
    pullbackFrac:       Math.max(0, num(raw.pullbackFrac, 0.5)),
    maxPullbackFrac:    Math.max(0, num(raw.maxPullbackFrac, 1)),
    breakoutBufferFrac: Math.max(0, num(raw.breakoutBufferFrac, 0)),
    tpFrac:             Math.max(0, num(raw.tpFrac, 0.5)),
    slFrac:             Math.max(0, num(raw.slFrac, 0.5)),
    trendFilter:        oneOf(raw.trendFilter, ["none", "highs", "both"] as const, "none"),
    trendSource:        oneOf(raw.trendSource, ["zigzag", "fractals"] as const, "zigzag"),
    fractalN:           Math.max(1, int(raw.fractalN, 2)),
    minWavePct:         Math.max(0, num(raw.minWavePct, 0)),
    maxWavePct:         Math.max(0, num(raw.maxWavePct, 0)),
    maxBarsToEntry:     Math.max(0, int(raw.maxBarsToEntry, 0)),
    maxBarsInTrade:     Math.max(0, int(raw.maxBarsInTrade, 0)),
    maxTradesPerPivot:  Math.max(1, int(raw.maxTradesPerPivot, 1)),
    allowLong:          flag(raw.allowLong, true),
    allowShort:         flag(raw.allowShort, true),
    riskPct:            Math.max(0, num(raw.riskPct, 0.5)),
    maxLeverage:        Math.max(0, num(raw.maxLeverage, 5)),
    minQty:             Math.max(0, num(raw.minQty, 0.001)),
    qtyStep:            Math.max(0, num(raw.qtyStep, 0.001)),
  };
}

/**
 * Pivots a strategy may act on at the end of `bars`.
 *
 * `bars` must already be cut at the current bar. The `pivotsAsOf` filter then
 * removes the trailing extreme that ZigZag is still tracking: it has not
 * retraced enough to be a pivot, so treating it as one would be trading a top
 * that the market has not yet declared.
 */
export function visiblePivots(bars: Candle[], deviationPct: number): ZigzagPivot[] {
  if (bars.length === 0) return [];
  return pivotsAsOf(zigzag(bars, deviationPct), bars.length - 1);
}

/**
 * Trend agreement between the last two structures of the same kind.
 *
 * For a long setup the last wave was up, so the two most recent highs must be
 * ascending; "both" additionally demands ascending lows. Returns false when
 * there is not enough structure to judge — an unproven filter must block, not
 * wave things through.
 */
export function trendAgrees(
  highs: number[],
  lows: number[],
  side: Side,
  filter: TrendFilter,
): boolean {
  if (filter === "none") return true;

  const primary = side === "buy" ? highs : lows;
  if (primary.length < 2) return false;
  const a = primary[primary.length - 2];
  const b = primary[primary.length - 1];
  const primaryOk = side === "buy" ? b > a : b < a;
  if (!primaryOk) return false;
  if (filter === "highs") return true;

  const secondary = side === "buy" ? lows : highs;
  if (secondary.length < 2) return false;
  const c = secondary[secondary.length - 2];
  const d = secondary[secondary.length - 1];
  return side === "buy" ? d > c : d < c;
}

interface Setup {
  /** Pivot timestamp — stable identity across bars, unlike a window index. */
  key: number;
  side: Side;
  pivotPrice: number;
  wave: number;
  startIndex: number;
  trades: number;
  dead: boolean;
}

interface ActiveTrade {
  side: Side;
  qty: number;
  stopPrice: number;
  tpPrice: number;
  entryIndex: number;
}

interface SkipCounters {
  size: number;
  stop: number;
  trend: number;
  wave: number;
  expired: number;
}

class ZigzagBreakoutBot implements Bot {
  config: BotConfig;

  private readonly p: ZigzagBreakoutParams;
  private valid = true;

  private setup: Setup | null = null;
  private entryOrderId: string | null = null;
  /** Bracket parameters for an entry that has not filled yet (breakout mode). */
  private armed: { side: Side; wave: number; placedIndex: number } | null = null;
  private stopId: string | null = null;
  private tpId: string | null = null;
  private trade: ActiveTrade | null = null;

  private skips: SkipCounters = { size: 0, stop: 0, trend: 0, wave: 0, expired: 0 };
  private entriesPlaced = 0;

  constructor(config: BotConfig) {
    this.config = config;
    this.p = parseZigzagBreakoutParams(config.params);
  }

  start(_ctx: BotContext): void {
    void _ctx;
    const p = this.p;
    if (!(p.deviationPct > 0)) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "deviationPct must be > 0 — ZigZag would never build a wave");
      return;
    }
    if (!(p.slFrac > 0)) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "slFrac must be > 0 — position size is derived from the stop distance");
      return;
    }
    if (!(p.tpFrac > 0)) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "tpFrac must be > 0 — the trade would have no target");
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
      `zigzag breakout started — dev ${p.deviationPct}%, entry ${p.entryMode} @ ${p.pullbackFrac} of wave, ` +
      `tp ${p.tpFrac} / sl ${p.slFrac}, trend filter ${p.trendFilter}/${p.trendSource}, risk ${p.riskPct}%`,
    );
  }

  stop(ctx: BotContext): void {
    const cancelled = ctx.cancelAllOrders();
    const s = this.skips;
    this.reset();
    logInfo(
      `bot:${this.config.id}`,
      `zigzag breakout stopped — entries ${this.entriesPlaced}, skipped: size ${s.size}, stop ${s.stop}, ` +
      `trend ${s.trend}, wave ${s.wave}, expired ${s.expired}, cancelled ${cancelled}`,
    );
  }

  /**
   * Breakout entries fill from a resting stop order, so the bracket can only be
   * built once the fill price is known. Orders placed from here are matched
   * starting at the next bar — one execution bar of exposure, which is the
   * price of entering on a break rather than at a level chosen in advance.
   */
  onOrderFilled(ctx: BotContext, order: VenueOrder, fillPrice: number): void {
    if (this.entryOrderId === null || order.id !== this.entryOrderId) return;
    const armed = this.armed;
    this.entryOrderId = null;
    this.armed = null;
    if (!armed || this.trade !== null) return;
    this.openBrackets(ctx, armed.side, order.qty, fillPrice, armed.wave, -1);
  }

  onBar(ctx: BotContext, bar: Candle, index: number): void {
    if (!this.valid) return;
    this.reconcile(ctx);

    const position = this.position(ctx);
    if (this.trade !== null && this.trade.entryIndex < 0) this.trade.entryIndex = index;

    if (position) {
      this.manageOpen(ctx, position, bar, index);
      return;
    }

    if (this.entryOrderId !== null) {
      this.ageEntryOrder(ctx, index);
      return;
    }

    const bars = ctx.history.last(this.p.lookbackBars);
    const pivots = visiblePivots(bars, this.p.deviationPct);
    this.refreshSetup(pivots, index);
    this.tryEnter(ctx, bars, pivots, bar, index);
  }

  // ─── state ────────────────────────────────────────────────────────────────

  private reset(): void {
    this.setup = null;
    this.entryOrderId = null;
    this.armed = null;
    this.stopId = null;
    this.tpId = null;
    this.trade = null;
  }

  private hasWorkingOrders(): boolean {
    return this.entryOrderId !== null || this.stopId !== null || this.tpId !== null;
  }

  /**
   * Rebuilds the bot's view of its own orders from the venue. A bracket leg
   * that fired intrabar, or an order the venue refused, would otherwise leave
   * the bot convinced it still has protection resting.
   *
   * `getPendingOrders` scans every order the venue has ever seen, so it is only
   * asked while this bot actually has something working — otherwise an idle bot
   * makes a long run quadratic in the number of bars.
   */
  private reconcile(ctx: BotContext): void {
    if (this.hasWorkingOrders()) {
      const pending = new Set(ctx.getPendingOrders().map((o) => o.id));
      if (this.entryOrderId !== null && !pending.has(this.entryOrderId)) {
        this.entryOrderId = null;
        this.armed = null;
      }
      if (this.stopId !== null && !pending.has(this.stopId)) this.stopId = null;
      if (this.tpId !== null && !pending.has(this.tpId)) this.tpId = null;
    }

    if (this.position(ctx) !== null || this.entryOrderId !== null) return;

    // Flat with nothing inbound: the trade is over, drop whatever leg survived.
    if (this.stopId !== null) ctx.cancelOrder(this.stopId, "flat");
    if (this.tpId !== null) ctx.cancelOrder(this.tpId, "flat");
    this.stopId = null;
    this.tpId = null;
    this.trade = null;
  }

  private position(ctx: BotContext): VenuePosition | null {
    return ctx.getPositions().find((p) => p.symbol === this.config.symbol && p.qty > 0) ?? null;
  }

  // ─── setup tracking ───────────────────────────────────────────────────────

  /**
   * Derives the current setup from the last two confirmed pivots.
   *
   * A resting breakout entry is deliberately NOT cancelled here. Confirming the
   * pivot that ends a wave requires price to retrace by the deviation
   * threshold, and returning from that retracement to the old level requires at
   * least as much again — so the retracement low is always confirmed as a new
   * pivot before the old level can be re-broken. Cancelling on every structure
   * change would mean the re-break order never survives long enough to fill,
   * i.e. the hypothesis could never be tested at all. The order's lifetime is
   * bounded by `maxBarsToEntry` instead.
   */
  private refreshSetup(pivots: ZigzagPivot[], index: number): void {
    if (pivots.length < 2) {
      this.setup = null;
      return;
    }
    const last = pivots[pivots.length - 1];
    const prev = pivots[pivots.length - 2];
    if (this.setup && this.setup.key === last.time) return;

    const wave = Math.abs(last.price - prev.price);
    this.setup = {
      key: last.time,
      // Wave up (ends on a high) → the continuation of that wave is a long.
      side: last.kind === "high" ? "buy" : "sell",
      pivotPrice: last.price,
      wave,
      startIndex: index,
      trades: 0,
      dead: !(wave > 0),
    };
  }

  /** Withdraws a re-break order that has waited past its budget. */
  private ageEntryOrder(ctx: BotContext, index: number): void {
    const p = this.p;
    if (p.maxBarsToEntry <= 0 || this.armed === null || this.entryOrderId === null) return;
    if (index - this.armed.placedIndex <= p.maxBarsToEntry) return;
    ctx.cancelOrder(this.entryOrderId, "entry expired");
    this.entryOrderId = null;
    this.armed = null;
    this.skips.expired += 1;
  }

  // ─── open position ────────────────────────────────────────────────────────

  private manageOpen(ctx: BotContext, position: VenuePosition, bar: Candle, index: number): void {
    const p = this.p;
    const trade = this.trade;

    if (
      p.maxBarsInTrade > 0 && trade !== null &&
      trade.entryIndex >= 0 && index - trade.entryIndex >= p.maxBarsInTrade
    ) {
      if (this.stopId !== null) ctx.cancelOrder(this.stopId, "time exit");
      if (this.tpId !== null) ctx.cancelOrder(this.tpId, "time exit");
      this.stopId = null;
      this.tpId = null;
      ctx.placeOrder({
        symbol: this.config.symbol,
        side: position.side === "buy" ? "sell" : "buy",
        type: "market",
        price: bar.close,
        qty: position.qty,
        reduceOnly: true,
      });
      return;
    }

    if (trade === null) return;
    // Safety net: a leg the venue rejected leaves the position naked, so put it
    // back rather than run on the assumption that it is still there.
    if (this.stopId === null) {
      const stop = ctx.placeOrder({
        symbol: this.config.symbol,
        side: trade.side === "buy" ? "sell" : "buy",
        type: "stop",
        price: trade.stopPrice,
        qty: position.qty,
        reduceOnly: true,
      });
      if (stop.status === "pending") this.stopId = stop.id;
    }
    if (this.tpId === null) {
      const tp = ctx.placeOrder({
        symbol: this.config.symbol,
        side: trade.side === "buy" ? "sell" : "buy",
        type: "limit",
        price: trade.tpPrice,
        qty: position.qty,
        reduceOnly: true,
      });
      if (tp.status === "pending") this.tpId = tp.id;
    }
  }

  // ─── entry ────────────────────────────────────────────────────────────────

  private tryEnter(
    ctx: BotContext,
    bars: Candle[],
    pivots: ZigzagPivot[],
    bar: Candle,
    index: number,
  ): void {
    const p = this.p;
    const setup = this.setup;
    if (!setup || setup.dead) return;
    if (setup.trades >= p.maxTradesPerPivot) return;
    if (setup.side === "buy" && !p.allowLong) return;
    if (setup.side === "sell" && !p.allowShort) return;

    if (p.maxBarsToEntry > 0 && index - setup.startIndex > p.maxBarsToEntry) {
      setup.dead = true;
      this.skips.expired += 1;
      return;
    }

    const wavePct = bar.close > 0 ? (setup.wave / bar.close) * 100 : 0;
    if (p.minWavePct > 0 && wavePct < p.minWavePct) return;
    if (p.maxWavePct > 0 && wavePct > p.maxWavePct) {
      setup.dead = true;
      this.skips.wave += 1;
      return;
    }

    // Retracement away from the pivot, measured on closed bars only.
    const retrace = setup.side === "buy"
      ? setup.pivotPrice - bar.close
      : bar.close - setup.pivotPrice;
    const frac = retrace / setup.wave;
    if (frac > p.maxPullbackFrac) {
      setup.dead = true;
      return;
    }
    if (frac < p.pullbackFrac) return;

    if (!this.trendOk(bars, pivots, setup.side)) {
      this.skips.trend += 1;
      return;
    }

    if (p.entryMode === "breakout") {
      this.placeBreakoutEntry(ctx, setup, bar, index);
      return;
    }
    this.placePullbackEntry(ctx, setup, bar, index);
  }

  private trendOk(bars: Candle[], pivots: ZigzagPivot[], side: Side): boolean {
    const p = this.p;
    if (p.trendFilter === "none") return true;

    if (p.trendSource === "fractals") {
      const f = fractals(bars, p.fractalN);
      const highs = f.highs.map((i) => bars[i].high);
      const lows = f.lows.map((i) => bars[i].low);
      return trendAgrees(highs, lows, side, p.trendFilter);
    }

    const highs = pivots.filter((v) => v.kind === "high").map((v) => v.price);
    const lows = pivots.filter((v) => v.kind === "low").map((v) => v.price);
    return trendAgrees(highs, lows, side, p.trendFilter);
  }

  /**
   * Market entry at the retracement level. The stop goes in first so it is
   * already resting when the entry fills at the next bar's open — the venue
   * matches markets before stops, so the very first bar of the trade is
   * covered. A venue that will not take the stop kills the trade rather than
   * running it naked.
   */
  private placePullbackEntry(ctx: BotContext, setup: Setup, bar: Candle, index: number): void {
    const p = this.p;
    const ref = bar.close;
    const stopDistance = p.slFrac * setup.wave;
    const stopPrice = setup.side === "buy" ? ref - stopDistance : ref + stopDistance;
    if (!(stopDistance > 0) || !(stopPrice > 0)) {
      this.skips.stop += 1;
      return;
    }

    const qty = this.positionSize(ctx, ref, stopDistance);
    if (qty <= 0) {
      this.skips.size += 1;
      return;
    }

    if (!this.openBrackets(ctx, setup.side, qty, ref, setup.wave, index)) return;

    const entry = ctx.placeOrder({
      symbol: this.config.symbol,
      side: setup.side,
      type: "market",
      price: ref,
      qty,
    });
    if (entry.status !== "pending") {
      this.cancelBrackets(ctx, "entry rejected");
      this.skips.size += 1;
      return;
    }
    this.entryOrderId = entry.id;
    this.armed = null;   // brackets already live, no follow-up needed on fill
    setup.trades += 1;
    this.entriesPlaced += 1;
  }

  /**
   * Stop entry just past the pivot: the trade only starts if the break actually
   * happens. The bracket cannot be pre-placed here — a reduce-only stop with no
   * position behind it is cancelled by the venue the moment it triggers — so it
   * is built in `onOrderFilled` and rests from the next bar.
   */
  private placeBreakoutEntry(ctx: BotContext, setup: Setup, bar: Candle, index: number): void {
    const p = this.p;
    const buffer = p.breakoutBufferFrac * setup.wave;
    const trigger = setup.side === "buy"
      ? setup.pivotPrice + buffer
      : setup.pivotPrice - buffer;
    if (!(trigger > 0)) {
      this.skips.stop += 1;
      return;
    }
    // Price is already through the level: a stop order there would fill at once
    // at a price the break never offered. Wait for the next setup instead.
    if (setup.side === "buy" ? bar.close >= trigger : bar.close <= trigger) return;

    const stopDistance = p.slFrac * setup.wave;
    if (!(stopDistance > 0)) {
      this.skips.stop += 1;
      return;
    }
    const qty = this.positionSize(ctx, trigger, stopDistance);
    if (qty <= 0) {
      this.skips.size += 1;
      return;
    }

    const entry = ctx.placeOrder({
      symbol: this.config.symbol,
      side: setup.side,
      type: "stop",
      price: trigger,
      qty,
    });
    if (entry.status !== "pending") {
      this.skips.size += 1;
      return;
    }
    this.entryOrderId = entry.id;
    this.armed = { side: setup.side, wave: setup.wave, placedIndex: index };
    setup.trades += 1;
    this.entriesPlaced += 1;
  }

  /** Places stop and target around `ref`, both reduce-only. */
  private openBrackets(
    ctx: BotContext,
    side: Side,
    qty: number,
    ref: number,
    wave: number,
    entryIndex: number,
  ): boolean {
    const p = this.p;
    const stopPrice = side === "buy" ? ref - p.slFrac * wave : ref + p.slFrac * wave;
    const tpPrice   = side === "buy" ? ref + p.tpFrac * wave : ref - p.tpFrac * wave;
    if (!(stopPrice > 0) || !(tpPrice > 0)) {
      this.skips.stop += 1;
      return false;
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
      return false;
    }

    const tp = ctx.placeOrder({
      symbol: this.config.symbol,
      side: side === "buy" ? "sell" : "buy",
      type: "limit",
      price: tpPrice,
      qty,
      reduceOnly: true,
    });

    this.stopId = stop.id;
    this.tpId = tp.status === "pending" ? tp.id : null;
    this.trade = { side, qty, stopPrice, tpPrice, entryIndex };
    return true;
  }

  private cancelBrackets(ctx: BotContext, reason: string): void {
    if (this.stopId !== null) ctx.cancelOrder(this.stopId, reason);
    if (this.tpId !== null) ctx.cancelOrder(this.tpId, reason);
    this.stopId = null;
    this.tpId = null;
    this.trade = null;
  }

  /**
   * Size from risk: the fraction of equity lost if the stop is hit, divided by
   * the distance to it. Capped by notional leverage, then rounded DOWN to the
   * instrument step — a size below the exchange minimum skips the trade rather
   * than rounding up into more risk than was asked for.
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

export const zigzagBreakoutFactory: BotFactory = {
  kind: "zz-breakout",
  name: "Пробой после отхода от ZigZag",
  defaultParams: {
    deviationPct: 1,
    lookbackBars: 400,
    entryMode: "pullback",
    pullbackFrac: 0.5,
    maxPullbackFrac: 1,
    breakoutBufferFrac: 0,
    tpFrac: 0.5,
    slFrac: 0.5,
    trendFilter: "none",
    trendSource: "zigzag",
    fractalN: 2,
    minWavePct: 0,
    maxWavePct: 0,
    maxBarsToEntry: 0,
    maxBarsInTrade: 0,
    maxTradesPerPivot: 1,
    allowLong: 1,
    allowShort: 1,
    riskPct: 0.5,
    maxLeverage: 5,
    minQty: 0.001,
    qtyStep: 0.001,
  },
  paramSpec: [
    { key: "deviationPct",       label: "Порог ZigZag, %",                  type: "number", min: 0.05, max: 20, step: 0.05 },
    { key: "lookbackBars",       label: "Окно баров для ZigZag",            type: "number", min: 10, max: 5000, step: 10 },
    { key: "entryMode",          label: "Вход: pullback / breakout",        type: "string" },
    { key: "pullbackFrac",       label: "Отход для входа, доля волны",      type: "number", min: 0, max: 2, step: 0.05 },
    { key: "maxPullbackFrac",    label: "Макс. отход, доля волны",          type: "number", min: 0, max: 3, step: 0.05 },
    { key: "breakoutBufferFrac", label: "Отступ пробоя, доля волны",        type: "number", min: 0, max: 1, step: 0.01 },
    { key: "tpFrac",             label: "Take-profit, доля волны",          type: "number", min: 0.05, max: 5, step: 0.05 },
    { key: "slFrac",             label: "Stop-loss, доля волны",            type: "number", min: 0.05, max: 5, step: 0.05 },
    { key: "trendFilter",        label: "Фильтр тренда: none/highs/both",   type: "string" },
    { key: "trendSource",        label: "Источник: zigzag / fractals",      type: "string" },
    { key: "fractalN",           label: "Плечо фрактала",                   type: "number", min: 1, max: 10, step: 1 },
    { key: "minWavePct",         label: "Мин. волна, % цены (0=выкл)",      type: "number", min: 0, max: 20, step: 0.05 },
    { key: "maxWavePct",         label: "Макс. волна, % цены (0=выкл)",     type: "number", min: 0, max: 50, step: 0.05 },
    { key: "maxBarsToEntry",     label: "Макс. баров до входа (0=выкл)",    type: "number", min: 0, max: 1000, step: 1 },
    { key: "maxBarsInTrade",     label: "Макс. баров в сделке (0=выкл)",    type: "number", min: 0, max: 1000, step: 1 },
    { key: "maxTradesPerPivot",  label: "Сделок на один пивот",             type: "number", min: 1, max: 5, step: 1 },
    { key: "allowLong",          label: "Разрешить лонги (0/1)",            type: "number", min: 0, max: 1, step: 1 },
    { key: "allowShort",         label: "Разрешить шорты (0/1)",            type: "number", min: 0, max: 1, step: 1 },
    { key: "riskPct",            label: "Риск на сделку, % депозита",       type: "number", min: 0, max: 20, step: 0.05 },
    { key: "maxLeverage",        label: "Макс. плечо по номиналу",          type: "number", min: 0, max: 50, step: 0.5 },
    { key: "minQty",             label: "Мин. лот инструмента",             type: "number", min: 0, step: 0.001 },
    { key: "qtyStep",            label: "Шаг объёма",                       type: "number", min: 0, step: 0.001 },
  ],
  create(config) {
    return new ZigzagBreakoutBot(config);
  },
};
