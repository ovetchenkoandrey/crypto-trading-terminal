import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  ChecksumError,
  archiveUrl,
  checksumUrl,
  downloadArchive,
  parseChecksum,
  sha256Hex,
  tryDownloadArchive,
  type ArchiveRef,
} from "./binanceArchive.ts";
import { makeZip } from "./zipFixture.ts";

const HEADER = "open_time,open,high,low,close,volume,close_time,quote_volume,count,taker_buy_volume,taker_buy_quote_volume,ignore";

const MONTHLY: ArchiveRef = {
  market: "linear",
  symbol: "BTCUSDT",
  interval: "1m",
  granularity: "monthly",
  period: "2025-03",
};

function csv(startMs: number, count: number): string {
  const rows = Array.from({ length: count }, (_, i) => {
    const t = startMs + i * 60_000;
    return `${t},100,101,99,100.5,1.5,${t + 59_999},150,10,0.5,50,0`;
  });
  return [HEADER, ...rows, ""].join("\n");
}

function zipFor(ref: ArchiveRef, text: string): Buffer {
  return makeZip([{ name: `${ref.symbol}-${ref.interval}-${ref.period}.csv`, content: text }]);
}

function serve(map: Map<string, Buffer | string | number>) {
  return vi.fn(async (url: string) => {
    const entry = map.get(url);
    if (entry === undefined || entry === 404) {
      return {
        ok: false,
        status: 404,
        headers: { get: () => null },
        text: async () => "not found",
      } as unknown as Response;
    }
    const buf = Buffer.isBuffer(entry) ? entry : Buffer.from(String(entry), "utf8");
    return {
      ok: true,
      status: 200,
      headers: { get: () => null },
      text: async () => buf.toString("utf8"),
      arrayBuffer: async () => Uint8Array.from(buf).buffer,
    } as unknown as Response;
  });
}

const noTimeout = { timeoutMs: 0, baseDelayMs: 1, sleep: async () => undefined };

describe("binanceArchive urls", () => {
  it("builds the futures and spot paths", () => {
    expect(archiveUrl(MONTHLY)).toBe(
      "https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2025-03.zip",
    );
    expect(archiveUrl({ ...MONTHLY, market: "spot" })).toBe(
      "https://data.binance.vision/data/spot/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2025-03.zip",
    );
    expect(archiveUrl({ ...MONTHLY, granularity: "daily", period: "2025-03-14" })).toBe(
      "https://data.binance.vision/data/futures/um/daily/klines/BTCUSDT/1m/BTCUSDT-1m-2025-03-14.zip",
    );
    expect(checksumUrl(MONTHLY)).toBe(`${archiveUrl(MONTHLY)}.CHECKSUM`);
    expect(archiveUrl(MONTHLY, "https://mirror.example/")).toContain("https://mirror.example/data/");
  });

  it("reads the hex out of a CHECKSUM sidecar", () => {
    const hex = "9b214199eb5063585c7ed0f59ba19323326d68ac024b85106713989399204490";
    expect(parseChecksum(`${hex}  BTCUSDT-1m-2026-06.zip\n`)).toBe(hex);
    expect(parseChecksum(hex.toUpperCase())).toBe(hex);
    expect(() => parseChecksum("nonsense")).toThrow(/unreadable CHECKSUM/);
    expect(() => parseChecksum("")).toThrow();
  });

  it("hashes a buffer the same way the sidecar does", () => {
    const buf = Buffer.from("abc");
    expect(sha256Hex(buf)).toBe(createHash("sha256").update(buf).digest("hex"));
  });
});

describe("downloadArchive", () => {
  const startMs = Date.UTC(2025, 2, 1);

  it("verifies the checksum, unzips and parses", async () => {
    const zip = zipFor(MONTHLY, csv(startMs, 3));
    const fetchImpl = serve(
      new Map<string, Buffer | string>([
        [archiveUrl(MONTHLY), zip],
        [checksumUrl(MONTHLY), `${sha256Hex(zip)}  BTCUSDT-1m-2025-03.zip\n`],
      ]),
    );
    const res = await downloadArchive(MONTHLY, { ...noTimeout, fetchImpl });
    expect(res.checksumVerified).toBe(true);
    expect(res.sha256).toBe(sha256Hex(zip));
    expect(res.timeUnit).toBe("ms");
    expect(res.rows).toBe(3);
    expect(res.malformed).toBe(0);
    expect(res.candles.map((c) => c.time)).toEqual([startMs / 1000, startMs / 1000 + 60, startMs / 1000 + 120]);
    expect(res.csvName).toBe("BTCUSDT-1m-2025-03.csv");
  });

  it("re-downloads once on a checksum mismatch and then gives up", async () => {
    const zip = zipFor(MONTHLY, csv(startMs, 1));
    const fetchImpl = serve(
      new Map<string, Buffer | string>([
        [archiveUrl(MONTHLY), zip],
        [checksumUrl(MONTHLY), `${"0".repeat(64)}  BTCUSDT-1m-2025-03.zip`],
      ]),
    );
    await expect(downloadArchive(MONTHLY, { ...noTimeout, fetchImpl })).rejects.toBeInstanceOf(ChecksumError);
    const zipRequests = fetchImpl.mock.calls.filter((c) => c[0] === archiveUrl(MONTHLY));
    expect(zipRequests).toHaveLength(2);
  });

  it("skips verification when explicitly asked", async () => {
    const zip = zipFor(MONTHLY, csv(startMs, 2));
    const fetchImpl = serve(new Map<string, Buffer | string>([[archiveUrl(MONTHLY), zip]]));
    const res = await downloadArchive(MONTHLY, { ...noTimeout, fetchImpl, verifyChecksum: false });
    expect(res.checksumVerified).toBe(false);
    expect(res.candles).toHaveLength(2);
  });

  it("returns null for a period that is not published yet", async () => {
    const fetchImpl = serve(new Map());
    expect(await tryDownloadArchive(MONTHLY, { ...noTimeout, fetchImpl })).toBeNull();
  });

  it("propagates non-404 failures", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });
    await expect(tryDownloadArchive(MONTHLY, { ...noTimeout, fetchImpl, retries: 1 })).rejects.toThrow(/ECONNRESET/);
  });

  it("carries microsecond timestamps through to seconds", async () => {
    const usCsv = [HEADER, `${startMs * 1000},100,101,99,100.5,1.5,0,0,0,0,0,0`, ""].join("\n");
    const zip = zipFor(MONTHLY, usCsv);
    const fetchImpl = serve(new Map<string, Buffer | string>([[archiveUrl(MONTHLY), zip]]));
    const res = await downloadArchive(MONTHLY, { ...noTimeout, fetchImpl, verifyChecksum: false });
    expect(res.timeUnit).toBe("us");
    expect(res.candles[0].time).toBe(startMs / 1000);
  });
});
