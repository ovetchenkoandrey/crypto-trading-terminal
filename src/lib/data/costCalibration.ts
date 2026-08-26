import type { QuoteDay, TradeDay } from "./tardisSamples.ts";

/**
 * Measurements that replace the guessed numbers in the execution cost model.
 *
 * Everything here is a pure function over a parsed day of market data, so the
 * results can be re-derived from the archives at any time and the arithmetic can
 * be unit-tested on hand-written fixtures rather than on 120 MB of CSV.
 *
 * Three things get measured:
 *
 *   1. the taker cost distribution by hour of day and weekday/weekend — what a
 *      market order of our size actually pays against the mid it decided on,
 *      including the latency between decision and arrival;
 *   2. the depth at the touch, per hour — the liquidity seasonality the dead-hour
 *      multiplier claims to describe;
 *   3. the probability that a resting limit order fills when price reaches it,
 *      as a function of how far price traded through the level, from a FIFO
 *      queue simulation against real trade flow.
 */

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

export function utcHourOfMs(ms: number): number {
  return Math.floor((((ms % MS_PER_DAY) + MS_PER_DAY) % MS_PER_DAY) / MS_PER_HOUR);
}

/** 0 = Sunday. Epoch day 0 (1970-01-01) was a Thursday. */
export function utcDayOfWeekOfMs(ms: number): number {
  return (((Math.floor(ms / MS_PER_DAY) + 4) % 7) + 7) % 7;
}

export function isWeekendMs(ms: number): boolean {
  const d = utcDayOfWeekOfMs(ms);
  return d === 0 || d === 6;
}

/* ── spread and depth by hour ─────────────────────────────────────────────── */

export const SPREAD_TICK_BINS = 32;

/**
 * 48 buckets: hour of day, weekday and weekend kept apart. Everything is
 * time-weighted — a quote that stood for 900 ms says more about what an order
 * would have met than one that stood for 20 ms, and quote frequency itself
 * varies with the hour, so event-weighting would double-count activity.
 */
export interface HourStats {
  /** Seconds of book time observed. */
  weight: Float64Array;
  spreadBpsW: Float64Array;
  spreadTicksW: Float64Array;
  topNotionalW: Float64Array;
  samples: Float64Array;
  /** Time-weighted histogram of spread width in ticks, per bucket. */
  tickHist: Float64Array;
  /** Book time dropped because the gap to the next quote was implausible. */
  droppedSec: number;
}

export function bucketIndex(hour: number, weekend: boolean): number {
  return hour + (weekend ? 24 : 0);
}

export function createHourStats(): HourStats {
  return {
    weight: new Float64Array(48),
    spreadBpsW: new Float64Array(48),
    spreadTicksW: new Float64Array(48),
    topNotionalW: new Float64Array(48),
    samples: new Float64Array(48),
    tickHist: new Float64Array(48 * SPREAD_TICK_BINS),
    droppedSec: 0,
  };
}

export interface QuoteAccumulateOptions {
  tickSize: number;
  /** Longer gaps are treated as a feed outage rather than a standing quote. */
  maxGapMs?: number;
  /** End of the observation window; the last quote is weighted up to it. */
  endMs?: number;
}

export function accumulateQuotes(day: QuoteDay, stats: HourStats, opts: QuoteAccumulateOptions): void {
  const tick = opts.tickSize > 0 ? opts.tickSize : 1;
  const maxGap = opts.maxGapMs ?? 5_000;
  const n = day.n;
  if (n === 0) return;

  for (let i = 0; i < n; i++) {
    const t = day.ts[i];
    const next = i + 1 < n ? day.ts[i + 1] : (opts.endMs ?? t);
    let dt = next - t;
    if (!(dt > 0)) continue;
    if (dt > maxGap) {
      stats.droppedSec += dt / 1000;
      continue;
    }
    const bid = day.bid[i];
    const ask = day.ask[i];
    if (!(bid > 0) || !(ask > bid)) continue;

    const mid = (bid + ask) / 2;
    const spread = ask - bid;
    const spreadBps = (spread / mid) * 10_000;
    const ticks = spread / tick;

    const b = bucketIndex(utcHourOfMs(t), isWeekendMs(t));
    const w = dt / 1000;
    stats.weight[b] += w;
    stats.spreadBpsW[b] += spreadBps * w;
    stats.spreadTicksW[b] += ticks * w;
    stats.topNotionalW[b] += Math.min(day.bidAmt[i] * bid, day.askAmt[i] * ask) * w;
    stats.samples[b] += 1;

    const binRaw = Math.round(ticks) - 1;
    const bin = binRaw < 0 ? 0 : binRaw >= SPREAD_TICK_BINS ? SPREAD_TICK_BINS - 1 : binRaw;
    stats.tickHist[b * SPREAD_TICK_BINS + bin] += w;
  }
}

