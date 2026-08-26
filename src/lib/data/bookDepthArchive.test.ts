import { describe, expect, it } from "vitest";
import {
  bookDepthCachePath,
  bookDepthUrl,
  dateRange,
  epochDay,
  forEachBookDepthRow,
  isoFromEpochDay,
  parseBookDepthTimestamp,
} from "./bookDepthArchive";

const buf = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

const SAMPLE = [
  "timestamp,percentage,depth,notional",
  "2025-06-01 00:00:09,-1,2386.60500000,248307045.51610000",
  "2025-06-01 00:00:09,1,2449.24000000,257246884.45870000",
  "2025-06-01 23:59:33,5,6859.91600000,736587755.70310000",
  "",
].join("\n");

describe("bookDepth urls", () => {
  it("builds the daily archive path", () => {
    expect(bookDepthUrl({ symbol: "BTCUSDT", date: "2025-06-01" })).toBe(
      "https://data.binance.vision/data/futures/um/daily/bookDepth/BTCUSDT/BTCUSDT-bookDepth-2025-06-01.zip",
    );
  });

  it("caches per symbol", () => {
    expect(bookDepthCachePath("/d", { symbol: "BTCUSDT", date: "2025-06-01" }))
      .toMatch(/orderbook[\\/]binance[\\/]BTCUSDT[\\/]bookDepth-2025-06-01\.zip$/);
  });
});

describe("epochDay", () => {
  it("agrees with Date.UTC", () => {
    for (const [y, m, d] of [
      [1970, 1, 1],
      [2000, 2, 29],
      [2024, 12, 31],
      [2025, 6, 1],
      [2026, 8, 26],
    ] as const) {
      expect(epochDay(y, m, d)).toBe(Date.UTC(y, m - 1, d) / 86_400_000);
    }
  });

  it("round-trips through isoFromEpochDay", () => {
    for (let d = 19_000; d < 21_000; d += 37) {
      const iso = isoFromEpochDay(d);
      const [y, m, dd] = iso.split("-").map(Number);
      expect(epochDay(y, m, dd)).toBe(d);
    }
  });
});

describe("parseBookDepthTimestamp", () => {
  it("reads the fixed-width UTC stamp", () => {
    const b = buf("2025-06-01 03:04:05");
    expect(parseBookDepthTimestamp(b, 0, b.length)).toBe(Date.UTC(2025, 5, 1, 3, 4, 5) / 1000);
  });

  it("returns NaN on a short or impossible field", () => {
    const short = buf("2025-06-01");
    expect(parseBookDepthTimestamp(short, 0, short.length)).toBeNaN();
    const bad = buf("2025-19-01 03:04:05");
    expect(parseBookDepthTimestamp(bad, 0, bad.length)).toBeNaN();
  });
});

describe("dateRange", () => {
  it("is inclusive on both ends and crosses months", () => {
    expect(dateRange("2025-01-30", "2025-02-02")).toEqual([
      "2025-01-30",
      "2025-01-31",
      "2025-02-01",
      "2025-02-02",
    ]);
  });

  it("rejects an inverted range instead of returning nothing", () => {
    expect(() => dateRange("2025-02-02", "2025-01-30")).toThrow(/empty range/);
  });
});

describe("forEachBookDepthRow", () => {
  it("yields every band with a UTC second stamp", () => {
    const rows: Array<[number, number, number]> = [];
    const bad = forEachBookDepthRow(buf(SAMPLE), (r) => rows.push([r.timeSec, r.percentage, r.notional]));
    expect(bad).toBe(0);
    expect(rows).toHaveLength(3);
    expect(rows[0][0]).toBe(Date.UTC(2025, 5, 1, 0, 0, 9) / 1000);
    expect(rows[0][1]).toBe(-1);
    expect(rows[1][2]).toBeCloseTo(257246884.4587, 3);
  });

  it("refuses a file whose columns moved", () => {
    expect(() => forEachBookDepthRow(buf("timestamp,depth\n"), () => undefined)).toThrow(/unexpected header/);
  });
});
