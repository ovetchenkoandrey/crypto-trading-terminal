// The sweep itself: expand the grid, fit each fold on its training window,
// judge the winner on the window that fitting never saw, and then spend most of
// the remaining effort trying to talk itself out of the result.
//
// Order of work is deliberate. Everything that does not depend on a selection —
// every combination on every training window, every combination on every test
// window, every combination over the whole range — goes into one wave, because
// a single wave keeps the worker pool saturated. Only the re-runs that need
// equity curves (the selected combination per fold, its stressed twin, the
// naive winner) wait for the first wave to finish.

import { checkCriteria, computeRollingWindows, computeStreaks, type CriteriaVerdict, type RollingWindowStats, type StreakStats } from "./report.ts";
import { comboLabel, type GridValue, type ParamCombo } from "./paramGrid.ts";
import { rankScore, scoreStats, type ObjectiveKey } from "./objective.ts";
import { analysePlateau, formatHeatmap, pickMapAxes, type PlateauReport } from "./plateau.ts";
import { aggregateSegments, alignReturnMatrix, concatDaily, stitchSegments } from "./stitch.ts";
import { deflatedSharpe, moments, realityCheck, type DeflatedSharpeResult, type RealityCheckResult } from "./multipleTesting.ts";
import { createWorkerExecutor, inlineExecutor, type ExecutorProgress, type SegmentExecutor } from "./segmentExecutor.ts";
import { resolveWorkerCount, type OptimizePlan } from "./optimizeConfig.ts";
import { loadCandles, loadFunding } from "./cliRun.ts";
import { createCandleStore } from "../data/candleStore.ts";
import { createFundingStore } from "../data/fundingStore.ts";
import { intervalSeconds } from "../data/interval.ts";
import { resolveDataRoot } from "../data/paths.ts";
import { computeStats, type BacktestStats } from "../execution/backtest/stats";
import type { PaperTrade } from "../store";
import type { SegmentJob, SegmentOutcome } from "./segmentRun.ts";
import type { WalkForwardFold } from "./walkForward.ts";

export interface FoldOutcome {
  fold: WalkForwardFold;
  /** Combinations whose training result was rankable at all. */
  candidates: number;
  selected: { comboIndex: number; params: Record<string, GridValue>; label: string } | null;
  trainScore: number | null;
  trainStats: BacktestStats | null;
  testStats: BacktestStats | null;
  testScore: number | null;
  stressStats: BacktestStats | null;
  liquidations: number;
  note?: string;
}

export interface ComboSummary {
  index: number;
  label: string;
  params: Record<string, GridValue>;
  /**
   * Mean of the fold training scores. Null when the combination cleared the
   * minimum trade count in fewer than half the folds: a configuration that was
   * only rankable once would otherwise be averaged over that one fold and beat
   * configurations that had to hold up fifteen times.
   */
  trainScore: number | null;
  /** Folds where the combination produced a rankable training result. */
  trainFolds: number;
  /** Score of its compounded out-of-sample track. Null when it was never evaluated on test. */
  testScore: number | null;
  testStats: BacktestStats | null;
  fullStats: BacktestStats | null;
  fullScore: number | null;
  selectedInFolds: number[];
}

export interface OptimizeBaselines {
  /** The walk-forward track: selection retrained per fold, judged out of sample. */
  walkForward: { score: number | null; stats: BacktestStats | null };
  /** Median combination measured out of sample — what an uninformed pick would have given. */
  medianCombo: { score: number | null; netPct: number | null };
  /** Best combination measured out of sample, choosing with hindsight. The ceiling, not a result. */
  oracle: { comboIndex: number; label: string; score: number | null } | null;
  /**
   * Best combination over the whole range, scored on that same range — the
   * number a plain optimizer would print, and the one that must not be believed.
   * `walkForwardScore` is what the same parameters actually did out of sample.
   */
  naive: { comboIndex: number; label: string; inSampleScore: number | null; inSampleStats: BacktestStats | null; walkForwardScore: number | null } | null;
}

