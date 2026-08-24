import type { Candle } from "../../types";

/** Start of the interval a timestamp belongs to, in UTC seconds. */
export function alignDown(timeSec: number, intervalSec: number): number {
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) return timeSec;
  return Math.floor(timeSec / intervalSec) * intervalSec;
}

/**
 * Builds signal bars out of execution bars as they arrive.
 *
 * A backtest runs on two timeframes: orders, stops and liquidation are checked
 * against the fine series (minutes), while the strategy only wakes up when a
 * coarser bar closes. Matching on the same bar the strategy reasons about
 * leaves the intrabar order of events unknown — with OHLC alone there is no way
 * to tell whether a bar that covers both a stop and a target hit the stop
 * first. Feeding execution minute by minute recovers that ordering.
 *
 * A bar is emitted only once the first bar of the NEXT interval arrives, so a
 * strategy never sees a period that is still forming. The final period stays
 * unemitted for exactly that reason.
 */
export class BarAggregator {
  private open = 0;
  private high = 0;
  private low = 0;
  private close = 0;
  private volume = 0;
  private start = -1;

  constructor(private readonly intervalSec: number) {}

  /** Feeds one execution bar; returns a signal bar when one has just closed. */
  push(bar: Candle): Candle | null {
    const slot = alignDown(bar.time, this.intervalSec);

    if (this.start < 0) {
      this.begin(slot, bar);
      return null;
    }
    if (slot === this.start) {
      this.high = Math.max(this.high, bar.high);
      this.low = Math.min(this.low, bar.low);
      this.close = bar.close;
      this.volume += bar.volume;
      return null;
    }

    const closed = this.snapshot();
    this.begin(slot, bar);
    return closed;
  }

  /** The period still forming. Never hand this to a strategy. */
  pending(): Candle | null {
    return this.start < 0 ? null : this.snapshot();
  }

  private begin(slot: number, bar: Candle): void {
    this.start = slot;
    this.open = bar.open;
    this.high = bar.high;
    this.low = bar.low;
    this.close = bar.close;
    this.volume = bar.volume;
  }

  private snapshot(): Candle {
    return {
      time:   this.start,
      open:   this.open,
      high:   this.high,
      low:    this.low,
      close:  this.close,
      volume: this.volume,
    };
  }
}

/**
 * Aggregates a whole series at once. Unlike the streaming aggregator this keeps
 * the trailing period, because the caller already has every bar — use it for
 * charting, not for driving a strategy.
 */
export function aggregateBars(bars: readonly Candle[], intervalSec: number): Candle[] {
  const out: Candle[] = [];
  const agg = new BarAggregator(intervalSec);
  for (const bar of bars) {
    const closed = agg.push(bar);
    if (closed) out.push(closed);
  }
  const tail = agg.pending();
  if (tail) out.push(tail);
  return out;
}
