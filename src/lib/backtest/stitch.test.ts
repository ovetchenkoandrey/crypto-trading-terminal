import { describe, it, expect } from "vitest";
import { aggregateSegments, alignReturnMatrix, concatDaily, stitchSegments } from "./stitch.ts";
import type { SegmentOutcome } from "./segmentRun.ts";
import type { BacktestStats } from "../execution/backtest/stats";

const DAY = 86_400;

function segment(fromSec: number, start: number, end: number, trades: number[]) {
  return {
    fromSec,
    startEquity: start,
    endEquity: end,
    equity: [
      { time: fromSec, equity: start },
      { time: fromSec + DAY, equity: end },
    ],
    trades: trades.map((pnl, i) => ({ pnl, ts: (fromSec + i) * 1000, entryTs: (fromSec + i - 60) * 1000 })),
    days: [Math.floor(fromSec / DAY)],
    returns: [end / start - 1],
  };
}

describe("stitchSegments", () => {
  it("compounds the segments instead of restarting each one at the initial balance", () => {
    const out = stitchSegments([segment(0, 1000, 1100, []), segment(2 * DAY, 1000, 1200, [])], 1000);
    expect(out.multiples).toEqual([1.1, 1.2]);
    expect(out.totalMultiple).toBeCloseTo(1.32, 10);
    expect(out.finalEquity).toBeCloseTo(1320, 10);
    expect(out.equity[out.equity.length - 1].equity).toBeCloseTo(1320, 10);
  });

  it("scales trade P&L by the same factor, so profit factor matches the curve", () => {
    const out = stitchSegments([segment(0, 1000, 2000, [100]), segment(2 * DAY, 1000, 1100, [50])], 1000);
    expect(out.trades.map((t) => t.pnl)).toEqual([100, 100]);
  });

  it("orders segments by time whatever order they arrive in", () => {
    const out = stitchSegments([segment(2 * DAY, 1000, 900, []), segment(0, 1000, 1100, [])], 1000);
    expect(out.multiples).toEqual([1.1, 0.9]);
  });

  it("treats a wiped account as a zero multiple rather than dividing by it", () => {
    const out = stitchSegments([segment(0, 1000, 0, []), segment(2 * DAY, 1000, 1500, [])], 1000);
    expect(out.totalMultiple).toBe(0);
    expect(Number.isFinite(out.finalEquity)).toBe(true);
  });
});

function stats(over: Partial<BacktestStats>): BacktestStats {
  return {
    netProfit: 0,
    netProfitPct: 0,
    trades: 0,
    wins: 0,
    losses: 0,
    winRate: 0,
    profitFactor: 0,
    maxDrawdown: 0,
    maxDrawdownPct: 0,
    avgTrade: 0,
    avgWin: 0,
    avgLoss: 0,
    avgHoldSec: 0,
    sharpeDaily: 0,
    ...over,
  };
}

function outcome(foldIndex: number, start: number, end: number, over: Partial<BacktestStats>, returns: number[]): SegmentOutcome {
  return {
    id: foldIndex,
    comboIndex: 0,
    foldIndex,
    phase: "test",
    stats: stats(over),
    startEquity: start,
    endEquity: end,
    funding: 0,
    rejected: 0,
    liquidations: 0,
    bars: 100,
    days: returns.map((_, i) => foldIndex * 10 + i),
    returns,
    equity: null,
    trades: null,
  };
}

describe("aggregateSegments", () => {
  it("compounds returns and sums the trade counts", () => {
    const agg = aggregateSegments(
      [
        outcome(0, 1000, 1100, { trades: 10, wins: 6, losses: 4, avgWin: 30, avgLoss: -20 }, [0.05, 0.05]),
        outcome(1, 1000, 1050, { trades: 8, wins: 5, losses: 3, avgWin: 20, avgLoss: -15 }, [0.02, 0.03]),
      ],
      1000,
    );
    expect(agg.trades).toBe(18);
    expect(agg.multiple).toBeCloseTo(1.155, 10);
    expect(agg.netProfitPct).toBeCloseTo(15.5, 10);
    expect(agg.profitFactor).toBeGreaterThan(1);
  });

  it("measures drawdown on the rebuilt daily curve", () => {
    const agg = aggregateSegments([outcome(0, 1000, 1000, { trades: 5 }, [0.1, -0.2, 0.125])], 1000);
    expect(agg.maxDrawdownPct).toBeCloseTo(20, 6);
  });

  it("reports an infinite profit factor only when nothing was lost", () => {
    const agg = aggregateSegments([outcome(0, 1000, 1200, { trades: 3, wins: 3, losses: 0, avgWin: 66 }, [0.2])], 1000);
    expect(agg.profitFactor).toBe(Infinity);
  });
});

describe("concatDaily", () => {
  it("concatenates in fold order regardless of arrival order", () => {
    const out = concatDaily([outcome(1, 1000, 1000, {}, [0.3]), outcome(0, 1000, 1000, {}, [0.1, 0.2])]);
    expect(out.returns).toEqual([0.1, 0.2, 0.3]);
    expect(out.days).toEqual([0, 1, 10]);
  });
});

describe("alignReturnMatrix", () => {
  it("puts every series on one day grid and fills gaps with flat days", () => {
    const { days, matrix } = alignReturnMatrix([
      { days: [1, 2, 3], returns: [0.1, 0.2, 0.3] },
      { days: [2, 4], returns: [0.5, 0.6] },
    ]);
    expect(days).toEqual([1, 2, 3, 4]);
    expect(matrix[0]).toEqual([0.1, 0.2, 0.3, 0]);
    expect(matrix[1]).toEqual([0, 0.5, 0, 0.6]);
  });
});
