import type { Candle } from "../types.ts";
import { monthOf, toISO, type MonthKey } from "./months.ts";

/**
 * Data quality checks.
 *
 * A backtest cannot tell the difference between a strategy that works and a
 * dataset with holes in it — both produce a plausible equity curve. So the rule
 * here is that nothing is repaired silently: gaps are reported, never filled,
 * and every finding lands in a machine-readable structure that a run can gate on
 * as well as in text a human can skim.
 */

export type IssueKind =
  | "gap"
  | "duplicate"
  | "out-of-order"
  | "misaligned"
  | "bad-ohlc"
  | "non-positive"
  | "extreme-move"
  | "flat-run"
  | "month-seam"
  | "source-mix"
  | "coverage"
  | "storage";

export type Severity = "error" | "warning" | "info";

export interface ValidationIssue {
  kind: IssueKind;
  severity: Severity;
  /** Where the problem starts, UTC seconds. */
  time: number;
  endTime?: number;
  bars?: number;
  message: string;
  details?: Record<string, string | number | boolean>;
}

export interface GapInfo {
  /** Open time of the last bar before the hole. */
  after: number;
  /** Open time of the first bar after the hole. */
  before: number;
  missingBars: number;
  atMonthSeam: boolean;
}

export interface MonthInput {
  month: MonthKey;
  present: boolean;
  state: string;
  sources: string[];
  count: number;
  complete: boolean;
  /** Bars a fully covered month would hold in the validated range. */
  expected: number;
}

export interface MonthQuality extends MonthInput {
  missing: number;
  coverage: number;
}

/** A contiguous run of bars that came from one place. */
export interface SourceSpan {
  source: string;
  from: number;
  to: number;
}

export interface SourceSeam {
  time: number;
  from: string;
  to: string;
  previousClose: number;
  nextOpen: number;
  jumpPct: number;
}

export interface ValidateOptions {
  intervalSec: number;
  fromSec: number;
  /** Inclusive. */
  toSec: number;
  dataset?: { market: string; symbol: string; interval: string };
  months?: readonly MonthInput[];
  /** Where each source's bars start and end, across the whole range. */
  sourceSpans?: readonly SourceSpan[];
  /** Bar-to-bar close move that counts as suspicious, in percent. */
  extremeMovePct?: number;
  /** Consecutive zero-volume bars that count as suspicious. */
  flatRunBars?: number;
  /** Gaps at least this long are errors rather than warnings. */
  gapErrorBars?: number;
  /** Coverage below this makes the report fail. */
  minCoverage?: number;
  /** Price jump across a month boundary that counts as suspicious, in percent. */
  seamJumpPct?: number;
  maxIssues?: number;
  maxGaps?: number;
}

export interface QualityReport {
  version: number;
  generatedAt: number;
  dataset: { market: string; symbol: string; interval: string; intervalSeconds: number };
  range: { fromSec: number; toSec: number; from: string; to: string };
  bars: {
    expected: number;
    present: number;
    unique: number;
    missing: number;
    duplicates: number;
    outOfOrder: number;
    misaligned: number;
  };
  coverage: number;
  gaps: GapInfo[];
  gapCount: number;
  gapBars: number;
  largestGap: GapInfo | null;
  months: MonthQuality[];
  sourceSpans: SourceSpan[];
  sourceSeams: SourceSeam[];
  issues: ValidationIssue[];
  issuesOmitted: number;
  counts: Record<string, number>;
  errors: number;
  warnings: number;
  ok: boolean;
}

export const QUALITY_REPORT_VERSION = 1;

/** Grid points in [from, to] that a complete dataset would occupy. */
export function expectedBarCount(fromSec: number, toSec: number, intervalSec: number): number {
  if (intervalSec <= 0 || toSec < fromSec) return 0;
  const first = Math.ceil(fromSec / intervalSec);
  const last = Math.floor(toSec / intervalSec);
  return Math.max(0, last - first + 1);
}

