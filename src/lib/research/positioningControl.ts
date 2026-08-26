import { intervalSeconds, type DataInterval } from "../data/interval.ts";
import { createMetricsStore } from "../data/metricsStore.ts";
import { normalizeSymbol, type Market } from "../data/paths.ts";
import type { Series } from "../indicators/core.ts";
import { featureCatalog } from "./featureLib.ts";
import { bucketProfile, forwardReturns, type AlignedPairs } from "./infoCoefficient.ts";
import { buildPositioningSeries, positioningFeatureSpecs, type AsOfOptions } from "./positioningFeatures.ts";
import { quantileBucketIndex, spearman } from "./rank.ts";
import { loadFrames } from "./screening.ts";
import { twoSidedP } from "./distributions.ts";

/**
 * Is a positioning feature anything more than a price feature in a costume?
 *
 * The crowd gets long as price rises, so the long/short ratio is partly a slow
 * copy of the recent return, and the recent return is something we have already
 * screened sixty-three ways. A big quantile spread on such a feature could be
 * the positioning data speaking, or it could be the price data speaking through
 * it — and those are opposite conclusions.
 *
 * The test here is the direct one. Cut the sample into quantile slices of the
 * price feature, compute the positioning feature's quintile spread inside each
 * slice, and pool. If the spread is a repackaged price effect it collapses,
 * because inside a slice the price effect barely varies. If it survives, the
 * positioning column carries something the price does not.
 *
 * Read the retained fraction against a calibrated baseline rather than against
 * zero. Conditioning on a finite grid only partly removes a proxy: in the test
 * for this file, a feature built as a near-perfect copy of the control keeps
 * about 0.41 of its spread inside terciles and 0.14 inside deciles. A retained
 * fraction near one is the interesting outcome; one near the baseline is a
 * costume.
 *
 * The rank correlation between the two features is reported alongside: a spread
 * that survives conditioning at rho = 0.02 was never in danger, and one that
 * survives at rho = 0.8 is the interesting case.
 */

export interface ControlOptions {
  dataRoot: string;
  market: Market;
  symbols: string[];
  fromSec: number;
  toSec: number;
  timeframe: DataInterval;
  horizon: number;
  /** Positioning features to test. */
  features: string[];
  /** Price features to control for. */
  controls: string[];
  buckets?: number;
  controlBuckets?: number;
  asOf?: AsOfOptions;
  /** Cross-symbol return correlation used to inflate the pooled standard error. */
  crossCorr?: number;
  onProgress?: (message: string) => void;
}

export interface ControlRow {
  feature: string;
  control: string;
  n: number;
  /** Pooled Spearman between the two features. */
  rho: number;
  spreadBps: number;
  spreadZ: number;
  /** Quintile spread computed inside quantile slices of the control, then pooled. */
  conditionalSpreadBps: number;
  conditionalSpreadZ: number;
  conditionalP: number;
  /** Share of the unconditional spread that survives conditioning. */
  retained: number;
  /** The control's own quintile spread, for scale. */
  controlSpreadBps: number;
  controlSpreadZ: number;
}

export interface ControlResult {
  timeframe: DataInterval;
  horizon: number;
  symbols: string[];
  rows: ControlRow[];
}

interface Aligned3 {
  x: Float64Array;
  c: Float64Array;
  y: Float64Array;
  index: Int32Array;
}

/** Keeps only the positions where the feature, the control and the target all exist. */
export function alignTriple(feature: Series, control: Series, forward: Float64Array): Aligned3 {
  const n = Math.min(feature.length, control.length, forward.length);
  let count = 0;
  for (let i = 0; i < n; i++) {
    const f = feature[i];
    const c = control[i];
    if (f === null || c === null || !Number.isFinite(f) || !Number.isFinite(c) || !Number.isFinite(forward[i])) continue;
    count++;
  }
  const x = new Float64Array(count);
  const c = new Float64Array(count);
  const y = new Float64Array(count);
  const index = new Int32Array(count);
  let at = 0;
  for (let i = 0; i < n; i++) {
    const f = feature[i];
    const g = control[i];
    if (f === null || g === null || !Number.isFinite(f) || !Number.isFinite(g) || !Number.isFinite(forward[i])) continue;
    x[at] = f;
    c[at] = g;
    y[at] = forward[i];
    index[at] = i;
    at++;
  }
  return { x, c, y, index };
}

