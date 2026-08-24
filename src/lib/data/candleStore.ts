import fs from "node:fs";
import path from "node:path";
import type { Candle } from "../types.ts";
import { RECORD_SIZE, decodeCandles, decodeRange, encodeCandles, isWholeRecords, recordCount } from "./codec.ts";
import { monthOf, monthRange, type MonthKey } from "./months.ts";
import { dedupeSorted, mergeCandles, sortByTime } from "./ranges.ts";
import { candlesDir, monthDataFile, monthMetaFile, type DatasetKey } from "./paths.ts";

/**
 * On-disk candle store: one fixed-width binary file per (market, symbol,
 * interval, calendar month) plus a JSON sidecar.
 *
 *   data/candles/linear/BTCUSDT/1m/2025-03.bin    43200 * 48 bytes
 *   data/candles/linear/BTCUSDT/1m/2025-03.json   count, span, source, bytes
 *
 * Why this shape:
 *  - fetching another month never rewrites a byte of the months already on
 *    disk, which is what killed the IndexedDB cache (one blob per series,
 *    rewritten per page — quadratic on a year of minutes);
 *  - a month is a plain array of records, so reading a range is a `readFileSync`
 *    plus a binary search, with no parsing and no allocation per field;
 *  - the sidecar is written after the data file and records the committed byte
 *    length, so a download killed halfway leaves a detectable state instead of a
 *    silently short month;
 *  - there is deliberately no global index file. The month list is a `readdir`,
 *    which cannot go stale and has no write contention.
 */

export const META_VERSION = 2;

export type CandleSource = "binance-archive" | "bybit-rest";

/**
 * Which bars came from where. A month can start in the Binance archives and end
 * on Bybit REST, and the price seam sits wherever the handover happened, not on
 * the month boundary — so the boundary is recorded rather than inferred.
 */
export interface SourceSpan {
  source: CandleSource;
  from: number;
  to: number;
}

export interface MonthMeta {
  version: number;
  market: string;
  symbol: string;
  interval: string;
  month: MonthKey;
  count: number;
  /** First and last bar open time, UTC seconds. */
  firstTime: number;
  lastTime: number;
  /** Committed length of the .bin file. Anything past this is uncommitted. */
  bytes: number;
  sources: CandleSource[];
  sourceSpans: SourceSpan[];
  /** True when the month is finished and must not be refetched. */
  complete: boolean;
  updatedAt: number;
}

export type MonthState = "missing" | "ok" | "trailing" | "truncated" | "corrupt" | "no-meta";

export interface MonthStatus {
  month: MonthKey;
  state: MonthState;
  meta: MonthMeta | null;
  actualBytes: number;
  note?: string;
}

export interface DatasetStats {
  months: number;
  candles: number;
  bytes: number;
  firstTime: number | null;
  lastTime: number | null;
  sources: CandleSource[];
}

export interface CandleStore {
  readonly root: string;
  listMonths(key: DatasetKey): MonthKey[];
  inspectMonth(key: DatasetKey, month: MonthKey): MonthStatus;
  inspectRange(key: DatasetKey, from: MonthKey, to: MonthKey): MonthStatus[];
  readMeta(key: DatasetKey, month: MonthKey): MonthMeta | null;
  readMonth(key: DatasetKey, month: MonthKey): Candle[];
  readRange(key: DatasetKey, fromSec: number, toSec: number): Candle[];
  writeMonth(key: DatasetKey, month: MonthKey, candles: readonly Candle[], opts?: WriteOptions): MonthMeta;
  appendMonth(key: DatasetKey, month: MonthKey, candles: readonly Candle[], opts?: WriteOptions): MonthMeta;
  setComplete(key: DatasetKey, month: MonthKey, complete: boolean): MonthMeta | null;
  repairMonth(key: DatasetKey, month: MonthKey): MonthStatus;
  removeMonth(key: DatasetKey, month: MonthKey): void;
  stats(key: DatasetKey): DatasetStats;
}

