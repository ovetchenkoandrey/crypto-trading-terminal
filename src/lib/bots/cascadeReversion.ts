// Liquidation cascade reversion — fade the minute that moved far enough to be a
// forced-liquidation chain rather than a repricing, and hold for the snap back.
//
// The premise is mechanical, not statistical. A liquidation is a market order the
// holder did not choose to send; a chain of them walks the book past any price a
// willing participant would have paid, and when the chain runs out the quote
// returns toward where the willing participants still are. That is the only
// structure in this dataset whose measured size (tens of basis points) is larger
// than a round trip (eleven).
//
// Two things in here matter more than the parameters.
//
// The trigger threshold is estimated from a window that ends at the previous bar.
// A quantile taken over the whole series is look-ahead of the most seductive kind:
// it looks like a description of the market and behaves like a filter that knows
// which minutes turned out to be the biggest. `thresholdMode` therefore offers
// rolling and expanding estimators alongside the fixed number, and the fixed one
// exists so the difference can be measured rather than assumed.
//
// The exit is time, not a stop. Right after a cascade bar the one-minute range is
// enormous, so any stop close enough to bound the loss is hit by noise before the
// reversion has a chance; measurement showed every stop level from 30 to 400 bps
// cutting the edge roughly in half. The position is therefore bounded by
// `holdBars` and by size, and `stopMode` is off by default and kept only so the
// trade-off stays visible.

import type { BotConfig, Side } from "../store";
import type { VenueOrder, VenuePosition } from "../execution/types";
import type { Bot, BotContext, BotFactory } from "./base";
import type { Candle } from "../types";
import { atr } from "../indicators/core";
import { logInfo, logWarn } from "../eventBus";

const HOUR_SECONDS = 3600;

const ATR_WARMUP_FACTOR = 10;

export type ThresholdMode = "fixed" | "rolling" | "expanding" | "sigma";
export type Direction = "fade" | "follow";
export type CascadeStopMode = "none" | "pct" | "atr" | "move";
export type CascadeTargetMode = "none" | "pct" | "move";
export type SizeMode = "notional" | "risk";

export interface CascadeReversionParams {
  moveBars: number;
  thresholdMode: ThresholdMode;
  thresholdBps: number;
  percentile: number;
  lookbackBars: number;
  refreshBars: number;
  sigmaMult: number;
  sigmaWindow: number;
  minThresholdBps: number;
  maxThresholdBps: number;
  direction: Direction;
  allowLong: boolean;
  allowShort: boolean;
  holdBars: number;
  entryDelayBars: number;
  stopMode: CascadeStopMode;
  stopPct: number;
  stopAtrMult: number;
  stopMoveMult: number;
  targetMode: CascadeTargetMode;
  targetPct: number;
  targetMoveMult: number;
  cooldownBars: number;
  maxTradesPerDay: number;
  tradeStartHour: number;
  tradeEndHour: number;
  minVolumeMult: number;
  volumeWindow: number;
  minMoveAtrMult: number;
  atrPeriod: number;
  sizeMode: SizeMode;
  notionalPct: number;
  riskPct: number;
  maxLeverage: number;
  minQty: number;
  qtyStep: number;
  warmupBars: number;
}

/* ── parameter parsing ────────────────────────────────────────────────────── */

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

export function utcHour(timeSec: number): number {
  return ((Math.floor(timeSec / HOUR_SECONDS) % 24) + 24) % 24;
}

/** Half-open [startHour, endHour) in UTC; wraps midnight; start === end means all day. */
export function inWindow(timeSec: number, startHour: number, endHour: number): boolean {
  if (startHour === endHour) return true;
  const h = utcHour(timeSec);
  return startHour < endHour ? h >= startHour && h < endHour : h >= startHour || h < endHour;
}

/** Rounds down to the instrument step — never up, which would take unrequested risk. */
export function quantiseDown(qty: number, step: number): number {
  if (!(qty > 0)) return 0;
  if (!(step > 0)) return qty;
  const units = Math.floor(qty / step + 1e-9);
  if (units <= 0) return 0;
  return Number((units * step).toFixed(12));
}

