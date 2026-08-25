// Optimizer run file: a normal backtest declaration plus the two things that
// make it an optimization — what to vary, and how to split the range.
//
// `base` is exactly a `RunDecl`, so everything the single-run CLI understands
// (market, intervals, costs, stress multiplier, rolling window) means the same
// thing here and is validated by the same code. The optimizer adds nothing that
// could quietly change the cost model out from under a run.
//
// Grid keys are checked against the bot's parameter list. A typo in a parameter
// name would otherwise expand into a grid that varies nothing, run for an hour
// and report a "winner" that is just the default configuration.

import os from "node:os";
import { getBotFactory } from "../bots/registry";
import { resolveRunSpec, type RunDecl, type RunSpec } from "./runConfig.ts";
import { expandGrid, type GridDecl, type ParamGrid } from "./paramGrid.ts";
import { planWalkForward, type WalkForwardDecl, type WalkForwardPlan } from "./walkForward.ts";
import { isObjective, type ObjectiveKey } from "./objective.ts";

export interface OptimizeDecl {
  name?: string;
  dataDir?: string;
  out?: string;
  base?: RunDecl;
  grid?: GridDecl;
  walkForward?: WalkForwardDecl;
  /** What to maximise when picking a fold's parameters. Default: sharpe. */
  objective?: ObjectiveKey;
  /** Combinations with fewer trades in a training window are not selectable. Default 20. */
  minTrainTrades?: number;
  /** How many combinations the report ranks. Default 10. */
  topN?: number;
  maxCombos?: number;
  /** Worker threads. "auto" = cores - 1, capped at 8 and by a memory budget; 1 = run in-process. */
  workers?: number | "auto";
  seed?: number;
  bootstrapSamples?: number;
  /**
   * Evaluate every combination on every test window, not just the selected one.
   * Costs one extra pass and buys the reality-check null, the plateau map on
   * out-of-sample data, and the "what a lucky pick would have given" baseline.
   */
  evaluateAllOnTest?: boolean;
  /** Also run every combination over the whole range, to show what plain optimization would have claimed. */
  compareNaive?: boolean;
  /** Two parameter names for the ASCII map. Defaults to the two widest axes. */
  plateauAxes?: string[];
}

export interface OptimizePlan {
  name: string;
  dataDir?: string;
  out?: string;
  spec: RunSpec;
  grid: ParamGrid;
  walkForward: WalkForwardPlan;
  objective: ObjectiveKey;
  minTrainTrades: number;
  topN: number;
  workers: number | "auto";
  seed: number;
  bootstrapSamples: number;
  evaluateAllOnTest: boolean;
  compareNaive: boolean;
  plateauAxes: string[] | null;
}

export const DEFAULT_MIN_TRAIN_TRADES = 20;
export const DEFAULT_TOP_N = 10;
export const DEFAULT_BOOTSTRAP_SAMPLES = 2000;
export const DEFAULT_SEED = 20260826;

function fail(source: string, message: string): never {
  throw new Error(`${source}: ${message}`);
}

function positiveInt(value: unknown, fallback: number, name: string, source: string): number {
  if (value === undefined || value === null) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0 || Math.floor(n) !== n) fail(source, `${name} must be a non-negative integer`);
  return n;
}

