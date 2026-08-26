// Extreme funding — trade against (or with) a crowded perpetual.
//
// The funding rate is the only signal in this project that is not derived from
// the price series: it is a direct reading of how lopsided the open interest
// is, and the settled figure is public at the moment of settlement. A large
// positive rate means longs are paying to stay long, which historically has
// preceded long squeezes; a large negative rate is the mirror.
//
// Two things about the mechanics matter more than the parameters.
//
// The rate is read from the settlement that fell inside the bar just closed,
// and the entry is a market order, so it fills at the NEXT bar's open. Nothing
// is decided on information the strategy did not already hold.
//
// The settlement interval is never assumed. Bybit runs 8h on most symbols, but
// the grid broke during the FTX collapse — SOLUSDT settled every two hours for
// a week — so "hold for N settlements" is counted in actual settlement events
// read off the history, not in hours.

import type { BotConfig, Side } from "../store";
import type { VenueOrder, VenuePosition } from "../execution/types";
import type { Bot, BotContext, BotFactory } from "./base";
import type { Candle } from "../types";
import { logInfo, logWarn } from "../eventBus";

/** One settlement. `time` is UTC seconds, matching the candle clock. */
export interface FundingPoint {
  time: number;
  rate: number;
}

const HISTORY = new Map<string, FundingPoint[]>();

/**
 * Supplies the settlement history the bot reasons on.
 *
 * The bot module stays free of any file or network access so it can be bundled
 * for the browser alongside the rest of the registry; whoever knows where the
 * history lives — a CLI preload, or the live Bybit client — pushes it in here.
 */
export function setFundingHistory(symbol: string, events: readonly FundingPoint[]): void {
  const clean = events
    .filter((e) => e && Number.isFinite(e.time) && Number.isFinite(e.rate))
    .map((e) => ({ time: Math.floor(e.time), rate: e.rate }))
    .sort((a, b) => a.time - b.time);
  HISTORY.set(symbol.toUpperCase(), clean);
}

export function getFundingHistory(symbol: string): readonly FundingPoint[] {
  return HISTORY.get(symbol.toUpperCase()) ?? [];
}

export function clearFundingHistory(): void {
  HISTORY.clear();
}

export type FundingDirection = "contrarian" | "momentum";
export type FundingSizeMode = "notional" | "risk";

