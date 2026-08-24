// Order rejection / non-fill model.
//
// Bybit does not fill a market order at whatever price it can find: it converts it
// into an IOC limit inside a price band. If there is nothing to match inside that
// band, the order simply does not execute. A simulator that always fills — even at
// a bad price — is modelling a different exchange.
//
// The second half is queue position: a resting limit order touched by a bar has
// not necessarily been filled. Optimistic limit fills are what make grid backtests
// look printable.
//
// Determinism is non-negotiable. Math.random() would make two runs of the same
// backtest disagree, and then no result can be trusted or reproduced. Every draw
// here comes from a hash of (run seed + order identity), so it is stable across
// runs, stable across evaluation order, and independent between orders.

import type { OrderType, Side } from "../store";

export type RejectionReason =
  | "accepted"
  | "price_band"         // nothing inside the tolerance band — Bybit IOC semantics
  | "book_evaporated"    // stress window: top of book is gone
  | "thin_book"          // requested qty exceeds the estimated available liquidity
  | "queue_not_reached"  // resting limit was touched but the queue never cleared
  | "random_miss";       // residual probability of not getting filled

export interface StressWindow {
  /** UTC seconds, inclusive. Bar timestamps are compared against this. */
  fromSec: number;
  toSec:   number;
  /** Fraction of normal top-of-book depth still present. 0.08 = 92% gone. */
  depthRemaining: number;
  /** Extra spread on top of the expected slippage, in bps. */
  spreadBps: number;
  /** Multiplier on the residual miss probability. */
  rejectMultiplier: number;
  label?: string;
}

export interface RejectionSettings {
  enabled: boolean;
  /** Price band a taker tolerates. Beyond it the order does not execute at all. */
  slippageToleranceBps: number;
  /** Residual chance a taker order finds no counterparty on a normal bar. */
  baseRejectProb: number;
  maxRejectProb: number;
  /** Bar range (% of close) treated as normal for scaling the miss probability. */
  volatilityRefPct: number;
  volatilityMaxFactor: number;
  /** Chance a resting limit fills when the bar merely touches its price. */
  limitFillProbability: number;
  /** Penetration past the limit price (bps) at which the fill becomes certain. */
  limitFullFillPenetrationBps: number;
  stressWindows: StressWindow[];
}

/**
 * Reference magnitude from 10.10.2025: top-of-book depth collapsed by more than
 * 90% and spreads went from single-digit bps to double-digit percent.
 */
export const BOOK_EVAPORATION_DEPTH_REMAINING = 0.08;
export const BOOK_EVAPORATION_SPREAD_BPS = 500;

export const DEFAULT_REJECTION_SETTINGS: RejectionSettings = {
  enabled:                     true,
  slippageToleranceBps:        50,
  baseRejectProb:              0.001,
  maxRejectProb:               0.25,
  volatilityRefPct:            0.2,
  volatilityMaxFactor:         5,
  limitFillProbability:        0.6,
  limitFullFillPenetrationBps: 5,
  stressWindows:               [],
};

export interface RejectionInput {
  symbol: string;
  side:   Side;
  type:   OrderType;
  qty:    number;
  price:  number;
  /** Bar time, UTC seconds. Also feeds the deterministic draw. */
  barTime: number;
  /** Slippage the fill would incur, in bps — compared against the price band. */
  expectedSlippageBps?: number;
  /** Bar range as % of close — stands in for book thinness. */
  barRangePct?: number;
  /** Estimated qty available at the top of the book, in base units. */
  availableQty?: number;
  /** True when the order takes liquidity (market, stop, marketable limit). */
  crossedBook?: boolean;
  /** How far the bar traded through a resting limit price, in bps. */
  penetrationBps?: number;
}

export interface RejectionOptions {
  /** Run seed. Same seed + same orders = same rejections, always. */
  seed?: number;
  /** Replaces the deterministic draw. For tests and scenario replay. */
  roll?: number;
  /**
   * Overrides the identity the draw is keyed on. The default key includes qty and
   * price, so two neighbouring parameter sets in a sweep get different luck. Key on
   * something coarser (bar + symbol + side) to compare them under identical luck.
   */
  key?: string;
}

