// Rendering for a walk-forward sweep.
//
// The order of the sections is the argument the report is making. First what
// was searched and how much of it — because the size of the search is the
// context for every number after it. Then the fold-by-fold selection, so the
// reader can see the parameters moving around (or not). Then the stitched
// out-of-sample track and the acceptance gate. Only then the comparison
// baselines, the multiple-testing correction and the plateau map, which exist
// to argue against the track, not for it.

import { toISO } from "../data/months.ts";
import { annualizeSharpe, TRADING_DAYS_PER_YEAR, type CriterionCheck } from "./report.ts";
import { objectiveLabel } from "./objective.ts";
import { formatAxisProfiles, type NeighbourStats } from "./plateau.ts";
import { describeFold, hasOverlappingTestWindows } from "./walkForward.ts";
import type { BacktestStats } from "../execution/backtest/stats";
import type { OptimizeResult } from "./optimizer.ts";

export const OPTIMIZE_REPORT_VERSION = 1;

export interface OptimizeReport {
  version: number;
  kind: "walk-forward-optimization";
  name: string;
  generatedAt: string;
  durationMs: number;
  workers: number;
  runs: number;
  instrument: { market: string; symbol: string; interval: string; signalIntervalSec: number };
  range: { from: string; to: string; bars: number };
  bot: { kind: string; params: Record<string, number | string> };
  costs: unknown;
  objective: string;
  grid: { size: number; axes: { key: string; values: (number | string)[] }[] };
  walkForward: {
    mode: string;
    trainDays: number;
    testDays: number;
    stepDays: number;
    warmupBars: number;
    folds: number;
    testFrom: string;
    testTo: string;
    testWindowsOverlap: boolean;
  };
  folds: {
    index: number;
    train: string;
    test: string;
    candidates: number;
    selected: string | null;
    trainScore: number | null;
    testScore: number | null;
    testTrades: number | null;
    testNetPct: number | null;
    note?: string;
  }[];
  outOfSample: {
    stats: BacktestStats | null;
    finalEquity: number;
    profitableWindows: { profitable: number; total: number; share: number } | null;
    maxLossStreak: number | null;
    stressProfitFactor: number | null;
    criteria: { passed: boolean; failed: string[]; unchecked: string[]; checks: CriterionCheck[] } | null;
  };
  baselines: OptimizeResult["baselines"];
  multipleTesting: OptimizeResult["multipleTesting"];
  plateau: {
    verdictInSample: string;
    verdictOutOfSample: string | null;
    robustnessInSample: number;
    axes: [string, string] | null;
    neighbours: NeighbourStats;
  } | null;
  top: OptimizeResult["top"];
  warnings: string[];
}

export function buildOptimizeReport(r: OptimizeResult): OptimizeReport {
  const spec = r.plan.spec;
  return {
    version: OPTIMIZE_REPORT_VERSION,
    kind: "walk-forward-optimization",
    name: r.plan.name,
    generatedAt: r.generatedAt,
    durationMs: r.durationMs,
    workers: r.workers,
    runs: r.runs,
    instrument: { market: spec.market, symbol: spec.symbol, interval: spec.interval, signalIntervalSec: spec.signalIntervalSec },
    range: { from: toISO(spec.fromSec), to: toISO(spec.toSec), bars: r.bars },
    bot: { kind: spec.bot.kind, params: spec.bot.params },
    costs: spec.costs,
    objective: r.plan.objective,
    grid: { size: r.plan.grid.size, axes: r.plan.grid.axes.map((a) => ({ key: a.key, values: a.values })) },
    walkForward: {
      mode: r.plan.walkForward.mode,
      trainDays: r.plan.walkForward.trainDays,
      testDays: r.plan.walkForward.testDays,
      stepDays: r.plan.walkForward.stepDays,
      warmupBars: r.plan.walkForward.warmupBars,
      folds: r.plan.walkForward.folds.length,
      testFrom: toISO(r.plan.walkForward.testFromSec),
      testTo: toISO(r.plan.walkForward.testToSec),
      testWindowsOverlap: hasOverlappingTestWindows(r.plan.walkForward),
    },
    folds: r.folds.map((f) => ({
      index: f.fold.index,
      train: `${toISO(f.fold.trainFromSec)} .. ${toISO(f.fold.trainToSec)}`,
      test: `${toISO(f.fold.testFromSec)} .. ${toISO(f.fold.testToSec)}`,
      candidates: f.candidates,
      selected: f.selected ? f.selected.label : null,
      trainScore: f.trainScore,
      testScore: f.testScore,
      testTrades: f.testStats ? f.testStats.trades : null,
      testNetPct: f.testStats ? f.testStats.netProfitPct : null,
      note: f.note,
    })),
    outOfSample: {
      stats: r.stitched.stats,
      finalEquity: r.stitched.finalEquity,
      profitableWindows: r.stitched.rolling && r.stitched.rolling.windows > 0
        ? { profitable: r.stitched.rolling.profitable, total: r.stitched.rolling.windows, share: r.stitched.rolling.share }
        : null,
      maxLossStreak: r.stitched.streaks ? r.stitched.streaks.maxLossStreak : null,
      stressProfitFactor: r.stitched.stressProfitFactor,
      criteria: r.stitched.criteria
        ? {
            passed: r.stitched.criteria.passed,
            failed: r.stitched.criteria.failed,
            unchecked: r.stitched.criteria.unchecked,
            checks: r.stitched.criteria.checks,
          }
        : null,
    },
    baselines: r.baselines,
    multipleTesting: r.multipleTesting,
    plateau: r.plateau
      ? {
          verdictInSample: r.plateau.train.verdict,
          verdictOutOfSample: r.plateau.test ? r.plateau.test.verdict : null,
          robustnessInSample: r.plateau.train.robustness,
          axes: r.plateau.axes,
          neighbours: r.plateau.train.neighbours,
        }
      : null,
    top: r.top,
    warnings: r.warnings,
  };
}

