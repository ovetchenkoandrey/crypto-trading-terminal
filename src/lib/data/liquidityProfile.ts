import { MAX_FIELDS, createCursor, expectHeader, forEachDataRow, parseNumberSlice } from "./csvBytes.ts";

/**
 * Per-symbol execution cost measured from a real order book, for the coins the
 * positioning factor actually trades.
 *
 * `cost-calibration.md` measured BTC and ETH and said in plain words that the
 * numbers do not transfer: on BTCUSDT the spread is one tick 99.8% of the time
 * and a 200 USDT market order pays 0.006 bp. Half of the factor basket is TRB,
 * COTI, ALICE, MASK, ZEN — where one tick can be several basis points and the
 * top of the book can be smaller than our order.
 *
 * The input is Tardis `book_snapshot_5` for binance-futures: five levels a side,
 * every time the book changes. Five levels is more than enough to price a
 * 110 USDT order and enough to say where a larger one would start to hurt;
 * beyond that the Binance `bookDepth` bands take over.
 *
 * Everything here is a pure function over a parsed day so the arithmetic can be
 * unit-tested on hand-written books rather than on gigabytes of CSV.
 */

export const BOOK5_LEVELS = 5;

/** Tardis writes `book_snapshot_N` as four fixed columns then ask/bid pairs per level. */
export function bookSnapshotHeader(levels: number): string[] {
  const cols = ["exchange", "symbol", "timestamp", "local_timestamp"];
  for (let l = 0; l < levels; l++) {
    cols.push(`asks[${l}].price`, `asks[${l}].amount`, `bids[${l}].price`, `bids[${l}].amount`);
  }
  return cols;
}

export const BOOK5_HEADER = bookSnapshotHeader(BOOK5_LEVELS);

export interface BookRow {
  /** Exchange time in milliseconds; the archive carries microseconds. */
  tsMs: number;
  askPx: Float64Array;
  askAmt: Float64Array;
  bidPx: Float64Array;
  bidAmt: Float64Array;
  /** Levels actually present — a thin book can publish fewer than the file allows. */
  askLevels: number;
  bidLevels: number;
}

export function createBookRow(levels = BOOK5_LEVELS): BookRow {
  return {
    tsMs: 0,
    askPx: new Float64Array(levels),
    askAmt: new Float64Array(levels),
    bidPx: new Float64Array(levels),
    bidAmt: new Float64Array(levels),
    askLevels: 0,
    bidLevels: 0,
  };
}

/**
 * Streams the file instead of materialising it: a day of DOGE is 400 MB of CSV
 * and the same day as objects is several gigabytes of heap. The row is reused,
 * so the callback must read what it needs before returning.
 *
 * `csvBytes` splits at most 32 fields, which is 4 + 4 x 7 levels — deeper files
 * are read to the depth the splitter can reach, and the header check keeps that
 * honest by naming the depth the file claims.
 */
export function forEachBookRow(
  buf: Uint8Array,
  fileLevels: number,
  onRow: (row: BookRow) => void,
  readLevels = fileLevels,
): number {
  expectHeader(buf, bookSnapshotHeader(fileLevels), `tardis book_snapshot_${fileLevels}`);
  const levels = Math.min(readLevels, fileLevels, Math.floor((MAX_FIELDS - 4) / 4));
  const cur = createCursor();
  const row = createBookRow(levels);
  let bad = 0;
  forEachDataRow(
    buf,
    (c) => {
      if (c.count < 4 + levels * 4) {
        bad++;
        return;
      }
      const ts = parseNumberSlice(buf, c.starts[2], c.ends[2]);
      if (!(ts > 0)) {
        bad++;
        return;
      }
      row.tsMs = ts / 1000;
      let asks = 0;
      let bids = 0;
      for (let l = 0; l < levels; l++) {
        const base = 4 + l * 4;
        const ap = parseNumberSlice(buf, c.starts[base], c.ends[base]);
        const aa = parseNumberSlice(buf, c.starts[base + 1], c.ends[base + 1]);
        const bp = parseNumberSlice(buf, c.starts[base + 2], c.ends[base + 2]);
        const ba = parseNumberSlice(buf, c.starts[base + 3], c.ends[base + 3]);
        if (ap > 0 && aa > 0 && asks === l) {
          row.askPx[l] = ap;
          row.askAmt[l] = aa;
          asks = l + 1;
        }
        if (bp > 0 && ba > 0 && bids === l) {
          row.bidPx[l] = bp;
          row.bidAmt[l] = ba;
          bids = l + 1;
        }
      }
      row.askLevels = asks;
      row.bidLevels = bids;
      if (asks === 0 || bids === 0 || !(row.askPx[0] > row.bidPx[0])) {
        bad++;
        return;
      }
      onRow(row);
    },
    cur,
  );
  return bad;
}

