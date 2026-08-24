// Maker/taker fee model for paper and backtest execution.
//
// Bybit charges different rates for adding and removing liquidity. A single flat
// rate makes limit/grid strategies look 2-3x more expensive than they really are,
// and market strategies cheaper than they really are. Both directions are lies.

import type { OrderType } from "../store";

export type FeeRole = "maker" | "taker";

export interface FeeSettings {
  makerRate: number;   // fraction of notional, 0.0002 = 0.02%
  takerRate: number;   // fraction of notional, 0.00055 = 0.055%
}

/** Bybit USDT perpetual (linear), no VIP tier. Verified 24.08.2026. */
export const BYBIT_LINEAR_FEES: FeeSettings = { makerRate: 0.0002, takerRate: 0.00055 };

/** Bybit spot, no VIP tier. */
export const BYBIT_SPOT_FEES: FeeSettings = { makerRate: 0.001, takerRate: 0.001 };

/** Project default: we trade linear perpetuals. */
export const DEFAULT_FEE_SETTINGS: FeeSettings = { ...BYBIT_LINEAR_FEES };

export interface FeeRoleInput {
  type: OrderType;
  /** Limit order priced through the spread — it took liquidity, so it pays taker. */
  crossedBook?: boolean;
  /** PostOnly limit is maker by construction: the exchange rejects it otherwise. */
  postOnly?: boolean;
}

function sane(value: number | undefined, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  // Maker rebates (negative fees) exist on high VIP tiers but are not modelled:
  // paying zero is already the optimistic edge of what we can rely on.
  return Math.max(0, value);
}

/**
 * Fills in missing/garbage fields from the Bybit defaults. Never yields zero fees
 * by accident — an undefined config means "unknown", not "free".
 */
export function normalizeFeeSettings(cfg: FeeSettings | undefined): FeeSettings {
  if (!cfg) return { ...DEFAULT_FEE_SETTINGS };
  return {
    makerRate: sane(cfg.makerRate, DEFAULT_FEE_SETTINGS.makerRate),
    takerRate: sane(cfg.takerRate, DEFAULT_FEE_SETTINGS.takerRate),
  };
}

/** Rate for one role, as a fraction of notional. */
export function feeRateFor(role: FeeRole, cfg: FeeSettings | undefined): number {
  const c = normalizeFeeSettings(cfg);
  return role === "maker" ? c.makerRate : c.takerRate;
}

/** Fee in quote currency for a given notional. Always >= 0. */
export function computeFee(notional: number, role: FeeRole, cfg: FeeSettings | undefined): number {
  if (!Number.isFinite(notional)) return 0;
  return Math.abs(notional) * feeRateFor(role, cfg);
}

/** Fee for an order described by price and qty. */
export function computeOrderFee(
  price: number,
  qty:   number,
  role:  FeeRole,
  cfg:   FeeSettings | undefined,
): number {
  if (!Number.isFinite(price) || !Number.isFinite(qty)) return 0;
  return computeFee(Math.abs(price) * Math.abs(qty), role, cfg);
}

/** Entry + exit fee on the same notional — the number that actually eats the edge. */
export function computeRoundTripFee(
  notional:  number,
  entryRole: FeeRole,
  exitRole:  FeeRole,
  cfg:       FeeSettings | undefined,
): number {
  return computeFee(notional, entryRole, cfg) + computeFee(notional, exitRole, cfg);
}

/** Round-trip cost as a fraction of notional (0.0011 = 0.11% for taker/taker on linear). */
export function roundTripRate(
  entryRole: FeeRole,
  exitRole:  FeeRole,
  cfg:       FeeSettings | undefined,
): number {
  return feeRateFor(entryRole, cfg) + feeRateFor(exitRole, cfg);
}

/**
 * Which side of the book the order ended up on.
 * Market and stop orders always take. A limit order makes unless it was marketable
 * (crossed the spread) at placement time.
 */
export function inferFeeRole(input: FeeRoleInput): FeeRole {
  if (input.postOnly) return "maker";
  switch (input.type) {
    case "market": return "taker";
    case "stop":   return "taker";
    case "limit":  return input.crossedBook ? "taker" : "maker";
  }
}

/** Migration helper: the legacy single `feeRate` becomes the same rate on both sides. */
export function feeSettingsFromFlatRate(rate: number | undefined): FeeSettings {
  const r = sane(rate, DEFAULT_FEE_SETTINGS.takerRate);
  return { makerRate: r, takerRate: r };
}

export function describeFees(cfg: FeeSettings | undefined): string {
  const c = normalizeFeeSettings(cfg);
  const pct = (r: number) => `${(r * 100).toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}%`;
  return `maker ${pct(c.makerRate)} / taker ${pct(c.takerRate)}`;
}
