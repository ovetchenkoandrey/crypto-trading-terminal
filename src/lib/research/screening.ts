import { createCandleStore } from "../data/candleStore.ts";
import { intervalSeconds, parseInterval, type DataInterval } from "../data/interval.ts";
import { normalizeSymbol, type Market } from "../data/paths.ts";
import { BarAggregator } from "../execution/backtest/aggregate.ts";
import type { Series } from "../indicators/core.ts";
import type { Candle } from "../types.ts";
import { featureCatalog, regimeCatalog, type FeatureGroup, type FeatureSpec } from "./featureLib.ts";
import {
  alignPairs,
  bucketProfile,
  conditionalIc,
  forwardReturns,
  informationCoefficient,
  pairGrid,
  type AlignedPairs,
  type BucketProfile,
  type IcResult,
  type InteractionResult,
  type PairGrid,
} from "./infoCoefficient.ts";
import { adjustPValues, expectedMaxAbsZ, familywiseZThreshold, type Adjusted } from "./multipleTesting.ts";
import { pearson } from "./rank.ts";
import { chiSquareSf, twoSidedP } from "./distributions.ts";

/**
 * The screening run: every feature against every horizon on every timeframe,
 * measured directly rather than through a strategy.
 *
 * Three decisions carry the honesty of the whole thing.
 *
 * Pooling across symbols is equal-weight, not inverse-variance. The question is
 * "does this work on the market", not "does this work on whichever symbol has
 * the most bars", and a feature that lives on BTC alone should not be rescued by
 * BTC's row count.
 *
 * The pooled standard error is inflated for cross-symbol correlation. BTC and
 * ETH minute returns correlate at 0.79; treating four perpetuals as four
 * independent experiments would understate every standard error by roughly a
 * factor of two. The inflation uses the measured average pairwise correlation of
 * the returns themselves, which is an upper bound on the correlation of the
 * rank-product series and therefore errs toward finding nothing.
 *
 * Stability is counted, not averaged. A feature is reported with the number of
 * symbol-by-subperiod slices whose sign agrees with the pooled estimate. Under
 * the null that is a coin flip per slice, so the count is directly readable.
 */

export const DEFAULT_TIMEFRAMES: DataInterval[] = ["15m", "1h", "4h", "1d"];
export const DEFAULT_HORIZONS = [1, 4, 24, 96];

export interface ScreenOptions {
  dataRoot: string;
  market: Market;
  symbols: string[];
  fromSec: number;
  toSec: number;
  timeframes?: DataInterval[];
  horizons?: number[];
  /** Quantile buckets per feature. */
  buckets?: number;
  /** Chronological slices per symbol used for the stability count. */
  subperiods?: number;
  /** How many features go on to the interaction and pair stages. */
  shortlist?: number;
  /** Round-trip taker cost in basis points, used for the economic comparison. */
  costBps?: number;
  onProgress?: (message: string) => void;
}

export interface SymbolCell {
  symbol: string;
  ic: IcResult;
  /** IC inside each chronological slice, ranks recomputed within the slice. */
  subperiodIc: number[];
  spreadBps: number;
  spreadSeBps: number;
}

export interface ScreenCell {
  feature: string;
  group: FeatureGroup;
  timeframe: DataInterval;
  horizon: number;
  /** Total aligned observations across symbols. */
  n: number;
  perSymbol: SymbolCell[];
  /** Equal-weight mean IC across symbols. */
  ic: number;
  /** Standard error of that mean, inflated for cross-symbol correlation. */
  se: number;
  z: number;
  p: number;
  /** Symbols whose IC sign matches the pooled sign. */
  symbolAgree: number;
  symbolTotal: number;
  /** Symbol-by-subperiod slices whose sign matches the pooled sign. */
  sliceAgree: number;
  sliceTotal: number;
  /** Equal-weight top-minus-bottom quantile spread, basis points. */
  spreadBps: number;
  spreadSeBps: number;
  spreadZ: number;
  spreadP: number;
  /** Pooled quantile means, basis points. */
  bucketBps: number[];
  monotonicity: number;
  curvatureBps: number;
  curvatureZ: number;
  /** Pooled chi-square that the quantile means are all equal. */
  chi2Equal: number;
  pEqual: number;
  chi2Nonlinear: number;
  pNonlinear: number;
}

