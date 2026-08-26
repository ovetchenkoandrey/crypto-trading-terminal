import { describe, expect, it } from "vitest";
import {
  breakevenCostScale,
  costVector,
  runLiquidityFactor,
  runLiquiditySleeves,
  type LiquidityFactorParams,
} from "./factorLiquidity.ts";
import { DEFAULT_FACTOR_PARAMS, runFactorPortfolio, type FactorInput } from "./positioningFactor.ts";

const HOUR = 3600;

/**
 * A board where the feature is a clean contrarian signal: the coin ranked
 * lowest this bar goes up next bar, the highest goes down. Prices are built to
 * make the arithmetic checkable rather than to look like a market.
 */
function makeInput(symbols: number, bars: number, price = 100): FactorInput {
  const times = Float64Array.from({ length: bars }, (_, i) => 1_700_000_000 + i * HOUR);
  const feature: Float64Array[] = [];
  const close: Float64Array[] = [];
  for (let s = 0; s < symbols; s++) {
    const f = new Float64Array(bars);
    const c = new Float64Array(bars);
    for (let t = 0; t < bars; t++) {
      // Rotating ranks so the basket turns over, and a return that pays the
      // contrarian side one percent a bar.
      const rank = (s + t) % symbols;
      f[t] = rank;
      const prev = t === 0 ? price : c[t - 1];
      const prevRank = t === 0 ? rank : (s + t - 1) % symbols;
      const up = prevRank < symbols / 2 ? 0.01 : -0.01;
      c[t] = t === 0 ? price : prev * (1 + up);
    }
    feature.push(f);
    close.push(c);
  }
  return { symbols: Array.from({ length: symbols }, (_, i) => `S${i}`), times, feature, close };
}

function params(over: Partial<LiquidityFactorParams> & { costBpsPerSide: Float64Array }): LiquidityFactorParams {
  return {
    side: 0.2,
    rebalanceBars: 1,
    minSymbols: 4,
    contrarian: true,
    longOnly: false,
    grossLeverage: 1,
    ...over,
  };
}

