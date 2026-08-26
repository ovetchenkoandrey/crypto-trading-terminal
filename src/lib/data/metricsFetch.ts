import { dateRange } from "./bookDepthArchive.ts";
import { createRateLimiter, isNotFound, type HttpOptions } from "./http.ts";
import {
  tryDownloadMetricsDay,
  type MetricsDownload,
  type MetricsDownloadOptions,
  type MetricsRow,
} from "./metricsArchive.ts";
import { createMetricsStore, type MetricsMonthMeta } from "./metricsStore.ts";
import { monthRange, type MonthKey } from "./months.ts";
import { normalizeSymbol } from "./paths.ts";

/**
 * Downloads the daily positioning archives and lands them in the metrics store.
 *
 * There is no monthly roll-up for this dataset, so six years of one symbol is
 * about two thousand small requests. Work is organised month by month: the days
 * of a month are fetched by a small pool of workers, then written once. That
 * keeps memory at one month of rows, makes every write atomic at a natural
 * boundary, and means an interrupted run resumes at the month it died in
 * instead of at the beginning.
 *
 * A 404 is not an error here. Binance began publishing this dataset on
 * 2020-09-01 for BTCUSDT and 2021-12-01 for the rest, and the newest day appears
 * a day or two late, so the range asked for legitimately runs past both ends.
 */

export interface FetchMetricsOptions {
  root: string;
  symbols: string[];
  /** YYYY-MM-DD, inclusive. */
  fromDay: string;
  toDay: string;
  /** Re-download days already on disk. */
  force?: boolean;
  /** Parallel in-flight downloads. */
  concurrency?: number;
  /** Ceiling on request rate, requests per second. */
  rps?: number;
  verifyChecksum?: boolean;
  http?: MetricsDownloadOptions;
  onProgress?: (message: string) => void;
}

export interface SymbolFetchResult {
  symbol: string;
  daysRequested: number;
  daysCached: number;
  daysDownloaded: number;
  /** Days the archive does not have — before listing, or not published yet. */
  daysMissing: number;
  missingDays: string[];
  rows: number;
  zipBytes: number;
  malformed: number;
  emptyFields: Record<string, number>;
  /** Days whose file held something other than the 288 expected rows. */
  shortDays: { day: string; rows: number }[];
  months: MonthKey[];
  firstDay: string | null;
  lastDay: string | null;
}

export interface FetchMetricsResult {
  symbols: SymbolFetchResult[];
  elapsedMs: number;
}

function monthOfDay(day: string): MonthKey {
  return day.slice(0, 7);
}

async function pool<T, R>(
  items: readonly T[],
  workers: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const run = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(workers, items.length)) }, run));
  return out;
}

export async function fetchMetrics(opts: FetchMetricsOptions): Promise<FetchMetricsResult> {
  const started = Date.now();
  const say = opts.onProgress ?? ((): void => {});
  const store = createMetricsStore(opts.root);
  const days = dateRange(opts.fromDay, opts.toDay);
  const concurrency = Math.max(1, opts.concurrency ?? 6);
  const acquire = createRateLimiter(opts.rps ?? 12);
  const http: MetricsDownloadOptions = {
    ...(opts.http ?? {}),
    verifyChecksum: opts.verifyChecksum ?? opts.http?.verifyChecksum ?? true,
  };

  const results: SymbolFetchResult[] = [];

  for (const raw of opts.symbols) {
    const symbol = normalizeSymbol(raw);
    const have = opts.force ? new Set<string>() : store.storedDays(symbol);
    const res: SymbolFetchResult = {
      symbol,
      daysRequested: days.length,
      daysCached: 0,
      daysDownloaded: 0,
      daysMissing: 0,
      missingDays: [],
      rows: 0,
      zipBytes: 0,
      malformed: 0,
      emptyFields: {},
      shortDays: [],
      months: [],
      firstDay: null,
      lastDay: null,
    };

    const byMonth = new Map<MonthKey, string[]>();
    for (const day of days) {
      const m = monthOfDay(day);
      const list = byMonth.get(m) ?? [];
      list.push(day);
      byMonth.set(m, list);
    }

    for (const month of monthRange(monthOfDay(days[0]), monthOfDay(days[days.length - 1]))) {
      const wanted = (byMonth.get(month) ?? []).filter((d) => !have.has(d));
      res.daysCached += (byMonth.get(month) ?? []).length - wanted.length;
      if (wanted.length === 0) continue;

      say(`${symbol} ${month}: ${wanted.length} day(s)`);
      const downloads = await pool(wanted, concurrency, async (day) => {
        await acquire();
        try {
          return await tryDownloadMetricsDay({ symbol, date: day }, http);
        } catch (err) {
          if (isNotFound(err)) return null;
          throw err;
        }
      });

      const rows: MetricsRow[] = [];
      let touched = false;
      downloads.forEach((d: MetricsDownload | null, i) => {
        const day = wanted[i];
        if (!d) {
          res.daysMissing++;
          if (res.missingDays.length < 60) res.missingDays.push(day);
          return;
        }
        touched = true;
        res.daysDownloaded++;
        res.zipBytes += d.zipBytes;
        res.malformed += d.malformed;
        for (const [k, v] of Object.entries(d.emptyFields)) {
          res.emptyFields[k] = (res.emptyFields[k] ?? 0) + v;
        }
        if (d.rows.length !== 288) res.shortDays.push({ day, rows: d.rows.length });
        rows.push(...d.rows);
      });

      if (touched) {
        const meta: MetricsMonthMeta = store.mergeMonth(symbol, month, rows);
        res.months.push(month);
        say(`  ${symbol} ${month}: stored ${meta.count} rows over ${meta.days.length} day(s)`);
      }
    }

    const stats = store.stats(symbol);
    res.rows = stats.rows;
    res.firstDay = stats.firstTime === null ? null : new Date(stats.firstTime * 1000).toISOString().slice(0, 10);
    res.lastDay = stats.lastTime === null ? null : new Date(stats.lastTime * 1000).toISOString().slice(0, 10);
    results.push(res);
  }

  return { symbols: results, elapsedMs: Date.now() - started };
}
