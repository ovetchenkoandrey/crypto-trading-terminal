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
  cfg:      SlippageSettings,
): number {
  if (cfg.kind === "none" || refPrice <= 0) return refPrice;

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