export function forEachBook5Row(buf: Uint8Array, onRow: (row: BookRow) => void): number {
  return forEachBookRow(buf, BOOK5_LEVELS, onRow);
}

/* ── walking the book ─────────────────────────────────────────────────────── */

export interface SweepResult {
  /** Volume-weighted fill price, NaN when the visible levels cannot fill. */
  vwap: number;
  /** Notional the visible levels could absorb. */
  filledUsdt: number;
}

/**
 * Consumes `notionalUsdt` from one side of the book, partially filling the last
 * level it reaches. Returns NaN for the price when five levels are not enough:
 * a guessed sixth level would be exactly the kind of plausible number this whole
 * exercise exists to avoid.
 */
export function sweepBook(
  px: Float64Array | readonly number[],
  amt: Float64Array | readonly number[],
  levels: number,
  notionalUsdt: number,
): SweepResult {
  if (!(notionalUsdt > 0)) return { vwap: Number.NaN, filledUsdt: 0 };
  let remaining = notionalUsdt;
  let qty = 0;
  let cash = 0;
  let filled = 0;
  for (let l = 0; l < levels; l++) {
    const p = px[l];
    const a = amt[l];
    if (!(p > 0) || !(a > 0)) break;
    const levelNotional = p * a;
    filled += levelNotional;
    if (levelNotional >= remaining) {
      qty += remaining / p;
      cash += remaining;
      return { vwap: cash / qty, filledUsdt: notionalUsdt };
    }
    qty += a;
    cash += levelNotional;
    remaining -= levelNotional;
  }
  return { vwap: Number.NaN, filledUsdt: filled };
}

/** One-way cost of a market order against the mid, in basis points. */
export function marketOrderCostBps(row: BookRow, notionalUsdt: number): {
  buyBps: number;
  sellBps: number;
  meanBps: number;
  filled: boolean;
} {
  const mid = (row.askPx[0] + row.bidPx[0]) / 2;
  const buy = sweepBook(row.askPx, row.askAmt, row.askLevels, notionalUsdt);
  const sell = sweepBook(row.bidPx, row.bidAmt, row.bidLevels, notionalUsdt);
  const buyBps = ((buy.vwap - mid) / mid) * 1e4;
  const sellBps = ((mid - sell.vwap) / mid) * 1e4;
  const filled = Number.isFinite(buyBps) && Number.isFinite(sellBps);
  return { buyBps, sellBps, meanBps: filled ? (buyBps + sellBps) / 2 : Number.NaN, filled };
}

/* ── accumulation ─────────────────────────────────────────────────────────── */

export interface LiquidityStats {
  /** Order sizes priced, in USDT of notional. */
  sizes: number[];
  bins: number;
  binBps: number;
  /** Seconds of book time observed. */
  weightSec: number;
  samples: number;
  /** Book time skipped because the gap to the next snapshot was implausible. */
  droppedSec: number;
  spreadBpsW: number;
  spreadHist: Float64Array;
  spreadMaxBps: number;
  /** Time-weighted notional resting on the best bid / best ask. */
  topBidW: number;
  topAskW: number;
  /** Time-weighted notional across every visible level. */
  depthBidW: number;
  depthAskW: number;
  midW: number;
  /** Per size: time-weighted mean cost, its histogram, and unfillable time. */
  costW: Float64Array;
  costHist: Float64Array;
  unfilledSec: Float64Array;
  costMaxBps: Float64Array;
}

export interface LiquidityStatsOptions {
  sizes: number[];
  bins?: number;
  binBps?: number;
}