export interface MultipleTestingReport {
  /** Combinations in the grid; each one is a look at the data. */
  combos: number;
  folds: number;
  /** Segment backtests actually executed. */
  runs: number;
  /** Grid size x folds — the number of fits the selection performed. */
  selectionTrials: number;
  deflatedWalkForward: DeflatedSharpeResult | null;
  deflatedNaive: DeflatedSharpeResult | null;
  reality: RealityCheckResult | null;
  verdict: "survives" | "fails" | "not-evaluated";
  notes: string[];
}

export interface PlateauSection {
  objective: ObjectiveKey;
  axes: [string, string] | null;
  train: PlateauReport;
  test: PlateauReport | null;
  trainMap: string;
  testMap: string | null;
}

export interface OptimizeResult {
  plan: OptimizePlan;
  generatedAt: string;
  durationMs: number;
  workers: number;
  bars: number;
  fundingEvents: number;
  runs: number;
  folds: FoldOutcome[];
  stitched: {
    stats: BacktestStats | null;
    rolling: RollingWindowStats | null;
    streaks: StreakStats | null;
    criteria: CriteriaVerdict | null;
    finalEquity: number;
    multiples: number[];
    stressProfitFactor: number | null;
  };
  baselines: OptimizeBaselines;
  multipleTesting: MultipleTestingReport;
  plateau: PlateauSection | null;
  top: ComboSummary[];
  warnings: string[];
}

export interface OptimizeOptions {
  dataRoot?: string;
  /** Injected in tests so the orchestration can be exercised without a dataset. */
  executor?: SegmentExecutor;
  onPhase?: (phase: string, detail: string) => void;
  onProgress?: (p: ExecutorProgress & { phase: string }) => void;
  now?: number;
}

