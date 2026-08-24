import { createHash } from "node:crypto";
import type { Candle } from "../types.ts";
import { parseKlineCsv, type TimeUnit } from "./binanceCsv.ts";
import type { DataInterval } from "./interval.ts";
import { fetchBuffer, fetchText, isNotFound, type HttpOptions } from "./http.ts";
import type { Market } from "./paths.ts";
import { readSingleZipEntry } from "./zip.ts";

/**
 * Downloader for the public Binance data archives — no key, no registration,
 * a SHA256 sidecar next to every file.
 *
 *   https://data.binance.vision/data/futures/um/monthly/klines/BTCUSDT/1m/BTCUSDT-1m-2025-03.zip
 *
 * Monthly files appear a few days into the following month; daily files lag the
 * present by roughly three days. Whatever is newer than that has to come from
 * the exchange REST API instead.
 */

export const BINANCE_ARCHIVE_BASE = "https://data.binance.vision";

export type Granularity = "monthly" | "daily";

export interface ArchiveRef {
  market: Market;
  symbol: string;
  interval: DataInterval;
  granularity: Granularity;
  /** "2025-03" for monthly, "2025-03-14" for daily. */
  period: string;
}

export interface ArchiveOptions extends HttpOptions {
  baseUrl?: string;
  /** Skipping verification is only for tests; a silently corrupt month is worse than a slow one. */
  verifyChecksum?: boolean;
  /** Re-download attempts when the checksum does not match. */
  checksumRetries?: number;
}

export interface ArchiveResult {
  ref: ArchiveRef;
  url: string;
  candles: Candle[];
  zipBytes: number;
  csvBytes: number;
  sha256: string;
  checksumVerified: boolean;
  csvName: string;
  header: string[] | null;
  timeUnit: TimeUnit;
  rows: number;
  malformed: number;
}

export class ChecksumError extends Error {
  constructor(url: string, expected: string, actual: string) {
    super(`checksum mismatch for ${url}: expected ${expected}, got ${actual}`);
    this.name = "ChecksumError";
  }
}

function marketSegment(market: Market): string {
  return market === "linear" ? "futures/um" : "spot";
}

export function archiveFileName(ref: ArchiveRef): string {
  return `${ref.symbol}-${ref.interval}-${ref.period}.zip`;
}

export function archiveUrl(ref: ArchiveRef, baseUrl = BINANCE_ARCHIVE_BASE): string {
  return [
    baseUrl.replace(/\/+$/, ""),
    "data",
    marketSegment(ref.market),
    ref.granularity,
    "klines",
    ref.symbol,
    ref.interval,
    archiveFileName(ref),
  ].join("/");
}

export function checksumUrl(ref: ArchiveRef, baseUrl = BINANCE_ARCHIVE_BASE): string {
  return `${archiveUrl(ref, baseUrl)}.CHECKSUM`;
}

/** The sidecar is one line: `<hex>  <filename>`. */
export function parseChecksum(text: string): string {
  const hex = String(text ?? "").trim().split(/\s+/)[0] ?? "";
  if (!/^[0-9a-f]{64}$/i.test(hex)) throw new Error(`unreadable CHECKSUM payload: "${String(text).slice(0, 80)}"`);
  return hex.toLowerCase();
}

export function sha256Hex(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Downloads, verifies, unzips and parses one archive file.
 * Throws `HttpError(404)` when the period is not published yet.
 */
export async function downloadArchive(ref: ArchiveRef, opts: ArchiveOptions = {}): Promise<ArchiveResult> {
  const base = opts.baseUrl ?? BINANCE_ARCHIVE_BASE;
  const url = archiveUrl(ref, base);
  const verify = opts.verifyChecksum !== false;
  const attempts = Math.max(0, opts.checksumRetries ?? 1) + 1;

  let expected: string | null = null;
  if (verify) {
    expected = parseChecksum(await fetchText(checksumUrl(ref, base), opts));
  }

  let lastMismatch: ChecksumError | null = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const zip = await fetchBuffer(url, opts);
    const digest = sha256Hex(zip);
    if (expected && digest !== expected) {
      lastMismatch = new ChecksumError(url, expected, digest);
      continue;
    }
    const entry = readSingleZipEntry(zip);
    const parsed = parseKlineCsv(entry.data.toString("utf8"));
    return {
      ref,
      url,
      candles: parsed.candles,
      zipBytes: zip.length,
      csvBytes: entry.data.length,
      sha256: digest,
      checksumVerified: expected !== null,
      csvName: entry.name,
      header: parsed.header,
      timeUnit: parsed.timeUnit,
      rows: parsed.rows,
      malformed: parsed.malformed,
    };
  }
  throw lastMismatch ?? new Error(`failed to download ${url}`);
}

/** Same as `downloadArchive` but returns null when the file does not exist yet. */
export async function tryDownloadArchive(ref: ArchiveRef, opts: ArchiveOptions = {}): Promise<ArchiveResult | null> {
  try {
    return await downloadArchive(ref, opts);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}