export function createLiquidityStats(opts: LiquidityStatsOptions): LiquidityStats {
  const bins = opts.bins ?? 600;
  const binBps = opts.binBps ?? 0.25;
  const k = opts.sizes.length;
  return {
    sizes: [...opts.sizes],
    bins,
    binBps,
    weightSec: 0,
    samples: 0,
    droppedSec: 0,
    spreadBpsW: 0,
    spreadHist: new Float64Array(bins),
    spreadMaxBps: 0,
    topBidW: 0,
    topAskW: 0,
    depthBidW: 0,
    depthAskW: 0,
    midW: 0,
    costW: new Float64Array(k),
    costHist: new Float64Array(k * bins),
    unfilledSec: new Float64Array(k),
    costMaxBps: new Float64Array(k),
  };
}

function addToHist(hist: Float64Array, offset: number, bins: number, binWidth: number, value: number, w: number): void {
  let bin = Math.floor(value / binWidth);
  if (!(bin >= 0)) bin = 0;
  if (bin >= bins) bin = bins - 1;
  hist[offset + bin] += w;
}

export interface AccumulateOptions {
  /** Levels the file carries: 5 for `book_snapshot_5`, 25 for `book_snapshot_25`. */
  fileLevels?: number;
  /** Longer gaps between snapshots are treated as a feed outage. */
  maxGapMs?: number;
  /** End of the observation window; the last snapshot is weighted up to it. */
  endMs?: number;
}

/**
 * Time-weighted, not event-weighted. A book that stood for four seconds says
 * more about what an order would have met than one that stood for twenty
 * milliseconds, and update frequency itself is a function of how liquid the coin
 * is — event weighting would quietly count activity twice.
 */
export function accumulateBookSnapshots(
  buf: Uint8Array,
  stats: LiquidityStats,
  opts: AccumulateOptions = {},
): { rows: number; bad: number } {
  const fileLevels = opts.fileLevels ?? BOOK5_LEVELS;
  const maxGap = opts.maxGapMs ?? 60_000;
  const k = stats.sizes.length;
  let rows = 0;
  let prev: {
    tsMs: number;
    spreadBps: number;
    mid: number;
    topBid: number;
    topAsk: number;
    depthBid: number;
    depthAsk: number;
    cost: Float64Array;
  } | null = null;
  const scratch = new Float64Array(k);

  const flush = (nextMs: number): void => {
    if (!prev) return;
    let dt = nextMs - prev.tsMs;
    if (!(dt > 0)) return;
    if (dt > maxGap) {
      stats.droppedSec += dt / 1000;
      return;
    }
    const w = dt / 1000;
    stats.weightSec += w;
    stats.samples++;
    stats.spreadBpsW += prev.spreadBps * w;
    if (prev.spreadBps > stats.spreadMaxBps) stats.spreadMaxBps = prev.spreadBps;
    addToHist(stats.spreadHist, 0, stats.bins, stats.binBps, prev.spreadBps, w);
    stats.topBidW += prev.topBid * w;
    stats.topAskW += prev.topAsk * w;
    stats.depthBidW += prev.depthBid * w;
    stats.depthAskW += prev.depthAsk * w;
    stats.midW += prev.mid * w;
    for (let i = 0; i < k; i++) {
      const c = prev.cost[i];
      if (Number.isFinite(c)) {
        stats.costW[i] += c * w;
        addToHist(stats.costHist, i * stats.bins, stats.bins, stats.binBps, c, w);
        if (c > stats.costMaxBps[i]) stats.costMaxBps[i] = c;
      } else {
        stats.unfilledSec[i] += w;
      }
    }
  };

  const bad = forEachBookRow(buf, fileLevels, (row) => {
    flush(row.tsMs);
    rows++;
    const mid = (row.askPx[0] + row.bidPx[0]) / 2;
    let depthBid = 0;
    for (let l = 0; l < row.bidLevels; l++) depthBid += row.bidPx[l] * row.bidAmt[l];
    let depthAsk = 0;
    for (let l = 0; l < row.askLevels; l++) depthAsk += row.askPx[l] * row.askAmt[l];
    for (let i = 0; i < k; i++) scratch[i] = marketOrderCostBps(row, stats.sizes[i]).meanBps;
    prev = {
      tsMs: row.tsMs,
      spreadBps: ((row.askPx[0] - row.bidPx[0]) / mid) * 1e4,
      mid,
      topBid: row.bidPx[0] * row.bidAmt[0],
      topAsk: row.askPx[0] * row.askAmt[0],
      depthBid,
      depthAsk,
      cost: Float64Array.from(scratch),
    };
  });
  if (opts.endMs !== undefined) flush(opts.endMs);
  return { rows, bad };
}

