// Funding payments for USDT perpetuals.
//
// A perpetual has no expiry, so longs and shorts exchange a funding payment every
// interval. A position held for a day pays three times at the 8h BTCUSDT interval.
// Ignoring this systematically overstates the P&L of anything held overnight.
//
// Sign convention: `amount` is what hits the account. Negative = paid out.
//   long  + positive rate -> pays
//   long  + negative rate -> receives
//   short + positive rate -> receives
//   short + negative rate -> pays

import type { Side } from "../store";

export interface FundingRateEvent {
  /** Settlement time. Unit must match `FundingOptions.timeUnit` (ms by default). */
  timestamp: number;
  /** Rate for this single interval, 0.0001 = 0.01%. */
  rate: number;
  /** Mark price at settlement. Falls back to the position price when absent. */
  markPrice?: number;
}

export interface FundingPosition {
  side: Side;
  qty: number;
  /** Reference price for the notional when no mark price is available. */
  price: number;
  openedAt: number;
  /** Absent = still open; then `FundingOptions.now` or the last event is used. */
  closedAt?: number;
}

export interface FundingOptions {
  /** BTCUSDT is 480. Some alts run 240 or 60 — read it from instruments-info. */
  intervalMinutes?: number;
  /** Unit of every timestamp in and out. Bybit REST gives ms, our candles give s. */
  timeUnit?: "ms" | "s";
  /** Used as the close time for a still-open position. */
  now?: number;
  /**
   * When the funding history has gaps, synthesize events on the interval grid at
   * this rate. Leaving it undefined means missing history = free funding, which is
   * exactly the optimistic assumption we are trying to avoid.
   */
  fillMissingWithRate?: number;
}

export interface FundingPayment {
  timestamp: number;
  rate: number;
  price: number;
  notional: number;
  /** Negative = the position paid, positive = the position received. */
  amount: number;
  synthetic: boolean;
}

export interface FundingResult {
  /** Net effect on the account. Negative = net paid. */
  total: number;
  /** Absolute sum of everything paid out. */
  paid: number;
  /** Absolute sum of everything received. */
  received: number;
  count: number;
  payments: FundingPayment[];
}

export const DEFAULT_FUNDING_INTERVAL_MINUTES = 480;

/** Typical BTCUSDT funding rate per 8h interval — the long-run mean is mildly positive. */
export const TYPICAL_FUNDING_RATE = 0.0001;

const EMPTY: FundingResult = { total: 0, paid: 0, received: 0, count: 0, payments: [] };

function unitMs(opts: FundingOptions | undefined): number {
  return opts?.timeUnit === "s" ? 1000 : 1;
}

function intervalIn(opts: FundingOptions | undefined): number {
  const m = opts?.intervalMinutes;
  if (typeof m !== "number" || !Number.isFinite(m) || m <= 0) return DEFAULT_FUNDING_INTERVAL_MINUTES;
  return m;
}

/**
 * Funding settlement timestamps strictly after `fromTs` and up to and including
 * `toTs`, aligned to the epoch grid (00:00 / 08:00 / 16:00 UTC for a 480m interval).
 * Timestamps are returned in the same unit as the inputs.
 */
export function fundingSchedule(
  fromTs: number,
  toTs:   number,
  opts?:  FundingOptions,
): number[] {
  if (!Number.isFinite(fromTs) || !Number.isFinite(toTs) || toTs <= fromTs) return [];
  const scale = unitMs(opts);
  const stepMs = intervalIn(opts) * 60_000;
  const step   = stepMs / scale;
  if (!Number.isFinite(step) || step <= 0) return [];

  const out: number[] = [];
  let k = Math.floor(fromTs / step) + 1;
  const guard = Math.ceil((toTs - fromTs) / step) + 2;
  for (let i = 0; i < guard; i++) {
    const ts = k * step;
    if (ts > toTs) break;
    if (ts > fromTs) out.push(ts);
    k++;
  }
  return out;
}

/**
 * Total funding for a position over its lifetime, plus a per-event breakdown.
 *
 * An event counts when it falls strictly after the open and at or before the close:
 * a position opened exactly at a settlement was not held through it, one closed
 * exactly at a settlement was.
 */