export interface HourSummaryRow {
  hour: number;
  weekend: boolean;
  hours: number;
  meanSpreadBps: number;
  meanSpreadTicks: number;
  /** Share of book time spent at the minimum one-tick spread. */
  oneTickShare: number;
  p90SpreadTicks: number;
  meanTopNotional: number;
  samples: number;
}

export function summarizeHours(stats: HourStats): HourSummaryRow[] {
  const out: HourSummaryRow[] = [];
  for (let b = 0; b < 48; b++) {
    const w = stats.weight[b];
    if (w <= 0) continue;
    const hist = stats.tickHist.subarray(b * SPREAD_TICK_BINS, (b + 1) * SPREAD_TICK_BINS);
    out.push({
      hour: b % 24,
      weekend: b >= 24,
      hours: w / 3600,
      meanSpreadBps: stats.spreadBpsW[b] / w,
      meanSpreadTicks: stats.spreadTicksW[b] / w,
      oneTickShare: hist[0] / w,
      p90SpreadTicks: histQuantile(hist, 0.9),
      meanTopNotional: stats.topNotionalW[b] / w,
      samples: stats.samples[b],
    });
  }
  return out;
}

/** Quantile over the tick histogram. Bin i holds spreads of (i + 1) ticks. */
export function histQuantile(hist: Float64Array | number[], q: number): number {
  let total = 0;
  for (let i = 0; i < hist.length; i++) total += hist[i];
  if (total <= 0) return NaN;
  const target = total * Math.min(1, Math.max(0, q));
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return i + 1;
  }
  return hist.length;
}

/** Aggregate of a set of hour buckets — the denominator for the multipliers. */
export interface HourAggregate {
  hours: number;
  meanSpreadBps: number;
  meanSpreadTicks: number;
  meanTopNotional: number;
}

export function aggregateHours(rows: readonly HourSummaryRow[], filter: (r: HourSummaryRow) => boolean): HourAggregate {
  let w = 0;
  let spreadBps = 0;
  let ticks = 0;
  let notional = 0;
  for (const r of rows) {
    if (!filter(r)) continue;
    w += r.hours;
    spreadBps += r.meanSpreadBps * r.hours;
    ticks += r.meanSpreadTicks * r.hours;
    notional += r.meanTopNotional * r.hours;
  }
  if (w <= 0) return { hours: 0, meanSpreadBps: NaN, meanSpreadTicks: NaN, meanTopNotional: NaN };
  return { hours: w, meanSpreadBps: spreadBps / w, meanSpreadTicks: ticks / w, meanTopNotional: notional / w };
}

/* ── taker cost with latency ──────────────────────────────────────────────── */

/**
 * What a market order actually pays.
 *
 * The strategy decides on a reference price and the order arrives some
 * milliseconds later; by then the touch has moved. Cost is measured against the
 * mid at the decision instant, which is what the backtest uses as its reference,
 * so the figure includes the half-spread and the adverse drift during the flight.
 * Both sides are sampled at every instant, so a trending sample cannot bias the
 * result the way a one-sided measurement would.
 */
export interface TakerCostStats {
  /** Buckets are hour + 24 * weekend, like HourStats. */
  count: Float64Array;
  sumBps: Float64Array;
  sumSqBps: Float64Array;
  /** Cost histogram in 0.25 bps bins; index 0 is [0, 0.25). */
  hist: Float64Array;
  /** Samples where the cost exceeded each configured band. */
  overBand: Float64Array;
  bandsBps: number[];
  binBps: number;
  bins: number;
  skipped: number;
}

export function createTakerCostStats(bandsBps: number[] = [5, 10, 20, 50], bins = 200, binBps = 0.25): TakerCostStats {
  return {
    count: new Float64Array(48),
    sumBps: new Float64Array(48),
    sumSqBps: new Float64Array(48),
    hist: new Float64Array(48 * bins),
    overBand: new Float64Array(48 * bandsBps.length),
    bandsBps: [...bandsBps],
    binBps,
    bins,
    skipped: 0,
  };
}

