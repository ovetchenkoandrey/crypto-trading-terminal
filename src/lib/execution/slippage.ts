// Slippage models for paper/backtest order matching.
// All return an absolute price delta (in quote currency) to be applied to the
// reference fill price. Sign is handled by caller — for a buy we add, for a sell we subtract.

import type { SlippageSettings } from "../settings";
import type { Side, Ticker } from "../store";

/**
 * Returns the effective fill price after applying slippage.
 * @param refPrice  raw fill price before slippage (last/ref/limit)
 * @param side      buy → fills cost more, sell → fills cost less
 * @param qty       order qty (used only for volume_impact)
 * @param ticker    current ticker — only needed for spread_pct
 * @param cfg       slippage settings from store
 */
export function applySlippage(
  refPrice: number,
  side:     Side,
  qty:      number,
  ticker:   Ticker | undefined,
  cfg:      SlippageSettings | undefined,
): number {
  // Defensive: if the slippage config hasn't migrated in yet (e.g. fresh boot from
  // an old persist snapshot), just don't apply slippage at all.
  if (!cfg || cfg.kind === "none" || refPrice <= 0) return refPrice;

  let bps = 0;

  switch (cfg.kind) {
    case "fixed_bps":
      bps = Math.max(0, cfg.bps);
      break;

    case "spread_pct": {
      // Convert bid-ask spread into bps, then take cfg.spreadPct of that.
      if (ticker && ticker.bid1 > 0 && ticker.ask1 > 0) {
        const mid = (ticker.bid1 + ticker.ask1) / 2;
        const spreadBps = ((ticker.ask1 - ticker.bid1) / mid) * 10_000;
        bps = Math.max(0, spreadBps * Math.max(0, Math.min(1, cfg.spreadPct)));
      }
      break;
    }

    case "volume_impact": {
      // Classic sqrt-impact: impact_bps = k * sqrt(qty / refQty).
      const ref = Math.max(1e-9, cfg.impactRefQty);
      bps = Math.max(0, cfg.impactK) * Math.sqrt(Math.max(0, qty) / ref);
      break;
    }
  }

  const delta = refPrice * (bps / 10_000);
  return side === "buy" ? refPrice + delta : Math.max(0, refPrice - delta);
}

/** Human-readable description for the badge / debug log. */
export function describeSlippage(cfg: SlippageSettings): string {
  switch (cfg.kind) {
    case "none":          return "off";
    case "fixed_bps":     return `${cfg.bps} bps`;
    case "spread_pct":    return `${(cfg.spreadPct * 100).toFixed(0)}% spread`;
    case "volume_impact": return `k=${cfg.impactK} / ref=${cfg.impactRefQty}`;
  }
}

/* ─────────────────────────────────────────────────────────────────────────────
   Context multipliers.

   These sit on top of applySlippage as a multiplier on the delta it produced —
   the base models keep their behaviour and their existing tests.

   The hour ALWAYS comes from the bar timestamp, never from the system clock:
   otherwise a backtest is priced by whenever it happened to be launched.

   The defaults below were guesses until 26.08.2026 and are now measurements.
   The headline: on BTCUSDT perpetual the clock barely moves the cost of a trade
   of our size. Full method, sample and intervals in docs/cost-calibration.md;
   re-derive with `npm run calibrate:costs`.
   ───────────────────────────────────────────────────────────────────────────── */

export interface SlippageContextSettings {
  enabled:                 boolean;
  /** UTC hours treated as the liquidity trough. 03:00-06:00 -> 3,4,5. */
  deadHoursUtc:            number[];
  deadHourMultiplier:      number;
  weekendMultiplier:       number;
  volatilityEnabled:       boolean;
  /** Bar range (high-low) as % of close that counts as "normal". */
  volatilityRefPct:        number;
  volatilityMaxMultiplier: number;
  /** Overall cap so a weekend + dead hour + volatile bar cannot run away. */
  maxMultiplier:           number;
}

