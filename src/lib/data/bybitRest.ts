import type { Candle } from "../types.ts";
import { backoffDelay, createRateLimiter, defaultSleep, fetchJson, type HttpOptions } from "./http.ts";
import { intervalSeconds, toBybitInterval, type DataInterval } from "./interval.ts";
import type { FundingEvent } from "./fundingStore.ts";

/**
 * Bybit v5 public market data, used to cover whatever the Binance archives have
 * not published yet.
 *
 * Three things about this API bite every time:
 *  - the list comes back newest-first, so every page needs reversing;
 *  - every field is a string;
 *  - there is no cursor. Paging is manual, from `last + interval`.
 *
 * The limit is 600 requests per 5 seconds per IP. We run at 4 rps by default,
 * which is two orders of magnitude below the ceiling — a throttle here costs a
 * whole run, and there is nothing to gain from going faster.
 */

export const BYBIT_BASE_URL = "https://api.bybit.com";

export type BybitCategory = "linear" | "spot" | "inverse";

export interface BybitOptions extends HttpOptions {
  baseUrl?: string;
  category?: BybitCategory;
  /** Requests per second. */
  rps?: number;
  /** Shared limiter, so several calls in one run respect one budget. */
  acquire?: () => Promise<void>;
  /** Stop after this many consecutive empty pages (end of data reached). */
  maxEmptyPages?: number;
  maxPages?: number;
}

export interface KlineProgress {
  fetched: number;
  pages: number;
  cursorSec: number;
  toSec: number;
  /** 0..1, best-effort — the range may legitimately contain no bars. */
  fraction: number;
}

export interface FundingProgress {
  fetched: number;
  pages: number;
  oldestSec: number;
  fromSec: number;
}

export class BybitApiError extends Error {
  readonly retCode: number;
  constructor(retCode: number, retMsg: string, url: string) {
    super(`Bybit retCode=${retCode} retMsg="${retMsg}" (${url})`);
    this.name = "BybitApiError";
    this.retCode = retCode;
  }
}

interface Envelope<T> {
  retCode: number;
  retMsg: string;
  result: T;
}

const KLINE_PAGE = 1000;
const FUNDING_PAGE = 200;

/** Rate-limit / server-busy codes that are worth another attempt. */
const RETRYABLE_RET_CODES = new Set([10006, 10016, 10018, 10429, 130150]);

function limiterFor(opts: BybitOptions): () => Promise<void> {
  if (opts.acquire) return opts.acquire;
  return createRateLimiter(opts.rps ?? 4, { sleep: opts.sleep, now: opts.now });
}

async function request<T>(url: string, opts: BybitOptions, acquire: () => Promise<void>): Promise<T> {
  const sleep = opts.sleep ?? defaultSleep;
  const jitter = opts.jitter ?? Math.random;
  const retries = opts.retries ?? 4;
  const base = opts.baseDelayMs ?? 500;
  const max = opts.maxDelayMs ?? 20_000;

  for (let attempt = 0; ; attempt++) {
    await acquire();
    const body = await fetchJson<Envelope<T>>(url, opts);
    if (body?.retCode === 0) return body.result;
    const retCode = body?.retCode ?? -1;
    const err = new BybitApiError(retCode, body?.retMsg ?? "", url);
    if (!RETRYABLE_RET_CODES.has(retCode) || attempt >= retries) throw err;
    opts.onRetry?.({ url, attempt: attempt + 1, delayMs: 0, error: err });
    await sleep(backoffDelay(attempt, base, max, jitter()));
  }
}

function num(value: unknown): number {
  return typeof value === "number" ? value : parseFloat(String(value));
}

