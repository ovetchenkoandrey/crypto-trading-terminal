import { createHash } from "node:crypto";
import { parseBookDepthTimestamp as parseSpacedTimestamp } from "./bookDepthArchive.ts";
import { createCursor, expectHeader, fieldEquals, forEachDataRow, parseNumberSlice } from "./csvBytes.ts";
import { fetchBuffer, fetchText, isNotFound, type HttpOptions } from "./http.ts";
import { readSingleZipEntry } from "./zip.ts";

/**
 * Binance USD-M futures `metrics`: how the crowd is positioned, every five
 * minutes, from 2020-09 for BTCUSDT and 2021-12 for everything else.
 *
 *   https://data.binance.vision/data/futures/um/daily/metrics/BTCUSDT/BTCUSDT-metrics-2024-06-15.zip
 *
 * 288 rows and 11 KB per day, no key, no registration, with a SHA256 sidecar.
 * The REST endpoint `/futures/data/openInterestHist` serves only the last 30
 * days, which is why open-interest history is widely believed not to exist for
 * free; the archive goes around that wall.
 *
 * This is the first dataset in the project that is not derived from our own
 * price history. Every one of the 63 screened features is a function of OHLCV;
 * these columns are a different kind of information — not where price went, but
 * how much leverage is in the system and which side is holding it.
 *
 * There is no monthly roll-up for this dataset, only daily files.
 */

export const BINANCE_ARCHIVE_BASE = "https://data.binance.vision";

export const METRICS_HEADER = [
  "create_time",
  "symbol",
  "sum_open_interest",
  "sum_open_interest_value",
  "count_toptrader_long_short_ratio",
  "sum_toptrader_long_short_ratio",
  "count_long_short_ratio",
  "sum_taker_long_short_vol_ratio",
] as const;

/** Nominal spacing of the series, seconds. */
export const METRICS_STEP_SEC = 300;

export const METRICS_ROWS_PER_DAY = 86_400 / METRICS_STEP_SEC;

export interface MetricsRef {
  symbol: string;
  /** YYYY-MM-DD. */
  date: string;
}

/**
 * One snapshot. Any of the six measurements can be NaN: Binance occasionally
 * emits an empty field, and a silently-zero column would look like a real
 * reading of "no open interest" or "nobody is long".
 */
export interface MetricsRow {
  /** UTC seconds of the snapshot. */
  timeSec: number;
  /** Open interest in contracts. */
  openInterest: number;
  /** Open interest in quote currency. */
  openInterestValue: number;
  /** Top traders long/short, counted by account. */
  topTraderAccountRatio: number;
  /** Top traders long/short, weighted by position size. */
  topTraderPositionRatio: number;
  /** All accounts long/short, counted by account. */
  accountRatio: number;
  /** Taker buy volume / taker sell volume over the preceding period. */
  takerVolumeRatio: number;
}

export function metricsUrl(ref: MetricsRef, base = BINANCE_ARCHIVE_BASE): string {
  return [
    base.replace(/\/+$/, ""),
    "data/futures/um/daily/metrics",
    ref.symbol,
    `${ref.symbol}-metrics-${ref.date}.zip`,
  ].join("/");
}

export function metricsChecksumUrl(ref: MetricsRef, base = BINANCE_ARCHIVE_BASE): string {
  return `${metricsUrl(ref, base)}.CHECKSUM`;
}

/** The sidecar is one line: `<hex>  <filename>`. */
export function parseChecksum(text: string): string {
  const hex = String(text ?? "").trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) {
    throw new Error(`unreadable CHECKSUM payload: "${String(text).slice(0, 80)}"`);
  }
  return hex.toLowerCase();
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

export interface MetricsParse {
  rows: MetricsRow[];
  /** Rows whose timestamp or symbol could not be read at all. */
  malformed: number;
  /** Non-finite values per measurement column, keyed by field name. */
  emptyFields: Record<string, number>;
}

const NAN = Number.NaN;

/**
 * Reads the CSV straight out of the buffer.
 *
 * The symbol column is checked rather than skipped: a file that carries someone
 * else's ticker is a mixed-up download, and finding that out here is much
 * cheaper than finding it out as a strange correlation three stages later.
 */
