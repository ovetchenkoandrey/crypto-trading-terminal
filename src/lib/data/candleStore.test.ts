import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Candle } from "../types.ts";
import { createCandleStore, normalizeSpans, type CandleStore } from "./candleStore.ts";
import { RECORD_SIZE } from "./codec.ts";
import { monthStartSec } from "./months.ts";
import { monthDataFile, monthMetaFile, type DatasetKey } from "./paths.ts";

const KEY: DatasetKey = { market: "linear", symbol: "BTCUSDT", interval: "1m" };

function series(month: string, count: number, offsetBars = 0, price = 100): Candle[] {
  const start = monthStartSec(month) + offsetBars * 60;
  return Array.from({ length: count }, (_, i) => ({
    time: start + i * 60,
    open: price + i,
    high: price + i + 1,
    low: price + i - 1,
    close: price + i + 0.5,
    volume: 1 + i,
  }));
}

let root: string;
let store: CandleStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "candle-store-"));
  store = createCandleStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("candleStore write and read", () => {
  it("round-trips a month and records its span", () => {
    const candles = series("2025-03", 100);
    const meta = store.writeMonth(KEY, "2025-03", candles, { source: "binance-archive", complete: true });
    expect(meta.count).toBe(100);
    expect(meta.bytes).toBe(100 * RECORD_SIZE);
    expect(meta.firstTime).toBe(candles[0].time);
    expect(meta.lastTime).toBe(candles[99].time);
    expect(meta.sources).toEqual(["binance-archive"]);
    expect(meta.sourceSpans).toEqual([{ source: "binance-archive", from: candles[0].time, to: candles[99].time }]);
    expect(store.readMonth(KEY, "2025-03")).toEqual(candles);
    expect(store.listMonths(KEY)).toEqual(["2025-03"]);
  });

  it("sorts and dedupes on write", () => {
    const a = series("2025-03", 3);
    const shuffled = [a[2], a[0], a[1], { ...a[1], close: 999 }];
    const meta = store.writeMonth(KEY, "2025-03", shuffled, { source: "bybit-rest" });
    expect(meta.count).toBe(3);
    const read = store.readMonth(KEY, "2025-03");
    expect(read.map((c) => c.time)).toEqual([a[0].time, a[1].time, a[2].time]);
    expect(read[1].close).toBe(999);
  });

  it("reads a range spanning several months", () => {
    store.writeMonth(KEY, "2025-01", series("2025-01", 44640), { source: "binance-archive", complete: true });
    store.writeMonth(KEY, "2025-02", series("2025-02", 40320), { source: "binance-archive", complete: true });
    const from = monthStartSec("2025-01") + 44639 * 60;
    const to = monthStartSec("2025-02") + 60;
    const slice = store.readRange(KEY, from, to);
    expect(slice.map((c) => c.time)).toEqual([from, monthStartSec("2025-02"), monthStartSec("2025-02") + 60]);
  });

  it("returns nothing for an empty or inverted range", () => {
    store.writeMonth(KEY, "2025-03", series("2025-03", 10), { source: "binance-archive" });
    expect(store.readRange(KEY, 100, 50)).toEqual([]);
    expect(store.readRange(KEY, 0, 1)).toEqual([]);
    expect(store.readMonth(KEY, "2025-04")).toEqual([]);
    expect(store.listMonths({ ...KEY, symbol: "ETHUSDT" })).toEqual([]);
  });

  it("reports dataset-wide stats", () => {
    store.writeMonth(KEY, "2025-01", series("2025-01", 10), { source: "binance-archive" });
    store.writeMonth(KEY, "2025-02", series("2025-02", 20), { source: "bybit-rest" });
    const stats = store.stats(KEY);
    expect(stats).toMatchObject({ months: 2, candles: 30, bytes: 30 * RECORD_SIZE });
    expect(stats.sources).toEqual(["binance-archive", "bybit-rest"]);
    expect(stats.firstTime).toBe(monthStartSec("2025-01"));
  });
});

describe("candleStore append", () => {
  it("appends newer bars without rewriting the file", () => {
    const first = series("2025-03", 10);
    store.writeMonth(KEY, "2025-03", first, { source: "binance-archive" });
    const file = monthDataFile(root, KEY, "2025-03");
    const before = fs.readFileSync(file);

    const next = series("2025-03", 5, 10);
    const meta = store.appendMonth(KEY, "2025-03", next, { source: "bybit-rest" });

    expect(meta.count).toBe(15);
    const after = fs.readFileSync(file);
    expect(after.subarray(0, before.length).equals(before)).toBe(true);
    expect(store.readMonth(KEY, "2025-03")).toEqual([...first, ...next]);
    expect(meta.sources).toEqual(["binance-archive", "bybit-rest"]);
    expect(meta.sourceSpans).toEqual([
      { source: "binance-archive", from: first[0].time, to: first[9].time },
      { source: "bybit-rest", from: next[0].time, to: next[4].time },
    ]);
  });

  it("falls back to a merge when the incoming bars overlap", () => {
    const first = series("2025-03", 10);
    store.writeMonth(KEY, "2025-03", first, { source: "binance-archive" });
    const overlapping = series("2025-03", 5, 8, 500);
    const meta = store.appendMonth(KEY, "2025-03", overlapping, { source: "bybit-rest" });

    expect(meta.count).toBe(13);
    const read = store.readMonth(KEY, "2025-03");
    expect(read).toHaveLength(13);
    expect(read[8].close).toBe(overlapping[0].close);
    expect(read[7].close).toBe(first[7].close);
  });

  it("creates the month when appending to nothing", () => {
    const meta = store.appendMonth(KEY, "2025-03", series("2025-03", 4), { source: "bybit-rest" });
    expect(meta.count).toBe(4);
    expect(meta.sources).toEqual(["bybit-rest"]);
  });

  it("keeps the stored month untouched when the append is empty", () => {
    store.writeMonth(KEY, "2025-03", series("2025-03", 4), { source: "binance-archive" });
    const meta = store.appendMonth(KEY, "2025-03", [], { source: "bybit-rest" });
    expect(meta.count).toBe(4);
    expect(meta.sources).toEqual(["binance-archive"]);
  });

  it("flips the complete flag without touching the data", () => {
    store.writeMonth(KEY, "2025-03", series("2025-03", 4), { source: "binance-archive" });
    const bytes = fs.readFileSync(monthDataFile(root, KEY, "2025-03"));
    const meta = store.setComplete(KEY, "2025-03", true);
    expect(meta?.complete).toBe(true);
    expect(fs.readFileSync(monthDataFile(root, KEY, "2025-03")).equals(bytes)).toBe(true);
    expect(store.setComplete(KEY, "2025-04", true)).toBeNull();
  });
});

