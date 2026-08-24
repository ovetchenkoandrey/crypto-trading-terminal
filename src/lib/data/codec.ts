import type { Candle } from "../types.ts";

/**
 * Fixed-width binary encoding for candles: six little-endian float64 fields per
 * record — time (UTC seconds), open, high, low, close, volume.
 *
 * Float64 for the timestamp costs nothing (records stay 8-byte aligned) and is
 * exact for integers up to 2^53, which covers UTC seconds for the next quarter
 * million years. The point of a fixed stride is that a month file is a plain
 * array: appending is a write at the end, the record count is `size / 48`, and
 * a truncated file is detectable by a size that is not a multiple of the stride.
 */

export const FIELDS = 6;
export const RECORD_SIZE = FIELDS * 8;

export function encodeCandles(candles: readonly Candle[]): Buffer {
  const buf = Buffer.allocUnsafe(candles.length * RECORD_SIZE);
  let off = 0;
  for (const c of candles) {
    buf.writeDoubleLE(c.time, off);
    buf.writeDoubleLE(c.open, off + 8);
    buf.writeDoubleLE(c.high, off + 16);
    buf.writeDoubleLE(c.low, off + 24);
    buf.writeDoubleLE(c.close, off + 32);
    buf.writeDoubleLE(c.volume, off + 40);
    off += RECORD_SIZE;
  }
  return buf;
}

export function recordCount(byteLength: number): number {
  return Math.floor(byteLength / RECORD_SIZE);
}

export function isWholeRecords(byteLength: number): boolean {
  return byteLength % RECORD_SIZE === 0;
}

export function decodeCandles(buf: Buffer): Candle[] {
  const n = recordCount(buf.length);
  const out: Candle[] = new Array(n);
  let off = 0;
  for (let i = 0; i < n; i++) {
    out[i] = {
      time: buf.readDoubleLE(off),
      open: buf.readDoubleLE(off + 8),
      high: buf.readDoubleLE(off + 16),
      low: buf.readDoubleLE(off + 24),
      close: buf.readDoubleLE(off + 32),
      volume: buf.readDoubleLE(off + 40),
    };
    off += RECORD_SIZE;
  }
  return out;
}

/** Timestamp of record `i` without materialising the whole file. */
export function readTimeAt(buf: Buffer, index: number): number {
  return buf.readDoubleLE(index * RECORD_SIZE);
}

/**
 * Index of the first record with `time >= target`, or `recordCount` when every
 * record is older. Records are stored sorted, so this is a plain binary search.
 */
export function lowerBound(buf: Buffer, target: number): number {
  let lo = 0;
  let hi = recordCount(buf.length);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (readTimeAt(buf, mid) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Decodes only the records inside [fromSec, toSec] (both inclusive). */
export function decodeRange(buf: Buffer, fromSec: number, toSec: number): Candle[] {
  const start = lowerBound(buf, fromSec);
  const end = lowerBound(buf, toSec + 1);
  if (end <= start) return [];
  return decodeCandles(buf.subarray(start * RECORD_SIZE, end * RECORD_SIZE));
}