export interface RejectionDecision {
  accepted: boolean;
  reason: RejectionReason;
  /** Probability of the outcome that was drawn against. */
  probability: number;
  /** The draw in [0, 1). */
  roll: number;
  stress: StressWindow | null;
  detail: string;
}

/* ── deterministic randomness ─────────────────────────────────────────────── */

/** FNV-1a, 32 bit. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32 — small, fast, good enough, and identical on every platform. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * One stable draw for a given (seed, key). Stateless: the value does not depend
 * on how many draws happened before, so re-ordering or skipping orders cannot
 * shift the sequence.
 */
export function deterministicRoll(seed: number, key: string): number {
  const s = Number.isFinite(seed) ? Math.floor(seed) : 0;
  return mulberry32(hashString(`${s}|${key}`))();
}

/** Identity of an order for seeding. Stable across runs, unique within a run. */
export function rejectionKey(input: RejectionInput): string {
  return [
    input.symbol,
    input.barTime,
    input.side,
    input.type,
    input.qty,
    input.price,
  ].join("|");
}

/* ── model ────────────────────────────────────────────────────────────────── */

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return Math.min(hi, Math.max(lo, v));
}

function cfgOrDefault(cfg: RejectionSettings | undefined): RejectionSettings {
  if (!cfg) return DEFAULT_REJECTION_SETTINGS;
  const d = DEFAULT_REJECTION_SETTINGS;
  return {
    enabled:                     cfg.enabled !== false,
    slippageToleranceBps:        num(cfg.slippageToleranceBps, d.slippageToleranceBps, 0),
    baseRejectProb:              clamp(num(cfg.baseRejectProb, d.baseRejectProb, 0), 0, 1),
    maxRejectProb:               clamp(num(cfg.maxRejectProb, d.maxRejectProb, 0), 0, 1),
    volatilityRefPct:            num(cfg.volatilityRefPct, d.volatilityRefPct, 1e-9),
    volatilityMaxFactor:         num(cfg.volatilityMaxFactor, d.volatilityMaxFactor, 1),
    limitFillProbability:        clamp(num(cfg.limitFillProbability, d.limitFillProbability, 0), 0, 1),
    limitFullFillPenetrationBps: num(cfg.limitFullFillPenetrationBps, d.limitFullFillPenetrationBps, 1e-9),
    stressWindows:               Array.isArray(cfg.stressWindows) ? cfg.stressWindows : d.stressWindows,
  };
}

function num(v: number | undefined, fallback: number, min: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(min, v);
}

/** The stress window covering this bar time, if any. */
export function findStressWindow(
  barTimeSec: number,
  windows:    readonly StressWindow[] | undefined,
): StressWindow | null {
  if (!windows || !Number.isFinite(barTimeSec)) return null;
  for (const w of windows) {
    if (!w || !Number.isFinite(w.fromSec) || !Number.isFinite(w.toSec)) continue;
    if (barTimeSec >= w.fromSec && barTimeSec <= w.toSec) return w;
  }
  return null;
}

/** Builds a book-evaporation window with the 10.10.2025 magnitude as the default. */
export function makeStressWindow(
  fromSec:    number,
  toSec:      number,
  overrides?: Partial<Omit<StressWindow, "fromSec" | "toSec">>,
): StressWindow {
  return {
    fromSec,
    toSec,
    depthRemaining:   BOOK_EVAPORATION_DEPTH_REMAINING,
    spreadBps:        BOOK_EVAPORATION_SPREAD_BPS,
    rejectMultiplier: 50,
    label:            "book evaporated",
    ...overrides,
  };
}

/** The IOC limit price a Bybit market order is actually converted into. */
export function bandPrice(refPrice: number, side: Side, toleranceBps: number): number {
  if (!Number.isFinite(refPrice) || refPrice <= 0) return refPrice;
  const bps = Math.max(0, Number.isFinite(toleranceBps) ? toleranceBps : 0);
  const delta = refPrice * (bps / 10_000);
  return side === "buy" ? refPrice + delta : Math.max(0, refPrice - delta);
}

function accepted(roll: number, stress: StressWindow | null, detail: string): RejectionDecision {
  return { accepted: true, reason: "accepted", probability: 0, roll, stress, detail };
}