export interface RegimeReport {
  feature: string;
  timeframe: DataInterval;
  horizon: number;
  regime: string;
  perRegime: { label: string; ic: number; se: number; z: number }[];
  maxDiffZ: number;
  maxDiffLabel: string;
  chi2: number;
  p: number;
}

export interface PairReport {
  featureA: string;
  featureB: string;
  timeframe: DataInterval;
  horizon: number;
  /** Best minus worst grid cell, basis points, pooled across symbols. */
  spreadBps: number;
  chi2Interaction: number;
  pInteraction: number;
  maxCellZ: number;
  maxCellLabel: string;
}

export interface ScreenResult {
  market: Market;
  symbols: string[];
  fromSec: number;
  toSec: number;
  timeframes: DataInterval[];
  horizons: number[];
  buckets: number;
  subperiods: number;
  costBps: number;
  featureCount: number;
  cells: ScreenCell[];
  /** Average pairwise correlation of bar returns per timeframe. */
  crossCorr: Record<string, number>;
  /** BH and Bonferroni over the IC family. */
  icAdjusted: Adjusted[];
  /** Same over the "quantile means are not all equal" family. */
  shapeAdjusted: Adjusted[];
  regimes: RegimeReport[];
  pairs: PairReport[];
  family: {
    icTests: number;
    shapeTests: number;
    regimeTests: number;
    pairTests: number;
    total: number;
    /** |z| a single test must clear for the whole family at 5%. */
    zThreshold: number;
    /** Expected largest |z| from that many pure-noise draws. */
    expectedMaxZ: number;
  };
  perSymbolBars: Record<string, Record<string, number>>;
  elapsedMs: number;
}

interface LoadedFrames {
  bars: Map<DataInterval, Candle[]>;
}

/**
 * Streams the minute series month by month straight into bar aggregators.
 *
 * Holding three and a half million candle objects to aggregate them costs
 * several hundred megabytes per symbol and buys nothing: the aggregators only
 * ever need the current bar.
 */
function loadFrames(
  dataRoot: string,
  market: Market,
  symbol: string,
  fromSec: number,
  toSec: number,
  timeframes: readonly DataInterval[],
): LoadedFrames {
  const store = createCandleStore(dataRoot);
  const key = { market, symbol: normalizeSymbol(symbol), interval: parseInterval("1m") };
  const aggs = timeframes.map((tf) => ({ tf, agg: new BarAggregator(intervalSeconds(tf)), out: [] as Candle[] }));

  const CHUNK = 86400 * 30;
  for (let start = fromSec; start <= toSec; start += CHUNK) {
    const end = Math.min(toSec, start + CHUNK - 1);
    const chunk = store.readRange(key, start, end);
    for (const bar of chunk) {
      for (const a of aggs) {
        const closed = a.agg.push(bar);
        if (closed) a.out.push(closed);
      }
    }
  }

  const bars = new Map<DataInterval, Candle[]>();
  for (const a of aggs) bars.set(a.tf, a.out);
  return { bars };
}

function subperiodIcs(pairs: AlignedPairs, slices: number, horizon: number): number[] {
  const out: number[] = [];
  const n = pairs.x.length;
  if (n < slices * 60) return out;
  const size = Math.floor(n / slices);
  for (let s = 0; s < slices; s++) {
    const from = s * size;
    const to = s === slices - 1 ? n : from + size;
    const sub: AlignedPairs = {
      x: pairs.x.subarray(from, to),
      y: pairs.y.subarray(from, to),
      index: pairs.index.subarray(from, to),
    };
    out.push(informationCoefficient(sub, horizon).ic);
  }
  return out;
}

/** Equal-weight pooling with a variance inflation for cross-symbol correlation. */
function poolMean(values: number[], ses: number[], rho: number): { mean: number; se: number } {
  const k = values.length;
  if (k === 0) return { mean: Number.NaN, se: Number.NaN };
  let sum = 0;
  for (const v of values) sum += v;
  const mean = sum / k;
  let variance = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) {
      const cov = i === j ? ses[i] * ses[i] : rho * ses[i] * ses[j];
      variance += cov;
    }
  }
  return { mean, se: Math.sqrt(Math.max(variance, 0)) / k };
}