export function parseCascadeParams(raw: Record<string, number | string>): CascadeReversionParams {
  return {
    moveBars:        Math.max(1, int(raw.moveBars, 1)),
    thresholdMode:   oneOf(raw.thresholdMode, ["fixed", "rolling", "expanding", "sigma"] as const, "expanding"),
    thresholdBps:    Math.max(0, num(raw.thresholdBps, 90)),
    percentile:      Math.min(0.999999, Math.max(0.5, num(raw.percentile, 0.9999))),
    lookbackBars:    Math.max(100, int(raw.lookbackBars, 129_600)),
    refreshBars:     Math.max(1, int(raw.refreshBars, 1440)),
    sigmaMult:       Math.max(0, num(raw.sigmaMult, 12)),
    sigmaWindow:     Math.max(30, int(raw.sigmaWindow, 1440)),
    minThresholdBps: Math.max(0, num(raw.minThresholdBps, 0)),
    maxThresholdBps: Math.max(0, num(raw.maxThresholdBps, 0)),
    direction:       oneOf(raw.direction, ["fade", "follow"] as const, "fade"),
    allowLong:       flag(raw.allowLong, true),
    allowShort:      flag(raw.allowShort, true),
    holdBars:        Math.max(1, int(raw.holdBars, 60)),
    entryDelayBars:  Math.max(0, int(raw.entryDelayBars, 0)),
    stopMode:        oneOf(raw.stopMode, ["none", "pct", "atr", "move"] as const, "none"),
    stopPct:         Math.max(0, num(raw.stopPct, 1)),
    stopAtrMult:     Math.max(0, num(raw.stopAtrMult, 3)),
    stopMoveMult:    Math.max(0, num(raw.stopMoveMult, 1)),
    targetMode:      oneOf(raw.targetMode, ["none", "pct", "move"] as const, "none"),
    targetPct:       Math.max(0, num(raw.targetPct, 0.5)),
    targetMoveMult:  Math.max(0, num(raw.targetMoveMult, 0.5)),
    cooldownBars:    Math.max(0, int(raw.cooldownBars, 60)),
    maxTradesPerDay: Math.max(0, int(raw.maxTradesPerDay, 0)),
    tradeStartHour:  hourParam(raw.tradeStartHour, 0),
    tradeEndHour:    hourParam(raw.tradeEndHour, 0),
    minVolumeMult:   Math.max(0, num(raw.minVolumeMult, 0)),
    volumeWindow:    Math.max(2, int(raw.volumeWindow, 60)),
    minMoveAtrMult:  Math.max(0, num(raw.minMoveAtrMult, 0)),
    atrPeriod:       Math.max(1, int(raw.atrPeriod, 14)),
    sizeMode:        oneOf(raw.sizeMode, ["notional", "risk"] as const, "notional"),
    notionalPct:     Math.max(0, num(raw.notionalPct, 100)),
    riskPct:         Math.max(0, num(raw.riskPct, 0.5)),
    maxLeverage:     Math.max(0, num(raw.maxLeverage, 3)),
    minQty:          Math.max(0, num(raw.minQty, 0.001)),
    qtyStep:         Math.max(0, num(raw.qtyStep, 0.001)),
    warmupBars:      Math.max(0, int(raw.warmupBars, 0)),
  };
}

/* ── quantile over a stream of absolute moves ─────────────────────────────── */

/**
 * Histogram quantile over |move| in basis points.
 *
 * Sorting a 90-day minute window on every refresh costs more than the whole
 * backtest, and the number wanted is a far tail, so the estimate is taken off a
 * fixed-bin histogram instead: 0.25 bps resolution where the thresholds actually
 * land, coarsening above, one saturating bin at the top. Adding and removing a
 * sample is O(1), which is what lets the same structure serve both the rolling
 * window (add and remove) and the expanding one (add only).
 *
 * The class holds no notion of time. Feeding it is the caller's job, and the
 * caller feeds it only bars that have already closed — that is where the
 * no-look-ahead guarantee lives.
 */
export class MoveQuantile {
  private static readonly FINE_MAX_BPS = 200;
  private static readonly FINE_WIDTH = 0.25;
  private static readonly MID_MAX_BPS = 1000;
  private static readonly MID_WIDTH = 1;
  private static readonly COARSE_MAX_BPS = 5000;
  private static readonly COARSE_WIDTH = 10;
  private static readonly FINE_BINS = MoveQuantile.FINE_MAX_BPS / MoveQuantile.FINE_WIDTH;
  private static readonly MID_BINS = (MoveQuantile.MID_MAX_BPS - MoveQuantile.FINE_MAX_BPS) / MoveQuantile.MID_WIDTH;
  private static readonly COARSE_BINS = (MoveQuantile.COARSE_MAX_BPS - MoveQuantile.MID_MAX_BPS) / MoveQuantile.COARSE_WIDTH;
  static readonly BIN_COUNT = MoveQuantile.FINE_BINS + MoveQuantile.MID_BINS + MoveQuantile.COARSE_BINS + 1;

