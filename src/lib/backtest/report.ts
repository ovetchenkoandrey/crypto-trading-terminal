// Report builder for headless runs.
//
// Three things live here that `computeStats` deliberately does not compute:
//
//  - losing streaks and their distribution. The martingale decision hangs on
//    the tail of that distribution, not on the average trade;
//  - the share of profitable rolling months, which is the acceptance rule for
//    "stable over time" rather than "one good quarter";
//  - the acceptance gate itself, evaluated against docs/strategy-search.md.
//
// Sharpe needs care. `BacktestStats.sharpeDaily` is per day; the threshold in
// the strategy document (> 1.0) is the annual figure everyone quotes. Both are
// printed, the gate uses the annualised one, and the report says which is which.

import type { PaperTrade } from "../store";
import type { BacktestStats, EquitySample } from "../execution/backtest/stats";
import { toISO } from "../data/months.ts";
import type { RunSpec, RunWindow } from "./runConfig.ts";

/* ── losing / winning streaks ─────────────────────────────────────────────── */

export interface StreakBucket {
  length: number;
  count: number;
}

export interface StreakStats {
  maxLossStreak: number;
  maxWinStreak: number;
  /** Number of distinct losing runs. */
  lossStreaks: number;
  avgLossStreak: number;
  /** How many losing runs of each length, ascending by length. */
  lossDistribution: StreakBucket[];
  /** Losing run still open when the series ended. */
  finalLossStreak: number;
}

/**
 * Consecutive runs of losing trades in close order. A zero-P&L trade breaks
 * both streaks: it is neither a win nor a loss, and folding it into either one
 * would invent a streak that never happened.
 */
export function computeStreaks(trades: readonly Pick<PaperTrade, "pnl">[]): StreakStats {
  const lossLengths: number[] = [];
  let maxWin = 0;
  let lossRun = 0;
  let winRun = 0;

  const closeLoss = () => {
    if (lossRun > 0) lossLengths.push(lossRun);
    lossRun = 0;
  };

  for (const t of trades) {
    if (t.pnl < 0) {
      winRun = 0;
      lossRun += 1;
    } else if (t.pnl > 0) {
      closeLoss();
      winRun += 1;
      if (winRun > maxWin) maxWin = winRun;
    } else {
      closeLoss();
      winRun = 0;
    }
  }
  const finalLossStreak = lossRun;
  closeLoss();

  const byLength = new Map<number, number>();
  for (const len of lossLengths) byLength.set(len, (byLength.get(len) ?? 0) + 1);

  return {
    maxLossStreak: lossLengths.reduce((m, l) => Math.max(m, l), 0),
    maxWinStreak: maxWin,
    lossStreaks: lossLengths.length,
    avgLossStreak: lossLengths.length ? lossLengths.reduce((s, l) => s + l, 0) / lossLengths.length : 0,
    lossDistribution: Array.from(byLength.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([length, count]) => ({ length, count })),
    finalLossStreak,
  };
}

/* ── rolling windows ──────────────────────────────────────────────────────── */

export interface RollingWindow {
  fromSec: number;
  toSec: number;
  startEquity: number;
  endEquity: number;
  returnPct: number;
}

export interface RollingWindowStats {
  windowDays: number;
  stepDays: number;
  windows: number;
  profitable: number;
  /** 0..1. NaN-free: 0 when no window fits. */
  share: number;
  best: RollingWindow | null;
  worst: RollingWindow | null;
  /** True when the equity series is shorter than one window. */
  insufficient: boolean;
}

