import { METRICS_STEP_SEC } from "../data/metricsArchive.ts";
import type { Series } from "../indicators/core.ts";
import type { Candle } from "../types.ts";
import type { FeatureSpec } from "./featureLib.ts";
import {
  buildPositioningGrid,
  directional,
  laggedDiff,
  logOf,
  multiply,
  rollingMax,
  rollingMean,
  rollingZ,
  scaleBySd,
  subtract,
  type PositioningGrid,
} from "./positioningGrid.ts";
import type { MetricsRow } from "../data/metricsArchive.ts";

/**
 * Features built from the Binance positioning archive.
 *
 * Every one of the 63 features screened so far is a function of our own OHLCV.
 * These are not: they describe how much leverage is in the system, which side
 * the large accounts are holding, and how hard the aggressive flow is leaning.
 * Whether that is worth anything is the question; that it is a different
 * question is the point.
 *
 * Three rules, in decreasing order of how badly breaking them would hurt.
 *
 * **No value may be used before it could have been known.** The snapshot stamped
 * T is treated as public only at T + one period. Binance stamps the taker
 * buy/sell ratio with the start of the window it summarises, so a row stamped
 * 12:00 partly describes 12:00–12:05 and cannot be on screen at 12:00. One
 * period of lag is correct under that reading and conservative under the other.
 * The feature on a bar is then the newest snapshot whose publication time is at
 * or before that bar's close, and nothing older than an hour.
 *
 * **Scale invariance.** The sample spans BTC at ten thousand and at a hundred
 * thousand dollars, and open interest grew by an order of magnitude over it. A
 * raw level ranks chronologically, so its correlation with anything is a report
 * about the trend of the sample. Changes are logs, levels appear as deviations
 * from their own trailing mean or as trailing z-scores. The three raw levels
 * that are kept — the long/short ratios — are kept because the brief asks for
 * the level, and they are read with that caveat attached.
 *
 * **No full-sample statistic anywhere.** Every mean, standard deviation and
 * maximum below is over a trailing window ending at the bar being described.
 * This is the error that killed hypothesis 7, and it is worth being boring
 * about.
 *
 * The price used for the price-versus-open-interest features comes out of the
 * archive itself (`sum_open_interest_value / sum_open_interest` is the mark
 * price of the snapshot), not from our candles. Same instant, same row, no join,
 * no alignment to get wrong.
 */

/** Slots per hour, per day, and the window used for standardisation. */
export const SLOTS_1H = 12;
export const SLOTS_24H = 288;
export const SLOTS_28D = 8064;

export const DEFAULT_PUBLISH_LAG_SEC = METRICS_STEP_SEC;
export const DEFAULT_MAX_STALE_SEC = 3600;

export interface AsOfOptions {
  /** How long after its timestamp a snapshot is treated as public. */
  publishLagSec?: number;
  /** A value older than this relative to the bar close is dropped. */
  maxStaleSec?: number;
}

/**
 * Newest grid slot whose publication time is at or before `barCloseSec`, with
 * missing slots skipped up to the staleness bound. Returns -1 when there is
 * nothing usable.
 */
export function asOfSlot(
  grid: PositioningGrid,
  values: Float64Array,
  barCloseSec: number,
  publishLagSec: number,
  maxStaleSec: number,
): number {
  if (grid.length === 0) return -1;
  const deadline = barCloseSec - publishLagSec;
  let idx = Math.floor((deadline - grid.startSec) / METRICS_STEP_SEC);
  if (idx < 0) return -1;
  if (idx > grid.length - 1) idx = grid.length - 1;
  const oldest = barCloseSec - maxStaleSec;
  for (let i = idx; i >= 0; i--) {
    const t = grid.startSec + i * METRICS_STEP_SEC;
    if (t < oldest) return -1;
    if (Number.isFinite(values[i])) return i;
  }
  return -1;
}