export const DEFAULT_SLIPPAGE_CONTEXT: SlippageContextSettings = {
  enabled:                 true,
  deadHoursUtc:            [3, 4, 5, 21, 22],
  // Measured 1.00. Over 24 sample days of Bybit BTCUSDT L1 (576 hours of book
  // time, 4.1M priced instants) the mean taker cost in these hours came out at
  // 0.993 of the rest of the day and the spread at 0.992 — the trough hours are
  // marginally cheaper, not 75% dearer. The old 1.75 was borrowed from FX.
  deadHourMultiplier:      1,
  // Measured 1.030 on taker cost (1.032 on spread). Depth at the touch is a
  // different story — the weekend book is 28% thinner — but our order is ~200
  // USDT against a ~215k USDT touch, so it is priced by the spread, not depth.
  weekendMultiplier:       1.03,
  volatilityEnabled:       true,
  // Measured against the cost-by-bar-range curve: cost is flat up to a 0.2%
  // minute range and roughly doubles by 0.6%. A linear ramp from 0.3% tracks
  // that; the old 0.2% made every ordinary bar expensive (median range <= 0.1%).
  volatilityRefPct:        0.3,
  // Weakly supported: only 8 bars in 34,560 had a range above 0.8%, where the
  // measured multiplier was 2.4-2.8. Extrapolation, not measurement.
  volatilityMaxMultiplier: 3,
  maxMultiplier:           4,
};

export interface SlippageBar {
  high:  number;
  low:   number;
  close: number;
}

export interface SlippageContext {
  /** Bar open time in UTC seconds (ms is tolerated and normalised). */
  barTime: number;
  /** Bar being executed on — only used by the volatility component. */
  bar?: SlippageBar;
  /** Overrides cfg.context for this call. */
  contextCfg?: SlippageContextSettings;
}

const SECONDS_PER_DAY = 86_400;

/** Candle times are UTC seconds by project invariant; tolerate ms so a mixed-up
 *  caller gets the right hour instead of a silently wrong one. */
function toSeconds(t: number): number {
  if (!Number.isFinite(t)) return NaN;
  return Math.abs(t) > 1e11 ? Math.floor(t / 1000) : Math.floor(t);
}

/** UTC hour (0-23) of a bar timestamp. Pure arithmetic — no Date, no local zone. */
export function utcHourOfBar(barTime: number): number {
  const s = toSeconds(barTime);
  if (!Number.isFinite(s)) return NaN;
  const secOfDay = ((s % SECONDS_PER_DAY) + SECONDS_PER_DAY) % SECONDS_PER_DAY;
  return Math.floor(secOfDay / 3600);
}

/** UTC day of week, 0 = Sunday. Epoch day 0 (1970-01-01) was a Thursday. */
export function utcDayOfWeekOfBar(barTime: number): number {
  const s = toSeconds(barTime);
  if (!Number.isFinite(s)) return NaN;
  const dayIdx = Math.floor(s / SECONDS_PER_DAY);
  return (((dayIdx + 4) % 7) + 7) % 7;
}

export function isWeekendBar(barTime: number): boolean {
  const d = utcDayOfWeekOfBar(barTime);
  return d === 0 || d === 6;
}

function ctxOrDefault(cfg: SlippageContextSettings | undefined): SlippageContextSettings {
  if (!cfg) return DEFAULT_SLIPPAGE_CONTEXT;
  return {
    enabled:                 cfg.enabled !== false,
    deadHoursUtc:            Array.isArray(cfg.deadHoursUtc) ? cfg.deadHoursUtc : DEFAULT_SLIPPAGE_CONTEXT.deadHoursUtc,
    deadHourMultiplier:      atLeastOne(cfg.deadHourMultiplier, DEFAULT_SLIPPAGE_CONTEXT.deadHourMultiplier),
    weekendMultiplier:       atLeastOne(cfg.weekendMultiplier, DEFAULT_SLIPPAGE_CONTEXT.weekendMultiplier),
    volatilityEnabled:       cfg.volatilityEnabled !== false,
    volatilityRefPct:        positive(cfg.volatilityRefPct, DEFAULT_SLIPPAGE_CONTEXT.volatilityRefPct),
    volatilityMaxMultiplier: atLeastOne(cfg.volatilityMaxMultiplier, DEFAULT_SLIPPAGE_CONTEXT.volatilityMaxMultiplier),
    maxMultiplier:           atLeastOne(cfg.maxMultiplier, DEFAULT_SLIPPAGE_CONTEXT.maxMultiplier),
  };
}

