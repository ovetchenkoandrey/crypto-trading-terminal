import type { Interval } from "../types.ts";

/**
 * Canonical interval names for the on-disk dataset. They match the Binance
 * archive path segment, which keeps path building trivial, and map onto the
 * Bybit REST interval codes used for the live tail.
 */
export type DataInterval =
  | "1m" | "3m" | "5m" | "15m" | "30m"
  | "1h" | "2h" | "4h" | "6h" | "12h"
  | "1d";

const SECONDS: Record<DataInterval, number> = {
  "1m": 60,
  "3m": 180,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "2h": 7200,
  "4h": 14400,
  "6h": 21600,
  "12h": 43200,
  "1d": 86400,
};

const BYBIT: Record<DataInterval, Interval> = {
  "1m": "1",
  "3m": "3",
  "5m": "5",
  "15m": "15",
  "30m": "30",
  "1h": "60",
  "2h": "120",
  "4h": "240",
  "6h": "360",
  "12h": "720",
  "1d": "D",
};

const ALIASES: Record<string, DataInterval> = {
  "1": "1m", "3": "3m", "5": "5m", "15": "15m", "30": "30m",
  "60": "1h", "120": "2h", "240": "4h", "360": "6h", "720": "12h",
  "d": "1d", "1440": "1d",
};

export const DATA_INTERVALS = Object.keys(SECONDS) as DataInterval[];

export function isDataInterval(value: string): value is DataInterval {
  return Object.prototype.hasOwnProperty.call(SECONDS, value);
}

/** Bar size in UTC seconds. */
export function intervalSeconds(interval: DataInterval): number {
  return SECONDS[interval];
}

/** Bybit `/v5/market/kline` interval code. */
export function toBybitInterval(interval: DataInterval): Interval {
  return BYBIT[interval];
}

/**
 * Accepts the canonical form plus the notations that show up in the wild:
 * Bybit codes ("1", "60", "D"), MetaTrader style ("M1", "H4", "D1") and any
 * casing. Throws on anything unrecognised rather than silently defaulting,
 * because a wrong interval produces a plausible-looking but wrong dataset.
 */
export function parseInterval(raw: string): DataInterval {
  const value = String(raw ?? "").trim().toLowerCase();
  if (value === "") throw new Error("interval is empty");
  if (isDataInterval(value)) return value;
  if (ALIASES[value]) return ALIASES[value];

  const mt = /^([mhd])(\d+)$/.exec(value);
  if (mt) {
    const candidate = mt[1] === "d" ? "1d" : `${mt[2]}${mt[1]}`;
    if (isDataInterval(candidate)) return candidate;
  }
  throw new Error(`unsupported interval "${raw}" (known: ${DATA_INTERVALS.join(", ")})`);
}
