import { METRICS_STEP_SEC, type MetricsRow } from "../data/metricsArchive.ts";

/**
 * The positioning metrics laid out on a regular five-minute grid.
 *
 * The archive rows are already five minutes apart, but "already" is not
 * "always": days go missing, and a series read as a plain array would then have
 * a "24-hour change" that silently spans thirty hours. So the rows are placed
 * into slots by timestamp, missing slots are NaN, and every derived quantity
 * below indexes by slot. Arithmetic on indices is then arithmetic on time, and a
 * hole propagates into a NaN instead of into a wrong number.
 *
 * The grid also carries a price. `sum_open_interest_value / sum_open_interest`
 * is the mark price Binance used for the snapshot — same instant, same row, no
 * join. Every price-versus-open-interest feature uses it rather than our candle
 * closes, which removes a whole class of alignment error from the comparison
 * that matters most.
 */

export interface PositioningGrid {
  /** UTC seconds of slot i: `startSec + i * METRICS_STEP_SEC`. */
  startSec: number;
  length: number;
  openInterest: Float64Array;
  openInterestValue: Float64Array;
  topTraderAccountRatio: Float64Array;
  topTraderPositionRatio: Float64Array;
  accountRatio: Float64Array;
  takerVolumeRatio: Float64Array;
  /** openInterestValue / openInterest — the mark price of the snapshot. */
  price: Float64Array;
  /** Rows whose timestamp was not on the grid and were therefore dropped. */
  offGrid: number;
  /** Slots with no row at all. */
  missing: number;
}

export function slotTime(grid: PositioningGrid, index: number): number {
  return grid.startSec + index * METRICS_STEP_SEC;
}

function filled(n: number): Float64Array {
  return new Float64Array(n).fill(Number.NaN);
}

export function buildPositioningGrid(rows: readonly MetricsRow[]): PositioningGrid {
  const onGrid = rows.filter((r) => Number.isFinite(r.timeSec) && r.timeSec % METRICS_STEP_SEC === 0);
  const offGrid = rows.length - onGrid.length;
  if (onGrid.length === 0) {
    return {
      startSec: 0,
      length: 0,
      openInterest: filled(0),
      openInterestValue: filled(0),
      topTraderAccountRatio: filled(0),
      topTraderPositionRatio: filled(0),
      accountRatio: filled(0),
      takerVolumeRatio: filled(0),
      price: filled(0),
      offGrid,
      missing: 0,
    };
  }

  let min = Infinity;
  let max = -Infinity;
  for (const r of onGrid) {
    if (r.timeSec < min) min = r.timeSec;
    if (r.timeSec > max) max = r.timeSec;
  }
  const length = Math.round((max - min) / METRICS_STEP_SEC) + 1;

  const grid: PositioningGrid = {
    startSec: min,
    length,
    openInterest: filled(length),
    openInterestValue: filled(length),
    topTraderAccountRatio: filled(length),
    topTraderPositionRatio: filled(length),
    accountRatio: filled(length),
    takerVolumeRatio: filled(length),
    price: filled(length),
    offGrid,
    missing: 0,
  };

  let placed = 0;
  const seen = new Uint8Array(length);
  for (const r of onGrid) {
    const i = Math.round((r.timeSec - min) / METRICS_STEP_SEC);
    if (!seen[i]) {
      seen[i] = 1;
      placed++;
    }
    grid.openInterest[i] = r.openInterest;
    grid.openInterestValue[i] = r.openInterestValue;
    grid.topTraderAccountRatio[i] = r.topTraderAccountRatio;
    grid.topTraderPositionRatio[i] = r.topTraderPositionRatio;
    grid.accountRatio[i] = r.accountRatio;
    grid.takerVolumeRatio[i] = r.takerVolumeRatio;
    const oi = r.openInterest;
    const oiv = r.openInterestValue;
    grid.price[i] = oi > 0 && Number.isFinite(oiv) ? oiv / oi : Number.NaN;
  }
  grid.missing = length - placed;
  return grid;
}

/* ── causal transforms on the grid ────────────────────────────────────────── */

export function logOf(x: Float64Array): Float64Array {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = x[i] > 0 ? Math.log(x[i]) : Number.NaN;
  return out;
}

/** x[i] - x[i-k], NaN unless both slots carry a value. */
export function laggedDiff(x: Float64Array, k: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n).fill(Number.NaN);
  for (let i = k; i < n; i++) {
    const a = x[i - k];
    const b = x[i];
    if (!Number.isFinite(a) || !Number.isFinite(b)) continue;
    out[i] = b - a;
  }
  return out;
}

/**
 * Trailing mean over `window` slots ending at i, requiring `minFill` of them to
 * be present. A window mostly full of holes produces NaN rather than an average
 * of whatever survived — the point of the grid is that a gap stays a gap.
 */
