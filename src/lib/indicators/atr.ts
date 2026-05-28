import type { Candle } from "../types";
import type { IndicatorDef, IndicatorOutput } from "./base";

// ATR (Average True Range) — Wilder's smoothing.

export const def: IndicatorDef = {
  kind: "atr",
  name: "ATR",
  region: "pane",
  defaultParams: { period: 14 },
  defaultColor: "#f0b90b",
  compute(candles: Candle[], params): IndicatorOutput {
    const period = Number(params.period ?? 14);
    const line: { time: number; value: number }[] = [];
    if (candles.length < period + 1) {
      const color = typeof params.color === "string" ? params.color : this.defaultColor;
      return { lines: [{ name: "ATR", color, data: line }] };
    }

    // True Range
    const tr: number[] = [];
    for (let i = 0; i < candles.length; i++) {
      const c = candles[i];
      if (i === 0) { tr.push(c.high - c.low); continue; }
      const pc = candles[i - 1].close;
      tr.push(Math.max(c.high - c.low, Math.abs(c.high - pc), Math.abs(c.low - pc)));
    }

    // Initial ATR: SMA of first `period` TRs
    let atr = tr.slice(0, period).reduce((s, v) => s + v, 0) / period;
    line.push({ time: candles[period - 1].time, value: atr });

    // Subsequent: Wilder smoothing
    for (let i = period; i < tr.length; i++) {
      atr = (atr * (period - 1) + tr[i]) / period;
      line.push({ time: candles[i].time, value: atr });
    }

    const color = typeof params.color === "string" ? params.color : this.defaultColor;
    return { lines: [{ name: "ATR", color, data: line }] };
  },
};
