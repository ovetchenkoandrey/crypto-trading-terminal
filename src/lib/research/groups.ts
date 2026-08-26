import { mean, median, quantileSorted, variance, welchTest } from "./descriptive.ts";
import { twoSidedP } from "./distributions.ts";

/**
 * Slicing a return series by a calendar key — hour of day, weekday, day of
 * month — and testing each slice both against zero and against everything else.
 *
 * Two comparisons, because they answer different questions. "Is this hour's
 * mean return non-zero" is what a strategy trading only that hour needs. "Is
 * this hour different from the others" is what a claim like *the night is a
 * different regime* actually asserts, and it is the harder bar to clear.
 */

export interface GroupStat {
  key: number;
  label: string;
  n: number;
  /** Mean signed return, basis points. */
  meanBps: number;
  seBps: number;
  /** t of mean vs zero. */
  t: number;
  p: number;
  ciLowBps: number;
  ciHighBps: number;
  /** Standard deviation of returns in the group, basis points. */
  stdevBps: number;
  meanAbsBps: number;
  medianAbsBps: number;
  /** Mean of an optional companion series — volume, range, whatever. */
  auxMean: Record<string, number>;
  /** Mean minus the mean of every other group, basis points. */
  diffVsRestBps: number;
  tVsRest: number;
  pVsRest: number;
  /** Group stdev divided by the stdev of the rest. 1.0 = same volatility. */
  volRatioVsRest: number;
  /** Levene-style test of that ratio: spread of |r - median| vs the rest. */
  tVolVsRest: number;
  pVolVsRest: number;
}

export interface GroupSpec {
  key: number;
  label: string;
}

function gather(indices: number[], src: ArrayLike<number>): Float64Array {
  const out = new Float64Array(indices.length);
  for (let i = 0; i < indices.length; i++) out[i] = src[indices[i]];
  return out;
}

/**
 * @param keys   group key per observation, parallel to `values`
 * @param values signed returns as fractions (0.0001 = 1 bp)
 * @param specs  which keys to report and how to label them
 * @param aux    extra parallel series to average per group
 */
export function groupProfile(
  keys: ArrayLike<number>,
  values: ArrayLike<number>,
  specs: readonly GroupSpec[],
  aux: Record<string, ArrayLike<number>> = {},
  z95 = 1.959963985,
): GroupStat[] {
  const buckets = new Map<number, number[]>();
  for (const s of specs) buckets.set(s.key, []);
  for (let i = 0; i < values.length; i++) {
    const list = buckets.get(keys[i]);
    if (list) list.push(i);
  }

  return specs.map((spec) => {
    const idx = buckets.get(spec.key) ?? [];
    const inside = gather(idx, values);
    const outsideIdx: number[] = [];
    for (let i = 0; i < values.length; i++) if (keys[i] !== spec.key) outsideIdx.push(i);
    const outside = gather(outsideIdx, values);

    const m = mean(inside);
    const v = variance(inside, m);
    const sd = Math.sqrt(v);
    const se = sd / Math.sqrt(inside.length);
    const t = m / se;

    const absInside = new Float64Array(inside.length);
    for (let i = 0; i < inside.length; i++) absInside[i] = Math.abs(inside[i]);
    const sortedAbs = Float64Array.from(absInside);
    sortedAbs.sort();

    const rest = welchTest(inside, outside);
    const sdOut = Math.sqrt(variance(outside));

    const medIn = median(inside);
    const medOut = median(outside);
    const devIn = new Float64Array(inside.length);
    for (let i = 0; i < inside.length; i++) devIn[i] = Math.abs(inside[i] - medIn);
    const devOut = new Float64Array(outside.length);
    for (let i = 0; i < outside.length; i++) devOut[i] = Math.abs(outside[i] - medOut);
    const levene = welchTest(devIn, devOut);

    const auxMean: Record<string, number> = {};
    for (const [name, series] of Object.entries(aux)) auxMean[name] = mean(gather(idx, series));

    return {
      key: spec.key,
      label: spec.label,
      n: inside.length,
      meanBps: m * 1e4,
      seBps: se * 1e4,
      t,
      p: twoSidedP(t),
      ciLowBps: (m - z95 * se) * 1e4,
      ciHighBps: (m + z95 * se) * 1e4,
      stdevBps: sd * 1e4,
      meanAbsBps: mean(absInside) * 1e4,
      medianAbsBps: quantileSorted(sortedAbs, 0.5) * 1e4,
      auxMean,
      diffVsRestBps: rest.diff * 1e4,
      tVsRest: rest.t,
      pVsRest: twoSidedP(rest.t),
      volRatioVsRest: sd / sdOut,
      tVolVsRest: levene.t,
      pVolVsRest: twoSidedP(levene.t),
    };
  });
}

/** 0..23, labelled as the UTC hour they cover. */
export function hourSpecs(): GroupSpec[] {
  return Array.from({ length: 24 }, (_, h) => ({ key: h, label: `${String(h).padStart(2, "0")}:00` }));
}

const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function weekdaySpecs(): GroupSpec[] {
  return WEEKDAY_NAMES.map((label, key) => ({ key, label }));
}
