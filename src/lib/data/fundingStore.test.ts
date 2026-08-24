import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFundingStore, type FundingEvent, type FundingStore } from "./fundingStore.ts";
import { monthStartSec } from "./months.ts";
import { fundingMonthFile } from "./paths.ts";

const EIGHT_HOURS = 8 * 3600;

function events(month: string, count: number, rate = 0.0001): FundingEvent[] {
  const start = monthStartSec(month);
  return Array.from({ length: count }, (_, i) => ({ time: start + i * EIGHT_HOURS, rate }));
}

let root: string;
let store: FundingStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "funding-store-"));
  store = createFundingStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("fundingStore", () => {
  it("round-trips a month", () => {
    const list = events("2025-03", 5);
    const file = store.writeMonth("linear", "BTCUSDT", "2025-03", list, 480);
    expect(file.count).toBe(5);
    expect(file.intervalMinutes).toBe(480);
    expect(store.readMonth("linear", "BTCUSDT", "2025-03")).toEqual(list);
    expect(store.listMonths("linear", "BTCUSDT")).toEqual(["2025-03"]);
  });

  it("dedupes and sorts on write", () => {
    const list = events("2025-03", 3);
    const file = store.writeMonth("linear", "BTCUSDT", "2025-03", [list[2], list[0], { ...list[0], rate: 0.5 }], 480);
    expect(file.count).toBe(2);
    expect(store.readMonth("linear", "BTCUSDT", "2025-03")).toEqual([{ time: list[0].time, rate: 0.5 }, list[2]]);
  });

  it("splits a fetched batch across month files", () => {
    const batch = [...events("2025-03", 3), ...events("2025-04", 2)];
    const res = store.merge("linear", "BTCUSDT", batch, 480);
    expect(res.months).toEqual(["2025-03", "2025-04"]);
    expect(res.written).toBe(5);
    expect(store.listMonths("linear", "BTCUSDT")).toEqual(["2025-03", "2025-04"]);
  });

  it("leaves a month alone when the merge changes nothing", () => {
    const batch = events("2025-03", 3);
    store.merge("linear", "BTCUSDT", batch, 480);
    const file = fundingMonthFile(root, "linear", "BTCUSDT", "2025-03");
    const before = fs.readFileSync(file, "utf8");
    const second = store.merge("linear", "BTCUSDT", batch, 480);
    expect(second.months).toEqual([]);
    expect(fs.readFileSync(file, "utf8")).toBe(before);
  });

  it("rewrites a month when a rate is corrected", () => {
    const batch = events("2025-03", 3);
    store.merge("linear", "BTCUSDT", batch, 480);
    const second = store.merge("linear", "BTCUSDT", [{ ...batch[1], rate: -0.0004 }], 480);
    expect(second.months).toEqual(["2025-03"]);
    expect(store.readMonth("linear", "BTCUSDT", "2025-03")[1].rate).toBe(-0.0004);
  });

  it("reads a range across months", () => {
    store.merge("linear", "BTCUSDT", [...events("2025-03", 93), ...events("2025-04", 90)], 480);
    const from = monthStartSec("2025-03") + 92 * EIGHT_HOURS;
    const to = monthStartSec("2025-04") + EIGHT_HOURS;
    expect(store.readRange("linear", "BTCUSDT", from, to).map((e) => e.time)).toEqual([
      from,
      monthStartSec("2025-04"),
      monthStartSec("2025-04") + EIGHT_HOURS,
    ]);
    expect(store.readRange("linear", "BTCUSDT", to, from)).toEqual([]);
  });

  it("reports stats and survives a corrupted file", () => {
    store.merge("linear", "BTCUSDT", events("2025-03", 4), 480);
    expect(store.stats("linear", "BTCUSDT")).toMatchObject({ months: 1, events: 4 });
    fs.writeFileSync(fundingMonthFile(root, "linear", "BTCUSDT", "2025-03"), "{ broken");
    expect(store.readMonth("linear", "BTCUSDT", "2025-03")).toEqual([]);
    expect(store.stats("linear", "BTCUSDT")).toMatchObject({ months: 1, events: 0 });
  });

  it("keeps symbols and markets apart", () => {
    store.merge("linear", "BTCUSDT", events("2025-03", 2), 480);
    expect(store.listMonths("linear", "ETHUSDT")).toEqual([]);
    expect(store.readMonth("spot", "BTCUSDT", "2025-03")).toEqual([]);
  });
});
