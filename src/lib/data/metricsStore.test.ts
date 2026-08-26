import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MetricsRow } from "./metricsArchive.ts";
import {
  RECORD_SIZE,
  createMetricsStore,
  decodeMetrics,
  dedupeRows,
  encodeMetrics,
  metricsMonthDataFile,
  metricsMonthMetaFile,
} from "./metricsStore.ts";

function row(timeSec: number, oi = 100): MetricsRow {
  return {
    timeSec,
    openInterest: oi,
    openInterestValue: oi * 1000,
    topTraderAccountRatio: 2,
    topTraderPositionRatio: 1.5,
    accountRatio: 2.3,
    takerVolumeRatio: 0.9,
  };
}

const JUNE = Date.UTC(2024, 5, 1) / 1000;

let root = "";

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "metrics-store-"));
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("codec", () => {
  it("round-trips every column", () => {
    const rows = [row(JUNE, 1), row(JUNE + 300, 2)];
    rows[1].takerVolumeRatio = Number.NaN;
    const decoded = decodeMetrics(encodeMetrics(rows));
    expect(decoded[0]).toEqual(rows[0]);
    expect(decoded[1].openInterest).toBe(2);
    expect(Number.isNaN(decoded[1].takerVolumeRatio)).toBe(true);
  });

  it("uses a fixed stride so a month is a plain array", () => {
    expect(encodeMetrics([row(JUNE)]).length).toBe(RECORD_SIZE);
    expect(encodeMetrics([row(JUNE), row(JUNE + 300)]).length).toBe(2 * RECORD_SIZE);
  });
});

describe("dedupeRows", () => {
  it("sorts and collapses repeated timestamps, keeping the last", () => {
    const out = dedupeRows([row(JUNE + 300, 2), row(JUNE, 1), row(JUNE, 9)]);
    expect(out.map((r) => r.timeSec)).toEqual([JUNE, JUNE + 300]);
    expect(out[0].openInterest).toBe(9);
  });
});

describe("createMetricsStore", () => {
  it("writes, lists and reads a month back", () => {
    const store = createMetricsStore(root);
    const rows = [row(JUNE), row(JUNE + 300), row(JUNE + 600)];
    const meta = store.mergeMonth("btcusdt", "2024-06", rows);

    expect(meta.symbol).toBe("BTCUSDT");
    expect(meta.count).toBe(3);
    expect(meta.days).toEqual(["2024-06-01"]);
    expect(store.listMonths("BTCUSDT")).toEqual(["2024-06"]);
    expect(store.readMonth("BTCUSDT", "2024-06")).toHaveLength(3);
    expect(fs.existsSync(metricsMonthDataFile(root, "BTCUSDT", "2024-06"))).toBe(true);
    expect(fs.existsSync(metricsMonthMetaFile(root, "BTCUSDT", "2024-06"))).toBe(true);
  });

  it("merges a second write without losing or duplicating rows", () => {
    const store = createMetricsStore(root);
    store.mergeMonth("BTCUSDT", "2024-06", [row(JUNE), row(JUNE + 300)]);
    const meta = store.mergeMonth("BTCUSDT", "2024-06", [row(JUNE + 300, 7), row(JUNE + 600)]);
    expect(meta.count).toBe(3);
    const rows = store.readMonth("BTCUSDT", "2024-06");
    expect(rows.map((r) => r.timeSec)).toEqual([JUNE, JUNE + 300, JUNE + 600]);
    expect(rows[1].openInterest).toBe(7);
  });

  it("reads a range that spans two months", () => {
    const store = createMetricsStore(root);
    const july = Date.UTC(2024, 6, 1) / 1000;
    store.mergeMonth("BTCUSDT", "2024-06", [row(july - 300)]);
    store.mergeMonth("BTCUSDT", "2024-07", [row(july), row(july + 300)]);
    expect(store.readRange("BTCUSDT", july - 300, july).map((r) => r.timeSec)).toEqual([july - 300, july]);
    expect(store.readRange("BTCUSDT", 0, 4e9)).toHaveLength(3);
    expect(store.readRange("BTCUSDT", july + 900, july + 1800)).toHaveLength(0);
  });

  it("reports the calendar days it holds", () => {
    const store = createMetricsStore(root);
    store.mergeMonth("BTCUSDT", "2024-06", [row(JUNE), row(JUNE + 86_400)]);
    expect(Array.from(store.storedDays("BTCUSDT")).sort()).toEqual(["2024-06-01", "2024-06-02"]);
  });

  it("ignores bytes written past the committed length", () => {
    const store = createMetricsStore(root);
    store.mergeMonth("BTCUSDT", "2024-06", [row(JUNE), row(JUNE + 300)]);
    fs.appendFileSync(metricsMonthDataFile(root, "BTCUSDT", "2024-06"), encodeMetrics([row(JUNE + 600)]));
    expect(store.readMonth("BTCUSDT", "2024-06")).toHaveLength(2);
  });

  it("survives a missing month rather than throwing", () => {
    const store = createMetricsStore(root);
    expect(store.listMonths("BTCUSDT")).toEqual([]);
    expect(store.readMonth("BTCUSDT", "2024-06")).toEqual([]);
    expect(store.readRange("BTCUSDT", 0, 4e9)).toEqual([]);
    expect(store.stats("BTCUSDT")).toMatchObject({ months: 0, rows: 0, firstTime: null });
  });

  it("summarises what is on disk", () => {
    const store = createMetricsStore(root);
    store.mergeMonth("BTCUSDT", "2024-06", [row(JUNE), row(JUNE + 300)]);
    const stats = store.stats("BTCUSDT");
    expect(stats).toMatchObject({ months: 1, rows: 2, days: 1, firstTime: JUNE, lastTime: JUNE + 300 });
    expect(stats.bytes).toBe(2 * RECORD_SIZE);
  });

  it("removes a month completely", () => {
    const store = createMetricsStore(root);
    store.mergeMonth("BTCUSDT", "2024-06", [row(JUNE)]);
    store.removeMonth("BTCUSDT", "2024-06");
    expect(store.listMonths("BTCUSDT")).toEqual([]);
  });
});
