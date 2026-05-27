import { RestClientV5 } from "bybit-api";
import type { Candle, Interval } from "./types";

// Single shared client — no auth needed for public endpoints
const client = new RestClientV5();

export async function fetchKlines(
  symbol: string,
  interval: Interval,
  limit: number = 200
): Promise<Candle[]> {
  const res = await client.getKline({
    category: "spot",
    symbol,
    interval,
    limit,
  });

  if (res.retCode !== 0 || !res.result?.list) {
    throw new Error(
      `Bybit API error: retCode=${res.retCode} retMsg="${res.retMsg}"`
    );
  }

  // Each row: [timestamp_ms, open, high, low, close, volume, quote_volume]
  const candles: Candle[] = res.result.list.map((row) => ({
    time: Math.floor(parseFloat(row[0]) / 1000), // ms → seconds
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5]),
  }));

  // Bybit returns newest-first — sort ascending by time
  candles.sort((a, b) => a.time - b.time);

  return candles;
}
