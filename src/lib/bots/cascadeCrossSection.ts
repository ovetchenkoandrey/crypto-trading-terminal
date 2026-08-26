// Cross-section of the liquidation-cascade effect.
//
// Hypothesis 7 survived every control it was given and was rejected for one
// reason only: about twenty events a year on a symbol. The obvious repair is
// breadth — forty symbols should turn twenty events into eight hundred. This
// module exists to test the part of that argument that can actually fail:
// whether those events are independent observations or the same market-wide
// flush counted forty times.
//
// Everything here is measurement, not trading. It extracts events under the
// same no-look-ahead threshold the bot uses (`CascadeThreshold` is imported,
// not reimplemented, so the two cannot drift), records what happened after
// each one, and then asks how many of them happened at the same minute.
//
// Two forward measures are kept side by side on purpose:
//  - close-to-close, which is what `market-stats.md` reported and what the
//    literature means by "the effect";
//  - open-to-open starting at the bar after the trigger, which is what a market
//    order placed on the trigger bar can actually get.
// The gap between them is the part of the effect that lives inside the minute
// the strategy cannot reach.

import { CascadeThreshold, parseCascadeParams, type CascadeReversionParams } from "./cascadeReversion";
import type { Candle } from "../types";

export const FORWARD_HORIZONS = [1, 5, 15, 30, 60, 120] as const;
export type ForwardHorizon = (typeof FORWARD_HORIZONS)[number];

export interface CascadeEvent {
  symbol: string;
  /** Open time of the trigger bar, UTC seconds. */
  time: number;
  /** Signed move over `moveBars` closed bars, in bps. */
  moveBps: number;
  /** Threshold that admitted it, estimated on strictly earlier bars. */
  thresholdBps: number;
  triggerClose: number;
  /** Trigger-bar volume over the median of the prior window; 0 when unknown. */
  volumeMult: number;
  /** Open of the bar after the trigger — the first price a market order can get. */
  entryOpen: number;
  entryLow: number;
  entryHigh: number;
  /**
   * Fade return, close of trigger bar to close h bars later, in bps.
   * Positive means the move reverted. Keyed by horizon; missing when the
   * series ends first.
   */
  fadeCloseBps: Partial<Record<ForwardHorizon, number>>;
  /** Fade return, open[t+1] to open[t+1+h], in bps — the tradable version. */
  fadeOpenBps: Partial<Record<ForwardHorizon, number>>;
  /** open[t+1+h] for h = 0..holdCap, the price path a portfolio run replays. */
  path: number[];
}

export interface ExtractOptions {
  symbol: string;
  /** Bars the portfolio simulator may hold for; sizes the stored path. */
  holdCap?: number;
  /** Overrides on top of the bot's own defaults. */
  params?: Record<string, number | string>;
}

const DEFAULT_HOLD_CAP = 120;

/**
 * Params the cross-section runs with unless told otherwise. These are the ones
 * hypothesis 7 was left at, not a fresh fit: an expanding-window 0.9999 quantile
 * of one-bar moves, a 90-day warm-up before the first trade is allowed, and an
 * hour of cooldown so a four-minute flush counts once rather than four times.
 */
export const CROSS_SECTION_DEFAULTS: Record<string, number | string> = {
  moveBars: 1,
  thresholdMode: "expanding",
  percentile: 0.9999,
  refreshBars: 1440,
  warmupBars: 129_600,
  cooldownBars: 60,
  volumeWindow: 60,
};

function bps(from: number, to: number): number {
  return (to / from - 1) * 1e4;
}

/**
 * Median of the previous `window` volumes. Kept as a plain sort of a short
 * slice: it runs once per bar only when a trigger fires, not on every bar.
 */
function volumeMedian(bars: readonly Candle[], end: number, window: number): number {
  const start = Math.max(0, end - window);
  if (end - start < 10) return 0;
  const slice: number[] = [];
  for (let i = start; i < end; i++) slice.push(bars[i].volume);
  slice.sort((a, b) => a - b);
  return slice[Math.floor(slice.length / 2)];
}