export function accumulateBook5(
  buf: Uint8Array,
  stats: LiquidityStats,
  opts: AccumulateOptions = {},
): { rows: number; bad: number } {
  return accumulateBookSnapshots(buf, stats, { ...opts, fileLevels: BOOK5_LEVELS });
}

/** Folds a day into a running total, so a file is parsed once, not once per aggregate. */
export function mergeLiquidityStats(into: LiquidityStats, from: LiquidityStats): void {
  if (into.bins !== from.bins || into.binBps !== from.binBps || into.sizes.length !== from.sizes.length) {
    throw new Error("mergeLiquidityStats: incompatible stats");
  }
  into.weightSec += from.weightSec;
  into.samples += from.samples;
  into.droppedSec += from.droppedSec;
  into.spreadBpsW += from.spreadBpsW;
  into.topBidW += from.topBidW;
  into.topAskW += from.topAskW;
  into.depthBidW += from.depthBidW;
  into.depthAskW += from.depthAskW;
  into.midW += from.midW;
  if (from.spreadMaxBps > into.spreadMaxBps) into.spreadMaxBps = from.spreadMaxBps;
  for (let i = 0; i < into.spreadHist.length; i++) into.spreadHist[i] += from.spreadHist[i];
  for (let i = 0; i < into.costW.length; i++) {
    into.costW[i] += from.costW[i];
    into.unfilledSec[i] += from.unfilledSec[i];
    if (from.costMaxBps[i] > into.costMaxBps[i]) into.costMaxBps[i] = from.costMaxBps[i];
  }
  for (let i = 0; i < into.costHist.length; i++) into.costHist[i] += from.costHist[i];
}

/* ── summary ──────────────────────────────────────────────────────────────── */

export function histQuantileBps(hist: Float64Array, offset: number, bins: number, binWidth: number, q: number): number {
  let total = 0;
  for (let i = 0; i < bins; i++) total += hist[offset + i];
  if (!(total > 0)) return Number.NaN;
  const target = total * q;
  let seen = 0;
  for (let i = 0; i < bins; i++) {
    seen += hist[offset + i];
    if (seen >= target) return (i + 0.5) * binWidth;
  }
  return (bins - 0.5) * binWidth;
}

export interface SizeSummary {
  notionalUsdt: number;
  costBpsMean: number;
  costBpsMedian: number;
  costBpsP90: number;
  costBpsP99: number;
  costBpsMax: number;
  /** Share of book time when five levels could not absorb the order. */
  unfilledFrac: number;
}

export interface LiquiditySummary {
  bookSeconds: number;
  samples: number;
  droppedSec: number;
  midPrice: number;
  spreadBpsMean: number;
  spreadBpsMedian: number;
  spreadBpsP90: number;
  spreadBpsP99: number;
  spreadBpsMax: number;
  topBidUsdt: number;
  topAskUsdt: number;
  topUsdt: number;
  depthVisibleUsdt: number;
  sizes: SizeSummary[];
}

