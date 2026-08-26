import { METRICS_STEP_SEC, type MetricsRow } from "./metricsArchive.ts";

/**
 * Quality of a positioning-metrics series.
 *
 * The dataset notes for the candle store were worth more than the candles
 * themselves — the frozen 74 minutes of 2024-10-28 would have been invisible in
 * any summary statistic and poisonous in a backtest. The same discipline
 * applies here, and this series has two failure modes the candles do not:
 *
 *  - the five-minute grid can slip, so a "24-hour change" is silently a change
 *    over something else;
 *  - open interest can be repeated verbatim for hours when the publisher
 *    stalls, which reads as "leverage did not move" rather than "we were not
 *    told". Both are counted here rather than repaired.
 *
 * Nothing in this file changes a value. A validator that quietly fixes things
 * is a validator that hides them.
 */

export interface MetricsGap {
  /** Last timestamp before the hole. */
  fromSec: number;
  /** First timestamp after it. */
  toSec: number;
  /** Slots of `METRICS_STEP_SEC` that are missing. */
  missing: number;
}

export interface FlatRun {
  fromSec: number;
  toSec: number;
  /** Consecutive rows carrying the identical open-interest value. */
  length: number;
  value: number;
}

export interface MetricsQuality {
  rows: number;
  firstSec: number | null;
  lastSec: number | null;
  /** Slots the span should hold if nothing were missing. */
  expectedSlots: number;
  coverage: number;
  /** Timestamps that are not a multiple of the five-minute grid. */
  offGrid: number;
  /** Repeated timestamps, which `dedupeRows` would have collapsed. */
  duplicates: number;
  /** Rows out of chronological order in the input. */
  unordered: number;
  /** Every hole found, not just the ones listed below. */
  gapCount: number;
  /** The largest holes, capped by `maxGapsListed` so a report stays readable. */
  gaps: MetricsGap[];
  missingSlots: number;
  /** Non-finite values per column. */
  emptyFields: Record<string, number>;
  /** Rows with a non-positive open interest, which cannot be a real reading. */
  nonPositiveOi: number;
  /** Runs of at least `flatMin` identical open-interest readings. */
  flatRuns: FlatRun[];
  flatRows: number;
  /** Largest single-step |log change| in open interest, and its timestamp. */
  maxAbsStepLogOi: number;
  maxAbsStepAtSec: number | null;
  /** Standard deviation of the single-step log change in open interest. */
  stepSdLogOi: number;
}

const COLUMNS: (keyof MetricsRow)[] = [
  "openInterest",
  "openInterestValue",
  "topTraderAccountRatio",
  "topTraderPositionRatio",
  "accountRatio",
  "takerVolumeRatio",
];

export interface AssessOptions {
  /** Shortest run of identical open interest worth reporting. */
  flatMin?: number;
  /** Holes smaller than this many slots are counted but never listed. */
  listGapsFrom?: number;
  /** How many of the deepest holes to list. */
  maxGapsListed?: number;
  maxFlatRunsListed?: number;
}

export function assessMetrics(rows: readonly MetricsRow[], opts: AssessOptions = {}): MetricsQuality {
  const flatMin = opts.flatMin ?? 6;
  const listGapsFrom = opts.listGapsFrom ?? 1;
  const maxGaps = opts.maxGapsListed ?? 40;
  const maxFlat = opts.maxFlatRunsListed ?? 20;

  const emptyFields: Record<string, number> = {};
  for (const c of COLUMNS) emptyFields[c] = 0;

  const n = rows.length;
  if (n === 0) {
    return {
      rows: 0,
      firstSec: null,
      lastSec: null,
      expectedSlots: 0,
      coverage: 0,
      offGrid: 0,
      duplicates: 0,
      unordered: 0,
      gapCount: 0,
      gaps: [],
      missingSlots: 0,
      emptyFields,
      nonPositiveOi: 0,
      flatRuns: [],
      flatRows: 0,
      maxAbsStepLogOi: 0,
      maxAbsStepAtSec: null,
      stepSdLogOi: 0,
    };
  }

  let offGrid = 0;
  let duplicates = 0;
  let unordered = 0;
  let nonPositiveOi = 0;
  const gaps: MetricsGap[] = [];
  let gapCount = 0;
  let missingSlots = 0;

  for (let i = 0; i < n; i++) {
    const r = rows[i];
    if (r.timeSec % METRICS_STEP_SEC !== 0) offGrid++;
    for (const c of COLUMNS) if (!Number.isFinite(r[c] as number)) emptyFields[c]++;
    if (!(r.openInterest > 0)) nonPositiveOi++;
    if (i > 0) {
      const step = r.timeSec - rows[i - 1].timeSec;
      if (step < 0) unordered++;
      else if (step === 0) duplicates++;
      else if (step > METRICS_STEP_SEC) {
        const missing = Math.round(step / METRICS_STEP_SEC) - 1;
        missingSlots += missing;
        gapCount++;
        if (missing >= listGapsFrom) {
          gaps.push({ fromSec: rows[i - 1].timeSec, toSec: r.timeSec, missing });
        }
      }
    }
  }

  // Listing every hole of a six-year series would bury the report, so only the
  // deepest survive — but the count above is the honest one.
  gaps.sort((a, b) => b.missing - a.missing);
  gaps.length = Math.min(gaps.length, maxGaps);

  const firstSec = rows[0].timeSec;
  const lastSec = rows[n - 1].timeSec;
  const expectedSlots = Math.max(1, Math.round((lastSec - firstSec) / METRICS_STEP_SEC) + 1);

  const flatRuns: FlatRun[] = [];
  let flatRows = 0;
  let runStart = 0;
  for (let i = 1; i <= n; i++) {
    const same = i < n && rows[i].openInterest === rows[runStart].openInterest && Number.isFinite(rows[i].openInterest);
    if (same) continue;
    const length = i - runStart;
    if (length >= flatMin) {
      flatRows += length;
      if (flatRuns.length < maxFlat) {
        flatRuns.push({
          fromSec: rows[runStart].timeSec,
          toSec: rows[i - 1].timeSec,
          length,
          value: rows[runStart].openInterest,
        });
      }
    }
    runStart = i;
  }

  let maxAbs = 0;
  let maxAt: number | null = null;
  let sum = 0;
  let sumSq = 0;
  let steps = 0;
  for (let i = 1; i < n; i++) {
    if (rows[i].timeSec - rows[i - 1].timeSec !== METRICS_STEP_SEC) continue;
    const a = rows[i - 1].openInterest;
    const b = rows[i].openInterest;
    if (!(a > 0) || !(b > 0)) continue;
    const d = Math.log(b / a);
    sum += d;
    sumSq += d * d;
    steps++;
    if (Math.abs(d) > maxAbs) {
      maxAbs = Math.abs(d);
      maxAt = rows[i].timeSec;
    }
  }
  const mean = steps > 0 ? sum / steps : 0;
  const variance = steps > 1 ? Math.max(0, sumSq / steps - mean * mean) : 0;

  return {
    rows: n,
    firstSec,
    lastSec,
    expectedSlots,
    coverage: n / expectedSlots,
    offGrid,
    duplicates,
    unordered,
    gapCount,
    gaps,
    missingSlots,
    emptyFields,
    nonPositiveOi,
    flatRuns,
    flatRows,
    maxAbsStepLogOi: maxAbs,
    maxAbsStepAtSec: maxAt,
    stepSdLogOi: Math.sqrt(variance),
  };
}