/**
 * Extracts cascade events from one symbol's minute series.
 *
 * The threshold sees a bar only after that bar has been judged, which is the
 * whole reason `CascadeThreshold` is shaped the way it is. Bars are expected in
 * time order and contiguous; a gap simply means the move across it is measured
 * across the gap, the same way a live bot would see it.
 */
export function extractEvents(bars: readonly Candle[], opts: ExtractOptions): CascadeEvent[] {
  const p: CascadeReversionParams = parseCascadeParams({ ...CROSS_SECTION_DEFAULTS, ...(opts.params ?? {}) });
  const holdCap = Math.max(1, opts.holdCap ?? DEFAULT_HOLD_CAP);
  const threshold = new CascadeThreshold(p);
  const events: CascadeEvent[] = [];

  let lastTriggerBar = -1e9;

  for (let i = 0; i < bars.length; i++) {
    let move = Number.NaN;
    if (i >= p.moveBars) {
      const from = bars[i - p.moveBars].close;
      const to = bars[i].close;
      if (from > 0 && to > 0) move = bps(from, to);
    }

    const thr = threshold.thresholdBps();
    const triggered =
      Number.isFinite(thr) && thr > 0 && Number.isFinite(move) && Math.abs(move) >= thr &&
      i - lastTriggerBar >= p.cooldownBars;

    if (triggered) {
      lastTriggerBar = i;
      const entryBar = bars[i + 1];
      if (entryBar !== undefined) {
        const sign = move > 0 ? -1 : 1; // fade
        const fadeCloseBps: Partial<Record<ForwardHorizon, number>> = {};
        const fadeOpenBps: Partial<Record<ForwardHorizon, number>> = {};
        for (const h of FORWARD_HORIZONS) {
          const c = bars[i + h];
          if (c !== undefined) fadeCloseBps[h] = sign * bps(bars[i].close, c.close);
          const o = bars[i + 1 + h];
          if (o !== undefined) fadeOpenBps[h] = sign * bps(entryBar.open, o.open);
        }
        const path: number[] = [];
        for (let h = 0; h <= holdCap; h++) {
          const b = bars[i + 1 + h];
          if (b === undefined) break;
          path.push(b.open);
        }
        const med = volumeMedian(bars, i, p.volumeWindow);
        events.push({
          symbol: opts.symbol,
          time: bars[i].time,
          moveBps: move,
          thresholdBps: thr,
          triggerClose: bars[i].close,
          volumeMult: med > 0 ? bars[i].volume / med : 0,
          entryOpen: entryBar.open,
          entryLow: entryBar.low,
          entryHigh: entryBar.high,
          fadeCloseBps,
          fadeOpenBps,
          path,
        });
      }
    }

    if (Number.isFinite(move)) threshold.observe(move);
  }

  return events;
}

/* ── simultaneity ─────────────────────────────────────────────────────────── */

export interface EventCluster {
  /** Earliest event time in the cluster, UTC seconds. */
  time: number;
  symbols: string[];
  events: CascadeEvent[];
}

/**
 * Groups events across symbols into market-wide flushes.
 *
 * Single-link clustering on time with a `windowSec` link distance: two events
 * join the same cluster when they are within the window of each other, so a
 * cascade that rolls across the board over several minutes stays one event
 * rather than becoming several. That is the conservative direction — it makes
 * the independent count smaller, which is the number the hypothesis needs to be
 * large.
 */
export function clusterEvents(events: readonly CascadeEvent[], windowSec: number): EventCluster[] {
  const sorted = [...events].sort((a, b) => a.time - b.time);
  const out: EventCluster[] = [];
  let current: CascadeEvent[] = [];
  let lastTime = -Infinity;

  for (const e of sorted) {
    if (current.length > 0 && e.time - lastTime > windowSec) {
      out.push(makeCluster(current));
      current = [];
    }
    current.push(e);
    lastTime = e.time;
  }
  if (current.length > 0) out.push(makeCluster(current));
  return out;
}

