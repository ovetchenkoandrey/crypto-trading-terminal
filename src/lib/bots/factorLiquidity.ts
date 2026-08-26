import { fitLot, type LotSpec } from "../data/liquidityProfile.ts";
import type { FactorInput } from "./positioningFactor.ts";

/**
 * The positioning factor priced against the book it would actually trade.
 *
 * `positioningFactor.ts` charges one flat rate per unit of turnover — 5.5 basis
 * points, the taker fee, measured on BTCUSDT. That is the right shape for a
 * question about the signal and the wrong shape for a question about the coins:
 * the book holds TRB and COTI next to BTC and ETH, and it does not trade them
 * in equal amounts of turnover either.
 *
 * Three things change here and nothing else:
 *
 *  1. cost is per symbol, so a rebalance that rotates through the thin end of
 *     the board pays for the thin end;
 *  2. weights pass through the exchange's LOT_SIZE and MIN_NOTIONAL filters at
 *     the price of the bar, so a 1000 USDT account gets the basket it can
 *     actually buy rather than the one on paper;
 *  3. a name the account cannot trade at all is dropped rather than resized,
 *     and the gross exposure that goes missing is reported instead of hidden.
 */

export interface LiquidityFactorParams {
  /** Fraction of the board taken on each side, 0.02..0.5. */
  side: number;
  rebalanceBars: number;
  /** Cross-section breadth required before a date is traded. */
  minSymbols: number;
  contrarian: boolean;
  longOnly: boolean;
  grossLeverage: number;
  startOffset?: number;
  /** Cost of one side of one unit of turnover, per symbol index, basis points. */
  costBpsPerSide: Float64Array;
  /** Exchange filters per symbol index; when present, weights are floored to a lot. */
  lots?: (LotSpec | null)[];
  /** Notional the weights are scaled to, USDT. Required for lot rounding. */
  bookNotionalUsdt?: number;
  /** Symbols excluded from the ranking universe entirely. */
  excluded?: boolean[];
}

export interface LiquidityFactorPeriod {
  fromIndex: number;
  toIndex: number;
  fromTime: number;
  toTime: number;
  longs: number;
  shorts: number;
  grossBps: number;
  turnover: number;
  costBps: number;
  netBps: number;
  boardBps: number;
  /** Sum of absolute realised weights — 1.0 when nothing was dropped. */
  exposure: number;
  /** Sum of |target - realised| across names, the rounding damage. */
  weightErrorL1: number;
  droppedNames: number;
}

export interface LiquidityFactorResult {
  periods: LiquidityFactorPeriod[];
  grossBps: number;
  costBps: number;
  netBps: number;
  boardBps: number;
  netSeBps: number;
  netT: number;
  meanTurnover: number;
  meanExposure: number;
  meanWeightErrorL1: number;
  meanDroppedNames: number;
  equity: number;
  maxDrawdown: number;
  sharpe: number;
  annualReturnPct: number;
  winRate: number;
  tradesPerYear: number;
  alphaBps: number;
  alphaT: number;
  beta: number;
  betaT: number;
  /** Turnover spent on each symbol over the whole run, for cost attribution. */
  turnoverBySymbol: Float64Array;
  /** Net contribution of each symbol to the book, basis points per period. */
  contributionBySymbol: Float64Array;
}

interface Slot {
  index: number;
  value: number;
}

function targetWeights(
  input: FactorInput,
  t: number,
  params: LiquidityFactorParams,
): Map<number, number> | null {
  const eligible: Slot[] = [];
  for (let s = 0; s < input.symbols.length; s++) {
    if (params.excluded?.[s]) continue;
    const f = input.feature[s][t];
    const c = input.close[s][t];
    if (!Number.isFinite(f) || !(c > 0)) continue;
    eligible.push({ index: s, value: f });
  }
  if (eligible.length < params.minSymbols) return null;
  eligible.sort((a, b) => a.value - b.value);
  const k = eligible.length;
  const take = Math.max(1, Math.round(k * Math.min(0.5, Math.max(0.02, params.side))));

  const weights = new Map<number, number>();
  const legs = params.longOnly ? 1 : 2;
  const perName = params.grossLeverage / (legs * take);
  const lowSide = params.contrarian ? 1 : -1;
  for (let i = 0; i < take; i++) {
    const low = eligible[i].index;
    const high = eligible[k - 1 - i].index;
    weights.set(low, (weights.get(low) ?? 0) + lowSide * perName);
    if (!params.longOnly) weights.set(high, (weights.get(high) ?? 0) - lowSide * perName);
  }
  return weights;
}