/** Folds consecutive spans that share a source into one. */
export function mergeSourceSpans(spans: readonly SourceSpan[]): SourceSpan[] {
  const sorted = spans
    .filter((s) => s && Number.isFinite(s.from) && Number.isFinite(s.to) && s.to >= s.from)
    .slice()
    .sort((a, b) => a.from - b.from);
  const out: SourceSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && last.source === s.source) {
      if (s.to > last.to) last.to = s.to;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

function indexOfTime(candles: readonly Candle[], time: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    const t = candles[mid].time;
    if (t === time) return mid;
    if (t < time) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

export function validateCandles(candles: readonly Candle[], opts: ValidateOptions): QualityReport {
  const step = opts.intervalSec;
  const extremePct = opts.extremeMovePct ?? 10;
  const flatRun = opts.flatRunBars ?? 60;
  const gapErrorBars = opts.gapErrorBars ?? 60;
  const minCoverage = opts.minCoverage ?? 0.99;
  const seamJumpPct = opts.seamJumpPct ?? 2;
  const maxIssues = opts.maxIssues ?? 500;
  const maxGaps = opts.maxGaps ?? 200;

  const issues: ValidationIssue[] = [];
  const counts: Record<string, number> = {};
  let omitted = 0;

  function add(issue: ValidationIssue): void {
    counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
    if (issues.length < maxIssues) issues.push(issue);
    else omitted++;
  }

  const gaps: GapInfo[] = [];
  let gapCount = 0;
  let gapBars = 0;
  let duplicates = 0;
  let outOfOrder = 0;
  let misaligned = 0;
  let unique = 0;

  let prev: Candle | null = null;
  let zeroRunStart: number | null = null;
  let zeroRunLen = 0;

  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];

    if (step > 0 && c.time % step !== 0) {
      misaligned++;
      add({
        kind: "misaligned",
        severity: "error",
        time: c.time,
        message: `bar at ${toISO(c.time)} is not on the ${step}s grid`,
        details: { offset: c.time % step },
      });
    }

    if (!(c.open > 0) || !(c.high > 0) || !(c.low > 0) || !(c.close > 0) || !(c.volume >= 0)) {
      add({
        kind: "non-positive",
        severity: "error",
        time: c.time,
        message: `bar at ${toISO(c.time)} has a non-positive price or negative volume`,
        details: { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume },
      });
    } else if (c.high < c.low || c.high < Math.max(c.open, c.close) || c.low > Math.min(c.open, c.close)) {
      add({
        kind: "bad-ohlc",
        severity: "error",
        time: c.time,
        message: `bar at ${toISO(c.time)} violates low <= open/close <= high`,
        details: { open: c.open, high: c.high, low: c.low, close: c.close },
      });
    }

    if (c.volume === 0) {
      if (zeroRunStart === null) zeroRunStart = c.time;
      zeroRunLen++;
    } else if (zeroRunStart !== null) {
      if (zeroRunLen >= flatRun) {
        add({
          kind: "flat-run",
          severity: "warning",
          time: zeroRunStart,
          endTime: c.time - step,
          bars: zeroRunLen,
          message: `${zeroRunLen} consecutive zero-volume bars from ${toISO(zeroRunStart)}`,
        });
      }
      zeroRunStart = null;
      zeroRunLen = 0;
    }

    if (prev) {
      const delta = c.time - prev.time;
      if (delta === 0) {
        duplicates++;
        add({
          kind: "duplicate",
          severity: "error",
          time: c.time,
          message: `duplicate timestamp ${toISO(c.time)}`,
        });
      } else if (delta < 0) {
        outOfOrder++;
        add({
          kind: "out-of-order",
          severity: "error",
          time: c.time,
          message: `bar at ${toISO(c.time)} comes after ${toISO(prev.time)}`,
        });
      } else if (step > 0 && delta > step) {
        const missing = Math.round(delta / step) - 1;
        const seam = monthOf(prev.time) !== monthOf(c.time);
        gapCount++;
        gapBars += missing;
        if (gaps.length < maxGaps) gaps.push({ after: prev.time, before: c.time, missingBars: missing, atMonthSeam: seam });
        add({
          kind: seam ? "month-seam" : "gap",
          severity: missing >= gapErrorBars ? "error" : "warning",
          time: prev.time + step,
          endTime: c.time - step,
          bars: missing,
          message: `${missing} missing bar(s) between ${toISO(prev.time)} and ${toISO(c.time)}${seam ? " (month boundary)" : ""}`,
        });
      }

      if (delta > 0 && prev.close > 0 && c.close > 0) {
        const movePct = Math.abs(c.close / prev.close - 1) * 100;
        if (movePct >= extremePct) {
          add({
            kind: "extreme-move",
            severity: "warning",
            time: c.time,
            message: `close moved ${movePct.toFixed(2)}% in one bar at ${toISO(c.time)}`,
            details: { from: prev.close, to: c.close, pct: Number(movePct.toFixed(4)) },
          });
        }
      }

    }

    if (!prev || c.time !== prev.time) unique++;
    prev = c;
  }

  if (zeroRunStart !== null && zeroRunLen >= flatRun) {
    add({
      kind: "flat-run",
      severity: "warning",
      time: zeroRunStart,
      bars: zeroRunLen,
      message: `${zeroRunLen} consecutive zero-volume bars from ${toISO(zeroRunStart)}`,
    });
  }

  const expected = expectedBarCount(opts.fromSec, opts.toSec, step);
  const missing = Math.max(0, expected - unique);
  const coverage = expected > 0 ? unique / expected : 1;

  if (candles.length === 0) {
    add({
      kind: "coverage",
      severity: "error",
      time: opts.fromSec,
      endTime: opts.toSec,
      message: `no bars at all in ${toISO(opts.fromSec)}..${toISO(opts.toSec)}`,
    });
  } else {
    const first = candles[0].time;
    const last = candles[candles.length - 1].time;
    const leading = Math.max(0, Math.round((first - opts.fromSec) / step));
    const trailing = Math.max(0, Math.round((opts.toSec - last) / step));
    if (leading > 0) {
      add({
        kind: "coverage",
        severity: leading >= gapErrorBars ? "error" : "warning",
        time: opts.fromSec,
        endTime: first - step,
        bars: leading,
        message: `range starts ${leading} bar(s) later than requested (${toISO(first)} vs ${toISO(opts.fromSec)})`,
      });
    }
    if (trailing > 0) {
      add({
        kind: "coverage",
        severity: trailing >= gapErrorBars ? "error" : "warning",
        time: last + step,
        endTime: opts.toSec,
        bars: trailing,
        message: `range ends ${trailing} bar(s) earlier than requested (${toISO(last)} vs ${toISO(opts.toSec)})`,
      });
    }
    if (coverage < minCoverage) {
      add({
        kind: "coverage",
        severity: "error",
        time: opts.fromSec,
        endTime: opts.toSec,
        message: `coverage ${(coverage * 100).toFixed(3)}% is below the ${(minCoverage * 100).toFixed(3)}% threshold`,
        details: { expected, present: unique, missing },
      });
    }
  }

  const months: MonthQuality[] = (opts.months ?? []).map((m) => ({
    ...m,
    missing: Math.max(0, m.expected - m.count),
    coverage: m.expected > 0 ? m.count / m.expected : 1,
  }));

  for (const m of months) {
    if (!m.present) {
      add({
        kind: "storage",
        severity: "error",
        time: opts.fromSec,
        message: `month ${m.month} is missing from the store`,
        details: { month: m.month, state: m.state },
      });
    } else if (m.state !== "ok") {
      add({
        kind: "storage",
        severity: m.state === "trailing" ? "warning" : "error",
        time: opts.fromSec,
        message: `month ${m.month} is in state "${m.state}"`,
        details: { month: m.month, state: m.state },
      });
    }
  }

  const sourceSpans = mergeSourceSpans(opts.sourceSpans ?? []);
  const sourceSeams: SourceSeam[] = [];
  for (let i = 1; i < sourceSpans.length; i++) {
    const prevSpan = sourceSpans[i - 1];
    const span = sourceSpans[i];
    if (prevSpan.source === span.source) continue;
    const index = indexOfTime(candles, span.from);
    const next = index >= 0 ? candles[index] : null;
    const before = index > 0 ? candles[index - 1] : null;
    const previousClose = before?.close ?? 0;
    const nextOpen = next?.open ?? 0;
    const jumpPct = previousClose > 0 && nextOpen > 0 ? Math.abs(nextOpen / previousClose - 1) * 100 : 0;
    sourceSeams.push({ time: span.from, from: prevSpan.source, to: span.source, previousClose, nextOpen, jumpPct });
    add({
      kind: "source-mix",
      severity: jumpPct >= seamJumpPct ? "error" : "warning",
      time: span.from,
      message:
        `data source changes from ${prevSpan.source} to ${span.source} at ${toISO(span.from)}; ` +
        `close-to-open jump across the seam is ${jumpPct.toFixed(3)}%`,
      details: {
        from: prevSpan.source,
        to: span.source,
        previousClose,
        nextOpen,
        jumpPct: Number(jumpPct.toFixed(4)),
      },
    });
  }

  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    if (issue.severity === "error") errors++;
    else if (issue.severity === "warning") warnings++;
  }

  const largestGap = gaps.reduce<GapInfo | null>(
    (best, g) => (best === null || g.missingBars > best.missingBars ? g : best),
    null,
  );

  return {
    version: QUALITY_REPORT_VERSION,
    generatedAt: Math.floor(Date.now() / 1000),
    dataset: {
      market: opts.dataset?.market ?? "",
      symbol: opts.dataset?.symbol ?? "",
      interval: opts.dataset?.interval ?? "",
      intervalSeconds: step,
    },
    range: {
      fromSec: opts.fromSec,
      toSec: opts.toSec,
      from: toISO(opts.fromSec),
      to: toISO(opts.toSec),
    },
    bars: {
      expected,
      present: candles.length,
      unique,
      missing,
      duplicates,
      outOfOrder,
      misaligned,
    },
    coverage,
    gaps,
    gapCount,
    gapBars,
    largestGap,
    months,
    sourceSpans,
    sourceSeams,
    issues,
    issuesOmitted: omitted,
    counts,
    errors,
    warnings,
    ok: errors === 0,
  };
}