export function parseKlineRows(rows: readonly (readonly string[])[] | undefined): Candle[] {
  if (!rows) return [];
  const out: Candle[] = [];
  for (const row of rows) {
    if (!row || row.length < 6) continue;
    const ms = num(row[0]);
    const candle: Candle = {
      time: Math.floor(ms / 1000),
      open: num(row[1]),
      high: num(row[2]),
      low: num(row[3]),
      close: num(row[4]),
      volume: num(row[5]),
    };
    if (!Number.isFinite(candle.time) || !Number.isFinite(candle.close)) continue;
    out.push(candle);
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

/** One page, ascending. `startSec`/`endSec` are inclusive UTC seconds. */
export async function fetchKlinePage(
  symbol: string,
  interval: DataInterval,
  startSec: number,
  endSec: number,
  opts: BybitOptions = {},
  acquire = limiterFor(opts),
): Promise<Candle[]> {
  const baseUrl = opts.baseUrl ?? BYBIT_BASE_URL;
  const params = new URLSearchParams({
    category: opts.category ?? "linear",
    symbol,
    interval: String(toBybitInterval(interval)),
    start: String(startSec * 1000),
    end: String(endSec * 1000),
    limit: String(KLINE_PAGE),
  });
  const result = await request<{ list?: string[][] }>(
    `${baseUrl}/v5/market/kline?${params.toString()}`,
    opts,
    acquire,
  );
  return parseKlineRows(result?.list);
}

export interface FetchKlinesOptions extends BybitOptions {
  /**
   * Drop the bar that is still forming. Storing an unclosed bar poisons every
   * backtest that later reads the tail, and it is invisible after the fact.
   */
  dropUnclosed?: boolean;
  onProgress?: (p: KlineProgress) => void;
}

/**
 * Walks [fromSec, toSec] page by page. Missing bars are normal (the exchange
 * does not always publish a minute), so an empty window advances the cursor past
 * that window instead of stalling.
 */
export async function fetchKlines(
  symbol: string,
  interval: DataInterval,
  fromSec: number,
  toSec: number,
  opts: FetchKlinesOptions = {},
): Promise<Candle[]> {
  if (!(toSec >= fromSec)) return [];
  const step = intervalSeconds(interval);
  const acquire = limiterFor(opts);
  const maxEmpty = opts.maxEmptyPages ?? 10;
  const maxPages = opts.maxPages ?? 20_000;
  const nowMs = opts.now ?? Date.now;

  const out: Candle[] = [];
  const seen = new Set<number>();
  let cursor = fromSec;
  let empties = 0;
  let pages = 0;

  while (cursor <= toSec && pages < maxPages) {
    const windowEnd = Math.min(cursor + step * KLINE_PAGE - 1, toSec);
    const page = await fetchKlinePage(symbol, interval, cursor, windowEnd, opts, acquire);
    pages++;

    if (page.length === 0) {
      empties++;
      if (empties >= maxEmpty) break;
      cursor = windowEnd + 1;
      continue;
    }
    empties = 0;

    let last = cursor;
    for (const c of page) {
      if (c.time < fromSec || c.time > toSec) continue;
      if (seen.has(c.time)) continue;
      seen.add(c.time);
      out.push(c);
      if (c.time > last) last = c.time;
    }
    opts.onProgress?.({
      fetched: out.length,
      pages,
      cursorSec: last,
      toSec,
      fraction: toSec > fromSec ? Math.min(1, (last - fromSec) / (toSec - fromSec)) : 1,
    });
    cursor = Math.max(last + step, windowEnd + 1);
  }

  out.sort((a, b) => a.time - b.time);
  if (opts.dropUnclosed === false) return out;
  const nowSec = Math.floor(nowMs() / 1000);
  return out.filter((c) => c.time + step <= nowSec);
}

interface FundingRow {
  symbol?: string;
  fundingRate?: string | number;
  fundingRateTimestamp?: string | number;
}

export function parseFundingRows(rows: readonly FundingRow[] | undefined): FundingEvent[] {
  if (!rows) return [];
  const out: FundingEvent[] = [];
  for (const r of rows) {
    const rate = num(r?.fundingRate);
    const ms = num(r?.fundingRateTimestamp);
    if (!Number.isFinite(rate) || !Number.isFinite(ms)) continue;
    out.push({ time: Math.floor(ms / 1000), rate });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

export interface FetchFundingOptions extends BybitOptions {
  onProgress?: (p: FundingProgress) => void;
}

/**
 * Funding history for [fromSec, toSec].
 *
 * The endpoint rejects a lone `startTime`, and pages newest-first, so the walk
 * runs backwards: ask for `endTime`, take the 200 rows, move `endTime` to just
 * before the oldest one. Two years is roughly eleven requests per symbol.
 */
export async function fetchFundingHistory(
  symbol: string,
  fromSec: number,
  toSec: number,
  opts: FetchFundingOptions = {},
): Promise<FundingEvent[]> {
  if (!(toSec >= fromSec)) return [];
  const baseUrl = opts.baseUrl ?? BYBIT_BASE_URL;
  const acquire = limiterFor(opts);
  const maxPages = opts.maxPages ?? 500;

  const collected = new Map<number, number>();
  let cursorEndMs = toSec * 1000;
  let pages = 0;

  while (pages < maxPages && cursorEndMs >= fromSec * 1000) {
    const params = new URLSearchParams({
      category: opts.category ?? "linear",
      symbol,
      endTime: String(cursorEndMs),
      limit: String(FUNDING_PAGE),
    });
    const result = await request<{ list?: FundingRow[] }>(
      `${baseUrl}/v5/market/funding/history?${params.toString()}`,
      opts,
      acquire,
    );
    pages++;
    const page = parseFundingRows(result?.list);
    if (page.length === 0) break;

    const oldest = page[0].time;
    for (const e of page) collected.set(e.time, e.rate);
    opts.onProgress?.({ fetched: collected.size, pages, oldestSec: oldest, fromSec });

    const nextEnd = oldest * 1000 - 1;
    if (nextEnd >= cursorEndMs) break;
    cursorEndMs = nextEnd;
    if (oldest <= fromSec) break;
  }

  return Array.from(collected.entries())
    .filter(([time]) => time >= fromSec && time <= toSec)
    .map(([time, rate]) => ({ time, rate }))
    .sort((a, b) => a.time - b.time);
}

/**
 * Funding interval in minutes from instruments-info. BTCUSDT is 480, some alts
 * run 240 or 60 — hardcoding eight hours quietly breaks the gap check.
 */
export async function fetchFundingIntervalMinutes(symbol: string, opts: BybitOptions = {}): Promise<number | null> {
  const baseUrl = opts.baseUrl ?? BYBIT_BASE_URL;
  const params = new URLSearchParams({ category: opts.category ?? "linear", symbol });
  const result = await request<{ list?: { fundingInterval?: number | string }[] }>(
    `${baseUrl}/v5/market/instruments-info?${params.toString()}`,
    opts,
    limiterFor(opts),
  );
  const raw = result?.list?.[0]?.fundingInterval;
  const minutes = num(raw);
  return Number.isFinite(minutes) && minutes > 0 ? minutes : null;
}
