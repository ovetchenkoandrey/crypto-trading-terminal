/**
 * UTC month arithmetic. The storage layer partitions every dataset by calendar
 * month, so these helpers are on the hot path of both fetching and reading.
 */

export type MonthKey = string; // "2024-09"
export type DayKey = string;   // "2024-09-05"

const MONTH_RE = /^(\d{4})-(\d{2})$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function monthKey(year: number, month: number): MonthKey {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
}

export function dayKey(year: number, month: number, day: number): DayKey {
  return `${monthKey(year, month)}-${String(day).padStart(2, "0")}`;
}

export function parseMonth(key: string): { year: number; month: number } {
  const m = MONTH_RE.exec(String(key ?? "").trim());
  if (!m) throw new Error(`bad month "${key}", expected YYYY-MM`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  if (month < 1 || month > 12) throw new Error(`bad month "${key}", month out of range`);
  return { year, month };
}

export function isMonthKey(key: string): boolean {
  const m = MONTH_RE.exec(String(key ?? "").trim());
  return m !== null && Number(m[2]) >= 1 && Number(m[2]) <= 12;
}

/** First second of the month, UTC seconds. */
export function monthStartSec(key: MonthKey): number {
  const { year, month } = parseMonth(key);
  return Math.floor(Date.UTC(year, month - 1, 1, 0, 0, 0) / 1000);
}

/** First second of the next month, UTC seconds (exclusive end). */
export function monthEndSec(key: MonthKey): number {
  const { year, month } = parseMonth(key);
  return Math.floor(Date.UTC(year, month, 1, 0, 0, 0) / 1000);
}

export function daysInMonth(key: MonthKey): number {
  return (monthEndSec(key) - monthStartSec(key)) / 86400;
}

export function addMonths(key: MonthKey, delta: number): MonthKey {
  const { year, month } = parseMonth(key);
  const total = year * 12 + (month - 1) + delta;
  return monthKey(Math.floor(total / 12), (total % 12) + 1);
}

/** Month containing the given UTC-seconds timestamp. */
export function monthOf(sec: number): MonthKey {
  const d = new Date(sec * 1000);
  return monthKey(d.getUTCFullYear(), d.getUTCMonth() + 1);
}

export function dayOf(sec: number): DayKey {
  const d = new Date(sec * 1000);
  return dayKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

export function dayStartSec(key: DayKey): number {
  const m = DAY_RE.exec(String(key ?? "").trim());
  if (!m) throw new Error(`bad day "${key}", expected YYYY-MM-DD`);
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 1000);
}

export function addDays(key: DayKey, delta: number): DayKey {
  return dayOf(dayStartSec(key) + delta * 86400);
}

/** Inclusive list of months from `from` to `to`. Empty when `to` precedes `from`. */
export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const a = parseMonth(from);
  const b = parseMonth(to);
  const start = a.year * 12 + (a.month - 1);
  const end = b.year * 12 + (b.month - 1);
  if (end < start) return [];
  const out: MonthKey[] = [];
  for (let i = start; i <= end; i++) out.push(monthKey(Math.floor(i / 12), (i % 12) + 1));
  return out;
}

/** Inclusive list of days inside a month, optionally clipped to `maxSec`. */
export function daysOfMonth(key: MonthKey, maxSec?: number): DayKey[] {
  const total = daysInMonth(key);
  const { year, month } = parseMonth(key);
  const out: DayKey[] = [];
  for (let d = 1; d <= total; d++) {
    const start = Math.floor(Date.UTC(year, month - 1, d) / 1000);
    if (maxSec !== undefined && start > maxSec) break;
    out.push(dayKey(year, month, d));
  }
  return out;
}

/**
 * How many bars a complete month should hold. `capToSec` clips the count for a
 * month that is still running, so a partially-downloaded current month is not
 * reported as full of holes.
 */
export function expectedBarsInMonth(key: MonthKey, intervalSec: number, capToSec?: number): number {
  const start = monthStartSec(key);
  const end = capToSec === undefined ? monthEndSec(key) : Math.min(monthEndSec(key), capToSec);
  if (end <= start) return 0;
  return Math.floor((end - start) / intervalSec);
}

export function toISO(sec: number): string {
  return new Date(sec * 1000).toISOString().replace(".000Z", "Z");
}