export async function runOptimize(plan: OptimizePlan, opts: OptimizeOptions = {}): Promise<OptimizeResult> {
  const startedAt = Date.now();
  const root = resolveDataRoot(opts.dataRoot ?? plan.dataDir);
  const warnings: string[] = [];

  const folds = plan.walkForward.folds;
  const combos = plan.grid.combos;
  const wave1Size = combos.length * folds.length * (plan.evaluateAllOnTest ? 2 : 1) + (plan.compareNaive ? combos.length : 0);
  const barsInRange = Math.ceil((plan.spec.toSec - plan.spec.fromSec + 1) / intervalSeconds(plan.spec.interval));
  const workerCount = resolveWorkerCount(plan.workers, wave1Size, { barsPerWorker: barsInRange });

  const executor = opts.executor ?? (await makeExecutor(plan, root, workerCount));
  let runs = 0;

  try {
    /* ── wave 1: everything that does not depend on a selection ──────────── */

    const jobs: SegmentJob[] = [];
    let id = 0;
    for (const fold of folds) {
      for (const combo of combos) {
        jobs.push({ id: id++, comboIndex: combo.index, foldIndex: fold.index, phase: "train", params: combo.params, fromSec: fold.trainFromSec, toSec: fold.trainToSec });
      }
    }
    if (plan.evaluateAllOnTest) {
      for (const fold of folds) {
        for (const combo of combos) {
          jobs.push({ id: id++, comboIndex: combo.index, foldIndex: fold.index, phase: "test", params: combo.params, fromSec: fold.testFromSec, toSec: fold.testToSec, want: { daily: true } });
        }
      }
    }
    const naiveFrom = folds[0].trainFromSec;
    const naiveTo = folds[folds.length - 1].testToSec;
    if (plan.compareNaive) {
      for (const combo of combos) {
        jobs.push({ id: id++, comboIndex: combo.index, foldIndex: -1, phase: "full", params: combo.params, fromSec: naiveFrom, toSec: naiveTo, want: { daily: true } });
      }
    }

    opts.onPhase?.("sweep", `${jobs.length} segment run(s) over ${combos.length} combination(s) on ${executor.workers} worker(s)`);
    const wave1 = await executor.run(jobs, (p) => opts.onProgress?.({ ...p, phase: "sweep" }));
    runs += wave1.length;

    const trainBy = indexOutcomes(wave1, "train");
    const testBy = indexOutcomes(wave1, "test");
    const fullBy = indexOutcomes(wave1, "full");
    for (const o of wave1) if (o.error) warnings.push(`segment ${o.phase} combo ${o.comboIndex} fold ${o.foldIndex + 1}: ${o.error}`);

    /* ── selection ────────────────────────────────────────────────────────── */

    const selections = folds.map((fold) => selectForFold(fold, combos, trainBy, plan));
    for (const s of selections) if (s.note) warnings.push(`fold ${s.fold.index + 1}: ${s.note}`);

    /* ── wave 2: the runs that need equity curves ─────────────────────────── */

    const wave2Jobs: SegmentJob[] = [];
    const stressMultiplier = plan.spec.stressSlippage;
    for (const s of selections) {
      if (!s.selected) continue;
      wave2Jobs.push({
        id: id++,
        comboIndex: s.selected.comboIndex,
        foldIndex: s.fold.index,
        phase: "test",
        params: s.selected.params,
        fromSec: s.fold.testFromSec,
        toSec: s.fold.testToSec,
        want: { daily: true, equity: true, trades: true },
      });
      if (stressMultiplier !== null) {
        wave2Jobs.push({
          id: id++,
          comboIndex: s.selected.comboIndex,
          foldIndex: s.fold.index,
          phase: "stress",
          params: s.selected.params,
          fromSec: s.fold.testFromSec,
          toSec: s.fold.testToSec,
          stressSlippage: stressMultiplier,
          want: { daily: true, equity: true, trades: true },
        });
      }
    }

    opts.onPhase?.("validate", `${wave2Jobs.length} run(s) for the selected track`);
    const wave2 = wave2Jobs.length > 0 ? await executor.run(wave2Jobs, (p) => opts.onProgress?.({ ...p, phase: "validate" })) : [];
    runs += wave2.length;
    for (const o of wave2) if (o.error) warnings.push(`selected ${o.phase} fold ${o.foldIndex + 1}: ${o.error}`);

    const selectedTest = wave2.filter((o) => o.phase === "test").sort((a, b) => a.foldIndex - b.foldIndex);
    const selectedStress = wave2.filter((o) => o.phase === "stress").sort((a, b) => a.foldIndex - b.foldIndex);

    /* ── stitched out-of-sample track ─────────────────────────────────────── */

    const barSec = intervalSeconds(plan.spec.interval);
    const stitchedOos = stitchSegments(
      selectedTest.map((o) => ({
        fromSec: folds[o.foldIndex].testFromSec,
        startEquity: o.startEquity,
        endEquity: o.endEquity,
        equity: o.equity ?? [],
        trades: o.trades ?? [],
        days: o.days,
        returns: o.returns,
      })),
      plan.spec.initialBalance,
    );

    const stitchedStats = selectedTest.length > 0 ? statsOfStitched(plan, stitchedOos) : null;
    const rolling = stitchedStats
      ? computeRollingWindows(stitchedOos.equity, plan.spec.window, { barSec, startSec: plan.walkForward.testFromSec })
      : null;
    const streaks = stitchedStats ? computeStreaks(stitchedOos.trades) : null;

    const stressStitched = selectedStress.length > 0
      ? stitchSegments(
          selectedStress.map((o) => ({
            fromSec: folds[o.foldIndex].testFromSec,
            startEquity: o.startEquity,
            endEquity: o.endEquity,
            equity: o.equity ?? [],
            trades: o.trades ?? [],
            days: o.days,
            returns: o.returns,
          })),
          plan.spec.initialBalance,
        )
      : null;
    const stressStats = stressStitched ? statsOfStitched(plan, stressStitched) : null;

    // A stress multiplier applied to a cost declaration that has no slippage
    // model multiplies zero. The paired run comes back identical and the
    // "survives x2 slippage" criterion passes without testing anything.
    if (stressMultiplier !== null && plan.spec.costs.slippage === false) {
      warnings.push(
        `stressSlippage x${stressMultiplier} is declared but costs.slippage is off — the stressed run is identical ` +
          `to the base run, so the "survives x${stressMultiplier} slippage" criterion passes for free`,
      );
    }

    const liquidations = selectedTest.reduce((s, o) => s + o.liquidations, 0);
    const criteria = stitchedStats && rolling && streaks
      ? checkCriteria({
          stats: stitchedStats,
          rolling,
          streaks,
          stressProfitFactor: stressStats ? stressStats.profitFactor : null,
          stressMultiplier,
          liquidations,
        })
      : null;

    /* ── per-combination summaries and baselines ──────────────────────────── */

    const summaries = combos.map((combo) =>
      summariseCombo(combo, plan, trainBy, testBy, fullBy, selections),
    );

    const trainScores = summaries.map((s) => s.trainScore);
    const testScores = summaries.map((s) => s.testScore);
    const fullScores = summaries.map((s) => s.fullScore);

    const bestTrainIndex = argMax(trainScores);
    const oracleIndex = argMax(testScores);
    const naiveIndex = argMax(fullScores);

    const walkForwardScore = stitchedStats ? scoreStats(stitchedStats, plan.objective) : null;
    const baselines: OptimizeBaselines = {
      walkForward: { score: walkForwardScore, stats: stitchedStats },
      medianCombo: medianBaseline(summaries, plan.objective),
      oracle: oracleIndex >= 0 ? { comboIndex: oracleIndex, label: summaries[oracleIndex].label, score: testScores[oracleIndex] } : null,
      naive:
        naiveIndex >= 0
          ? {
              comboIndex: naiveIndex,
              label: summaries[naiveIndex].label,
              inSampleScore: fullScores[naiveIndex],
              inSampleStats: summaries[naiveIndex].fullStats,
              walkForwardScore: testScores[naiveIndex],
            }
          : null,
    };

    /* ── multiple testing ─────────────────────────────────────────────────── */

    const multipleTesting = assessMultipleTesting(plan, summaries, testBy, fullBy, stitchedOos, stitchedStats, runs, warnings);

    /* ── plateau ──────────────────────────────────────────────────────────── */

    const centre = bestTrainIndex >= 0 ? bestTrainIndex : oracleIndex >= 0 ? oracleIndex : 0;
    const axes = pickMapAxes(plan.grid, plan.plateauAxes ?? undefined);
    const plateau: PlateauSection | null =
      plan.grid.axes.length > 0
        ? {
            objective: plan.objective,
            axes,
            train: analysePlateau(plan.grid, trainScores, centre),
            test: plan.evaluateAllOnTest ? analysePlateau(plan.grid, testScores, centre) : null,
            trainMap: axes
              ? formatHeatmap(plan.grid, trainScores, { bestIndex: centre, xAxis: axes[0], yAxis: axes[1], title: "in-sample (training windows, mean over folds)" })
              : "(no map: the grid has fewer than two varying axes)",
            testMap:
              axes && plan.evaluateAllOnTest
                ? formatHeatmap(plan.grid, testScores, { bestIndex: centre, xAxis: axes[0], yAxis: axes[1], title: "out-of-sample (test windows, compounded)" })
                : null,
          }
        : null;

    if (plateau && plateau.train.verdict === "isolated-peak") {
      warnings.push("the best in-sample combination is an isolated peak: its immediate neighbours lose most of its score");
    }

    const top = [...summaries]
      .sort((a, b) => (b.trainScore ?? -Infinity) - (a.trainScore ?? -Infinity) || a.index - b.index)
      .slice(0, plan.topN);

    return {
      plan,
      generatedAt: new Date(opts.now ?? Date.now()).toISOString(),
      durationMs: Date.now() - startedAt,
      workers: executor.workers,
      bars: executor.dataset.bars,
      fundingEvents: executor.dataset.fundingEvents,
      runs,
      folds: selections.map((s) => ({
        fold: s.fold,
        candidates: s.candidates,
        selected: s.selected,
        trainScore: s.trainScore,
        trainStats: s.trainStats,
        testStats: findFold(selectedTest, s.fold.index)?.stats ?? null,
        testScore: foldScore(findFold(selectedTest, s.fold.index), plan.objective),
        stressStats: findFold(selectedStress, s.fold.index)?.stats ?? null,
        liquidations: findFold(selectedTest, s.fold.index)?.liquidations ?? 0,
        note: s.note,
      })),
      stitched: {
        stats: stitchedStats,
        rolling,
        streaks,
        criteria,
        finalEquity: stitchedOos.finalEquity,
        multiples: stitchedOos.multiples,
        stressProfitFactor: stressStats ? stressStats.profitFactor : null,
      },
      baselines,
      multipleTesting,
      plateau,
      top,
      warnings,
    };
  } finally {
    await executor.close();
  }
}