function atLeastOne(v: number | undefined, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v)) return fallback;
  return Math.max(1, v);
}

function positive(v: number | undefined, fallback: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v <= 0) return fallback;
  return v;
}

/** Hour-of-day and weekend multiplier. Never below 1 — thin books never help. */
export function timeOfDayMultiplier(
  barTime: number,
  cfg?:    SlippageContextSettings,
): number {
  const c = ctxOrDefault(cfg);
  if (!c.enabled) return 1;
  const hour = utcHourOfBar(barTime);
  if (!Number.isFinite(hour)) return 1;

  let m = 1;
  if (c.deadHoursUtc.includes(hour)) m *= c.deadHourMultiplier;
  if (isWeekendBar(barTime)) m *= c.weekendMultiplier;
  return Math.min(m, c.maxMultiplier);
}

/**
 * Volatility multiplier from the bar's own range. A wide bar means a wide book,
 * so fills get worse. Calm bars are never given a discount: being cheap in the
 * quiet is the optimism that kills backtests.
 */
export function volatilityMultiplier(
  bar:  SlippageBar | undefined,
  cfg?: SlippageContextSettings,
): number {
  const c = ctxOrDefault(cfg);
  if (!c.enabled || !c.volatilityEnabled || !bar) return 1;
  const { high, low, close } = bar;
  if (![high, low, close].every(Number.isFinite) || close <= 0 || high < low) return 1;

  const rangePct = ((high - low) / close) * 100;
  const raw = rangePct / c.volatilityRefPct;
  if (!Number.isFinite(raw)) return 1;
  return Math.min(Math.max(1, raw), c.volatilityMaxMultiplier);
}

/** Combined multiplier: time of day x weekend x volatility, capped. */
export function slippageMultiplier(
  ctx:  SlippageContext,
  cfg?: SlippageContextSettings,
): number {
  const c = ctxOrDefault(cfg ?? ctx.contextCfg);
  if (!c.enabled) return 1;
  const m = timeOfDayMultiplier(ctx.barTime, c) * volatilityMultiplier(ctx.bar, c);
  return Math.min(Math.max(1, m), c.maxMultiplier);
}

/**
 * applySlippage plus the context multiplier, applied to the delta rather than to
 * the price, so the base models keep their exact semantics.
 */
export function applySlippageWithContext(
  refPrice: number,
  side:     Side,
  qty:      number,
  ticker:   Ticker | undefined,
  cfg:      SlippageSettings | undefined,
  ctx:      SlippageContext | undefined,
): number {
  const base = applySlippage(refPrice, side, qty, ticker, cfg);
  if (!ctx || refPrice <= 0) return base;

  const contextCfg = ctx.contextCfg ?? cfg?.context;
  const mult = slippageMultiplier(ctx, contextCfg);
  if (mult === 1) return base;

  const delta = Math.abs(base - refPrice) * mult;
  return side === "buy" ? refPrice + delta : Math.max(0, refPrice - delta);
}

export function describeSlippageContext(cfg: SlippageContextSettings | undefined): string {
  const c = ctxOrDefault(cfg);
  if (!c.enabled) return "context off";
  const parts = [
    `dead h${c.deadHoursUtc.join(",")} x${c.deadHourMultiplier}`,
    `weekend x${c.weekendMultiplier}`,
  ];
  if (c.volatilityEnabled) parts.push(`vol ref ${c.volatilityRefPct}% cap x${c.volatilityMaxMultiplier}`);
  parts.push(`cap x${c.maxMultiplier}`);
  return parts.join(", ");
}