/** Smallest positive spacing between consecutive bars — the timeframe, in seconds. */
export function inferIntervalSec(bars: readonly Candle[]): number {
  let best = Number.POSITIVE_INFINITY;
  for (let i = 1; i < bars.length; i++) {
    const d = bars[i].time - bars[i - 1].time;
    if (d > 0 && d < best) best = d;
  }
  return Number.isFinite(best) ? best : METRICS_STEP_SEC;
}

/** Projects a grid series onto a bar series with the as-of rule. */
export function asOfSeries(
  grid: PositioningGrid,
  values: Float64Array,
  bars: readonly Candle[],
  opts: AsOfOptions = {},
): Series {
  const publishLag = opts.publishLagSec ?? DEFAULT_PUBLISH_LAG_SEC;
  const maxStale = opts.maxStaleSec ?? DEFAULT_MAX_STALE_SEC;
  const intervalSec = inferIntervalSec(bars);
  const out: Series = new Array(bars.length).fill(null);
  for (let i = 0; i < bars.length; i++) {
    const close = bars[i].time + intervalSec;
    const slot = asOfSlot(grid, values, close, publishLag, maxStale);
    if (slot < 0) continue;
    out[i] = values[slot];
  }
  return out;
}

/* ── the catalogue ────────────────────────────────────────────────────────── */

export interface PositioningSeriesSet {
  grid: PositioningGrid;
  byName: Map<string, Float64Array>;
  notes: Map<string, string>;
}

interface Draft {
  name: string;
  note: string;
  values: Float64Array;
}

/**
 * Builds every derived series once per symbol. They are shared by all
 * timeframes: the grid does not change when the bars get coarser, only the
 * as-of join does.
 */