/**
 * Rounds the target book to what the exchange will accept.
 *
 * Quantity is floored, so a name whose lot is worth more than its target slot
 * disappears instead of doubling. On a 1000 USDT account that is not a corner
 * case: 0.001 BTC is a hundred-odd dollars all by itself.
 */
function applyLots(
  target: Map<number, number>,
  input: FactorInput,
  t: number,
  params: LiquidityFactorParams,
): { weights: Map<number, number>; errorL1: number; dropped: number } {
  const notional = params.bookNotionalUsdt;
  if (!params.lots || !(notional !== undefined && notional > 0)) {
    return { weights: target, errorL1: 0, dropped: 0 };
  }
  const out = new Map<number, number>();
  let errorL1 = 0;
  let dropped = 0;
  for (const [s, w] of target) {
    const lot = params.lots[s];
    const price = input.close[s][t];
    if (!lot || !(price > 0)) {
      errorL1 += Math.abs(w);
      dropped++;
      continue;
    }
    const fit = fitLot(Math.abs(w) * notional, price, lot);
    if (!fit.tradable) {
      errorL1 += Math.abs(w);
      dropped++;
      continue;
    }
    const real = Math.sign(w) * (fit.notionalUsdt / notional);
    errorL1 += Math.abs(w - real);
    if (real !== 0) out.set(s, real);
  }
  return { weights: out, errorL1, dropped };
}

