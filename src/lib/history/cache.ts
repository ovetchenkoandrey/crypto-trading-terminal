// IndexedDB cache for historical candles, keyed by {symbol, interval}.
// Candles are stored as flat arrays sorted by time ascending. The store keeps
// only one record per (symbol, interval); newly fetched ranges are merged in.
//
// Time is UTC seconds — same format as lightweight-charts expects everywhere
// else in the codebase.

import type { Candle } from "../types";

const DB_NAME    = "trading-app-history";
const DB_VERSION = 1;
const STORE      = "candles";

interface CacheRecord {
  key:      string;     // `${symbol}::${interval}`
  symbol:   string;
  interval: string;
  candles:  Candle[];   // sorted ascending by time
  updatedAt: number;    // UTC seconds, last write
}

function keyOf(symbol: string, interval: string): string {
  return `${symbol}::${interval}`;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function open(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror   = () => reject(req.error);
  });
  return dbPromise;
}

async function readRecord(symbol: string, interval: string): Promise<CacheRecord | null> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(keyOf(symbol, interval));
    req.onsuccess = () => resolve((req.result as CacheRecord) ?? null);
    req.onerror   = () => reject(req.error);
  });
}

async function writeRecord(record: CacheRecord): Promise<void> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(record);
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

/** Return cached candles within [from, to] (inclusive). Empty array if nothing. */
export async function getCachedRange(symbol: string, interval: string, from: number, to: number): Promise<Candle[]> {
  const rec = await readRecord(symbol, interval);
  if (!rec) return [];
  return rec.candles.filter((c) => c.time >= from && c.time <= to);
}

/** Return the [min, max] range we have cached for this {symbol, interval}, or null. */
export async function getCachedSpan(symbol: string, interval: string): Promise<{ from: number; to: number } | null> {
  const rec = await readRecord(symbol, interval);
  if (!rec || rec.candles.length === 0) return null;
  return { from: rec.candles[0].time, to: rec.candles[rec.candles.length - 1].time };
}

/**
 * Merge a batch of newly-fetched candles into the cached array. Duplicates
 * (same `time`) are replaced by the incoming value — useful when the last
 * cached candle was still incomplete and gets corrected later.
 */
export async function mergeCandles(symbol: string, interval: string, incoming: Candle[]): Promise<void> {
  if (incoming.length === 0) return;
  const rec = await readRecord(symbol, interval);
  const merged = mergeSortedByTime(rec?.candles ?? [], incoming);
  await writeRecord({
    key:      keyOf(symbol, interval),
    symbol,
    interval,
    candles:  merged,
    updatedAt: Math.floor(Date.now() / 1000),
  });
}

export async function clearSymbol(symbol: string, interval: string): Promise<void> {
  const db = await open();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(keyOf(symbol, interval));
    tx.oncomplete = () => resolve();
    tx.onerror    = () => reject(tx.error);
  });
}

export async function getCacheSize(): Promise<{ entries: number; candles: number }> {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx  = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const all = (req.result as CacheRecord[]) ?? [];
      const candles = all.reduce((sum, r) => sum + r.candles.length, 0);
      resolve({ entries: all.length, candles });
    };
    req.onerror = () => reject(req.error);
  });
}

// ─── helpers ───────────────────────────────────────────────────────────────

/**
 * Merge two sorted-by-time arrays. Incoming values win on duplicate `time`.
 * Used to "extend" the cached range or correct the last partial candle.
 */
export function mergeSortedByTime(a: Candle[], b: Candle[]): Candle[] {
  if (a.length === 0) return b.slice().sort((x, y) => x.time - y.time);
  if (b.length === 0) return a;
  const map = new Map<number, Candle>();
  for (const c of a) map.set(c.time, c);
  for (const c of b) map.set(c.time, c);   // incoming overrides
  return Array.from(map.values()).sort((x, y) => x.time - y.time);
}