/** Average pairwise correlation of bar returns across symbols, aligned by timestamp. */
function crossSymbolCorrelation(series: Map<string, { time: Float64Array; ret: Float64Array }>): number {
  const names = Array.from(series.keys());
  if (names.length < 2) return 0;
  const maps = names.map((name) => {
    const s = series.get(name)!;
    const m = new Map<number, number>();
    for (let i = 0; i < s.time.length; i++) m.set(s.time[i], s.ret[i]);
    return m;
  });
  let sum = 0;
  let count = 0;
  for (let a = 0; a < maps.length; a++) {
    for (let b = a + 1; b < maps.length; b++) {
      const xs: number[] = [];
      const ys: number[] = [];
      for (const [t, v] of maps[a]) {
        const w = maps[b].get(t);
        if (w === undefined) continue;
        xs.push(v);
        ys.push(w);
      }
      if (xs.length < 100) continue;
      const r = pearson(xs, ys);
      if (!Number.isFinite(r)) continue;
      sum += r;
      count++;
    }
  }
  return count > 0 ? sum / count : 0;
}

function barReturns(bars: readonly Candle[]): { time: Float64Array; ret: Float64Array } {
  const n = Math.max(0, bars.length - 1);
  const time = new Float64Array(n);
  const ret = new Float64Array(n);
  let at = 0;
  for (let i = 1; i < bars.length; i++) {
    const prev = bars[i - 1].close;
    const cur = bars[i].close;
    if (!(prev > 0) || !(cur > 0)) continue;
    time[at] = bars[i].time;
    ret[at] = Math.log(cur / prev);
    at++;
  }
  return { time: time.subarray(0, at), ret: ret.subarray(0, at) };
}

interface RawCell {
  feature: string;
  group: FeatureGroup;
  timeframe: DataInterval;
  horizon: number;
  perSymbol: SymbolCell[];
  profiles: BucketProfile[];
  n: number;
}

function poolBuckets(profiles: BucketProfile[], count: number, rho: number): {
  bucketBps: number[];
  chi2Equal: number;
  pEqual: number;
  chi2Nonlinear: number;
  pNonlinear: number;
  monotonicity: number;
  curvatureBps: number;
  curvatureZ: number;
} {
  const bucketBps: number[] = [];
  const bucketSe: number[] = [];
  for (let b = 0; b < count; b++) {
    const values: number[] = [];
    const ses: number[] = [];
    for (const p of profiles) {
      const cell = p.buckets[b];
      if (!cell || !Number.isFinite(cell.meanBps) || !(cell.seBps > 0)) continue;
      values.push(cell.meanBps);
      ses.push(cell.seBps);
    }
    if (values.length === 0) {
      bucketBps.push(Number.NaN);
      bucketSe.push(Number.NaN);
      continue;
    }
    const pooled = poolMean(values, ses, rho);
    bucketBps.push(pooled.mean);
    bucketSe.push(pooled.se);
  }

  const idx: number[] = [];
  const means: number[] = [];
  const ses: number[] = [];
  for (let b = 0; b < count; b++) {
    if (!Number.isFinite(bucketBps[b]) || !(bucketSe[b] > 0)) continue;
    idx.push(b);
    means.push(bucketBps[b]);
    ses.push(bucketSe[b]);
  }

  if (means.length < 3) {
    return {
      bucketBps,
      chi2Equal: Number.NaN,
      pEqual: Number.NaN,
      chi2Nonlinear: Number.NaN,
      pNonlinear: Number.NaN,
      monotonicity: Number.NaN,
      curvatureBps: Number.NaN,
      curvatureZ: Number.NaN,
    };
  }

  let sw = 0;
  let swy = 0;
  for (let i = 0; i < means.length; i++) {
    const w = 1 / (ses[i] * ses[i]);
    sw += w;
    swy += w * means[i];
  }
  const pooledMeanValue = swy / sw;
  let chi2Equal = 0;
  for (let i = 0; i < means.length; i++) chi2Equal += (means[i] - pooledMeanValue) ** 2 / (ses[i] * ses[i]);

  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let w0 = 0;
  for (let i = 0; i < means.length; i++) {
    const w = 1 / (ses[i] * ses[i]);
    w0 += w;
    sx += w * idx[i];
    sy += w * means[i];
    sxx += w * idx[i] * idx[i];
    sxy += w * idx[i] * means[i];
  }
  const det = w0 * sxx - sx * sx;
  let chi2Nonlinear = Number.NaN;
  if (det !== 0) {
    const slope = (w0 * sxy - sx * sy) / det;
    const intercept = (sy - slope * sx) / w0;
    chi2Nonlinear = 0;
    for (let i = 0; i < means.length; i++) {
      chi2Nonlinear += (means[i] - (intercept + slope * idx[i])) ** 2 / (ses[i] * ses[i]);
    }
  }

  const lo = 0;
  const hi = means.length - 1;
  const mid = Math.floor(means.length / 2);
  const curvatureBps = (means[lo] + means[hi]) / 2 - means[mid];
  const curvatureSe = Math.sqrt((ses[lo] ** 2 + ses[hi] ** 2) / 4 + ses[mid] ** 2);

  let concordant = 0;
  let pairsSeen = 0;
  for (let i = 0; i < means.length; i++) {
    for (let j = i + 1; j < means.length; j++) {
      pairsSeen++;
      if (means[j] > means[i]) concordant++;
      else if (means[j] < means[i]) concordant--;
    }
  }
  const monotonicity = pairsSeen > 0 ? concordant / pairsSeen : Number.NaN;

  return {
    bucketBps,
    chi2Equal,
    pEqual: chiSquare(chi2Equal, means.length - 1),
    chi2Nonlinear,
    pNonlinear: chiSquare(chi2Nonlinear, Math.max(1, means.length - 2)),
    monotonicity,
    curvatureBps,
    curvatureZ: curvatureBps / curvatureSe,
  };
}

