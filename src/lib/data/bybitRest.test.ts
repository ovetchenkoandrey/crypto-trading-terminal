import { describe, expect, it, vi } from "vitest";
import {
  BYBIT_BASE_URL,
  BybitApiError,
  fetchFundingHistory,
  fetchFundingIntervalMinutes,
  fetchKlinePage,
  fetchKlines,
  parseFundingRows,
  parseKlineRows,
} from "./bybitRest.ts";

const MIN = 60_000;

function ok(result: unknown): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ retCode: 0, retMsg: "OK", result }),
    json: async () => ({ retCode: 0, retMsg: "OK", result }),
  } as unknown as Response;
}

function apiError(retCode: number, retMsg = "boom"): Response {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    text: async () => JSON.stringify({ retCode, retMsg, result: {} }),
    json: async () => ({ retCode, retMsg, result: {} }),
  } as unknown as Response;
}

/** Bybit rows: strings, newest first. */
function klineRows(startMs: number, count: number, price = 100): string[][] {
  const rows = Array.from({ length: count }, (_, i) => [
    String(startMs + i * MIN),
    String(price),
    String(price + 1),
    String(price - 1),
    String(price + 0.5),
    "2.5",
    "250",
  ]);
  return rows.reverse();
}

const base = { timeoutMs: 0, baseDelayMs: 1, sleep: async () => undefined, rps: 0 };

describe("bybit parsing", () => {
  it("turns descending string rows into ascending second-based candles", () => {
    const candles = parseKlineRows(klineRows(Date.UTC(2025, 0, 1), 3));
    expect(candles.map((c) => c.time)).toEqual([1735689600, 1735689660, 1735689720]);
    expect(candles[0]).toEqual({ time: 1735689600, open: 100, high: 101, low: 99, close: 100.5, volume: 2.5 });
  });

  it("skips rows that are too short or unparseable", () => {
    expect(parseKlineRows([["1"], ["x", "1", "2", "3", "4", "5"]])).toEqual([]);
    expect(parseKlineRows(undefined)).toEqual([]);
  });

  it("parses funding rows into seconds", () => {
    const events = parseFundingRows([
      { fundingRate: "0.0001", fundingRateTimestamp: "1787587200000" },
      { fundingRate: "-0.00005", fundingRateTimestamp: "1787558400000" },
      { fundingRate: "bad", fundingRateTimestamp: "1" },
    ]);
    expect(events).toEqual([
      { time: 1787558400, rate: -0.00005 },
      { time: 1787587200, rate: 0.0001 },
    ]);
  });
});