export function parseMetricsCsv(buf: Uint8Array, expectSymbol?: string): MetricsParse {
  expectHeader(buf, METRICS_HEADER, "binance metrics");
  const rows: MetricsRow[] = [];
  const emptyFields: Record<string, number> = {
    openInterest: 0,
    openInterestValue: 0,
    topTraderAccountRatio: 0,
    topTraderPositionRatio: 0,
    accountRatio: 0,
    takerVolumeRatio: 0,
  };
  let malformed = 0;

  forEachDataRow(
    buf,
    (c) => {
      if (c.count < METRICS_HEADER.length) {
        malformed++;
        return;
      }
      const t = parseSpacedTimestamp(buf, c.starts[0], c.ends[0]);
      if (!Number.isFinite(t)) {
        malformed++;
        return;
      }
      if (expectSymbol && !fieldEquals(buf, c.starts[1], c.ends[1], expectSymbol)) {
        malformed++;
        return;
      }
      const values = new Array<number>(6);
      for (let f = 0; f < 6; f++) {
        const v = parseNumberSlice(buf, c.starts[f + 2], c.ends[f + 2]);
        values[f] = Number.isFinite(v) ? v : NAN;
      }
      const row: MetricsRow = {
        timeSec: t,
        openInterest: values[0],
        openInterestValue: values[1],
        topTraderAccountRatio: values[2],
        topTraderPositionRatio: values[3],
        accountRatio: values[4],
        takerVolumeRatio: values[5],
      };
      if (!Number.isFinite(row.openInterest)) emptyFields.openInterest++;
      if (!Number.isFinite(row.openInterestValue)) emptyFields.openInterestValue++;
      if (!Number.isFinite(row.topTraderAccountRatio)) emptyFields.topTraderAccountRatio++;
      if (!Number.isFinite(row.topTraderPositionRatio)) emptyFields.topTraderPositionRatio++;
      if (!Number.isFinite(row.accountRatio)) emptyFields.accountRatio++;
      if (!Number.isFinite(row.takerVolumeRatio)) emptyFields.takerVolumeRatio++;
      rows.push(row);
    },
    createCursor(),
  );

  rows.sort((a, b) => a.timeSec - b.timeSec);
  return { rows, malformed, emptyFields };
}

export interface MetricsDownloadOptions extends HttpOptions {
  baseUrl?: string;
  /** Skipping verification is only for tests; a silently corrupt day is worse than a slow one. */
  verifyChecksum?: boolean;
  checksumRetries?: number;
}

export interface MetricsDownload extends MetricsParse {
  ref: MetricsRef;
  url: string;
  zipBytes: number;
  csvBytes: number;
  sha256: string;
  checksumVerified: boolean;
}

export class ChecksumError extends Error {
  constructor(url: string, expected: string, actual: string) {
    super(`checksum mismatch for ${url}: expected ${expected}, got ${actual}`);
    this.name = "ChecksumError";
  }
}

export async function downloadMetricsDay(
  ref: MetricsRef,
  opts: MetricsDownloadOptions = {},
): Promise<MetricsDownload> {
  const base = opts.baseUrl ?? BINANCE_ARCHIVE_BASE;
  const url = metricsUrl(ref, base);
  const verify = opts.verifyChecksum !== false;
  const attempts = Math.max(0, opts.checksumRetries ?? 1) + 1;

  let expected: string | null = null;
  if (verify) expected = parseChecksum(await fetchText(metricsChecksumUrl(ref, base), opts));

  let lastMismatch: ChecksumError | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const zip = await fetchBuffer(url, opts);
    const digest = sha256Hex(zip);
    if (expected && digest !== expected) {
      lastMismatch = new ChecksumError(url, expected, digest);
      continue;
    }
    const entry = readSingleZipEntry(zip);
    const parsed = parseMetricsCsv(entry.data, ref.symbol);
    return {
      ...parsed,
      ref,
      url,
      zipBytes: zip.length,
      csvBytes: entry.data.length,
      sha256: digest,
      checksumVerified: expected !== null,
    };
  }
  throw lastMismatch ?? new Error(`failed to download ${url}`);
}

/** Same as `downloadMetricsDay` but returns null when the day is not published. */
export async function tryDownloadMetricsDay(
  ref: MetricsRef,
  opts: MetricsDownloadOptions = {},
): Promise<MetricsDownload | null> {
  try {
    return await downloadMetricsDay(ref, opts);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}
