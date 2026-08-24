import { describe, expect, it } from "vitest";
import type { Candle } from "../types.ts";
import { RECORD_SIZE, decodeCandles, decodeRange, encodeCandles, isWholeRecords, lowerBound, readTimeAt, recordCount } from "./codec.ts";

function series(count: number, start = 1_700_000_000, step = 60): Candle[] {
  return Array.from({ length: count }, (_, i) => ({
    time: start + i * step,
    open: 100 + i,
    high: 101 + i,
    low: 99 + i,
    close: 100.5 + i,
    volume: i * 0.25,
  }));
}

describe("codec", () => {
  it("round-trips candles byte for byte", () => {
    const candles = series(5);
    const buf = encodeCandles(candles);
    expect(buf.length).toBe(5 * RECORD_SIZE);
    expect(decodeCandles(buf)).toEqual(candles);
  });

  it("keeps fractional prices and volumes exact", () => {
    const candles: Candle[] = [{ time: 1_700_000_000, open: 0.000012345, high: 77123.456789, low: 0.1, close: 1 / 3, volume: 1e-9 }];
    expect(decodeCandles(encodeCandles(candles))).toEqual(candles);
  });

  it("encodes an empty series as an empty buffer", () => {
    expect(encodeCandles([]).length).toBe(0);
    expect(decodeCandles(Buffer.alloc(0))).toEqual([]);
  });

  it("detects a truncated file by its length", () => {
    expect(isWholeRecords(RECORD_SIZE * 3)).toBe(true);
    expect(isWholeRecords(RECORD_SIZE * 3 + 7)).toBe(false);
    expect(recordCount(RECORD_SIZE * 3 + 7)).toBe(3);
  });

  it("binary-searches timestamps without decoding", () => {
    const buf = encodeCandles(series(100));
    expect(readTimeAt(buf, 0)).toBe(1_700_000_000);
    expect(readTimeAt(buf, 99)).toBe(1_700_000_000 + 99 * 60);
    expect(lowerBound(buf, 1_700_000_000)).toBe(0);
    expect(lowerBound(buf, 1_700_000_000 + 60 * 50)).toBe(50);
    expect(lowerBound(buf, 1_700_000_000 + 60 * 50 - 1)).toBe(50);
    expect(lowerBound(buf, 0)).toBe(0);
    expect(lowerBound(buf, 9_999_999_999)).toBe(100);
  });

  it("decodes only the requested slice", () => {
    const candles = series(100);
    const buf = encodeCandles(candles);
    const from = candles[10].time;
    const to = candles[19].time;
    const slice = decodeRange(buf, from, to);
    expect(slice).toHaveLength(10);
    expect(slice[0]).toEqual(candles[10]);
    expect(slice[9]).toEqual(candles[19]);
    expect(decodeRange(buf, to + 1, from - 1)).toEqual([]);
    expect(decodeRange(buf, 0, 1)).toEqual([]);
  });
});
