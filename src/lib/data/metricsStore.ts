import fs from "node:fs";
import path from "node:path";
import { METRICS_STEP_SEC, type MetricsRow } from "./metricsArchive.ts";
import { monthOf, monthRange, type MonthKey } from "./months.ts";
import { normalizeSymbol } from "./paths.ts";

/**
 * On-disk store for the positioning metrics.
 *
 * Deliberately not the candle store. A metrics row is seven numbers on a
 * five-minute grid with its own start date, its own holes and its own notion of
 * a complete day; forcing it into a `Candle` would mean inventing an open, a
 * high and a low, and then every reader downstream would have to remember which
 * of the six columns had been smuggled into `volume`.
 *
 *   data/metrics/binance/BTCUSDT/2024-06.bin    288 * 30 * 56 bytes
 *   data/metrics/binance/BTCUSDT/2024-06.json   count, span, days, bytes
 *
 * The shape follows the candle store for the same reasons: one file per calendar
 * month so adding a month never rewrites an old one, a fixed record stride so a
 * month is a plain sorted array, and the sidecar written after the data so a
 * download killed halfway is detectable rather than silently short.
 */

export const FIELDS = 7;
export const RECORD_SIZE = FIELDS * 8;
export const META_VERSION = 1;

export function metricsDir(root: string, symbol: string): string {
  return path.join(root, "metrics", "binance", normalizeSymbol(symbol));
}

export function metricsMonthDataFile(root: string, symbol: string, month: MonthKey): string {
  return path.join(metricsDir(root, symbol), `${month}.bin`);
}

export function metricsMonthMetaFile(root: string, symbol: string, month: MonthKey): string {
  return path.join(metricsDir(root, symbol), `${month}.json`);
}

export function encodeMetrics(rows: readonly MetricsRow[]): Buffer {
  const buf = Buffer.allocUnsafe(rows.length * RECORD_SIZE);
  let off = 0;
  for (const r of rows) {
    buf.writeDoubleLE(r.timeSec, off);
    buf.writeDoubleLE(r.openInterest, off + 8);
    buf.writeDoubleLE(r.openInterestValue, off + 16);
    buf.writeDoubleLE(r.topTraderAccountRatio, off + 24);
    buf.writeDoubleLE(r.topTraderPositionRatio, off + 32);
    buf.writeDoubleLE(r.accountRatio, off + 40);
    buf.writeDoubleLE(r.takerVolumeRatio, off + 48);
    off += RECORD_SIZE;
  }
  return buf;
}

export function metricsRecordCount(byteLength: number): number {
  return Math.floor(byteLength / RECORD_SIZE);
}

export function decodeMetrics(buf: Buffer): MetricsRow[] {
  const n = metricsRecordCount(buf.length);
  const out: MetricsRow[] = new Array(n);
  let off = 0;
  for (let i = 0; i < n; i++) {
    out[i] = {
      timeSec: buf.readDoubleLE(off),
      openInterest: buf.readDoubleLE(off + 8),
      openInterestValue: buf.readDoubleLE(off + 16),
      topTraderAccountRatio: buf.readDoubleLE(off + 24),
      topTraderPositionRatio: buf.readDoubleLE(off + 32),
      accountRatio: buf.readDoubleLE(off + 40),
      takerVolumeRatio: buf.readDoubleLE(off + 48),
    };
    off += RECORD_SIZE;
  }
  return out;
}

function lowerBound(buf: Buffer, target: number): number {
  let lo = 0;
  let hi = metricsRecordCount(buf.length);
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (buf.readDoubleLE(mid * RECORD_SIZE) < target) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

export interface MetricsMonthMeta {
  version: number;
  symbol: string;
  month: MonthKey;
  count: number;
  firstTime: number;
  lastTime: number;
  bytes: number;
  /** Calendar days (YYYY-MM-DD) that contributed rows, sorted. */
  days: string[];
  updatedAt: number;
}

/** Sorts by time and drops exact timestamp duplicates, keeping the last one seen. */
export function dedupeRows(rows: readonly MetricsRow[]): MetricsRow[] {
  const sorted = rows.slice().sort((a, b) => a.timeSec - b.timeSec);
  const out: MetricsRow[] = [];
  for (const r of sorted) {
    const last = out[out.length - 1];
    if (last && last.timeSec === r.timeSec) out[out.length - 1] = r;
    else out.push(r);
  }
  return out;
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8")) as T;
  } catch {
    return null;
  }
}