/* ── helpers ──────────────────────────────────────────────────────────────── */

async function makeExecutor(plan: OptimizePlan, root: string, workerCount: number): Promise<SegmentExecutor> {
  if (workerCount > 1) {
    return createWorkerExecutor({ dataRoot: root, spec: plan.spec, warmupBars: plan.walkForward.warmupBars }, workerCount);
  }
  const candles = loadCandles(createCandleStore(root), plan.spec);
  const fundingEvents = plan.spec.costs.funding ? loadFunding(createFundingStore(root), plan.spec) : [];
  return inlineExecutor({ spec: plan.spec, candles, fundingEvents, warmupBars: plan.walkForward.warmupBars });
}

type OutcomeIndex = Map<string, SegmentOutcome>;

function key(comboIndex: number, foldIndex: number): string {
  return `${comboIndex}:${foldIndex}`;
}

function indexOutcomes(outcomes: readonly SegmentOutcome[], phase: string): OutcomeIndex {
  const map: OutcomeIndex = new Map();
  for (const o of outcomes) if (o.phase === phase) map.set(key(o.comboIndex, o.foldIndex), o);
  return map;
}

function findFold(outcomes: readonly SegmentOutcome[], foldIndex: number): SegmentOutcome | null {
  return outcomes.find((o) => o.foldIndex === foldIndex) ?? null;
}

