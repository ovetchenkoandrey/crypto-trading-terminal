import type { Candle } from "../types";

/**
 * Read-only view over the bars a strategy is allowed to see.
 *
 * Everything is bounded by a cursor pointing at the bar currently being
 * processed, so a strategy cannot read bars that have not happened yet. This is
 * the single defence against look-ahead bias: handing a bot the raw candle
 * array would let it index into the future and produce backtest profits that
 * cannot exist in live trading.
 *
 * Indices are absolute (same numbering as the underlying series), so `at(i)`
 * means "bar number i", not "i bars ago".
 */
export interface BarHistory {
  /** Number of bars visible right now — the cursor position plus one. */
  readonly length: number;
  /** Bar by absolute index; undefined outside [0, length). */
  at(i: number): Candle | undefined;
  /** The bar being processed, i.e. the newest visible one. */
  current(): Candle | undefined;
  /** Up to `n` most recent bars, oldest first. Fewer if history is shorter. */
  last(n: number): Candle[];
  closes(n: number): number[];
  highs(n: number): number[];
  lows(n: number): number[];
  volumes(n: number): number[];
}

/**
 * BarHistory over a candle series, optionally bounded by an external cursor
 * (the backtest clock index). Slices are cut to the requested window only, so
 * reading a 20-bar window stays O(20) regardless of how long the series is.
 *
 * The series may be given as an array (backtest — fixed up front) or as a
 * provider function (live — the store's candle array is replaced on updates).
 * Without a cursor the whole series is visible, which is correct live where
 * every stored bar is already in the past.
 */
export class CursorBarHistory implements BarHistory {
  constructor(
    private readonly bars: readonly Candle[] | (() => readonly Candle[]),
    private readonly cursor?: () => number,
  ) {}

  private series(): readonly Candle[] {
    return typeof this.bars === "function" ? this.bars() : this.bars;
  }

  get length(): number {
    const len = this.series().length;
    if (!this.cursor) return len;
    const c = this.cursor();
    if (c < 0) return 0;
    return Math.min(c + 1, len);
  }

  at(i: number): Candle | undefined {
    if (!Number.isInteger(i) || i < 0 || i >= this.length) return undefined;
    return this.series()[i];
  }

  current(): Candle | undefined {
    return this.at(this.length - 1);
  }

  last(n: number): Candle[] {
    const len = this.length;
    if (!Number.isFinite(n) || n <= 0 || len === 0) return [];
    const take = Math.min(Math.floor(n), len);
    return this.series().slice(len - take, len);
  }

  closes(n: number): number[]  { return this.last(n).map((b) => b.close); }
  highs(n: number): number[]   { return this.last(n).map((b) => b.high); }
  lows(n: number): number[]    { return this.last(n).map((b) => b.low); }
  volumes(n: number): number[] { return this.last(n).map((b) => b.volume); }
}

/** History with nothing in it — used where no bar source is wired up yet. */
export const EMPTY_HISTORY: BarHistory = {
  length: 0,
  at: () => undefined,
  current: () => undefined,
  last: () => [],
  closes: () => [],
  highs: () => [],
  lows: () => [],
  volumes: () => [],
};