export function summarizeLiquidity(stats: LiquidityStats): LiquiditySummary {
  const w = stats.weightSec;
  const spreadQ = (p: number): number => histQuantileBps(stats.spreadHist, 0, stats.bins, stats.binBps, p);
  const sizes: SizeSummary[] = stats.sizes.map((size, i) => {
    const filledW = w - stats.unfilledSec[i];
    return {
      notionalUsdt: size,
      costBpsMean: filledW > 0 ? stats.costW[i] / filledW : Number.NaN,
      costBpsMedian: histQuantileBps(stats.costHist, i * stats.bins, stats.bins, stats.binBps, 0.5),
      costBpsP90: histQuantileBps(stats.costHist, i * stats.bins, stats.bins, stats.binBps, 0.9),
      costBpsP99: histQuantileBps(stats.costHist, i * stats.bins, stats.bins, stats.binBps, 0.99),
      costBpsMax: stats.costMaxBps[i],
      unfilledFrac: w > 0 ? stats.unfilledSec[i] / w : Number.NaN,
    };
  });
  return {
    bookSeconds: w,
    samples: stats.samples,
    droppedSec: stats.droppedSec,
    midPrice: w > 0 ? stats.midW / w : Number.NaN,
    spreadBpsMean: w > 0 ? stats.spreadBpsW / w : Number.NaN,
    spreadBpsMedian: spreadQ(0.5),
    spreadBpsP90: spreadQ(0.9),
    spreadBpsP99: spreadQ(0.99),
    spreadBpsMax: stats.spreadMaxBps,
    topBidUsdt: w > 0 ? stats.topBidW / w : Number.NaN,
    topAskUsdt: w > 0 ? stats.topAskW / w : Number.NaN,
    topUsdt: w > 0 ? Math.min(stats.topBidW, stats.topAskW) / w : Number.NaN,
    depthVisibleUsdt: w > 0 ? Math.min(stats.depthBidW, stats.depthAskW) / w : Number.NaN,
    sizes,
  };
}

/**
 * Cost at a size between two measured ones.
 *
 * Book depth accumulates roughly linearly in price distance, so cost grows
 * roughly with the square root of size; in log-size that is close to a straight
 * line, and a straight line between two measurements is the least invented
 * thing available. Outside the measured grid the nearest endpoint is returned
 * rather than an extrapolation — the whole point of this file is that the thin
 * end of the board is not where guessing pays.
 */
export function interpolateCostBps(
  sizes: readonly number[],
  costsBps: readonly number[],
  targetUsdt: number,
): number {
  const n = Math.min(sizes.length, costsBps.length);
  if (n === 0 || !(targetUsdt > 0)) return Number.NaN;
  if (targetUsdt <= sizes[0]) return costsBps[0];
  if (targetUsdt >= sizes[n - 1]) return costsBps[n - 1];
  for (let i = 1; i < n; i++) {
    if (targetUsdt <= sizes[i]) {
      const a = Math.log(sizes[i - 1]);
      const b = Math.log(sizes[i]);
      const w = b > a ? (Math.log(targetUsdt) - a) / (b - a) : 0;
      return costsBps[i - 1] + w * (costsBps[i] - costsBps[i - 1]);
    }
  }
  return costsBps[n - 1];
}

/* ── lot feasibility ──────────────────────────────────────────────────────── */

export interface LotSpec {
  minQty: number;
  qtyStep: number;
  minNotionalUsdt: number;
}

export interface LotFit {
  /** Notional actually reachable after flooring to the step, USDT. */
  notionalUsdt: number;
  qty: number;
  /** Relative distance from the target notional; 1 when the name is skipped. */
  error: number;
  tradable: boolean;
}

/**
 * What a target notional becomes once the exchange's LOT_SIZE and MIN_NOTIONAL
 * filters have had their say.
 *
 * Quantity is floored, not rounded: rounding up can breach the risk budget, and
 * on a coin whose step is worth more than the whole target that is the
 * difference between a 110 USDT position and a 250 USDT one.
 */
export function fitLot(targetUsdt: number, price: number, lot: LotSpec): LotFit {
  const miss: LotFit = { notionalUsdt: 0, qty: 0, error: 1, tradable: false };
  if (!(targetUsdt > 0) || !(price > 0) || !(lot.qtyStep > 0)) return miss;
  const rawQty = targetUsdt / price;
  const steps = Math.floor(rawQty / lot.qtyStep + 1e-9);
  const qty = steps * lot.qtyStep;
  if (!(qty > 0) || qty + 1e-12 < lot.minQty) return miss;
  const notional = qty * price;
  if (notional + 1e-9 < lot.minNotionalUsdt) return miss;
  return { notionalUsdt: notional, qty, error: Math.abs(notional - targetUsdt) / targetUsdt, tradable: true };
}