export function buildPositioningSeries(rows: readonly MetricsRow[]): PositioningSeriesSet {
  const grid = buildPositioningGrid(rows);
  const byName = new Map<string, Float64Array>();
  const notes = new Map<string, string>();
  const drafts: Draft[] = [];
  const add = (name: string, note: string, values: Float64Array): Float64Array => {
    drafts.push({ name, note, values });
    return values;
  };

  const logOi = logOf(grid.openInterest);
  const logPx = logOf(grid.price);
  const logTtPos = logOf(grid.topTraderPositionRatio);
  const logTtAcc = logOf(grid.topTraderAccountRatio);
  const logAcc = logOf(grid.accountRatio);
  const logTaker = logOf(grid.takerVolumeRatio);

  // ---- open interest: change, level, shock ------------------------------
  const oiChg1h = add("pos_oi_chg_1h", "log change of open interest over 1 hour", laggedDiff(logOi, SLOTS_1H));
  const oiChg24h = add("pos_oi_chg_24h", "log change of open interest over 24 hours", laggedDiff(logOi, SLOTS_24H));
  const oiChg1hZ = add(
    "pos_oi_chg_1h_z",
    "1-hour open-interest change in sigmas of its own trailing 28 days",
    scaleBySd(oiChg1h, SLOTS_28D),
  );
  const oiChg24hZ = add(
    "pos_oi_chg_24h_z",
    "24-hour open-interest change in sigmas of its own trailing 28 days",
    scaleBySd(oiChg24h, SLOTS_28D),
  );
  add("pos_oi_level_z_24h", "open interest against its own trailing 24 hours, in sigmas", rollingZ(logOi, SLOTS_24H));
  add("pos_oi_level_z_28d", "open interest against its own trailing 28 days, in sigmas", rollingZ(logOi, SLOTS_28D));

  const oiStep = laggedDiff(logOi, 1);
  const oiStepZ = scaleBySd(oiStep, SLOTS_28D);
  const oiDrop1h = add(
    "pos_oi_drop_1h",
    "deepest single 5-minute drop in open interest over the last hour, in sigmas",
    rollingMax(
      (() => {
        const out = new Float64Array(oiStepZ.length).fill(Number.NaN);
        for (let i = 0; i < oiStepZ.length; i++) if (Number.isFinite(oiStepZ[i])) out[i] = -oiStepZ[i];
        return out;
      })(),
      SLOTS_1H,
    ),
  );
  add(
    "pos_oi_pop_1h",
    "largest single 5-minute jump in open interest over the last hour, in sigmas",
    rollingMax(oiStepZ, SLOTS_1H),
  );

  // ---- price against open interest --------------------------------------
  const ret1h = laggedDiff(logPx, SLOTS_1H);
  const ret24h = laggedDiff(logPx, SLOTS_24H);
  const ret1hZ = scaleBySd(ret1h, SLOTS_28D);
  const ret24hZ = scaleBySd(ret24h, SLOTS_28D);

  add(
    "pos_oi_price_agree_1h",
    "1-hour price move times 1-hour open-interest change, both in sigmas",
    multiply(ret1hZ, oiChg1hZ),
  );
  add(
    "pos_oi_price_agree_24h",
    "24-hour price move times 24-hour open-interest change, both in sigmas",
    multiply(ret24hZ, oiChg24hZ),
  );
  add(
    "pos_oi_exhaustion_1h",
    "fade a 1-hour move made on falling open interest (positions closing, not opening)",
    directional(ret1h, oiChg1hZ, -1, -1),
  );
  add(
    "pos_oi_exhaustion_24h",
    "fade a 24-hour move made on falling open interest",
    directional(ret24h, oiChg24hZ, -1, -1),
  );
  add(
    "pos_oi_backed_1h",
    "follow a 1-hour move made on rising open interest (new money entering)",
    directional(ret1h, oiChg1hZ, 1, 1),
  );
  add(
    "pos_oi_backed_24h",
    "follow a 24-hour move made on rising open interest",
    directional(ret24h, oiChg24hZ, 1, 1),
  );
  add(
    "pos_oi_cascade_fade_1h",
    "fade the 1-hour move in proportion to the sharpest open-interest drop inside it",
    directional(ret1h, oiDrop1h, 1, -1),
  );

  // ---- large traders -----------------------------------------------------
  add("pos_tt_pos_level", "top-trader long/short by position size, log level", logTtPos);
  add("pos_tt_pos_chg_1h", "1-hour log change of top-trader long/short by size", laggedDiff(logTtPos, SLOTS_1H));
  add(
    "pos_tt_pos_dev_24h",
    "top-trader long/short by size against its own trailing 24 hours",
    subtract(logTtPos, rollingMean(logTtPos, SLOTS_24H)),
  );
  add(
    "pos_tt_pos_z_28d",
    "top-trader long/short by size against its own trailing 28 days, in sigmas",
    rollingZ(logTtPos, SLOTS_28D),
  );
  add("pos_tt_acc_level", "top-trader long/short by account count, log level", logTtAcc);
  add(
    "pos_tt_acc_dev_24h",
    "top-trader long/short by account count against its own trailing 24 hours",
    subtract(logTtAcc, rollingMean(logTtAcc, SLOTS_24H)),
  );

  // ---- everyone else -----------------------------------------------------
  add("pos_crowd_level", "long/short across all accounts, log level", logAcc);
  add("pos_crowd_chg_1h", "1-hour log change of the all-account long/short ratio", laggedDiff(logAcc, SLOTS_1H));
  add(
    "pos_crowd_dev_24h",
    "all-account long/short against its own trailing 24 hours",
    subtract(logAcc, rollingMean(logAcc, SLOTS_24H)),
  );

  // ---- large traders against everyone else -------------------------------
  const smartMinusCrowd = subtract(logTtPos, logAcc);
  add("pos_smart_minus_crowd", "top traders by size minus all accounts, in logs", smartMinusCrowd);
  add(
    "pos_smart_minus_crowd_dev_24h",
    "that gap against its own trailing 24 hours",
    subtract(smartMinusCrowd, rollingMean(smartMinusCrowd, SLOTS_24H)),
  );
  add(
    "pos_smart_minus_crowd_z_28d",
    "that gap against its own trailing 28 days, in sigmas",
    rollingZ(smartMinusCrowd, SLOTS_28D),
  );

  // ---- aggressive flow ---------------------------------------------------
  add("pos_taker_5m", "taker buy/sell volume ratio of the last 5 minutes, log", logTaker);
  const taker1h = rollingMean(logTaker, SLOTS_1H);
  add("pos_taker_1h", "taker buy/sell volume ratio averaged over the last hour, log", taker1h);
  add("pos_taker_24h", "taker buy/sell volume ratio averaged over the last 24 hours, log", rollingMean(logTaker, SLOTS_24H));
  add("pos_taker_1h_z_28d", "the hourly taker ratio against its own trailing 28 days, in sigmas", rollingZ(taker1h, SLOTS_28D));

  for (const d of drafts) {
    byName.set(d.name, d.values);
    notes.set(d.name, d.note);
  }
  return { grid, byName, notes };
}