interface Selection {
  fold: WalkForwardFold;
  candidates: number;
  selected: { comboIndex: number; params: Record<string, GridValue>; label: string } | null;
  trainScore: number | null;
  trainStats: BacktestStats | null;
  note?: string;
}

/**
 * Picks the training winner of one fold. Ties break on the lower grid index so
 * that a rerun of the same config produces the same selection — a report that
 * cannot be reproduced cannot be argued with.
 */
function selectForFold(fold: WalkForwardFold, combos: readonly ParamCombo[], trainBy: OutcomeIndex, plan: OptimizePlan): Selection {
  let best: { combo: ParamCombo; score: number; stats: BacktestStats } | null = null;
  let candidates = 0;
  for (const combo of combos) {
    const outcome = trainBy.get(key(combo.index, fold.index));
    if (!outcome || outcome.error) continue;
    const score = rankScore(outcome.stats, plan.objective, plan.minTrainTrades);
    if (score === null) continue;
    candidates += 1;
    if (!best || score > best.score) best = { combo, score, stats: outcome.stats };
  }
  if (!best) {
    return {
      fold,
      candidates,
      selected: null,
      trainScore: null,
      trainStats: null,
      note: `no combination reached minTrainTrades=${plan.minTrainTrades} on this training window — the fold contributes nothing`,
    };
  }
  return {
    fold,
    candidates,
    selected: { comboIndex: best.combo.index, params: best.combo.params, label: comboLabel(best.combo, plan.grid.axes) },
    trainScore: best.score,
    trainStats: best.stats,
  };
}

/**
 * Same `computeStats` the single-run report uses, so a walk-forward line and a
 * plain backtest line mean exactly the same thing. Only pnl and the timestamps
 * are read, which is all a stitched trade record carries.
 */
function statsOfStitched(plan: OptimizePlan, stitched: ReturnType<typeof stitchSegments>): BacktestStats {
  return computeStats(plan.spec.initialBalance, stitched.trades as unknown as PaperTrade[], stitched.equity);
}