export function runLiquidityFactor(
  input: FactorInput,
  params: LiquidityFactorParams,
): LiquidityFactorResult {
  const step = Math.max(1, Math.floor(params.rebalanceBars));
  const n = input.symbols.length;
  const periods: LiquidityFactorPeriod[] = [];
  const turnoverBySymbol = new Float64Array(n);
  const contributionBySymbol = new Float64Array(n);
  let held = new Map<number, number>();
  let equity = 1;
  let peak = 1;
  let maxDd = 0;
  let turnoverTotal = 0;

  const start = Math.max(0, Math.floor(params.startOffset ?? 0)) % step;
  for (let t = start; t + step < input.times.length; t += step) {
    const raw = targetWeights(input, t, params);
    const fitted = raw ? applyLots(raw, input, t, params) : { weights: new Map<number, number>(), errorL1: 0, dropped: 0 };
    const next = fitted.weights;

    let turnover = 0;
    let cost = 0;
    const names = new Set<number>([...held.keys(), ...next.keys()]);
    for (const s of names) {
      const d = Math.abs((next.get(s) ?? 0) - (held.get(s) ?? 0));
      if (!(d > 0)) continue;
      turnover += d;
      turnoverBySymbol[s] += d;
      const c = params.costBpsPerSide[s];
      cost += d * (Number.isFinite(c) ? c : 0) / 1e4;
    }
    turnoverTotal += turnover;

    let gross = 0;
    let boardSum = 0;
    let boardCount = 0;
    let longs = 0;
    let shorts = 0;
    let exposure = 0;
    for (let s = 0; s < n; s++) {
      const a = input.close[s][t];
      const b = input.close[s][t + step];
      if (!(a > 0) || !(b > 0)) continue;
      const r = b / a - 1;
      boardSum += r;
      boardCount++;
      const w = next.get(s);
      if (w === undefined || w === 0) continue;
      gross += w * r;
      contributionBySymbol[s] += w * r * 1e4;
      exposure += Math.abs(w);
      if (w > 0) longs++;
      else shorts++;
    }

    const net = gross - cost;
    equity *= 1 + net;
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? 1 - equity / peak : 0;
    if (dd > maxDd) maxDd = dd;

    periods.push({
      fromIndex: t,
      toIndex: t + step,
      fromTime: input.times[t],
      toTime: input.times[t + step],
      longs,
      shorts,
      grossBps: gross * 1e4,
      turnover,
      costBps: cost * 1e4,
      netBps: net * 1e4,
      boardBps: boardCount > 0 ? (boardSum / boardCount) * 1e4 : Number.NaN,
      exposure,
      weightErrorL1: fitted.errorL1,
      droppedNames: fitted.dropped,
    });
    held = next;
  }

  const count = periods.length;
  const empty: LiquidityFactorResult = {
    periods,
    grossBps: Number.NaN,
    costBps: Number.NaN,
    netBps: Number.NaN,
    boardBps: Number.NaN,
    netSeBps: Number.NaN,
    netT: Number.NaN,
    meanTurnover: Number.NaN,
    meanExposure: Number.NaN,
    meanWeightErrorL1: Number.NaN,
    meanDroppedNames: Number.NaN,
    equity,
    maxDrawdown: maxDd,
    sharpe: Number.NaN,
    annualReturnPct: Number.NaN,
    winRate: Number.NaN,
    tradesPerYear: Number.NaN,
    alphaBps: Number.NaN,
    alphaT: Number.NaN,
    beta: Number.NaN,
    betaT: Number.NaN,
    turnoverBySymbol,
    contributionBySymbol,
  };
  if (count < 5) return empty;

  const mean = (get: (p: LiquidityFactorPeriod) => number): number => {
    let sum = 0;
    let k = 0;
    for (const p of periods) {
      const v = get(p);
      if (!Number.isFinite(v)) continue;
      sum += v;
      k++;
    }
    return k > 0 ? sum / k : Number.NaN;
  };

  const netMean = mean((p) => p.netBps);
  let sq = 0;
  for (const p of periods) sq += (p.netBps - netMean) ** 2;
  const netSd = Math.sqrt(sq / (count - 1));
  const netSe = netSd / Math.sqrt(count);

  const spanSec = input.times[periods[count - 1].toIndex] - input.times[periods[0].fromIndex];
  const years = spanSec > 0 ? spanSec / (365.25 * 86400) : Number.NaN;
  const periodsPerYear = Number.isFinite(years) && years > 0 ? count / years : Number.NaN;
  for (let s = 0; s < n; s++) contributionBySymbol[s] /= count;

  return {
    periods,
    grossBps: mean((p) => p.grossBps),
    costBps: mean((p) => p.costBps),
    netBps: netMean,
    boardBps: mean((p) => p.boardBps),
    netSeBps: netSe,
    netT: netMean / netSe,
    meanTurnover: turnoverTotal / count,
    meanExposure: mean((p) => p.exposure),
    meanWeightErrorL1: mean((p) => p.weightErrorL1),
    meanDroppedNames: mean((p) => p.droppedNames),
    equity,
    maxDrawdown: maxDd,
    sharpe: netSd > 0 ? (netMean / netSd) * Math.sqrt(periodsPerYear) : Number.NaN,
    annualReturnPct: Number.isFinite(years) && years > 0 ? (equity ** (1 / years) - 1) * 100 : Number.NaN,
    winRate: periods.filter((p) => p.netBps > 0).length / count,
    tradesPerYear: (turnoverTotal / count) * periodsPerYear,
    ...regressOnBoard(periods),
    turnoverBySymbol,
    contributionBySymbol,
  };
}

function regressOnBoard(periods: readonly LiquidityFactorPeriod[]): {
  alphaBps: number;
  alphaT: number;
  beta: number;
  betaT: number;
} {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of periods) {
    if (!Number.isFinite(p.boardBps) || !Number.isFinite(p.netBps)) continue;
    xs.push(p.boardBps);
    ys.push(p.netBps);
  }
  const n = xs.length;
  const empty = { alphaBps: Number.NaN, alphaT: Number.NaN, beta: Number.NaN, betaT: Number.NaN };
  if (n < 20) return empty;
  let mx = 0;
  let my = 0;
  for (let i = 0; i < n; i++) {
    mx += xs[i];
    my += ys[i];
  }
  mx /= n;
  my /= n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  if (!(sxx > 0)) return empty;
  const beta = sxy / sxx;
  const alpha = my - beta * mx;
  let rss = 0;
  for (let i = 0; i < n; i++) rss += (ys[i] - alpha - beta * xs[i]) ** 2;
  const sigma2 = rss / (n - 2);
  return {
    alphaBps: alpha,
    alphaT: alpha / Math.sqrt(sigma2 * (1 / n + (mx * mx) / sxx)),
    beta,
    betaT: beta / Math.sqrt(sigma2 / sxx),
  };
}

/* ── staggered schedules ──────────────────────────────────────────────────── */