function pct(value: number): string {
  return `${(value * 100).toFixed(3)}%`;
}

/** Human-readable rendering of the same report. */
export function formatQualityReport(report: QualityReport, opts: { maxIssues?: number } = {}): string {
  const limit = opts.maxIssues ?? 25;
  const d = report.dataset;
  const lines: string[] = [];

  lines.push(`Data quality report — ${d.market}:${d.symbol}:${d.interval}`);
  lines.push(`Range     ${report.range.from} .. ${report.range.to}`);
  lines.push(`Verdict   ${report.ok ? "OK" : "FAILED"}  (${report.errors} error(s), ${report.warnings} warning(s))`);
  lines.push("");
  lines.push(`Bars      expected ${report.bars.expected}, present ${report.bars.unique}, missing ${report.bars.missing}`);
  lines.push(`Coverage  ${pct(report.coverage)}`);
  lines.push(`Gaps      ${report.gapCount} hole(s), ${report.gapBars} missing bar(s)`);
  if (report.largestGap) {
    lines.push(
      `Largest   ${report.largestGap.missingBars} bar(s) between ${toISO(report.largestGap.after)} and ${toISO(report.largestGap.before)}`,
    );
  }
  lines.push(
    `Anomalies duplicates ${report.bars.duplicates}, out-of-order ${report.bars.outOfOrder}, misaligned ${report.bars.misaligned}`,
  );

  if (report.months.length > 0) {
    lines.push("");
    lines.push("Months");
    lines.push("  month    state      bars/expected  coverage  sources");
    for (const m of report.months) {
      lines.push(
        `  ${m.month}  ${m.state.padEnd(9)}  ${String(m.count).padStart(6)}/${String(m.expected).padEnd(6)}  ${pct(m.coverage).padStart(8)}  ${m.sources.join("+") || "-"}${m.complete ? "" : " (open)"}`,
      );
    }
  }

  if (report.sourceSpans.length > 0) {
    lines.push("");
    lines.push("Sources");
    for (const s of report.sourceSpans) {
      lines.push(`  ${s.source.padEnd(16)} ${toISO(s.from)} .. ${toISO(s.to)}`);
    }
    for (const seam of report.sourceSeams) {
      lines.push(
        `  seam ${seam.from} -> ${seam.to} at ${toISO(seam.time)}: close ${seam.previousClose} -> open ${seam.nextOpen} (${seam.jumpPct.toFixed(3)}%)`,
      );
    }
  }

  const kinds = Object.keys(report.counts).sort();
  if (kinds.length > 0) {
    lines.push("");
    lines.push("Findings by kind");
    for (const k of kinds) lines.push(`  ${k.padEnd(14)} ${report.counts[k]}`);
  }

  if (report.issues.length > 0) {
    lines.push("");
    lines.push(`Issues (first ${Math.min(limit, report.issues.length)} of ${report.issues.length + report.issuesOmitted})`);
    for (const issue of report.issues.slice(0, limit)) {
      lines.push(`  [${issue.severity}] ${issue.kind}: ${issue.message}`);
    }
    const hidden = report.issues.length - limit + report.issuesOmitted;
    if (hidden > 0) lines.push(`  ... ${hidden} more`);
  }

  return lines.join("\n");
}