function makeCluster(events: CascadeEvent[]): EventCluster {
  return {
    time: events[0].time,
    symbols: Array.from(new Set(events.map((e) => e.symbol))),
    events,
  };
}

export interface SimultaneityReport {
  events: number;
  clusters: number;
  /** Events landing in a cluster with at least one other symbol. */
  clusteredEvents: number;
  clusteredShare: number;
  meanClusterSize: number;
  maxClusterSize: number;
  /** Largest cluster, for the "one bad day" check. */
  largestClusterTime: number;
  largestClusterSymbols: string[];
  /** Histogram: index k holds the number of clusters holding k+1 symbols. */
  sizeHistogram: number[];
}

export function summariseSimultaneity(clusters: readonly EventCluster[]): SimultaneityReport {
  let events = 0;
  let clustered = 0;
  let maxSize = 0;
  let largest: EventCluster | null = null;
  const hist: number[] = [];

  for (const c of clusters) {
    const size = c.symbols.length;
    events += c.events.length;
    if (size > 1) clustered += c.events.length;
    if (size > maxSize) {
      maxSize = size;
      largest = c;
    }
    while (hist.length < size) hist.push(0);
    hist[size - 1] += 1;
  }

  return {
    events,
    clusters: clusters.length,
    clusteredEvents: clustered,
    clusteredShare: events > 0 ? clustered / events : 0,
    meanClusterSize: clusters.length > 0 ? events / clusters.length : 0,
    maxClusterSize: maxSize,
    largestClusterTime: largest?.time ?? 0,
    largestClusterSymbols: largest?.symbols ?? [],
    sizeHistogram: hist,
  };
}

/* ── effective sample size ────────────────────────────────────────────────── */

export interface EffectiveSize {
  n: number;
  clusters: number;
  /** Intra-cluster correlation of the outcome, from the one-way ANOVA estimator. */
  icc: number;
  /** n / (1 + (mBar - 1) * icc) — the design effect the t-statistic must pay. */
  effectiveN: number;
  meanClusterSize: number;
  /** t computed as if every event were independent. */
  naiveT: number;
  /** t on cluster means — the honest one when a cluster is one flush. */
  clusterT: number;
  meanBps: number;
  clusterMeanBps: number;
}

function meanOf(x: readonly number[]): number {
  if (x.length === 0) return Number.NaN;
  let s = 0;
  for (const v of x) s += v;
  return s / x.length;
}

function varianceOf(x: readonly number[], m: number): number {
  if (x.length < 2) return Number.NaN;
  let s = 0;
  for (const v of x) s += (v - m) * (v - m);
  return s / (x.length - 1);
}

/**
 * How many independent observations forty symbols really provide.
 *
 * Two numbers, because they answer different objections. `clusterT` treats each
 * market-wide flush as one observation and is what a sceptic would demand.
 * `effectiveN` is the standard design-effect deflation, which is milder: it
 * credits within-cluster variation when symbols do not move together, and
 * collapses to the cluster count when they move in lockstep.
 */