function asPairs(x: Float64Array, y: Float64Array, index: Int32Array): AlignedPairs {
  return { x, y, index };
}

/**
 * Quantile spread of `x` against `y`, computed inside slices of `c` and pooled.
 *
 * The slices are disjoint samples, so their standard errors add; the pooling is
 * equal-weight for the same reason the screener pools symbols equal-weight —
 * the slice with the most rows should not decide the answer.
 */
export function conditionalSpread(
  tri: Aligned3,
  buckets: number,
  controlBuckets: number,
  horizon: number,
  minPerSlice = 500,
): { spreadBps: number; seBps: number; slices: number } {
  const slice = quantileBucketIndex(tri.c, controlBuckets);
  const parts: number[] = [];
  const partSes: number[] = [];
  for (let t = 0; t < controlBuckets; t++) {
    let count = 0;
    for (let i = 0; i < slice.length; i++) if (slice[i] === t) count++;
    if (count < minPerSlice) continue;
    const sx = new Float64Array(count);
    const sy = new Float64Array(count);
    const si = new Int32Array(count);
    let at = 0;
    for (let i = 0; i < slice.length; i++) {
      if (slice[i] !== t) continue;
      sx[at] = tri.x[i];
      sy[at] = tri.y[i];
      si[at] = tri.index[i];
      at++;
    }
    const p = bucketProfile(asPairs(sx, sy, si), buckets, horizon);
    if (!Number.isFinite(p.spreadBps) || !(p.spreadSeBps > 0)) continue;
    parts.push(p.spreadBps);
    partSes.push(p.spreadSeBps);
  }
  if (parts.length === 0) return { spreadBps: Number.NaN, seBps: Number.NaN, slices: 0 };
  const pooled = pool(parts, partSes, 0);
  return { spreadBps: pooled.mean, seBps: pooled.se, slices: parts.length };
}

/** Equal-weight pooling with the same variance inflation the screener uses. */
function pool(values: number[], ses: number[], rho: number): { mean: number; se: number } {
  const k = values.length;
  if (k === 0) return { mean: Number.NaN, se: Number.NaN };
  let sum = 0;
  for (const v of values) sum += v;
  let variance = 0;
  for (let i = 0; i < k; i++) {
    for (let j = 0; j < k; j++) variance += i === j ? ses[i] * ses[i] : rho * ses[i] * ses[j];
  }
  return { mean: sum / k, se: Math.sqrt(Math.max(variance, 0)) / k };
}