export interface TakerCostOptions {
  /** Flight time between decision and arrival. 0 measures the pure half-spread. */
  latencyMs: number;
  /** Interval between sampled decision instants. */
  sampleStepMs?: number;
  /** A quote older than this is stale; the sample is dropped rather than guessed. */
  maxStaleMs?: number;
}

/** Index of the last quote at or before `t`, searching forward from `from`. */
function advance(ts: Float64Array, n: number, from: number, t: number): number {
  let i = from;
  while (i + 1 < n && ts[i + 1] <= t) i++;
  return i;
}

export function accumulateTakerCost(day: QuoteDay, stats: TakerCostStats, opts: TakerCostOptions): void {
  const n = day.n;
  if (n < 2) return;
  const step = opts.sampleStepMs ?? 1000;
  const maxStale = opts.maxStaleMs ?? 5_000;
  const latency = Math.max(0, opts.latencyMs);
  const nb = stats.bandsBps.length;

  const start = Math.ceil(day.ts[0] / step) * step;
  const end = day.ts[n - 1] - latency;
  let iDecide = 0;
  let iArrive = 0;

  for (let t = start; t <= end; t += step) {
    iDecide = advance(day.ts, n, iDecide, t);
    iArrive = advance(day.ts, n, iArrive < iDecide ? iDecide : iArrive, t + latency);
    if (t - day.ts[iDecide] > maxStale || t + latency - day.ts[iArrive] > maxStale) {
      stats.skipped++;
      continue;
    }
    const mid = (day.bid[iDecide] + day.ask[iDecide]) / 2;
    if (!(mid > 0)) {
      stats.skipped++;
      continue;
    }
    const buyBps = ((day.ask[iArrive] - mid) / mid) * 10_000;
    const sellBps = ((mid - day.bid[iArrive]) / mid) * 10_000;
    const b = bucketIndex(utcHourOfMs(t), isWeekendMs(t));
    addCost(stats, b, buyBps, nb);
    addCost(stats, b, sellBps, nb);
  }
}

function addCost(stats: TakerCostStats, b: number, bps: number, nb: number): void {
  const v = Number.isFinite(bps) ? bps : 0;
  stats.count[b] += 1;
  stats.sumBps[b] += v;
  stats.sumSqBps[b] += v * v;
  const raw = Math.floor(Math.max(0, v) / stats.binBps);
  const bin = raw >= stats.bins ? stats.bins - 1 : raw;
  stats.hist[b * stats.bins + bin] += 1;
  for (let k = 0; k < nb; k++) {
    if (v > stats.bandsBps[k]) stats.overBand[b * nb + k] += 1;
  }
}

export interface TakerCostRow {
  hour: number;
  weekend: boolean;
  samples: number;
  meanBps: number;
  sdBps: number;
  medianBps: number;
  p95Bps: number;
  p99Bps: number;
  overBand: { bandBps: number; share: number }[];
}

export function summarizeTakerCost(stats: TakerCostStats): TakerCostRow[] {
  const out: TakerCostRow[] = [];
  const nb = stats.bandsBps.length;
  for (let b = 0; b < 48; b++) {
    const c = stats.count[b];
    if (c <= 0) continue;
    const mean = stats.sumBps[b] / c;
    const varc = Math.max(0, stats.sumSqBps[b] / c - mean * mean);
    const hist = stats.hist.subarray(b * stats.bins, (b + 1) * stats.bins);
    out.push({
      hour: b % 24,
      weekend: b >= 24,
      samples: c,
      meanBps: mean,
      sdBps: Math.sqrt(varc),
      medianBps: binQuantile(hist, 0.5, stats.binBps),
      p95Bps: binQuantile(hist, 0.95, stats.binBps),
      p99Bps: binQuantile(hist, 0.99, stats.binBps),
      overBand: stats.bandsBps.map((band, k) => ({ bandBps: band, share: stats.overBand[b * nb + k] / c })),
    });
  }
  return out;
}

