// Exchange-side order constraints: lot size, price tick, minimum notional.
//
// A backtest that skips these fills orders the exchange would have rejected —
// most often the tiny ones, which is exactly where a "high win rate on small
// positions" illusion comes from.

export interface InstrumentRules {
  symbol:       string;
  minOrderQty:  number;
  qtyStep:      number;
  tickSize:     number;
  /** Minimum order value in quote currency. Bybit linear: 5 USDT. */
  minNotional:  number;
  maxOrderQty?: number;
}

/** Verified against instruments-info on 24.08.2026. */
export const BTCUSDT_RULES: InstrumentRules = {
  symbol:      "BTCUSDT",
  minOrderQty: 0.001,
  qtyStep:     0.001,
  tickSize:    0.1,
  minNotional: 5,
};

/** Fallback when the instrument is unknown. Deliberately not permissive. */
export const DEFAULT_INSTRUMENT_RULES: InstrumentRules = {
  symbol:      "UNKNOWN",
  minOrderQty: 0.001,
  qtyStep:     0.001,
  tickSize:    0.01,
  minNotional: 5,
};

export type RoundMode = "floor" | "ceil" | "nearest";

export type ViolationCode =
  | "invalid_qty"
  | "invalid_price"
  | "qty_below_min"
  | "qty_above_max"
  | "qty_step"
  | "price_tick"
  | "notional_below_min";

export interface OrderViolation {
  code:    ViolationCode;
  message: string;
  /** The value that failed. */
  value:   number;
  /** The limit or step it failed against. */
  limit:   number;
}

export interface OrderValidation {
  ok:         boolean;
  violations: OrderViolation[];
}

export interface OrderDraft {
  qty:   number;
  price: number;
}

export interface NormalizedOrder extends OrderDraft {
  /** True when quantisation actually changed something. */
  adjusted:   boolean;
  ok:         boolean;
  violations: OrderViolation[];
}

/* ── step arithmetic ──────────────────────────────────────────────────────── */

const EPS = 1e-9;

/** Decimal places implied by a step: 0.001 -> 3, 0.1 -> 1, 1 -> 0. */
export function stepDecimals(step: number): number {
  if (!Number.isFinite(step) || step <= 0) return 0;
  const s = step.toString();
  const exp = s.indexOf("e") >= 0 ? s.indexOf("e") : s.indexOf("E");
  if (exp >= 0) {
    const power = parseInt(s.slice(exp + 1), 10);
    const mantissaDecimals = (s.slice(0, exp).split(".")[1] ?? "").length;
    return Math.max(0, Math.min(12, mantissaDecimals - power));
  }
  const dot = s.indexOf(".");
  return dot < 0 ? 0 : Math.min(12, s.length - dot - 1);
}

function roundToDecimals(value: number, decimals: number): number {
  const r = Number(value.toFixed(decimals));
  return Object.is(r, -0) ? 0 : r;
}

/**
 * Snaps a value to a multiple of `step`. Uses a small epsilon so binary noise
 * (0.003 / 0.001 = 2.9999999999999996) does not silently drop a whole step.
 */
export function snapToStep(value: number, step: number, mode: RoundMode = "nearest"): number {
  if (!Number.isFinite(value)) return NaN;
  if (!Number.isFinite(step) || step <= 0) return value;
  const n = value / step;
  const k = mode === "floor" ? Math.floor(n + EPS)
    : mode === "ceil" ? Math.ceil(n - EPS)
    : Math.round(n);
  return roundToDecimals(k * step, stepDecimals(step));
}

export function isMultipleOfStep(value: number, step: number): boolean {
  if (!Number.isFinite(value) || !Number.isFinite(step) || step <= 0) return false;
  const n = value / step;
  const tolerance = Math.max(1e-6, Math.abs(n) * 1e-9);
  return Math.abs(n - Math.round(n)) <= tolerance;
}

/* ── quantisation ─────────────────────────────────────────────────────────── */

function rulesOrDefault(rules: InstrumentRules | undefined): InstrumentRules {
  if (!rules) return DEFAULT_INSTRUMENT_RULES;
  const d = DEFAULT_INSTRUMENT_RULES;
  return {
    symbol:      rules.symbol || d.symbol,
    minOrderQty: pos(rules.minOrderQty, d.minOrderQty),
    qtyStep:     pos(rules.qtyStep, d.qtyStep),
    tickSize:    pos(rules.tickSize, d.tickSize),
    minNotional: Number.isFinite(rules.minNotional) ? Math.max(0, rules.minNotional) : d.minNotional,
    maxOrderQty: Number.isFinite(rules.maxOrderQty ?? NaN) ? rules.maxOrderQty : undefined,
  };
}

function pos(v: number | undefined, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return fallback;
  return v;
}

/**
 * Quantity to the lot step. Floors by default: rounding up can exceed the size
 * the strategy sized for and, at the boundary, the balance it has.
 */
export function quantizeQty(
  qty:   number,
  rules: InstrumentRules | undefined,
  mode:  RoundMode = "floor",
): number {
  const r = rulesOrDefault(rules);
  if (!Number.isFinite(qty)) return NaN;
  const snapped = snapToStep(Math.abs(qty), r.qtyStep, mode);
  return snapped < 0 ? 0 : snapped;
}

/** Price to the tick. */
export function quantizePrice(
  price: number,
  rules: InstrumentRules | undefined,
  mode:  RoundMode = "nearest",
): number {
  const r = rulesOrDefault(rules);
  if (!Number.isFinite(price)) return NaN;
  return snapToStep(price, r.tickSize, mode);
}

/**
 * Tick rounding that can only make a resting limit order worse, never better:
 * a buy is rounded down, a sell up. Rounding the favourable way manufactures
 * fractions of a tick of free edge on every order.
 */