export interface FundingValidateOptions {
  fromSec: number;
  toSec: number;
  intervalMinutes: number | null;
  symbol?: string;
  market?: string;
  /** Per-interval rate that counts as suspicious. Bybit caps around 0.375%. */
  extremeRate?: number;
  maxIssues?: number;
}

export interface FundingQualityReport {
  version: number;
  generatedAt: number;
  symbol: string;
  market: string;
  range: { fromSec: number; toSec: number; from: string; to: string };
  intervalMinutes: number | null;
  events: { expected: number; present: number; unique: number; missing: number; duplicates: number; outOfOrder: number };
  coverage: number;
  rate: { min: number; max: number; mean: number; annualizedMean: number };
  issues: ValidationIssue[];
  counts: Record<string, number>;
  errors: number;
  warnings: number;
  ok: boolean;
}

/**
 * Funding settles on a fixed grid, so a hole is unambiguous: the interval is
 * known from instruments-info and anything that does not land on it is either a
 * missing settlement or a wrong interval assumption. Both matter — funding is
 * what turns an "always profitable" perpetual backtest into a realistic one.
 */
export function validateFunding(
  events: readonly { time: number; rate: number }[],
  opts: FundingValidateOptions,
): FundingQualityReport {
  const stepSec = opts.intervalMinutes && opts.intervalMinutes > 0 ? opts.intervalMinutes * 60 : 0;
  const extreme = opts.extremeRate ?? 0.00375;
  const maxIssues = opts.maxIssues ?? 200;

  const issues: ValidationIssue[] = [];
  const counts: Record<string, number> = {};
  function add(issue: ValidationIssue): void {
    counts[issue.kind] = (counts[issue.kind] ?? 0) + 1;
    if (issues.length < maxIssues) issues.push(issue);
  }

  const sorted = events.slice().sort((a, b) => a.time - b.time);
  let duplicates = 0;
  let outOfOrder = 0;
  let unique = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  let sum = 0;

  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    const prev = i > 0 ? sorted[i - 1] : null;
    if (prev && e.time === prev.time) {
      duplicates++;
      add({ kind: "duplicate", severity: "error", time: e.time, message: `duplicate funding settlement at ${toISO(e.time)}` });
    } else {
      unique++;
    }
    if (stepSec > 0 && e.time % stepSec !== 0) {
      add({
        kind: "misaligned",
        severity: "warning",
        time: e.time,
        message: `settlement at ${toISO(e.time)} is not on the ${opts.intervalMinutes}m grid`,
      });
    }
    if (prev && stepSec > 0) {
      const delta = e.time - prev.time;
      if (delta > stepSec) {
        const missed = Math.round(delta / stepSec) - 1;
        add({
          kind: "gap",
          severity: "error",
          time: prev.time + stepSec,
          endTime: e.time - stepSec,
          bars: missed,
          message: `${missed} missing funding settlement(s) between ${toISO(prev.time)} and ${toISO(e.time)}`,
        });
      }
    }
    if (Math.abs(e.rate) >= extreme) {
      add({
        kind: "extreme-move",
        severity: "warning",
        time: e.time,
        message: `funding rate ${(e.rate * 100).toFixed(4)}% at ${toISO(e.time)} is at or past the usual cap`,
        details: { rate: e.rate },
      });
    }
    if (e.rate < min) min = e.rate;
    if (e.rate > max) max = e.rate;
    sum += e.rate;
  }

  const expected = stepSec > 0 ? Math.max(0, Math.floor((opts.toSec - opts.fromSec) / stepSec) + 1) : unique;
  const missing = Math.max(0, expected - unique);
  const coverage = expected > 0 ? Math.min(1, unique / expected) : 1;
  if (stepSec === 0) {
    add({
      kind: "coverage",
      severity: "warning",
      time: opts.fromSec,
      message: "funding interval unknown, gap detection disabled",
    });
  }
  if (unique === 0) {
    add({ kind: "coverage", severity: "error", time: opts.fromSec, message: "no funding events in range" });
  }

  let errors = 0;
  let warnings = 0;
  for (const issue of issues) {
    if (issue.severity === "error") errors++;
    else if (issue.severity === "warning") warnings++;
  }

  const mean = unique > 0 ? sum / sorted.length : 0;
  const perYear = stepSec > 0 ? (365 * 86400) / stepSec : 0;

  return {
    version: QUALITY_REPORT_VERSION,
    generatedAt: Math.floor(Date.now() / 1000),
    symbol: opts.symbol ?? "",
    market: opts.market ?? "",
    range: { fromSec: opts.fromSec, toSec: opts.toSec, from: toISO(opts.fromSec), to: toISO(opts.toSec) },
    intervalMinutes: opts.intervalMinutes,
    events: { expected, present: sorted.length, unique, missing, duplicates, outOfOrder },
    coverage,
    rate: {
      min: Number.isFinite(min) ? min : 0,
      max: Number.isFinite(max) ? max : 0,
      mean,
      annualizedMean: mean * perYear,
    },
    issues,
    counts,
    errors,
    warnings,
    ok: errors === 0,
  };
}