export function effectiveSampleSize(
  clusters: readonly EventCluster[],
  outcome: (e: CascadeEvent) => number | undefined,
): EffectiveSize {
  const groups: number[][] = [];
  const all: number[] = [];
  for (const c of clusters) {
    const vals: number[] = [];
    for (const e of c.events) {
      const v = outcome(e);
      if (v !== undefined && Number.isFinite(v)) vals.push(v);
    }
    if (vals.length > 0) {
      groups.push(vals);
      for (const v of vals) all.push(v);
    }
  }

  const n = all.length;
  const k = groups.length;
  const grand = meanOf(all);
  const clusterMeans = groups.map(meanOf);
  const clusterMean = meanOf(clusterMeans);

  const naiveVar = varianceOf(all, grand);
  const naiveT = n > 1 && naiveVar > 0 ? grand / Math.sqrt(naiveVar / n) : Number.NaN;

  const cVar = varianceOf(clusterMeans, clusterMean);
  const clusterT = k > 1 && cVar > 0 ? clusterMean / Math.sqrt(cVar / k) : Number.NaN;

  // One-way random-effects ICC. msb/msw with the unequal-size correction m0.
  let ssb = 0;
  let ssw = 0;
  for (let g = 0; g < k; g++) {
    const m = groups[g].length;
    ssb += m * (clusterMeans[g] - grand) * (clusterMeans[g] - grand);
    for (const v of groups[g]) ssw += (v - clusterMeans[g]) * (v - clusterMeans[g]);
  }
  const dfB = k - 1;
  const dfW = n - k;
  const msb = dfB > 0 ? ssb / dfB : Number.NaN;
  const msw = dfW > 0 ? ssw / dfW : Number.NaN;
  let sumSq = 0;
  for (const g of groups) sumSq += g.length * g.length;
  const m0 = dfB > 0 ? (n - sumSq / n) / dfB : Number.NaN;

  let icc = 0;
  if (Number.isFinite(msb) && Number.isFinite(msw) && Number.isFinite(m0) && m0 > 0) {
    const between = (msb - msw) / m0;
    const denom = between + msw;
    icc = denom > 0 ? Math.max(0, Math.min(1, between / denom)) : 0;
  }

  const mBar = k > 0 ? n / k : 0;
  const design = 1 + Math.max(0, mBar - 1) * icc;
  return {
    n,
    clusters: k,
    icc,
    effectiveN: design > 0 ? n / design : n,
    meanClusterSize: mBar,
    naiveT,
    clusterT,
    meanBps: grand,
    clusterMeanBps: clusterMean,
  };
}

/* ── per-symbol reproducibility ───────────────────────────────────────────── */

export interface SymbolEffect {
  symbol: string;
  n: number;
  meanBps: number;
  medianBps: number;
  t: number;
  winRate: number;
  /** Share of the symbol's total fade profit contributed by its best event. */
  topShare: number;
}

export function symbolEffect(
  symbol: string,
  events: readonly CascadeEvent[],
  outcome: (e: CascadeEvent) => number | undefined,
): SymbolEffect {
  const vals: number[] = [];
  for (const e of events) {
    const v = outcome(e);
    if (v !== undefined && Number.isFinite(v)) vals.push(v);
  }
  const n = vals.length;
  const m = meanOf(vals);
  const v = varianceOf(vals, m);
  const sorted = [...vals].sort((a, b) => a - b);
  const median = n === 0 ? Number.NaN : n % 2 === 1 ? sorted[(n - 1) / 2] : (sorted[n / 2 - 1] + sorted[n / 2]) / 2;
  const wins = vals.filter((x) => x > 0).length;
  const total = vals.reduce((s, x) => s + x, 0);
  const best = n > 0 ? sorted[n - 1] : 0;
  return {
    symbol,
    n,
    meanBps: m,
    medianBps: median,
    t: n > 1 && v > 0 ? m / Math.sqrt(v / n) : Number.NaN,
    winRate: n > 0 ? wins / n : Number.NaN,
    topShare: total > 0 ? best / total : Number.NaN,
  };
}

/** Sign test over per-symbol means — reproducibility that does not average away. */
export function reproducibility(effects: readonly SymbolEffect[]): {
  symbols: number;
  positive: number;
  share: number;
  /** Two-sided binomial z against a coin flip. */
  z: number;
} {
  const usable = effects.filter((e) => e.n > 0 && Number.isFinite(e.meanBps));
  const k = usable.length;
  const pos = usable.filter((e) => e.meanBps > 0).length;
  const z = k > 0 ? (pos - k / 2) / Math.sqrt(k / 4) : Number.NaN;
  return { symbols: k, positive: pos, share: k > 0 ? pos / k : Number.NaN, z };
}
