/**
 * The cost floor every measurement in this study is compared against.
 *
 * Rates are Bybit linear perpetual without VIP, as recorded in
 * docs/strategy-search.md: 0.02% maker, 0.055% taker per side. A round trip is
 * two sides, so the numbers below are what a completed trade owes before it has
 * predicted anything at all.
 */

export const BPS = 1e4;

export const TAKER_FEE_BPS = 5.5;
export const MAKER_FEE_BPS = 2.0;

/** Both sides taker: the honest floor for any signal that chases price. */
export const TAKER_ROUND_TRIP_BPS = 2 * TAKER_FEE_BPS;
/** Both sides maker: only reachable by strategies that can wait to be filled. */
export const MAKER_ROUND_TRIP_BPS = 2 * MAKER_FEE_BPS;
/** Fees plus the 5 bp per side slippage the backtester assumes by default. */
export const REALISTIC_ROUND_TRIP_BPS = TAKER_ROUND_TRIP_BPS + 10;

export interface CostFloor {
  label: string;
  roundTripBps: number;
}

export const COST_FLOORS: CostFloor[] = [
  { label: "maker/maker", roundTripBps: MAKER_ROUND_TRIP_BPS },
  { label: "taker/taker", roundTripBps: TAKER_ROUND_TRIP_BPS },
  { label: "taker + slippage", roundTripBps: REALISTIC_ROUND_TRIP_BPS },
];

/**
 * Win rate a symmetric target/stop system needs just to break even.
 * (2p - 1) * target = cost, so p = 0.5 + cost / (2 * target).
 * Returns NaN when the target is not even large enough to be reachable.
 */
export function breakEvenHitRate(targetBps: number, costBps: number): number {
  if (!(targetBps > 0)) return Number.NaN;
  return 0.5 + costBps / (2 * targetBps);
}

/** Cost as a share of a typical move: 1.0 means the move pays exactly the fee. */
export function costShareOfMove(moveBps: number, costBps: number): number {
  return moveBps > 0 ? costBps / moveBps : Infinity;
}

/**
 * How large a directional edge, in basis points per round trip, has to be for
 * costs to eat no more than `maxShare` of the gross. This is the "0.6% target"
 * rule from docs/strategy-ideas.md, generalised.
 */
export function requiredGrossBps(costBps: number, maxShare = 0.25): number {
  return costBps / maxShare;
}
