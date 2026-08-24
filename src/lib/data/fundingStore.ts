import fs from "node:fs";
import path from "node:path";
import { monthOf, monthRange, type MonthKey } from "./months.ts";
import { fundingDir, fundingMonthFile, type Market } from "./paths.ts";

/**
 * Funding history storage, partitioned by month like the candles.
 *
 * Volume here is three orders of magnitude smaller than candles — three events
 * a day, ninety a month — so JSON is the right trade: readable, diffable, and
 * still a single small file per month, which keeps the "no full rewrite on
 * append" property of the candle store.
 */

export interface FundingEvent {
  /** Settlement time, UTC seconds. */
  time: number;
  /** Rate for one interval; 0.0001 = 0.01%. */
  rate: number;
}

export const FUNDING_VERSION = 1;

export interface FundingMonthFile {
  version: number;
  market: string;
  symbol: string;
  month: MonthKey;
  count: number;
  /** From instruments-info when known; used by the gap check. */
  intervalMinutes: number | null;
  firstTime: number;
  lastTime: number;
  /** [time, rate] pairs, ascending. */
  events: [number, number][];
  updatedAt: number;
}

export interface FundingStore {
  readonly root: string;
  listMonths(market: Market, symbol: string): MonthKey[];
  readMonthFile(market: Market, symbol: string, month: MonthKey): FundingMonthFile | null;
  readMonth(market: Market, symbol: string, month: MonthKey): FundingEvent[];
  readRange(market: Market, symbol: string, fromSec: number, toSec: number): FundingEvent[];
  writeMonth(market: Market, symbol: string, month: MonthKey, events: readonly FundingEvent[], intervalMinutes?: number | null): FundingMonthFile;
  merge(market: Market, symbol: string, events: readonly FundingEvent[], intervalMinutes?: number | null): { months: MonthKey[]; written: number };
  stats(market: Market, symbol: string): { months: number; events: number; firstTime: number | null; lastTime: number | null };
}

function writeFileAtomic(file: string, data: string): void {
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

export function createFundingStore(root: string): FundingStore {
  function listMonths(market: Market, symbol: string): MonthKey[] {
    try {
      return fs
        .readdirSync(fundingDir(root, market, symbol))
        .filter((n) => /^\d{4}-\d{2}\.json$/.test(n))
        .map((n) => n.slice(0, 7))
        .sort();
    } catch {
      return [];
    }
  }

  function readMonthFile(market: Market, symbol: string, month: MonthKey): FundingMonthFile | null {
    try {
      const parsed = JSON.parse(fs.readFileSync(fundingMonthFile(root, market, symbol, month), "utf8")) as FundingMonthFile;
      if (parsed?.version !== FUNDING_VERSION || !Array.isArray(parsed.events)) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function readMonth(market: Market, symbol: string, month: MonthKey): FundingEvent[] {
    const file = readMonthFile(market, symbol, month);
    if (!file) return [];
    return file.events.map(([time, rate]) => ({ time, rate }));
  }

  function readRange(market: Market, symbol: string, fromSec: number, toSec: number): FundingEvent[] {
    if (!Number.isFinite(fromSec) || !Number.isFinite(toSec) || toSec < fromSec) return [];
    const out: FundingEvent[] = [];
    for (const m of monthRange(monthOf(fromSec), monthOf(toSec))) {
      for (const e of readMonth(market, symbol, m)) {
        if (e.time >= fromSec && e.time <= toSec) out.push(e);
      }
    }
    return out.sort((a, b) => a.time - b.time);
  }

  function writeMonth(
    market: Market,
    symbol: string,
    month: MonthKey,
    events: readonly FundingEvent[],
    intervalMinutes: number | null = null,
  ): FundingMonthFile {
    const map = new Map<number, number>();
    for (const e of events) {
      if (Number.isFinite(e?.time) && Number.isFinite(e?.rate)) map.set(e.time, e.rate);
    }
    const pairs = Array.from(map.entries()).sort((a, b) => a[0] - b[0]) as [number, number][];
    const previous = readMonthFile(market, symbol, month);
    const file: FundingMonthFile = {
      version: FUNDING_VERSION,
      market,
      symbol,
      month,
      count: pairs.length,
      intervalMinutes: intervalMinutes ?? previous?.intervalMinutes ?? null,
      firstTime: pairs.length ? pairs[0][0] : 0,
      lastTime: pairs.length ? pairs[pairs.length - 1][0] : 0,
      events: pairs,
      updatedAt: Math.floor(Date.now() / 1000),
    };
    writeFileAtomic(fundingMonthFile(root, market, symbol, month), `${JSON.stringify(file, null, 2)}\n`);
    return file;
  }

  /** Splits events by month and rewrites only the months that actually changed. */
  function merge(
    market: Market,
    symbol: string,
    events: readonly FundingEvent[],
    intervalMinutes: number | null = null,
  ): { months: MonthKey[]; written: number } {
    const byMonth = new Map<MonthKey, FundingEvent[]>();
    for (const e of events) {
      if (!Number.isFinite(e?.time) || !Number.isFinite(e?.rate)) continue;
      const m = monthOf(e.time);
      const list = byMonth.get(m);
      if (list) list.push(e);
      else byMonth.set(m, [e]);
    }
    const touched: MonthKey[] = [];
    let written = 0;
    for (const [month, incoming] of Array.from(byMonth.entries()).sort()) {
      const existing = readMonth(market, symbol, month);
      const before = new Map(existing.map((e) => [e.time, e.rate]));
      let changed = false;
      for (const e of incoming) {
        if (before.get(e.time) !== e.rate) changed = true;
        before.set(e.time, e.rate);
      }
      const previous = readMonthFile(market, symbol, month);
      if (!changed && previous && (intervalMinutes ?? null) === (previous.intervalMinutes ?? null)) continue;
      const merged = Array.from(before.entries()).map(([time, rate]) => ({ time, rate }));
      const file = writeMonth(market, symbol, month, merged, intervalMinutes);
      touched.push(month);
      written += file.count;
    }
    return { months: touched, written };
  }

  function stats(market: Market, symbol: string) {
    const months = listMonths(market, symbol);
    let count = 0;
    let firstTime: number | null = null;
    let lastTime: number | null = null;
    for (const m of months) {
      const file = readMonthFile(market, symbol, m);
      if (!file || file.count === 0) continue;
      count += file.count;
      if (firstTime === null || file.firstTime < firstTime) firstTime = file.firstTime;
      if (lastTime === null || file.lastTime > lastTime) lastTime = file.lastTime;
    }
    return { months: months.length, events: count, firstTime, lastTime };
  }

  return { root, listMonths, readMonthFile, readMonth, readRange, writeMonth, merge, stats };
}
