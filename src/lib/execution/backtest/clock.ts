// Drives "now" during a backtest. The runner advances the index one bar at a
// time; subscribers (mostly the venue) see each new bar via onBar.

import type { Candle } from "../../types";

type BarHandler = (bar: Candle, index: number) => void;

export class BacktestClock {
  private idx = -1;
  private subs: Set<BarHandler> = new Set();

  constructor(public readonly bars: Candle[]) {}

  get index(): number { return this.idx; }
  get current(): Candle | null {
    return this.idx >= 0 && this.idx < this.bars.length ? this.bars[this.idx] : null;
  }
  get done(): boolean { return this.idx >= this.bars.length - 1; }
  get total(): number { return this.bars.length; }
  get progress(): number {
    return this.bars.length === 0 ? 1 : (this.idx + 1) / this.bars.length;
  }

  onBar(h: BarHandler): () => void {
    this.subs.add(h);
    return () => this.subs.delete(h);
  }

  /** Advance one bar. Returns false if there are no more bars. */
  step(): boolean {
    if (this.done) return false;
    this.idx += 1;
    const bar = this.bars[this.idx];
    for (const s of this.subs) s(bar, this.idx);
    return true;
  }

  reset(): void {
    this.idx = -1;
  }
}
