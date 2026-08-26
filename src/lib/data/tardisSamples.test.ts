import { describe, expect, it } from "vitest";
import {
  firstOfMonthDates,
  isFreeSampleDate,
  parseIsoDate,
  parseQuotesCsv,
  parseTradesCsv,
  tardisCachePath,
  tardisUrl,
} from "./tardisSamples";

const buf = (s: string): Uint8Array => new Uint8Array(Buffer.from(s, "utf8"));

const QUOTES = [
  "exchange,symbol,timestamp,local_timestamp,ask_amount,ask_price,bid_price,bid_amount",
  "bybit,BTCUSDT,1748736000072000,1748736000209254,7.852,104566.1,104566,16.889",
  "bybit,BTCUSDT,1748736000092000,1748736000209254,7.851,104566.2,104566,16.873",
  "",
].join("\n");

const TRADES = [
  "exchange,symbol,timestamp,local_timestamp,id,side,price,amount",
  "bybit,BTCUSDT,1748736000078000,1748736000124947,e63,sell,104566,0.016",
  "bybit,BTCUSDT,1748736000107000,1748736000154213,505,buy,104566.1,0.005",
  "bybit,BTCUSDT,1748736000108000,1748736000154213,506,unknown,104566.1,0.005",
  "",
].join("\n");

describe("tardis urls", () => {
  it("builds the free-sample path", () => {
    expect(tardisUrl({ exchange: "bybit", dataType: "quotes", symbol: "BTCUSDT", date: "2025-06-01" })).toBe(
      "https://datasets.tardis.dev/v1/bybit/quotes/2025/06/01/BTCUSDT.csv.gz",
    );
  });

  it("rejects a malformed date rather than fetching a wrong day", () => {
    expect(() => parseIsoDate("2025-6-1")).toThrow(/bad date/);
  });

  it("knows which dates are free", () => {
    expect(isFreeSampleDate("2025-06-01")).toBe(true);
    expect(isFreeSampleDate("2025-06-02")).toBe(false);
  });

  it("caches per exchange and data type", () => {
    expect(tardisCachePath("/d", { exchange: "bybit", dataType: "trades", symbol: "BTCUSDT", date: "2025-06-01" }))
      .toMatch(/orderbook[\\/]tardis[\\/]bybit[\\/]trades[\\/]BTCUSDT-2025-06-01\.csv\.gz$/);
  });
});

describe("firstOfMonthDates", () => {
  it("walks months inclusively across a year boundary", () => {
    expect(firstOfMonthDates("2024-11", "2025-02")).toEqual([
      "2024-11-01",
      "2024-12-01",
      "2025-01-01",
      "2025-02-01",
    ]);
  });

  it("returns a single month when from equals to", () => {
    expect(firstOfMonthDates("2025-06", "2025-06")).toEqual(["2025-06-01"]);
  });

  it("returns nothing when the range is inverted", () => {
    expect(firstOfMonthDates("2025-06", "2025-05")).toEqual([]);
  });
});

describe("parseQuotesCsv", () => {
  it("reads columns by name-checked position and converts to milliseconds", () => {
    const day = parseQuotesCsv(buf(QUOTES));
    expect(day.n).toBe(2);
    expect(day.ts[0]).toBe(1748736000072);
    expect(day.ask[0]).toBeCloseTo(104566.1, 6);
    expect(day.bid[0]).toBe(104566);
    expect(day.bidAmt[0]).toBeCloseTo(16.889, 6);
    expect(day.askAmt[1]).toBeCloseTo(7.851, 6);
    expect(day.malformed).toBe(0);
  });

  it("refuses a file whose columns moved", () => {
    expect(() => parseQuotesCsv(buf("exchange,symbol,timestamp\n"))).toThrow(/unexpected header/);
  });
});

describe("parseTradesCsv", () => {
  it("keeps the aggressor side", () => {
    const day = parseTradesCsv(buf(TRADES));
    expect(day.n).toBe(2);
    expect(day.sell[0]).toBe(1);
    expect(day.sell[1]).toBe(0);
    expect(day.amount[0]).toBeCloseTo(0.016, 9);
    expect(day.ts[1]).toBe(1748736000107);
  });

  it("counts a row with an unrecognised side instead of guessing", () => {
    expect(parseTradesCsv(buf(TRADES)).malformed).toBe(1);
  });
});