function rejected(
  reason: RejectionReason,
  probability: number,
  roll: number,
  stress: StressWindow | null,
  detail: string,
): RejectionDecision {
  return { accepted: false, reason, probability, roll, stress, detail };
}

/**
 * Decides whether the order executes at all.
 *
 * Hard checks come first (price band, evaporated book, not enough size), then a
 * single probabilistic draw. The draw is derived from the run seed and the order
 * identity, so the same backtest always produces the same rejections.
 */
export function evaluateRejection(
  input: RejectionInput,
  cfg:   RejectionSettings | undefined,
  opts:  RejectionOptions = {},
): RejectionDecision {
  const c = cfgOrDefault(cfg);
  const roll = Number.isFinite(opts.roll ?? NaN)
    ? clamp(opts.roll as number, 0, 1)
    : deterministicRoll(opts.seed ?? 0, opts.key ?? rejectionKey(input));

  const stress = findStressWindow(input.barTime, c.stressWindows);

  if (!c.enabled) return accepted(roll, stress, "rejection model disabled");

  const isTaker = input.type === "market" || input.type === "stop" || input.crossedBook === true;

  const volFactor = clamp(
    (Number.isFinite(input.barRangePct ?? NaN) ? (input.barRangePct as number) : c.volatilityRefPct) / c.volatilityRefPct,
    1,
    c.volatilityMaxFactor,
  );

  if (isTaker) {
    const extraSpread = stress ? Math.max(0, stress.spreadBps) : 0;
    const expected = (Number.isFinite(input.expectedSlippageBps ?? NaN) ? (input.expectedSlippageBps as number) : 0) + extraSpread;

    if (expected > c.slippageToleranceBps) {
      return rejected(
        stress ? "book_evaporated" : "price_band",
        1,
        roll,
        stress,
        `needed ${expected.toFixed(1)} bps, band is ${c.slippageToleranceBps} bps`,
      );
    }

    if (Number.isFinite(input.availableQty ?? NaN)) {
      const depth = (input.availableQty as number) * (stress ? clamp(stress.depthRemaining, 0, 1) : 1);
      if (Math.abs(input.qty) > depth) {
        return rejected(
          stress ? "book_evaporated" : "thin_book",
          1,
          roll,
          stress,
          `qty ${input.qty} vs depth ${depth}`,
        );
      }
    }

    const p = clamp(
      c.baseRejectProb * volFactor * (stress ? Math.max(1, stress.rejectMultiplier) : 1),
      0,
      c.maxRejectProb,
    );
    if (roll < p) return rejected("random_miss", p, roll, stress, `miss probability ${p.toFixed(4)}`);
    return accepted(roll, stress, "taker filled inside band");
  }

  // Resting limit: touch alone does not mean the queue cleared. Penetration past
  // the price does — the deeper the sweep, the more certain the fill.
  const penetration = Number.isFinite(input.penetrationBps ?? NaN) ? Math.max(0, input.penetrationBps as number) : 0;
  const certainty = clamp(penetration / c.limitFullFillPenetrationBps, 0, 1);
  let fillProb = c.limitFillProbability + (1 - c.limitFillProbability) * certainty;
  if (stress) fillProb *= clamp(stress.depthRemaining, 0, 1);
  fillProb = clamp(fillProb, 0, 1);

  if (roll >= fillProb) {
    return rejected(
      stress ? "book_evaporated" : "queue_not_reached",
      1 - fillProb,
      roll,
      stress,
      `fill probability ${fillProb.toFixed(4)}`,
    );
  }
  return accepted(roll, stress, `limit filled, probability ${fillProb.toFixed(4)}`);
}

export function describeRejection(cfg: RejectionSettings | undefined): string {
  const c = cfgOrDefault(cfg);
  if (!c.enabled) return "off";
  const parts = [
    `band ${c.slippageToleranceBps} bps`,
    `taker miss ${(c.baseRejectProb * 100).toFixed(2)}%`,
    `limit touch fill ${(c.limitFillProbability * 100).toFixed(0)}%`,
  ];
  if (c.stressWindows.length > 0) parts.push(`${c.stressWindows.length} stress window(s)`);
  return parts.join(", ");
}