export function computeFunding(
  position: FundingPosition,
  history:  readonly FundingRateEvent[] | undefined,
  opts?:    FundingOptions,
): FundingResult {
  if (!position) return { ...EMPTY, payments: [] };
  const qty = Math.abs(position.qty);
  if (!Number.isFinite(qty) || qty <= 0) return { ...EMPTY, payments: [] };
  if (!Number.isFinite(position.price) || position.price <= 0) return { ...EMPTY, payments: [] };
  if (!Number.isFinite(position.openedAt)) return { ...EMPTY, payments: [] };

  const events = (history ?? []).filter(
    (e) => e && Number.isFinite(e.timestamp) && Number.isFinite(e.rate),
  );

  const end = resolveEnd(position, events, opts);
  if (!Number.isFinite(end) || end <= position.openedAt) return { ...EMPTY, payments: [] };

  const inRange = events
    .filter((e) => e.timestamp > position.openedAt && e.timestamp <= end)
    .sort((a, b) => a.timestamp - b.timestamp);

  const merged = dedupe(inRange);
  const withGaps = opts?.fillMissingWithRate === undefined
    ? merged
    : fillGaps(merged, position.openedAt, end, opts);

  const dirSign = position.side === "buy" ? 1 : -1;
  const payments: FundingPayment[] = withGaps.map((e) => {
    const price = Number.isFinite(e.markPrice ?? NaN) && (e.markPrice ?? 0) > 0
      ? (e.markPrice as number)
      : position.price;
    const notional = qty * price;
    const amount = -dirSign * notional * e.rate;
    return {
      timestamp: e.timestamp,
      rate:      e.rate,
      price,
      notional,
      amount,
      synthetic: e.synthetic === true,
    };
  });

  let paid = 0;
  let received = 0;
  for (const p of payments) {
    if (p.amount < 0) paid += -p.amount;
    else received += p.amount;
  }

  return {
    total:    received - paid,
    paid,
    received,
    count:    payments.length,
    payments,
  };
}

interface InternalEvent extends FundingRateEvent {
  synthetic?: boolean;
}

function resolveEnd(
  position: FundingPosition,
  events:   readonly FundingRateEvent[],
  opts?:    FundingOptions,
): number {
  if (Number.isFinite(position.closedAt ?? NaN)) return position.closedAt as number;
  if (Number.isFinite(opts?.now ?? NaN)) return opts?.now as number;
  let max = position.openedAt;
  for (const e of events) if (e.timestamp > max) max = e.timestamp;
  return max;
}

function dedupe(sorted: readonly FundingRateEvent[]): InternalEvent[] {
  const out: InternalEvent[] = [];
  for (const e of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.timestamp === e.timestamp) out[out.length - 1] = { ...e };
    else out.push({ ...e });
  }
  return out;
}

function fillGaps(
  events: InternalEvent[],
  from:   number,
  to:     number,
  opts:   FundingOptions,
): InternalEvent[] {
  const scale = unitMs(opts);
  const stepMs = intervalIn(opts) * 60_000;
  const tolerance = Math.min(60_000, stepMs / 4) / scale;
  const grid = fundingSchedule(from, to, opts);
  const rate = opts.fillMissingWithRate ?? 0;

  const out = [...events];
  for (const g of grid) {
    const covered = events.some((e) => Math.abs(e.timestamp - g) <= tolerance);
    if (!covered) out.push({ timestamp: g, rate, synthetic: true });
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}

/** Funding applied to a realized P&L figure. */
export function netPnlAfterFunding(pnl: number, funding: FundingResult | undefined): number {
  if (!funding || !Number.isFinite(funding.total)) return pnl;
  return pnl + funding.total;
}

/** Per-interval rate expressed as a yearly figure — useful for sanity checks. */
export function annualizeFundingRate(ratePerInterval: number, intervalMinutes: number): number {
  if (!Number.isFinite(ratePerInterval)) return 0;
  const m = Number.isFinite(intervalMinutes) && intervalMinutes > 0
    ? intervalMinutes
    : DEFAULT_FUNDING_INTERVAL_MINUTES;
  const perYear = (365 * 24 * 60) / m;
  return ratePerInterval * perYear;
}

interface BybitFundingRow {
  fundingRate?: string | number;
  fundingRateTimestamp?: string | number;
}

/** Parses `/v5/market/funding/history` rows into events. Timestamps stay in ms. */
export function fundingEventsFromBybit(rows: readonly BybitFundingRow[] | undefined): FundingRateEvent[] {
  if (!rows) return [];
  const out: FundingRateEvent[] = [];
  for (const r of rows) {
    const rate = typeof r.fundingRate === "number" ? r.fundingRate : parseFloat(String(r.fundingRate ?? ""));
    const ts = typeof r.fundingRateTimestamp === "number"
      ? r.fundingRateTimestamp
      : parseInt(String(r.fundingRateTimestamp ?? ""), 10);
    if (!Number.isFinite(rate) || !Number.isFinite(ts)) continue;
    out.push({ timestamp: ts, rate });
  }
  return out.sort((a, b) => a.timestamp - b.timestamp);
}