export function runPositioningControl(opts: ControlOptions): ControlResult {
  const say = opts.onProgress ?? ((): void => {});
  const buckets = opts.buckets ?? 5;
  const controlBuckets = opts.controlBuckets ?? 5;
  const rho = Math.max(0, opts.crossCorr ?? 0);
  const symbols = opts.symbols.map(normalizeSymbol);
  const tf = opts.timeframe;
  const sec = intervalSeconds(tf);
  const store = createMetricsStore(opts.dataRoot);
  const priceSpecs = new Map(featureCatalog().map((s) => [s.name, s]));

  interface Acc {
    n: number;
    rho: number[];
    spread: number[];
    spreadSe: number[];
    cond: number[];
    condSe: number[];
    ctrl: number[];
    ctrlSe: number[];
  }
  const acc = new Map<string, Acc>();
  const get = (key: string): Acc => {
    const a = acc.get(key) ?? { n: 0, rho: [], spread: [], spreadSe: [], cond: [], condSe: [], ctrl: [], ctrlSe: [] };
    acc.set(key, a);
    return a;
  };

  for (const symbol of symbols) {
    say(`control: ${symbol}`);
    const rows = store.readRange(symbol, opts.fromSec, opts.toSec);
    const set = buildPositioningSeries(rows);
    const posSpecs = new Map(positioningFeatureSpecs(set, opts.asOf).map((s) => [s.name, s]));
    const frames = loadFrames(opts.dataRoot, opts.market, symbol, opts.fromSec, opts.toSec, [tf]);
    const bars = frames.bars.get(tf) ?? [];
    if (bars.length < 500) continue;
    const fwd = forwardReturns(bars, opts.horizon, sec);

    const posCache = new Map<string, Series>();
    for (const name of opts.features) {
      const spec = posSpecs.get(name);
      if (spec) posCache.set(name, spec.compute(bars));
    }
    const ctrlCache = new Map<string, Series>();
    for (const name of opts.controls) {
      const spec = priceSpecs.get(name);
      if (spec) ctrlCache.set(name, spec.compute(bars));
    }

    for (const feature of opts.features) {
      const fSeries = posCache.get(feature);
      if (!fSeries) continue;
      for (const control of opts.controls) {
        const cSeries = ctrlCache.get(control);
        if (!cSeries) continue;
        const tri = alignTriple(fSeries, cSeries, fwd);
        if (tri.x.length < 1000) continue;

        const a = get(`${feature}|${control}`);
        a.n += tri.x.length;
        a.rho.push(spearman(tri.x, tri.c));

        const uncond = bucketProfile(asPairs(tri.x, tri.y, tri.index), buckets, opts.horizon);
        if (Number.isFinite(uncond.spreadBps) && uncond.spreadSeBps > 0) {
          a.spread.push(uncond.spreadBps);
          a.spreadSe.push(uncond.spreadSeBps);
        }

        const ctrlProfile = bucketProfile(asPairs(tri.c, tri.y, tri.index), buckets, opts.horizon);
        if (Number.isFinite(ctrlProfile.spreadBps) && ctrlProfile.spreadSeBps > 0) {
          a.ctrl.push(ctrlProfile.spreadBps);
          a.ctrlSe.push(ctrlProfile.spreadSeBps);
        }

        // Inside a slice of the control the control barely moves, so whatever
        // the quintile spread still finds is mostly not the control.
        const cond = conditionalSpread(tri, buckets, controlBuckets, opts.horizon);
        if (Number.isFinite(cond.spreadBps) && cond.seBps > 0) {
          a.cond.push(cond.spreadBps);
          a.condSe.push(cond.seBps);
        }
      }
    }
    frames.bars.set(tf, []);
  }

  const out: ControlRow[] = [];
  for (const [key, a] of acc) {
    const [feature, control] = key.split("|");
    const spread = pool(a.spread, a.spreadSe, rho);
    const cond = pool(a.cond, a.condSe, rho);
    const ctrl = pool(a.ctrl, a.ctrlSe, rho);
    const rhoMean = a.rho.length > 0 ? a.rho.reduce((s, v) => s + v, 0) / a.rho.length : Number.NaN;
    const condZ = cond.mean / cond.se;
    out.push({
      feature,
      control,
      n: a.n,
      rho: rhoMean,
      spreadBps: spread.mean,
      spreadZ: spread.mean / spread.se,
      conditionalSpreadBps: cond.mean,
      conditionalSpreadZ: condZ,
      conditionalP: twoSidedP(condZ),
      retained: Math.abs(spread.mean) > 0 ? cond.mean / spread.mean : Number.NaN,
      controlSpreadBps: ctrl.mean,
      controlSpreadZ: ctrl.mean / ctrl.se,
    });
  }
  out.sort((x, y) => Math.abs(y.conditionalSpreadZ) - Math.abs(x.conditionalSpreadZ));

  return { timeframe: tf, horizon: opts.horizon, symbols, rows: out };
}