describe("candleStore integrity", () => {
  it("reports a missing month", () => {
    expect(store.inspectMonth(KEY, "2025-03")).toMatchObject({ state: "missing", meta: null });
    expect(store.readMeta(KEY, "2025-03")).toBeNull();
  });

  it("treats a month without a sidecar as unusable", () => {
    store.writeMonth(KEY, "2025-03", series("2025-03", 10), { source: "binance-archive" });
    fs.rmSync(monthMetaFile(root, KEY, "2025-03"));
    expect(store.inspectMonth(KEY, "2025-03").state).toBe("no-meta");
    expect(store.readMonth(KEY, "2025-03")).toEqual([]);
    expect(store.readRange(KEY, 0, 9_999_999_999)).toEqual([]);
  });

  it("ignores a sidecar written by an older format version", () => {
    store.writeMonth(KEY, "2025-03", series("2025-03", 10), { source: "binance-archive" });
    const file = monthMetaFile(root, KEY, "2025-03");
    const meta = JSON.parse(fs.readFileSync(file, "utf8"));
    fs.writeFileSync(file, JSON.stringify({ ...meta, version: 0 }));
    expect(store.inspectMonth(KEY, "2025-03").state).toBe("no-meta");
  });

  it("detects and repairs bytes written past the committed end", () => {
    const candles = series("2025-03", 10);
    store.writeMonth(KEY, "2025-03", candles, { source: "binance-archive" });
    fs.appendFileSync(monthDataFile(root, KEY, "2025-03"), Buffer.alloc(RECORD_SIZE * 2));

    const status = store.inspectMonth(KEY, "2025-03");
    expect(status.state).toBe("trailing");
    expect(store.readMonth(KEY, "2025-03")).toEqual(candles);

    expect(store.repairMonth(KEY, "2025-03").state).toBe("ok");
    expect(fs.statSync(monthDataFile(root, KEY, "2025-03")).size).toBe(10 * RECORD_SIZE);
  });

  it("appends over uncommitted bytes rather than after them", () => {
    const first = series("2025-03", 10);
    store.writeMonth(KEY, "2025-03", first, { source: "binance-archive" });
    fs.appendFileSync(monthDataFile(root, KEY, "2025-03"), Buffer.alloc(RECORD_SIZE));

    const next = series("2025-03", 3, 10);
    const meta = store.appendMonth(KEY, "2025-03", next, { source: "bybit-rest" });
    expect(meta.count).toBe(13);
    expect(store.readMonth(KEY, "2025-03")).toEqual([...first, ...next]);
  });

  it("flags a month shorter than its sidecar claims", () => {
    store.writeMonth(KEY, "2025-03", series("2025-03", 10), { source: "binance-archive" });
    fs.truncateSync(monthDataFile(root, KEY, "2025-03"), 5 * RECORD_SIZE);
    expect(store.inspectMonth(KEY, "2025-03").state).toBe("truncated");
    expect(store.readMonth(KEY, "2025-03")).toEqual([]);
  });

  it("removes a month entirely", () => {
    store.writeMonth(KEY, "2025-03", series("2025-03", 10), { source: "binance-archive" });
    store.removeMonth(KEY, "2025-03");
    expect(store.listMonths(KEY)).toEqual([]);
    expect(() => store.removeMonth(KEY, "2025-03")).not.toThrow();
  });

  it("keeps datasets with different intervals apart", () => {
    store.writeMonth(KEY, "2025-03", series("2025-03", 10), { source: "binance-archive" });
    const hourly: DatasetKey = { ...KEY, interval: "1h" };
    expect(store.listMonths(hourly)).toEqual([]);
    store.writeMonth(hourly, "2025-03", series("2025-03", 5), { source: "binance-archive" });
    expect(store.readMonth(KEY, "2025-03")).toHaveLength(10);
    expect(store.readMonth(hourly, "2025-03")).toHaveLength(5);
  });
});

describe("normalizeSpans", () => {
  it("folds consecutive spans of the same source", () => {
    expect(
      normalizeSpans([
        { source: "binance-archive", from: 0, to: 10 },
        { source: "binance-archive", from: 11, to: 20 },
        { source: "bybit-rest", from: 21, to: 30 },
      ]),
    ).toEqual([
      { source: "binance-archive", from: 0, to: 20 },
      { source: "bybit-rest", from: 21, to: 30 },
    ]);
  });

  it("drops nonsense spans", () => {
    expect(normalizeSpans([{ source: "bybit-rest", from: 30, to: 10 }])).toEqual([]);
  });
});