function summariseCombo(
  combo: ParamCombo,
  plan: OptimizePlan,
  trainBy: OutcomeIndex,
  testBy: OutcomeIndex,
  fullBy: OutcomeIndex,
  selections: readonly Selection[],
): ComboSummary {
  const trainScores: number[] = [];
  for (const fold of plan.walkForward.folds) {
    const o = trainBy.get(key(combo.index, fold.index));
    if (!o || o.error) continue;
    const s = rankScore(o.stats, plan.objective, plan.minTrainTrades);
    if (s !== null) trainScores.push(s);
  }

  const testOutcomes = plan.walkForward.folds
    .map((fold) => testBy.get(key(combo.index, fold.index)))
    .filter((o): o is SegmentOutcome => Boolean(o) && !o!.error);
  const testStats = testOutcomes.length > 0 ? aggregateSegments(testOutcomes, plan.spec.initialBalance) : null;

  const fullOutcome = fullBy.get(key(combo.index, -1));
  const fullStats = fullOutcome && !fullOutcome.error ? fullOutcome.stats : null;

  // The same trade-count floor the selection uses applies to the baselines.
  // Without it the "best combination" of a losing grid is whichever one never
  // fired: on Sharpe a flat account scores zero, which beats every real
  // configuration, and the report would present doing nothing as the ceiling.
  const floor = plan.minTrainTrades;
  const enoughFolds = trainScores.length >= Math.ceil(plan.walkForward.folds.length / 2);
  return {
    index: combo.index,
    label: comboLabel(combo, plan.grid.axes),
    params: combo.params,
    trainScore: enoughFolds ? trainScores.reduce((s, v) => s + v, 0) / trainScores.length : null,
    trainFolds: trainScores.length,
    testScore: testStats ? rankScore(testStats, plan.objective, floor) : null,
    testStats,
    fullStats,
    fullScore: fullStats ? rankScore(fullStats, plan.objective, floor) : null,
    selectedInFolds: selections.filter((s) => s.selected?.comboIndex === combo.index).map((s) => s.fold.index),
  };
}

function argMax(values: readonly (number | null)[]): number {
  let best = -Infinity;
  let at = -1;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (v === null || !Number.isFinite(v)) continue;
    if (v > best) {
      best = v;
      at = i;
    }
  }
  return at;
}

function medianBaseline(summaries: readonly ComboSummary[], objective: ObjectiveKey): { score: number | null; netPct: number | null } {
  const scores = summaries.map((s) => s.testScore).filter((v): v is number => v !== null && Number.isFinite(v)).sort((a, b) => a - b);
  const nets = summaries.map((s) => s.testStats?.netProfitPct).filter((v): v is number => v !== undefined && Number.isFinite(v)).sort((a, b) => a - b);
  const mid = (arr: number[]) => (arr.length === 0 ? null : arr.length % 2 ? arr[arr.length >> 1] : (arr[(arr.length >> 1) - 1] + arr[arr.length >> 1]) / 2);
  return { score: mid(scores), netPct: mid(nets) };
}

/**
 * Two corrections, both on out-of-sample returns.
 *
 * The deflated Sharpe asks how high the best of N configurations climbs by luck
 * given the spread of the N results; the reality check asks the same question
 * without assuming anything about the shape of the returns, by resampling the
 * actual series in blocks. They are reported side by side because disagreement
 * is itself information: a large gap usually means the return distribution is
 * far from normal and the parametric answer should be discounted.
 */