export function positioningFeatureNames(): string[] {
  return Array.from(buildPositioningSeries([]).byName.keys());
}

/** Feature specs for the screener, bound to one symbol's grid. */
export function positioningFeatureSpecs(set: PositioningSeriesSet, opts: AsOfOptions = {}): FeatureSpec[] {
  const specs: FeatureSpec[] = [];
  for (const [name, values] of set.byName) {
    specs.push({
      name,
      group: "positioning",
      note: set.notes.get(name) ?? "",
      compute: (bars: Candle[]): Series => asOfSeries(set.grid, values, bars, opts),
    });
  }
  return specs;
}

/* ── timestamp-convention diagnostic ──────────────────────────────────────── */

export interface AlignmentDiagnostic {
  n: number;
  /** Correlation of the taker ratio stamped T with the return over [T-5m, T]. */
  corrWithPastBar: number;
  /** Correlation of the taker ratio stamped T with the return over [T, T+5m]. */
  corrWithNextBar: number;
  /** Correlation of the open-interest change ending at T with the same two windows. */
  oiCorrWithPastBar: number;
  oiCorrWithNextBar: number;
}

/**
 * Which five minutes does a row describe?
 *
 * The taker buy/sell ratio is a summary of one period, and Binance does not say
 * in the archive whether the stamp is that period's start or its end. It matters
 * a great deal: the wrong reading buys a whole period of hindsight. The answer
 * is in the data — an aggressive-buying ratio has to line up with the price move
 * of the period it summarises — so it is measured rather than assumed.
 */
export function alignmentDiagnostic(grid: PositioningGrid): AlignmentDiagnostic {
  const logPx = logOf(grid.price);
  const logTaker = logOf(grid.takerVolumeRatio);
  const oiStep = laggedDiff(logOf(grid.openInterest), 1);
  const past: number[] = [];
  const next: number[] = [];
  const taker: number[] = [];
  const oi: number[] = [];
  for (let i = 1; i + 1 < grid.length; i++) {
    const rPast = logPx[i] - logPx[i - 1];
    const rNext = logPx[i + 1] - logPx[i];
    if (!Number.isFinite(rPast) || !Number.isFinite(rNext)) continue;
    if (!Number.isFinite(logTaker[i]) || !Number.isFinite(oiStep[i])) continue;
    past.push(rPast);
    next.push(rNext);
    taker.push(logTaker[i]);
    oi.push(oiStep[i]);
  }
  const corr = (a: number[], b: number[]): number => {
    const n = a.length;
    if (n < 100) return Number.NaN;
    let ma = 0;
    let mb = 0;
    for (let i = 0; i < n; i++) {
      ma += a[i];
      mb += b[i];
    }
    ma /= n;
    mb /= n;
    let sab = 0;
    let saa = 0;
    let sbb = 0;
    for (let i = 0; i < n; i++) {
      const da = a[i] - ma;
      const db = b[i] - mb;
      sab += da * db;
      saa += da * da;
      sbb += db * db;
    }
    return saa > 0 && sbb > 0 ? sab / Math.sqrt(saa * sbb) : Number.NaN;
  };
  return {
    n: past.length,
    corrWithPastBar: corr(taker, past),
    corrWithNextBar: corr(taker, next),
    oiCorrWithPastBar: corr(oi, past),
    oiCorrWithNextBar: corr(oi, next),
  };
}
