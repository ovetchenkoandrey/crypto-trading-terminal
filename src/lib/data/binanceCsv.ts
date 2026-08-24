import type { Candle } from "../types.ts";

/**
 * Parser for the kline CSV inside a Binance data archive.
 *
 * Column order is fixed and has never changed:
 *   open_time, open, high, low, close, volume, close_time, quote_volume,
 *   count, taker_buy_volume, taker_buy_quote_volume, ignore
 *
 * Two things do change and both are handled here:
 *  - a header row appeared in the archives during 2025, older files start
 *    straight at data;
 *  - the timestamp unit. Spot archives switched to microseconds on 2025-01-01;
 *    UM futures are still milliseconds (verified against a real 2026-06 file).
 *    Rather than hardcoding either, the unit is inferred from the magnitude and
 *    reported back so the caller can log what it actually got.
 */

export type TimeUnit = "s" | "ms" | "us";

export interface KlineCsvResult {
  candles: Candle[];
  /** Header cells when the file carried one, else null. */
  header: string[] | null;
  timeUnit: TimeUnit;
  /** Data rows seen, including the ones that failed to parse. */
  rows: number;
  malformed: number;
  malformedSamples: string[];
}

const US_THRESHOLD = 1e14;
const MS_THRESHOLD = 1e11;
const MIN_SANE_SEC = Math.floor(Date.UTC(2010, 0, 1) / 1000);
const MAX_SANE_SEC = Math.floor(Date.UTC(2100, 0, 1) / 1000);

export function detectTimeUnit(rawTimestamp: number): TimeUnit {
  if (rawTimestamp >= US_THRESHOLD) return "us";
  if (rawTimestamp >= MS_THRESHOLD) return "ms";
  return "s";
}

/**
 * The unit is a property of the file, but a single corrupt row must not decide
 * it — reading the first line alone would let one bad timestamp reinterpret
 * every other row and silently produce a file's worth of wrong dates. The median
 * survives outliers at either end.
 */
export function detectTimeUnitFromSamples(raw: readonly number[]): TimeUnit {
  const usable = raw.filter((v) => Number.isFinite(v) && v > 0).sort((a, b) => a - b);
  if (usable.length === 0) return "ms";
  return detectTimeUnit(usable[Math.floor(usable.length / 2)]);
}

export function toSeconds(rawTimestamp: number, unit: TimeUnit): number {
  if (unit === "us") return Math.floor(rawTimestamp / 1_000_000);
  if (unit === "ms") return Math.floor(rawTimestamp / 1000);
  return Math.floor(rawTimestamp);
}

function isHeaderLine(line: string): boolean {
  const firstCell = line.slice(0, line.indexOf(",") === -1 ? line.length : line.indexOf(","));
  return !Number.isFinite(Number(firstCell.trim()));
}

/** Splits a line into at most `max` cells without allocating the tail columns. */
function cells(line: string, max: number): string[] {
  const out: string[] = [];
  let start = 0;
  for (let i = 0; i < max; i++) {
    const comma = line.indexOf(",", start);
    if (comma === -1) {
      out.push(line.slice(start));
      return out;
    }
    out.push(line.slice(start, comma));
    start = comma + 1;
  }
  return out;
}

export function parseKlineCsv(text: string, maxMalformedSamples = 5): KlineCsvResult {
  const lines = text.split("\n");
  const raw: number[] = [];
  const parsed: Candle[] = [];
  const malformedSamples: string[] = [];
  let header: string[] | null = null;
  let malformed = 0;
  let rows = 0;

  function reject(line: string): void {
    malformed++;
    if (malformedSamples.length < maxMalformedSamples) malformedSamples.push(line);
  }

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length === 0) continue;

    if (header === null && rows === 0 && malformed === 0 && isHeaderLine(line)) {
      header = line.split(",").map((c) => c.trim());
      continue;
    }

    rows++;
    const c = cells(line, 6);
    if (c.length < 6) {
      reject(line);
      continue;
    }

    const rawTime = Number(c[0]);
    const open = Number(c[1]);
    const high = Number(c[2]);
    const low = Number(c[3]);
    const close = Number(c[4]);
    const volume = Number(c[5]);

    if (
      !Number.isFinite(rawTime) || !Number.isFinite(open) || !Number.isFinite(high) ||
      !Number.isFinite(low) || !Number.isFinite(close) || !Number.isFinite(volume)
    ) {
      reject(line);
      continue;
    }

    raw.push(rawTime);
    parsed.push({ time: rawTime, open, high, low, close, volume });
  }

  const timeUnit = detectTimeUnitFromSamples(raw);
  const candles: Candle[] = [];
  for (const c of parsed) {
    const time = toSeconds(c.time, timeUnit);
    if (time < MIN_SANE_SEC || time > MAX_SANE_SEC) {
      reject(String(c.time));
      continue;
    }
    candles.push({ ...c, time });
  }

  candles.sort((a, b) => a.time - b.time);
  return { candles, header, timeUnit, rows, malformed, malformedSamples };
}