  private readonly counts = new Int32Array(MoveQuantile.BIN_COUNT);
  private total = 0;

  static binOf(bps: number): number {
    const v = Number.isFinite(bps) ? Math.abs(bps) : 0;
    if (v < MoveQuantile.FINE_MAX_BPS) return Math.floor(v / MoveQuantile.FINE_WIDTH);
    if (v < MoveQuantile.MID_MAX_BPS) {
      return MoveQuantile.FINE_BINS + Math.floor((v - MoveQuantile.FINE_MAX_BPS) / MoveQuantile.MID_WIDTH);
    }
    if (v < MoveQuantile.COARSE_MAX_BPS) {
      return MoveQuantile.FINE_BINS + MoveQuantile.MID_BINS +
        Math.floor((v - MoveQuantile.MID_MAX_BPS) / MoveQuantile.COARSE_WIDTH);
    }
    return MoveQuantile.BIN_COUNT - 1;
  }

  /** Upper edge of a bin, in bps — the conservative reading of "at least this big". */
  static edgeOf(bin: number): number {
    if (bin < MoveQuantile.FINE_BINS) return (bin + 1) * MoveQuantile.FINE_WIDTH;
    if (bin < MoveQuantile.FINE_BINS + MoveQuantile.MID_BINS) {
      return MoveQuantile.FINE_MAX_BPS + (bin - MoveQuantile.FINE_BINS + 1) * MoveQuantile.MID_WIDTH;
    }
    if (bin < MoveQuantile.BIN_COUNT - 1) {
      return MoveQuantile.MID_MAX_BPS +
        (bin - MoveQuantile.FINE_BINS - MoveQuantile.MID_BINS + 1) * MoveQuantile.COARSE_WIDTH;
    }
    return MoveQuantile.COARSE_MAX_BPS;
  }

  get size(): number {
    return this.total;
  }

  add(bps: number): void {
    this.counts[MoveQuantile.binOf(bps)] += 1;
    this.total += 1;
  }

  remove(bps: number): void {
    const bin = MoveQuantile.binOf(bps);
    if (this.counts[bin] > 0) {
      this.counts[bin] -= 1;
      this.total -= 1;
    }
  }

  /**
   * Smallest bin edge at or above which the tail holds no more than (1 - p) of
   * the samples. Scanning down from the top keeps the cost proportional to how
   * far into the tail the quantile sits, which for the far tail is a few bins.
   */
  quantileBps(p: number): number {
    if (this.total <= 0) return Number.NaN;
    const wanted = (1 - p) * this.total;
    let tail = 0;
    for (let bin = MoveQuantile.BIN_COUNT - 1; bin >= 0; bin--) {
      tail += this.counts[bin];
      if (tail > wanted) return MoveQuantile.edgeOf(bin);
    }
    return 0;
  }
}

/* ── trigger state ────────────────────────────────────────────────────────── */

export interface CascadeTrigger {
  side: Side;
  moveBps: number;
  thresholdBps: number;
  refPrice: number;
}

/**
 * Threshold estimator over closed bars only.
 *
 * `observe` is called once per bar with that bar's move, and it is called after
 * the bar has been used for a decision. `thresholdBps` therefore always reflects
 * bars strictly older than the one being judged, which is the property the
 * strategy stands or falls on.
 */
export class CascadeThreshold {
  private readonly hist = new MoveQuantile();
  private readonly ring: Float64Array;
  private ringAt = 0;
  private ringFilled = false;
  private seen = 0;
  private sinceRefresh = 0;
  private cached = Number.NaN;

  private sum = 0;
  private sumSq = 0;
  private readonly sigRing: Float64Array;
  private sigAt = 0;
  private sigFilled = false;

  constructor(private readonly p: CascadeReversionParams) {
    this.ring = p.thresholdMode === "rolling" ? new Float64Array(p.lookbackBars) : new Float64Array(0);
    this.sigRing = new Float64Array(p.sigmaWindow);
  }

  get samples(): number {
    return this.seen;
  }

