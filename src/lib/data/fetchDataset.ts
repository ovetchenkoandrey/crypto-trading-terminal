import type { Candle } from "../types.ts";
import { tryDownloadArchive, type ArchiveOptions } from "./binanceArchive.ts";
import { fetchFundingHistory, fetchFundingIntervalMinutes, fetchKlines, type BybitOptions } from "./bybitRest.ts";
import { createCandleStore, type CandleSource, type CandleStore } from "./candleStore.ts";
import { createFundingStore, type FundingStore } from "./fundingStore.ts";
import { intervalSeconds } from "./interval.ts";
import {
  dayStartSec,
  daysOfMonth,
  monthEndSec,
  monthRange,
  monthStartSec,
  toISO,
  type MonthKey,
} from "./months.ts";
import type { DatasetKey, Market } from "./paths.ts";

/**
 * Orchestration: work out what is missing, pull it from the cheapest source that
 * has it, and put it in the store.
 *
 * Source order per month, cheapest first:
 *   1. the monthly Binance archive — one request for a whole month, checksummed;
 *   2. the daily Binance archives — for a month that is not packaged yet, they
 *      cover everything up to roughly three days ago;
 *   3. Bybit REST — only the last few days, one request per 1000 bars.
 *
 * Steps 1 and 2 are Binance and step 3 is Bybit, i.e. two different exchanges in
 * one series. That is unavoidable if the tail has to be current, so the seam is
 * recorded in the month metadata and the validator reports the price jump across
 * it instead of pretending the series is homogeneous.
 */

export type FetchPhase = "plan" | "archive" | "daily" | "rest" | "skip" | "funding" | "done";

export interface ProgressEvent {
  phase: FetchPhase;
  month?: MonthKey;
  day?: string;
  monthIndex?: number;
  monthTotal?: number;
  candles?: number;
  bytes?: number;
  message: string;
}

export type MonthAction = "skipped" | "archive" | "daily" | "rest" | "daily+rest" | "unavailable" | "failed";

export interface MonthOutcome {
  month: MonthKey;
  action: MonthAction;
  added: number;
  total: number;
  sources: CandleSource[];
  complete: boolean;
  error?: string;
}

export interface FetchDatasetOptions {
  root: string;
  key: DatasetKey;
  from: MonthKey;
  to: MonthKey;
  /** Refetch months that are already marked complete. */
  force?: boolean;
  /** Follow the tail with Bybit REST. Off means archives only. */
  tail?: boolean;
  /** Use the daily Binance archives before falling back to REST. */
  daily?: boolean;
  archive?: ArchiveOptions;
  bybit?: BybitOptions;
  store?: CandleStore;
  now?: () => number;
  onProgress?: (e: ProgressEvent) => void;
  /** Keep going after a month fails instead of aborting the run. */
  continueOnError?: boolean;
}

export interface FetchDatasetResult {
  key: DatasetKey;
  from: MonthKey;
  to: MonthKey;
  months: MonthOutcome[];
  added: number;
  requests: { archives: number; dailyArchives: number };
  durationMs: number;
}

function clip(candles: readonly Candle[], fromSec: number, toSec: number): Candle[] {
  return candles.filter((c) => c.time >= fromSec && c.time <= toSec);
}

