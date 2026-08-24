// Headless execution path: local disk -> cost models -> runBacktest -> report.
//
// Deliberately free of anything browser-shaped. The UI path (`driver.ts`) pulls
// history through IndexedDB and the live Bybit client and drives a Zustand
// store; this one reads the on-disk dataset written by `npm run data:fetch` and
// returns a plain object. That is what makes hundreds of runs — and subagents —
// possible.

import type { Candle } from "../types";
import { runBacktest, type BacktestProgress, type BacktestResult } from "../execution/backtest/runner";
import type { FundingRateEvent } from "../execution/funding";
import { createCandleStore, type CandleStore } from "../data/candleStore.ts";
import { createFundingStore, type FundingStore } from "../data/fundingStore.ts";
import { intervalSeconds } from "../data/interval.ts";
import { resolveDataRoot, type DatasetKey } from "../data/paths.ts";
import { toISO } from "../data/months.ts";
import { resolveCosts, type RunSpec } from "./runConfig.ts";
import { buildReport, type BacktestReport } from "./report.ts";

export interface CliRunStores {
  candles?: CandleStore;
  funding?: FundingStore;
}

export interface CliRunOptions {
  /** Dataset root. Defaults to `--data-dir`/$TRADING_DATA_DIR/./data. */
  dataRoot?: string;
  stores?: CliRunStores;
  onProgress?: (p: BacktestProgress & { spec: RunSpec; stress: boolean }) => void;
  /** Swapped out in unit tests; production always uses the real engine. */
  runner?: typeof runBacktest;
  now?: number;
}

export interface Coverage {
  bars: number;
  expectedBars: number;
  /** Present bars over expected bars, 0..1. */
  ratio: number;
  firstSec: number;
  lastSec: number;
}

export interface CliRunOutcome {
  spec: RunSpec;
  report: BacktestReport;
  result: BacktestResult;
  /** Paired run with multiplied slippage, when the spec asked for one. */
  stressResult: BacktestResult | null;
  coverage: Coverage;
  fundingEvents: number;
}

export function datasetKey(spec: RunSpec): DatasetKey {
  return { market: spec.market, symbol: spec.symbol, interval: spec.interval };
}

/**
 * Reads the bars for a run and refuses to continue on an empty slice. A silent
 * zero-bar run would produce a report full of zeroes that looks like a result.
 */
export function loadCandles(store: CandleStore, spec: RunSpec): Candle[] {
  const key = datasetKey(spec);
  const candles = store.readRange(key, spec.fromSec, spec.toSec);
  if (candles.length === 0) {
    const stats = store.stats(key);
    const have = stats.candles > 0
      ? `dataset holds ${stats.candles} bar(s), ${toISO(stats.firstTime ?? 0)} .. ${toISO(stats.lastTime ?? 0)}`
      : "dataset is empty";
    throw new Error(
      `no candles for ${key.market}:${key.symbol}:${key.interval} in ${toISO(spec.fromSec)} .. ${toISO(spec.toSec)} — ${have} (root ${store.root})`,
    );
  }
  return candles;
}

export function loadFunding(store: FundingStore, spec: RunSpec): FundingRateEvent[] {
  return store
    .readRange(spec.market, spec.symbol, spec.fromSec, spec.toSec)
    .map((e) => ({ timestamp: e.time, rate: e.rate }));
}

export function coverageOf(candles: readonly Candle[], spec: RunSpec): Coverage {
  const barSec = intervalSeconds(spec.interval);
  const expected = Math.max(1, Math.floor((spec.toSec - spec.fromSec + 1) / barSec));
  return {
    bars: candles.length,
    expectedBars: expected,
    ratio: candles.length / expected,
    firstSec: candles.length ? candles[0].time : 0,
    lastSec: candles.length ? candles[candles.length - 1].time : 0,
  };
}

/** One run, plus its stress twin when `spec.stressSlippage` is set. */
export async function runFromSpec(spec: RunSpec, opts: CliRunOptions = {}): Promise<CliRunOutcome> {
  const root = resolveDataRoot(opts.dataRoot);
  const candleStore = opts.stores?.candles ?? createCandleStore(root);
  const fundingStore = opts.stores?.funding ?? createFundingStore(root);
  const engine = opts.runner ?? runBacktest;

  const candles = loadCandles(candleStore, spec);
  const fundingEvents = spec.costs.funding ? loadFunding(fundingStore, spec) : [];
  const resolved = resolveCosts(spec, fundingEvents);

  const startedAt = Date.now();
  const result = await engine(
    {
      symbol: spec.symbol,
      candles,
      bot: spec.bot,
      initialBalance: spec.initialBalance,
      feeRate: resolved.feeRate,
      slippageCfg: resolved.slippage,
      costs: resolved.costs,
      signalIntervalSec: spec.signalIntervalSec,
    },
    { onProgress: opts.onProgress ? (p) => opts.onProgress!({ ...p, spec, stress: false }) : undefined },
  );

  let stressResult: BacktestResult | null = null;
  if (spec.stressSlippage !== null) {
    const stressed = resolveCosts(spec, fundingEvents, { stressSlippage: spec.stressSlippage });
    stressResult = await engine(
      {
        symbol: spec.symbol,
        candles,
        bot: spec.bot,
        initialBalance: spec.initialBalance,
        feeRate: stressed.feeRate,
        slippageCfg: stressed.slippage,
        costs: stressed.costs,
        signalIntervalSec: spec.signalIntervalSec,
      },
      { onProgress: opts.onProgress ? (p) => opts.onProgress!({ ...p, spec, stress: true }) : undefined },
    );
  }
  const durationMs = Date.now() - startedAt;

  const report = buildReport({
    spec,
    bars: candles.length,
    durationMs,
    stats: result.stats,
    equity: result.equity,
    trades: result.trades,
    funding: result.funding,
    rejected: result.rejected,
    liquidations: result.liquidations ?? 0,
    openPositions: result.positions.length,
    pendingOrders: result.orders.filter((o) => o.status === "pending").length,
    costsApplied: result.costsApplied,
    costsDetail: resolved.description,
    barSec: intervalSeconds(spec.interval),
    rangeStartSec: candles[0].time,
    stress: stressResult && spec.stressSlippage !== null
      ? { multiplier: spec.stressSlippage, stats: stressResult.stats }
      : null,
    now: opts.now,
  });

  return { spec, report, result, stressResult, coverage: coverageOf(candles, spec), fundingEvents: fundingEvents.length };
}

/** Runs every spec in order and keeps going after a failure. */
export interface PlanRunOutcome {
  outcomes: CliRunOutcome[];
  failures: { spec: RunSpec; error: string }[];
}

export async function runSpecs(specs: readonly RunSpec[], opts: CliRunOptions = {}): Promise<PlanRunOutcome> {
  const outcomes: CliRunOutcome[] = [];
  const failures: { spec: RunSpec; error: string }[] = [];
  for (const spec of specs) {
    try {
      outcomes.push(await runFromSpec(spec, opts));
    } catch (err) {
      failures.push({ spec, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { outcomes, failures };
}
