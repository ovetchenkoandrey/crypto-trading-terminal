/**
 * What raising the stake after a losing run does to the distribution of the
 * result.
 *
 * This file deliberately says nothing about whether the streaks are random. It
 * answers the second question, which stands on its own: *given* the strategy's
 * own trade distribution, what happens to the account when size is multiplied
 * after each loss. The answer is a change in shape — a long left tail traded
 * for a slightly higher chance of a small gain — and shape is exactly what an
 * equity curve hides until the day it does not.
 *
 * Units. Trades are expressed as R multiples: the payoff of a trade divided by
 * the size of a typical loss, so a losing trade sits near -1 R. Equity then
 * evolves as
 *
 *     E <- E * (1 + risk * R)
 *
 * where `risk` is the fraction of the account put behind one R. That is the
 * standard fractional-risk model, and it makes the martingale a single knob:
 * `risk` gets multiplied by `multiplier` after every consecutive loss.
 */

import type { Rng } from "./random.ts";

export interface MartingaleConfig {
  /** Fraction of equity risked on a trade that follows a win (1 R). */
  baseRisk: number;
  /** Stake multiplier applied per consecutive loss. 1 = flat sizing. */
  multiplier: number;
  /** Cap on consecutive multiplications. 0 means uncapped. */
  maxSteps: number;
  /** Equity fraction of the starting balance at which the account is dead. */
  ruinFloor: number;
  /** Stake off current equity (true) or off the starting balance (false). */
  compounding: boolean;
  /**
   * A real account cannot go below zero: the exchange closes the position and
   * the loss stops there. That truncation is a genuine gift to an escalating
   * scheme, and it is on by default because it is what happens.
   *
   * Turn it off to check the theorem in its exact form. Without truncation the
   * P&L process is a supermartingale under a negative per-trade edge, so mean
   * terminal equity is strictly below the starting balance for *every* sizing
   * rule. With truncation on, the arithmetic mean can be dragged above 1 by a
   * handful of lottery paths while the median sits at zero — which is precisely
   * the illusion the scheme is being sold on.
   */
  limitedLiability?: boolean;
}

export const FLAT: Omit<MartingaleConfig, "baseRisk" | "ruinFloor"> = {
  multiplier: 1,
  maxSteps: 0,
  compounding: true,
};

/** Risk fraction in force after `lossRun` consecutive losses. */
export function riskAfter(cfg: MartingaleConfig, lossRun: number): number {
  const steps = cfg.maxSteps > 0 ? Math.min(lossRun, cfg.maxSteps) : lossRun;
  return cfg.baseRisk * Math.pow(cfg.multiplier, steps);
}

/**
 * Equity multiple after `k` consecutive losses of `lossR` R each, starting from
 * a fresh sequence. Deterministic — this is the arithmetic of the scheme, with
 * no randomness anywhere in it.
 */
export function equityAfterLossRun(cfg: MartingaleConfig, k: number, lossR = 1): number {
  let equity = 1;
  for (let i = 0; i < k; i++) {
    const risk = riskAfter(cfg, i);
    const stake = cfg.compounding ? equity * risk : risk;
    equity -= stake * lossR;
    if (equity <= 0) return 0;
  }
  return equity;
}

/**
 * The number of consecutive losses that takes the account to `ruinFloor`.
 * `Infinity` when the scheme survives any run, which only happens with flat
 * compounding sizing.
 */
export function lossRunToRuin(cfg: MartingaleConfig, lossR = 1, limit = 200): number {
  let equity = 1;
  for (let k = 0; k < limit; k++) {
    const risk = riskAfter(cfg, k);
    const stake = cfg.compounding ? equity * risk : risk;
    equity -= stake * lossR;
    if (equity <= cfg.ruinFloor) return k + 1;
  }
  return Number.POSITIVE_INFINITY;
}

/**
 * Total risk already committed by the k-th trade of a run, as a multiple of the
 * base bet: 1 + m + m^2 + ... The number that makes people's eyes widen.
 */
export function cumulativeStakeMultiple(multiplier: number, k: number): number {
  if (k <= 0) return 0;
  if (multiplier === 1) return k;
  return (Math.pow(multiplier, k) - 1) / (multiplier - 1);
}