export interface FundingExtremeParams {
  /** |rate| in basis points per settlement that counts as extreme. */
  thresholdBps: number;
  direction: FundingDirection;
  /** Consecutive same-signed extreme settlements required before entering. 1 = react to the first. */
  requireStreak: number;
  /** Settlements to hold before flattening. */
  holdSettlements: number;
  /** Hard cap in signal bars; 0 = only the settlement count exits. */
  maxBarsInTrade: number;
  stopPct: number;
  targetPct: number;
  /** Skip a signal whose absolute rate exceeds this — the FTX tail, if you want it out. */
  maxRateBps: number;
  allowLong: boolean;
  allowShort: boolean;
  sizeMode: FundingSizeMode;
  /** Position notional as a percentage of equity, for sizeMode "notional". */
  notionalPct: number;
  /** Equity fraction risked to the stop, for sizeMode "risk". */
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

export function parseFundingExtremeParams(raw: Record<string, number | string>): FundingExtremeParams {
  return {
    thresholdBps:     Math.max(0, num(raw.thresholdBps, 20)),
    direction:        oneOf(raw.direction, ["contrarian", "momentum"] as const, "contrarian"),
    requireStreak:    Math.max(1, int(raw.requireStreak, 1)),
    holdSettlements:  Math.max(1, int(raw.holdSettlements, 3)),
    maxBarsInTrade:   Math.max(0, int(raw.maxBarsInTrade, 0)),
    stopPct:          Math.max(0, num(raw.stopPct, 0)),
    targetPct:        Math.max(0, num(raw.targetPct, 0)),
    maxRateBps:       Math.max(0, num(raw.maxRateBps, 0)),
    allowLong:        flag(raw.allowLong, true),
    allowShort:       flag(raw.allowShort, true),
    sizeMode:         oneOf(raw.sizeMode, ["notional", "risk"] as const, "notional"),
    notionalPct:      Math.max(0, num(raw.notionalPct, 50)),
    riskPct:          Math.max(0, num(raw.riskPct, 0.5)),
    maxLeverage:      Math.max(0, num(raw.maxLeverage, 3)),
    minQty:           Math.max(0, num(raw.minQty, 0.001)),
    qtyStep:          Math.max(0, num(raw.qtyStep, 0.001)),
  };
}

/** Rounds down to the instrument step. Never up — that would take more risk than asked. */
export function quantiseDown(qty: number, step: number): number {
  if (!(qty > 0)) return 0;
  if (!(step > 0)) return qty;
  const units = Math.floor(qty / step + 1e-9);
  if (units <= 0) return 0;
  return Number((units * step).toFixed(12));
}

/**
 * The side to take given a settled rate.
 *
 * A positive rate means longs pay, so the crowd is long. Contrarian sells it,
 * momentum buys it.
 */
export function sideForRate(rate: number, direction: FundingDirection): Side | null {
  if (!Number.isFinite(rate) || rate === 0) return null;
  const crowdIsLong = rate > 0;
  if (direction === "contrarian") return crowdIsLong ? "sell" : "buy";
  return crowdIsLong ? "buy" : "sell";
}

/**
 * Length of the run of same-signed extremes ending at `index`, inclusive.
 * Used by `requireStreak`: one squeeze usually shows up as several consecutive
 * settlements, and reacting only to a sustained skew is a different bet from
 * reacting to a single print.
 */
export function extremeStreak(
  events: readonly FundingPoint[],
  index: number,
  thresholdBps: number,
): number {
  if (index < 0 || index >= events.length) return 0;
  const threshold = thresholdBps / 1e4;
  const rate = events[index].rate;
  if (Math.abs(rate) <= threshold) return 0;
  const sign = Math.sign(rate);
  let n = 0;
  for (let i = index; i >= 0; i--) {
    const r = events[i].rate;
    if (Math.abs(r) <= threshold || Math.sign(r) !== sign) break;
    n++;
  }
  return n;
}

interface SkipCounters {
  size: number;
  streak: number;
  cap: number;
  side: number;
}

class FundingExtremeBot implements Bot {
  config: BotConfig;

  private readonly p: FundingExtremeParams;
  private valid = true;

  private events: readonly FundingPoint[] = [];
  /** Index of the last settlement already handed to the strategy. */
  private cursor = 0;

  private pendingEntryIds: string[] = [];
  private stopIds: string[] = [];
  private targetIds: string[] = [];
  private entryBar: number | null = null;
  /** Settlement index at the moment of entry; the exit counts forward from it. */
  private entryEventIdx: number | null = null;

  private skips: SkipCounters = { size: 0, streak: 0, cap: 0, side: 0 };
  private signals = 0;
  private entriesPlaced = 0;
  private timedExits = 0;

  constructor(config: BotConfig) {
    this.config = config;
    this.p = parseFundingExtremeParams(config.params);
  }