function equityAt(equity: readonly EquitySample[], t: number): number {
  let lo = 0;
  let hi = equity.length - 1;
  let idx = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (equity[mid].time <= t) {
      idx = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return equity[idx < 0 ? 0 : idx].equity;
}

/**
 * Share of rolling windows that ended above where they started.
 *
 * The series is treated as covering `[first, last + barSec)` — the last bar owns
 * its own interval. Without that, a run over exactly one calendar month ends one
 * bar short of a single 30-day window and the metric reports "no data".
 */
export interface RollingWindowOptions {
  /** Bar size, so the last bar is credited with the interval it covers. */
  barSec?: number;
  /** Start of the run. Equity sampling begins one bar in, which loses a bar. */
  startSec?: number;
}

export function computeRollingWindows(
  equity: readonly EquitySample[],
  window: RunWindow,
  opts: RollingWindowOptions = {},
): RollingWindowStats {
  const windowSec = Math.round(window.days * 86_400);
  const stepSec = Math.max(1, Math.round(window.stepDays * 86_400));
  const base: RollingWindowStats = {
    windowDays: window.days,
    stepDays: window.stepDays,
    windows: 0,
    profitable: 0,
    share: 0,
    best: null,
    worst: null,
    insufficient: true,
  };
  if (equity.length < 2) return base;

  const inferred = opts.barSec && opts.barSec > 0 ? opts.barSec : Math.max(1, equity[1].time - equity[0].time);
  const first = opts.startSec !== undefined ? Math.min(opts.startSec, equity[0].time) : equity[0].time;
  const endExclusive = equity[equity.length - 1].time + inferred;
  if (endExclusive - first < windowSec) return base;

  const out: RollingWindow[] = [];
  for (let start = first; start + windowSec <= endExclusive; start += stepSec) {
    const stop = start + windowSec;
    const startEquity = equityAt(equity, start);
    const endEquity = equityAt(equity, Math.min(stop, equity[equity.length - 1].time));
    out.push({
      fromSec: start,
      toSec: stop,
      startEquity,
      endEquity,
      returnPct: startEquity > 0 ? ((endEquity - startEquity) / startEquity) * 100 : 0,
    });
  }
  if (out.length === 0) return base;

  const profitable = out.filter((w) => w.endEquity > w.startEquity).length;
  const sorted = [...out].sort((a, b) => a.returnPct - b.returnPct);
  return {
    windowDays: window.days,
    stepDays: window.stepDays,
    windows: out.length,
    profitable,
    share: profitable / out.length,
    best: sorted[sorted.length - 1],
    worst: sorted[0],
    insufficient: false,
  };
}

/* ── sharpe ───────────────────────────────────────────────────────────────── */

/** Trading is 24/7 on crypto, so the year is 365 days, not 252. */
export const TRADING_DAYS_PER_YEAR = 365;

export function annualizeSharpe(sharpeDaily: number): number {
  return Number.isFinite(sharpeDaily) ? sharpeDaily * Math.sqrt(TRADING_DAYS_PER_YEAR) : 0;
}

/* ── acceptance gate ──────────────────────────────────────────────────────── */

export const ACCEPTANCE = {
  profitFactor: 1.3,
  trades: 100,
  maxDrawdownPct: 20,
  sharpeAnnual: 1.0,
  profitableWindowShare: 0.6,
  stressMultiplier: 2,
} as const;

export interface CriterionCheck {
  key: string;
  label: string;
  requirement: string;
  value: string;
  raw: number | null;
  /** null = not evaluated (missing input), and it counts as "not passed". */
  passed: boolean | null;
  gate: boolean;
  note?: string;
}

export interface CriteriaInput {
  stats: BacktestStats;
  rolling: RollingWindowStats;
  streaks: StreakStats;
  /** Profit factor of the paired stressed run, when one was made. */
  stressProfitFactor?: number | null;
  stressMultiplier?: number | null;
  /** Any liquidation invalidates the run, whatever the P&L says. */
  liquidations?: number;
}

export interface CriteriaVerdict {
  checks: CriterionCheck[];
  /** Every gate criterion evaluated and passed. */
  passed: boolean;
  failed: string[];
  unchecked: string[];
}

function fmtNum(v: number, digits = 2): string {
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "n/a";
  return v.toFixed(digits);
}

export function checkCriteria(input: CriteriaInput): CriteriaVerdict {
  const { stats, rolling, streaks } = input;
  const sharpeAnnual = annualizeSharpe(stats.sharpeDaily);
  const checks: CriterionCheck[] = [];

  checks.push({
    key: "profitFactor",
    label: "Profit factor",
    requirement: `> ${ACCEPTANCE.profitFactor}`,
    value: fmtNum(stats.profitFactor),
    raw: Number.isFinite(stats.profitFactor) ? stats.profitFactor : null,
    passed: stats.trades > 0 ? stats.profitFactor > ACCEPTANCE.profitFactor : null,
    gate: true,
    note: stats.trades === 0 ? "no trades" : undefined,
  });

  checks.push({
    key: "trades",
    label: "Trade count",
    requirement: `>= ${ACCEPTANCE.trades}`,
    value: String(stats.trades),
    raw: stats.trades,
    passed: stats.trades >= ACCEPTANCE.trades,
    gate: true,
  });

  checks.push({
    key: "maxDrawdown",
    label: "Max drawdown",
    requirement: `< ${ACCEPTANCE.maxDrawdownPct}% of peak equity`,
    value: `${fmtNum(stats.maxDrawdownPct)}%`,
    raw: stats.maxDrawdownPct,
    passed: stats.maxDrawdownPct < ACCEPTANCE.maxDrawdownPct,
    gate: true,
  });

  checks.push({
    key: "sharpe",
    label: "Sharpe (annualised)",
    requirement: `> ${ACCEPTANCE.sharpeAnnual}`,
    value: fmtNum(sharpeAnnual),
    raw: sharpeAnnual,
    passed: sharpeAnnual > ACCEPTANCE.sharpeAnnual,
    gate: true,
    note: `daily ${fmtNum(stats.sharpeDaily, 4)} x sqrt(${TRADING_DAYS_PER_YEAR})`,
  });

  checks.push({
    key: "profitableWindows",
    label: "Profitable rolling months",
    requirement: `>= ${(ACCEPTANCE.profitableWindowShare * 100).toFixed(0)}%`,
    value: rolling.windows > 0 ? `${(rolling.share * 100).toFixed(1)}% (${rolling.profitable}/${rolling.windows})` : "n/a",
    raw: rolling.windows > 0 ? rolling.share : null,
    passed: rolling.windows > 0 ? rolling.share >= ACCEPTANCE.profitableWindowShare : null,
    gate: true,
    note: rolling.windows === 0
      ? "run is shorter than one window"
      : `${rolling.windowDays}d window, ${rolling.stepDays}d step`,
  });

  const stressed = input.stressProfitFactor;
  const mult = input.stressMultiplier ?? ACCEPTANCE.stressMultiplier;
  checks.push({
    key: "costStress",
    label: `Survives x${mult} slippage`,
    requirement: `profit factor > ${ACCEPTANCE.profitFactor} under stress`,
    value: stressed === undefined || stressed === null ? "not run" : fmtNum(stressed),
    raw: stressed ?? null,
    passed: stressed === undefined || stressed === null ? null : stressed > ACCEPTANCE.profitFactor,
    gate: true,
    note: stressed === undefined || stressed === null ? "pass stressSlippage to evaluate" : undefined,
  });

  const liquidations = input.liquidations ?? 0;
  checks.push({
    key: "liquidations",
    label: "Liquidations",
    requirement: "= 0",
    value: String(liquidations),
    raw: liquidations,
    passed: liquidations === 0,
    gate: true,
    note: liquidations > 0 ? "the account was wiped — every metric above is fiction" : undefined,
  });

  checks.push({
    key: "maxLossStreak",
    label: "Max losing streak",
    requirement: "recorded, not a gate",
    value: String(streaks.maxLossStreak),
    raw: streaks.maxLossStreak,
    passed: null,
    gate: false,
    note: "input for the martingale decision",
  });

  const gates = checks.filter((c) => c.gate);
  return {
    checks,
    passed: gates.every((c) => c.passed === true),
    failed: gates.filter((c) => c.passed === false).map((c) => c.key),
    unchecked: gates.filter((c) => c.passed === null).map((c) => c.key),
  };
}

/* ── the report ───────────────────────────────────────────────────────────── */

export interface ReportRunMeta {
  name: string;
  market: string;
  symbol: string;
  interval: string;
  fromSec: number;
  toSec: number;
  from: string;
  to: string;
  bars: number;
  initialBalance: number;
  bot: { kind: string; id: string; params: Record<string, number | string> };
  durationMs: number;
  generatedAt: string;
}

export interface BacktestReport {
  version: number;
  run: ReportRunMeta;
  costs: {
    /** From the engine — the models that actually ran. */
    applied: string[];
    /** Parameters of each model, resolved. */
    detail: string[];
    declared: unknown;
  };
  stats: BacktestStats & { sharpeAnnual: number; finalEquity: number };
  execution: {
    funding: number;
    rejectedOrders: number;
    liquidations: number;
    openPositions: number;
    pendingOrders: number;
  };
  streaks: StreakStats;
  rolling: RollingWindowStats;
  stress: { multiplier: number; profitFactor: number; netProfit: number; trades: number } | null;
  criteria: CriteriaVerdict;
}

export const REPORT_VERSION = 1;

export interface BuildReportInput {
  spec: RunSpec;
  bars: number;
  durationMs: number;
  stats: BacktestStats;
  equity: readonly EquitySample[];
  trades: readonly Pick<PaperTrade, "pnl">[];
  funding: number;
  rejected: number;
  liquidations?: number;
  openPositions: number;
  pendingOrders: number;
  costsApplied: string[];
  costsDetail: string[];
  barSec?: number;
  /** Time of the first bar fed to the engine — anchors the rolling windows. */
  rangeStartSec?: number;
  stress?: { multiplier: number; stats: BacktestStats } | null;
  now?: number;
}

export function buildReport(input: BuildReportInput): BacktestReport {
  const { spec, stats } = input;
  const streaks = computeStreaks(input.trades);
  const rolling = computeRollingWindows(input.equity, spec.window, {
    barSec: input.barSec,
    startSec: input.rangeStartSec,
  });
  const finalEquity = input.equity.length
    ? input.equity[input.equity.length - 1].equity
    : spec.initialBalance;

  const stress = input.stress
    ? {
        multiplier: input.stress.multiplier,
        profitFactor: input.stress.stats.profitFactor,
        netProfit: input.stress.stats.netProfit,
        trades: input.stress.stats.trades,
      }
    : null;

  const criteria = checkCriteria({
    stats,
    rolling,
    streaks,
    stressProfitFactor: stress ? stress.profitFactor : null,
    stressMultiplier: stress ? stress.multiplier : spec.stressSlippage,
    liquidations: input.liquidations ?? 0,
  });

  return {
    version: REPORT_VERSION,
    run: {
      name: spec.name,
      market: spec.market,
      symbol: spec.symbol,
      interval: spec.interval,
      fromSec: spec.fromSec,
      toSec: spec.toSec,
      from: toISO(spec.fromSec),
      to: toISO(spec.toSec),
      bars: input.bars,
      initialBalance: spec.initialBalance,
      bot: { kind: spec.bot.kind, id: spec.bot.id, params: spec.bot.params },
      durationMs: Math.round(input.durationMs),
      generatedAt: new Date(input.now ?? Date.now()).toISOString(),
    },
    costs: {
      applied: input.costsApplied,
      detail: input.costsDetail,
      declared: spec.costs,
    },
    stats: { ...stats, sharpeAnnual: annualizeSharpe(stats.sharpeDaily), finalEquity },
    execution: {
      funding: input.funding,
      rejectedOrders: input.rejected,
      liquidations: input.liquidations ?? 0,
      openPositions: input.openPositions,
      pendingOrders: input.pendingOrders,
    },
    streaks,
    rolling,
    stress,
    criteria,
  };
}

/* ── text rendering ───────────────────────────────────────────────────────── */

function money(v: number): string {
  return `${v >= 0 ? "+" : "-"}${Math.abs(v).toFixed(2)}`;
}

function verdictWord(check: CriterionCheck): string {
  if (check.passed === true) return "PASS";
  if (check.passed === false) return "FAIL";
  return check.gate ? "SKIP" : "INFO";
}

export function formatReportText(r: BacktestReport): string {
  const l: string[] = [];
  const s = r.stats;

  l.push(`Backtest report — ${r.run.name}`);
  l.push(`Instrument  ${r.run.market}:${r.run.symbol}:${r.run.interval}`);
  l.push(`Range       ${r.run.from} .. ${r.run.to}  (${r.run.bars} bars)`);
  l.push(`Bot         ${r.run.bot.kind} [${r.run.bot.id}] ${JSON.stringify(r.run.bot.params)}`);
  l.push(`Balance     ${r.run.initialBalance.toFixed(2)} -> ${s.finalEquity.toFixed(2)} USDT`);
  l.push(`Verdict     ${r.criteria.passed ? "ACCEPTED" : "REJECTED"}${r.criteria.failed.length ? ` (failed: ${r.criteria.failed.join(", ")})` : ""}${r.criteria.unchecked.length ? ` (not checked: ${r.criteria.unchecked.join(", ")})` : ""}`);
  l.push(`Run time    ${(r.run.durationMs / 1000).toFixed(1)}s, generated ${r.run.generatedAt}`);

  l.push("");
  l.push("Cost models applied");
  if (r.costs.applied.length === 0) l.push("  (none — this run pays no modelled costs beyond the flat fee)");
  else for (const name of r.costs.applied) l.push(`  - ${name}`);
  for (const line of r.costs.detail) l.push(`  ${line}`);

  l.push("");
  l.push("Performance");
  l.push(`  Net profit      ${money(s.netProfit)} USDT (${money(s.netProfitPct)}%)`);
  l.push(`  Profit factor   ${fmtNum(s.profitFactor)}`);
  l.push(`  Trades          ${s.trades} (${s.wins} win / ${s.losses} loss, win rate ${(s.winRate * 100).toFixed(1)}%)`);
  l.push(`  Avg trade       ${money(s.avgTrade)} USDT (win ${money(s.avgWin)}, loss ${money(s.avgLoss)})`);
  l.push(`  Max drawdown    ${s.maxDrawdown.toFixed(2)} USDT (${s.maxDrawdownPct.toFixed(2)}% of peak)`);
  l.push(`  Sharpe          daily ${fmtNum(s.sharpeDaily, 4)}, annualised ${fmtNum(s.sharpeAnnual)} (x sqrt(${TRADING_DAYS_PER_YEAR}))`);
  l.push(`  Avg hold        ${s.avgHoldSec.toFixed(0)}s`);

  l.push("");
  l.push("Execution");
  l.push(`  Funding         ${money(r.execution.funding)} USDT`);
  l.push(`  Rejected orders ${r.execution.rejectedOrders}  (takers dropped and size/leverage violations; a resting limit that missed its queue stays in the book)`);
  l.push(`  Liquidations    ${r.execution.liquidations}`);
  l.push(`  Left open       ${r.execution.openPositions} position(s), ${r.execution.pendingOrders} pending order(s)`);

  l.push("");
  l.push("Losing streaks");
  l.push(`  Max losing run  ${r.streaks.maxLossStreak} trade(s)  (max winning run ${r.streaks.maxWinStreak})`);
  l.push(`  Losing runs     ${r.streaks.lossStreaks}, average length ${r.streaks.avgLossStreak.toFixed(2)}`);
  if (r.streaks.finalLossStreak > 0) l.push(`  Open at the end ${r.streaks.finalLossStreak} trade(s)`);
  if (r.streaks.lossDistribution.length > 0) {
    l.push("  length  runs");
    for (const b of r.streaks.lossDistribution) {
      l.push(`  ${String(b.length).padStart(6)}  ${String(b.count).padStart(4)}  ${"#".repeat(Math.min(40, b.count))}`);
    }
  }

  l.push("");
  l.push(`Rolling windows (${r.rolling.windowDays}d window, ${r.rolling.stepDays}d step)`);
  if (r.rolling.windows === 0) {
    l.push("  not enough data — the run is shorter than one window");
  } else {
    l.push(`  Profitable      ${r.rolling.profitable}/${r.rolling.windows} (${(r.rolling.share * 100).toFixed(1)}%)`);
    if (r.rolling.best) l.push(`  Best            ${money(r.rolling.best.returnPct)}%  ${toISO(r.rolling.best.fromSec)} .. ${toISO(r.rolling.best.toSec)}`);
    if (r.rolling.worst) l.push(`  Worst           ${money(r.rolling.worst.returnPct)}%  ${toISO(r.rolling.worst.fromSec)} .. ${toISO(r.rolling.worst.toSec)}`);
  }

  if (r.stress) {
    l.push("");
    l.push(`Cost stress (x${r.stress.multiplier} slippage)`);
    l.push(`  Profit factor   ${fmtNum(r.stress.profitFactor)}`);
    l.push(`  Net profit      ${money(r.stress.netProfit)} USDT over ${r.stress.trades} trade(s)`);
  }

  l.push("");
  l.push("Acceptance criteria (docs/strategy-search.md)");
  for (const c of r.criteria.checks) {
    const tail = c.note ? `  — ${c.note}` : "";
    l.push(`  [${verdictWord(c)}] ${c.label.padEnd(26)} ${c.requirement.padEnd(34)} got ${c.value}${tail}`);
  }
  l.push("");
  l.push(`  Overall: ${r.criteria.passed ? "PASSED" : "NOT PASSED"}`);

  return l.join("\n");
}

/* ── multi-run summary ────────────────────────────────────────────────────── */

export interface SummaryRow {
  name: string;
  symbol: string;
  trades: number;
  netProfit: number;
  netProfitPct: number;
  profitFactor: number;
  maxDrawdownPct: number;
  sharpeAnnual: number;
  windowShare: number | null;
  maxLossStreak: number;
  funding: number;
  rejected: number;
  passed: boolean;
}

export function summaryRow(r: BacktestReport): SummaryRow {
  return {
    name: r.run.name,
    symbol: r.run.symbol,
    trades: r.stats.trades,
    netProfit: r.stats.netProfit,
    netProfitPct: r.stats.netProfitPct,
    profitFactor: r.stats.profitFactor,
    maxDrawdownPct: r.stats.maxDrawdownPct,
    sharpeAnnual: r.stats.sharpeAnnual,
    windowShare: r.rolling.windows > 0 ? r.rolling.share : null,
    maxLossStreak: r.streaks.maxLossStreak,
    funding: r.execution.funding,
    rejected: r.execution.rejectedOrders,
    passed: r.criteria.passed,
  };
}

export function formatSummaryTable(reports: readonly BacktestReport[]): string {
  const rows = reports.map(summaryRow);
  const head = ["run", "trades", "net", "net%", "PF", "maxDD%", "sharpeY", "win-mo", "lossRun", "funding", "rej", "gate"];
  const body = rows.map((r) => [
    r.name,
    String(r.trades),
    r.netProfit.toFixed(2),
    r.netProfitPct.toFixed(2),
    fmtNum(r.profitFactor),
    r.maxDrawdownPct.toFixed(2),
    fmtNum(r.sharpeAnnual),
    r.windowShare === null ? "n/a" : `${(r.windowShare * 100).toFixed(0)}%`,
    String(r.maxLossStreak),
    r.funding.toFixed(2),
    String(r.rejected),
    r.passed ? "PASS" : "FAIL",
  ]);

  const widths = head.map((h, i) => Math.max(h.length, ...body.map((b) => b[i].length)));
  const line = (cells: string[]) =>
    cells.map((c, i) => (i === 0 ? c.padEnd(widths[i]) : c.padStart(widths[i]))).join("  ");

  return [line(head), widths.map((w) => "-".repeat(w)).join("  "), ...body.map(line)].join("\n");
}