export function rollingMean(x: Float64Array, window: number, minFill = 0.8): Float64Array {
  const n = x.length;
  const out = new Float64Array(n).fill(Number.NaN);
  const need = Math.max(2, Math.ceil(window * minFill));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (Number.isFinite(v)) {
      sum += v;
      count++;
    }
    const drop = i - window;
    if (drop >= 0) {
      const old = x[drop];
      if (Number.isFinite(old)) {
        sum -= old;
        count--;
      }
    }
    if (i >= window - 1 && count >= need) out[i] = sum / count;
  }
  return out;
}

export interface RollingStats {
  mean: Float64Array;
  sd: Float64Array;
}

/**
 * Trailing mean and standard deviation over `window` slots ending at i.
 *
 * The sums are accumulated around the first finite observation rather than
 * around zero. Open interest enters as a log, so the raw values sit near 11 and
 * their variance near 1e-4: computing E[x²] - E[x]² on those numbers throws away
 * five significant digits to cancellation, and the answer then depends on the
 * units the series happened to arrive in. Offsetting costs one subtraction and
 * makes the result the same whether open interest is counted in coins or in
 * thousands of coins.
 */
export function rollingMeanSd(x: Float64Array, window: number, minFill = 0.8): RollingStats {
  const n = x.length;
  const mean = new Float64Array(n).fill(Number.NaN);
  const sd = new Float64Array(n).fill(Number.NaN);
  const need = Math.max(3, Math.ceil(window * minFill));
  let offset = 0;
  for (let i = 0; i < n; i++) {
    if (Number.isFinite(x[i])) {
      offset = x[i];
      break;
    }
  }
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let i = 0; i < n; i++) {
    const v = x[i];
    if (Number.isFinite(v)) {
      const d = v - offset;
      sum += d;
      sumSq += d * d;
      count++;
    }
    const drop = i - window;
    if (drop >= 0) {
      const old = x[drop];
      if (Number.isFinite(old)) {
        const d = old - offset;
        sum -= d;
        sumSq -= d * d;
        count--;
      }
    }
    if (i >= window - 1 && count >= need) {
      const m = sum / count;
      const variance = Math.max(0, sumSq / count - m * m);
      mean[i] = offset + m;
      sd[i] = Math.sqrt(variance);
    }
  }
  return { mean, sd };
}

/** (x[i] - trailing mean) / trailing sd, over a window ending at i. */
export function rollingZ(x: Float64Array, window: number, minFill = 0.8): Float64Array {
  const { mean, sd } = rollingMeanSd(x, window, minFill);
  const out = new Float64Array(x.length).fill(Number.NaN);
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i]) || !Number.isFinite(mean[i]) || !(sd[i] > 0)) continue;
    out[i] = (x[i] - mean[i]) / sd[i];
  }
  return out;
}

/** x[i] divided by the trailing standard deviation of x, mean not removed. */
export function scaleBySd(x: Float64Array, window: number, minFill = 0.8): Float64Array {
  const { sd } = rollingMeanSd(x, window, minFill);
  const out = new Float64Array(x.length).fill(Number.NaN);
  for (let i = 0; i < x.length; i++) {
    if (!Number.isFinite(x[i]) || !(sd[i] > 0)) continue;
    out[i] = x[i] / sd[i];
  }
  return out;
}

/** Largest value of x over the `window` slots ending at i; NaN if all are NaN. */
export function rollingMax(x: Float64Array, window: number): Float64Array {
  const n = x.length;
  const out = new Float64Array(n).fill(Number.NaN);
  for (let i = window - 1; i < n; i++) {
    let best = Number.NaN;
    for (let j = i - window + 1; j <= i; j++) {
      const v = x[j];
      if (!Number.isFinite(v)) continue;
      if (!Number.isFinite(best) || v > best) best = v;
    }
    out[i] = best;
  }
  return out;
}

export function negate(x: Float64Array): Float64Array {
  const out = new Float64Array(x.length);
  for (let i = 0; i < x.length; i++) out[i] = -x[i];
  return out;
}

export function multiply(a: Float64Array, b: Float64Array): Float64Array {
  const n = Math.min(a.length, b.length);
  const out = new Float64Array(n).fill(Number.NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    out[i] = a[i] * b[i];
  }
  return out;
}

export function subtract(a: Float64Array, b: Float64Array): Float64Array {
  const n = Math.min(a.length, b.length);
  const out = new Float64Array(n).fill(Number.NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    out[i] = a[i] - b[i];
  }
  return out;
}

/** sign(a) * max(0, side * b); the building block of the direction features. */
export function directional(a: Float64Array, b: Float64Array, side: 1 | -1, flip: 1 | -1): Float64Array {
  const n = Math.min(a.length, b.length);
  const out = new Float64Array(n).fill(Number.NaN);
  for (let i = 0; i < n; i++) {
    if (!Number.isFinite(a[i]) || !Number.isFinite(b[i])) continue;
    out[i] = flip * Math.sign(a[i]) * Math.max(0, side * b[i]);
  }
  return out;
}
