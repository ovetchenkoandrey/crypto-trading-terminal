import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { archiveUrl, checksumUrl, sha256Hex, type ArchiveRef } from "./binanceArchive.ts";
import { createCandleStore, type CandleStore } from "./candleStore.ts";
import { buildQualityReport } from "./datasetReport.ts";
import { fetchDataset, fetchFundingDataset } from "./fetchDataset.ts";
import { createFundingStore, type FundingStore } from "./fundingStore.ts";
import { monthStartSec } from "./months.ts";
import type { DatasetKey } from "./paths.ts";
import { makeZip } from "./zipFixture.ts";

const KEY: DatasetKey = { market: "linear", symbol: "BTCUSDT", interval: "1h" };
const HOUR = 3600;
const NOW_MS = Date.UTC(2025, 3, 5, 12, 30);
const HEADER = "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore";

function csvRows(startSec: number, count: number, price: number): string {
  const rows = Array.from({ length: count }, (_, i) => {
    const ms = (startSec + i * HOUR) * 1000;
    return `${ms},${price},${price + 1},${price - 1},${price},1.5,${ms + HOUR * 1000 - 1},1,1,1,1,0`;
  });
  return [HEADER, ...rows, ""].join("\n");
}

function ref(granularity: "monthly" | "daily", period: string): ArchiveRef {
  return { market: "linear", symbol: "BTCUSDT", interval: "1h", granularity, period };
}

interface Fixture {
  files: Map<string, Buffer>;
  klines: Map<number, { price: number }>;
  fetchImpl: ReturnType<typeof vi.fn>;
  restCalls: number;
}

function addArchive(files: Map<string, Buffer>, r: ArchiveRef, startSec: number, count: number, price: number): void {
  const zip = makeZip([{ name: `BTCUSDT-1h-${r.period}.csv`, content: csvRows(startSec, count, price) }]);
  files.set(archiveUrl(r), zip);
  files.set(checksumUrl(r), Buffer.from(`${sha256Hex(zip)}  BTCUSDT-1h-${r.period}.zip\n`, "utf8"));
}

function makeFixture(restPrice = 130): Fixture {
  const files = new Map<string, Buffer>();
  const fixture: Fixture = { files, klines: new Map(), fetchImpl: vi.fn(), restCalls: 0 };

  fixture.fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/v5/market/kline")) {
      fixture.restCalls++;
      const params = new URL(url).searchParams;
      const startSec = Number(params.get("start")) / 1000;
      const endSec = Number(params.get("end")) / 1000;
      const list: string[][] = [];
      for (let t = startSec; t <= endSec; t += HOUR) {
        list.push([String(t * 1000), String(restPrice), String(restPrice + 1), String(restPrice - 1), String(restPrice), "2", "5"]);
      }
      list.reverse();
      const body = { retCode: 0, retMsg: "OK", result: { list } };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    }
    if (url.includes("/v5/market/instruments-info")) {
      const body = { retCode: 0, retMsg: "OK", result: { list: [{ symbol: "BTCUSDT", fundingInterval: 480 }] } };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    }
    if (url.includes("/v5/market/funding/history")) {
      const params = new URL(url).searchParams;
      const endSec = Math.floor(Number(params.get("endTime")) / 1000 / (8 * HOUR)) * (8 * HOUR);
      const list = Array.from({ length: 10 }, (_, i) => ({
        symbol: "BTCUSDT",
        fundingRate: "0.0001",
        fundingRateTimestamp: String((endSec - i * 8 * HOUR) * 1000),
      }));
      const body = { retCode: 0, retMsg: "OK", result: { list } };
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
    }
    const file = files.get(url);
    if (!file) {
      return { ok: false, status: 404, headers: { get: () => null }, text: async () => "not found" } as unknown as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => file.toString("utf8"),
      arrayBuffer: async () => Uint8Array.from(file).buffer,
    } as unknown as Response;
  });

  return fixture;
}

function options(fixture: Fixture, store: CandleStore, root: string, extra: Record<string, unknown> = {}) {
  const net = { fetchImpl: fixture.fetchImpl, timeoutMs: 0, baseDelayMs: 1, sleep: async () => undefined };
  return {
    root,
    key: KEY,
    from: "2025-03",
    to: "2025-04",
    store,
    now: () => NOW_MS,
    archive: net,
    bybit: { ...net, rps: 0 },
    ...extra,
  } as Parameters<typeof fetchDataset>[0];
}