export interface WriteOptions {
  source?: CandleSource;
  /** Overrides `source` when a month came from more than one place. */
  sources?: readonly CandleSource[];
  /** Explicit provenance; derived from `source` and the data span when absent. */
  sourceSpans?: readonly SourceSpan[];
  complete?: boolean;
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

function sizeOf(file: string): number {
  try {
    return fs.statSync(file).size;
  } catch {
    return -1;
  }
}

function uniqueSources(list: readonly CandleSource[]): CandleSource[] {
  return Array.from(new Set(list)).sort();
}

/** Sorts spans and folds neighbours that share a source. */
export function normalizeSpans(spans: readonly SourceSpan[]): SourceSpan[] {
  const sorted = spans
    .filter((s) => s && Number.isFinite(s.from) && Number.isFinite(s.to) && s.to >= s.from)
    .slice()
    .sort((a, b) => a.from - b.from);
  const out: SourceSpan[] = [];
  for (const s of sorted) {
    const last = out[out.length - 1];
    if (last && last.source === s.source) {
      if (s.to > last.to) last.to = s.to;
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

export function createCandleStore(root: string): CandleStore {
  function listMonths(key: DatasetKey): MonthKey[] {
    const dir = candlesDir(root, key);
    let names: string[];
    try {
      names = fs.readdirSync(dir);
    } catch {
      return [];
    }
    return names
      .filter((n) => /^\d{4}-\d{2}\.bin$/.test(n))
      .map((n) => n.slice(0, 7))
      .sort();
  }

  function inspectMonth(key: DatasetKey, month: MonthKey): MonthStatus {
    const dataFile = monthDataFile(root, key, month);
    const actualBytes = sizeOf(dataFile);
    if (actualBytes < 0) return { month, state: "missing", meta: null, actualBytes: 0 };

    const meta = readJson<MonthMeta>(monthMetaFile(root, key, month));
    if (!meta || meta.version !== META_VERSION || !Number.isFinite(meta.bytes)) {
      return { month, state: "no-meta", meta: null, actualBytes, note: "sidecar missing or unreadable" };
    }
    if (!isWholeRecords(meta.bytes)) {
      return { month, state: "corrupt", meta, actualBytes, note: `committed length ${meta.bytes} is not a multiple of ${RECORD_SIZE}` };
    }
    if (actualBytes < meta.bytes) {
      return { month, state: "truncated", meta, actualBytes, note: `file is ${meta.bytes - actualBytes} bytes shorter than committed` };
    }
    if (actualBytes > meta.bytes) {
      return { month, state: "trailing", meta, actualBytes, note: `${actualBytes - meta.bytes} uncommitted bytes past the committed end` };
    }
    return { month, state: "ok", meta, actualBytes };
  }

  function inspectRange(key: DatasetKey, from: MonthKey, to: MonthKey): MonthStatus[] {
    return monthRange(from, to).map((m) => inspectMonth(key, m));
  }

  function readMeta(key: DatasetKey, month: MonthKey): MonthMeta | null {
    const status = inspectMonth(key, month);
    return status.state === "ok" || status.state === "trailing" ? status.meta : null;
  }

  /** Committed prefix of a month file, or null when the month is unusable. */
  function readCommitted(key: DatasetKey, month: MonthKey): Buffer | null {
    const status = inspectMonth(key, month);
    if (status.state !== "ok" && status.state !== "trailing") return null;
    const buf = fs.readFileSync(monthDataFile(root, key, month));
    const committed = status.meta!.bytes;
    return buf.length === committed ? buf : buf.subarray(0, committed);
  }

  function readMonth(key: DatasetKey, month: MonthKey): Candle[] {
    const buf = readCommitted(key, month);
    return buf ? decodeCandles(buf) : [];
  }

  function readRange(key: DatasetKey, fromSec: number, toSec: number): Candle[] {
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec < fromSec) return [];
    const months = monthRange(monthOf(fromSec), monthOf(toSec));
    const out: Candle[] = [];
    for (const m of months) {
      const buf = readCommitted(key, m);
      if (!buf) continue;
      const part = decodeRange(buf, fromSec, toSec);
      for (const c of part) out.push(c);
    }
    return out;
  }

  function writeMonth(key: DatasetKey, month: MonthKey, candles: readonly Candle[], opts: WriteOptions = {}): MonthMeta {
    const clean = dedupeSorted(sortByTime(candles));
    const buf = encodeCandles(clean);
    const dataFile = monthDataFile(root, key, month);
    writeFileAtomic(dataFile, buf);

    const spans = normalizeSpans(
      opts.sourceSpans ??
        (opts.source && clean.length > 0
          ? [{ source: opts.source, from: clean[0].time, to: clean[clean.length - 1].time }]
          : []),
    );
    const sources = uniqueSources(
      spans.length > 0 ? spans.map((s) => s.source) : opts.sources ?? (opts.source ? [opts.source] : []),
    );
    const meta: MonthMeta = {
      version: META_VERSION,
      market: key.market,
      symbol: key.symbol,
      interval: key.interval,
      month,
      count: clean.length,
      firstTime: clean.length ? clean[0].time : 0,
      lastTime: clean.length ? clean[clean.length - 1].time : 0,
      bytes: buf.length,
      sources,
      sourceSpans: spans,
      complete: opts.complete ?? false,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    writeFileAtomic(monthMetaFile(root, key, month), `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
  }

  /**
   * Adds candles to a month. When every incoming bar is newer than what is on
   * disk — the normal case while following the tail — the bytes are appended and
   * the rest of the file is untouched. Overlapping input falls back to a
   * read-merge-rewrite of that one month, which is bounded at a couple of MB.
   */
  function appendMonth(key: DatasetKey, month: MonthKey, candles: readonly Candle[], opts: WriteOptions = {}): MonthMeta {
    const incoming = dedupeSorted(sortByTime(candles));
    const status = inspectMonth(key, month);
    const previous = status.state === "ok" || status.state === "trailing" ? status.meta : null;
    const incomingSpans: SourceSpan[] =
      opts.sourceSpans?.slice() ??
      (opts.source && incoming.length > 0
        ? [{ source: opts.source, from: incoming[0].time, to: incoming[incoming.length - 1].time }]
        : []);
    const nextSpans = normalizeSpans([...(previous?.sourceSpans ?? []), ...incomingSpans]);
    const nextSources = uniqueSources([
      ...(previous?.sources ?? []),
      ...(opts.sources ?? (opts.source ? [opts.source] : [])),
      ...incomingSpans.map((s) => s.source),
    ]);

    if (!previous || previous.count === 0) {
      return writeMonth(key, month, incoming, { ...opts, sources: nextSources, sourceSpans: nextSpans });
    }
    if (incoming.length === 0) return previous;

    if (incoming[0].time > previous.lastTime) {
      const dataFile = monthDataFile(root, key, month);
      if (status.state === "trailing") fs.truncateSync(dataFile, previous.bytes);
      const chunk = encodeCandles(incoming);
      const fd = fs.openSync(dataFile, "r+");
      try {
        fs.writeSync(fd, chunk, 0, chunk.length, previous.bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      const bytes = previous.bytes + chunk.length;
      const meta: MonthMeta = {
        ...previous,
        count: recordCount(bytes),
        lastTime: incoming[incoming.length - 1].time,
        bytes,
        sources: nextSources,
        sourceSpans: nextSpans,
        complete: opts.complete ?? previous.complete,
        updatedAt: Math.floor(Date.now() / 1000),
      };
      writeFileAtomic(monthMetaFile(root, key, month), `${JSON.stringify(meta, null, 2)}\n`);
      return meta;
    }

    const merged = mergeCandles(readMonth(key, month), incoming);
    return writeMonth(key, month, merged, {
      ...opts,
      sources: nextSources,
      sourceSpans: nextSpans,
      complete: opts.complete ?? previous.complete,
    });
  }

  /** Flips the "do not refetch" flag without touching the data file. */
  function setComplete(key: DatasetKey, month: MonthKey, complete: boolean): MonthMeta | null {
    const previous = readMeta(key, month);
    if (!previous || previous.complete === complete) return previous;
    const meta: MonthMeta = { ...previous, complete, updatedAt: Math.floor(Date.now() / 1000) };
    writeFileAtomic(monthMetaFile(root, key, month), `${JSON.stringify(meta, null, 2)}\n`);
    return meta;
  }

  /** Drops bytes written past the last committed length — the crash-recovery path. */
  function repairMonth(key: DatasetKey, month: MonthKey): MonthStatus {
    const status = inspectMonth(key, month);
    if (status.state !== "trailing" || !status.meta) return status;
    fs.truncateSync(monthDataFile(root, key, month), status.meta.bytes);
    return inspectMonth(key, month);
  }

  function removeMonth(key: DatasetKey, month: MonthKey): void {
    for (const file of [monthDataFile(root, key, month), monthMetaFile(root, key, month)]) {
      try {
        fs.rmSync(file);
      } catch {
        /* already gone */
      }
    }
  }

  function stats(key: DatasetKey): DatasetStats {
    const months = listMonths(key);
    let candles = 0;
    let bytes = 0;
    let firstTime: number | null = null;
    let lastTime: number | null = null;
    const sources: CandleSource[] = [];
    for (const m of months) {
      const meta = readMeta(key, m);
      if (!meta || meta.count === 0) continue;
      candles += meta.count;
      bytes += meta.bytes;
      sources.push(...meta.sources);
      if (firstTime === null || meta.firstTime < firstTime) firstTime = meta.firstTime;
      if (lastTime === null || meta.lastTime > lastTime) lastTime = meta.lastTime;
    }
    return { months: months.length, candles, bytes, firstTime, lastTime, sources: uniqueSources(sources) };
  }

  return {
    root,
    listMonths,
    inspectMonth,
    inspectRange,
    readMeta,
    readMonth,
    readRange,
    writeMonth,
    appendMonth,
    setComplete,
    repairMonth,
    removeMonth,
    stats,
  };
}
