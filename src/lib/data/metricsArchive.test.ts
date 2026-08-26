import { describe, expect, it } from "vitest";
import {
  METRICS_HEADER,
  METRICS_ROWS_PER_DAY,
  METRICS_STEP_SEC,
  metricsChecksumUrl,
  metricsUrl,
  parseChecksum,
  parseMetricsCsv,
  sha256Hex,
} from "./metricsArchive.ts";

const buf = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

const SAMPLE = [
  METRICS_HEADER.join(","),
  "2024-06-15 00:00:00,BTCUSDT,79438.9190000000000000,5247201626.4112400000000000,2.07638620,1.45672300,2.31372549,0.60486200",
  "2024-06-15 00:05:00,BTCUSDT,79334.4120000000000000,5238628809.6589830000000000,2.07904127,1.45790400,2.32174756,1.09858400",
  "2024-06-15 00:10:00,BTCUSDT,79300.0000000000000000,5236000000.0000000000000000,2.07000000,1.45000000,2.30000000,0.90000000",
  "",
].join("\n");

describe("metrics urls", () => {
  it("builds the daily archive path", () => {
    expect(metricsUrl({ symbol: "BTCUSDT", date: "2024-06-15" })).toBe(
      "https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-2024-06-15.zip",
    );
  });

  it("puts the checksum next to the archive", () => {
    expect(metricsChecksumUrl({ symbol: "ETHUSDT", date: "2022-01-02" })).toBe(
      "https://data.binance.vision/data/futures/um/daily/metrics/ETHUSDT/ETHUSDT-metrics-2022-01-02.zip.CHECKSUM",
    );
  });

  it("honours an alternative base", () => {
    expect(metricsUrl({ symbol: "BTCUSDT", date: "2024-06-15" }, "http://localhost:8080/")).toBe(
      "http://localhost:8080/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-2024-06-15.zip",
    );
  });
});

describe("grid constants", () => {
  it("describes a five-minute series", () => {
    expect(METRICS_STEP_SEC).toBe(300);
    expect(METRICS_ROWS_PER_DAY).toBe(288);
  });
});

describe("parseChecksum", () => {
  it("takes the hex from a `<hex>  <file>` line", () => {
    const hex = "a".repeat(64);
    expect(parseChecksum(`${hex}  BTCUSDT-metrics-2024-06-15.zip\n`)).toBe(hex);
  });

  it("rejects anything that is not a digest", () => {
    expect(() => parseChecksum("not a checksum")).toThrow(/unreadable/);
  });

  it("hashes deterministically", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("parseMetricsCsv", () => {
  it("reads every column of every row", () => {
    const { rows, malformed } = parseMetricsCsv(buf(SAMPLE), "BTCUSDT");
    expect(malformed).toBe(0);
    expect(rows).toHaveLength(3);
    expect(rows[0].timeSec).toBe(Date.UTC(2024, 5, 15, 0, 0, 0) / 1000);
    expect(rows[0].openInterest).toBeCloseTo(79438.919, 3);
    expect(rows[0].openInterestValue).toBeCloseTo(5247201626.41124, 2);
    expect(rows[0].topTraderAccountRatio).toBeCloseTo(2.0763862, 7);
    expect(rows[0].topTraderPositionRatio).toBeCloseTo(1.456723, 6);
    expect(rows[0].accountRatio).toBeCloseTo(2.31372549, 8);
    expect(rows[0].takerVolumeRatio).toBeCloseTo(0.604862, 6);
    expect(rows[1].timeSec - rows[0].timeSec).toBe(METRICS_STEP_SEC);
  });

  it("keeps the mark price recoverable to full precision", () => {
    const { rows } = parseMetricsCsv(buf(SAMPLE));
    expect(rows[0].openInterestValue / rows[0].openInterest).toBeCloseTo(66053.2858763, 5);
  });

  it("returns rows in time order even when the file is not", () => {
    const shuffled = [
      METRICS_HEADER.join(","),
      "2024-06-15 00:05:00,BTCUSDT,2,2,1,1,1,1",
      "2024-06-15 00:00:00,BTCUSDT,1,1,1,1,1,1",
      "",
    ].join("\n");
    const { rows } = parseMetricsCsv(buf(shuffled));
    expect(rows.map((r) => r.openInterest)).toEqual([1, 2]);
  });

  it("counts an empty measurement instead of reading it as zero", () => {
    const withHole = [
      METRICS_HEADER.join(","),
      "2024-06-15 00:00:00,BTCUSDT,79438.919,5247201626.41,2.07,,2.31,0.60",
      "",
    ].join("\n");
    const { rows, emptyFields, malformed } = parseMetricsCsv(buf(withHole));
    expect(malformed).toBe(0);
    expect(rows).toHaveLength(1);
    expect(Number.isNaN(rows[0].topTraderPositionRatio)).toBe(true);
    expect(emptyFields.topTraderPositionRatio).toBe(1);
    expect(emptyFields.openInterest).toBe(0);
  });

  it("rejects a row carrying someone else's ticker", () => {
    const mixed = [
      METRICS_HEADER.join(","),
      "2024-06-15 00:00:00,ETHUSDT,1,1,1,1,1,1",
      "2024-06-15 00:05:00,BTCUSDT,1,1,1,1,1,1",
      "",
    ].join("\n");
    const { rows, malformed } = parseMetricsCsv(buf(mixed), "BTCUSDT");
    expect(malformed).toBe(1);
    expect(rows).toHaveLength(1);
  });

  it("counts an unreadable timestamp as malformed", () => {
    const broken = [METRICS_HEADER.join(","), "not-a-date,BTCUSDT,1,1,1,1,1,1", ""].join("\n");
    const { rows, malformed } = parseMetricsCsv(buf(broken));
    expect(rows).toHaveLength(0);
    expect(malformed).toBe(1);
  });

  it("refuses a file whose header is not the one we expect", () => {
    expect(() => parseMetricsCsv(buf("a,b,c\n1,2,3\n"))).toThrow(/unexpected header/);
  });
});