  /** Bars that must be observed before any threshold is offered. */
  get requiredSamples(): number {
    const p = this.p;
    if (p.warmupBars > 0) return p.warmupBars;
    switch (p.thresholdMode) {
      case "rolling":   return p.lookbackBars;
      case "expanding": return Math.min(p.lookbackBars, 43_200);
      case "sigma":     return p.sigmaWindow;
      default:          return 0;
    }
  }

  observe(moveBps: number): void {
    const p = this.p;
    const v = Number.isFinite(moveBps) ? Math.abs(moveBps) : 0;

    if (p.thresholdMode === "rolling") {
      if (this.ringFilled) this.hist.remove(this.ring[this.ringAt]);
      this.ring[this.ringAt] = v;
      this.ringAt = (this.ringAt + 1) % this.ring.length;
      if (this.ringAt === 0) this.ringFilled = true;
      this.hist.add(v);
    } else if (p.thresholdMode === "expanding") {
      this.hist.add(v);
    } else if (p.thresholdMode === "sigma") {
      const signed = moveBps;
      if (this.sigFilled) {
        const old = this.sigRing[this.sigAt];
        this.sum -= old;
        this.sumSq -= old * old;
      }
      this.sigRing[this.sigAt] = signed;
      this.sum += signed;
      this.sumSq += signed * signed;
      this.sigAt = (this.sigAt + 1) % this.sigRing.length;
      if (this.sigAt === 0) this.sigFilled = true;
    }

    this.seen += 1;
    this.sinceRefresh += 1;
  }

  /** Threshold in bps for the bar being judged, or NaN while still warming up. */
  thresholdBps(): number {
    const p = this.p;
    if (p.thresholdMode === "fixed") return this.clampThreshold(p.thresholdBps);
    if (this.seen < this.requiredSamples) return Number.NaN;

    if (p.thresholdMode === "sigma") {
      const n = this.sigFilled ? this.sigRing.length : this.sigAt;
      if (n < 30) return Number.NaN;
      const mean = this.sum / n;
      const variance = Math.max(0, this.sumSq / n - mean * mean);
      return this.clampThreshold(p.sigmaMult * Math.sqrt(variance));
    }

    if (!Number.isFinite(this.cached) || this.sinceRefresh >= p.refreshBars) {
      this.cached = this.hist.quantileBps(p.percentile);
      this.sinceRefresh = 0;
    }
    return this.clampThreshold(this.cached);
  }

  private clampThreshold(v: number): number {
    const p = this.p;
    if (!Number.isFinite(v)) return Number.NaN;
    let out = v;
    if (p.minThresholdBps > 0) out = Math.max(out, p.minThresholdBps);
    if (p.maxThresholdBps > 0) out = Math.min(out, p.maxThresholdBps);
    return out;
  }
}

/* ── bot ──────────────────────────────────────────────────────────────────── */

interface SkipCounters {
  warmup: number;
  cooldown: number;
  hour: number;
  volume: number;
  atr: number;
  size: number;
  cap: number;
}

class CascadeReversionBot implements Bot {
  config: BotConfig;

  private readonly p: CascadeReversionParams;
  private valid = true;

  private threshold: CascadeThreshold;
  private pendingEntryIds: string[] = [];
  private stopIds: string[] = [];
  private targetIds: string[] = [];
  private entryBar: number | null = null;
  private lastTriggerBar = -1e9;
  private armedFor: { bar: number; trigger: CascadeTrigger } | null = null;
  private tradesToday = 0;
  private dayKey = -1;

  private skips: SkipCounters = { warmup: 0, cooldown: 0, hour: 0, volume: 0, atr: 0, size: 0, cap: 0 };
  private triggersSeen = 0;
  private entriesPlaced = 0;
  private timedExits = 0;

  constructor(config: BotConfig) {
    this.config = config;
    this.p = parseCascadeParams(config.params);
    this.threshold = new CascadeThreshold(this.p);
  }