function chiSquare(x: number, df: number): number {
  return Number.isFinite(x) ? chiSquareSf(x, df) : Number.NaN;
}

export function runScreen(opts: ScreenOptions): ScreenResult {
  const started = Date.now();
  const timeframes = opts.timeframes ?? DEFAULT_TIMEFRAMES;
  const horizons = opts.horizons ?? DEFAULT_HORIZONS;
  const buckets = opts.buckets ?? 5;
  const subperiods = opts.subperiods ?? 4;
  const shortlist = opts.shortlist ?? 10;
  const costBps = opts.costBps ?? 11;
  const say = opts.onProgress ?? ((): void => {});

  const catalog = featureCatalog();
  const regimeSpecs = regimeCatalog();
  const symbols = opts.symbols.map(normalizeSymbol);

  const raw = new Map<string, RawCell>();
  const perSymbolBars: Record<string, Record<string, number>> = {};
  const returnsByTf = new Map<DataInterval, Map<string, { time: Float64Array; ret: Float64Array }>>();
  for (const tf of timeframes) returnsByTf.set(tf, new Map());

  for (const symbol of symbols) {
    say(`loading ${symbol}`);
    const frames = loadFrames(opts.dataRoot, opts.market, symbol, opts.fromSec, opts.toSec, timeframes);
    perSymbolBars[symbol] = {};

    for (const tf of timeframes) {
      const bars = frames.bars.get(tf) ?? [];
      perSymbolBars[symbol][tf] = bars.length;
      if (bars.length < 500) {
        say(`  ${symbol} ${tf}: only ${bars.length} bars, skipped`);
        continue;
      }
      const sec = intervalSeconds(tf);
      returnsByTf.get(tf)!.set(symbol, barReturns(bars));

      const fwd = new Map<number, Float64Array>();
      for (const h of horizons) fwd.set(h, forwardReturns(bars, h, sec));

      say(`  ${symbol} ${tf}: ${bars.length} bars, ${catalog.length} features`);
      for (const spec of catalog) {
        const series = spec.compute(bars);
        for (const h of horizons) {
          const pairs = alignPairs(series, fwd.get(h)!);
          if (pairs.x.length < 200) continue;
          const ic = informationCoefficient(pairs, h);
          if (!Number.isFinite(ic.ic)) continue;
          const profile = bucketProfile(pairs, buckets, h);
          const cellKey = `${spec.name}|${tf}|${h}`;
          let cell = raw.get(cellKey);
          if (!cell) {
            cell = { feature: spec.name, group: spec.group, timeframe: tf, horizon: h, perSymbol: [], profiles: [], n: 0 };
            raw.set(cellKey, cell);
          }
          cell.perSymbol.push({
            symbol,
            ic,
            subperiodIc: subperiodIcs(pairs, subperiods, h),
            spreadBps: profile.spreadBps,
            spreadSeBps: profile.spreadSeBps,
          });
          cell.profiles.push(profile);
          cell.n += pairs.x.length;
        }
      }
      frames.bars.set(tf, []);
    }
  }

  const crossCorr: Record<string, number> = {};
  for (const tf of timeframes) crossCorr[tf] = crossSymbolCorrelation(returnsByTf.get(tf)!);

  const cells: ScreenCell[] = [];
  for (const cell of raw.values()) {
    const rho = Math.max(0, crossCorr[cell.timeframe] ?? 0);
    const ics = cell.perSymbol.map((s) => s.ic.ic);
    const ses = cell.perSymbol.map((s) => s.ic.se);
    const pooled = poolMean(ics, ses, rho);
    const z = pooled.mean / pooled.se;

    const spreads = cell.perSymbol.map((s) => s.spreadBps).filter((v) => Number.isFinite(v));
    const spreadSes = cell.perSymbol
      .map((s) => s.spreadSeBps)
      .filter((v, i) => Number.isFinite(cell.perSymbol[i].spreadBps));
    const pooledSpread = spreads.length > 0 ? poolMean(spreads, spreadSes, rho) : { mean: Number.NaN, se: Number.NaN };
    const spreadZ = pooledSpread.mean / pooledSpread.se;

    const sign = Math.sign(pooled.mean);
    let symbolAgree = 0;
    let sliceAgree = 0;
    let sliceTotal = 0;
    for (const s of cell.perSymbol) {
      if (Math.sign(s.ic.ic) === sign && sign !== 0) symbolAgree++;
      for (const v of s.subperiodIc) {
        if (!Number.isFinite(v)) continue;
        sliceTotal++;
        if (Math.sign(v) === sign && sign !== 0) sliceAgree++;
      }
    }

    const shape = poolBuckets(cell.profiles, buckets, rho);

    cells.push({
      feature: cell.feature,
      group: cell.group,
      timeframe: cell.timeframe,
      horizon: cell.horizon,
      n: cell.n,
      perSymbol: cell.perSymbol,
      ic: pooled.mean,
      se: pooled.se,
      z,
      p: twoSidedP(z),
      symbolAgree,
      symbolTotal: cell.perSymbol.length,
      sliceAgree,
      sliceTotal,
      spreadBps: pooledSpread.mean,
      spreadSeBps: pooledSpread.se,
      spreadZ,
      spreadP: twoSidedP(spreadZ),
      ...shape,
    });
  }

  cells.sort((a, b) => Math.abs(b.z) - Math.abs(a.z));

  const icAdjusted = adjustPValues(cells.map((c) => ({ label: `${c.feature}|${c.timeframe}|h${c.horizon}`, p: c.p })));
  const shapeAdjusted = adjustPValues(
    cells
      .filter((c) => Number.isFinite(c.pEqual))
      .map((c) => ({ label: `${c.feature}|${c.timeframe}|h${c.horizon}`, p: c.pEqual })),
  );

  // ---- stage two: regimes and pairs on the shortlist ----------------------
  const bestPerFeature = new Map<string, ScreenCell>();
  for (const c of cells) {
    const prev = bestPerFeature.get(c.feature);
    if (!prev || Math.abs(c.z) > Math.abs(prev.z)) bestPerFeature.set(c.feature, c);
  }
  const picks = Array.from(bestPerFeature.values())
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
    .slice(0, shortlist);

  const regimes: RegimeReport[] = [];
  const pairs: PairReport[] = [];

  if (picks.length > 0) {
    const byTf = new Map<DataInterval, ScreenCell[]>();
    for (const p of picks) {
      const list = byTf.get(p.timeframe) ?? [];
      list.push(p);
      byTf.set(p.timeframe, list);
    }

    const specByName = new Map<string, FeatureSpec>(catalog.map((s) => [s.name, s]));
    const regimeAcc = new Map<string, { label: string; ics: number[]; ses: number[] }[]>();
    const pairAcc = new Map<string, { cells: Map<string, { means: number[]; ses: number[] }>; size: number }>();

    for (const symbol of symbols) {
      say(`stage two: ${symbol}`);
      const tfs = Array.from(byTf.keys());
      const frames = loadFrames(opts.dataRoot, opts.market, symbol, opts.fromSec, opts.toSec, tfs);

      for (const tf of tfs) {
        const bars = frames.bars.get(tf) ?? [];
        if (bars.length < 500) continue;
        const sec = intervalSeconds(tf);
        const picksHere = byTf.get(tf)!;
        const regimeValues = regimeSpecs.map((r) => ({ spec: r, values: r.compute(bars) }));

        const seriesCache = new Map<string, Series>();
        const need = new Set(picksHere.map((p) => p.feature));
        for (const name of need) {
          const spec = specByName.get(name);
          if (spec) seriesCache.set(name, spec.compute(bars));
        }

        for (const pick of picksHere) {
          const series = seriesCache.get(pick.feature);
          if (!series) continue;
          const fwd = forwardReturns(bars, pick.horizon, sec);
          const aligned = alignPairs(series, fwd);
          if (aligned.x.length < 500) continue;

          for (const r of regimeValues) {
            const res: InteractionResult = conditionalIc(
              aligned,
              (barIndex) => r.values[barIndex],
              r.spec.labels,
              pick.horizon,
            );
            const key = `${pick.feature}|${tf}|${pick.horizon}|${r.spec.name}`;
            const acc = regimeAcc.get(key) ?? r.spec.labels.map((label) => ({ label, ics: [], ses: [] }));
            res.regimes.forEach((entry, i) => {
              if (!Number.isFinite(entry.ic.ic) || !(entry.ic.se > 0)) return;
              acc[i].ics.push(entry.ic.ic);
              acc[i].ses.push(entry.ic.se);
            });
            regimeAcc.set(key, acc);
          }

          for (const other of picksHere) {
            if (other.feature === pick.feature) continue;
            if (other.feature < pick.feature) continue;
            const otherSeries = seriesCache.get(other.feature);
            if (!otherSeries) continue;
            const grid: PairGrid = pairGrid(aligned, otherSeries, 3, pick.horizon);
            const key = `${pick.feature}|${other.feature}|${tf}|${pick.horizon}`;
            const acc = pairAcc.get(key) ?? { cells: new Map(), size: grid.size };
            for (const cell of grid.cells) {
              if (!(cell.n > 0) || !Number.isFinite(cell.meanBps) || !(cell.seBps > 0)) continue;
              const ck = `${cell.row}:${cell.col}`;
              const list = acc.cells.get(ck) ?? { means: [], ses: [] };
              list.means.push(cell.meanBps);
              list.ses.push(cell.seBps);
              acc.cells.set(ck, list);
            }
            pairAcc.set(key, acc);
          }
        }
        frames.bars.set(tf, []);
      }
    }

    for (const [key, acc] of regimeAcc) {
      const [feature, tf, hRaw, regime] = key.split("|");
      const rho = Math.max(0, crossCorr[tf] ?? 0);
      const perRegime = acc.map((entry) => {
        const pooled = poolMean(entry.ics, entry.ses, rho);
        return { label: entry.label, ic: pooled.mean, se: pooled.se, z: pooled.mean / pooled.se };
      });
      const usable = perRegime.filter((r) => Number.isFinite(r.ic) && r.se > 0);
      let chi2 = 0;
      let sw = 0;
      let swy = 0;
      for (const r of usable) {
        const w = 1 / (r.se * r.se);
        sw += w;
        swy += w * r.ic;
      }
      const pooledIc = swy / sw;
      for (const r of usable) chi2 += (r.ic - pooledIc) ** 2 / (r.se * r.se);
      let maxDiffZ = 0;
      let maxDiffLabel = "";
      for (let a = 0; a < usable.length; a++) {
        for (let b = a + 1; b < usable.length; b++) {
          const z = (usable[a].ic - usable[b].ic) / Math.sqrt(usable[a].se ** 2 + usable[b].se ** 2);
          if (Math.abs(z) > Math.abs(maxDiffZ)) {
            maxDiffZ = z;
            maxDiffLabel = `${usable[a].label} vs ${usable[b].label}`;
          }
        }
      }
      regimes.push({
        feature,
        timeframe: tf as DataInterval,
        horizon: Number(hRaw.replace("h", "")),
        regime,
        perRegime,
        maxDiffZ,
        maxDiffLabel,
        chi2,
        p: chiSquare(chi2, Math.max(1, usable.length - 1)),
      });
    }
    regimes.sort((a, b) => Math.abs(b.maxDiffZ) - Math.abs(a.maxDiffZ));

    for (const [key, acc] of pairAcc) {
      const [featureA, featureB, tf, hRaw] = key.split("|");
      const rho = Math.max(0, crossCorr[tf] ?? 0);
      const pooledCells: { row: number; col: number; mean: number; se: number }[] = [];
      for (const [ck, list] of acc.cells) {
        const [r, c] = ck.split(":").map(Number);
        const pooled = poolMean(list.means, list.ses, rho);
        if (!Number.isFinite(pooled.mean) || !(pooled.se > 0)) continue;
        pooledCells.push({ row: r, col: c, mean: pooled.mean, se: pooled.se });
      }
      if (pooledCells.length < 5) continue;

      const size = acc.size;
      const rowEff = new Float64Array(size);
      const colEff = new Float64Array(size);
      let grand = 0;
      let wTotal = 0;
      for (const c of pooledCells) {
        const w = 1 / (c.se * c.se);
        grand += w * c.mean;
        wTotal += w;
      }
      grand /= wTotal;
      for (let sweep = 0; sweep < 50; sweep++) {
        for (let r = 0; r < size; r++) {
          let num = 0;
          let den = 0;
          for (const c of pooledCells) {
            if (c.row !== r) continue;
            const w = 1 / (c.se * c.se);
            num += w * (c.mean - grand - colEff[c.col]);
            den += w;
          }
          rowEff[r] = den > 0 ? num / den : 0;
        }
        for (let k = 0; k < size; k++) {
          let num = 0;
          let den = 0;
          for (const c of pooledCells) {
            if (c.col !== k) continue;
            const w = 1 / (c.se * c.se);
            num += w * (c.mean - grand - rowEff[c.row]);
            den += w;
          }
          colEff[k] = den > 0 ? num / den : 0;
        }
      }
      let chi2 = 0;
      let maxCellZ = 0;
      let maxCellLabel = "";
      let best = -Infinity;
      let worst = Infinity;
      for (const c of pooledCells) {
        const resid = c.mean - (grand + rowEff[c.row] + colEff[c.col]);
        chi2 += (resid / c.se) ** 2;
        const z = resid / c.se;
        if (Math.abs(z) > Math.abs(maxCellZ)) {
          maxCellZ = z;
          maxCellLabel = `r${c.row + 1}c${c.col + 1}`;
        }
        best = Math.max(best, c.mean);
        worst = Math.min(worst, c.mean);
      }
      pairs.push({
        featureA,
        featureB,
        timeframe: tf as DataInterval,
        horizon: Number(hRaw.replace("h", "")),
        spreadBps: best - worst,
        chi2Interaction: chi2,
        pInteraction: chiSquare(chi2, Math.max(1, (size - 1) * (size - 1))),
        maxCellZ,
        maxCellLabel,
      });
    }
    pairs.sort((a, b) => a.pInteraction - b.pInteraction);
  }

  const icTests = cells.length;
  const shapeTests = shapeAdjusted.length;
  const regimeTests = regimes.length;
  const pairTests = pairs.length;
  const total = icTests + shapeTests + regimeTests + pairTests;

  return {
    market: opts.market,
    symbols,
    fromSec: opts.fromSec,
    toSec: opts.toSec,
    timeframes,
    horizons,
    buckets,
    subperiods,
    costBps,
    featureCount: catalog.length,
    cells,
    crossCorr,
    icAdjusted,
    shapeAdjusted,
    regimes,
    pairs,
    family: {
      icTests,
      shapeTests,
      regimeTests,
      pairTests,
      total,
      zThreshold: familywiseZThreshold(total),
      expectedMaxZ: expectedMaxAbsZ(total),
    },
    perSymbolBars,
    elapsedMs: Date.now() - started,
  };
}