describe("fetchKlinePage", () => {
  it("sends the documented query and converts seconds to milliseconds", async () => {
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (target: string) => {
      seen.push(target);
      return ok({ list: klineRows(Date.UTC(2025, 0, 1), 2) });
    });
    await fetchKlinePage("BTCUSDT", "1m", 1735689600, 1735689660, { ...base, fetchImpl });
    const url = new URL(seen[0]);
    expect(url.origin + url.pathname).toBe(`${BYBIT_BASE_URL}/v5/market/kline`);
    expect(url.searchParams.get("category")).toBe("linear");
    expect(url.searchParams.get("interval")).toBe("1");
    expect(url.searchParams.get("start")).toBe("1735689600000");
    expect(url.searchParams.get("end")).toBe("1735689660000");
    expect(url.searchParams.get("limit")).toBe("1000");
  });

  it("throws on a non-zero retCode", async () => {
    const fetchImpl = vi.fn(async () => apiError(10001, "params error"));
    await expect(fetchKlinePage("BTCUSDT", "1m", 0, 60, { ...base, fetchImpl })).rejects.toBeInstanceOf(BybitApiError);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("retries a rate-limit retCode", async () => {
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      return calls < 3 ? apiError(10006, "too many visits") : ok({ list: klineRows(0, 1) });
    });
    const page = await fetchKlinePage("BTCUSDT", "1m", 0, 60, { ...base, fetchImpl });
    expect(page).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("fetchKlines pagination", () => {
  const start = Date.UTC(2025, 0, 1) / 1000;

  it("pages forward from the last bar of the previous page", async () => {
    const starts: number[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const startMs = Number(new URL(url).searchParams.get("start"));
      starts.push(startMs / 1000);
      const index = starts.length - 1;
      if (index >= 2) return ok({ list: [] });
      return ok({ list: klineRows(startMs, 1000) });
    });
    const candles = await fetchKlines("BTCUSDT", "1m", start, start + 3000 * 60 - 1, {
      ...base,
      fetchImpl,
      maxEmptyPages: 1,
      now: () => Date.UTC(2030, 0, 1),
    });
    expect(candles).toHaveLength(2000);
    expect(starts[0]).toBe(start);
    expect(starts[1]).toBe(start + 1000 * 60);
    expect(candles[0].time).toBe(start);
    expect(candles[1999].time).toBe(start + 1999 * 60);
  });

  it("steps over a window the exchange has no bars for", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (url: string) => {
      const startMs = Number(new URL(url).searchParams.get("start"));
      call++;
      if (call === 1) return ok({ list: [] });
      if (call === 2) return ok({ list: klineRows(startMs, 5) });
      return ok({ list: [] });
    });
    const candles = await fetchKlines("BTCUSDT", "1m", start, start + 2500 * 60, {
      ...base,
      fetchImpl,
      maxEmptyPages: 2,
      now: () => Date.UTC(2030, 0, 1),
    });
    expect(candles).toHaveLength(5);
    expect(candles[0].time).toBe(start + 1000 * 60);
  });

  it("stops after the configured run of empty pages", async () => {
    const fetchImpl = vi.fn(async () => ok({ list: [] }));
    const candles = await fetchKlines("BTCUSDT", "1m", start, start + 100_000 * 60, {
      ...base,
      fetchImpl,
      maxEmptyPages: 3,
      now: () => Date.UTC(2030, 0, 1),
    });
    expect(candles).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("drops the bar that has not closed yet", async () => {
    const nowMs = (start + 3 * 60 + 30) * 1000;
    const fetchImpl = vi.fn(async () => ok({ list: klineRows(start * 1000, 4) }));
    const candles = await fetchKlines("BTCUSDT", "1m", start, start + 3 * 60, {
      ...base,
      fetchImpl,
      maxEmptyPages: 1,
      now: () => nowMs,
    });
    expect(candles.map((c) => c.time)).toEqual([start, start + 60, start + 120]);
  });

  it("keeps the forming bar when asked to", async () => {
    const nowMs = (start + 3 * 60 + 30) * 1000;
    const fetchImpl = vi.fn(async () => ok({ list: klineRows(start * 1000, 4) }));
    const candles = await fetchKlines("BTCUSDT", "1m", start, start + 3 * 60, {
      ...base,
      fetchImpl,
      maxEmptyPages: 1,
      dropUnclosed: false,
      now: () => nowMs,
    });
    expect(candles).toHaveLength(4);
  });

  it("reports progress as it pages", async () => {
    const onProgress = vi.fn();
    const fetchImpl = vi.fn(async (url: string) => {
      const startMs = Number(new URL(url).searchParams.get("start"));
      return ok({ list: klineRows(startMs, 10) });
    });
    await fetchKlines("BTCUSDT", "1m", start, start + 9 * 60, {
      ...base,
      fetchImpl,
      maxEmptyPages: 1,
      now: () => Date.UTC(2030, 0, 1),
      onProgress,
    });
    expect(onProgress).toHaveBeenCalled();
    expect(onProgress.mock.calls[0][0]).toMatchObject({ fetched: 10, pages: 1 });
  });

  it("returns nothing for an inverted range", async () => {
    const fetchImpl = vi.fn();
    expect(await fetchKlines("BTCUSDT", "1m", 100, 50, { ...base, fetchImpl })).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("fetchFundingHistory", () => {
  const eight = 8 * 3600;
  const to = Date.UTC(2025, 0, 31) / 1000;
  const from = Date.UTC(2025, 0, 1) / 1000;

  function fundingRows(endSec: number, count: number): { fundingRate: string; fundingRateTimestamp: string }[] {
    return Array.from({ length: count }, (_, i) => ({
      fundingRate: "0.0001",
      fundingRateTimestamp: String((endSec - i * eight) * 1000),
    }));
  }

  it("walks backwards using endTime only", async () => {
    const endTimes: number[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      const params = new URL(url).searchParams;
      expect(params.get("startTime")).toBeNull();
      const endTime = Number(params.get("endTime"));
      endTimes.push(endTime);
      const endSec = Math.floor(endTime / 1000 / eight) * eight;
      if (endSec < from) return ok({ list: [] });
      return ok({ list: fundingRows(endSec, 5) });
    });

    const events = await fetchFundingHistory("BTCUSDT", from, to, { ...base, fetchImpl });
    expect(endTimes[0]).toBe(to * 1000);
    expect(endTimes.length).toBeGreaterThan(1);
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.time >= from && e.time <= to)).toBe(true);
    const times = events.map((e) => e.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(new Set(times).size).toBe(times.length);
  });

  it("stops on the first empty page", async () => {
    const fetchImpl = vi.fn(async () => ok({ list: [] }));
    expect(await fetchFundingHistory("BTCUSDT", from, to, { ...base, fetchImpl })).toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not loop forever when the cursor stops moving", async () => {
    const fetchImpl = vi.fn(async () => ok({ list: fundingRows(to, 1) }));
    const events = await fetchFundingHistory("BTCUSDT", from, to, { ...base, fetchImpl, maxPages: 50 });
    expect(fetchImpl.mock.calls.length).toBeLessThan(50);
    expect(events.length).toBeGreaterThan(0);
  });
});

describe("fetchFundingIntervalMinutes", () => {
  it("reads the interval from instruments-info", async () => {
    const fetchImpl = vi.fn(async () => ok({ list: [{ symbol: "BTCUSDT", fundingInterval: 480 }] }));
    expect(await fetchFundingIntervalMinutes("BTCUSDT", { ...base, fetchImpl })).toBe(480);
  });

  it("returns null when the field is missing", async () => {
    const fetchImpl = vi.fn(async () => ok({ list: [{ symbol: "BTCUSDT" }] }));
    expect(await fetchFundingIntervalMinutes("BTCUSDT", { ...base, fetchImpl })).toBeNull();
  });
});