/** Upper edge of the bin holding the quantile. Coarse by design — bins are 0.25 bps. */
export function binQuantile(hist: Float64Array | number[], q: number, binWidth: number): number {
  let total = 0;
  for (let i = 0; i < hist.length; i++) total += hist[i];
  if (total <= 0) return NaN;
  const target = total * Math.min(1, Math.max(0, q));
  let acc = 0;
  for (let i = 0; i < hist.length; i++) {
    acc += hist[i];
    if (acc >= target) return (i + 1) * binWidth;
  }
  return hist.length * binWidth;
}

export function aggregateTakerCost(
  rows: readonly TakerCostRow[],
  filter: (r: TakerCostRow) => boolean,
): { samples: number; meanBps: number; overBand: { bandBps: number; share: number }[] } {
  let n = 0;
  let sum = 0;
  const bands = new Map<number, number>();
  for (const r of rows) {
    if (!filter(r)) continue;
    n += r.samples;
    sum += r.meanBps * r.samples;
    for (const ob of r.overBand) bands.set(ob.bandBps, (bands.get(ob.bandBps) ?? 0) + ob.share * r.samples);
  }
  return {
    samples: n,
    meanBps: n > 0 ? sum / n : NaN,
    overBand: [...bands.entries()].map(([bandBps, hits]) => ({ bandBps, share: n > 0 ? hits / n : NaN })),
  };
}

/* ── limit order queue simulation ─────────────────────────────────────────── */

/**
 * Queue model for a resting limit order, measured three ways at once.
 *
 * The one thing that is not a modelling choice: if the tape prints a trade
 * *through* our price — below a resting bid, above a resting ask — then price
 * priority says every order at our level was consumed first, so we were filled.
 * No queue assumption is involved. That case is settled exactly.
 *
 * What is left uncertain is the level the bar merely reached and did not pass:
 * the extreme of the bar. There the outcome depends on where in the queue we
 * stood, which public data cannot show, so all three positions are reported:
 *
 *   back    — everything displayed at the level was ahead of us (lower bound);
 *   uniform — our position was uniform over the displayed size (expected value);
 *   front   — nothing was ahead of us (upper bound).
 *
 * Cancellations in the queue ahead are invisible to us and would only help, so
 * even the uniform figure leans low.
 */
export interface LimitFillOptions {
  /** Our order size in base units. 0.002 BTC is roughly 200 USDT of notional. */
  ourQty: number;
  tickSize: number;
  /** Candidate levels sampled per bar between the extreme and the open. */
  levelsPerBar?: number;
  barMs?: number;
  /** Upper edges, in bps, of the penetration buckets. */
  penetrationEdgesBps?: number[];
}

/**
 * The first bucket is penetration of exactly zero — the level sat on the bar's
 * extreme and the price never went past it. That bucket alone answers what
 * `limitFillProbability` should be; every other bucket answers where
 * `limitFullFillPenetrationBps` belongs. One BTCUSDT tick is 0.1 on a six-figure
 * price, about 0.01 bps, which is why the edges start that fine.
 */
export const DEFAULT_PENETRATION_EDGES_BPS = [0, 0.011, 0.03, 0.1, 0.3, 1, 2, 5, 10, 30, Infinity];

export interface LimitFillStats {
  edgesBps: number[];
  touches: Float64Array;
  /** Back of the queue: the whole displayed size had to trade first. */
  filled: Float64Array;
  /** Front of the queue: any trade at the level was ours. */
  filledOptimistic: Float64Array;
  /** Expected fills under a uniform queue position — fractional, not a count. */
  filledUniform: Float64Array;
  /** Levels the tape traded through, where the fill needs no queue assumption. */
  swept: Float64Array;
  queueAheadSum: Float64Array;
  /** Levels the book never quoted as best — the price gapped past them. */
  gapped: Float64Array;
  bars: number;
  levels: number;
  skippedLevels: number;
}

export function createLimitFillStats(edges: number[] = DEFAULT_PENETRATION_EDGES_BPS): LimitFillStats {
  const k = edges.length;
  return {
    edgesBps: [...edges],
    touches: new Float64Array(k),
    filled: new Float64Array(k),
    filledOptimistic: new Float64Array(k),
    filledUniform: new Float64Array(k),
    swept: new Float64Array(k),
    queueAheadSum: new Float64Array(k),
    gapped: new Float64Array(k),
    bars: 0,
    levels: 0,
    skippedLevels: 0,
  };
}

function bucketOf(edges: number[], value: number): number {
  for (let i = 0; i < edges.length; i++) if (value <= edges[i]) return i;
  return edges.length - 1;
}

