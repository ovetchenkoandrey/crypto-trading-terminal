import path from "node:path";
import type { DataInterval } from "./interval.ts";
import type { MonthKey } from "./months.ts";

/** Which Bybit product the dataset describes. The project trades `linear`. */
export type Market = "linear" | "spot";

export interface DatasetKey {
  market: Market;
  symbol: string;
  interval: DataInterval;
}

export const DATA_DIR_ENV = "TRADING_DATA_DIR";

/**
 * Datasets live in `data/` at the repo root by default. The CLI can point
 * elsewhere with `--data-dir`, and tests always pass a temp directory.
 */
export function resolveDataRoot(explicit?: string): string {
  const raw = explicit ?? process.env[DATA_DIR_ENV] ?? "data";
  return path.resolve(raw);
}

/**
 * Symbols reach us from CLI arguments and end up as path segments, so anything
 * that is not a plain ticker is rejected rather than escaped.
 */
export function normalizeSymbol(symbol: string): string {
  const upper = String(symbol ?? "").trim().toUpperCase();
  if (!/^[A-Z0-9]{2,32}$/.test(upper)) throw new Error(`bad symbol "${symbol}"`);
  return upper;
}

export function datasetLabel(key: DatasetKey): string {
  return `${key.market}:${key.symbol}:${key.interval}`;
}

export function candlesDir(root: string, key: DatasetKey): string {
  return path.join(root, "candles", key.market, normalizeSymbol(key.symbol), key.interval);
}

export function monthDataFile(root: string, key: DatasetKey, month: MonthKey): string {
  return path.join(candlesDir(root, key), `${month}.bin`);
}

export function monthMetaFile(root: string, key: DatasetKey, month: MonthKey): string {
  return path.join(candlesDir(root, key), `${month}.json`);
}

export function fundingDir(root: string, market: Market, symbol: string): string {
  return path.join(root, "funding", market, normalizeSymbol(symbol));
}

export function fundingMonthFile(root: string, market: Market, symbol: string, month: MonthKey): string {
  return path.join(fundingDir(root, market, symbol), `${month}.json`);
}

export function reportsDir(root: string): string {
  return path.join(root, "reports");
}

export function reportFile(root: string, name: string): string {
  return path.join(reportsDir(root), name);
}