export function parseOptimizePlan(input: unknown, source = "config"): OptimizePlan {
  if (!input || typeof input !== "object") fail(source, "config must be a JSON object");
  const decl = input as OptimizeDecl;

  if (!decl.base || typeof decl.base !== "object") {
    fail(source, '"base" is required and must be a run declaration (symbol, from, to, bot, costs...)');
  }
  if (!decl.grid || typeof decl.grid !== "object" || Array.isArray(decl.grid)) {
    fail(source, '"grid" is required, e.g. {"bbPeriod":{"from":10,"to":40,"step":10},"bbMult":[2,2.5,3]}');
  }
  if (!decl.walkForward || typeof decl.walkForward !== "object") {
    fail(source, '"walkForward" is required, e.g. {"trainDays":90,"testDays":30}');
  }

  const spec = resolveRunSpec(decl.base, `${source}.base`);
  const grid = expandGrid(decl.grid, { maxCombos: decl.maxCombos });
  assertKnownParams(spec, grid, source);

  const walkForward = planWalkForward(spec.fromSec, spec.toSec, decl.walkForward);

  const objective = decl.objective ?? "sharpe";
  if (!isObjective(objective)) fail(source, `objective "${objective}" is unknown`);

  let plateauAxes: string[] | null = null;
  if (decl.plateauAxes) {
    if (!Array.isArray(decl.plateauAxes) || decl.plateauAxes.length !== 2) fail(source, "plateauAxes must be two parameter names");
    for (const key of decl.plateauAxes) {
      if (!grid.axes.some((a) => a.key === key)) fail(source, `plateauAxes: "${key}" is not in the grid`);
    }
    plateauAxes = [...decl.plateauAxes];
  }

  const workers = decl.workers ?? "auto";
  if (workers !== "auto" && (!Number.isFinite(Number(workers)) || Number(workers) < 1)) {
    fail(source, 'workers must be "auto" or a positive integer');
  }

  return {
    name: decl.name ?? `${spec.bot.kind}-${spec.symbol}-wf`,
    dataDir: decl.dataDir,
    out: decl.out,
    spec,
    grid,
    walkForward,
    objective,
    minTrainTrades: positiveInt(decl.minTrainTrades, DEFAULT_MIN_TRAIN_TRADES, "minTrainTrades", source),
    topN: Math.max(1, positiveInt(decl.topN, DEFAULT_TOP_N, "topN", source)),
    workers: workers === "auto" ? "auto" : Math.floor(Number(workers)),
    seed: positiveInt(decl.seed, DEFAULT_SEED, "seed", source),
    bootstrapSamples: Math.max(1, positiveInt(decl.bootstrapSamples, DEFAULT_BOOTSTRAP_SAMPLES, "bootstrapSamples", source)),
    evaluateAllOnTest: decl.evaluateAllOnTest !== false,
    compareNaive: decl.compareNaive !== false,
    plateauAxes,
  };
}

function assertKnownParams(spec: RunSpec, grid: ParamGrid, source: string): void {
  const factory = getBotFactory(spec.bot.kind);
  if (!factory) fail(source, `unknown bot kind "${spec.bot.kind}"`);
  const known = new Set(Object.keys(factory.defaultParams ?? {}));
  if (known.size === 0) return;
  const unknown = grid.axes.map((a) => a.key).filter((key) => !known.has(key));
  if (unknown.length > 0) {
    fail(
      source,
      `grid varies parameter(s) the bot "${spec.bot.kind}" does not have: ${unknown.join(", ")}. ` +
        `Known parameters: ${Array.from(known).sort().join(", ")}`,
    );
  }
}

/**
 * How many workers to actually spawn.
 *
 * Three ceilings, all of them measured rather than guessed. Cores minus one so
 * the machine stays usable. Eight by default because the speed-up flattens hard
 * past that — on a 12-core box a 872-run sweep went 50s -> 24.6s -> 14.3s ->
 * 12.8s for 1, 2, 4 and 8 workers, and 11 workers bought another 0.8s. And a
 * memory budget, because every worker keeps its own copy of the bars: eleven
 * copies of two years of minutes is over a gigabyte of candle objects for a
 * gain that small.
 */
export const MAX_AUTO_WORKERS = 8;

/** Rough footprint of one decoded candle object in V8, including overhead. */
export const BYTES_PER_BAR = 160;

export function resolveWorkerCount(workers: number | "auto", jobs: number, opts: { barsPerWorker?: number } = {}): number {
  const cores = Math.max(1, os.cpus()?.length ?? 1);
  let wanted = workers === "auto" ? Math.max(1, Math.min(cores - 1, MAX_AUTO_WORKERS)) : Math.max(1, Math.floor(workers));

  const bars = opts.barsPerWorker ?? 0;
  if (bars > 0) {
    const budget = Math.max(256 * 1024 * 1024, (os.totalmem?.() ?? 0) * 0.25);
    wanted = Math.max(1, Math.min(wanted, Math.floor(budget / (bars * BYTES_PER_BAR))));
  }
  return Math.max(1, Math.min(wanted, jobs));
}