interface BarSpan {
  startMs: number;
  endMs: number;
  tFrom: number;
  tTo: number;
  qFrom: number;
  qTo: number;
  open: number;
  high: number;
  low: number;
}

/** Minute bars built from the trade tape, with the matching quote index range. */
export function buildBarSpans(q: QuoteDay, t: TradeDay, barMs: number): BarSpan[] {
  const spans: BarSpan[] = [];
  let i = 0;
  let qi = 0;
  while (i < t.n) {
    const startMs = Math.floor(t.ts[i] / barMs) * barMs;
    const endMs = startMs + barMs;
    let j = i;
    let open = t.price[i];
    let high = open;
    let low = open;
    while (j < t.n && t.ts[j] < endMs) {
      const p = t.price[j];
      if (p > high) high = p;
      if (p < low) low = p;
      j++;
    }
    while (qi < q.n && q.ts[qi] < startMs) qi++;
    let qj = qi;
    while (qj < q.n && q.ts[qj] < endMs) qj++;
    spans.push({ startMs, endMs, tFrom: i, tTo: j, qFrom: qi, qTo: qj, open, high, low });
    i = j;
  }
  return spans;
}

function levelGrid(from: number, to: number, tick: number, count: number): number[] {
  const lo = Math.min(from, to);
  const hi = Math.max(from, to);
  const out: number[] = [];
  const k = Math.max(1, count);
  for (let i = 0; i < k; i++) {
    const raw = k === 1 ? lo : lo + ((hi - lo) * i) / (k - 1);
    const snapped = Math.round(raw / tick) * tick;
    const v = Number(snapped.toFixed(10));
    if (v >= lo - tick / 2 && v <= hi + tick / 2 && out[out.length - 1] !== v) out.push(v);
  }
  return out;
}

/**
 * Walks every minute bar, plants limit orders across the range the bar covered
 * and asks whether the tape would have cleared the queue in front of them.
 * Buy limits are planted between the low and the open, sell limits between the
 * open and the high — exactly the levels a bar "touches" in the matching engine.
 */
export function simulateLimitFills(q: QuoteDay, t: TradeDay, stats: LimitFillStats, opts: LimitFillOptions): void {
  const barMs = opts.barMs ?? 60_000;
  const tick = opts.tickSize > 0 ? opts.tickSize : 0.1;
  const levels = opts.levelsPerBar ?? 8;
  const ourQty = opts.ourQty > 0 ? opts.ourQty : 0.002;
  const edges = stats.edgesBps;

  for (const span of buildBarSpans(q, t, barMs)) {
    if (span.qTo <= span.qFrom || span.tTo <= span.tFrom) continue;
    stats.bars++;
    simulateSide(q, t, stats, span, edges, tick, levels, ourQty, true);
    simulateSide(q, t, stats, span, edges, tick, levels, ourQty, false);
  }
}