let root: string;
let store: CandleStore;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "fetch-dataset-"));
  store = createCandleStore(root);
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe("fetchDataset", () => {
  function seedArchives(fixture: Fixture): void {
    addArchive(fixture.files, ref("monthly", "2025-03"), monthStartSec("2025-03"), 744, 100);
    for (const day of ["2025-04-01", "2025-04-02", "2025-04-03"]) {
      addArchive(fixture.files, ref("daily", day), Date.parse(`${day}T00:00:00Z`) / 1000, 24, 100);
    }
  }

  it("pulls a finished month from the monthly archive and marks it done", async () => {
    const fixture = makeFixture();
    seedArchives(fixture);
    const result = await fetchDataset(options(fixture, store, root, { to: "2025-03" }));

    expect(result.months).toHaveLength(1);
    expect(result.months[0]).toMatchObject({ action: "archive", total: 744, complete: true });
    const meta = store.readMeta(KEY, "2025-03");
    expect(meta?.count).toBe(744);
    expect(meta?.sources).toEqual(["binance-archive"]);
    expect(meta?.sourceSpans).toEqual([
      { source: "binance-archive", from: monthStartSec("2025-03"), to: monthStartSec("2025-04") - HOUR },
    ]);
    expect(meta?.complete).toBe(true);
    expect(fixture.restCalls).toBe(0);
  });

  it("refills days the monthly archive lost from the daily archives", async () => {
    const fixture = makeFixture();
    // Days 1..28 only: the shape of a real short monthly file (SOLUSDT 2022-02).
    addArchive(fixture.files, ref("monthly", "2025-03"), monthStartSec("2025-03"), 28 * 24, 100);
    for (const day of ["2025-03-29", "2025-03-30", "2025-03-31"]) {
      addArchive(fixture.files, ref("daily", day), Date.parse(`${day}T00:00:00Z`) / 1000, 24, 200);
    }

    const result = await fetchDataset(options(fixture, store, root, { to: "2025-03" }));

    expect(result.months[0]).toMatchObject({ action: "archive+daily", total: 744, complete: true });
    expect(result.months[0].repairedDays).toEqual(["2025-03-29", "2025-03-30", "2025-03-31"]);
    expect(store.readMeta(KEY, "2025-03")?.count).toBe(744);
    expect(store.readMeta(KEY, "2025-03")?.sources).toEqual(["binance-archive"]);
    expect(fixture.restCalls).toBe(0);
  });

  it("repairs an already complete month only when asked to", async () => {
    const fixture = makeFixture();
    addArchive(fixture.files, ref("monthly", "2025-03"), monthStartSec("2025-03"), 28 * 24, 100);
    await fetchDataset(options(fixture, store, root, { to: "2025-03" }));
    expect(store.readMeta(KEY, "2025-03")?.count).toBe(28 * 24);

    for (const day of ["2025-03-29", "2025-03-30", "2025-03-31"]) {
      addArchive(fixture.files, ref("daily", day), Date.parse(`${day}T00:00:00Z`) / 1000, 24, 200);
    }

    const plain = await fetchDataset(options(fixture, store, root, { to: "2025-03" }));
    expect(plain.months[0].action).toBe("skipped");
    expect(plain.requests.dailyArchives).toBe(0);

    const repaired = await fetchDataset(options(fixture, store, root, { to: "2025-03", repair: true }));
    expect(repaired.months[0]).toMatchObject({ action: "archive+daily", total: 744, added: 72 });
    expect(repaired.requests.archives).toBe(0);
    expect(store.readMeta(KEY, "2025-03")?.count).toBe(744);
  });

  it("keeps the short month when the daily archives cannot help either", async () => {
    const fixture = makeFixture();
    addArchive(fixture.files, ref("monthly", "2025-03"), monthStartSec("2025-03"), 28 * 24, 100);

    const result = await fetchDataset(options(fixture, store, root, { to: "2025-03" }));

    expect(result.months[0]).toMatchObject({ action: "archive", total: 28 * 24, complete: true });
    expect(result.months[0].repairedDays).toBeUndefined();
  });

  it("leaves a partial day alone instead of spending a request on it", async () => {
    const fixture = makeFixture();
    // 18 of 24 bars on the last day — an outage, not a lost day.
    addArchive(fixture.files, ref("monthly", "2025-03"), monthStartSec("2025-03"), 30 * 24 + 18, 100);
    addArchive(fixture.files, ref("daily", "2025-03-31"), Date.parse("2025-03-31T00:00:00Z") / 1000, 24, 200);

    const result = await fetchDataset(options(fixture, store, root, { to: "2025-03" }));

    expect(result.months[0].action).toBe("archive");
    expect(result.requests.dailyArchives).toBe(0);
    expect(store.readMeta(KEY, "2025-03")?.count).toBe(30 * 24 + 18);
  });

  it("skips a month that is already complete", async () => {
    const fixture = makeFixture();
    seedArchives(fixture);
    await fetchDataset(options(fixture, store, root, { to: "2025-03" }));
    const callsAfterFirst = fixture.fetchImpl.mock.calls.length;

    const second = await fetchDataset(options(fixture, store, root, { to: "2025-03" }));
    expect(second.months[0].action).toBe("skipped");
    expect(second.added).toBe(0);
    expect(fixture.fetchImpl.mock.calls.length).toBe(callsAfterFirst);
  });

  it("refetches a complete month when forced", async () => {
    const fixture = makeFixture();
    seedArchives(fixture);
    await fetchDataset(options(fixture, store, root, { to: "2025-03" }));
    const second = await fetchDataset(options(fixture, store, root, { to: "2025-03", force: true }));
    expect(second.months[0].action).toBe("archive");
  });

  it("fills the running month from daily archives and then from REST", async () => {
    const fixture = makeFixture();
    seedArchives(fixture);
    const result = await fetchDataset(options(fixture, store, root));

    const april = result.months.find((m) => m.month === "2025-04");
    expect(april?.action).toBe("daily+rest");
    expect(april?.complete).toBe(false);
    expect(april?.sources).toEqual(["binance-archive", "bybit-rest"]);

    const meta = store.readMeta(KEY, "2025-04");
    // Apr 1..3 from daily archives (72 bars) plus Apr 4 00:00..Apr 5 11:00 from REST (36 bars).
    expect(meta?.count).toBe(108);
    expect(meta?.firstTime).toBe(monthStartSec("2025-04"));
    expect(meta?.lastTime).toBe(Date.UTC(2025, 3, 5, 11) / 1000);
    expect(meta?.sourceSpans).toEqual([
      { source: "binance-archive", from: monthStartSec("2025-04"), to: Date.UTC(2025, 3, 3, 23) / 1000 },
      { source: "bybit-rest", from: Date.UTC(2025, 3, 4) / 1000, to: Date.UTC(2025, 3, 5, 11) / 1000 },
    ]);
  });

  it("never stores a bar that has not closed", async () => {
    const fixture = makeFixture();
    seedArchives(fixture);
    await fetchDataset(options(fixture, store, root));
    const last = store.readMeta(KEY, "2025-04")!.lastTime;
    expect(last + HOUR).toBeLessThanOrEqual(Math.floor(NOW_MS / 1000));
  });

  it("resumes the running month instead of refetching it", async () => {
    const fixture = makeFixture();
    seedArchives(fixture);
    await fetchDataset(options(fixture, store, root));
    const before = store.readMeta(KEY, "2025-04")!;
    fixture.fetchImpl.mockClear();
    fixture.restCalls = 0;

    const second = await fetchDataset(options(fixture, store, root));
    const after = store.readMeta(KEY, "2025-04")!;
    expect(after.count).toBe(before.count);
    expect(second.months.find((m) => m.month === "2025-04")?.added).toBe(0);
    // Only the not-yet-published daily archive is probed again, plus the empty REST window.
    const dailyProbes = fixture.fetchImpl.mock.calls.filter((c) => String(c[0]).includes("/daily/"));
    expect(dailyProbes.length).toBeLessThanOrEqual(2);
  });

  it("picks up a daily archive that appeared since the last run", async () => {
    const fixture = makeFixture();
    seedArchives(fixture);
    await fetchDataset(options(fixture, store, root, { tail: false }));
    expect(store.readMeta(KEY, "2025-04")?.count).toBe(72);

    addArchive(fixture.files, ref("daily", "2025-04-04"), Date.UTC(2025, 3, 4) / 1000, 24, 100);
    const second = await fetchDataset(options(fixture, store, root, { tail: false }));
    expect(second.months.find((m) => m.month === "2025-04")?.added).toBe(24);
    expect(store.readMeta(KEY, "2025-04")?.count).toBe(96);
  });

  it("stays off the exchange API when the tail is disabled", async () => {
    const fixture = makeFixture();
    seedArchives(fixture);
    const result = await fetchDataset(options(fixture, store, root, { tail: false }));
    expect(fixture.restCalls).toBe(0);
    expect(result.months.find((m) => m.month === "2025-04")?.action).toBe("daily");
  });

  it("uses REST for the whole running month when daily archives are off", async () => {
    const fixture = makeFixture();
    seedArchives(fixture);
    const result = await fetchDataset(options(fixture, store, root, { daily: false }));
    const april = result.months.find((m) => m.month === "2025-04");
    expect(april?.action).toBe("rest");
    expect(store.readMeta(KEY, "2025-04")?.sources).toEqual(["bybit-rest"]);
  });

  it("upgrades a REST-filled month once its monthly archive appears", async () => {
    const fixture = makeFixture(200);
    await fetchDataset(options(fixture, store, root, { from: "2025-03", to: "2025-03" }));
    let meta = store.readMeta(KEY, "2025-03")!;
    expect(meta.sources).toEqual(["bybit-rest"]);

    addArchive(fixture.files, ref("monthly", "2025-03"), monthStartSec("2025-03"), 744, 100);
    const second = await fetchDataset(options(fixture, store, root, { from: "2025-03", to: "2025-03" }));
    expect(second.months[0].action).toBe("archive");
    meta = store.readMeta(KEY, "2025-03")!;
    expect(meta.sources).toEqual(["binance-archive"]);
    expect(store.readMonth(KEY, "2025-03")[0].close).toBe(100);
  });

  it("records a failed month and keeps going", async () => {
    const fixture = makeFixture();
    seedArchives(fixture);
    fixture.files.set(archiveUrl(ref("monthly", "2025-03")), Buffer.from("this is not a zip file at all"));
    const result = await fetchDataset(options(fixture, store, root, { continueOnError: true }));
    expect(result.months[0].action).toBe("failed");
    expect(result.months[0].error).toBeTruthy();
    expect(result.months[1].action).toBe("daily+rest");
  });

  it("aborts on the first failure by default", async () => {
    const fixture = makeFixture();
    seedArchives(fixture);
    fixture.files.set(checksumUrl(ref("monthly", "2025-03")), Buffer.from(`${"0".repeat(64)}  x.zip`));
    await expect(fetchDataset(options(fixture, store, root))).rejects.toThrow(/checksum mismatch/);
  });

  it("produces a quality report that sees the whole fetched range", async () => {
    const fixture = makeFixture();
    seedArchives(fixture);
    await fetchDataset(options(fixture, store, root));
    const report = buildQualityReport(root, KEY, "2025-03", "2025-04", {
      store,
      nowSec: Math.floor(NOW_MS / 1000),
      minCoverage: 0,
    });
    expect(report.bars.unique).toBe(744 + 108);
    expect(report.gapCount).toBe(0);
    expect(report.months.map((m) => m.month)).toEqual(["2025-03", "2025-04"]);
    expect(report.sourceSeams).toHaveLength(1);
    expect(report.sourceSeams[0].from).toBe("binance-archive");
    expect(report.sourceSeams[0].to).toBe("bybit-rest");
  });
});