  start(_ctx: BotContext): void {
    void _ctx;
    const p = this.p;
    this.events = getFundingHistory(this.config.symbol);
    if (this.events.length === 0) {
      this.valid = false;
      logWarn(
        `bot:${this.config.id}`,
        `no funding history for ${this.config.symbol} — call setFundingHistory() before the run`,
      );
      return;
    }
    if (!p.allowLong && !p.allowShort) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "both directions disabled");
      return;
    }
    if (p.sizeMode === "risk" && !(p.stopPct > 0)) {
      this.valid = false;
      logWarn(`bot:${this.config.id}`, "sizeMode risk needs stopPct > 0 — nothing to size against");
      return;
    }
    this.reset();
    logInfo(
      `bot:${this.config.id}`,
      `funding extreme started — ${p.direction}, |rate| > ${p.thresholdBps} bps, streak ${p.requireStreak}, ` +
      `hold ${p.holdSettlements} settlement(s), ${this.events.length} settlement(s) loaded`,
    );
  }

  stop(ctx: BotContext): void {
    const cancelled = ctx.cancelAllOrders();
    logInfo(
      `bot:${this.config.id}`,
      `funding extreme stopped — signals ${this.signals}, entries ${this.entriesPlaced}, ` +
      `timed exits ${this.timedExits}, skipped (streak) ${this.skips.streak}, (cap) ${this.skips.cap}, ` +
      `(side) ${this.skips.side}, (size) ${this.skips.size}, cancelled ${cancelled}`,
    );
    this.reset();
  }

  onOrderFilled(_ctx: BotContext, _order: VenueOrder, _fillPrice: number): void {
    void _ctx; void _order; void _fillPrice;
  }

  onBar(ctx: BotContext, bar: Candle, index: number): void {
    if (!this.valid) return;
    this.reconcile(ctx);

    const fresh = this.advance(bar.time);
    const position = this.position(ctx);

    if (position && this.manageOpen(ctx, position, index, bar)) return;
    if (fresh === null) return;
    if (position !== null || this.pendingEntryIds.length > 0) return;
    this.tryEnter(ctx, bar, index, fresh);
  }

  // --- funding cursor ------------------------------------------------------

  /**
   * Index of the newest settlement at or before `barTime`, but only when it
   * arrived on this bar. Returns null on every bar that carries no settlement,
   * which is all but three a day.
   */
  private advance(barTime: number): number | null {
    let latest: number | null = null;
    while (this.cursor < this.events.length && this.events[this.cursor].time <= barTime) {
      latest = this.cursor;
      this.cursor++;
    }
    return latest;
  }

  // --- state ---------------------------------------------------------------

  private reset(): void {
    this.cursor = 0;
    this.pendingEntryIds = [];
    this.stopIds = [];
    this.targetIds = [];
    this.entryBar = null;
    this.entryEventIdx = null;
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
    this.entryEventIdx = null;
  }

  private position(ctx: BotContext): VenuePosition | null {
    return ctx.getPositions().find((p) => p.symbol === this.config.symbol && p.qty > 0) ?? null;
  }

  // --- open position -------------------------------------------------------

  /** Returns true when the position was flattened on this bar. */
  private manageOpen(ctx: BotContext, position: VenuePosition, index: number, bar: Candle): boolean {
    const p = this.p;
    if (p.maxBarsInTrade > 0 && this.entryBar !== null && index - this.entryBar >= p.maxBarsInTrade) {
      this.flatten(ctx, position, bar.close);
      return true;
    }
    // The cursor has already been walked past every settlement up to this bar,
    // so its distance from the entry is the number of settlements lived through.
    if (this.entryEventIdx !== null && this.cursor - 1 - this.entryEventIdx >= p.holdSettlements) {
      this.timedExits += 1;
      this.flatten(ctx, position, bar.close);
      return true;
    }
    return false;
  }

  private flatten(ctx: BotContext, position: VenuePosition, refPrice: number): void {
    ctx.cancelAllOrders();
    this.pendingEntryIds = [];
    this.stopIds = [];
    this.targetIds = [];
    ctx.placeOrder({
      symbol: this.config.symbol,
      side: position.side === "buy" ? "sell" : "buy",
      type: "market",
      price: refPrice,
      qty: position.qty,
      reduceOnly: true,
    });
  }

  // --- entry ---------------------------------------------------------------

  private tryEnter(ctx: BotContext, bar: Candle, index: number, eventIdx: number): void {
    const p = this.p;
    const event = this.events[eventIdx];
    const rateBps = Math.abs(event.rate) * 1e4;
    if (rateBps <= p.thresholdBps) return;
    this.signals += 1;

    if (p.maxRateBps > 0 && rateBps > p.maxRateBps) {
      this.skips.cap += 1;
      return;
    }
    if (extremeStreak(this.events, eventIdx, p.thresholdBps) < p.requireStreak) {
      this.skips.streak += 1;
      return;
    }

    const side = sideForRate(event.rate, p.direction);
    if (side === null) return;
    if ((side === "buy" && !p.allowLong) || (side === "sell" && !p.allowShort)) {
      this.skips.side += 1;
      return;
    }

    const ref = bar.close;
    const stopDistance = p.stopPct > 0 ? ref * (p.stopPct / 100) : 0;
    const qty = this.positionSize(ctx, ref, stopDistance);
    if (qty <= 0) {
      this.skips.size += 1;
      return;
    }

    if (stopDistance > 0) {
      const stopPrice = side === "buy" ? ref - stopDistance : ref + stopDistance;
      if (stopPrice > 0) {
        const stop = ctx.placeOrder({
          symbol: this.config.symbol,
          side: side === "buy" ? "sell" : "buy",
          type: "stop",
          price: stopPrice,
          qty,
          reduceOnly: true,
        });
        if (stop.status === "pending") this.stopIds.push(stop.id);
      }
    }

    const entry = ctx.placeOrder({ symbol: this.config.symbol, side, type: "market", price: ref, qty });
    if (entry.status !== "pending") {
      for (const id of this.stopIds) ctx.cancelOrder(id, "entry rejected");
      this.stopIds = [];
      this.skips.size += 1;
      return;
    }

    this.pendingEntryIds.push(entry.id);
    this.entriesPlaced += 1;
    this.entryBar = index;
    this.entryEventIdx = eventIdx;

    if (p.targetPct > 0) {
      const move = ref * (p.targetPct / 100);
      const target = side === "buy" ? ref + move : ref - move;
      if (target > 0) {
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
  }

  private positionSize(ctx: BotContext, refPrice: number, stopDistance: number): number {
    const p = this.p;
    const equity = ctx.getBalance().equity;
    if (!(equity > 0) || !(refPrice > 0)) return 0;

    let qty: number;
    if (p.sizeMode === "risk") {
      if (!(stopDistance > 0) || !(p.riskPct > 0)) return 0;
      qty = (equity * (p.riskPct / 100)) / stopDistance;
    } else {
      if (!(p.notionalPct > 0)) return 0;
      qty = (equity * (p.notionalPct / 100)) / refPrice;
    }
    if (p.maxLeverage > 0) qty = Math.min(qty, (equity * p.maxLeverage) / refPrice);
    qty = quantiseDown(qty, p.qtyStep);
    if (qty + 1e-12 < p.minQty) return 0;
    return qty;
  }
}

export const fundingExtremeFactory: BotFactory = {
  kind: "funding-extreme",
  name: "Экстремальный фандинг",
  defaultParams: {
    thresholdBps: 20,
    direction: "contrarian",
    requireStreak: 1,
    holdSettlements: 3,
    maxBarsInTrade: 0,
    stopPct: 0,
    targetPct: 0,
    maxRateBps: 0,
    allowLong: 1,
    allowShort: 1,
    sizeMode: "notional",
    notionalPct: 50,
    riskPct: 0.5,
    maxLeverage: 3,
    minQty: 0.001,
    qtyStep: 0.001,
  },
  paramSpec: [
    { key: "thresholdBps",    label: "Порог |ставки|, б.п. за сеттлмент", type: "number", min: 0, max: 300, step: 1 },
    { key: "direction",       label: "Направление: contrarian / momentum", type: "string" },
    { key: "requireStreak",   label: "Подряд сеттлментов за порогом",     type: "number", min: 1, max: 20, step: 1 },
    { key: "holdSettlements", label: "Держать сеттлментов",               type: "number", min: 1, max: 60, step: 1 },
    { key: "maxBarsInTrade",  label: "Макс. баров в сделке (0=выкл)",     type: "number", min: 0, max: 20000, step: 1 },
    { key: "stopPct",         label: "Стоп, % от цены (0=выкл)",          type: "number", min: 0, max: 50, step: 0.1 },
    { key: "targetPct",       label: "Цель, % от цены (0=выкл)",          type: "number", min: 0, max: 50, step: 0.1 },
    { key: "maxRateBps",      label: "Игнорировать |ставку| выше, б.п.",  type: "number", min: 0, max: 300, step: 5 },
    { key: "allowLong",       label: "Разрешить лонги (0/1)",             type: "number", min: 0, max: 1, step: 1 },
    { key: "allowShort",      label: "Разрешить шорты (0/1)",             type: "number", min: 0, max: 1, step: 1 },
    { key: "sizeMode",        label: "Размер: notional / risk",           type: "string" },
    { key: "notionalPct",     label: "Номинал, % депозита",               type: "number", min: 0, max: 300, step: 5 },
    { key: "riskPct",         label: "Риск на сделку, % депозита",        type: "number", min: 0, max: 20, step: 0.05 },
    { key: "maxLeverage",     label: "Макс. плечо по номиналу",           type: "number", min: 0, max: 50, step: 0.5 },
    { key: "minQty",          label: "Мин. лот инструмента",              type: "number", min: 0, step: 0.001 },
    { key: "qtyStep",         label: "Шаг объёма",                        type: "number", min: 0, step: 0.001 },
  ],
  create(config) {
    return new FundingExtremeBot(config);
  },
};
