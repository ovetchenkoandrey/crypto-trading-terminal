// Historical-range loader that fills gaps in the cache.
// Bybit kline endpoint returns at most 1000 candles per call, so we page
// through the requested range. Caller passes UTC seconds.

import { RestClientV5 } from "bybit-api";
import type { Candle, Interval } from "../types";
import { useStore } from "../store";
import type { Category } from "../symbols";
import { getCachedSpan, mergeCandles, getCachedRange } from "./cache";

const client = new RestClientV5();
const PAGE = 1000;

function resolveCategory(symbol: string): Category {
  const meta = useStore.getState().allSymbols.find((s) => s.symbol === symbol);
  return meta?.category ?? "spot";
}

/** Bar size in seconds for a Bybit interval string (e.g. "15" → 900). */
export function intervalSeconds(interval: Interval): number {
  // Bybit minute intervals are passed as "1", "5", "15"... and "D", "W", "M".
  if (interval === "D") return 86_400;
  if (interval === "W") return 86_400 * 7;
  if (interval === "M") return 86_400 * 30;
  const n = parseInt(interval, 10);
  return Number.isFinite(n) ? n * 60 : 60;
}

async function fetchPage(
  symbol: string,
  interval: Interval,
  startSec: number,
  endSec: number,
  category: Category,
): Promise<Candle[]> {
  const res = await client.getKline({
    category,
    symbol,
    interval,
    start: startSec * 1000,    // Bybit expects ms
    end:   endSec   * 1000,
    limit: PAGE,
  });
  if (res.retCode !== 0 || !res.result?.list) {
    throw new Error(`Bybit kline error: retCode=${res.retCode} retMsg="${res.retMsg}"`);
  }
  const candles: Candle[] = res.result.list.map((row) => ({
    time: Math.floor(parseFloat(row[0]) / 1000),
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low:  parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5]),
  }));
  candles.sort((a, b) => a.time - b.time);
  return candles;
}

export interface LoadProgress {
  loaded: number;          // candles fetched so far in this call
  estimated: number;       // estimated total candles in range
}

/**
 * Ensure cache covers [from, to] for {symbol, interval}. Fetches whatever is
 * missing from Bybit, paginates, merges into cache. Reports progress via
 * `onProgress` callback if provided.
 *
 * Returns the candles in the requested range (after the cache is filled).
 */
export async function ensureRange(
  symbol: string,
  interval: Interval,
  from: number,
  to: number,
  onProgress?: (p: LoadProgress) => void,
): Promise<Candle[]> {
  if (to <= from) return [];

  const barSec = intervalSeconds(interval);
  const estTotal = Math.ceil((to - from) / barSec);

  const cached = await getCachedSpan(symbol, interval);
  const gaps: { from: number; to: number }[] = [];
  if (!cached) {
    gaps.push({ from, to });
  } else {
    if (from < cached.from) gaps.push({ from, to: Math.min(cached.from - 1, to) });
    if (to   > cached.to)   gaps.push({ from: Math.max(cached.to + 1, from), to });
  }

  let loaded = 0;
  const category = resolveCategory(symbol);

  for (const gap of gaps) {
    let cursor = gap.from;
    while (cursor < gap.to) {
      const windowEnd = Math.min(cursor + barSec * PAGE - 1, gap.to);
      const page = await fetchPage(symbol, interval, cursor, windowEnd, category);
      if (page.length === 0) break;
      await mergeCandles(symbol, interval, page);
      loaded += page.length;
      onProgress?.({ loaded, estimated: estTotal });
      const last = page[page.length - 1].time;
      // Advance past the last candle we got; if we got fewer than PAGE, the
      // range had a gap (e.g. exchange downtime) — jump past windowEnd to keep going.
      cursor = Math.max(last + barSec, windowEnd + 1);
    }
  }

  return getCachedRange(symbol, interval, from, to);
}