export interface LiquiditySleeveSummary {
  sleeves: number;
  netBps: number;
  netSdAcrossSleeves: number;
  minNetBps: number;
  maxNetBps: number;
  meanT: number;
  meanSharpe: number;
  meanTurnover: number;
  meanAnnualPct: number;
  meanMaxDrawdown: number;
  meanExposure: number;
  agree: number;
}

/** Every staggered entry hour instead of the one nobody chose deliberately. */
export function runLiquiditySleeves(
  input: FactorInput,
  params: LiquidityFactorParams,
  sleeves: number,
): LiquiditySleeveSummary {
  const step = Math.max(1, Math.floor(params.rebalanceBars));
  const wanted = Math.max(1, Math.min(sleeves, step));
  const stride = Math.max(1, Math.floor(step / wanted));
  const runs: LiquidityFactorResult[] = [];
  for (let i = 0; i < wanted; i++) {
    const r = runLiquidityFactor(input, { ...params, startOffset: i * stride });
    if (Number.isFinite(r.netBps)) runs.push(r);
  }
  const blank: LiquiditySleeveSummary = {
    sleeves: 0,
    netBps: Number.NaN,
    netSdAcrossSleeves: Number.NaN,
    minNetBps: Number.NaN,
    maxNetBps: Number.NaN,
    meanT: Number.NaN,
    meanSharpe: Number.NaN,
    meanTurnover: Number.NaN,
    meanAnnualPct: Number.NaN,
    meanMaxDrawdown: Number.NaN,
    meanExposure: Number.NaN,
    agree: 0,
  };
  if (runs.length === 0) return blank;
  const mean = (get: (r: LiquidityFactorResult) => number): number => {
    let sum = 0;
    let k = 0;
    for (const r of runs) {
      const v = get(r);
      if (!Number.isFinite(v)) continue;
      sum += v;
      k++;
    }
    return k > 0 ? sum / k : Number.NaN;
  };
  const nets = runs.map((r) => r.netBps);
  const m = mean((r) => r.netBps);
  let sq = 0;
  for (const v of nets) sq += (v - m) ** 2;
  const sign = Math.sign(m);
  return {
    sleeves: runs.length,
    netBps: m,
    netSdAcrossSleeves: Math.sqrt(sq / Math.max(1, nets.length - 1)),
    minNetBps: Math.min(...nets),
    maxNetBps: Math.max(...nets),
    meanT: mean((r) => r.netT),
    meanSharpe: mean((r) => r.sharpe),
    meanTurnover: mean((r) => r.meanTurnover),
    meanAnnualPct: mean((r) => r.annualReturnPct),
    meanMaxDrawdown: mean((r) => r.maxDrawdown),
    meanExposure: mean((r) => r.meanExposure),
    agree: nets.filter((v) => Math.sign(v) === sign).length,
  };
}

/**
 * How many times the measured cost vector the book can absorb before it stops
 * paying.
 *
 * The old `breakevenCostBps` answers in basis points, which only means anything
 * when every name costs the same. With a cost vector the honest unit is a
 * multiple of it: 1.0 is what was measured, 2.0 is the stress case, and the
 * number returned is where the mean net period return crosses zero.
 */
export function breakevenCostScale(input: FactorInput, params: LiquidityFactorParams): number {
  const zero = runLiquidityFactor(input, { ...params, costBpsPerSide: new Float64Array(input.symbols.length) });
  const paid = runLiquidityFactor(input, params);
  const costAtOne = paid.costBps;
  if (!Number.isFinite(zero.netBps) || !(costAtOne > 0)) return Number.NaN;
  return zero.netBps / costAtOne;
}

/** Per-symbol cost vector built from a lookup, with a stress multiplier on the slippage. */
export function costVector(
  symbols: readonly string[],
  feeBpsPerSide: number,
  slippageBySymbol: ReadonlyMap<string, number>,
  slippageScale = 1,
  fallbackSlippageBps = Number.NaN,
): Float64Array {
  const out = new Float64Array(symbols.length);
  for (let i = 0; i < symbols.length; i++) {
    const slip = slippageBySymbol.get(symbols[i]) ?? fallbackSlippageBps;
    out[i] = feeBpsPerSide + (Number.isFinite(slip) ? slip * slippageScale : 0);
  }
  return out;
}