function assessMultipleTesting(
  plan: OptimizePlan,
  summaries: readonly ComboSummary[],
  testBy: OutcomeIndex,
  fullBy: OutcomeIndex,
  stitchedOos: ReturnType<typeof stitchSegments>,
  stitchedStats: BacktestStats | null,
  runs: number,
  warnings: string[],
): MultipleTestingReport {
  const notes: string[] = [];
  const combos = plan.grid.combos.length;
  const folds = plan.walkForward.folds.length;
  const base: MultipleTestingReport = {
    combos,
    folds,
    runs,
    selectionTrials: combos * folds,
    deflatedWalkForward: null,
    deflatedNaive: null,
    reality: null,
    verdict: "not-evaluated",
    notes,
  };

  if (!plan.evaluateAllOnTest) {
    notes.push("evaluateAllOnTest was off, so there is no cross-section of trial results to correct against");
    return base;
  }

  const perCombo = plan.grid.combos.map((combo) => {
    const outcomes = plan.walkForward.folds
      .map((fold) => testBy.get(key(combo.index, fold.index)))
      .filter((o): o is SegmentOutcome => Boolean(o) && !o!.error);
    return concatDaily(outcomes);
  });
  const aligned = alignReturnMatrix(perCombo);

  if (aligned.days.length < 10) {
    notes.push(`only ${aligned.days.length} out-of-sample day(s) — too few to correct anything`);
    return base;
  }

  // A combination that never fired has an all-zero return row. Under the null
  // its recentred bootstrap statistic is exactly zero every draw, which pins the
  // best-of-grid null at or above zero and makes the grid-wide p-value
  // uninformative. It stays in: dropping it would shrink the null and make the
  // test easier to pass, which is the wrong direction to round in.
  const flat = aligned.matrix.filter((row) => row.every((v) => v === 0)).length;
  if (flat > 0) {
    notes.push(
      `${flat} of ${aligned.matrix.length} combination(s) never traded out of sample; ` +
        `their flat rows hold the reality-check null at zero, so the grid-wide p-value reads conservative`,
    );
  }

  const trialSharpes = summaries.map((s) => (s.testStats ? s.testStats.sharpeDaily : Number.NaN)).filter((v) => Number.isFinite(v));

  let deflatedWalkForward: DeflatedSharpeResult | null = null;
  if (stitchedStats && stitchedOos.returns.length > 1) {
    const m = moments(stitchedOos.returns);
    deflatedWalkForward = deflatedSharpe({
      sharpe: stitchedStats.sharpeDaily,
      observations: stitchedOos.returns.length,
      skew: m.skew,
      kurtosis: m.kurtosis,
      trialSharpes,
      trials: combos,
    });
  }

  let deflatedNaive: DeflatedSharpeResult | null = null;
  if (plan.compareNaive) {
    const fullSharpes = plan.grid.combos
      .map((c) => fullBy.get(key(c.index, -1)))
      .filter((o): o is SegmentOutcome => Boolean(o) && !o!.error)
      .map((o) => o.stats.sharpeDaily)
      .filter((v) => Number.isFinite(v));
    const bestFull = [...summaries].filter((s) => s.fullScore !== null).sort((a, b) => (b.fullScore ?? 0) - (a.fullScore ?? 0))[0];
    const bestOutcome = bestFull ? fullBy.get(key(bestFull.index, -1)) : undefined;
    if (bestOutcome && bestOutcome.returns && bestOutcome.returns.length > 1) {
      const m = moments(bestOutcome.returns);
      deflatedNaive = deflatedSharpe({
        sharpe: bestOutcome.stats.sharpeDaily,
        observations: bestOutcome.returns.length,
        skew: m.skew,
        kurtosis: m.kurtosis,
        trialSharpes: fullSharpes,
        trials: combos,
      });
    }
  }

  const candidateRow = stitchedOos.returns.length === aligned.days.length ? stitchedOos.returns : alignCandidate(stitchedOos, aligned.days);
  const reality = realityCheck({
    series: aligned.matrix,
    candidate: candidateRow,
    samples: plan.bootstrapSamples,
    seed: plan.seed,
  });

  const dsrOk = deflatedWalkForward ? deflatedWalkForward.dsr >= 0.95 : false;
  const rcOk = reality.candidatePValue !== null ? reality.candidatePValue <= 0.05 : false;
  const verdict: MultipleTestingReport["verdict"] = deflatedWalkForward === null ? "not-evaluated" : dsrOk && rcOk ? "survives" : "fails";

  if (!dsrOk && deflatedWalkForward) {
    notes.push(
      `deflated Sharpe ${deflatedWalkForward.dsr.toFixed(3)} is below 0.95: with ${combos} combination(s) tried and a trial spread of ` +
        `${Math.sqrt(deflatedWalkForward.trialVariance).toFixed(4)} daily Sharpe, a best-of-${combos} would be expected to reach ` +
        `${deflatedWalkForward.threshold.toFixed(4)} on luck alone`,
    );
  }
  if (!rcOk && reality.candidatePValue !== null) {
    notes.push(`reality-check p-value ${reality.candidatePValue.toFixed(3)} is above 0.05: the grid produces results this good from noise too often`);
  }
  if (verdict === "fails") warnings.push("the walk-forward result does not survive the multiple-testing correction");

  return { ...base, deflatedWalkForward, deflatedNaive, reality, verdict, notes };
}

/** Lays the stitched daily returns on the common day grid used by the bootstrap. */
function alignCandidate(stitched: ReturnType<typeof stitchSegments>, days: readonly number[]): number[] {
  const at = new Map<number, number>();
  for (let i = 0; i < stitched.days.length; i++) at.set(stitched.days[i], (at.get(stitched.days[i]) ?? 0) + stitched.returns[i]);
  return days.map((d) => at.get(d) ?? 0);
}

function foldScore(outcome: SegmentOutcome | null, objective: ObjectiveKey): number | null {
  return outcome ? scoreStats(outcome.stats, objective) : null;
}
