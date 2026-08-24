import type { Candle } from "../types.ts";

/** Inclusive time range in UTC seconds. */
export interface TimeRange {
  from: number;
  to: number;
}

function valid(r: TimeRange): boolean {
  return Number.isFinite(r.from) && Number.isFinite(r.to) && r.to >= r.from;
}

/**
 * Sorts and merges ranges. Two ranges are merged when they overlap or when they
 * are adjacent on the bar grid — `step` is the interval in seconds, so
 * [0..59] and [60..119] on 1m data collapse into [0..119]. Pass `step = 0` to
 * merge only genuinely overlapping ranges.
 */
export function normalizeRanges(ranges: readonly TimeRange[], step = 0): TimeRange[] {
  const sorted = ranges.filter(valid).slice().sort((a, b) => a.from - b.from || a.to - b.to);
  const out: TimeRange[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && r.from <= last.to + step) {
      if (r.to > last.to) last.to = r.to;
    } else {
      out.push({ from: r.from, to: r.to });
    }
  }
  return out;
}

/** Everything in `base` that is not covered by `holes`. */
export function subtractRanges(base: TimeRange, holes: readonly TimeRange[], step = 0): TimeRange[] {
  if (!valid(base)) return [];
  const blocked = normalizeRanges(holes, step);
  const out: TimeRange[] = [];
  let cursor = base.from;
  for (const h of blocked) {
    if (h.to < cursor) continue;
    if (h.from > base.to) break;
    if (h.from > cursor) out.push({ from: cursor, to: Math.min(h.from - 1, base.to) });
    cursor = Math.max(cursor, h.to + 1);
    if (cursor > base.to) break;
  }
  if (cursor <= base.to) out.push({ from: cursor, to: base.to });
  return out.filter(valid);
}

export function intersectRanges(a: readonly TimeRange[], b: readonly TimeRange[]): TimeRange[] {
  const left = normalizeRanges(a);
  const right = normalizeRanges(b);
  const out: TimeRange[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const from = Math.max(left[i].from, right[j].from);
    const to = Math.min(left[i].to, right[j].to);
    if (to >= from) out.push({ from, to });
    if (left[i].to < right[j].to) i++;
    else j++;
  }
  return out;
}

/**
 * Contiguous runs covered by the given candles. A run breaks wherever the step
 * between neighbouring bars is larger than `intervalSec`, so the result is
 * exactly "what we actually hold", holes excluded.
 */
export function rangesFromCandles(candles: readonly Candle[], intervalSec: number): TimeRange[] {
  if (candles.length === 0 || intervalSec <= 0) return [];
  const out: TimeRange[] = [];
  let start = candles[0].time;
  let prev = candles[0].time;
  for (let i = 1; i < candles.length; i++) {
    const t = candles[i].time;
    if (t === prev) continue;
    if (t - prev !== intervalSec) {
      out.push({ from: start, to: prev + intervalSec - 1 });
      start = t;
    }
    prev = t;
  }
  out.push({ from: start, to: prev + intervalSec - 1 });
  return out;
}

export function totalBars(ranges: readonly TimeRange[], intervalSec: number): number {
  if (intervalSec <= 0) return 0;
  let sum = 0;
  for (const r of normalizeRanges(ranges)) sum += Math.floor((r.to - r.from + 1) / intervalSec);
  return sum;
}

/** Merges two ascending candle arrays; on a duplicate timestamp `b` wins. */
export function mergeCandles(a: readonly Candle[], b: readonly Candle[]): Candle[] {
  if (a.length === 0) return sortByTime(b);
  if (b.length === 0) return sortByTime(a);
  const map = new Map<number, Candle>();
  for (const c of a) map.set(c.time, c);
  for (const c of b) map.set(c.time, c);
  return Array.from(map.values()).sort((x, y) => x.time - y.time);
}

export function sortByTime(candles: readonly Candle[]): Candle[] {
  return candles.slice().sort((a, b) => a.time - b.time);
}

/** Drops duplicate timestamps, keeping the last occurrence. Input must be sorted. */
export function dedupeSorted(candles: readonly Candle[]): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const last = out[out.length - 1];
    if (last && last.time === c.time) out[out.length - 1] = c;
    else out.push(c);
  }
  return out;
}