  start(_ctx: BotContext): void {
    void _ctx;
    const p = this.p;
    if (!p.allowLong && !p.allowShort) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "both directions disabled");
      return;
    }
    if (p.sizeMode === "notional" && !(p.notionalPct > 0)) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "notionalPct must be > 0 in notional sizing mode");
      return;
    }
    if (p.sizeMode === "risk" && (p.stopMode === "none" || !(p.riskPct > 0))) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "risk sizing needs a stop and riskPct > 0");
      return;
    }
    if (p.thresholdMode === "fixed" && !(p.thresholdBps > 0)) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "fixed threshold mode needs thresholdBps > 0");
      return;
    }
    this.reset();
    logInfo(
      `bot:${this.config.id}`,
      `cascade reversion started — ${p.direction} a ${p.moveBars}-bar move over the ${p.thresholdMode} threshold, ` +
      `hold ${p.holdBars} bars, stop ${p.stopMode}, size ${p.sizeMode}`,
    );
  }

  stop(ctx: BotContext): void {
    const cancelled = ctx.cancelAllOrders();
    const s = this.skips;
    logInfo(
      `bot:${this.config.id}`,
      `cascade reversion stopped — triggers ${this.triggersSeen}, entries ${this.entriesPlaced}, ` +
      `timed exits ${this.timedExits}, skipped warmup ${s.warmup}, cooldown ${s.cooldown}, hour ${s.hour}, ` +
      `volume ${s.volume}, atr ${s.atr}, size ${s.size}, daily cap ${s.cap}, cancelled ${cancelled}`,
    );
    this.reset();
  }

  onOrderFilled(_ctx: BotContext, _order: VenueOrder, _fillPrice: number): void {
    void _ctx; void _order; void _fillPrice;
  }

  onBar(ctx: BotContext, bar: Candle, index: number): void {
    if (!this.valid) return;
    this.reconcile(ctx);
    this.rollDay(bar.time);

    const move = this.moveBps(ctx);
    this.decide(ctx, bar, index, move);

    // Observed only after the bar has been judged: the threshold that admitted
    // this bar must not contain this bar.
    if (Number.isFinite(move)) this.threshold.observe(move);
  }

  /* ── decision ───────────────────────────────────────────────────────────── */

  /** Returns true when the bar was consumed by an exit and nothing else should run. */
  private decide(ctx: BotContext, bar: Candle, index: number, moveBps: number): boolean {
    const p = this.p;
    const position = this.position(ctx);

    if (position && this.manageOpen(ctx, position, index, bar)) return true;

    const armed = this.armedFor;
    if (armed && index >= armed.bar) {
      this.armedFor = null;
      if (!this.position(ctx) && this.pendingEntryIds.length === 0) this.enter(ctx, bar, index, armed.trigger);
      return false;
    }

    const thresholdBps = this.threshold.thresholdBps();
    if (!Number.isFinite(thresholdBps) || !(thresholdBps > 0)) {
      this.skips.warmup += 1;
      return false;
    }
    if (!Number.isFinite(moveBps) || Math.abs(moveBps) < thresholdBps) return false;

    this.triggersSeen += 1;

    if (index - this.lastTriggerBar < p.cooldownBars) {
      this.skips.cooldown += 1;
      return false;
    }
    this.lastTriggerBar = index;

    if (!inWindow(bar.time, p.tradeStartHour, p.tradeEndHour)) {
      this.skips.hour += 1;
      return false;
    }
    if (p.maxTradesPerDay > 0 && this.tradesToday >= p.maxTradesPerDay) {
      this.skips.cap += 1;
      return false;
    }
    if (!this.volumeOk(ctx, bar)) {
      this.skips.volume += 1;
      return false;
    }
    if (!this.atrOk(ctx, moveBps)) {
      this.skips.atr += 1;
      return false;
    }
    if (position !== null || this.pendingEntryIds.length > 0) return false;

    const against: Side = moveBps > 0 ? "sell" : "buy";
    const with_: Side = moveBps > 0 ? "buy" : "sell";
    const side = p.direction === "fade" ? against : with_;
    if (side === "buy" && !p.allowLong) return false;
    if (side === "sell" && !p.allowShort) return false;

    const trigger: CascadeTrigger = {
      side,
      moveBps: Math.abs(moveBps),
      thresholdBps,
      refPrice: bar.close,
    };

    if (p.entryDelayBars > 0) {
      this.armedFor = { bar: index + p.entryDelayBars, trigger };
      return false;
    }
    this.enter(ctx, bar, index, trigger);
    return false;
  }

  /**
   * Move of the last `moveBars` closed bars, in bps. Read from history, which is
   * cut at the bar being processed, so nothing ahead of it can contribute.
   */
  private moveBps(ctx: BotContext): number {
    const need = this.p.moveBars + 1;
    const bars = ctx.history.last(need);
    if (bars.length < need) return Number.NaN;
    const from = bars[0].close;
    const to = bars[bars.length - 1].close;
    if (!(from > 0) || !(to > 0)) return Number.NaN;
    return (to / from - 1) * 1e4;
  }

  private volumeOk(ctx: BotContext, bar: Candle): boolean {
    const p = this.p;
    if (!(p.minVolumeMult > 0)) return true;
    const bars = ctx.history.last(p.volumeWindow + 1);
    if (bars.length < 10) return false;
    const prior = bars.slice(0, bars.length - 1).map((b) => b.volume).sort((a, b) => a - b);
    const median = prior[Math.floor(prior.length / 2)];
    if (!(median > 0)) return true;
    return bar.volume >= median * p.minVolumeMult;
  }

  private atrOk(ctx: BotContext, moveBps: number): boolean {
    const p = this.p;
    if (!(p.minMoveAtrMult > 0)) return true;
    const value = this.atrNow(ctx);
    const price = ctx.history.current()?.close;
    if (value === null || !(value > 0) || !(price! > 0)) return false;
    const atrBps = (value / price!) * 1e4;
    return Math.abs(moveBps) >= atrBps * p.minMoveAtrMult;
  }

  private atrNow(ctx: BotContext): number | null {
    const p = this.p;
    const window = Math.max(p.atrPeriod * ATR_WARMUP_FACTOR, p.atrPeriod + 1);
    const bars = ctx.history.last(window);
    if (bars.length < p.atrPeriod + 1) return null;
    const series = atr(bars, p.atrPeriod);
    return series[series.length - 1];
  }

  /* ── entry ──────────────────────────────────────────────────────────────── */

  private enter(ctx: BotContext, bar: Candle, index: number, trigger: CascadeTrigger): void {
    const ref = bar.close;
    if (!(ref > 0)) return;

    const stopDistance = this.stopDistance(ctx, ref, trigger);
    const qty = this.positionSize(ctx, ref, stopDistance);
    if (qty <= 0) {
      this.skips.size += 1;
      return;
    }

    if (stopDistance > 0) {
      const stopPrice = trigger.side === "buy" ? ref - stopDistance : ref + stopDistance;
      if (stopPrice > 0) {
        const stop = ctx.placeOrder({
          symbol: this.config.symbol,
          side: trigger.side === "buy" ? "sell" : "buy",
          type: "stop",
          price: stopPrice,
          qty,
          reduceOnly: true,
        });
        if (stop.status === "pending") this.stopIds.push(stop.id);
      }
    }

    const entry = ctx.placeOrder({
      symbol: this.config.symbol,
      side: trigger.side,
      type: "market",
      price: ref,
      qty,
    });
    if (entry.status !== "pending") {
      this.cancelWorking(ctx);
      this.skips.size += 1;
      return;
    }

    this.pendingEntryIds.push(entry.id);
    this.entriesPlaced += 1;
    this.tradesToday += 1;
    this.entryBar = index;

    const target = this.targetPrice(ref, trigger);
    if (target !== null) {
      const order = ctx.placeOrder({
        symbol: this.config.symbol,
        side: trigger.side === "buy" ? "sell" : "buy",
        type: "limit",
        price: target,
        qty,
        reduceOnly: true,
      });
      if (order.status === "pending") this.targetIds.push(order.id);
    }
  }

  private stopDistance(ctx: BotContext, ref: number, trigger: CascadeTrigger): number {
    const p = this.p;
    switch (p.stopMode) {
      case "pct":  return ref * (p.stopPct / 100);
      case "move": return ref * ((trigger.moveBps * p.stopMoveMult) / 1e4);
      case "atr": {
        const value = this.atrNow(ctx);
        return value === null ? 0 : value * p.stopAtrMult;
      }
      default:     return 0;
    }
  }

  private targetPrice(ref: number, trigger: CascadeTrigger): number | null {
    const p = this.p;
    let move = 0;
    if (p.targetMode === "pct") move = ref * (p.targetPct / 100);
    else if (p.targetMode === "move") move = ref * ((trigger.moveBps * p.targetMoveMult) / 1e4);
    if (!(move > 0)) return null;
    const price = trigger.side === "buy" ? ref + move : ref - move;
    return price > 0 ? price : null;
  }

  /**
   * Notional sizing is the default because the default exit is time, not a stop:
   * with no stop there is no distance to divide risk by, and pretending otherwise
   * would report a risk figure the trade does not respect.
   */
  private positionSize(ctx: BotContext, refPrice: number, stopDistance: number): number {
    const p = this.p;
    const equity = ctx.getBalance().equity;
    if (!(equity > 0) || !(refPrice > 0)) return 0;

    let qty: number;
    if (p.sizeMode === "risk" && stopDistance > 0) {
      const risk = equity * (p.riskPct / 100);
      if (!(risk > 0)) return 0;
      qty = risk / stopDistance;
    } else {
      qty = (equity * (p.notionalPct / 100)) / refPrice;
    }

    if (p.maxLeverage > 0) qty = Math.min(qty, (equity * p.maxLeverage) / refPrice);
    qty = quantiseDown(qty, p.qtyStep);
    if (qty + 1e-12 < p.minQty) return 0;
    return qty;
  }

  /* ── open position ──────────────────────────────────────────────────────── */

  /**
   * Returns true when an exit was ordered on this bar.
   *
   * `entryBar` is deliberately left in place. The exit is a market order and the
   * venue can refuse it — that is precisely what a stress window models — and
   * clearing the counter here would rearm the whole holding period, leaving the
   * position open for another hour because one order missed. Keeping it means
   * the exit is retried on every subsequent bar until it fills; `reconcile`
   * clears the counter once the position is actually gone.
   */
  private manageOpen(ctx: BotContext, position: VenuePosition, index: number, bar: Candle): boolean {
    if (this.entryBar === null) this.entryBar = index;
    if (index - this.entryBar < this.p.holdBars) return false;
    this.cancelWorking(ctx);
    const exit = ctx.placeOrder({
      symbol: this.config.symbol,
      side: position.side === "buy" ? "sell" : "buy",
      type: "market",
      price: bar.close,
      qty: position.qty,
      reduceOnly: true,
    });
    if (exit.status === "pending") this.timedExits += 1;
    return true;
  }

  /* ── bookkeeping ────────────────────────────────────────────────────────── */

  private rollDay(timeSec: number): void {
    const day = Math.floor(timeSec / 86_400);
    if (day !== this.dayKey) {
      this.dayKey = day;
      this.tradesToday = 0;
    }
  }

  private reset(): void {
    this.pendingEntryIds = [];
    this.stopIds = [];
    this.targetIds = [];
    this.entryBar = null;
    this.lastTriggerBar = -1e9;
    this.armedFor = null;
    this.tradesToday = 0;
    this.dayKey = -1;
    this.threshold = new CascadeThreshold(this.p);
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

  private cancelWorking(ctx: BotContext): void {
    ctx.cancelAllOrders();
    this.pendingEntryIds = [];
    this.stopIds = [];
    this.targetIds = [];
  }

  private position(ctx: BotContext): VenuePosition | null {
    return ctx.getPositions().find((p) => p.symbol === this.config.symbol && p.qty > 0) ?? null;
  }
}