export async function fetchDataset(opts: FetchDatasetOptions): Promise<FetchDatasetResult> {
  const started = Date.now();
  const store = opts.store ?? createCandleStore(opts.root);
  const now = opts.now ?? Date.now;
  const step = intervalSeconds(opts.key.interval);
  const useTail = opts.tail !== false;
  const useDaily = opts.daily !== false;
  const months = monthRange(opts.from, opts.to);
  const report = (e: ProgressEvent) => opts.onProgress?.(e);

  const outcomes: MonthOutcome[] = [];
  let added = 0;
  let archives = 0;
  let dailyArchives = 0;

  for (let i = 0; i < months.length; i++) {
    const month = months[i];
    const nowSec = Math.floor(now() / 1000);
    const monthStart = monthStartSec(month);
    const monthLastBar = monthEndSec(month) - step;
    const monthEnded = monthEndSec(month) <= nowSec;
    const base = { month, monthIndex: i + 1, monthTotal: months.length };

    if (store.inspectMonth(opts.key, month).state === "trailing") store.repairMonth(opts.key, month);
    const meta = store.readMeta(opts.key, month);
    const before = meta?.count ?? 0;

    const homogeneous = meta?.sources.length === 1 && meta.sources[0] === "binance-archive";
    const wantsUpgrade = monthEnded && meta !== null && !homogeneous;

    if (!opts.force && meta?.complete && !wantsUpgrade) {
      report({ ...base, phase: "skip", message: `${month}: ${before} bars already complete` });
      outcomes.push({ month, action: "skipped", added: 0, total: before, sources: meta.sources, complete: true });
      continue;
    }

    try {
      let handled = false;

      if (monthEnded) {
        report({ ...base, phase: "archive", message: `${month}: fetching monthly archive` });
        archives++;
        const archive = await tryDownloadArchive(
          { market: opts.key.market, symbol: opts.key.symbol, interval: opts.key.interval, granularity: "monthly", period: month },
          opts.archive,
        );
        if (archive) {
          const candles = clip(archive.candles, monthStart, monthLastBar);
          const written = store.writeMonth(opts.key, month, candles, {
            sources: ["binance-archive"],
            complete: true,
          });
          added += Math.max(0, written.count - before);
          outcomes.push({
            month,
            action: "archive",
            added: written.count - before,
            total: written.count,
            sources: written.sources,
            complete: true,
          });
          report({
            ...base,
            phase: "archive",
            candles: written.count,
            bytes: archive.zipBytes,
            message: `${month}: ${written.count} bars from monthly archive (${archive.timeUnit} timestamps, ${(archive.zipBytes / 1048576).toFixed(2)} MB)`,
          });
          handled = true;
        }
      }

      if (!handled) {
        const outcome = await fillIncompleteMonth({
          opts,
          store,
          month,
          monthStart,
          monthLastBar,
          monthEnded,
          nowSec,
          step,
          useDaily,
          useTail,
          base,
          report,
          onDailyRequest: () => dailyArchives++,
        });
        added += outcome.added;
        outcomes.push(outcome);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      outcomes.push({ month, action: "failed", added: 0, total: before, sources: meta?.sources ?? [], complete: false, error: message });
      report({ ...base, phase: "archive", message: `${month}: FAILED — ${message}` });
      if (!opts.continueOnError) throw err;
    }
  }

  report({ phase: "done", message: `${added} new bars across ${months.length} month(s)` });
  return {
    key: opts.key,
    from: opts.from,
    to: opts.to,
    months: outcomes,
    added,
    requests: { archives, dailyArchives },
    durationMs: Date.now() - started,
  };
}

interface FillArgs {
  opts: FetchDatasetOptions;
  store: CandleStore;
  month: MonthKey;
  monthStart: number;
  monthLastBar: number;
  monthEnded: boolean;
  nowSec: number;
  step: number;
  useDaily: boolean;
  useTail: boolean;
  base: { month: MonthKey; monthIndex: number; monthTotal: number };
  report: (e: ProgressEvent) => void;
  onDailyRequest: () => void;
}

/**
 * Fills a month the monthly archive does not cover yet: daily archives first,
 * then whatever is still missing from Bybit REST. Resumes from the last bar on
 * disk, so re-running only pulls what appeared since.
 */
async function fillIncompleteMonth(args: FillArgs): Promise<MonthOutcome> {
  const { opts, store, month, monthStart, monthLastBar, monthEnded, nowSec, step, base, report } = args;
  const key = opts.key;

  // Last closed bar we are allowed to store.
  const lastClosed = Math.floor(nowSec / step) * step - step;
  const target = Math.min(monthLastBar, lastClosed);

  let meta = store.readMeta(key, month);
  const before = meta?.count ?? 0;
  let cursor = meta && meta.count > 0 ? meta.lastTime + step : monthStart;
  let usedDaily = false;
  let usedRest = false;

  if (target < monthStart) {
    return { month, action: "unavailable", added: 0, total: before, sources: meta?.sources ?? [], complete: false };
  }

  if (args.useDaily) {
    for (const day of daysOfMonth(month, target)) {
      const dayStart = dayStartSec(day);
      const dayEnd = Math.min(dayStart + 86400 - step, target);
      if (dayEnd < cursor) continue;
      if (dayStart > target) break;

      report({ ...base, phase: "daily", day, message: `${month}: fetching daily archive ${day}` });
      args.onDailyRequest();
      const archive = await tryDownloadArchive(
        { market: key.market, symbol: key.symbol, interval: key.interval, granularity: "daily", period: day },
        opts.archive,
      );
      if (!archive) break; // not published yet, and neither is anything after it

      const candles = clip(archive.candles, cursor, dayEnd);
      if (candles.length > 0) {
        meta = store.appendMonth(key, month, candles, { source: "binance-archive" });
        cursor = meta.lastTime + step;
        usedDaily = true;
        report({
          ...base,
          phase: "daily",
          day,
          candles: meta.count,
          message: `${month}: +${candles.length} bars from ${day}`,
        });
      }
    }
  }

  if (args.useTail && cursor <= target) {
    report({ ...base, phase: "rest", message: `${month}: Bybit REST ${toISO(cursor)} .. ${toISO(target)}` });
    const candles = await fetchKlines(key.symbol, key.interval, cursor, target, {
      category: key.market === "spot" ? "spot" : "linear",
      ...opts.bybit,
      now: opts.now ?? opts.bybit?.now,
      onProgress: (p) => report({ ...base, phase: "rest", candles: p.fetched, message: `${month}: REST ${p.fetched} bars, page ${p.pages}` }),
    });
    const fresh = clip(candles, cursor, target);
    if (fresh.length > 0) {
      meta = store.appendMonth(key, month, fresh, { source: "bybit-rest" });
      cursor = meta.lastTime + step;
      usedRest = true;
      report({ ...base, phase: "rest", candles: meta.count, message: `${month}: +${fresh.length} bars from Bybit REST` });
    }
  }

  const complete = monthEnded && meta !== null && meta.count > 0 && meta.lastTime >= monthLastBar;
  if (meta && complete !== meta.complete) {
    meta = store.setComplete(key, month, complete) ?? meta;
  }

  const action: MonthAction =
    usedDaily && usedRest ? "daily+rest" : usedDaily ? "daily" : usedRest ? "rest" : "unavailable";

  return {
    month,
    action,
    added: (meta?.count ?? 0) - before,
    total: meta?.count ?? 0,
    sources: meta?.sources ?? [],
    complete,
  };
}

export interface FetchFundingOptions {
  root: string;
  market: Market;
  symbol: string;
  from: MonthKey;
  to: MonthKey;
  force?: boolean;
  bybit?: BybitOptions;
  store?: FundingStore;
  now?: () => number;
  onProgress?: (e: ProgressEvent) => void;
}

export interface FetchFundingResult {
  symbol: string;
  fromSec: number;
  toSec: number;
  fetched: number;
  monthsWritten: MonthKey[];
  intervalMinutes: number | null;
  durationMs: number;
}

/**
 * Funding history into the same store. Only the segments that are not on disk
 * are requested — leading hole, trailing hole — so a re-run costs one request.
 */
export async function fetchFundingDataset(opts: FetchFundingOptions): Promise<FetchFundingResult> {
  const started = Date.now();
  const store = opts.store ?? createFundingStore(opts.root);
  const now = opts.now ?? Date.now;
  const nowSec = Math.floor(now() / 1000);

  const fromSec = monthStartSec(opts.from);
  const toSec = Math.min(monthEndSec(opts.to) - 1, nowSec);
  if (toSec < fromSec) {
    return { symbol: opts.symbol, fromSec, toSec, fetched: 0, monthsWritten: [], intervalMinutes: null, durationMs: Date.now() - started };
  }

  let intervalMinutes: number | null = null;
  try {
    intervalMinutes = await fetchFundingIntervalMinutes(opts.symbol, opts.bybit ?? {});
  } catch {
    intervalMinutes = null;
  }

  const existing = opts.force ? [] : store.readRange(opts.market, opts.symbol, fromSec, toSec);
  const segments: { from: number; to: number }[] = [];
  if (existing.length === 0) {
    segments.push({ from: fromSec, to: toSec });
  } else {
    const first = existing[0].time;
    const last = existing[existing.length - 1].time;
    if (first > fromSec) segments.push({ from: fromSec, to: first - 1 });
    if (last < toSec) segments.push({ from: last + 1, to: toSec });
  }

  let fetched = 0;
  const written = new Set<MonthKey>();
  for (const seg of segments) {
    opts.onProgress?.({ phase: "funding", message: `funding ${opts.symbol}: ${toISO(seg.from)} .. ${toISO(seg.to)}` });
    const events = await fetchFundingHistory(opts.symbol, seg.from, seg.to, {
      category: opts.market === "spot" ? "spot" : "linear",
      ...opts.bybit,
      onProgress: (p) => opts.onProgress?.({ phase: "funding", message: `funding ${opts.symbol}: ${p.fetched} events, page ${p.pages}` }),
    });
    fetched += events.length;
    const res = store.merge(opts.market, opts.symbol, events, intervalMinutes);
    for (const m of res.months) written.add(m);
  }

  return {
    symbol: opts.symbol,
    fromSec,
    toSec,
    fetched,
    monthsWritten: Array.from(written).sort(),
    intervalMinutes,
    durationMs: Date.now() - started,
  };
}
