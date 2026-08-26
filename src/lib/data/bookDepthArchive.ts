import fs from "node:fs";
import path from "node:path";
import { createCursor, expectHeader, forEachDataRow, parseNumberSlice } from "./csvBytes.ts";
import { fetchBuffer, type HttpOptions } from "./http.ts";
import { readSingleZipEntry } from "./zip.ts";

/**
 * Binance USD-M futures `bookDepth`: a snapshot roughly every 30 seconds of how
 * much size sits within ±1..5% of mid.
 *
 *   https://data.binance.vision/data/futures/um/daily/bookDepth/BTCUSDT/BTCUSDT-bookDepth-2025-06-01.zip
 *
 * It says nothing about the top of the book, so it cannot price our fills. What
 * it does give — for 450 KB a day, from 2023-01 — is a liquidity profile across
 * the clock and across the week on hundreds of days, which is exactly the shape
 * the dead-hour and weekend multipliers claim to describe. Tardis gives depth at
 * the touch on 24 days; this gives the seasonal shape on many. They are used as
 * two independent measurements of the same thing.
 */

export const BINANCE_ARCHIVE_BASE = "https://data.binance.vision";

export const BOOK_DEPTH_HEADER = ["timestamp", "percentage", "depth", "notional"] as const;

export interface BookDepthRef {
  symbol: string;
  /** YYYY-MM-DD. */
  date: string;
}

export function bookDepthUrl(ref: BookDepthRef, base = BINANCE_ARCHIVE_BASE): string {
  return [
    base.replace(/\/+$/, ""),
    "data/futures/um/daily/bookDepth",
    ref.symbol,
    `${ref.symbol}-bookDepth-${ref.date}.zip`,
  ].join("/");
}

export function bookDepthCachePath(root: string, ref: BookDepthRef): string {
  return path.join(root, "orderbook", "binance", ref.symbol, `bookDepth-${ref.date}.zip`);
}

export interface BookDepthDownloadOptions extends HttpOptions {
  baseUrl?: string;
  force?: boolean;
  /** Never hit the network: a missing day is an error, not a download. */
  offline?: boolean;
}

export async function downloadBookDepth(
  root: string,
  ref: BookDepthRef,
  opts: BookDepthDownloadOptions = {},
): Promise<{ file: string; bytes: number; fromCache: boolean; url: string }> {
  const url = bookDepthUrl(ref, opts.baseUrl ?? BINANCE_ARCHIVE_BASE);
  const file = bookDepthCachePath(root, ref);
  if (!opts.force && fs.existsSync(file)) {
    return { file, bytes: fs.statSync(file).size, fromCache: true, url };
  }
  if (opts.offline) throw new Error(`${file}: not cached and --offline was requested`);
  const buf = await fetchBuffer(url, opts);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, file);
  return { file, bytes: buf.length, fromCache: false, url };
}

/* ── parsing ──────────────────────────────────────────────────────────────── */

/** Days since the Unix epoch for a proleptic-Gregorian Y-M-D (days_from_civil). */
export function epochDay(year: number, month: number, day: number): number {
  const y = month <= 2 ? year - 1 : year;
  const era = Math.floor(y / 400);
  const yoe = y - era * 400;
  const doy = Math.floor((153 * (month + (month > 2 ? -3 : 9)) + 2) / 5) + day - 1;
  const doe = yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy;
  return era * 146_097 + doe - 719_468;
}

/**
 * "2025-06-01 00:00:09" is a fixed-width field in every row of every file, so it
 * is read by offset rather than by Date.parse — which would also drag the local
 * time zone into a UTC measurement.
 */
export function parseBookDepthTimestamp(buf: Uint8Array, start: number, end: number): number {
  if (end - start < 19) return NaN;
  const d = (i: number): number => buf[start + i] - 0x30;
  const year = d(0) * 1000 + d(1) * 100 + d(2) * 10 + d(3);
  const month = d(5) * 10 + d(6);
  const day = d(8) * 10 + d(9);
  const hour = d(11) * 10 + d(12);
  const min = d(14) * 10 + d(15);
  const sec = d(17) * 10 + d(18);
  if (!(year > 2000) || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || min > 59 || sec > 60) {
    return NaN;
  }
  return epochDay(year, month, day) * 86_400 + hour * 3600 + min * 60 + sec;
}

export interface BookDepthRow {
  /** UTC seconds. */
  timeSec: number;
  /** -5..-1 (bids below mid) and 1..5 (asks above mid), in percent. */
  percentage: number;
  /** Size in base units. */
  depth: number;
  /** Size in quote units. */
  notional: number;
}

export function forEachBookDepthRow(buf: Uint8Array, onRow: (row: BookDepthRow) => void): number {
  expectHeader(buf, BOOK_DEPTH_HEADER, "binance bookDepth");
  const cur = createCursor();
  const row: BookDepthRow = { timeSec: 0, percentage: 0, depth: 0, notional: 0 };
  let bad = 0;
  forEachDataRow(
    buf,
    (c) => {
      if (c.count < 4) {
        bad++;
        return;
      }
      const t = parseBookDepthTimestamp(buf, c.starts[0], c.ends[0]);
      const pct = parseNumberSlice(buf, c.starts[1], c.ends[1]);
      const depth = parseNumberSlice(buf, c.starts[2], c.ends[2]);
      const notional = parseNumberSlice(buf, c.starts[3], c.ends[3]);
      if (!Number.isFinite(t) || !Number.isFinite(pct) || !(depth >= 0) || !(notional >= 0)) {
        bad++;
        return;
      }
      row.timeSec = t;
      row.percentage = pct;
      row.depth = depth;
      row.notional = notional;
      onRow(row);
    },
    cur,
  );
  return bad;
}

export function readBookDepthZip(file: string): Buffer {
  return readSingleZipEntry(fs.readFileSync(file)).data;
}

/** Every calendar date in [from, to] inclusive, YYYY-MM-DD. */
export function dateRange(from: string, to: string): string[] {
  const parse = (s: string): number => {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ""));
    if (!m) throw new Error(`bad date "${s}", expected YYYY-MM-DD`);
    return epochDay(Number(m[1]), Number(m[2]), Number(m[3]));
  };
  const a = parse(from);
  const b = parse(to);
  if (b < a) throw new Error(`empty range ${from}..${to}`);
  const out: string[] = [];
  for (let d = a; d <= b; d++) out.push(isoFromEpochDay(d));
  return out;
}

/** Inverse of `epochDay` (civil_from_days). */
export function isoFromEpochDay(days: number): string {
  const z = days + 719_468;
  const era = Math.floor(z / 146_097);
  const doe = z - era * 146_097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36_524) - Math.floor(doe / 146_096)) / 365);
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1;
  const m = mp < 10 ? mp + 3 : mp - 9;
  const year = m <= 2 ? y + 1 : y;
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