export const cascadeReversionFactory: BotFactory = {
  kind: "cascade-mr",
  name: "Возврат после ликвидационного каскада",
  defaultParams: {
    moveBars: 1,
    thresholdMode: "expanding",
    thresholdBps: 90,
    percentile: 0.9999,
    lookbackBars: 129600,
    refreshBars: 1440,
    sigmaMult: 12,
    sigmaWindow: 1440,
    minThresholdBps: 0,
    maxThresholdBps: 0,
    direction: "fade",
    allowLong: 1,
    allowShort: 1,
    holdBars: 60,
    entryDelayBars: 0,
    stopMode: "none",
    stopPct: 1,
    stopAtrMult: 3,
    stopMoveMult: 1,
    targetMode: "none",
    targetPct: 0.5,
    targetMoveMult: 0.5,
    cooldownBars: 60,
    maxTradesPerDay: 0,
    tradeStartHour: 0,
    tradeEndHour: 0,
    minVolumeMult: 0,
    volumeWindow: 60,
    minMoveAtrMult: 0,
    atrPeriod: 14,
    sizeMode: "notional",
    notionalPct: 100,
    riskPct: 0.5,
    maxLeverage: 3,
    minQty: 0.001,
    qtyStep: 0.001,
    warmupBars: 0,
  },
  paramSpec: [
    { key: "moveBars",        label: "Баров в движении",                        type: "number", min: 1,   max: 10,      step: 1 },
    { key: "thresholdMode",   label: "Порог: fixed / rolling / expanding / sigma", type: "string" },
    { key: "thresholdBps",    label: "Порог, б.п. (режим fixed)",               type: "number", min: 0,   max: 2000,    step: 1 },
    { key: "percentile",      label: "Процентиль порога",                       type: "number", min: 0.5, max: 0.999999, step: 0.0001 },
    { key: "lookbackBars",    label: "Окно оценки порога, баров",               type: "number", min: 100, max: 1000000, step: 1440 },
    { key: "refreshBars",     label: "Пересчёт порога раз в N баров",           type: "number", min: 1,   max: 100000,  step: 60 },
    { key: "sigmaMult",       label: "Множитель сигмы (режим sigma)",           type: "number", min: 0,   max: 50,      step: 0.5 },
    { key: "sigmaWindow",     label: "Окно сигмы, баров",                       type: "number", min: 30,  max: 100000,  step: 60 },
    { key: "minThresholdBps", label: "Нижний предел порога, б.п. (0=выкл)",     type: "number", min: 0,   max: 2000,    step: 1 },
    { key: "maxThresholdBps", label: "Верхний предел порога, б.п. (0=выкл)",    type: "number", min: 0,   max: 5000,    step: 1 },
    { key: "direction",       label: "Направление: fade / follow",              type: "string" },
    { key: "allowLong",       label: "Разрешить лонги (0/1)",                   type: "number", min: 0,   max: 1,       step: 1 },
    { key: "allowShort",      label: "Разрешить шорты (0/1)",                   type: "number", min: 0,   max: 1,       step: 1 },
    { key: "holdBars",        label: "Горизонт удержания, баров",               type: "number", min: 1,   max: 1440,    step: 1 },
    { key: "entryDelayBars",  label: "Задержка входа, баров",                   type: "number", min: 0,   max: 60,      step: 1 },
    { key: "stopMode",        label: "Стоп: none / pct / atr / move",           type: "string" },
    { key: "stopPct",         label: "Стоп, % от цены",                         type: "number", min: 0,   max: 20,      step: 0.1 },
    { key: "stopAtrMult",     label: "Стоп, множитель ATR",                     type: "number", min: 0,   max: 20,      step: 0.5 },
    { key: "stopMoveMult",    label: "Стоп, доля размера движения",             type: "number", min: 0,   max: 5,       step: 0.1 },
    { key: "targetMode",      label: "Цель: none / pct / move",                 type: "string" },
    { key: "targetPct",       label: "Цель, % от цены",                         type: "number", min: 0,   max: 20,      step: 0.1 },
    { key: "targetMoveMult",  label: "Цель, доля размера движения",             type: "number", min: 0,   max: 5,       step: 0.1 },
    { key: "cooldownBars",    label: "Пауза между входами, баров",              type: "number", min: 0,   max: 10000,   step: 10 },
    { key: "maxTradesPerDay", label: "Макс. сделок в сутки (0=выкл)",           type: "number", min: 0,   max: 100,     step: 1 },
    { key: "tradeStartHour",  label: "Начало окна торговли (час UTC)",          type: "number", min: 0,   max: 23,      step: 1 },
    { key: "tradeEndHour",    label: "Конец окна торговли (час UTC)",           type: "number", min: 0,   max: 23,      step: 1 },
    { key: "minVolumeMult",   label: "Мин. объём к медиане (0=выкл)",           type: "number", min: 0,   max: 50,      step: 0.5 },
    { key: "volumeWindow",    label: "Окно медианы объёма, баров",              type: "number", min: 2,   max: 10000,   step: 10 },
    { key: "minMoveAtrMult",  label: "Мин. движение в ATR (0=выкл)",            type: "number", min: 0,   max: 50,      step: 0.5 },
    { key: "atrPeriod",       label: "Период ATR",                              type: "number", min: 1,   max: 200,     step: 1 },
    { key: "sizeMode",        label: "Размер: notional / risk",                 type: "string" },
    { key: "notionalPct",     label: "Номинал, % депозита",                     type: "number", min: 0,   max: 1000,    step: 5 },
    { key: "riskPct",         label: "Риск на сделку, % депозита",              type: "number", min: 0,   max: 20,      step: 0.05 },
    { key: "maxLeverage",     label: "Макс. плечо по номиналу",                 type: "number", min: 0,   max: 50,      step: 0.5 },
    { key: "minQty",          label: "Мин. лот инструмента",                    type: "number", min: 0,                 step: 0.001 },
    { key: "qtyStep",         label: "Шаг объёма",                              type: "number", min: 0,                 step: 0.001 },
    { key: "warmupBars",      label: "Прогрев порога, баров (0=авто)",          type: "number", min: 0,   max: 1000000, step: 1440 },
  ],
  create(config) {
    return new CascadeReversionBot(config);
  },
};