function writeFileAtomic(file: string, data: Buffer | string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try {
    fs.writeFileSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function dayOfSec(sec: number): string {
  return new Date(sec * 1000).toISOString().slice(0, 10);
}

export interface MetricsStats {
  months: number;
  rows: number;
  bytes: number;
  firstTime: number | null;
  lastTime: number | null;
  days: number;
}

export interface MetricsStore {
  readonly root: string;
  listMonths(symbol: string): MonthKey[];
  readMeta(symbol: string, month: MonthKey): MetricsMonthMeta | null;
  readMonth(symbol: string, month: MonthKey): MetricsRow[];
  readRange(symbol: string, fromSec: number, toSec: number): MetricsRow[];
  /** Merges `rows` into the month, replacing same-timestamp records. */
  mergeMonth(symbol: string, month: MonthKey, rows: readonly MetricsRow[]): MetricsMonthMeta;
  /** Days already on disk for the symbol, as a set of YYYY-MM-DD. */
  storedDays(symbol: string): Set<string>;
  removeMonth(symbol: string, month: MonthKey): void;
  stats(symbol: string): MetricsStats;
}

export function createMetricsStore(root: string): MetricsStore {
  const readBuffer = (symbol: string, month: MonthKey): Buffer => {
    const file = metricsMonthDataFile(root, symbol, month);
    const meta = readJson<MetricsMonthMeta>(metricsMonthMetaFile(root, symbol, month));
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch {
      return Buffer.alloc(0);
    }
    // Trust the sidecar over the file length: a killed write can leave bytes
    // past the committed end, and those records were never validated.
    if (meta && Number.isFinite(meta.bytes) && meta.bytes >= 0 && meta.bytes <= buf.length) {
      buf = buf.subarray(0, meta.bytes - (meta.bytes % RECORD_SIZE));
    } else {
      buf = buf.subarray(0, buf.length - (buf.length % RECORD_SIZE));
    }
    return buf;
  };

  const store: MetricsStore = {
    root,

    listMonths(symbol) {
      const dir = metricsDir(root, symbol);
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return [];
      }
      return names
        .filter((n) => n.endsWith(".bin"))
        .map((n) => n.slice(0, -4))
        .filter((n) => /^\d{4}-\d{2}$/.test(n))
        .sort();
    },

    readMeta(symbol, month) {
      return readJson<MetricsMonthMeta>(metricsMonthMetaFile(root, symbol, month));
    },

    readMonth(symbol, month) {
      return decodeMetrics(readBuffer(symbol, month));
    },

    readRange(symbol, fromSec, toSec) {
      if (toSec < fromSec) return [];
      const months = monthRange(monthOf(fromSec), monthOf(toSec));
      const out: MetricsRow[] = [];
      for (const month of months) {
        const buf = readBuffer(symbol, month);
        if (buf.length === 0) continue;
        const start = lowerBound(buf, fromSec);
        const end = lowerBound(buf, toSec + 1);
        if (end <= start) continue;
        out.push(...decodeMetrics(buf.subarray(start * RECORD_SIZE, end * RECORD_SIZE)));
      }
      return out;
    },

    mergeMonth(symbol, month, rows) {
      const sym = normalizeSymbol(symbol);
      const existing = decodeMetrics(readBuffer(sym, month));
      const merged = dedupeRows([...existing, ...rows]);
      const buf = encodeMetrics(merged);
      const file = metricsMonthDataFile(root, sym, month);
      writeFileAtomic(file, buf);
      const days = Array.from(new Set(merged.map((r) => dayOfSec(r.timeSec)))).sort();
      const meta: MetricsMonthMeta = {
        version: META_VERSION,
        symbol: sym,
        month,
        count: merged.length,
        firstTime: merged.length > 0 ? merged[0].timeSec : 0,
        lastTime: merged.length > 0 ? merged[merged.length - 1].timeSec : 0,
        bytes: buf.length,
        days,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      writeFileAtomic(metricsMonthMetaFile(root, sym, month), `${JSON.stringify(meta, null, 1)}\n`);
      return meta;
    },

    storedDays(symbol) {
      const out = new Set<string>();
      for (const month of store.listMonths(symbol)) {
        const meta = store.readMeta(symbol, month);
        if (meta?.days) {
          for (const d of meta.days) out.add(d);
          continue;
        }
        for (const r of store.readMonth(symbol, month)) out.add(dayOfSec(r.timeSec));
      }
      return out;
    },

    removeMonth(symbol, month) {
      for (const f of [metricsMonthDataFile(root, symbol, month), metricsMonthMetaFile(root, symbol, month)]) {
        try {
          fs.unlinkSync(f);
        } catch {
          /* already gone */
        }
      }
    },

    stats(symbol) {
      const months = store.listMonths(symbol);
      let rows = 0;
      let bytes = 0;
      let first: number | null = null;
      let last: number | null = null;
      const days = new Set<string>();
      for (const month of months) {
        const meta = store.readMeta(symbol, month);
        if (!meta) continue;
        rows += meta.count;
        bytes += meta.bytes;
        if (meta.count > 0) {
          first = first === null ? meta.firstTime : Math.min(first, meta.firstTime);
          last = last === null ? meta.lastTime : Math.max(last, meta.lastTime);
        }
        for (const d of meta.days ?? []) days.add(d);
      }
      return { months: months.length, rows, bytes, firstTime: first, lastTime: last, days: days.size };
    },
  };

  return store;
}

/** Whole 5-minute slots between two timestamps; NaN when either is unusable. */
export function slotsBetween(fromSec: number, toSec: number): number {
  return (toSec - fromSec) / METRICS_STEP_SEC;
}