function simulateSide(
  q: QuoteDay,
  t: TradeDay,
  stats: LimitFillStats,
  span: BarSpan,
  edges: number[],
  tick: number,
  levels: number,
  ourQty: number,
  buy: boolean,
): void {
  const extreme = buy ? span.low : span.high;
  const grid = levelGrid(span.open, extreme, tick, levels);
  // Descending for a buy, ascending for a sell: the touch time then moves
  // monotonically forward and the quote pointer never has to rewind.
  const ordered = buy ? [...grid].sort((a, b) => b - a) : [...grid].sort((a, b) => a - b);

  let qi = span.qFrom;
  for (const price of ordered) {
    if (price <= 0) continue;
    while (qi < span.qTo) {
      const touched = buy ? q.bid[qi] <= price : q.ask[qi] >= price;
      if (touched) break;
      qi++;
    }
    if (qi >= span.qTo) {
      stats.skippedLevels++;
      continue;
    }
    const touchMs = q.ts[qi];
    // Quotes lag the trades that moved them, so the sweep is looked for from the
    // last instant the book was still on the other side of our price. Anything
    // earlier belongs to a level above ours and is not ours to claim.
    const sweepFromMs = qi > span.qFrom ? q.ts[qi - 1] : span.startMs;
    const best = buy ? q.bid[qi] : q.ask[qi];
    const gapped = buy ? best < price - tick / 2 : best > price + tick / 2;
    const queueAhead = gapped ? 0 : buy ? q.bidAmt[qi] : q.askAmt[qi];

    const penetrationBps = (Math.abs(price - extreme) / price) * 10_000;
    const bucket = bucketOf(edges, penetrationBps);
    stats.touches[bucket] += 1;
    stats.levels++;
    stats.queueAheadSum[bucket] += queueAhead * price;
    if (gapped) stats.gapped[bucket] += 1;

    let cum = 0;
    let swept = false;
    for (let k = span.tFrom; k < span.tTo; k++) {
      if (t.ts[k] < sweepFromMs) continue;
      const aggressorMatches = buy ? t.sell[k] === 1 : t.sell[k] === 0;
      if (!aggressorMatches) continue;
      const beyond = buy ? t.price[k] < price - tick / 2 : t.price[k] > price + tick / 2;
      if (beyond) {
        swept = true;
        break;
      }
      const atLevel = Math.abs(t.price[k] - price) <= tick / 2;
      if (atLevel && t.ts[k] >= touchMs) cum += t.amount[k];
    }

    if (swept) {
      stats.swept[bucket] += 1;
      stats.filled[bucket] += 1;
      stats.filledOptimistic[bucket] += 1;
      stats.filledUniform[bucket] += 1;
      continue;
    }
    if (cum >= queueAhead + ourQty) stats.filled[bucket] += 1;
    if (cum >= ourQty) stats.filledOptimistic[bucket] += 1;
    stats.filledUniform[bucket] +=
      queueAhead > 0 ? clamp01((cum - ourQty) / queueAhead) : cum >= ourQty ? 1 : 0;
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export interface LimitFillRow {
  fromBps: number;
  toBps: number;
  touches: number;
  /** Back-of-queue fill rate — the lower bound. */
  fillRate: number;
  fillRateUniform: number;
  fillRateOptimistic: number;
  /** Share settled by price priority alone, with no queue assumption. */
  sweptShare: number;
  gapShare: number;
  meanQueueAheadNotional: number;
  /** Wilson 95% interval for the back-of-queue fill rate. */
  ci95: [number, number];
}

export function summarizeLimitFills(stats: LimitFillStats): LimitFillRow[] {
  const out: LimitFillRow[] = [];
  for (let i = 0; i < stats.edgesBps.length; i++) {
    const n = stats.touches[i];
    if (n <= 0) continue;
    out.push({
      fromBps: i === 0 ? 0 : stats.edgesBps[i - 1],
      toBps: stats.edgesBps[i],
      touches: n,
      fillRate: stats.filled[i] / n,
      fillRateUniform: stats.filledUniform[i] / n,
      fillRateOptimistic: stats.filledOptimistic[i] / n,
      sweptShare: stats.swept[i] / n,
      gapShare: stats.gapped[i] / n,
      meanQueueAheadNotional: stats.queueAheadSum[i] / n,
      ci95: wilson(stats.filled[i], n),
    });
  }
  return out;
}

/**
 * Wilson score interval. Preferred over the normal approximation because the
 * measured rates sit near 0 and 1, where the naive interval leaves the unit
 * square and stops meaning anything.
 */
export function wilson(successes: number, n: number, z = 1.96): [number, number] {
  if (n <= 0) return [NaN, NaN];
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return [Math.max(0, centre - half), Math.min(1, centre + half)];
}

/* ── binance bookDepth seasonality ────────────────────────────────────────── */

export interface DepthDay {
  sum: number;
  count: number;
  /** Both sides of the +-1% band added up, one entry per snapshot. */
  paired: number[];
}

export interface DepthProfile {
  /** Buckets are hour + 24 * weekend. */
  notionalSum: Float64Array;
  count: Float64Array;
  days: Set<string>;
  /** Per-date snapshots, so a single collapse day can be read off directly. */
  byDay: Map<string, DepthDay>;
  pendingSec: number;
  pendingSum: number;
  pendingDay: DepthDay | null;
}

export function createDepthProfile(): DepthProfile {
  return {
    notionalSum: new Float64Array(48),
    count: new Float64Array(48),
    days: new Set(),
    byDay: new Map(),
    pendingSec: -1,
    pendingSum: 0,
    pendingDay: null,
  };
}

/**
 * Adds one snapshot row. Only the +-1% band is used: it is the closest to the
 * touch that this dataset carries. Rows arrive one band per line, so the two
 * sides of a snapshot are paired by timestamp before being recorded — the
 * collapse figure has to describe a whole book, not half of one.
 */
export function addDepthRow(
  profile: DepthProfile,
  timeSec: number,
  percentage: number,
  notional: number,
  date?: string,
): void {
  if (Math.abs(percentage) !== 1) return;
  const ms = timeSec * 1000;
  const b = bucketIndex(utcHourOfMs(ms), isWeekendMs(ms));
  profile.notionalSum[b] += notional;
  profile.count[b] += 1;
  if (!date) return;

  let day = profile.byDay.get(date);
  if (!day) {
    day = { sum: 0, count: 0, paired: [] };
    profile.byDay.set(date, day);
  }
  day.sum += notional;
  day.count += 1;

  if (timeSec !== profile.pendingSec || profile.pendingDay !== day) {
    flushPending(profile);
    profile.pendingSec = timeSec;
    profile.pendingDay = day;
    profile.pendingSum = 0;
  }
  profile.pendingSum += notional;
}

function flushPending(profile: DepthProfile): void {
  if (profile.pendingDay && profile.pendingSum > 0) profile.pendingDay.paired.push(profile.pendingSum);
  profile.pendingSum = 0;
}

/** Must be called once the last file has been fed in. */
export function finishDepthProfile(profile: DepthProfile): void {
  flushPending(profile);
  profile.pendingDay = null;
  profile.pendingSec = -1;
}

export interface DepthDayRow {
  date: string;
  snapshots: number;
  median: number;
  p05: number;
  p01: number;
  min: number;
  /** Trough as a fraction of the same day's median — the collapse magnitude. */
  troughRatio: number;
}

export function summarizeDepthDays(profile: DepthProfile): DepthDayRow[] {
  const out: DepthDayRow[] = [];
  for (const [date, day] of [...profile.byDay.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (day.paired.length === 0) continue;
    const v = [...day.paired].sort((a, b) => a - b);
    const at = (q: number): number => v[Math.min(v.length - 1, Math.max(0, Math.floor(q * (v.length - 1))))];
    const median = at(0.5);
    out.push({
      date,
      snapshots: v.length,
      median,
      p05: at(0.05),
      p01: at(0.01),
      min: v[0],
      troughRatio: median > 0 ? v[0] / median : NaN,
    });
  }
  return out;
}

export interface DepthRow {
  hour: number;
  weekend: boolean;
  samples: number;
  meanNotional: number;
}

export function summarizeDepth(profile: DepthProfile): DepthRow[] {
  const out: DepthRow[] = [];
  for (let b = 0; b < 48; b++) {
    if (profile.count[b] <= 0) continue;
    out.push({
      hour: b % 24,
      weekend: b >= 24,
      samples: profile.count[b],
      meanNotional: profile.notionalSum[b] / profile.count[b],
    });
  }
  return out;
}

export function meanDepth(rows: readonly DepthRow[], filter: (r: DepthRow) => boolean): number {
  let n = 0;
  let s = 0;
  for (const r of rows) {
    if (!filter(r)) continue;
    n += r.samples;
    s += r.meanNotional * r.samples;
  }
  return n > 0 ? s / n : NaN;
}

/* ── cost against bar volatility ──────────────────────────────────────────── */

/**
 * The volatility multiplier claims a wide bar costs more to trade than a calm
 * one. That is testable: bucket minutes by their own range and compare what a
 * market order would have paid inside each bucket. The reference bucket is
 * whichever one holds `volatilityRefPct`, so the output is directly the
 * multiplier curve the engine applies.
 */
export const DEFAULT_RANGE_EDGES_PCT = [0.02, 0.05, 0.1, 0.2, 0.4, 0.8, 1.6, Infinity];

export interface VolatilityCostStats {
  edgesPct: number[];
  bars: Float64Array;
  samples: Float64Array;
  costSumBps: Float64Array;
  spreadSumBps: Float64Array;
  topNotionalSum: Float64Array;
  /** Every bar's range, kept as a histogram over the same edges. */
  rangeHist: Float64Array;
}

export function createVolatilityCostStats(edges: number[] = DEFAULT_RANGE_EDGES_PCT): VolatilityCostStats {
  const k = edges.length;
  return {
    edgesPct: [...edges],
    bars: new Float64Array(k),
    samples: new Float64Array(k),
    costSumBps: new Float64Array(k),
    spreadSumBps: new Float64Array(k),
    topNotionalSum: new Float64Array(k),
    rangeHist: new Float64Array(k),
  };
}

export interface VolatilityCostOptions {
  latencyMs: number;
  sampleStepMs?: number;
  barMs?: number;
}

export function accumulateVolatilityCost(
  q: QuoteDay,
  t: TradeDay,
  stats: VolatilityCostStats,
  opts: VolatilityCostOptions,
): void {
  const barMs = opts.barMs ?? 60_000;
  const step = opts.sampleStepMs ?? 1000;
  const latency = Math.max(0, opts.latencyMs);
  const edges = stats.edgesPct;

  for (const span of buildBarSpans(q, t, barMs)) {
    if (span.qTo <= span.qFrom || span.tTo <= span.tFrom) continue;
    const close = t.price[span.tTo - 1];
    if (!(close > 0)) continue;
    const rangePct = ((span.high - span.low) / close) * 100;
    const b = bucketOf(edges, rangePct);
    stats.bars[b] += 1;
    stats.rangeHist[b] += 1;

    let iDecide = span.qFrom;
    let iArrive = span.qFrom;
    for (let ts = span.startMs; ts < span.endMs; ts += step) {
      while (iDecide + 1 < span.qTo && q.ts[iDecide + 1] <= ts) iDecide++;
      if (iArrive < iDecide) iArrive = iDecide;
      while (iArrive + 1 < span.qTo && q.ts[iArrive + 1] <= ts + latency) iArrive++;
      if (q.ts[iDecide] > ts) continue;
      const mid = (q.bid[iDecide] + q.ask[iDecide]) / 2;
      if (!(mid > 0)) continue;
      const buyBps = ((q.ask[iArrive] - mid) / mid) * 10_000;
      const sellBps = ((mid - q.bid[iArrive]) / mid) * 10_000;
      stats.samples[b] += 2;
      stats.costSumBps[b] += buyBps + sellBps;
      stats.spreadSumBps[b] += (((q.ask[iDecide] - q.bid[iDecide]) / mid) * 10_000) * 2;
      stats.topNotionalSum[b] +=
        Math.min(q.bidAmt[iDecide] * q.bid[iDecide], q.askAmt[iDecide] * q.ask[iDecide]) * 2;
    }
  }
}

export interface VolatilityCostRow {
  fromPct: number;
  toPct: number;
  bars: number;
  barShare: number;
  samples: number;
  meanCostBps: number;
  meanSpreadBps: number;
  meanTopNotional: number;
  /** Cost relative to the bucket holding `refPct`. */
  multiplier: number;
}

export function summarizeVolatilityCost(stats: VolatilityCostStats, refPct = 0.2): VolatilityCostRow[] {
  const refBucket = bucketOf(stats.edgesPct, refPct);
  const refCost = stats.samples[refBucket] > 0 ? stats.costSumBps[refBucket] / stats.samples[refBucket] : NaN;
  let totalBars = 0;
  for (let i = 0; i < stats.bars.length; i++) totalBars += stats.bars[i];

  const out: VolatilityCostRow[] = [];
  for (let i = 0; i < stats.edgesPct.length; i++) {
    const n = stats.samples[i];
    if (n <= 0) continue;
    const mean = stats.costSumBps[i] / n;
    out.push({
      fromPct: i === 0 ? 0 : stats.edgesPct[i - 1],
      toPct: stats.edgesPct[i],
      bars: stats.bars[i],
      barShare: totalBars > 0 ? stats.bars[i] / totalBars : NaN,
      samples: n,
      meanCostBps: mean,
      meanSpreadBps: stats.spreadSumBps[i] / n,
      meanTopNotional: stats.topNotionalSum[i] / n,
      multiplier: mean / refCost,
    });
  }
  return out;
}

/** Bar-range percentile from the same histogram, as an upper bin edge. */
export function rangeQuantile(stats: VolatilityCostStats, q: number): number {
  let total = 0;
  for (let i = 0; i < stats.rangeHist.length; i++) total += stats.rangeHist[i];
  if (total <= 0) return NaN;
  const target = total * Math.min(1, Math.max(0, q));
  let acc = 0;
  for (let i = 0; i < stats.rangeHist.length; i++) {
    acc += stats.rangeHist[i];
    if (acc >= target) return stats.edgesPct[i];
  }
  return stats.edgesPct[stats.edgesPct.length - 1];
}