export interface MartingaleOutcome {
  iterations: number;
  tradesPerPath: number;
  /** Share of paths that touched the ruin floor. */
  ruinRate: number;
  /** Median trade index at which ruin happened, among the paths that died. */
  medianTradesToRuin: number;
  meanFinal: number;
  medianFinal: number;
  p05: number;
  p25: number;
  p75: number;
  p95: number;
  /** Median of each path's worst peak-to-trough drop, 0..1. */
  medianMaxDrawdown: number;
  /** Share of paths finishing above the starting balance. */
  winningPaths: number;
}

function pct(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return Number.NaN;
  const idx = q * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

/**
 * Bootstrap the strategy's own trades, in random order, through the sizing
 * scheme. Random order is the point: it is the independence null, so any
 * difference between schemes here is caused by the sizing alone and not by some
 * accident of the historical ordering.
 */
export function simulateMartingale(
  rMultiples: ArrayLike<number>,
  cfg: MartingaleConfig,
  tradesPerPath: number,
  iterations: number,
  rng: Rng,
): MartingaleOutcome {
  const m = rMultiples.length;
  if (m === 0) throw new Error("simulateMartingale needs at least one trade to resample");
  const finals: number[] = [];
  const drawdowns: number[] = [];
  const ruinAt: number[] = [];
  let ruined = 0;
  let winners = 0;

  for (let it = 0; it < iterations; it++) {
    let equity = 1;
    let peak = 1;
    let maxDd = 0;
    let lossRun = 0;
    let dead = false;
    for (let t = 0; t < tradesPerPath; t++) {
      const r = rMultiples[Math.floor(rng() * m)];
      const risk = riskAfter(cfg, lossRun);
      const stake = cfg.compounding ? equity * risk : risk;
      equity += stake * r;
      if (r > 0) lossRun = 0;
      else lossRun++;
      if (equity > peak) peak = equity;
      const dd = peak > 0 ? 1 - equity / peak : 1;
      if (dd > maxDd) maxDd = dd;
      if (equity <= cfg.ruinFloor) {
        if (cfg.limitedLiability !== false) equity = Math.max(0, equity);
        ruined++;
        ruinAt.push(t + 1);
        dead = true;
        break;
      }
    }
    finals.push(equity);
    drawdowns.push(maxDd);
    if (!dead && equity > 1) winners++;
  }

  const sortedFinal = [...finals].sort((a, b) => a - b);
  const sortedDd = [...drawdowns].sort((a, b) => a - b);
  const sortedRuin = [...ruinAt].sort((a, b) => a - b);
  return {
    iterations,
    tradesPerPath,
    ruinRate: ruined / iterations,
    medianTradesToRuin: sortedRuin.length ? pct(sortedRuin, 0.5) : Number.NaN,
    meanFinal: finals.reduce((a, b) => a + b, 0) / finals.length,
    medianFinal: pct(sortedFinal, 0.5),
    p05: pct(sortedFinal, 0.05),
    p25: pct(sortedFinal, 0.25),
    p75: pct(sortedFinal, 0.75),
    p95: pct(sortedFinal, 0.95),
    medianMaxDrawdown: pct(sortedDd, 0.5),
    winningPaths: winners / iterations,
  };
}

/**
 * Convert raw P&L into R multiples using the strategy's own mean loss as the
 * unit. Chosen over the standard deviation because the scheme under test sizes
 * off losses, and over a fixed stop distance because most of our bots do not
 * have one.
 */
export function toRMultiples(pnl: ArrayLike<number>): { r: Float64Array; unit: number } {
  let lossSum = 0;
  let lossCount = 0;
  for (let i = 0; i < pnl.length; i++) {
    if (pnl[i] < 0) {
      lossSum += -pnl[i];
      lossCount++;
    }
  }
  const unit = lossCount > 0 ? lossSum / lossCount : 1;
  const r = new Float64Array(pnl.length);
  const denom = unit > 0 ? unit : 1;
  for (let i = 0; i < pnl.length; i++) r[i] = pnl[i] / denom;
  return { r, unit };
}