/* ── text ─────────────────────────────────────────────────────────────────── */

function num(v: number | null | undefined, digits = 2): string {
  if (v === null || v === undefined) return "n/a";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "n/a";
  return v.toFixed(digits);
}

function pct(v: number | null | undefined, digits = 2): string {
  return v === null || v === undefined || !Number.isFinite(v) ? "n/a" : `${v >= 0 ? "+" : ""}${v.toFixed(digits)}%`;
}

function verdictWord(check: CriterionCheck): string {
  if (check.passed === true) return "PASS";
  if (check.passed === false) return "FAIL";
  return check.gate ? "SKIP" : "INFO";
}

function table(head: string[], body: string[][]): string {
  const widths = head.map((h, i) => Math.max(h.length, ...body.map((row) => (row[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === 0 ? (c ?? "").padEnd(widths[i]) : (c ?? "").padStart(widths[i]))).join("  ");
  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}

export function formatOptimizeReportText(r: OptimizeResult): string {
  const l: string[] = [];
  const spec = r.plan.spec;
  const wf = r.plan.walkForward;
  const s = r.stitched.stats;

  l.push(`Walk-forward optimization — ${r.plan.name}`);
  l.push(`Instrument  ${spec.market}:${spec.symbol}:${spec.interval}${spec.signalIntervalSec ? ` (signals every ${spec.signalIntervalSec}s)` : ""}`);
  l.push(`Range       ${toISO(spec.fromSec)} .. ${toISO(spec.toSec)}  (${r.bars} bars)`);
  l.push(`Bot         ${spec.bot.kind}, fixed params ${JSON.stringify(spec.bot.params)}`);
  l.push(`Objective   ${r.plan.objective} — ${objectiveLabel(r.plan.objective)}`);
  l.push(`Effort      ${r.plan.grid.size} combination(s) x ${wf.folds.length} fold(s), ${r.runs} segment run(s), ${r.workers} worker(s), ${(r.durationMs / 1000).toFixed(1)}s`);
  l.push(`Generated   ${r.generatedAt}`);

  l.push("");
  l.push("Search space");
  for (const axis of r.plan.grid.axes) {
    l.push(`  ${axis.key.padEnd(20)} ${axis.values.length.toString().padStart(3)} value(s): ${axis.values.join(", ")}`);
  }
  l.push(`  total combinations   ${r.plan.grid.size}`);
  l.push(`  selection fits       ${r.multipleTesting.selectionTrials} (combinations x folds)`);

  l.push("");
  l.push(`Walk-forward split (${wf.mode}, train ${wf.trainDays}d / test ${wf.testDays}d / step ${wf.stepDays}d, warm-up ${wf.warmupBars} bar(s))`);
  for (const fold of wf.folds) l.push(`  ${describeFold(fold)}`);
  l.push(`  out-of-sample stretch  ${toISO(wf.testFromSec)} .. ${toISO(wf.testToSec)}`);
  if (wf.leftoverDays >= 1) l.push(`  ${wf.leftoverDays.toFixed(1)} day(s) at the end did not fit a full fold and were not used`);
  if (hasOverlappingTestWindows(wf)) {
    l.push("  warning: test windows overlap (step is shorter than the test window). The stitched track counts some days");
    l.push("           twice, so its trade count and its apparent length are both larger than the real record.");
  }

  l.push("");
  l.push("Selection per fold");
  l.push(
    table(
      ["fold", "candidates", "train", "test", "trades", "net%", "parameters"],
      r.folds.map((f) => [
        String(f.fold.index + 1),
        String(f.candidates),
        num(f.trainScore),
        num(f.testScore),
        f.testStats ? String(f.testStats.trades) : "n/a",
        f.testStats ? pct(f.testStats.netProfitPct) : "n/a",
        f.selected ? f.selected.label : (f.note ?? "no selection"),
      ]),
    )
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  );
  const distinct = new Set(r.folds.map((f) => f.selected?.label).filter(Boolean));
  l.push(
    `  ${distinct.size} distinct parameter set(s) across ${r.folds.length} fold(s)` +
      (distinct.size === r.folds.length && r.folds.length > 1
        ? " — the optimum moves every fold, which is what an unstable parameter looks like"
        : distinct.size === 1
          ? " — the same set wins every fold, which is the stable case"
          : ""),
  );

  l.push("");
  l.push("Out-of-sample track (test windows only, compounded)");
  if (!s) {
    l.push("  no fold produced a selection — there is nothing to judge");
  } else {
    l.push(`  Balance         ${spec.initialBalance.toFixed(2)} -> ${r.stitched.finalEquity.toFixed(2)} USDT (${pct(s.netProfitPct)})`);
    l.push(`  Profit factor   ${num(s.profitFactor)}`);
    l.push(`  Trades          ${s.trades} (${s.wins} win / ${s.losses} loss, win rate ${(s.winRate * 100).toFixed(1)}%)`);
    l.push(`  Max drawdown    ${s.maxDrawdown.toFixed(2)} USDT (${s.maxDrawdownPct.toFixed(2)}% of peak)`);
    l.push(`  Sharpe          daily ${num(s.sharpeDaily, 4)}, annualised ${num(annualizeSharpe(s.sharpeDaily))} (x sqrt(${TRADING_DAYS_PER_YEAR}))`);
    l.push(`  Avg trade       ${num(s.avgTrade)} USDT, avg hold ${s.avgHoldSec.toFixed(0)}s`);
    if (r.stitched.streaks) l.push(`  Max losing run  ${r.stitched.streaks.maxLossStreak} trade(s)`);
    if (r.stitched.rolling && r.stitched.rolling.windows > 0) {
      l.push(`  Profitable ${r.stitched.rolling.windowDays}d windows  ${r.stitched.rolling.profitable}/${r.stitched.rolling.windows} (${(r.stitched.rolling.share * 100).toFixed(1)}%)`);
    }
    if (r.stitched.stressProfitFactor !== null) {
      const vacuous = spec.costs.slippage === false ? "  (identical to the base run — the cost declaration has no slippage to multiply)" : "";
      l.push(`  Profit factor under x${spec.stressSlippage} slippage  ${num(r.stitched.stressProfitFactor)}${vacuous}`);
    }
    l.push(`  Per-fold growth ${r.stitched.multiples.map((m) => `x${m.toFixed(3)}`).join(" ")}`);
  }

  l.push("");
  l.push("Comparison — the same out-of-sample days, judged four ways");
  const b = r.baselines;
  l.push(
    table(
      ["reading", r.plan.objective, "what it means"],
      [
        ["walk-forward", num(b.walkForward.score), "parameters refitted per fold, judged on unseen data — the only honest line"],
        ["median combination", num(b.medianCombo.score), "what picking at random from the grid would have given"],
        ["best with hindsight", num(b.oracle?.score ?? null), "ceiling of the grid on this data; unreachable in advance"],
        ["naive optimization", num(b.naive?.inSampleScore ?? null), "best combination scored on the data that chose it — the number to distrust"],
        ["  the same, honestly", num(b.naive?.walkForwardScore ?? null), "what that combination actually did out of sample"],
      ],
    )
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  );
  if (b.naive) l.push(`  naive winner: ${b.naive.label}`);
  if (b.oracle) l.push(`  hindsight winner: ${b.oracle.label}`);

  l.push("");
  l.push("Multiple testing");
  const mt = r.multipleTesting;
  l.push(`  Combinations tried      ${mt.combos}`);
  l.push(`  Selection fits          ${mt.selectionTrials} (${mt.folds} fold(s))`);
  l.push(`  Segment backtests run   ${mt.runs}`);
  if (mt.deflatedWalkForward) {
    const d = mt.deflatedWalkForward;
    l.push(`  Deflated Sharpe (walk-forward)`);
    l.push(`    observed daily Sharpe   ${num(d.sharpe, 4)} over ${mt.reality?.observations ?? 0} day(s)`);
    l.push(`    luck threshold          ${num(d.threshold, 4)} = expected best of ${d.trials} draws with trial sd ${num(Math.sqrt(d.trialVariance), 4)}`);
    l.push(`    DSR                     ${num(d.dsr, 3)}  (needs > 0.95; without the trials charge it would be ${num(d.psrZero, 3)})`);
  }
  if (mt.deflatedNaive) {
    l.push(`  Deflated Sharpe (naive in-sample best)  ${num(mt.deflatedNaive.dsr, 3)} against threshold ${num(mt.deflatedNaive.threshold, 4)}`);
  }
  if (mt.reality) {
    const rc = mt.reality;
    l.push(`  Reality check (stationary bootstrap, ${rc.samples} draws, mean block ${rc.blockLength} day(s), seed ${r.plan.seed})`);
    l.push(`    best of grid            statistic ${num(rc.statistic, 4)}, p = ${num(rc.pValue, 3)}`);
    if (rc.candidateStatistic !== null) {
      l.push(`    walk-forward track      statistic ${num(rc.candidateStatistic, 4)}, p = ${num(rc.candidatePValue, 3)}  (needs < 0.05)`);
    }
  }
  l.push(`  Verdict                 ${mt.verdict.toUpperCase()}`);
  for (const note of mt.notes) l.push(`    - ${note}`);

  if (r.plateau) {
    l.push("");
    l.push(`Plateau or peak (${objectiveLabel(r.plan.objective)})`);
    const p = r.plateau.train;
    l.push(`  Centre                  ${r.top[0]?.label ?? `combo ${p.bestIndex}`}`);
    l.push(`  In-sample verdict       ${p.verdict.toUpperCase()} — ${p.neighbours.holding}/${p.neighbours.scored} neighbour(s) keep at least half the score`);
    l.push(`  Neighbour scores        median ${num(p.neighbours.median)}, min ${num(p.neighbours.min)}, max ${num(p.neighbours.max)}; grid median ${num(p.gridMedian)}`);
    if (r.plateau.test) {
      l.push(`  Out-of-sample verdict   ${r.plateau.test.verdict.toUpperCase()} — ${r.plateau.test.neighbours.holding}/${r.plateau.test.neighbours.scored} neighbour(s) hold`);
    }
    l.push("");
    for (const line of r.plateau.trainMap.split("\n")) l.push(`  ${line}`);
    if (r.plateau.testMap) {
      l.push("");
      for (const line of r.plateau.testMap.split("\n")) l.push(`  ${line}`);
    }
    l.push("");
    for (const line of formatAxisProfiles(p.axisProfiles, r.plan.grid.axes).split("\n")) l.push(`  ${line}`);
  }

  l.push("");
  l.push(`Top ${r.top.length} combination(s) by mean training score`);
  l.push(
    table(
      ["#", "train", "rankable folds", "test", "test trades", "test net%", "folds won", "parameters"],
      r.top.map((c, i) => [
        String(i + 1),
        num(c.trainScore),
        `${c.trainFolds}/${r.folds.length}`,
        num(c.testScore),
        c.testStats ? String(c.testStats.trades) : "n/a",
        c.testStats ? pct(c.testStats.netProfitPct) : "n/a",
        c.selectedInFolds.length ? c.selectedInFolds.map((f) => f + 1).join(",") : "-",
        c.label,
      ]),
    )
      .split("\n")
      .map((line) => `  ${line}`)
      .join("\n"),
  );

  l.push("");
  l.push("Acceptance criteria (docs/strategy-search.md), evaluated on the stitched out-of-sample track");
  if (!r.stitched.criteria) {
    l.push("  not evaluated — no out-of-sample track was produced");
  } else {
    for (const c of r.stitched.criteria.checks) {
      const tail = c.note ? `  — ${c.note}` : "";
      l.push(`  [${verdictWord(c)}] ${c.label.padEnd(26)} ${c.requirement.padEnd(34)} got ${c.value}${tail}`);
    }
    l.push("");
    l.push(`  Gate:            ${r.stitched.criteria.passed ? "PASSED" : "NOT PASSED"}`);
    l.push(`  Multiple testing: ${r.multipleTesting.verdict.toUpperCase()}`);
    l.push(`  Plateau:          ${r.plateau ? r.plateau.train.verdict.toUpperCase() : "N/A"}`);
    l.push(
      `  Overall:          ${
        r.stitched.criteria.passed && r.multipleTesting.verdict === "survives" && r.plateau?.train.verdict === "plateau"
          ? "CANDIDATE — take it to the untouched out-of-sample period"
          : "REJECTED"
      }`,
    );
  }

  if (r.warnings.length > 0) {
    l.push("");
    l.push("Warnings");
    for (const w of dedupeWarnings(r.warnings)) l.push(`  - ${w}`);
  }

  return l.join("\n");
}

/** Per-segment failures repeat once per combination; collapse them. */
function dedupeWarnings(warnings: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const w of warnings) {
    const generic = w.replace(/combo \d+/, "combo N").replace(/fold \d+/, "fold N");
    counts.set(generic, (counts.get(generic) ?? 0) + 1);
  }
  return Array.from(counts.entries()).map(([w, n]) => (n > 1 ? `${w} (x${n})` : w));
}