export function formatFundingReport(report: FundingQualityReport, opts: { maxIssues?: number } = {}): string {
  const limit = opts.maxIssues ?? 15;
  const lines: string[] = [];
  lines.push(`Funding quality report — ${report.market}:${report.symbol}`);
  lines.push(`Range     ${report.range.from} .. ${report.range.to}`);
  lines.push(`Verdict   ${report.ok ? "OK" : "FAILED"}  (${report.errors} error(s), ${report.warnings} warning(s))`);
  lines.push(`Interval  ${report.intervalMinutes === null ? "unknown" : `${report.intervalMinutes} min`}`);
  lines.push(`Events    expected ${report.events.expected}, present ${report.events.unique}, missing ${report.events.missing}`);
  lines.push(`Coverage  ${(report.coverage * 100).toFixed(3)}%`);
  lines.push(
    `Rate      min ${(report.rate.min * 100).toFixed(4)}%, max ${(report.rate.max * 100).toFixed(4)}%, mean ${(report.rate.mean * 100).toFixed(5)}% (${(report.rate.annualizedMean * 100).toFixed(2)}%/yr)`,
  );
  if (report.issues.length > 0) {
    lines.push("");
    lines.push(`Issues (first ${Math.min(limit, report.issues.length)} of ${report.issues.length})`);
    for (const issue of report.issues.slice(0, limit)) {
      lines.push(`  [${issue.severity}] ${issue.kind}: ${issue.message}`);
    }
  }
  return lines.join("\n");
}