describe("fetchFundingDataset", () => {
  let fundingStore: FundingStore;

  beforeEach(() => {
    fundingStore = createFundingStore(root);
  });

  it("stores funding history and reads the interval from instruments-info", async () => {
    const fixture = makeFixture();
    const res = await fetchFundingDataset({
      root,
      market: "linear",
      symbol: "BTCUSDT",
      from: "2025-04",
      to: "2025-04",
      store: fundingStore,
      now: () => NOW_MS,
      bybit: { fetchImpl: fixture.fetchImpl, timeoutMs: 0, baseDelayMs: 1, sleep: async () => undefined, rps: 0 },
    });
    expect(res.intervalMinutes).toBe(480);
    expect(res.fetched).toBeGreaterThan(0);
    const events = fundingStore.readRange("linear", "BTCUSDT", res.fromSec, res.toSec);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.time >= res.fromSec && e.time <= res.toSec)).toBe(true);
  });

  it("only asks for the segment it is missing", async () => {
    const fixture = makeFixture();
    const opts = {
      root,
      market: "linear" as const,
      symbol: "BTCUSDT",
      from: "2025-04",
      to: "2025-04",
      store: fundingStore,
      now: () => NOW_MS,
      bybit: { fetchImpl: fixture.fetchImpl, timeoutMs: 0, baseDelayMs: 1, sleep: async () => undefined, rps: 0 },
    };
    await fetchFundingDataset(opts);
    fixture.fetchImpl.mockClear();
    const second = await fetchFundingDataset(opts);
    const historyCalls = fixture.fetchImpl.mock.calls.filter((c) => String(c[0]).includes("funding/history"));
    expect(historyCalls.length).toBeLessThan(4);
    expect(second.monthsWritten.length).toBeLessThanOrEqual(1);
  });
});