describe("runLiquidityFactor", () => {
  it("reproduces the flat-cost engine when every symbol costs the same and lots are off", () => {
    const input = makeInput(10, 200);
    const flat = runFactorPortfolio(input, {
      ...DEFAULT_FACTOR_PARAMS,
      side: 0.2,
      rebalanceBars: 4,
      minSymbols: 4,
      feeBpsPerSide: 7,
      slippageBpsPerSide: 0,
    });
    const perSymbol = runLiquidityFactor(
      input,
      params({ rebalanceBars: 4, costBpsPerSide: new Float64Array(10).fill(7) }),
    );
    expect(perSymbol.grossBps).toBeCloseTo(flat.grossBps, 8);
    expect(perSymbol.netBps).toBeCloseTo(flat.netBps, 8);
    expect(perSymbol.meanTurnover).toBeCloseTo(flat.meanTurnover, 8);
    expect(perSymbol.maxDrawdown).toBeCloseTo(flat.maxDrawdown, 8);
    expect(perSymbol.sharpe).toBeCloseTo(flat.sharpe, 6);
  });

  it("charges the expensive names their own rate", () => {
    const input = makeInput(10, 200);
    const cheap = runLiquidityFactor(input, params({ costBpsPerSide: new Float64Array(10).fill(1) }));
    const mixed = new Float64Array(10).fill(1);
    mixed[0] = 101;
    const withOneDear = runLiquidityFactor(input, params({ costBpsPerSide: mixed }));
    expect(withOneDear.costBps).toBeGreaterThan(cheap.costBps);
    // Exactly the turnover that went through symbol 0, at 100 bp extra.
    const extra = (withOneDear.turnoverBySymbol[0] / withOneDear.periods.length) * 100;
    expect(withOneDear.costBps - cheap.costBps).toBeCloseTo(extra, 8);
  });

  it("splits turnover and contribution across the symbols that were held", () => {
    const input = makeInput(10, 200);
    const r = runLiquidityFactor(input, params({ costBpsPerSide: new Float64Array(10) }));
    let turnover = 0;
    for (const v of r.turnoverBySymbol) turnover += v;
    expect(turnover / r.periods.length).toBeCloseTo(r.meanTurnover, 8);
    let contribution = 0;
    for (const v of r.contributionBySymbol) contribution += v;
    expect(contribution).toBeCloseTo(r.grossBps, 6);
  });

  it("drops a name whose minimum lot is worth more than its slot", () => {
    const input = makeInput(10, 200, 100);
    const lots = Array.from({ length: 10 }, () => ({ minQty: 0.001, qtyStep: 0.001, minNotionalUsdt: 5 }));
    // Symbol 0 must be bought in units of 1000 USDT; each slot is 100 USDT.
    lots[0] = { minQty: 10, qtyStep: 10, minNotionalUsdt: 5 };
    const r = runLiquidityFactor(
      input,
      params({ costBpsPerSide: new Float64Array(10), lots, bookNotionalUsdt: 1000 }),
    );
    expect(r.meanDroppedNames).toBeGreaterThan(0);
    expect(r.meanExposure).toBeLessThan(1);
    expect(r.turnoverBySymbol[0]).toBe(0);
  });

  it("keeps full exposure when every lot is fine enough", () => {
    const input = makeInput(10, 200, 100);
    const lots = Array.from({ length: 10 }, () => ({ minQty: 0.001, qtyStep: 0.001, minNotionalUsdt: 5 }));
    const r = runLiquidityFactor(
      input,
      params({ costBpsPerSide: new Float64Array(10), lots, bookNotionalUsdt: 1000 }),
    );
    expect(r.meanDroppedNames).toBe(0);
    expect(r.meanExposure).toBeCloseTo(1, 3);
    expect(r.meanWeightErrorL1).toBeLessThan(0.01);
  });

  it("leaves an excluded symbol out of the ranking entirely", () => {
    const input = makeInput(10, 200);
    const excluded = new Array(10).fill(false);
    excluded[3] = true;
    const r = runLiquidityFactor(input, params({ costBpsPerSide: new Float64Array(10), excluded }));
    expect(r.turnoverBySymbol[3]).toBe(0);
    expect(r.contributionBySymbol[3]).toBe(0);
  });

  it("returns an empty result rather than throwing on a run too short to score", () => {
    const input = makeInput(10, 6);
    const r = runLiquidityFactor(input, params({ rebalanceBars: 4, costBpsPerSide: new Float64Array(10) }));
    expect(Number.isNaN(r.netBps)).toBe(true);
  });
});

describe("breakevenCostScale", () => {
  it("is the multiple of the measured cost vector that takes the book to zero", () => {
    const input = makeInput(10, 400);
    const cost = new Float64Array(10).fill(3);
    const p = params({ rebalanceBars: 4, costBpsPerSide: cost });
    const scale = breakevenCostScale(input, p);
    expect(scale).toBeGreaterThan(0);
    const at = runLiquidityFactor(input, {
      ...p,
      costBpsPerSide: Float64Array.from(cost, (v) => v * scale),
    });
    expect(at.netBps).toBeCloseTo(0, 6);
  });
});

describe("runLiquiditySleeves", () => {
  it("averages the staggered entry schedules and counts the ones that agree", () => {
    const input = makeInput(10, 400);
    const s = runLiquiditySleeves(input, params({ rebalanceBars: 4, costBpsPerSide: new Float64Array(10) }), 4);
    expect(s.sleeves).toBe(4);
    expect(s.agree).toBeGreaterThanOrEqual(1);
    expect(s.minNetBps).toBeLessThanOrEqual(s.netBps);
    expect(s.maxNetBps).toBeGreaterThanOrEqual(s.netBps);
  });
});

describe("costVector", () => {
  it("adds fee to measured slippage and scales only the slippage", () => {
    const v = costVector(["A", "B"], 5.5, new Map([["A", 2], ["B", 10]]), 2);
    expect(v[0]).toBeCloseTo(5.5 + 4, 8);
    expect(v[1]).toBeCloseTo(5.5 + 20, 8);
  });

  it("uses the fallback for a symbol with no measurement", () => {
    const v = costVector(["A", "B"], 5.5, new Map([["A", 2]]), 1, 8);
    expect(v[1]).toBeCloseTo(13.5, 8);
  });

  it("charges fee only when there is neither a measurement nor a fallback", () => {
    const v = costVector(["A"], 5.5, new Map());
    expect(v[0]).toBeCloseTo(5.5, 8);
  });
});