export function quantizeLimitPrice(
  price: number,
  side:  "buy" | "sell",
  rules: InstrumentRules | undefined,
): number {
  return quantizePrice(price, rules, side === "buy" ? "floor" : "ceil");
}

/* ── validation ───────────────────────────────────────────────────────────── */

export function validateOrder(
  order: OrderDraft,
  rules: InstrumentRules | undefined,
): OrderValidation {
  const r = rulesOrDefault(rules);
  const violations: OrderViolation[] = [];
  const qty = order?.qty;
  const price = order?.price;

  if (typeof qty !== "number" || !Number.isFinite(qty) || qty <= 0) {
    violations.push({ code: "invalid_qty", message: "qty must be a positive finite number", value: qty as number, limit: 0 });
  }
  if (typeof price !== "number" || !Number.isFinite(price) || price <= 0) {
    violations.push({ code: "invalid_price", message: "price must be a positive finite number", value: price as number, limit: 0 });
  }
  if (violations.length > 0) return { ok: false, violations };

  if (qty < r.minOrderQty - EPS) {
    violations.push({ code: "qty_below_min", message: `qty ${qty} below minOrderQty ${r.minOrderQty}`, value: qty, limit: r.minOrderQty });
  }
  if (r.maxOrderQty !== undefined && qty > r.maxOrderQty + EPS) {
    violations.push({ code: "qty_above_max", message: `qty ${qty} above maxOrderQty ${r.maxOrderQty}`, value: qty, limit: r.maxOrderQty });
  }
  if (!isMultipleOfStep(qty, r.qtyStep)) {
    violations.push({ code: "qty_step", message: `qty ${qty} is not a multiple of qtyStep ${r.qtyStep}`, value: qty, limit: r.qtyStep });
  }
  if (!isMultipleOfStep(price, r.tickSize)) {
    violations.push({ code: "price_tick", message: `price ${price} is not a multiple of tickSize ${r.tickSize}`, value: price, limit: r.tickSize });
  }

  const notional = qty * price;
  if (notional < r.minNotional - EPS) {
    violations.push({ code: "notional_below_min", message: `notional ${notional} below minNotional ${r.minNotional}`, value: notional, limit: r.minNotional });
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Quantises then validates. What survives here is what the exchange would have
 * accepted; anything else must not become a trade in the backtest.
 */
export function normalizeOrder(
  order: OrderDraft,
  rules: InstrumentRules | undefined,
  opts:  { qtyMode?: RoundMode; priceMode?: RoundMode; side?: "buy" | "sell" } = {},
): NormalizedOrder {
  const qty = quantizeQty(order?.qty, rules, opts.qtyMode ?? "floor");
  const price = opts.side && !opts.priceMode
    ? quantizeLimitPrice(order?.price, opts.side, rules)
    : quantizePrice(order?.price, rules, opts.priceMode ?? "nearest");

  const adjusted = qty !== order?.qty || price !== order?.price;
  const { ok, violations } = validateOrder({ qty, price }, rules);
  return { qty, price, adjusted, ok, violations };
}

/** Smallest qty that satisfies both the lot minimum and the notional minimum. */
export function minTradableQty(price: number, rules: InstrumentRules | undefined): number {
  const r = rulesOrDefault(rules);
  if (!Number.isFinite(price) || price <= 0) return r.minOrderQty;
  const byNotional = snapToStep(r.minNotional / price, r.qtyStep, "ceil");
  return Math.max(r.minOrderQty, byNotional);
}

/* ── Bybit parsing ────────────────────────────────────────────────────────── */

interface BybitInstrumentRaw {
  symbol?: string;
  priceFilter?:   { tickSize?: string | number };
  lotSizeFilter?: {
    minOrderQty?:      string | number;
    maxOrderQty?:      string | number;
    qtyStep?:          string | number;
    minNotionalValue?: string | number;
  };
}

function toNum(v: string | number | undefined): number | undefined {
  if (typeof v === "number") return Number.isFinite(v) ? v : undefined;
  if (typeof v !== "string" || v.length === 0) return undefined;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : undefined;
}

/** Maps a `/v5/market/instruments-info` entry onto our rules. */
export function rulesFromBybitInstrument(raw: BybitInstrumentRaw | undefined): InstrumentRules {
  if (!raw) return { ...DEFAULT_INSTRUMENT_RULES };
  const lot = raw.lotSizeFilter ?? {};
  return {
    symbol:      raw.symbol ?? DEFAULT_INSTRUMENT_RULES.symbol,
    minOrderQty: toNum(lot.minOrderQty) ?? DEFAULT_INSTRUMENT_RULES.minOrderQty,
    qtyStep:     toNum(lot.qtyStep) ?? DEFAULT_INSTRUMENT_RULES.qtyStep,
    tickSize:    toNum(raw.priceFilter?.tickSize) ?? DEFAULT_INSTRUMENT_RULES.tickSize,
    minNotional: toNum(lot.minNotionalValue) ?? DEFAULT_INSTRUMENT_RULES.minNotional,
    maxOrderQty: toNum(lot.maxOrderQty),
  };
}

/** Known instruments, used until the REST list has loaded. */
export const KNOWN_INSTRUMENT_RULES: Record<string, InstrumentRules> = {
  BTCUSDT: BTCUSDT_RULES,
};

export function getInstrumentRules(
  symbol: string,
  table:  Record<string, InstrumentRules> | undefined = KNOWN_INSTRUMENT_RULES,
): InstrumentRules {
  const found = table?.[symbol];
  if (found) return found;
  return { ...DEFAULT_INSTRUMENT_RULES, symbol };
}
